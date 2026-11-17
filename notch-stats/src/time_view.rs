//! The Time view: where the hours went, by day / week / month (approved design "A · timeline"):
//! total and change vs the same stretch of the previous period, a picture of when (day ribbon,
//! week bars, month calendar) and the projects ranked.

use crate::screentime::{self as st, Period, Seg};
use crate::stats::unix_secs;
use crate::{CARD, DIM, FAINT, alpha, short};
use chrono::{Datelike, Local, NaiveDate};
use eframe::egui::{self, Align2, Color32, FontId, Rect, Sense, pos2, vec2};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PALETTE: [Color32; 8] = [
    Color32::from_rgb(217, 119, 87),
    Color32::from_rgb(100, 210, 255),
    Color32::from_rgb(138, 132, 255),
    Color32::from_rgb(48, 209, 88),
    Color32::from_rgb(255, 159, 10),
    Color32::from_rgb(255, 55, 95),
    Color32::from_rgb(191, 90, 242),
    Color32::from_rgb(255, 214, 10),
];
const GOOD: Color32 = Color32::from_rgb(48, 209, 88);
const BAD: Color32 = Color32::from_rgb(255, 69, 58);
const REFRESH: Duration = Duration::from_secs(15);
const ROW_H: f32 = 22.0;

struct Data {
    days: Vec<NaiveDate>,
    per_day: Vec<HashMap<String, u64>>,
    slots: Vec<HashMap<String, u64>>, // Day only: one per SLOT_S
    totals: HashMap<String, u64>,
    prev: HashMap<String, u64>,
    apps: HashMap<String, Vec<(String, u64)>>, // per project, biggest first
    elapsed_days: u64,
}

pub struct Time {
    live: Arc<Mutex<Option<Seg>>>,
    period: Period,
    back: u32,
    data: Option<(Period, u32, Instant, Data)>,
    colors: Vec<String>, // rule order = fixed colours for the owner's projects
}

impl Time {
    pub fn start() -> Self {
        Time { live: st::start(), period: Period::Day, back: 0, data: None, colors: Vec::new() }
    }

    fn color(&self, name: &str) -> Color32 {
        let i = self.colors.iter().position(|c| c == name).unwrap_or_else(|| {
            // ponytail: other names get a colour from their letters; two may share one
            self.colors.len() + name.bytes().fold(7usize, |h, b| h.wrapping_mul(31).wrapping_add(b as usize))
        });
        PALETTE[i % PALETTE.len()]
    }

    pub fn draw(&mut self, ui: &mut egui::Ui, p: &egui::Painter, b: Rect, a: f32) {
        let fresh = matches!(&self.data, Some((pp, bb, at, _)) if *pp == self.period && *bb == self.back && at.elapsed() < REFRESH);
        if !fresh {
            self.colors = st::rules().into_iter().map(|r| r.project).collect();
            let live = self.live.lock().unwrap().clone();
            self.data = Some((self.period, self.back, Instant::now(), compute(self.period, self.back, live)));
        }
        self.header(ui, p, b, a);
        let Some((_, _, _, d)) = &self.data else { return };
        let total: u64 = d.totals.values().sum();
        let prev: u64 = d.prev.values().sum();
        let y = b.top() + 34.0;
        let big = p.text(pos2(b.left() + 2.0, y), Align2::LEFT_TOP, fmt(total), FontId::proportional(24.0), alpha(Color32::WHITE, a));
        let sub = if self.period == Period::Day { "active".to_string() } else { format!("avg/day {}", fmt(total / d.elapsed_days.max(1))) };
        p.text(pos2(big.right() + 10.0, big.bottom() - 4.0), Align2::LEFT_BOTTOM, sub, FontId::proportional(12.0), alpha(DIM, a));
        let (dt, dc) = delta(total, prev);
        let vs = format!("vs {} {}", if self.back == 0 { "same time" } else { "the" }, ["yesterday", "last week", "last month"][self.period as usize]);
        let r = p.text(pos2(b.right() - 2.0, big.bottom() - 4.0), Align2::RIGHT_BOTTOM, vs, FontId::proportional(12.0), alpha(DIM, a));
        p.text(pos2(r.left() - 6.0, big.bottom() - 4.0), Align2::RIGHT_BOTTOM, dt, FontId::proportional(12.0), alpha(dc, a));

        let top = big.bottom() + 12.0;
        if total == 0 {
            let msg = if self.back == 0 { "Recording — the first minutes show up here shortly" } else { "Nothing recorded" };
            p.text(pos2(b.center().x, top + 60.0), Align2::CENTER_CENTER, msg, FontId::proportional(12.0), alpha(DIM, a));
        } else {
            match self.period {
                Period::Day => {
                    let card = Rect::from_min_size(pos2(b.left(), top), vec2(b.width(), 70.0));
                    self.ribbon(ui, p, card, d, a);
                    self.list(p, Rect::from_min_max(pos2(b.left(), card.bottom() + 12.0), b.max), d, a);
                }
                Period::Week => {
                    let card = Rect::from_min_size(pos2(b.left(), top), vec2(b.width(), 160.0));
                    self.week(ui, p, card, d, a);
                    self.list(p, Rect::from_min_max(pos2(b.left(), card.bottom() + 12.0), b.max), d, a);
                }
                Period::Month => {
                    let card = Rect::from_min_max(pos2(b.left(), top), pos2(b.left() + 300.0, b.bottom()));
                    self.month(ui, p, card, d, a);
                    self.list(p, Rect::from_min_max(pos2(card.right() + 16.0, top + 4.0), b.max), d, a);
                }
            }
        }
    }

    /// ‹ label › on the left, Day / Week / Month on the right.
    fn header(&mut self, ui: &mut egui::Ui, p: &egui::Painter, b: Rect, a: f32) {
        let y = b.top() + 11.0;
        let today = Local::now().date_naive();
        let (first, end) = st::period_days(self.period, self.back, today);
        let last = end.pred_opt().unwrap();
        let label = match (self.period, self.back) {
            (Period::Day, 0) => format!("Today · {}", first.format("%a %-d %b")),
            (Period::Day, 1) => format!("Yesterday · {}", first.format("%a %-d %b")),
            (Period::Day, _) => first.format("%a %-d %b").to_string(),
            (Period::Week, n) => format!("{}{}–{}", if n == 0 { "This week · " } else { "" }, first.format("%-d %b"), last.format("%-d %b")),
            (Period::Month, _) => first.format("%B %Y").to_string(),
        };
        let mut x = b.left();
        for (i, arrow) in ["‹", "›"].into_iter().enumerate() {
            let r = Rect::from_min_size(pos2(x, y - 11.0), vec2(24.0, 22.0));
            let usable = i == 0 || self.back > 0;
            let resp = ui.interact(r, ui.scope_id().with(("time-nav", i)), Sense::click());
            if resp.hovered() && usable {
                p.rect_filled(r, 6.0, alpha(Color32::from_gray(28), a));
            }
            p.text(r.center(), Align2::CENTER_CENTER, arrow, FontId::proportional(15.0), alpha(if usable { Color32::WHITE } else { FAINT }, a));
            if resp.clicked() && usable {
                self.back = if i == 0 { self.back + 1 } else { self.back - 1 };
            }
            x = r.right();
            if i == 0 {
                let t = p.text(pos2(x + 8.0, y), Align2::LEFT_CENTER, &label, FontId::proportional(13.0), alpha(Color32::WHITE, a));
                x = t.right() + 8.0;
            }
        }
        let mut x = b.right();
        for (i, (name, per)) in [("Day", Period::Day), ("Week", Period::Week), ("Month", Period::Month)].into_iter().enumerate().rev() {
            let r = Rect::from_min_size(pos2(x - 52.0, y - 11.0), vec2(52.0, 22.0));
            x -= 56.0;
            let resp = ui.interact(r, ui.scope_id().with(("time-period", i)), Sense::click());
            if resp.clicked() && self.period != per {
                (self.period, self.back) = (per, 0);
            }
            let on = self.period == per;
            let fill = if on { Color32::from_gray(48) } else if resp.hovered() { Color32::from_gray(28) } else { Color32::TRANSPARENT };
            p.rect_filled(r, 6.0, alpha(fill, a));
            p.text(r.center(), Align2::CENTER_CENTER, name, FontId::proportional(12.0), alpha(if on { Color32::WHITE } else { DIM }, a));
        }
    }

    /// The day as a strip from 8:00 (or earlier) to midnight; each 5 min slot coloured by its project.
    /// A slot split between two projects shows both, stacked by share.
    fn ribbon(&self, ui: &mut egui::Ui, p: &egui::Painter, card: Rect, d: &Data, a: f32) {
        p.rect_filled(card, 9.0, alpha(CARD, a));
        let per_h = (3600 / st::SLOT_S) as usize;
        let first = d.slots.iter().position(|s| !s.is_empty()).unwrap_or(0) / per_h;
        let h0 = first.min(8);
        let strip = Rect::from_min_max(card.min + vec2(12.0, 12.0), pos2(card.right() - 12.0, card.top() + 40.0));
        p.rect_filled(strip, 3.0, alpha(Color32::from_gray(26), a));
        let n = (24 - h0) * per_h;
        let w = strip.width() / n as f32;
        for (i, slot) in d.slots.iter().enumerate().skip(h0 * per_h) {
            let used: u64 = slot.values().sum();
            if used < 30 {
                continue;
            }
            let x = strip.left() + (i - h0 * per_h) as f32 * w;
            let r = Rect::from_min_size(pos2(x, strip.top()), vec2(w.max(1.0), strip.height()));
            let mut yy = r.top();
            for (name, secs) in st::ranked(slot).into_iter().take(2) {
                let h = r.height() * secs as f32 / used as f32;
                p.rect_filled(Rect::from_min_size(pos2(r.left(), yy), vec2(r.width(), h)), 0.0, alpha(self.color(&name), a));
                yy += h;
            }
            let at = i as u64 * st::SLOT_S;
            let tip: Vec<String> = st::ranked(slot).iter().map(|(k, v)| format!("{k} {}", fmt(*v))).collect();
            ui.interact(r, ui.scope_id().with(("slot", i)), Sense::hover())
                .on_hover_text(format!("{:02}:{:02} · {}", at / 3600, at % 3600 / 60, tip.join(" · ")));
        }
        for h in (h0..=24).step_by(2) {
            let x = strip.left() + ((h - h0) * per_h) as f32 * w;
            p.text(pos2(x, strip.bottom() + 6.0), Align2::CENTER_TOP, format!("{:02}", h % 24), FontId::proportional(10.0), alpha(DIM, a));
        }
    }

    /// One stacked bar per day, biggest project at the bottom.
    fn week(&self, ui: &mut egui::Ui, p: &egui::Painter, card: Rect, d: &Data, a: f32) {
        p.rect_filled(card, 9.0, alpha(CARD, a));
        let area = Rect::from_min_max(card.min + vec2(12.0, 12.0), card.max - vec2(12.0, 26.0));
        let max = d.per_day.iter().map(|m| m.values().sum::<u64>()).max().unwrap_or(1).max(1);
        let cw = area.width() / d.days.len() as f32;
        for (i, (day, m)) in d.days.iter().zip(&d.per_day).enumerate() {
            let x = area.left() + i as f32 * cw;
            let mut y = area.bottom();
            for (name, secs) in st::ranked(m) {
                let h = area.height() * secs as f32 / max as f32;
                let r = Rect::from_min_max(pos2(x + cw * 0.2, y - h), pos2(x + cw * 0.8, y - 1.0));
                p.rect_filled(r, 2.0, alpha(self.color(&name), a));
                ui.interact(r, ui.scope_id().with(("wk", i, name.as_str())), Sense::hover())
                    .on_hover_text(format!("{} · {name} · {}", day.format("%a %-d %b"), fmt(secs)));
                y -= h;
            }
            let label = format!("{} · {}", day.format("%a"), fmt(m.values().sum()));
            p.text(pos2(x + cw / 2.0, area.bottom() + 8.0), Align2::CENTER_TOP, label, FontId::proportional(10.5), alpha(DIM, a));
        }
    }

    /// A calendar: each day in its top project's colour, brighter for longer days.
    fn month(&self, ui: &mut egui::Ui, p: &egui::Painter, card: Rect, d: &Data, a: f32) {
        p.rect_filled(card, 9.0, alpha(CARD, a));
        let area = card.shrink(12.0);
        let (cw, gap) = ((area.width() - 6.0 * 4.0) / 7.0, 4.0);
        for (i, w) in ["S", "M", "T", "W", "T", "F", "S"].iter().enumerate() {
            p.text(pos2(area.left() + i as f32 * (cw + gap) + cw / 2.0, area.top()), Align2::CENTER_TOP, *w, FontId::proportional(10.0), alpha(DIM, a));
        }
        let max = d.per_day.iter().map(|m| m.values().sum::<u64>()).max().unwrap_or(1).max(1);
        let lead = d.days[0].weekday().num_days_from_sunday() as usize;
        let rows = (lead + d.days.len()).div_ceil(7);
        let ch = ((area.height() - 18.0 - (rows as f32 - 1.0) * gap) / rows as f32).min(34.0);
        for (i, (day, m)) in d.days.iter().zip(&d.per_day).enumerate() {
            let k = lead + i;
            let r = Rect::from_min_size(pos2(area.left() + (k % 7) as f32 * (cw + gap), area.top() + 18.0 + (k / 7) as f32 * (ch + gap)), vec2(cw, ch));
            let total: u64 = m.values().sum();
            let topp = st::ranked(m).into_iter().next();
            let fill = match &topp {
                Some((name, _)) => alpha(self.color(name), a * (0.25 + 0.75 * total as f32 / max as f32)),
                None => alpha(Color32::from_gray(26), a),
            };
            p.rect_filled(r, 4.0, fill);
            p.text(r.left_top() + vec2(4.0, 3.0), Align2::LEFT_TOP, day.day().to_string(), FontId::proportional(9.0), alpha(Color32::from_white_alpha(150), a));
            if let Some((name, _)) = topp {
                ui.interact(r, ui.scope_id().with(("mo", i)), Sense::hover()).on_hover_text(format!("{} · {} · mostly {name}", day.format("%-d %b"), fmt(total)));
            }
        }
    }

    /// Projects ranked: colour, name, its main apps, a bar, time, change vs the previous period.
    fn list(&self, p: &egui::Painter, r: Rect, d: &Data, a: f32) {
        let rows = st::ranked(&d.totals);
        let max = rows.first().map_or(1, |x| x.1).max(1);
        let narrow = r.width() < 500.0;
        let mut y = r.top();
        // ponytail: as many rows as fit; the rest are not shown
        for (name, secs) in rows {
            if y + ROW_H > r.bottom() {
                break;
            }
            let mid = y + ROW_H / 2.0;
            let c = self.color(&name);
            p.rect_filled(Rect::from_center_size(pos2(r.left() + 6.0, mid), vec2(8.0, 8.0)), 2.0, alpha(c, a));
            p.text(pos2(r.left() + 18.0, mid), Align2::LEFT_CENTER, short(&name, 20), FontId::proportional(12.0), alpha(Color32::WHITE, a));
            let mut bar_l = r.left() + 150.0;
            if !narrow {
                let apps: Vec<&str> = d.apps.get(&name).map(|v| v.iter().take(2).map(|x| x.0.as_str()).collect()).unwrap_or_default();
                p.text(pos2(bar_l, mid), Align2::LEFT_CENTER, short(&apps.join(" · "), 26), FontId::proportional(10.5), alpha(DIM, a));
                bar_l += 170.0;
            }
            let bar = Rect::from_min_max(pos2(bar_l, mid - 3.0), pos2(r.right() - 120.0, mid + 3.0));
            crate::bar(p, bar, &[(secs as f32 / max as f32, c)], a);
            p.text(pos2(r.right() - 52.0, mid), Align2::RIGHT_CENTER, fmt(secs), FontId::proportional(12.0), alpha(Color32::WHITE, a));
            let (dt, dc) = delta(secs, d.prev.get(&name).copied().unwrap_or(0));
            p.text(pos2(r.right() - 2.0, mid), Align2::RIGHT_CENTER, dt, FontId::proportional(10.5), alpha(dc, a));
            y += ROW_H;
        }
    }
}

/// Everything one view needs, read from the day files once (refreshed every 15 s while open).
fn compute(period: Period, back: u32, live: Option<Seg>) -> Data {
    let today = Local::now().date_naive();
    let now = unix_secs();
    let (first, end) = st::period_days(period, back, today);
    let days: Vec<NaiveDate> = first.iter_days().take_while(|d| *d < end).collect();
    let mut bounds: Vec<u64> = days.iter().map(|d| st::midnight(*d)).collect();
    bounds.push(st::midnight(end));
    let (from, to) = (bounds[0], bounds[bounds.len() - 1].min(now));
    let segs = st::load(from, to, live.as_ref());
    let proj = |s: &Seg| s.proj.clone();
    let per_day = st::bucket(&segs, &bounds, proj);
    let totals = st::bucket(&segs, &[from, to.max(from)], proj).pop().unwrap_or_default();
    let slots = if period == Period::Day { st::bucket(&segs, &(0..=86400 / st::SLOT_S).map(|i| from + i * st::SLOT_S).collect::<Vec<_>>(), proj) } else { Vec::new() };
    let mut apps: HashMap<String, Vec<(String, u64)>> = HashMap::new();
    for (k, v) in st::ranked(&st::bucket(&segs, &[from, to.max(from)], |s| format!("{}\t{}", s.proj, s.app)).pop().unwrap_or_default()) {
        let (p, app) = k.split_once('\t').unwrap_or_default();
        if p != app {
            apps.entry(p.to_string()).or_default().push((app.to_string(), v));
        }
    }
    // previous period; for the current one only up to the same point, so a half day is not judged against a whole one
    let (pf, pe) = st::period_days(period, back + 1, today);
    let (pfrom, pend) = (st::midnight(pf), st::midnight(pe));
    let pto = if back == 0 { (pfrom + now.saturating_sub(from)).min(pend) } else { pend };
    let prev = st::bucket(&st::load(pfrom, pto, None), &[pfrom, pto.max(pfrom)], proj).pop().unwrap_or_default();
    let elapsed_days = days.iter().filter(|d| **d <= today).count() as u64;
    Data { days, per_day, slots, totals, prev, apps, elapsed_days }
}

fn fmt(secs: u64) -> String {
    let m = secs / 60;
    match m {
        0 if secs > 0 => "<1m".into(),
        0..60 => format!("{m}m"),
        _ => format!("{}h {:02}m", m / 60, m % 60),
    }
}

fn delta(cur: u64, prev: u64) -> (String, Color32) {
    if prev == 0 {
        return (if cur > 0 { "new".into() } else { String::new() }, DIM);
    }
    let pct = (cur as f64 - prev as f64) / prev as f64 * 100.0;
    if pct >= 0.0 { (format!("+{pct:.0}%"), GOOD) } else { (format!("−{:.0}%", -pct), BAD) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_and_changes_read_right() {
        assert_eq!([fmt(0), fmt(30), fmt(600), fmt(3900)], ["0m", "<1m", "10m", "1h 05m"]);
        assert_eq!(delta(150, 100).0, "+50%");
        assert_eq!(delta(50, 100).0, "−50%");
        assert_eq!(delta(10, 0).0, "new");
    }
}
