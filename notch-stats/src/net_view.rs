//! The internet view: what the connection could carry over time (speed tests) and how it is right now.

use crate::net::{self, Test};
use crate::stats::{Shared, unix_secs};
use crate::{DIM, FAINT, alpha, area, row};
use eframe::egui::{self, Align2, Color32, FontId, Rect, Sense, Stroke, pos2, vec2};

/// Tests run every 30 min, so the internet view looks further back than the other metrics.
pub const RANGES: [(&str, u64); 3] = [("24h", 1440), ("3d", 4320), ("7d", 10080)];
pub const DOWN: Color32 = Color32::from_rgb(0, 199, 190);
const UP: Color32 = Color32::from_rgb(255, 159, 10);
const LOST: Color32 = Color32::from_rgb(255, 69, 58);

fn ago(s: u64) -> String {
    if s < 90 { "just now".into() } else if s < 5400 { format!("{} min ago", s / 60) } else { format!("{} h ago", s / 3600) }
}

/// The NET card: newest download speed big, upload and Wi-Fi signal small.
pub fn card(s: &Shared) -> (String, String) {
    let wifi = net::signal_word(s.now.wifi[0]);
    match s.net.last() {
        _ if s.net_busy && s.net.is_empty() => ("…".into(), "testing speed…".into()),
        None => ("–".into(), format!("first test soon · {wifi}")),
        Some(t) if t.down <= 0.0 => ("offline".into(), format!("last test {}", ago(unix_secs().saturating_sub(t.t)))),
        Some(t) => (format!("{:.0} ↓", t.down), if s.net_busy { "testing speed…".into() } else { format!("{:.0} ↑ Mb/s · {wifi}", t.up) }),
    }
}

/// Download speed of the last tests, for the card's sparkline: (values, scale top).
pub fn spark(s: &Shared) -> (Vec<f32>, f32) {
    let v: Vec<f32> = s.net.iter().rev().take(24).rev().map(|t| t.down).collect();
    let top = v.iter().cloned().fold(1.0, f32::max) * 1.1;
    (v, top)
}

fn in_range(s: &Shared, mins: u64) -> (u64, Vec<Test>) {
    let since = unix_secs().saturating_sub(mins * 60);
    (since, s.net.iter().filter(|t| t.t > since).copied().collect())
}

pub fn chart(ui: &egui::Ui, p: &egui::Painter, b: Rect, s: &Shared, range: (&str, u64), a: f32) {
    let white = alpha(Color32::WHITE, a);
    let (since, tests) = in_range(s, range.1);
    let up: Vec<&Test> = tests.iter().filter(|t| t.down > 0.0).collect();
    let summary = if up.is_empty() {
        String::new()
    } else {
        let avg = up.iter().map(|t| t.down).sum::<f32>() / up.len() as f32;
        let low = up.iter().map(|t| t.down).fold(f32::MAX, f32::min);
        let lost = tests.len() - up.len();
        format!("avg {avg:.0} ↓  ·  lowest {low:.0} ↓ Mb/s{}", if lost > 0 { format!("  ·  {lost} offline") } else { String::new() })
    };
    p.text(b.left_top() + vec2(14.0, 12.0), Align2::LEFT_TOP, format!("Internet speed · last {}", range.0), FontId::proportional(12.0), white);
    p.text(b.right_top() + vec2(-14.0, 12.0), Align2::RIGHT_TOP, summary, FontId::proportional(12.0), alpha(DIM, a));
    let plot = Rect::from_min_max(b.left_top() + vec2(14.0, 54.0), b.right_bottom() - vec2(14.0, 14.0));
    if tests.is_empty() {
        let msg = if s.net_busy { "testing speed…" } else { "first speed test runs 2 min after start, then every 30 min" };
        p.text(plot.center(), Align2::CENTER_CENTER, msg, FontId::proportional(12.0), alpha(DIM, a));
        return;
    }
    let mut lx = plot.left();
    let last = tests.last().copied().unwrap_or_default();
    for (col, t) in [(DOWN, format!("Download {:.0}", last.down)), (UP, format!("Upload {:.0}", last.up))] {
        p.rect_filled(Rect::from_min_size(pos2(lx, plot.top() - 15.0), vec2(8.0, 8.0)), 2.0, alpha(col, a));
        let r = p.text(pos2(lx + 12.0, plot.top() - 19.0), Align2::LEFT_TOP, t, FontId::proportional(11.0), alpha(DIM, a));
        lx = r.right() + 8.0;
    }
    let max = tests.iter().map(|t| t.down.max(t.up)).fold(1.0, f32::max) * 1.15;
    for g in [0.25, 0.5, 0.75] {
        let y = plot.bottom() - plot.height() * g;
        p.hline(plot.x_range(), y, Stroke::new(1.0, alpha(FAINT, a)));
        p.text(pos2(plot.left(), y - 1.0), Align2::LEFT_BOTTOM, format!("{:.0} Mb/s", g * max), FontId::proportional(9.0), alpha(DIM, a));
    }
    let span = unix_secs().saturating_sub(since).max(1) as f32;
    let at = |t: &Test, v: f32| pos2(plot.left() + plot.width() * (t.t - since) as f32 / span, plot.bottom() - plot.height() * (v / max).clamp(0.0, 1.0));
    for (col, pick) in [(UP, (|t: &Test| t.up) as fn(&Test) -> f32), (DOWN, |t: &Test| t.down)] {
        // a gap longer than two test periods (Mac asleep or off) is left open, not bridged with a straight line
        for w in tests.windows(2).filter(|w| w[1].t - w[0].t <= 2 * net::EVERY_S + 60) {
            p.line_segment([at(&w[0], pick(&w[0])), at(&w[1], pick(&w[1]))], Stroke::new(1.8, alpha(col, a)));
        }
        for t in &tests {
            p.circle_filled(at(t, pick(t)), 2.5, alpha(if t.down <= 0.0 { LOST } else { col }, a));
        }
    }
    if let Some(mp) = ui.ctx().pointer_hover_pos().filter(|mp| b.contains(*mp))
        && let Some(t) = tests.iter().min_by(|x, y| (at(x, 0.0).x - mp.x).abs().total_cmp(&(at(y, 0.0).x - mp.x).abs()))
    {
        let x = at(t, 0.0).x;
        p.vline(x, plot.y_range(), Stroke::new(1.0, alpha(Color32::from_gray(90), a)));
        let val = if t.down <= 0.0 { "no connection".into() } else { format!("{:.0} ↓  {:.0} ↑ Mb/s  ·  {:.0} ms", t.down, t.up, t.rtt) };
        let right = x > plot.center().x;
        let txt = format!("{val}  {}", ago(unix_secs().saturating_sub(t.t)));
        p.text(pos2(x + if right { -6.0 } else { 6.0 }, plot.top()), if right { Align2::RIGHT_TOP } else { Align2::LEFT_TOP }, txt, FontId::proportional(11.0), white);
    }
}

/// Right panel: the newest test, when the next one runs, Wi-Fi now and its signal over time; true = "Test now" clicked.
pub fn panel(ui: &mut egui::Ui, p: &egui::Painter, b: Rect, s: &Shared, range: (&str, u64), a: f32) -> bool {
    p.text(pos2(b.left() + 14.0, b.top() + 14.0), Align2::LEFT_TOP, "Connection", FontId::proportional(11.0), alpha(DIM, a));
    let now = unix_secs();
    let last = s.net.last().copied();
    let mut y = b.top() + 38.0;
    let mb = |v: f32| if last.is_some() { format!("{v:.0} Mb/s") } else { "–".into() };
    let t = last.unwrap_or_default();
    y = row(p, b, y, DOWN, "Download", mb(t.down), a);
    y = row(p, b, y, UP, "Upload", mb(t.up), a);
    y = row(p, b, y, FAINT, "Latency (idle)", if last.is_some() { format!("{:.0} ms", t.rtt) } else { "–".into() }, a);
    let tested = if s.net_busy { "testing now…".into() } else { last.map_or("not yet".into(), |t| ago(now.saturating_sub(t.t))) };
    y = row(p, b, y, FAINT, "Last test", tested, a);
    let next = last.map_or(0, |t| (t.t + net::EVERY_S).saturating_sub(now));
    y = row(p, b, y, FAINT, "Next test", if next == 0 { "soon".into() } else { format!("in {} min", next.div_ceil(60)) }, a);
    let [rssi, rate] = s.now.wifi;
    let sig = if rssi >= 0.0 { "not on Wi-Fi".into() } else { format!("{rssi:.0} dBm · {}", net::signal_word(rssi)) };
    y = row(p, b, y, DOWN, "Wi-Fi signal", sig, a);
    y = row(p, b, y, FAINT, "Wi-Fi link rate", if rate > 0.0 { format!("{rate:.0} Mb/s") } else { "–".into() }, a);

    // signal strength over time, -90 dBm (bottom) … -30 dBm (top); the regular history keeps 24 h of it
    let mins = range.1.min(1440);
    p.text(pos2(b.left() + 14.0, y + 8.0), Align2::LEFT_TOP, format!("Wi-Fi signal · last {}", if mins < range.1 { "24h" } else { range.0 }), FontId::proportional(11.0), alpha(DIM, a));
    let sr = Rect::from_min_max(pos2(b.left() + 14.0, y + 26.0), pos2(b.right() - 14.0, b.bottom() - 44.0));
    let vals: Vec<f32> = s.history(mins).iter().map(|x| if x.wifi[0] < 0.0 { x.wifi[0] + 90.0 } else { 0.0 }).collect();
    if sr.height() > 10.0 {
        area(p, sr, &vals, 60.0, alpha(DOWN, a), false);
    }

    let btn = Rect::from_min_size(pos2(b.right() - 14.0 - 90.0, b.bottom() - 34.0), vec2(90.0, 24.0));
    let r = ui.interact(btn, ui.scope_id().with("test-now"), Sense::click());
    p.rect_filled(btn, 6.0, alpha(Color32::from_gray(if s.net_busy { 34 } else if r.hovered() { 64 } else { 48 }), a));
    p.text(btn.center(), Align2::CENTER_CENTER, if s.net_busy { "Testing…" } else { "Test now" }, FontId::proportional(12.0), alpha(Color32::WHITE, a));
    r.clicked() && !s.net_busy
}
