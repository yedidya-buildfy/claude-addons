//! Sampling (once a second, on its own thread) and history (10 min of seconds, 24 h of minutes on disk).

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::{CFDictionary, CFMutableDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_char, c_void};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub const CPU: usize = 0;
pub const GPU: usize = 1;
pub const RAM: usize = 2;
const SECS: usize = 600;
const MINUTES: usize = 1440;
const TOP_KEEP: usize = 8;
const GIB: f32 = 1073741824.0; // memory in GiB, like Activity Monitor (disk stays decimal, like Finder)

/// Per-app share: CPU / GPU in % of the whole machine, RAM in GB.
pub type Tops = [Vec<(String, f32)>; 3];

/// One point of history: cpu %, gpu %, ram %; memory split (app, wired, compressed, cached) in GB;
/// each core's use in % (efficiency cores first).
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Point {
    #[serde(alias = "avg")] // files written before the memory split / cores were added
    pub v: [f32; 3],
    #[serde(default)]
    pub mem: [f32; 4],
    #[serde(default)]
    pub cores: Vec<f32>,
    #[serde(default)]
    pub swap: f32, // GB
    #[serde(default)]
    pub temp: [f32; 2], // CPU, GPU °C
    #[serde(default)]
    pub disk: [f32; 2], // read, write MB/s (all processes)
    #[serde(default)]
    pub wifi: [f32; 2], // signal dBm, link rate Mb/s (0, 0 = not on Wi-Fi)
}

impl Point {
    fn add(&mut self, o: &Point) {
        for i in 0..3 {
            self.v[i] += o.v[i];
        }
        for i in 0..4 {
            self.mem[i] += o.mem[i];
        }
        self.swap += o.swap;
        self.temp[0] += o.temp[0];
        self.temp[1] += o.temp[1];
        self.disk[0] += o.disk[0];
        self.disk[1] += o.disk[1];
        self.wifi[0] += o.wifi[0];
        self.wifi[1] += o.wifi[1];
        self.cores.resize(o.cores.len().max(self.cores.len()), 0.0);
        for (a, b) in self.cores.iter_mut().zip(&o.cores) {
            *a += b;
        }
    }

    fn scaled(mut self, k: f32) -> Point {
        self.v.iter_mut().chain(self.mem.iter_mut()).chain(self.cores.iter_mut()).chain(self.temp.iter_mut()).chain(self.disk.iter_mut()).chain(self.wifi.iter_mut()).chain([&mut self.swap]).for_each(|x| *x *= k);
        self
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Minute {
    pub t: u64,
    #[serde(flatten)]
    pub avg: Point,
    pub top: Tops,
}

#[derive(Default)]
struct Accum {
    t: u64,
    n: u32,
    sum: Point,
    apps: [HashMap<String, f32>; 3],
}

#[derive(Default, Clone, Copy)]
pub struct Now {
    pub cpu: f32,
    pub gpu: f32,
    pub ram_used: f32,
    pub ram_total: f32,
    pub swap: f32,
    pub swap_total: f32,
    pub mem: [f32; 4],
    pub temps: crate::temp::Temps,
    pub gpu_mem: f32,
    pub disk_free: f32,
    pub disk_total: f32,
    pub e_cores: usize,
    pub wifi: [f32; 2],
}

#[derive(Default)]
pub struct Shared {
    pub now: Now,
    pub secs: VecDeque<Point>,
    pub minutes: VecDeque<Minute>,
    pub now_top: Tops,
    /// What takes the disk: (folder, GB), biggest first, and when it was measured (unix s).
    pub folders: Vec<(String, f32)>,
    pub folders_at: u64,
    /// Speed tests, oldest first (7 days); `net_busy` while one runs, `net_now` asks for one right away.
    pub net: Vec<crate::net::Test>,
    pub net_busy: bool,
    pub net_now: bool,
    cur: Accum,
}

impl Shared {
    /// Average per-app use over the last `mins` minutes (current minute included), busiest first.
    pub fn tops(&self, metric: usize, mins: u64) -> Vec<(String, f32)> {
        let since = unix_min().saturating_sub(mins);
        let mut sum: HashMap<&str, f32> = HashMap::new();
        let mut n = 0.0f32;
        for m in self.minutes.iter().filter(|m| m.t > since) {
            n += 1.0;
            for (k, v) in &m.top[metric] {
                *sum.entry(k).or_default() += v;
            }
        }
        if self.cur.n > 0 {
            n += 1.0;
            let mut cur: Vec<_> = self.cur.apps[metric].iter().collect();
            cur.sort_by(|a, b| b.1.total_cmp(a.1));
            for (k, v) in cur.into_iter().take(TOP_KEEP) {
                *sum.entry(k).or_default() += v / self.cur.n as f32;
            }
        }
        let mut out: Vec<_> = sum.into_iter().map(|(k, v)| (k.to_string(), v / n.max(1.0))).collect();
        out.sort_by(|a, b| b.1.total_cmp(&a.1));
        out
    }

    /// History for a range: seconds for 10 min, minute averages beyond that. Oldest first.
    pub fn history(&self, mins: u64) -> Vec<Point> {
        if mins <= 10 {
            return self.secs.iter().cloned().collect();
        }
        let since = unix_min().saturating_sub(mins);
        self.minutes.iter().filter(|m| m.t > since).map(|m| m.avg.clone()).collect()
    }

    fn push(&mut self, now: Now, point: Point, tops: Tops) {
        self.now = now;
        if self.secs.len() == SECS {
            self.secs.pop_front();
        }
        self.secs.push_back(point.clone());

        let t = unix_min();
        if self.cur.n > 0 && self.cur.t != t {
            let c = std::mem::take(&mut self.cur);
            let n = c.n as f32;
            let top = c.apps.map(|m| {
                let mut v: Vec<_> = m.into_iter().map(|(k, x)| (k, x / n)).collect();
                v.sort_by(|a, b| b.1.total_cmp(&a.1));
                v.truncate(TOP_KEEP);
                v
            });
            if self.minutes.len() == MINUTES {
                self.minutes.pop_front();
            }
            self.minutes.push_back(Minute { t: c.t, avg: c.sum.scaled(1.0 / n), top });
            save(&self.minutes);
        }
        self.cur.t = t;
        self.cur.n += 1;
        self.cur.sum.add(&point);
        for i in 0..3 {
            for (k, x) in &tops[i] {
                *self.cur.apps[i].entry(k.clone()).or_default() += x;
            }
        }
        self.now_top = tops;
    }
}

fn unix_min() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() / 60
}

pub fn unix_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

const SCAN_EVERY_S: u64 = 6 * 3600;

/// Size of every top-level folder in the home folder (hidden ones summed together) and of /Applications.
/// `du` runs at background priority (efficiency cores, throttled disk), so a scan never gets in the way.
fn scan_folders() -> Vec<(String, f32)> {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let mut paths = vec![PathBuf::from("/Applications")];
    if let Ok(rd) = std::fs::read_dir(&home) {
        for e in rd.flatten() {
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                paths.push(e.path());
            }
        }
    }
    du(&paths, &home)
}

fn du(paths: &[PathBuf], home: &std::path::Path) -> Vec<(String, f32)> {
    let out = std::process::Command::new("/usr/sbin/taskpolicy")
        .args(["-b", "/usr/bin/du", "-sk"])
        .args(paths)
        .stderr(std::process::Stdio::null())
        .output();
    let Ok(out) = out else { return Vec::new() };
    let mut sizes: HashMap<String, f32> = HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let Some((kb, path)) = line.split_once('\t') else { continue };
        let Ok(kb) = kb.trim().parse::<f32>() else { continue };
        let p = std::path::Path::new(path);
        let name = match p.strip_prefix(home) {
            Ok(rel) if rel.to_string_lossy().starts_with('.') => "Hidden folders (~/.…)".to_string(),
            Ok(rel) => format!("~/{}", rel.to_string_lossy()),
            Err(_) => path.to_string(),
        };
        *sizes.entry(name).or_default() += kb * 1024.0 / 1e9;
    }
    let mut v: Vec<_> = sizes.into_iter().collect();
    v.sort_by(|a, b| b.1.total_cmp(&a.1));
    v
}

fn folders_file() -> PathBuf {
    history_file().with_file_name("folders.json")
}

fn save_folders(at: u64, folders: &[(String, f32)]) {
    if let Ok(s) = serde_json::to_string(&(at, folders)) {
        let _ = std::fs::write(folders_file(), s);
    }
}

fn load_folders() -> (u64, Vec<(String, f32)>) {
    std::fs::read(folders_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Where everything NotchStats keeps lives (history, speed tests, the shelf).
pub fn data_dir() -> PathBuf {
    let home = std::env::var_os("HOME").unwrap_or_default();
    PathBuf::from(home).join("Library/Application Support/NotchStats")
}

fn history_file() -> PathBuf {
    data_dir().join("history.json")
}

fn save(minutes: &VecDeque<Minute>) {
    let p = history_file();
    let _ = std::fs::create_dir_all(p.parent().unwrap());
    if let Ok(s) = serde_json::to_string(minutes) {
        let tmp = p.with_extension("tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(tmp, p);
        }
    }
}

fn load() -> VecDeque<Minute> {
    let since = unix_min().saturating_sub(MINUTES as u64);
    std::fs::read(history_file())
        .ok()
        .and_then(|b| serde_json::from_slice::<VecDeque<Minute>>(&b).ok())
        .map(|v| v.into_iter().filter(|m| m.t > since).collect())
        .unwrap_or_default()
}

/// "Google Chrome Helper (Renderer)" and friends count as their outer app ("Google Chrome").
fn app_name(p: &sysinfo::Process) -> String {
    if let Some(exe) = p.exe() {
        for c in exe.components() {
            let s = c.as_os_str().to_string_lossy();
            if let Some(name) = s.strip_suffix(".app") {
                return name.to_string();
            }
        }
    }
    p.name().to_string_lossy().into_owned()
}

fn top_of(m: HashMap<String, f32>) -> Vec<(String, f32)> {
    let mut v: Vec<_> = m.into_iter().filter(|x| x.1 > 0.0).collect();
    v.sort_by(|a, b| b.1.total_cmp(&a.1));
    v.truncate(TOP_KEEP * 2);
    v
}

pub fn start(ctx: eframe::egui::Context) -> Arc<Mutex<Shared>> {
    let (folders_at, folders) = load_folders();
    let shared = Arc::new(Mutex::new(Shared { minutes: load(), folders, folders_at, net: crate::net::load(), ..Default::default() }));
    crate::net::start(shared.clone(), ctx.clone());
    let out = shared.clone();
    let scan_into = shared.clone();
    std::thread::Builder::new()
        .name("disk-scan".into())
        .spawn(move || loop {
            // re-measure folders when the last scan is 6 h old (first one 1 min after start)
            let age = unix_secs().saturating_sub(scan_into.lock().unwrap().folders_at);
            let wait = if age >= SCAN_EVERY_S { 60 } else { SCAN_EVERY_S - age };
            std::thread::sleep(Duration::from_secs(wait));
            let folders = scan_folders();
            let at = unix_secs();
            save_folders(at, &folders);
            let mut s = scan_into.lock().unwrap();
            s.folders = folders;
            s.folders_at = at;
        })
        .expect("disk-scan thread");
    std::thread::Builder::new()
        .name("sampler".into())
        .spawn(move || {
            let mut sys = System::new();
            let mut disks = sysinfo::Disks::new_with_refreshed_list();
            let mut gpu = Gpu::default();
            let sensors = crate::temp::Sensors::new();
            let kind = ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_disk_usage()
                .with_exe(UpdateKind::OnlyIfNotSet);
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
            let ncpu = sys.cpus().len().max(1) as f32;
            let e_cores = sysctl_u32("hw.perflevel1.logicalcpu").unwrap_or(0) as usize;
            let mut tick = 0u64;
            loop {
                std::thread::sleep(Duration::from_secs(1));
                sys.refresh_cpu_usage();
                sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
                if tick % 30 == 0 {
                    disks.refresh(true);
                }
                // turned off in the add-ons page = our files are gone: quit cleanly (launchd won't restart a clean exit)
                if tick % 5 == 0 && std::env::current_exe().is_ok_and(|p| !p.exists()) {
                    std::process::exit(0);
                }
                tick += 1;
                let (util, gpu_mem, by_pid) = gpu.sample();
                let mem = memory();
                let temps = crate::temp::summarize(&sensors.read());
                let wifi = crate::net::wifi();
                let gpu_time: f32 = by_pid.values().sum::<f32>().max(1e-6);

                let mut apps: [HashMap<String, f32>; 3] = Default::default();
                let mut io = [0.0f32; 2];
                for (pid, p) in sys.processes() {
                    let u = p.disk_usage();
                    io[0] += u.read_bytes as f32 / 1e6;
                    io[1] += u.written_bytes as f32 / 1e6;
                    let name = app_name(p);
                    let cpu = p.cpu_usage() / ncpu;
                    if cpu > 0.0 {
                        *apps[CPU].entry(name.clone()).or_default() += cpu;
                    }
                    *apps[RAM].entry(name.clone()).or_default() += p.memory() as f32 / GIB;
                    if let Some(g) = by_pid.get(&pid.as_u32()) {
                        // split the device-busy figure by each app's share of GPU time
                        *apps[GPU].entry(name).or_default() += util * g / gpu_time;
                    }
                }
                if tick == 1 {
                    io = [0.0; 2]; // the first reading counts everything since each process started
                }
                let disk = disks.list().iter().find(|d| d.mount_point() == std::path::Path::new("/"));
                let ram_total = sys.total_memory() as f32 / GIB;
                let ram_used = mem.split[0] + mem.split[1] + mem.split[2];
                let now = Now {
                    cpu: sys.global_cpu_usage(),
                    gpu: util,
                    ram_used,
                    ram_total,
                    swap: mem.swap,
                    swap_total: mem.swap_total,
                    mem: mem.split,
                    temps,
                    gpu_mem,
                    disk_free: disk.map_or(0.0, |d| d.available_space() as f32 / 1e9),
                    disk_total: disk.map_or(0.0, |d| d.total_space() as f32 / 1e9),
                    e_cores,
                    wifi,
                };
                let point = Point {
                    v: [now.cpu, now.gpu, 100.0 * ram_used / ram_total.max(1.0)],
                    mem: mem.split,
                    cores: sys.cpus().iter().map(|c| c.cpu_usage()).collect(),
                    swap: mem.swap,
                    temp: [temps.cpu, temps.gpu],
                    disk: io,
                    wifi,
                };
                shared.lock().unwrap().push(now, point, apps.map(top_of));
                ctx.request_repaint();
            }
        })
        .expect("sampler thread");
    out
}

// ---------------------------------------------------------------- memory, the way Activity Monitor splits it

#[repr(C)]
#[derive(Default)]
struct VmStats64 {
    free: u32,
    active: u32,
    inactive: u32,
    wire: u32,
    _counters: [u64; 9],
    purgeable: u32,
    speculative: u32,
    _counters2: [u64; 4],
    compressor: u32,
    throttled: u32,
    external: u32,
    internal: u32,
    _uncompressed: u64,
}

#[repr(C)]
#[derive(Default)]
struct SwapUsage {
    total: u64,
    avail: u64,
    used: u64,
    pagesize: u32,
    encrypted: bool,
}

unsafe extern "C" {
    fn mach_host_self() -> u32;
    fn host_statistics64(host: u32, flavor: i32, info: *mut VmStats64, count: *mut u32) -> i32;
    fn sysctlbyname(name: *const c_char, old: *mut c_void, oldlen: *mut usize, new: *const c_void, newlen: usize) -> i32;
}

fn sysctl<T: Default>(name: &std::ffi::CStr) -> Option<T> {
    let mut v = T::default();
    let mut len = std::mem::size_of::<T>();
    let ok = unsafe { sysctlbyname(name.as_ptr(), &mut v as *mut T as *mut c_void, &mut len, std::ptr::null(), 0) } == 0;
    ok.then_some(v)
}

fn sysctl_u32(name: &str) -> Option<u32> {
    sysctl::<u32>(&std::ffi::CString::new(name).ok()?)
}

struct Mem {
    split: [f32; 4], // app, wired, compressed, cached files (GB)
    swap: f32,
    swap_total: f32,
}

fn memory() -> Mem {
    let mut s = VmStats64::default();
    let mut count = (std::mem::size_of::<VmStats64>() / 4) as u32;
    let page = sysctl_u32("hw.pagesize").unwrap_or(16384) as f32 / GIB;
    unsafe { host_statistics64(mach_host_self(), 4 /* HOST_VM_INFO64 */, &mut s, &mut count) };
    let (swap, swap_total) = sysctl::<SwapUsage>(c"vm.swapusage").map_or((0.0, 0.0), |u| (u.used as f32 / GIB, u.total as f32 / GIB));
    Mem {
        split: [
            s.internal.saturating_sub(s.purgeable) as f32 * page,
            s.wire as f32 * page,
            s.compressor as f32 * page,
            (s.external + s.purgeable) as f32 * page,
        ],
        swap,
        swap_total,
    }
}

// ---------------------------------------------------------------- GPU, straight from the IORegistry (no root)

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOServiceMatching(name: *const c_char) -> CFMutableDictionaryRef;
    fn IOServiceGetMatchingServices(main: u32, matching: CFMutableDictionaryRef, it: *mut u32) -> i32;
    fn IOIteratorNext(it: u32) -> u32;
    fn IOObjectRelease(o: u32) -> i32;
    fn IORegistryEntryGetChildIterator(e: u32, plane: *const c_char, it: *mut u32) -> i32;
    fn IORegistryEntryCreateCFProperties(e: u32, p: *mut CFMutableDictionaryRef, a: *const c_void, o: u32) -> i32;
}

fn props(entry: u32) -> Option<CFDictionary<CFString, CFType>> {
    let mut d: CFMutableDictionaryRef = std::ptr::null_mut();
    let ok = unsafe { IORegistryEntryCreateCFProperties(entry, &mut d, std::ptr::null(), 0) } == 0;
    (ok && !d.is_null()).then(|| unsafe { CFDictionary::wrap_under_create_rule(d as _) })
}

fn each_service(class: &str, mut f: impl FnMut(u32)) {
    let name = std::ffi::CString::new(class).unwrap();
    let mut it = 0;
    // IOServiceGetMatchingServices consumes the matching dictionary.
    if unsafe { IOServiceGetMatchingServices(0, IOServiceMatching(name.as_ptr()), &mut it) } != 0 {
        return;
    }
    loop {
        let s = unsafe { IOIteratorNext(it) };
        if s == 0 {
            break;
        }
        f(s);
        unsafe { IOObjectRelease(s) };
    }
    unsafe { IOObjectRelease(it) };
}

/// The per-process GPU clients hang under the accelerator; they are not matchable services.
fn each_child(entry: u32, mut f: impl FnMut(u32)) {
    let mut it = 0;
    if unsafe { IORegistryEntryGetChildIterator(entry, c"IOService".as_ptr(), &mut it) } != 0 {
        return;
    }
    loop {
        let s = unsafe { IOIteratorNext(it) };
        if s == 0 {
            break;
        }
        f(s);
        unsafe { IOObjectRelease(s) };
    }
    unsafe { IOObjectRelease(it) };
}

fn num(d: &CFDictionary<CFString, CFType>, key: &str) -> Option<f64> {
    d.find(CFString::new(key))?.downcast::<CFNumber>()?.to_f64()
}

#[derive(Default)]
struct Gpu {
    last: HashMap<u32, u64>,
    at: Option<Instant>,
}

impl Gpu {
    /// (utilization %, GPU memory in use GB, pid -> % of GPU time since the last sample)
    fn sample(&mut self) -> (f32, f32, HashMap<u32, f32>) {
        let (mut util, mut mem) = (0.0, 0.0);
        each_service("IOAccelerator", |s| {
            if let Some(p) = props(s)
                && let Some(stats) = p.find(CFString::new("PerformanceStatistics"))
                && let Some(stats) = stats.downcast::<CFDictionary>()
            {
                let stats: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(stats.as_concrete_TypeRef()) };
                util = num(&stats, "Device Utilization %").unwrap_or(0.0) as f32;
                mem = num(&stats, "In use system memory").unwrap_or(0.0) as f32 / 1e9;
            }
        });

        let mut total: HashMap<u32, u64> = HashMap::new();
        each_service("IOAccelerator", |acc| each_child(acc, |s| {
            let Some(p) = props(s) else { return };
            let Some(pid) = p
                .find(CFString::new("IOUserClientCreator"))
                .and_then(|c| c.downcast::<CFString>())
                .and_then(|c| c.to_string().strip_prefix("pid ")?.split(',').next()?.parse::<u32>().ok())
            else {
                return;
            };
            let Some(usage) = p.find(CFString::new("AppUsage")).and_then(|u| u.downcast::<CFArray>()) else { return };
            for item in usage.iter() {
                let d: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(*item as _) };
                *total.entry(pid).or_default() += num(&d, "accumulatedGPUTime").unwrap_or(0.0) as u64;
            }
        }));

        let now = Instant::now();
        let mut share = HashMap::new();
        if let Some(at) = self.at {
            let dt = now.duration_since(at).as_nanos().max(1) as f32;
            for (pid, t) in &total {
                let d = t.saturating_sub(*self.last.get(pid).unwrap_or(t));
                if d > 0 {
                    share.insert(*pid, (100.0 * d as f32 / dt).min(100.0));
                }
            }
        }
        self.last = total;
        self.at = Some(now);
        (util, mem, share)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minute_rolls_up_and_tops_average() {
        let mut s = Shared::default();
        let now = Now { cpu: 50.0, ram_total: 32.0, ram_used: 16.0, ..Default::default() };
        let pt = Point { v: [50.0, 0.0, 50.0], mem: [8.0, 4.0, 4.0, 2.0], cores: vec![20.0, 80.0], swap: 1.0, temp: [60.0, 50.0], disk: [1.0, 2.0], wifi: [-55.0, 400.0] };
        let tops: Tops = [vec![("A".into(), 30.0)], vec![], vec![("A".into(), 2.0)]];
        s.push(now, pt.clone(), tops.clone());
        s.push(now, pt, tops);
        assert_eq!(s.history(10).len(), 2);
        assert_eq!(s.secs[0].cores, vec![20.0, 80.0]);
        assert_eq!(s.tops(CPU, 10), vec![("A".to_string(), 30.0)]);
    }

    #[test]
    fn old_history_files_still_load() {
        let m: Minute = serde_json::from_str(r#"{"t":1,"avg":[1,2,3],"top":[[],[],[]]}"#).unwrap();
        assert_eq!(m.avg.v, [1.0, 2.0, 3.0]);
        assert!(m.avg.cores.is_empty());
    }

    #[test]
    fn folder_sizes_come_from_du() {
        let f = du(&[PathBuf::from("/System/Library/Fonts")], std::path::Path::new("/Users/nobody"));
        assert!(f.iter().any(|(n, gb)| n == "/System/Library/Fonts" && *gb > 0.01), "{f:?}");
    }

    #[test]
    fn memory_split_matches_the_machine() {
        let m = memory();
        let used = m.split[0] + m.split[1] + m.split[2];
        assert!(used > 1.0 && used < 1024.0, "used {used} GB");
    }

    #[test]
    fn gpu_sees_per_app_clients_without_root() {
        let mut g = Gpu::default();
        let (util, mem, _) = g.sample();
        assert!((0.0..=100.0).contains(&util));
        assert!(mem >= 0.0);
        assert!(!g.last.is_empty(), "no per-app GPU clients found (WindowServer always has one)");
    }
}
