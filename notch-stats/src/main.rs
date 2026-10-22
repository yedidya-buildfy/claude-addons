//! NotchStats: a live CPU / GPU / RAM / temperature / disk monitor that lives in the MacBook notch.
//! Collapsed it hugs the notch (CPU left, GPU right); hover it and it opens into history graphs
//! and "who is using it" donuts.

mod mac;
mod stats;
mod temp;

use eframe::egui::{
    self, Align2, Color32, CornerRadius, FontFamily, FontId, Mesh, Pos2, Rect, Sense, Shape, Stroke, Vec2, pos2, vec2,
};
use stats::{CPU, GPU, RAM, Shared};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const WING: f32 = 86.0; // collapsed width on each side of the notch
const EW: f32 = 740.0; // expanded panel
const EH: f32 = 470.0;
const PAD: f32 = 20.0;

const BG: Color32 = Color32::BLACK;
const CARD: Color32 = Color32::from_rgb(22, 22, 25);
const DIM: Color32 = Color32::from_rgb(130, 130, 140);
const FAINT: Color32 = Color32::from_rgb(44, 44, 50);
const ACCENT: [Color32; 5] = [
    Color32::from_rgb(90, 200, 250),  // CPU
    Color32::from_rgb(191, 90, 242),  // GPU
    Color32::from_rgb(48, 209, 88),   // RAM
    Color32::from_rgb(255, 99, 71),   // temperature
    Color32::from_rgb(255, 159, 10),  // disk
];
const TEMP: usize = 3;
const DISK: usize = 4;
const SWAP: Color32 = Color32::from_rgb(255, 69, 58);
const READ: Color32 = Color32::from_rgb(100, 210, 255);
const WRITE: Color32 = Color32::from_rgb(255, 159, 10);
const SLICES: [Color32; 5] = [
    Color32::from_rgb(10, 132, 255),
    Color32::from_rgb(191, 90, 242),
    Color32::from_rgb(255, 55, 95),
    Color32::from_rgb(255, 159, 10),
    Color32::from_rgb(48, 209, 88),
];
const RANGES: [(&str, u64); 3] = [("10m", 10), ("1h", 60), ("24h", 1440)];
const NAMES: [&str; 5] = ["CPU", "GPU", "Memory", "Temperature", "Disk"];
const MEM_PARTS: [&str; 4] = ["App", "Wired", "Compr.", "Cached"];
const MEM_HELP: [&str; 4] = ["App memory", "Wired (kept by macOS)", "Compressed", "Cached files (reclaimable)"];
const MEM_COLORS: [Color32; 4] = [
    Color32::from_rgb(48, 209, 88),
    Color32::from_rgb(255, 159, 10),
    Color32::from_rgb(191, 90, 242),
    Color32::from_rgb(100, 210, 255),
];

struct App {
    shared: Arc<Mutex<Shared>>,
    open: Arc<AtomicBool>,
    geo: mac::Geometry,
    metric: usize,
    range: usize,
    passthrough: bool,
    set_up: bool,
}

fn main() -> eframe::Result {
    let geo = mac::geometry();
    let size = vec2(EW + 2.0 * PAD, EH + PAD);
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size(size)
            .with_position(pos2((geo.screen_w - size.x) / 2.0, 0.0))
            .with_decorations(false)
            .with_transparent(true)
            .with_resizable(false)
            .with_has_shadow(false)
            .with_taskbar(false)
            .with_active(false)
            .with_mouse_passthrough(true)
            .with_window_level(egui::WindowLevel::AlwaysOnTop),
        // accessory from the very start (no Dock icon): only such apps may draw over other apps' full screen
        event_loop_builder: Some(Box::new(|b| {
            use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
            b.with_activation_policy(ActivationPolicy::Accessory);
        })),
        ..Default::default()
    };
    eframe::run_native(
        "NotchStats",
        options,
        Box::new(move |cc| {
            fonts(&cc.egui_ctx);
            // NOTCH_STATS_PIN=1 keeps it open (screenshots, tweaking the layout)
            let pinned = std::env::var_os("NOTCH_STATS_PIN").is_some();
            let open = Arc::new(AtomicBool::new(pinned));
            let collapsed = vec2(geo.notch_w + 2.0 * WING, geo.bar_h);
            if !pinned {
                mac::watch_hover(cc.egui_ctx.clone(), open.clone(), geo.screen_w, collapsed, vec2(EW, EH + 8.0));
            }
            Ok(Box::new(App {
                shared: stats::start(cc.egui_ctx.clone()),
                open,
                geo,
                // NOTCH_STATS_PIN=gpu / =memory also picks what is shown
                metric: match std::env::var("NOTCH_STATS_PIN").as_deref() { Ok("gpu") => GPU, Ok("memory") => RAM, Ok("temp") => TEMP, Ok("disk") => DISK, _ => CPU },
                range: 0,
                passthrough: true,
                set_up: false,
            }))
        }),
    )
}

fn fonts(ctx: &egui::Context) {
    let mut f = egui::FontDefinitions::default();
    for (name, path, family) in [
        ("sf", "/System/Library/Fonts/SFNS.ttf", FontFamily::Proportional),
        ("sf-mono", "/System/Library/Fonts/SFNSMono.ttf", FontFamily::Monospace),
    ] {
        if let Ok(bytes) = std::fs::read(path) {
            f.font_data.insert(name.into(), Arc::new(egui::FontData::from_owned(bytes)));
            f.families.entry(family).or_default().insert(0, name.into());
        }
    }
    ctx.set_fonts(f);
}

impl eframe::App for App {
    fn clear_color(&self, _: &egui::Visuals) -> [f32; 4] {
        [0.0; 4]
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        if !self.set_up || mac::off_active_space() {
            mac::pin_to_notch(EW + 2.0 * PAD, EH + PAD);
            self.set_up = true;
        }
        let open = self.open.load(Ordering::Relaxed);
        if self.passthrough == open {
            self.passthrough = !open;
            ctx.send_viewport_cmd(egui::ViewportCommand::MousePassthrough(!open));
        }
        let t = ctx.animate_bool_with_time_and_easing(egui::Id::NULL.with("open"), open, 0.32, emath_ease);

        let full = ui.max_rect();
        let cw = self.geo.notch_w + 2.0 * WING;
        let w = lerp(cw, EW, t);
        let h = lerp(self.geo.bar_h, EH, t);
        let panel = Rect::from_min_size(pos2(full.center().x - w / 2.0, full.top()), vec2(w, h));
        let r = lerp(10.0, 30.0, t) as u8;
        let p = ui.painter().clone();
        p.rect_filled(panel, CornerRadius { nw: 0, ne: 0, sw: r, se: r }, BG);
        // little concave "ears" so the panel flows out of the screen edge like the notch does
        ears(&p, panel, lerp(6.0, 12.0, t));

        let shared = self.shared.clone();
        let s = shared.lock().unwrap();
        if t < 0.5 {
            self.collapsed(&p, panel, &s, 1.0 - t * 2.0);
        }
        if t > 0.55 {
            let a = (t - 0.55) / 0.45;
            self.expanded(ui, &p, panel, &s, a);
        }
    }
}

fn emath_ease(t: f32) -> f32 {
    egui::emath::easing::cubic_out(t)
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn ears(p: &egui::Painter, panel: Rect, r: f32) {
    for (x, dir) in [(panel.left(), -1.0), (panel.right(), 1.0)] {
        let mut pts = vec![pos2(x, panel.top()), pos2(x + dir * r, panel.top())];
        for i in 0..=8 {
            let a = std::f32::consts::FRAC_PI_2 * i as f32 / 8.0;
            pts.push(pos2(x + dir * r * (1.0 - a.sin()), panel.top() + r * (1.0 - a.cos())));
        }
        pts.push(pos2(x, panel.top() + r));
        p.add(Shape::convex_polygon(pts, BG, Stroke::NONE));
    }
}

fn alpha(c: Color32, a: f32) -> Color32 {
    c.gamma_multiply(a.clamp(0.0, 1.0))
}

fn heat(v: f32, base: Color32) -> Color32 {
    if v >= 90.0 { Color32::from_rgb(255, 69, 58) } else { base }
}

impl App {
    fn collapsed(&self, p: &egui::Painter, panel: Rect, s: &Shared, a: f32) {
        let mid = panel.center().y;
        let font = FontId::new(13.0, FontFamily::Monospace);
        let wings = [
            (panel.left() + 14.0, Align2::LEFT_CENTER, CPU, s.now.cpu),
            (panel.right() - 14.0, Align2::RIGHT_CENTER, GPU, s.now.gpu),
        ];
        for (x, align, m, v) in wings {
            let c = heat(v, ACCENT[m]);
            let rect = p.text(pos2(x, mid), align, format!("{v:>3.0}%"), font.clone(), alpha(Color32::WHITE, a));
            // sparkline of the last 40 s next to the number, towards the notch
            let sx = if m == CPU { rect.right() + 6.0 } else { rect.left() - 6.0 - 34.0 };
            let spark = Rect::from_min_size(pos2(sx, mid - 7.0), vec2(34.0, 14.0));
            let vals: Vec<f32> = s.secs.iter().rev().take(40).rev().map(|x| x.v[m]).collect();
            area(p, spark, &vals, 100.0, alpha(c, a), false);
        }
    }

    fn expanded(&mut self, ui: &mut egui::Ui, p: &egui::Painter, panel: Rect, s: &Shared, a: f32) {
        let inner = panel.shrink2(vec2(PAD, 0.0));
        let white = alpha(Color32::WHITE, a);

        // top strip, beside the notch: live state on the left, range on the right
        let strip_y = panel.top() + self.geo.bar_h / 2.0;
        p.circle_filled(pos2(inner.left() + 4.0, strip_y), 3.5, alpha(ACCENT[RAM], a));
        p.text(pos2(inner.left() + 14.0, strip_y), Align2::LEFT_CENTER, "Live", FontId::proportional(12.0), alpha(DIM, a));
        let mut x = inner.right();
        for i in (0..RANGES.len()).rev() {
            let r = Rect::from_min_size(pos2(x - 40.0, strip_y - 11.0), vec2(40.0, 22.0));
            x -= 44.0;
            let resp = ui.interact(r, ui.scope_id().with(("range", i)), Sense::click());
            if resp.clicked() {
                self.range = i;
            }
            let on = self.range == i;
            let fill = if on { Color32::from_gray(48) } else if resp.hovered() { Color32::from_gray(28) } else { Color32::TRANSPARENT };
            p.rect_filled(r, 6.0, alpha(fill, a));
            p.text(r.center(), Align2::CENTER_CENTER, RANGES[i].0, FontId::proportional(12.0), alpha(if on { Color32::WHITE } else { DIM }, a));
        }

        // cards
        let top = panel.top() + self.geo.bar_h + 10.0;
        let gap = 10.0;
        let cw = (inner.width() - 4.0 * gap) / 5.0;
        let n = s.now;
        let cores = s.secs.back().map_or(0, |x| x.cores.len());
        let cards: [(usize, String, String, f32); 5] = [
            (CPU, format!("{:.0}%", n.cpu), format!("{:.1} of {} cores", n.cpu * cores as f32 / 100.0, cores), n.cpu),
            (GPU, format!("{:.0}%", n.gpu), format!("{:.1} GB in use", n.gpu_mem), n.gpu),
            (RAM, format!("{:.1} GB", n.ram_used), format!("of {:.0} · swap {:.1}", n.ram_total, n.swap), 100.0 * n.ram_used / n.ram_total.max(1.0)),
            (TEMP, format!("{:.0}°", n.temps.cpu), format!("GPU {:.0}° · SSD {:.0}°", n.temps.gpu, n.temps.ssd), n.temps.cpu),
            (DISK, format!("{:.0} GB", n.disk_free), format!("free of {:.0} GB", n.disk_total), 100.0 * (1.0 - n.disk_free / n.disk_total.max(1.0))),
        ];
        for (i, (m, big, small, pct)) in cards.into_iter().enumerate() {
            let r = Rect::from_min_size(pos2(inner.left() + i as f32 * (cw + gap), top), vec2(cw, 78.0));
            let resp = ui.interact(r, ui.scope_id().with(("card", i)), Sense::click());
            if resp.clicked() {
                self.metric = m;
            }
            let sel = m == self.metric;
            let c = if m == TEMP { temp_color(pct) } else { heat(if m == DISK { 0.0 } else { pct }, ACCENT[m]) };
            p.rect_filled(r, 14.0, alpha(if resp.hovered() { Color32::from_rgb(30, 30, 34) } else { CARD }, a));
            if sel {
                p.rect_stroke(r, 14.0, Stroke::new(1.5, alpha(c, a * 0.9)), egui::StrokeKind::Inside);
            }
            let label = ["CPU", "GPU", "MEMORY", "TEMP", "DISK"][m];
            p.text(r.left_top() + vec2(12.0, 10.0), Align2::LEFT_TOP, label, FontId::proportional(11.0), alpha(DIM, a));
            p.text(r.left_top() + vec2(12.0, 26.0), Align2::LEFT_TOP, big, FontId::proportional(22.0), white);
            p.text(r.left_bottom() + vec2(12.0, -10.0), Align2::LEFT_BOTTOM, small, FontId::proportional(11.0), alpha(DIM, a));
            if m != DISK {
                let vals: Vec<f32> = s.secs.iter().rev().take(60).rev().map(|x| value(x, m)).collect();
                let sr = Rect::from_min_max(pos2(r.right() - 52.0, r.top() + 9.0), pos2(r.right() - 10.0, r.top() + 25.0));
                area(p, sr, &vals, 100.0, alpha(c, a), false);
            } else {
                // disk: a fill bar
                let bar = Rect::from_min_size(pos2(r.right() - 52.0, r.top() + 14.0), vec2(42.0, 5.0));
                p.rect_filled(bar, 3.0, alpha(FAINT, a));
                p.rect_filled(Rect::from_min_size(bar.min, vec2(bar.width() * pct / 100.0, 6.0)), 3.0, alpha(c, a));
            }
        }

        // history chart (left) + who-uses-it donut (right)
        let lower = Rect::from_min_max(pos2(inner.left(), top + 78.0 + 14.0), pos2(inner.right(), panel.bottom() - 18.0));
        let split = lower.left() + lower.width() * 0.52;
        let chart_box = Rect::from_min_max(lower.min, pos2(split - 10.0, lower.bottom()));
        let pie_box = Rect::from_min_max(pos2(split + 10.0, lower.top()), lower.max);
        p.rect_filled(chart_box, 14.0, alpha(CARD, a));
        p.rect_filled(pie_box, 14.0, alpha(CARD, a));

        let m = self.metric;
        let (rname, mins) = RANGES[self.range];
        let c = ACCENT[m];
        let hist = s.history(mins);
        let vals: Vec<f32> = hist.iter().map(|x| value(x, m)).collect();
        let peak = vals.iter().cloned().fold(0.0, f32::max);
        // same points as the chart, so avg and peak always agree with what is drawn
        let avg = if vals.is_empty() { 0.0 } else { vals.iter().sum::<f32>() / vals.len() as f32 };
        let ncores = hist.last().map_or(0, |x| x.cores.len());
        let cores_of = |pct: f32| pct * ncores as f32 / 100.0;
        let summary = match m {
            CPU => format!("avg {:.1}  ·  peak {:.1} of {ncores} cores", cores_of(avg), cores_of(peak)),
            RAM => format!("used {:.1} of {:.0} GB  ·  swap {:.1} GB", s.now.ram_used, s.now.ram_total, s.now.swap),
            TEMP => format!("CPU avg {avg:.0}°  ·  peak {peak:.0}°"),
            DISK => format!("used {:.0} of {:.0} GB", s.now.disk_total - s.now.disk_free, s.now.disk_total),
            _ => format!("avg {avg:.0}%  ·  peak {peak:.0}%"),
        };
        p.text(chart_box.left_top() + vec2(14.0, 12.0), Align2::LEFT_TOP, format!("{} · last {}", NAMES[m], rname), FontId::proportional(12.0), white);
        p.text(chart_box.right_top() + vec2(-14.0, 12.0), Align2::RIGHT_TOP, summary, FontId::proportional(12.0), alpha(DIM, a));
        let mut plot = Rect::from_min_max(chart_box.left_top() + vec2(14.0, 36.0), chart_box.right_bottom() - vec2(14.0, 14.0));
        if vals.len() < 2 {
            p.text(plot.center(), Align2::CENTER_CENTER, "collecting history…", FontId::proportional(12.0), alpha(DIM, a));
        } else {
            let mut max = 100.0;
            if m == CPU && ncores > 0 {
                // one row per core under the line: how many cores were busy, and which, all along the range
                let row = (60.0 / ncores as f32).clamp(3.0, 6.0);
                let heat_r = Rect::from_min_max(pos2(plot.left() + 12.0, plot.bottom() - row * ncores as f32), plot.max);
                plot.max.y = heat_r.top() - 8.0;
                core_heatmap(p, heat_r, &hist, s.now.e_cores, a);
                for (i, kind) in [(0, "E"), (s.now.e_cores, "P")] {
                    if i < ncores {
                        p.text(pos2(plot.left(), heat_r.top() + row * i as f32), Align2::LEFT_TOP, kind, FontId::proportional(9.0), alpha(DIM, a));
                    }
                }
            }
            if m == DISK {
                // read and write as plain lines, scaled to the busiest moment
                let top = hist.iter().flat_map(|x| x.disk).fold(0.0, f32::max);
                max = (top * 1.2).max(1.0);
            }
            if m == RAM || m == TEMP || m == DISK {
                plot.min.y += 18.0;
                let last = hist.last().cloned().unwrap_or_default();
                let legend: Vec<(Color32, String)> = if m == RAM {
                    // one plain line per part (not stacked), scaled to the biggest part, in 4 GB steps
                    let top = hist.iter().flat_map(|x| x.mem.iter().copied().chain([x.swap])).fold(0.0, f32::max);
                    max = ((top * 1.1 / 4.0).ceil() * 4.0).max(4.0);
                    let mut l: Vec<_> = (0..4).map(|k| (MEM_COLORS[k], format!("{} {:.1}", MEM_PARTS[k], last.mem[k]))).collect();
                    l.push((SWAP, format!("Swap {:.1}", last.swap)));
                    l
                } else if m == TEMP {
                    vec![(ACCENT[TEMP], format!("CPU {:.0}°", last.temp[0])), (ACCENT[GPU], format!("GPU {:.0}°", last.temp[1]))]
                } else {
                    vec![(READ, format!("Read {:.1} MB/s", last.disk[0])), (WRITE, format!("Write {:.1} MB/s", last.disk[1]))]
                };
                let mut lx = plot.left();
                for (col, text) in legend {
                    p.rect_filled(Rect::from_min_size(pos2(lx, plot.top() - 15.0), vec2(8.0, 8.0)), 2.0, alpha(col, a));
                    let r = p.text(pos2(lx + 12.0, plot.top() - 19.0), Align2::LEFT_TOP, text, FontId::proportional(11.0), alpha(DIM, a));
                    lx = r.right() + 8.0;
                }
            }
            for g in [0.25, 0.5, 0.75] {
                let y = plot.bottom() - plot.height() * g;
                p.hline(plot.x_range(), y, Stroke::new(1.0, alpha(FAINT, a)));
                let label = match m {
                    CPU if ncores > 0 => format!("{}", (g * ncores as f32).round()),
                    RAM => format!("{:.0} GB", g * max),
                    TEMP => format!("{:.0}°", g * 100.0),
                    DISK => format!("{:.1} MB/s", g * max),
                    _ => String::new(),
                };
                p.text(pos2(plot.left(), y - 1.0), Align2::LEFT_BOTTOM, label, FontId::proportional(9.0), alpha(DIM, a));
            }
            if m == RAM {
                for k in 0..4 {
                    line(p, plot, &hist.iter().map(|x| x.mem[k]).collect::<Vec<_>>(), max, alpha(MEM_COLORS[k], a));
                }
                line(p, plot, &hist.iter().map(|x| x.swap).collect::<Vec<_>>(), max, alpha(SWAP, a));
            } else if m == DISK {
                line(p, plot, &hist.iter().map(|x| x.disk[0]).collect::<Vec<_>>(), max, alpha(READ, a));
                line(p, plot, &hist.iter().map(|x| x.disk[1]).collect::<Vec<_>>(), max, alpha(WRITE, a));
            } else if m == TEMP {
                area(p, plot, &vals, max, alpha(ACCENT[TEMP], a), true);
                line(p, plot, &hist.iter().map(|x| x.temp[1]).collect::<Vec<_>>(), max, alpha(ACCENT[GPU], a));
            } else {
                area(p, plot, &vals, max, alpha(c, a), true);
            }
            // hover readout
            if let Some(mp) = ui.ctx().pointer_hover_pos().filter(|mp| chart_box.contains(*mp) && mp.x >= plot.left() && mp.x <= plot.right()) {
                let i = (((mp.x - plot.left()) / plot.width()) * (vals.len() - 1) as f32).round() as usize;
                let x = plot.left() + plot.width() * i as f32 / (vals.len() - 1) as f32;
                p.vline(x, plot.y_range(), Stroke::new(1.0, alpha(Color32::from_gray(90), a)));
                let ago = (vals.len() - 1 - i) as u64 * if self.range == 0 { 1 } else { 60 };
                let ago = if ago < 60 { format!("{ago}s ago") } else if ago < 3600 { format!("{}m ago", ago / 60) } else { format!("{}h{:02}m ago", ago / 3600, ago / 60 % 60) };
                let val = match m {
                    CPU => format!("{:.1} cores ({:.0}%)", cores_of(vals[i]), vals[i]),
                    RAM => format!("{:.1} GB used · swap {:.1}", hist[i].mem[..3].iter().sum::<f32>(), hist[i].swap),
                    TEMP => format!("CPU {:.0}° · GPU {:.0}°", hist[i].temp[0], hist[i].temp[1]),
                    DISK => format!("read {:.1} · write {:.1} MB/s", hist[i].disk[0], hist[i].disk[1]),
                    _ => format!("{:.0}%", vals[i]),
                };
                if m != RAM && m != DISK {
                    p.circle_filled(pos2(x, plot.bottom() - plot.height() * vals[i] / 100.0), 3.5, alpha(c, a));
                }
                let right = x > plot.center().x;
                p.text(pos2(x + if right { -6.0 } else { 6.0 }, plot.top()), if right { Align2::RIGHT_TOP } else { Align2::LEFT_TOP }, format!("{val}  {ago}"), FontId::proportional(11.0), white);
            }
        }

        if m == RAM {
            memory_panel(p, pie_box, s, mins, a);
        } else if m == TEMP {
            temps_panel(p, pie_box, s.now.temps, a);
        } else if m == DISK {
            disk_panel(p, pie_box, s, a);
        } else {
            // donut: who is responsible, averaged over the chosen range
            let tops = s.tops(m, mins);
            // per-app GPU time can add up to more than the device-busy figure; never hide apps behind it
            let top5: f32 = tops.iter().take(5).map(|x| x.1).sum();
            let used = if m == GPU { avg.max(top5).min(100.0) } else { avg };
            let mut slices: Vec<(String, f32, Color32)> = Vec::new();
            let mut listed = 0.0;
            for (i, (name, v)) in tops.iter().take(5).enumerate() {
                let v = v.min(used - listed).max(0.0);
                listed += v;
                slices.push((name.clone(), v, SLICES[i]));
            }
            slices.push(("Other".into(), (used - listed).max(0.0), Color32::from_gray(90)));

            let center = pos2(pie_box.left() + 74.0, pie_box.center().y);
            let mut parts: Vec<(f32, Color32)> = slices.iter().map(|x| (x.1 / 100.0, alpha(x.2, a))).collect();
            parts.push(((100.0 - used).max(0.0) / 100.0, alpha(FAINT, a)));
            donut(p, center, 58.0, 40.0, &parts);
            p.text(center + vec2(0.0, -6.0), Align2::CENTER_CENTER, format!("{used:.0}%"), FontId::proportional(18.0), white);
            p.text(center + vec2(0.0, 13.0), Align2::CENTER_CENTER, "avg", FontId::proportional(10.0), alpha(DIM, a));

            let lx = pie_box.left() + 146.0;
            let mut ly = pie_box.top() + 16.0;
            p.text(pos2(lx, ly), Align2::LEFT_TOP, "Who is using it", FontId::proportional(11.0), alpha(DIM, a));
            ly += 22.0;
            for (name, v, col) in &slices {
                p.rect_filled(Rect::from_min_size(pos2(lx, ly + 3.0), vec2(8.0, 8.0)), 2.0, alpha(*col, a));
                p.text(pos2(lx + 14.0, ly), Align2::LEFT_TOP, short(name, 16), FontId::proportional(12.0), white);
                p.text(pos2(pie_box.right() - 12.0, ly), Align2::RIGHT_TOP, format!("{v:.0}%"), FontId::proportional(12.0), alpha(DIM, a));
                ly += 21.0;
            }
        }
    }
}

fn short(name: &str, n: usize) -> String {
    if name.chars().count() > n { format!("{}…", name.chars().take(n - 1).collect::<String>()) } else { name.to_string() }
}

/// A row: colour mark, name, value on the right; returns the next row's y.
fn row(p: &egui::Painter, b: Rect, y: f32, col: Color32, name: &str, value: String, a: f32) -> f32 {
    p.rect_filled(Rect::from_min_size(pos2(b.left() + 14.0, y + 3.0), vec2(8.0, 8.0)), 2.0, alpha(col, a));
    p.text(pos2(b.left() + 28.0, y), Align2::LEFT_TOP, name, FontId::proportional(12.0), alpha(Color32::WHITE, a));
    p.text(pos2(b.right() - 14.0, y), Align2::RIGHT_TOP, value, FontId::proportional(12.0), alpha(DIM, a));
    y + 19.0
}

fn bar(p: &egui::Painter, r: Rect, parts: &[(f32, Color32)], a: f32) {
    p.rect_filled(r, 4.0, alpha(FAINT, a));
    let mut x = r.left();
    for &(f, c) in parts {
        let w = r.width() * f.clamp(0.0, 1.0);
        p.rect_filled(Rect::from_min_size(pos2(x, r.top()), vec2(w, r.height())), 0.0, alpha(c, a));
        x += w;
    }
}

/// Memory the way Activity Monitor splits it, swap, and the apps holding the most.
fn memory_panel(p: &egui::Painter, b: Rect, s: &Shared, mins: u64, a: f32) {
    let n = s.now;
    let total = n.ram_total.max(1.0);
    let free = (total - n.mem.iter().sum::<f32>()).max(0.0);
    let dim = |t: &str, y: f32| p.text(pos2(b.left() + 14.0, y), Align2::LEFT_TOP, t, FontId::proportional(11.0), alpha(DIM, a));
    dim("Memory breakdown", b.top() + 14.0);
    let mut parts: Vec<(f32, Color32)> = (0..4).map(|k| (n.mem[k] / total, MEM_COLORS[k])).collect();
    parts.push((free / total, FAINT));
    bar(p, Rect::from_min_size(pos2(b.left() + 14.0, b.top() + 34.0), vec2(b.width() - 28.0, 12.0)), &parts, a);
    let mut y = b.top() + 56.0;
    for k in 0..4 {
        y = row(p, b, y, MEM_COLORS[k], MEM_HELP[k], format!("{:.1} GB  {:>3.0}%", n.mem[k], 100.0 * n.mem[k] / total), a);
    }
    y = row(p, b, y, Color32::from_gray(70), "Free", format!("{free:.1} GB  {:>3.0}%", 100.0 * free / total), a);
    y = row(p, b, y, SWAP, "Swap used (on disk)", format!("{:.1} of {:.0} GB", n.swap, n.swap_total), a);

    dim("Apps holding the most", y + 10.0);
    y += 30.0;
    for (i, (name, v)) in s.tops(RAM, mins).iter().take(4).enumerate() {
        y = row(p, b, y, SLICES[i], &short(name, 22), format!("{v:.1} GB"), a);
    }
}

/// What takes the disk: biggest folders (measured every 6 h in the background), the rest, and free space.
fn disk_panel(p: &egui::Painter, b: Rect, s: &Shared, a: f32) {
    let n = s.now;
    let total = n.disk_total.max(1.0);
    let used = total - n.disk_free;
    let when = if s.folders_at == 0 {
        "measuring… (first time takes a few minutes)".to_string()
    } else {
        let ago = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()).saturating_sub(s.folders_at);
        if ago < 3600 { format!("measured {} min ago", ago / 60) } else { format!("measured {} h ago", ago / 3600) }
    };
    p.text(pos2(b.left() + 14.0, b.top() + 14.0), Align2::LEFT_TOP, "What takes the space", FontId::proportional(11.0), alpha(DIM, a));
    p.text(pos2(b.right() - 14.0, b.top() + 14.0), Align2::RIGHT_TOP, when, FontId::proportional(10.0), alpha(DIM, a));
    let top: Vec<_> = s.folders.iter().take(8).collect();
    let listed: f32 = top.iter().map(|x| x.1).sum();
    let other = (used - listed).max(0.0);
    let colors = [SLICES[0], SLICES[1], SLICES[2], SLICES[3], SLICES[4], READ, Color32::from_rgb(255, 214, 10), Color32::from_rgb(172, 142, 104)];
    let mut parts: Vec<(f32, Color32)> = top.iter().enumerate().map(|(i, x)| (x.1 / total, colors[i])).collect();
    parts.push((other / total, Color32::from_gray(90)));
    bar(p, Rect::from_min_size(pos2(b.left() + 14.0, b.top() + 34.0), vec2(b.width() - 28.0, 12.0)), &parts, a);
    let mut y = b.top() + 56.0;
    for (i, (name, gb)) in top.iter().enumerate() {
        y = row(p, b, y, colors[i], &short(name, 26), format!("{gb:.0} GB"), a);
    }
    y = row(p, b, y, Color32::from_gray(90), "macOS, system & other", format!("{other:.0} GB"), a);
    row(p, b, y, FAINT, "Free", format!("{:.0} GB", n.disk_free), a);
}

fn temps_panel(p: &egui::Painter, b: Rect, t: temp::Temps, a: f32) {
    p.text(pos2(b.left() + 14.0, b.top() + 14.0), Align2::LEFT_TOP, "Sensors, hottest reading", FontId::proportional(11.0), alpha(DIM, a));
    let mut y = b.top() + 40.0;
    for (name, v) in [("CPU cores", t.cpu), ("GPU", t.gpu), ("Rest of the chip", t.soc), ("SSD", t.ssd), ("Battery", t.battery)] {
        if v <= 0.0 {
            continue;
        }
        let c = temp_color(v);
        p.text(pos2(b.left() + 14.0, y), Align2::LEFT_TOP, name, FontId::proportional(12.0), alpha(Color32::WHITE, a));
        p.text(pos2(b.right() - 14.0, y), Align2::RIGHT_TOP, format!("{v:.0}°"), FontId::proportional(12.0), alpha(c, a));
        bar(p, Rect::from_min_size(pos2(b.left() + 14.0, y + 19.0), vec2(b.width() - 28.0, 5.0)), &[(v / 110.0, c)], a);
        y += 40.0;
    }
}

fn temp_color(v: f32) -> Color32 {
    if v >= 85.0 {
        Color32::from_rgb(255, 69, 58)
    } else if v >= 65.0 {
        Color32::from_rgb(255, 159, 10)
    } else {
        Color32::from_rgb(48, 209, 88)
    }
}

/// What a history point says about one metric (temperature = hottest CPU die, °C).
fn value(x: &stats::Point, m: usize) -> f32 {
    match m {
        TEMP => x.temp[0],
        DISK => x.disk[0] + x.disk[1],
        _ => x.v[m],
    }
}

/// Plain line, values 0..max, oldest left.
fn line(p: &egui::Painter, r: Rect, vals: &[f32], max: f32, c: Color32) {
    if vals.len() < 2 {
        return;
    }
    let pts = vals
        .iter()
        .enumerate()
        .map(|(i, v)| pos2(r.left() + r.width() * i as f32 / (vals.len() - 1) as f32, r.bottom() - r.height() * (v / max).clamp(0.0, 1.0)))
        .collect();
    p.add(Shape::line(pts, Stroke::new(1.6, c)));
}

/// Line + gradient fill, values 0..max, oldest left.
fn area(p: &egui::Painter, r: Rect, vals: &[f32], max: f32, c: Color32, big: bool) {
    if vals.len() < 2 {
        return;
    }
    let pts: Vec<Pos2> = vals
        .iter()
        .enumerate()
        .map(|(i, v)| pos2(r.left() + r.width() * i as f32 / (vals.len() - 1) as f32, r.bottom() - r.height() * (v / max).clamp(0.0, 1.0)))
        .collect();
    let mut mesh = Mesh::default();
    let top = c.gamma_multiply(if big { 0.38 } else { 0.3 });
    for (i, pt) in pts.iter().enumerate() {
        mesh.colored_vertex(*pt, top);
        mesh.colored_vertex(pos2(pt.x, r.bottom()), Color32::TRANSPARENT);
        if i > 0 {
            let k = (i as u32) * 2;
            mesh.add_triangle(k - 2, k - 1, k);
            mesh.add_triangle(k - 1, k, k + 1);
        }
    }
    p.add(Shape::mesh(mesh));
    p.add(Shape::line(pts, Stroke::new(if big { 1.8 } else { 1.3 }, c)));
}

/// Ring of slices (fractions of the full circle), starting at 12 o'clock, clockwise.
fn donut(p: &egui::Painter, c: Pos2, ro: f32, ri: f32, parts: &[(f32, Color32)]) {
    let tau = std::f32::consts::TAU;
    let mut a0 = -tau / 4.0;
    let gap = 0.02;
    for &(f, col) in parts {
        let sweep = f * tau;
        if sweep < 0.004 {
            continue;
        }
        let (s, e) = (a0 + gap / 2.0, a0 + sweep - gap / 2.0);
        a0 += sweep;
        if e <= s {
            continue;
        }
        let n = ((e - s) / tau * 160.0).ceil().max(2.0) as u32;
        let mut mesh = Mesh::default();
        for i in 0..=n {
            let a = s + (e - s) * i as f32 / n as f32;
            let d = Vec2::angled(a);
            mesh.colored_vertex(c + d * ro, col);
            mesh.colored_vertex(c + d * ri, col);
            if i > 0 {
                let k = i * 2;
                mesh.add_triangle(k - 2, k - 1, k);
                mesh.add_triangle(k - 1, k, k + 1);
            }
        }
        p.add(Shape::mesh(mesh));
    }
}

/// One row per core (efficiency cores on top), one column per time slice, brighter = busier.
fn core_heatmap(p: &egui::Painter, r: Rect, hist: &[stats::Point], e_cores: usize, a: f32) {
    let ncores = hist.last().map_or(0, |x| x.cores.len());
    let cols = hist.len().min((r.width() / 3.0) as usize).max(1);
    let row = r.height() / ncores.max(1) as f32;
    let col = r.width() / cols as f32;
    for j in 0..cols {
        let (j0, j1) = (j * hist.len() / cols, ((j + 1) * hist.len() / cols).max(j * hist.len() / cols + 1));
        for core in 0..ncores {
            let u = hist[j0..j1].iter().map(|x| x.cores.get(core).copied().unwrap_or(0.0)).sum::<f32>() / (j1 - j0) as f32;
            let base = if core < e_cores { ACCENT[RAM] } else { ACCENT[CPU] };
            let c = if u >= 90.0 { Color32::from_rgb(255, 69, 58) } else { base };
            let cell = Rect::from_min_size(pos2(r.left() + j as f32 * col, r.top() + core as f32 * row), vec2(col + 0.5, row - 1.0));
            p.rect_filled(cell, 0.0, alpha(lerp_color(FAINT, c, (u / 100.0).sqrt()), a));
        }
    }
}

fn lerp_color(a: Color32, b: Color32, t: f32) -> Color32 {
    let m = |x: u8, y: u8| (x as f32 + (y as f32 - x as f32) * t.clamp(0.0, 1.0)) as u8;
    Color32::from_rgb(m(a.r(), b.r()), m(a.g(), b.g()), m(a.b(), b.b()))
}
