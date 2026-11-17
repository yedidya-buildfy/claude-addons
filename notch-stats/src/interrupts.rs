//! Interruption log: the owner marks "interrupted" / "back" by hand; every interruption is kept with its
//! absolute start and end so it can be shown to a partner. Also measures "back to focus": how long after
//! the interruption ended until the project worked on before it was in front again (from screen time).
//! Files: `interruptions.jsonl` (one line per finished one), `interruption-open` (start of the running one).

use crate::screentime::{self as st, Seg};
use crate::stats::data_dir;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;

/// Waiting longer than this to get back to the same project = not counted as "back to focus".
pub const FOCUS_CAP_S: u64 = 3600;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Interruption {
    pub s: u64,
    pub e: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

fn log_file() -> PathBuf {
    data_dir().join("interruptions.jsonl")
}
fn open_file() -> PathBuf {
    data_dir().join("interruption-open")
}

/// Start of the interruption still running, if any (kept on disk so a restart does not lose it).
pub fn running() -> Option<u64> {
    std::fs::read_to_string(open_file()).ok()?.trim().parse().ok()
}

pub fn begin(now: u64) {
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::write(open_file(), now.to_string());
}

/// Ends the running interruption and keeps it.
pub fn end(now: u64) {
    let Some(s) = running() else { return };
    let line = serde_json::to_string(&Interruption { s, e: now.max(s), note: String::new() }).unwrap();
    let ok = std::fs::OpenOptions::new().create(true).append(true).open(log_file()).and_then(|mut f| writeln!(f, "{line}"));
    if ok.is_ok() {
        let _ = std::fs::remove_file(open_file());
    }
}

fn all() -> Vec<Interruption> {
    std::fs::read_to_string(log_file()).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// Rewrites the whole log (temp file + rename, so a crash never leaves half of it).
fn save(v: &[Interruption]) -> bool {
    let tmp = log_file().with_extension("tmp");
    let body: String = v.iter().map(|x| serde_json::to_string(x).unwrap() + "\n").collect();
    std::fs::create_dir_all(data_dir()).and_then(|_| std::fs::write(&tmp, body)).and_then(|_| std::fs::rename(&tmp, log_file())).is_ok()
}

/// Adds one after the fact (or replaces the one starting at the same second).
pub fn add(i: Interruption) -> bool {
    let mut v = all();
    v.retain(|x| x.s != i.s);
    v.push(i);
    v.sort_by_key(|x| x.s);
    save(&v)
}

/// The interruption starting at `s` (unix seconds) is the key for edit and delete.
pub fn set_note(s: u64, note: &str) -> bool {
    let mut v = all();
    v.iter_mut().filter(|x| x.s == s).for_each(|x| x.note = note.trim().to_string());
    save(&v)
}

pub fn remove(s: u64) -> bool {
    let mut v = all();
    v.retain(|x| x.s != s);
    save(&v)
}

/// "14:10-14:25" (also with – or spaces) on `day` -> [start, end) unix seconds; None if unreadable,
/// backwards, or in the future.
pub fn parse_span(text: &str, day: NaiveDate, now: u64) -> Option<(u64, u64)> {
    let t: String = text.chars().map(|c| if c == '–' || c == '—' { '-' } else { c }).filter(|c| !c.is_whitespace()).collect();
    let (a, b) = t.split_once('-')?;
    let at = |x: &str| -> Option<u64> {
        let tm = chrono::NaiveTime::parse_from_str(x, "%H:%M").ok()?;
        let dt = day.and_time(tm).and_local_timezone(chrono::Local).earliest()?;
        Some(dt.timestamp() as u64)
    };
    let (s, e) = (at(a)?, at(b)?);
    (s < e && e <= now).then_some((s, e))
}

/// Interruptions overlapping [from, to), oldest first; the running one up to `now`.
pub fn load(from: u64, to: u64, now: u64) -> Vec<Interruption> {
    let mut v = all();
    v.extend(running().map(|s| Interruption { s, e: now.max(s), note: String::new() }));
    v.retain(|x| x.e > from && x.s < to);
    v.sort_by_key(|x| x.s);
    v
}

/// Seconds from the end of `i` until the project in front just before it is in front again
/// (None: nothing was in front before, or no return within FOCUS_CAP_S). `segs` = screen time around it.
pub fn back_to_focus(i: &Interruption, segs: &[Seg]) -> Option<u64> {
    let before = segs.iter().filter(|x| x.s < i.s && x.e + 2 * st::SAMPLE_S >= i.s).max_by_key(|x| x.e)?;
    let back = segs.iter().filter(|x| x.e > i.e && x.proj == before.proj).map(|x| x.s.max(i.e)).min()?;
    Some(back - i.e).filter(|d| *d <= FOCUS_CAP_S)
}

/// One period's numbers: THE source for both the Log tab and the partner report.
pub struct Summary {
    pub days: Vec<NaiveDate>,
    pub list: Vec<(Interruption, Option<u64>)>, // with its back-to-focus seconds
    pub per_day: Vec<(usize, u64)>,             // count, seconds lost
    pub lost: u64,
    pub focus: u64,
    pub active: u64, // screen time in the period
}

impl Summary {
    /// Interruption time as a share of active screen time, in %.
    pub fn share(&self) -> f64 {
        self.lost as f64 * 100.0 / self.active.max(1) as f64
    }
}

/// Days [first, end) up to `now`.
pub fn summary(first: NaiveDate, end: NaiveDate, now: u64) -> Summary {
    let days: Vec<NaiveDate> = first.iter_days().take_while(|d| *d < end).collect();
    let (from, to) = (st::midnight(first), st::midnight(end));
    let segs = st::load(from.saturating_sub(3600), (to + FOCUS_CAP_S).min(now), None);
    let list: Vec<_> = load(from, to, now).into_iter().map(|i| {
        let f = back_to_focus(&i, &segs);
        (i, f)
    }).collect();
    let per_day = days
        .iter()
        .map(|d| {
            let mine: Vec<_> = list.iter().filter(|x| st::local_day(x.0.s) == *d).collect();
            (mine.len(), mine.iter().map(|x| x.0.e - x.0.s).sum())
        })
        .collect();
    let lost = list.iter().map(|x| x.0.e - x.0.s).sum();
    let focus = list.iter().filter_map(|x| x.1).sum();
    let active = st::bucket(&segs, &[from, to.min(now).max(from)], |_| String::new()).pop().unwrap_or_default().values().sum();
    Summary { days, list, per_day, lost, focus, active }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(s: u64, e: u64, proj: &str) -> Seg {
        Seg { s, e, app: "Code".into(), proj: proj.into(), title: String::new() }
    }

    #[test]
    fn back_to_focus_is_the_wait_for_the_same_project() {
        let i = Interruption { s: 1000, e: 1600, note: String::new() };
        let segs = [seg(0, 1000, "e2k"), seg(1600, 1900, "Mail"), seg(1900, 2500, "e2k")];
        assert_eq!(back_to_focus(&i, &segs), Some(300));
        // straight back to it
        assert_eq!(back_to_focus(&i, &[seg(0, 1000, "e2k"), seg(1600, 2000, "e2k")]), Some(0));
        // nothing in front before it, or never back within the hour
        assert_eq!(back_to_focus(&i, &[seg(0, 500, "e2k"), seg(1600, 2000, "e2k")]), None);
        assert_eq!(back_to_focus(&i, &[seg(0, 1000, "e2k"), seg(9000, 9100, "e2k")]), None);
    }

    #[test]
    fn typed_times_read_on_the_day() {
        let day = NaiveDate::from_ymd_opt(2026, 11, 17).unwrap();
        let now = st::midnight(day) + 86400;
        let (s, e) = parse_span(" 14:10 – 14:25 ", day, now).unwrap();
        assert_eq!((s - st::midnight(day), e - s), (14 * 3600 + 600, 900));
        assert!(parse_span("14:25-14:10", day, now).is_none()); // backwards
        assert!(parse_span("14:10", day, now).is_none());
        assert!(parse_span("23:00-23:30", day, st::midnight(day) + 3600).is_none()); // future
    }
}
