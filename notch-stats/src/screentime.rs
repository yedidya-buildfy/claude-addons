//! Screen time: what was in front, and on which project, kept per day on this Mac only.
//! Every 2 s the focused app and its window title are sampled. Only the focused window counts, so with
//! two screens it is still one thing at a time and the total never exceeds real time. Nothing counts
//! after 3 min without keyboard or mouse. Files: one JSON line per stretch, `screentime/<day>.jsonl`.

use crate::stats::data_dir;
use chrono::{Datelike, Local, Months, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const SAMPLE_S: u64 = 2;
pub const IDLE_S: f64 = 180.0;
const FLUSH_S: u64 = 300; // a running stretch is written at least this often, so a crash loses little
const GAP_S: u64 = 3 * SAMPLE_S; // longer without a sample (Mac asleep) = the stretch ended
pub const SLOT_S: u64 = 300; // the day ribbon's resolution
const EDITORS: [&str; 3] = ["Code", "Cursor", "Visual Studio Code"];
const SKIP: [&str; 3] = ["NotchStats", "loginwindow", "ScreenSaverEngine"];

/// One stretch on one app + project, unix seconds [s, e).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Seg {
    pub s: u64,
    pub e: u64,
    pub app: String,
    pub proj: String,
    /// What inside the app: "file · folder" in an editor, the site in a browser, else the window title.
    #[serde(default)]
    pub title: String,
}

/// A project = apps named exactly, or any of `match` inside "app + window title" (any case).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Rule {
    pub project: String,
    #[serde(default)]
    pub apps: Vec<String>,
    #[serde(default, rename = "match")]
    pub words: Vec<String>,
}

fn rules_file() -> PathBuf {
    data_dir().join("screentime-rules.json")
}

const DEFAULT_RULES: &str = r#"[
  {"project": "e2k", "match": ["e2k", "localhost:3003"]},
  {"project": "PMS", "match": ["pms", "localhost:3002"]},
  {"project": "Drive Buddy", "match": ["dashbord", "drive buddy"]},
  {"project": "Claude add-ons", "match": ["claude-addons", "notch-stats"]},
  {"project": "Messages", "apps": ["WhatsApp", "Messages", "Mail", "Slack", "Telegram"]}
]"#;

/// The owner's rules (written with defaults the first time, so they can be edited by hand).
pub fn rules() -> Vec<Rule> {
    let f = rules_file();
    if !f.exists() {
        let _ = std::fs::create_dir_all(data_dir());
        let _ = std::fs::write(&f, DEFAULT_RULES);
    }
    let text = std::fs::read_to_string(f).unwrap_or_else(|_| DEFAULT_RULES.into());
    serde_json::from_str(&text).unwrap_or_else(|_| serde_json::from_str(DEFAULT_RULES).unwrap())
}

/// Which project a window belongs to: a rule, else a code editor's open folder, else the app itself.
pub fn project(rules: &[Rule], app: &str, title: &str) -> String {
    let hay = format!("{app} {title}").to_lowercase();
    for r in rules {
        if r.apps.iter().any(|a| a == app) || r.words.iter().any(|w| !w.is_empty() && hay.contains(&w.to_lowercase())) {
            return r.project.clone();
        }
    }
    // editors title windows "file.rs — folder — Visual Studio Code"
    if EDITORS.contains(&app) {
        let parts: Vec<&str> = title.split(" — ").filter(|p| !EDITORS.contains(p) && !p.starts_with('[')).collect();
        if let Some(folder) = parts.last().filter(|_| parts.len() > 1) {
            return folder.trim().to_string();
        }
    }
    app.to_string()
}

/// What inside the app the time went to: an editor's "file · folder", a browser's site, else the window title.
pub fn detail(app: &str, title: &str, url: &str) -> String {
    if !url.is_empty() {
        let host = url.split("://").nth(1).unwrap_or(url).split(['/', '?', '#']).next().unwrap_or("");
        return host.trim_start_matches("www.").to_string();
    }
    let title = title.trim().trim_start_matches("● ");
    if EDITORS.contains(&app) {
        return title.split(" — ").filter(|p| !EDITORS.contains(p) && !p.starts_with('[')).collect::<Vec<_>>().join(" · ");
    }
    if title.is_empty() { "(no window)".into() } else { title.to_string() }
}

/// Turns samples into stretches. `sample` returns the stretches that are finished and should be written.
#[derive(Default)]
pub struct Recorder {
    pub cur: Option<Seg>,
}

impl Recorder {
    /// `front` = (app, project, title) in front now; None = away (idle, locked). `idle` = s since last input.
    pub fn sample(&mut self, now: u64, front: Option<(String, String, String)>, idle: f64) -> Vec<Seg> {
        let mut done = Vec::new();
        if let Some(c) = &self.cur {
            if now.saturating_sub(c.e) > GAP_S {
                done.extend(self.cur.take()); // asleep in between: ends where it was last seen
            }
        }
        let Some((app, proj, title)) = front.map(|(a, p, t)| (a, p, t.chars().take(80).collect::<String>())) else {
            if let Some(mut c) = self.cur.take() {
                c.e = c.e.min(now.saturating_sub(idle as u64)).max(c.s); // the idle minutes do not count
                done.push(c);
            }
            return done;
        };
        match &mut self.cur {
            Some(c) if c.app == app && c.proj == proj && c.title == title && now - c.s < FLUSH_S => c.e = now,
            _ => {
                if let Some(mut c) = self.cur.take() {
                    c.e = now;
                    done.push(c);
                }
                self.cur = Some(Seg { s: now, e: now, app, proj, title });
            }
        }
        done.retain(|c| c.e > c.s);
        done
    }
}

fn day_file(day: NaiveDate) -> PathBuf {
    data_dir().join("screentime").join(format!("{day}.jsonl"))
}

pub fn local_day(t: u64) -> NaiveDate {
    Local.timestamp_opt(t as i64, 0).single().map_or_else(|| Local::now().date_naive(), |d| d.date_naive())
}

/// Unix seconds at local midnight starting `d`.
pub fn midnight(d: NaiveDate) -> u64 {
    d.and_hms_opt(0, 0, 0).and_then(|t| t.and_local_timezone(Local).earliest()).map_or(0, |t| t.timestamp() as u64)
}

fn append(segs: &[Seg]) {
    for s in segs {
        let f = day_file(local_day(s.s));
        let _ = std::fs::create_dir_all(f.parent().unwrap());
        if let (Ok(mut out), Ok(line)) = (std::fs::OpenOptions::new().create(true).append(true).open(f), serde_json::to_string(s)) {
            let _ = writeln!(out, "{line}");
        }
    }
}

/// Stretches overlapping [from, to), clipped to it; `live` = the stretch still running.
pub fn load(from: u64, to: u64, live: Option<&Seg>) -> Vec<Seg> {
    let mut out = Vec::new();
    let (mut d, last) = (local_day(from).pred_opt().unwrap(), local_day(to)); // a stretch may start the day before
    while d <= last {
        for line in std::fs::read_to_string(day_file(d)).unwrap_or_default().lines() {
            out.extend(serde_json::from_str::<Seg>(line).ok());
        }
        d = d.succ_opt().unwrap();
    }
    out.extend(live.cloned());
    out.into_iter()
        .filter(|x| x.e > from && x.s < to)
        .map(|mut x| {
            (x.s, x.e) = (x.s.max(from), x.e.min(to));
            x
        })
        .collect()
}

/// Starts sampling in the background; the shared value is the stretch still running (for the view).
pub fn start() -> Arc<Mutex<Option<Seg>>> {
    let live = Arc::new(Mutex::new(None));
    let out = live.clone();
    std::thread::Builder::new()
        .name("screen-time".into())
        .spawn(move || {
            let mut rec = Recorder::default();
            let mut list = rules();
            let mut n = 0u64;
            loop {
                std::thread::sleep(Duration::from_secs(SAMPLE_S));
                n += 1;
                if n % 30 == 0 {
                    list = rules(); // edits to the rules file apply within a minute
                }
                let idle = crate::screentime_mac::idle_secs();
                let front = crate::screentime_mac::front();
                if front.as_ref().is_some_and(|f| SKIP.contains(&f.name.as_str())) && idle < IDLE_S {
                    continue; // our own panel or the lock screen: keep the stretch as it is
                }
                let front = front.filter(|_| idle < IDLE_S).map(|f| {
                    let title = crate::screentime_mac::window_title(f.pid);
                    let url = if f.bundle == "com.google.Chrome" { crate::screentime_mac::chrome_url() } else { String::new() };
                    (f.name.clone(), project(&list, &f.name, &format!("{title} {url}")), detail(&f.name, &title, &url))
                });
                append(&rec.sample(crate::stats::unix_secs(), front, idle));
                *live.lock().unwrap() = rec.cur.clone();
            }
        })
        .expect("screen-time thread");
    out
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Period {
    Day,
    Week,
    Month,
}

/// The period `back` steps before the current one, as local days [first, end). Weeks start on Sunday.
pub fn period_days(p: Period, back: u32, today: NaiveDate) -> (NaiveDate, NaiveDate) {
    match p {
        Period::Day => {
            let d = today - chrono::Days::new(back as u64);
            (d, d.succ_opt().unwrap())
        }
        Period::Week => {
            let sun = today - chrono::Days::new(today.weekday().num_days_from_sunday() as u64 + 7 * back as u64);
            (sun, sun + chrono::Days::new(7))
        }
        Period::Month => {
            let first = today.with_day(1).unwrap() - Months::new(back);
            (first, first + Months::new(1))
        }
    }
}

/// Seconds per name inside each of the buckets between consecutive `bounds`.
pub fn bucket(segs: &[Seg], bounds: &[u64], key: impl Fn(&Seg) -> String) -> Vec<HashMap<String, u64>> {
    let mut out = vec![HashMap::new(); bounds.len().saturating_sub(1)];
    for x in segs {
        for (i, w) in bounds.windows(2).enumerate() {
            let secs = x.e.min(w[1]).saturating_sub(x.s.max(w[0]));
            if secs > 0 {
                *out[i].entry(key(x)).or_insert(0) += secs;
            }
        }
    }
    out
}

/// Biggest first.
pub fn ranked(m: &HashMap<String, u64>) -> Vec<(String, u64)> {
    let mut v: Vec<_> = m.iter().map(|(k, v)| (k.clone(), *v)).collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(app: &str, proj: &str) -> Option<(String, String, String)> {
        Some((app.into(), proj.into(), String::new()))
    }

    #[test]
    fn projects_from_rules_then_editor_folder_then_app() {
        let r: Vec<Rule> = serde_json::from_str(DEFAULT_RULES).unwrap();
        assert_eq!(project(&r, "Code", "main.rs — e2k-new — Visual Studio Code"), "e2k");
        assert_eq!(project(&r, "Code", "lib.rs — shopify-app"), "shopify-app");
        assert_eq!(project(&r, "WhatsApp", "Chat"), "Messages");
        assert_eq!(project(&r, "Google Chrome", "Site - localhost:3002"), "PMS");
        assert_eq!(project(&r, "Finder", "Downloads"), "Finder");
    }

    #[test]
    fn details_name_the_file_site_or_window() {
        assert_eq!(detail("Code", "● main.rs — e2k-new — Visual Studio Code", ""), "main.rs · e2k-new");
        assert_eq!(detail("Google Chrome", "Lab", "http://localhost:3003/lab?x=1"), "localhost:3003");
        assert_eq!(detail("Google Chrome", "Inbox", "https://www.gmail.com/"), "gmail.com");
        assert_eq!(detail("ChatGPT", "הרב כהנא", ""), "הרב כהנא");
        assert_eq!(detail("Finder", "", ""), "(no window)");
    }

    #[test]
    fn recorder_merges_splits_and_drops_idle() {
        let mut r = Recorder::default();
        assert!(r.sample(100, f("Code", "e2k"), 0.0).is_empty());
        assert!(r.sample(102, f("Code", "e2k"), 0.0).is_empty());
        let done = r.sample(104, f("Chrome", "PMS"), 0.0);
        assert_eq!((done[0].s, done[0].e, done[0].proj.as_str()), (100, 104, "e2k"));
        r.sample(106, f("Chrome", "PMS"), 0.0);
        // away: 180 s idle at 400 → the stretch ends at 220, not 400
        let mut t = 106;
        while t < 398 {
            t += 2;
            r.sample(t, f("Chrome", "PMS"), (t - 106) as f64);
        }
        let done = r.sample(400, None, 294.0);
        assert_eq!((done[0].s, done[0].e), (104, 106));
        // a long stretch is cut every FLUSH_S so a crash loses little
        let mut r = Recorder::default();
        let mut n = 0;
        for t in (0..700).step_by(2) {
            n += r.sample(t, f("Code", "e2k"), 0.0).len();
        }
        assert_eq!(n, 2);
        // the Mac slept: the stretch ends where it was last seen
        let done = r.sample(5000, f("Code", "e2k"), 0.0);
        assert_eq!(done[0].e, 698);
    }

    #[test]
    fn periods_and_buckets() {
        let tue = NaiveDate::from_ymd_opt(2026, 11, 17).unwrap();
        assert_eq!(period_days(Period::Week, 0, tue).0, NaiveDate::from_ymd_opt(2026, 11, 15).unwrap());
        assert_eq!(period_days(Period::Month, 1, tue), (NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(), NaiveDate::from_ymd_opt(2026, 11, 1).unwrap()));
        let s = Seg { s: 50, e: 250, app: "a".into(), proj: "p".into(), title: String::new() };
        let b = bucket(&[s], &[0, 100, 200, 300], |x| x.proj.clone());
        assert_eq!([b[0]["p"], b[1]["p"], b[2]["p"]], [50, 100, 50]);
    }
}
