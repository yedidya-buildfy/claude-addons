//! The Log view (approved design "B · interruption log"): a Start / End interruption button, the totals
//! for the day / week / month, a picture of when, and a report in Hebrew to show a partner.

use crate::interrupts::{self as int, Interruption, Summary};
use crate::screentime::{self as st, Period};
use crate::stats::unix_secs;
use crate::time_view::{fmt, period_nav};
use crate::{CARD, DIM, alpha};
use chrono::{Local, TimeZone};
use eframe::egui::{self, Align2, Color32, FontId, Rect, Sense, pos2, vec2};
use std::time::{Duration, Instant};

pub const RED: Color32 = Color32::from_rgb(255, 69, 58);
const REFRESH: Duration = Duration::from_secs(10);

pub struct Log {
    pub running: Option<u64>,
    period: Period,
    back: u32,
    data: Option<(Period, u32, Instant, Summary)>,
    said: Option<(Instant, &'static str)>,
}

impl Log {
    pub fn new() -> Self {
        Log { running: int::running(), period: Period::Day, back: 0, data: None, said: None }
    }

    /// Start or end an interruption (the tab's button and the red mark in the top strip).
    pub fn toggle(&mut self) {
        let now = unix_secs();
        if self.running.is_some() {
            int::end(now);
        } else {
            int::begin(now);
        }
        self.running = int::running();
        self.data = None;
    }

    pub fn draw(&mut self, ui: &mut egui::Ui, p: &egui::Painter, b: Rect, a: f32) {
        let fresh = matches!(&self.data, Some((pp, bb, at, _)) if *pp == self.period && *bb == self.back && at.elapsed() < REFRESH);
        if !fresh {
            self.data = Some((self.period, self.back, Instant::now(), { let (f, e) = st::period_days(self.period, self.back, Local::now().date_naive()); int::summary(f, e, unix_secs()) }));
        }
        if self.running.is_some() {
            ui.ctx().request_repaint_after(Duration::from_secs(1));
        }
        period_nav(ui, p, b, &mut self.period, &mut self.back, "log", a);
        let top = b.top() + 32.0;
        self.button(ui, p, Rect::from_min_size(pos2(b.left(), top), vec2(170.0, 62.0)), a);
        let Some((_, _, _, d)) = &self.data else { return };
        let lost = d.lost;
        let kpis = [
            ("Interruptions", d.list.len().to_string(), Color32::WHITE, String::new()),
            ("Time lost", fmt(lost), RED, if d.list.is_empty() { String::new() } else { format!("avg {}", fmt(lost / d.list.len() as u64)) }),
            ("Back to focus", if d.list.iter().any(|x| x.1.is_some()) { format!("+{}", fmt(d.focus)) } else { "—".into() }, Color32::WHITE, "to return to the same project".into()),
            ("Share of work", format!("{:.0}%", d.share()), Color32::WHITE, format!("of {} active", fmt(d.active))),
        ];
        let w = (b.right() - b.left() - 178.0 - 3.0 * 8.0) / 4.0;
        for (i, (name, v, c, sub)) in kpis.into_iter().enumerate() {
            let r = Rect::from_min_size(pos2(b.left() + 178.0 + i as f32 * (w + 8.0), top), vec2(w, 62.0));
            p.rect_filled(r, 9.0, alpha(CARD, a));
            p.text(r.left_top() + vec2(10.0, 8.0), Align2::LEFT_TOP, name, FontId::proportional(11.0), alpha(DIM, a));
            p.text(r.left_top() + vec2(10.0, 22.0), Align2::LEFT_TOP, v, FontId::proportional(20.0), alpha(c, a));
            p.text(r.left_bottom() + vec2(10.0, -6.0), Align2::LEFT_BOTTOM, sub, FontId::proportional(9.5), alpha(DIM, a));
        }
        let body = Rect::from_min_max(pos2(b.left(), top + 72.0), pos2(b.right(), b.bottom() - 30.0));
        p.rect_filled(body, 9.0, alpha(CARD, a));
        if d.list.is_empty() {
            p.text(body.center(), Align2::CENTER_CENTER, "No interruptions", FontId::proportional(12.0), alpha(DIM, a));
        } else if self.period == Period::Day {
            rows(p, body.shrink2(vec2(12.0, 8.0)), &d.list, self.running, a);
        } else {
            bars(ui, p, body.shrink2(vec2(12.0, 10.0)), d, a);
        }
        self.share(ui, p, Rect::from_min_max(pos2(b.left(), b.bottom() - 22.0), b.max), a);
    }

    fn button(&mut self, ui: &mut egui::Ui, p: &egui::Painter, r: Rect, a: f32) {
        let resp = ui.interact(r, ui.scope_id().with("int-button"), Sense::click());
        if resp.clicked() {
            self.toggle();
        }
        let (fill, line1, line2) = match self.running {
            Some(s) => (RED, "End interruption".to_string(), clock(unix_secs().saturating_sub(s))),
            None => (Color32::from_rgb(44, 22, 22), "Start interruption".to_string(), "click when someone interrupts".to_string()),
        };
        p.rect_filled(r, 9.0, alpha(if resp.hovered() { fill.gamma_multiply(1.15) } else { fill }, a));
        p.circle_filled(pos2(r.left() + 16.0, r.top() + 20.0), 5.0, alpha(if self.running.is_some() { Color32::WHITE } else { RED }, a));
        p.text(pos2(r.left() + 28.0, r.top() + 20.0), Align2::LEFT_CENTER, line1, FontId::proportional(13.0), alpha(Color32::WHITE, a));
        let size = if self.running.is_some() { 18.0 } else { 10.0 };
        p.text(pos2(r.left() + 12.0, r.bottom() - 8.0), Align2::LEFT_BOTTOM, line2, FontId::proportional(size), alpha(Color32::from_white_alpha(200), a));
    }

    /// "Open report" (a page in Hebrew for a partner) and "Copy as text", bottom right.
    fn share(&mut self, ui: &mut egui::Ui, p: &egui::Painter, r: Rect, a: f32) {
        let mut x = r.right();
        for (i, label) in ["Copy as text", "Open report"].into_iter().enumerate() {
            let w = 96.0;
            let br = Rect::from_min_size(pos2(x - w, r.top()), vec2(w, 22.0));
            x -= w + 6.0;
            let resp = ui.interact(br, ui.scope_id().with(("int-share", i)), Sense::click());
            p.rect_filled(br, 6.0, alpha(Color32::from_gray(if resp.hovered() { 40 } else { 28 }), a));
            p.text(br.center(), Align2::CENTER_CENTER, label, FontId::proportional(11.5), alpha(Color32::WHITE, a));
            if resp.clicked() {
                let (first, end) = st::period_days(self.period, self.back, Local::now().date_naive());
                let rep = crate::interrupts_report::build(first, end, unix_secs());
                self.said = Some((Instant::now(), if i == 0 { crate::interrupts_report::copy(&rep) } else { crate::interrupts_report::open(&rep) }));
            }
        }
        if let Some((at, msg)) = self.said.filter(|(at, _)| at.elapsed() < Duration::from_secs(3)) {
            ui.ctx().request_repaint_after(Duration::from_millis(300));
            let _ = at;
            p.text(pos2(x - 4.0, r.center().y), Align2::RIGHT_CENTER, msg, FontId::proportional(11.0), alpha(DIM, a));
        }
    }
}

/// One line per interruption: start–end, how long, back to focus.
fn rows(p: &egui::Painter, r: Rect, list: &[(Interruption, Option<u64>)], running: Option<u64>, a: f32) {
    let mut y = r.top();
    // ponytail: as many as fit, newest first
    for (i, focus) in list.iter().rev() {
        if y + 20.0 > r.bottom() {
            break;
        }
        let mid = y + 10.0;
        p.circle_filled(pos2(r.left() + 4.0, mid), 3.0, alpha(RED, a));
        p.text(pos2(r.left() + 16.0, mid), Align2::LEFT_CENTER, if running == Some(i.s) { format!("{} – now", hm(i.s)) } else { format!("{} – {}", hm(i.s), hm(i.e)) }, FontId::proportional(12.0), alpha(Color32::WHITE, a));
        p.text(pos2(r.left() + 140.0, mid), Align2::LEFT_CENTER, fmt(i.e - i.s), FontId::proportional(12.0), alpha(RED, a));
        let f = focus.map_or("—".to_string(), |s| format!("back to focus +{}", fmt(s)));
        p.text(pos2(r.left() + 220.0, mid), Align2::LEFT_CENTER, f, FontId::proportional(11.0), alpha(DIM, a));
        y += 20.0;
    }
}

/// One bar per day: time lost; label = day · count.
fn bars(ui: &mut egui::Ui, p: &egui::Painter, r: Rect, d: &Summary, a: f32) {
    let area = Rect::from_min_max(r.min, r.max - vec2(0.0, 16.0));
    let max = d.per_day.iter().map(|x| x.1).max().unwrap_or(1).max(1);
    let cw = area.width() / d.days.len() as f32;
    for (k, (day, (n, secs))) in d.days.iter().zip(&d.per_day).enumerate() {
        let x = area.left() + k as f32 * cw;
        let h = area.height() * *secs as f32 / max as f32;
        let br = Rect::from_min_max(pos2(x + cw * 0.25, area.bottom() - h), pos2(x + cw * 0.75, area.bottom()));
        p.rect_filled(br, 2.0, alpha(RED, a));
        ui.interact(br.expand2(vec2(cw * 0.25, 0.0)), ui.scope_id().with(("int-day", k)), Sense::hover())
            .on_hover_text(format!("{} · {n} × · {}", day.format("%a %-d %b"), fmt(*secs)));
        let label = if d.days.len() <= 7 { format!("{} · {n}×", day.format("%a")) } else { day.format("%-d").to_string() };
        p.text(pos2(x + cw / 2.0, area.bottom() + 4.0), Align2::CENTER_TOP, label, FontId::proportional(10.0), alpha(DIM, a));
    }
}

pub fn hm(t: u64) -> String {
    Local.timestamp_opt(t as i64, 0).single().map_or(String::new(), |d| d.format("%H:%M").to_string())
}

pub fn clock(secs: u64) -> String {
    if secs >= 3600 { format!("{}:{:02}:{:02}", secs / 3600, secs % 3600 / 60, secs % 60) } else { format!("{}:{:02}", secs / 60, secs % 60) }
}
