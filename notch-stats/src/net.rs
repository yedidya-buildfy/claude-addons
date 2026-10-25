//! Internet: what the connection can carry (a short speed test every 30 min with macOS's own
//! networkQuality, kept 7 days) and the Wi-Fi signal (every second, in the regular history).

use crate::stats::{Shared, data_dir, unix_secs};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const EVERY_S: u64 = 30 * 60;
const KEEP_S: u64 = 7 * 86400;
const FIRST_AFTER: Duration = Duration::from_secs(120); // let the Mac settle after login before the first test

/// One speed test: when (unix s), download and upload in Mb/s, idle latency in ms. 0 / 0 = no connection.
#[derive(Serialize, Deserialize, Clone, Copy, Default, PartialEq, Debug)]
pub struct Test {
    pub t: u64,
    pub down: f32,
    pub up: f32,
    pub rtt: f32,
}

fn file() -> std::path::PathBuf {
    data_dir().join("net.json")
}

pub fn load() -> Vec<Test> {
    let since = unix_secs().saturating_sub(KEEP_S);
    let v: Vec<Test> = std::fs::read(file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    v.into_iter().filter(|x| x.t > since).collect()
}

fn save(v: &[Test]) {
    let _ = std::fs::create_dir_all(data_dir());
    if let Ok(s) = serde_json::to_string(v) {
        let _ = std::fs::write(file(), s);
    }
}

/// networkQuality's computer-readable output → a Test (throughput comes in bits/s). Unreadable = no connection.
fn parse(json: &[u8], t: u64) -> Test {
    let v: serde_json::Value = serde_json::from_slice(json).unwrap_or_default();
    let f = |k: &str| v[k].as_f64().unwrap_or(0.0) as f32;
    Test { t, down: f("dl_throughput") / 1e6, up: f("ul_throughput") / 1e6, rtt: f("base_rtt") }
}

/// At most 8 s of traffic (about 50–200 MB at home speeds), so a test never ties up the line for long.
fn run_test() -> Test {
    let out = Command::new("/usr/bin/networkQuality").args(["-c", "-M", "8"]).stderr(Stdio::null()).output();
    parse(&out.map(|o| o.stdout).unwrap_or_default(), unix_secs())
}

/// iPhone Personal Hotspot always hands out 172.20.10.x; automatic tests there would eat the phone's data plan.
// ponytail: phone hotspots only; an Android or travel-router hotspot is not recognised
fn on_hotspot() -> bool {
    Command::new("/sbin/route")
        .args(["-n", "get", "default"])
        .output()
        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains("gateway: 172.20.10.1"))
}

pub fn start(shared: Arc<Mutex<Shared>>, ctx: eframe::egui::Context) {
    std::thread::Builder::new()
        .name("speed-test".into())
        .spawn(move || {
            let started = Instant::now();
            let mut next = shared.lock().unwrap().net.last().map_or(0, |x| x.t + EVERY_S);
            loop {
                std::thread::sleep(Duration::from_secs(5));
                let forced = std::mem::take(&mut shared.lock().unwrap().net_now);
                if !forced && (unix_secs() < next || started.elapsed() < FIRST_AFTER) {
                    continue;
                }
                next = unix_secs() + EVERY_S;
                if !forced && on_hotspot() {
                    continue;
                }
                shared.lock().unwrap().net_busy = true;
                ctx.request_repaint();
                let t = run_test();
                let mut s = shared.lock().unwrap();
                s.net.push(t);
                let since = unix_secs().saturating_sub(KEEP_S);
                s.net.retain(|x| x.t > since);
                save(&s.net);
                s.net_busy = false;
                ctx.request_repaint();
            }
        })
        .expect("speed-test thread");
}

#[link(name = "CoreWLAN", kind = "framework")]
unsafe extern "C" {}

/// Wi-Fi signal (dBm: about -30 excellent … -80 weak) and the link rate the router offers (Mb/s); 0, 0 off Wi-Fi.
pub fn wifi() -> [f32; 2] {
    objc2::rc::autoreleasepool(|_| unsafe {
        let client: *mut AnyObject = msg_send![class!(CWWiFiClient), sharedWiFiClient];
        let iface: *mut AnyObject = msg_send![client, interface];
        if iface.is_null() {
            return [0.0; 2];
        }
        let rssi: isize = msg_send![iface, rssiValue];
        let rate: f64 = msg_send![iface, transmitRate];
        [rssi as f32, rate as f32]
    })
}

/// How a signal reading feels, in the words Apple's Wi-Fi diagnostics use.
pub fn signal_word(dbm: f32) -> &'static str {
    match dbm {
        d if d >= 0.0 => "not on Wi-Fi",
        d if d >= -55.0 => "strong",
        d if d >= -67.0 => "good",
        d if d >= -75.0 => "fair",
        _ => "weak",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_network_quality_output() {
        let json = br#"{"base_rtt":106.1,"dl_throughput":78105848,"ul_throughput":12000000,"interface_name":"en0"}"#;
        let t = parse(json, 5);
        assert_eq!((t.t, t.down.round(), t.up, t.rtt), (5, 78.0, 12.0, 106.1));
    }

    #[test]
    fn failed_test_counts_as_no_connection() {
        assert_eq!(parse(b"", 7), Test { t: 7, ..Default::default() });
    }

    #[test]
    fn wifi_signal_is_in_range() {
        let [rssi, rate] = wifi();
        assert!((-120.0..=0.0).contains(&rssi) && rate >= 0.0, "{rssi} dBm {rate} Mb/s");
        assert_eq!(signal_word(-50.0), "strong");
        assert_eq!(signal_word(-80.0), "weak");
    }
}
