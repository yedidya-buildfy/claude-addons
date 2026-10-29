//! The AI view: every Claude subscription on this Mac, how much of each is used, and a button to switch.
//! All the account logic lives in the claude-accounts add-on's script; this only runs it and draws.

use crate::stats::unix_secs;
use crate::{CARD, DIM, alpha, bar};
use eframe::egui::{self, Align2, Color32, FontId, Rect, Sense, Stroke, pos2, vec2};
use serde::Deserialize;
use std::process::Command;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const EVERY_S: u64 = 300; // background refresh
const STALE_S: u64 = 60; // opening the view refreshes data older than this
const FIVE: Color32 = Color32::from_rgb(90, 200, 250);
const WEEK: Color32 = Color32::from_rgb(191, 90, 242);
const GOOD: Color32 = Color32::from_rgb(48, 209, 88);
const FULL: Color32 = Color32::from_rgb(255, 69, 58);

#[derive(Deserialize, Clone, Copy, Default)]
pub struct Window {
    pct: f32,
    resets: u64,
}

#[derive(Deserialize, Clone, Default)]
pub struct Account {
    email: String,
    name: String,
    plan: String,
    active: bool,
    five: Option<Window>,
    week: Option<Window>,
    error: Option<String>,
}

#[derive(Deserialize, Default)]
struct List {
    accounts: Vec<Account>,
    recommended: Option<String>,
}

#[derive(Default)]
struct State {
    list: List,
    at: u64, // when `list` was read; 0 = never
    busy: bool,
    error: Option<String>,
}

enum Cmd {
    Refresh,
    Use(String),
}

pub struct Ai {
    state: Arc<Mutex<State>>,
    tx: Sender<Cmd>,
}

fn script() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    // launchd gives no shell PATH: try the usual node homes first
    let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].into_iter().find(|p| std::path::Path::new(p).exists()).unwrap_or("node");
    vec![node.into(), format!("{home}/.claude/claude-accounts/accounts.mjs")]
}

fn run(args: &[&str]) -> Result<String, String> {
    let s = script();
    if !std::path::Path::new(&s[1]).exists() {
        return Err("turn on the claude-accounts add-on (addons page) to see your subscriptions".into());
    }
    let out = Command::new(&s[0]).arg(&s[1]).args(args).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).into()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

fn worker(state: Arc<Mutex<State>>, rx: Receiver<Cmd>, ctx: egui::Context) {
    loop {
        let cmd = rx.recv_timeout(Duration::from_secs(EVERY_S)).unwrap_or(Cmd::Refresh);
        state.lock().unwrap().busy = true;
        ctx.request_repaint();
        let switched = match cmd {
            Cmd::Use(email) => run(&["use", &email]).err(),
            Cmd::Refresh => None,
        };
        let listed = run(&["list"]).and_then(|j| serde_json::from_str::<List>(&j).map_err(|e| e.to_string()));
        let mut s = state.lock().unwrap();
        s.error = switched;
        match listed {
            Ok(l) => (s.list, s.at) = (l, unix_secs()),
            Err(e) => s.error = s.error.take().or(Some(e)),
        }
        s.busy = false;
        ctx.request_repaint();
    }
}

impl Ai {
    pub fn start(ctx: egui::Context) -> Self {
        let state = Arc::new(Mutex::new(State { busy: true, ..State::default() }));
        let (tx, rx) = channel();
        let st = state.clone();
        std::thread::Builder::new().name("ai-accounts".into()).spawn(move || worker(st, rx, ctx)).expect("ai thread");
        tx.send(Cmd::Refresh).ok();
        Ai { state, tx }
    }

    /// Called while the view is on screen: old data is fetched again.
    pub fn shown(&self) {
        let mut s = self.state.lock().unwrap();
        if !s.busy && unix_secs().saturating_sub(s.at) > STALE_S {
            s.busy = true; // once, not every frame
            self.tx.send(Cmd::Refresh).ok();
        }
    }

    pub fn draw(&mut self, ui: &mut egui::Ui, p: &egui::Painter, b: Rect, a: f32) {
        self.shown();
        let s = self.state.lock().unwrap();
        let white = alpha(Color32::WHITE, a);
        let updated = if s.busy { "updating…".to_string() } else if s.at == 0 { String::new() } else { format!("updated {}", ago(unix_secs().saturating_sub(s.at))) };
        p.text(b.left_top() + vec2(2.0, 0.0), Align2::LEFT_TOP, "Claude subscriptions", FontId::proportional(13.0), white);
        p.text(b.right_top() - vec2(2.0, 0.0), Align2::RIGHT_TOP, updated, FontId::proportional(11.0), alpha(DIM, a));
        let mut y = b.top() + 26.0;
        if let Some(e) = &s.error {
            p.text(pos2(b.left() + 2.0, y), Align2::LEFT_TOP, format!("⚠ {e}"), FontId::proportional(11.0), alpha(FULL, a));
            y += 18.0;
        }
        if s.list.accounts.is_empty() {
            let msg = if s.busy || s.at == 0 { "reading accounts…" } else { "no Claude login found — sign in to Claude Code first" };
            p.text(b.center(), Align2::CENTER_CENTER, msg, FontId::proportional(12.0), alpha(DIM, a));
        }
        // ponytail: fixed-height cards, about 3 fit; add scrolling when someone keeps more accounts
        let mut pick = None;
        for (i, acc) in s.list.accounts.iter().enumerate() {
            let r = Rect::from_min_size(pos2(b.left(), y), vec2(b.width(), 96.0));
            if r.bottom() > b.bottom() - 22.0 {
                break;
            }
            let best = s.list.recommended.as_deref() == Some(acc.email.as_str());
            if card(ui, p, r, acc, best, s.busy, i, a) {
                pick = Some(acc.email.clone());
            }
            y += 106.0;
        }
        let hint = "Add an account: in Claude Code run /login with it — it shows up here. Open sessions keep their account until restarted.";
        p.text(pos2(b.left() + 2.0, b.bottom()), Align2::LEFT_BOTTOM, hint, FontId::proportional(11.0), alpha(DIM, a));
        drop(s);
        if let Some(email) = pick {
            self.state.lock().unwrap().busy = true;
            self.tx.send(Cmd::Use(email)).ok();
        }
    }
}

/// One account; true = "Use" clicked.
#[allow(clippy::too_many_arguments)]
fn card(ui: &mut egui::Ui, p: &egui::Painter, r: Rect, acc: &Account, best: bool, busy: bool, i: usize, a: f32) -> bool {
    let white = alpha(Color32::WHITE, a);
    p.rect_filled(r, 14.0, alpha(CARD, a));
    if acc.active {
        p.rect_stroke(r, 14.0, Stroke::new(1.5, alpha(GOOD, a * 0.9)), egui::StrokeKind::Inside);
    }
    let title = if acc.name.is_empty() { acc.email.clone() } else { format!("{}  ·  {}", acc.name, acc.email) };
    p.text(r.left_top() + vec2(16.0, 12.0), Align2::LEFT_TOP, title, FontId::proportional(14.0), white);
    let mut tag = acc.plan.clone();
    if best {
        tag = format!("{tag}  ·  ★ most room left");
    }
    p.text(r.left_top() + vec2(16.0, 32.0), Align2::LEFT_TOP, tag, FontId::proportional(11.0), alpha(if best { GOOD } else { DIM }, a));

    // two usage bars, the official plan windows
    let bars = Rect::from_min_max(r.left_top() + vec2(16.0, 54.0), pos2(r.right() - 140.0, r.bottom() - 12.0));
    if let Some(e) = &acc.error {
        let msg = if e == "signed out" { "signed out — sign in to it again with /login".to_string() } else { format!("could not read usage ({e})") };
        p.text(bars.left_top(), Align2::LEFT_TOP, msg, FontId::proportional(12.0), alpha(FULL, a));
    } else {
        let half = (bars.width() - 20.0) / 2.0;
        for (k, (name, w, col)) in [("5 hours", acc.five, FIVE), ("Week", acc.week, WEEK)].into_iter().enumerate() {
            let x = bars.left() + k as f32 * (half + 20.0);
            let w = w.unwrap_or_default();
            let c = if w.pct >= 90.0 { FULL } else { col };
            p.text(pos2(x, bars.top()), Align2::LEFT_TOP, format!("{name}  {:.0}%", w.pct), FontId::proportional(12.0), white);
            let left = w.resets.saturating_sub(unix_secs());
            p.text(pos2(x + half, bars.top()), Align2::RIGHT_TOP, if w.resets > 0 { format!("resets in {}", span(left)) } else { String::new() }, FontId::proportional(11.0), alpha(DIM, a));
            bar(p, Rect::from_min_size(pos2(x, bars.top() + 20.0), vec2(half, 6.0)), &[(w.pct / 100.0, c)], a);
        }
    }

    let btn = Rect::from_min_size(pos2(r.right() - 116.0, r.center().y - 14.0), vec2(100.0, 28.0));
    if acc.active {
        p.text(btn.center(), Align2::CENTER_CENTER, "● In use", FontId::proportional(12.0), alpha(GOOD, a));
        return false;
    }
    let resp = ui.interact(btn, ui.scope_id().with(("use-account", i)), Sense::click());
    let fill = if busy { 34 } else if resp.hovered() { 64 } else { 48 };
    p.rect_filled(btn, 8.0, alpha(Color32::from_gray(fill), a));
    p.text(btn.center(), Align2::CENTER_CENTER, "Use this", FontId::proportional(12.0), alpha(if busy { DIM } else { Color32::WHITE }, a));
    resp.clicked() && !busy
}

fn ago(s: u64) -> String {
    if s < 60 { "just now".into() } else { format!("{} min ago", s / 60) }
}

/// 2d 4h / 3h 05m / 12m
fn span(s: u64) -> String {
    let (d, h, m) = (s / 86400, s / 3600 % 24, s / 60 % 60);
    if d > 0 { format!("{d}d {h}h") } else if h > 0 { format!("{h}h {m:02}m") } else { format!("{m}m") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_script_output() {
        let j = r#"{"accounts":[{"email":"a@b","name":"A","plan":"Max 20x","active":true,"five":{"pct":5,"resets":100},"week":null,"error":null}],"recommended":"a@b"}"#;
        let l: List = serde_json::from_str(j).unwrap();
        assert_eq!(l.accounts[0].five.unwrap().pct, 5.0);
        assert!(l.accounts[0].week.is_none() && l.accounts[0].active);
        assert_eq!(l.recommended.as_deref(), Some("a@b"));
    }

    #[test]
    fn reset_countdown() {
        assert_eq!(span(2 * 86400 + 4 * 3600 + 59), "2d 4h");
        assert_eq!(span(3 * 3600 + 5 * 60), "3h 05m");
        assert_eq!(span(720), "12m");
    }
}
