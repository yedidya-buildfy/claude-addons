//! The shelf view: a grid of tiles that fills the open panel in place of the stats.

use crate::shelf::{self, Item};
use crate::shelf_mac::{self, Pasted};
use crate::{CARD, DIM, FAINT, alpha, short};
use eframe::egui::{self, Align2, Color32, ColorImage, FontId, Rect, Sense, Shape, Stroke, TextureHandle, TextureOptions, pos2, vec2};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const COLS: usize = 6;
const GAP: f32 = 10.0;
const DROP: Color32 = Color32::from_rgb(48, 209, 88);

pub struct Shelf {
    root: PathBuf,
    pub items: Vec<Item>,
    thumbs: HashMap<PathBuf, Option<TextureHandle>>,
    read_at: Option<Instant>,
    copied: Option<(PathBuf, Instant)>,
    picked: HashSet<PathBuf>, // ⌘/⇧-clicked tiles: dragging any of them drags them all
}

impl Shelf {
    pub fn new() -> Shelf {
        let root = shelf::dir();
        let _ = std::fs::create_dir_all(&root);
        Shelf { root, items: Vec::new(), thumbs: HashMap::new(), read_at: None, copied: None, picked: HashSet::new() }
    }

    /// Re-reads the shelf folder every second; that is also when 3-day-old items go and new screenshots
    /// (macOS saves them straight into the shelf folder) move in. The newest screenshot also goes on the
    /// clipboard, so ⌘V right after taking one still pastes it.
    pub fn refresh(&mut self) {
        if self.read_at.is_some_and(|t| t.elapsed() < Duration::from_secs(1)) {
            return;
        }
        if let Some(shot) = shelf::adopt_loose(&self.root).last() {
            shelf_mac::copy(shot);
        }
        shelf::sweep(&self.root, crate::stats::unix_secs());
        self.items = shelf::list(&self.root);
        let items = &self.items;
        self.thumbs.retain(|p, _| items.iter().any(|i| &i.path == p));
        self.picked.retain(|p| items.iter().any(|i| &i.path == p));
        self.read_at = Some(Instant::now());
    }

    fn changed(&mut self) {
        self.read_at = None;
        self.refresh();
    }

    /// Files dropped on the window go on the shelf; true when something was dropped.
    pub fn take_drops(&mut self, ctx: &egui::Context) -> bool {
        let dropped = ctx.input(|i| i.raw.dropped_files.clone());
        for f in &dropped {
            shelf::add(&self.root, f.path());
        }
        if !dropped.is_empty() {
            self.changed();
        }
        !dropped.is_empty()
    }

    pub fn paste(&mut self) {
        for (i, x) in shelf_mac::paste().into_iter().enumerate() {
            match x {
                Pasted::File(p) => {
                    shelf::add(&self.root, &p);
                }
                Pasted::Png(b) => {
                    shelf::add_bytes(&self.root, &format!("Pasted {}-{i}.png", crate::stats::unix_secs()), &b);
                }
            }
        }
        self.changed();
    }

    fn thumb(&mut self, ctx: &egui::Context, path: &PathBuf) -> Option<TextureHandle> {
        self.thumbs
            .entry(path.clone())
            .or_insert_with(|| {
                let (size, rgba) = shelf_mac::thumbnail(path, 240)?;
                Some(ctx.load_texture(path.to_string_lossy(), ColorImage::from_rgba_premultiplied(size, &rgba), TextureOptions::LINEAR))
            })
            .clone()
    }

    pub fn draw(&mut self, ui: &mut egui::Ui, p: &egui::Painter, b: Rect, dragging_in: bool, a: f32) {
        let white = alpha(Color32::WHITE, a);
        p.rect_filled(b, 14.0, alpha(CARD, a));
        let n = self.items.len();
        let head = format!("Shelf · {n} item{}", if n == 1 { "" } else { "s" });
        p.text(b.left_top() + vec2(14.0, 12.0), Align2::LEFT_TOP, head, FontId::proportional(12.0), white);
        let paste = Rect::from_min_size(pos2(b.right() - 14.0 - 64.0, b.top() + 8.0), vec2(64.0, 22.0));
        let pr = ui.interact(paste, ui.scope_id().with("paste"), Sense::click());
        p.rect_filled(paste, 6.0, alpha(Color32::from_gray(if pr.hovered() { 60 } else { 44 }), a));
        p.text(paste.center(), Align2::CENTER_CENTER, "Paste", FontId::proportional(12.0), white);
        if pr.clicked() {
            self.paste();
        }
        p.text(pos2(paste.left() - 10.0, b.top() + 13.0), Align2::RIGHT_TOP, "each item clears 3 days after it came in", FontId::proportional(11.0), alpha(DIM, a));

        let grid = Rect::from_min_max(b.left_top() + vec2(14.0, 40.0), b.right_bottom() - vec2(14.0, 30.0));
        let tw = (grid.width() - GAP * (COLS - 1) as f32) / COLS as f32;
        let th = tw + 8.0;
        let rows = ((grid.height() + GAP) / (th + GAP)).floor().max(1.0) as usize;
        let room = rows * COLS - 1; // the last cell is always the drop target
        let tile = |k: usize| Rect::from_min_size(pos2(grid.left() + (k % COLS) as f32 * (tw + GAP), grid.top() + (k / COLS) as f32 * (th + GAP)), vec2(tw, th));

        let items: Vec<Item> = self.items.iter().take(room).cloned().collect();
        for (k, item) in items.iter().enumerate() {
            self.tile(ui, p, tile(k), item, a);
        }
        let drop = tile(items.len());
        let col = if dragging_in { DROP } else { Color32::from_gray(70) };
        let c = [drop.left_top(), drop.right_top(), drop.right_bottom(), drop.left_bottom(), drop.left_top()];
        p.extend(Shape::dashed_line(&c, Stroke::new(1.5, alpha(col, a)), 5.0, 4.0));
        let more = if n > room { format!("+{} more\n", n - room) } else { String::new() };
        p.text(drop.center(), Align2::CENTER_CENTER, format!("{more}drop here\nor Paste"), FontId::proportional(11.0), alpha(col, a));
        if dragging_in {
            p.rect_stroke(grid.expand(6.0), 12.0, Stroke::new(2.0, alpha(DROP, a)), egui::StrokeKind::Outside);
        }
        let hint = "drag a tile out to use it  ·  click = copy  ·  ⌘-click = pick several, drag one to take all  ·  × = remove";
        p.text(pos2(b.left() + 14.0, b.bottom() - 12.0), Align2::LEFT_BOTTOM, hint, FontId::proportional(11.0), alpha(DIM, a));
    }

    fn tile(&mut self, ui: &mut egui::Ui, p: &egui::Painter, r: Rect, item: &Item, a: f32) {
        let id = ui.scope_id().with(("tile", &item.path));
        let resp = ui.interact(r, id, Sense::click_and_drag());
        let x = Rect::from_min_size(r.left_top() + vec2(4.0, 4.0), vec2(18.0, 18.0));
        let xr = ui.interact(x, id.with("x"), Sense::click());
        let hot = resp.hovered() || xr.hovered();
        p.rect_filled(r, 10.0, alpha(Color32::from_gray(if hot { 54 } else { 40 }), a));

        let pic = Rect::from_min_max(r.left_top() + vec2(6.0, 6.0), r.right_bottom() - vec2(6.0, 22.0));
        if let Some(t) = self.thumb(ui.ctx(), &item.path) {
            let s = t.size_vec2();
            let k = (pic.width() / s.x).min(pic.height() / s.y);
            let fit = Rect::from_center_size(pic.center(), s * k);
            p.image(t.id(), fit, Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), alpha(Color32::WHITE, a));
        } else {
            p.rect_filled(pic, 6.0, alpha(FAINT, a));
        }
        let name = item.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        p.text(pos2(r.center().x, r.bottom() - 6.0), Align2::CENTER_BOTTOM, short(&name, 15), FontId::proportional(10.0), alpha(Color32::from_gray(210), a));
        let age = p.text(r.right_top() + vec2(-8.0, 8.0), Align2::RIGHT_TOP, shelf::age(item.added), FontId::proportional(9.0), alpha(Color32::WHITE, a));
        p.rect_filled(age.expand2(vec2(3.0, 1.0)), 3.0, alpha(Color32::from_black_alpha(150), a));
        p.text(r.right_top() + vec2(-8.0, 8.0), Align2::RIGHT_TOP, shelf::age(item.added), FontId::proportional(9.0), alpha(Color32::WHITE, a));

        let picked = self.picked.contains(&item.path);
        if picked {
            p.rect_stroke(r, 10.0, Stroke::new(2.0, alpha(DROP, a)), egui::StrokeKind::Inside);
            let dot = pos2(r.right() - 14.0, r.bottom() - 34.0);
            p.circle_filled(dot, 8.0, alpha(DROP, a));
            p.text(dot, Align2::CENTER_CENTER, "✓", FontId::proportional(11.0), alpha(Color32::BLACK, a));
        }
        if hot {
            p.circle_filled(x.center(), 9.0, alpha(Color32::from_gray(if xr.hovered() { 120 } else { 80 }), a));
            p.text(x.center(), Align2::CENTER_CENTER, "×", FontId::proportional(13.0), alpha(Color32::WHITE, a));
        }
        if let Some((path, at)) = &self.copied
            && path == &item.path
        {
            if at.elapsed() < Duration::from_millis(1200) {
                p.rect_filled(r, 10.0, alpha(Color32::from_black_alpha(170), a));
                p.text(r.center(), Align2::CENTER_CENTER, "Copied", FontId::proportional(13.0), alpha(DROP, a));
                ui.ctx().request_repaint_after(Duration::from_millis(100));
            } else {
                self.copied = None;
            }
        }

        if xr.clicked() {
            shelf::remove(item);
            self.changed();
        } else if resp.drag_started() {
            // a picked tile takes every picked one along, fanned out a little from under the pointer
            let paths: Vec<PathBuf> = if picked { self.items.iter().map(|i| i.path.clone()).filter(|p| self.picked.contains(p)).collect() } else { vec![item.path.clone()] };
            let files: Vec<(PathBuf, [f32; 4])> = paths.into_iter().enumerate().map(|(k, p)| (p, [r.left() + 6.0 * k as f32, r.top() + 6.0 * k as f32, r.width(), r.height()])).collect();
            shelf_mac::drag_out(&files);
        } else if resp.clicked() && ui.input(|i| i.modifiers.command || i.modifiers.shift) {
            if !self.picked.remove(&item.path) {
                self.picked.insert(item.path.clone());
            }
        } else if resp.clicked() {
            self.picked.clear();
            shelf_mac::copy(&item.path);
            self.copied = Some((item.path.clone(), Instant::now()));
        }
    }
}
