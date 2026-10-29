//! The AI view: every AI subscription on this Mac (Claude, Codex, Gemini), one line each — who, plan,
//! price, how much of the 5-hour and weekly windows is used — with switch and add buttons.
//! All the account logic lives in the claude-accounts add-on's script; this only runs it and draws.

use crate::stats::unix_secs;
use crate::{CARD, DIM, FAINT, alpha, bar};
use eframe::egui::{self, Align2, Color32, FontId, Rect, Sense, Stroke, pos2, vec2};
use serde::Deserialize;
use std::process::Command;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const EVERY_S: u64 = 300; // background refresh
const STALE_S: u64 = 60; // opening the view refreshes data older than this
const OLD_S: u64 = 900; // numbers older than this are drawn dim
const ROW_H: f32 = 34.0;
const GOOD: Color32 = Color32::from_rgb(48, 209, 88);
const FULL: Color32 = Color32::from_rgb(255, 69, 58);
const TOOLS: [(&str, &str, Color32); 3] = [
    ("claude", "Claude", Color32::from_rgb(217, 119, 87)),
    ("codex", "Codex", Color32::from_rgb(100, 210, 255)),
    ("gemini", "Gemini", Color32::from_rgb(138, 132, 255)),
];

#[derive(Deserialize, Clone, Default)]
pub struct Window {
    label: String,
    pct: f32,
    resets: u64,
}

#[derive(Deserialize, Clone, Default)]
pub struct Account {
    provider: String,
    email: String,
    name: String,
    plan: String,
    price: Option<f32>,
    active: bool,
    best: bool,
    windows: Vec<Window>,
    at: u64, // ms since 1970 when the numbers were read; 0 = never
    error: Option<String>,
}

#[derive(Deserialize, Default)]
struct List {
    accounts: Vec<Account>,
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
    Use(String, String),
    Add(String),
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
        let acted = match cmd {
            Cmd::Use(tool, email) => run(&["use", &tool, &email]).err(),
            Cmd::Add(tool) => run(&["add", &tool]).err(),
            Cmd::Refresh => None,
        };
        let listed = run(&["list"]).and_then(|j| serde_json::from_str::<List>(&j).map_err(|e| e.to_string()));
        let mut s = state.lock().unwrap();
        s.error = acted;
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

    fn send(&self, cmd: Cmd) {
        self.state.lock().unwrap().busy = true; // once, not every frame
        self.tx.send(cmd).ok();
    }

    pub fn draw(&mut self, ui: &mut egui::Ui, p: &egui::Painter, b: Rect, a: f32) {
        let mut cmd = None;
        {
            let s = self.state.lock().unwrap();
            if !s.busy && unix_secs().saturating_sub(s.at) > STALE_S {
                cmd = Some(Cmd::Refresh);
            }
            let updated = if s.busy { "updating…".to_string() } else if s.at == 0 { String::new() } else { format!("updated {}", ago(unix_secs().saturating_sub(s.at))) };
            p.text(b.left_top() + vec2(2.0, 0.0), Align2::LEFT_TOP, "AI subscriptions", FontId::proportional(13.0), alpha(Color32::WHITE, a));
            p.text(b.right_top() - vec2(2.0, 0.0), Align2::RIGHT_TOP, updated, FontId::proportional(11.0), alpha(DIM, a));
            let mut y = b.top() + 24.0;
            if let Some(e) = &s.error {
                p.text(pos2(b.left() + 2.0, y), Align2::LEFT_TOP, format!("⚠ {e}"), FontId::proportional(11.0), alpha(FULL, a));
                y += 18.0;
            }
            if s.list.accounts.is_empty() {
                let msg = if s.busy || s.at == 0 { "reading accounts…" } else { "no login found yet — add one below" };
                p.text(b.center(), Align2::CENTER_CENTER, msg, FontId::proportional(12.0), alpha(DIM, a));
            }
            // ponytail: about 8 rows fit; add scrolling when someone keeps more accounts
            for (i, acc) in s.list.accounts.iter().enumerate() {
                let r = Rect::from_min_size(pos2(b.left(), y), vec2(b.width(), ROW_H));
                if r.bottom() > b.bottom() - 34.0 {
                    break;
                }
                if line(ui, p, r, acc, s.busy, i, a) {
                    cmd = Some(Cmd::Use(acc.provider.clone(), acc.email.clone()));
                }
                y += ROW_H + 4.0;
            }
            // add one more account per tool
            let mut x = b.left();
            for (id, name, col) in TOOLS {
                let r = Rect::from_min_size(pos2(x, b.bottom() - 24.0), vec2(84.0, 24.0));
                x += 90.0;
                let resp = ui.interact(r, ui.scope_id().with(("add", id)), Sense::click()).on_hover_text(format!("Opens a Terminal to sign in to one more {name} account"));
                p.rect_filled(r, 7.0, alpha(Color32::from_gray(if resp.hovered() { 48 } else { 30 }), a));
                p.text(r.center(), Align2::CENTER_CENTER, format!("+ {name}"), FontId::proportional(12.0), alpha(col, a));
                if resp.clicked() && !s.busy {
                    cmd = Some(Cmd::Add(id.into()));
                }
            }
        }
        if let Some(c) = cmd {
            self.send(c);
        }
    }
}

/// One account on one line; true = "Use" clicked.
fn line(ui: &mut egui::Ui, p: &egui::Painter, r: Rect, acc: &Account, busy: bool, i: usize, a: f32) -> bool {
    let white = alpha(Color32::WHITE, a);
    let f = |s: f32| FontId::proportional(s);
    let mid = r.center().y;
    let old = acc.at == 0 || unix_secs().saturating_sub(acc.at / 1000) > OLD_S;
    let hover = ui.interact(r, ui.scope_id().with(("acc-row", i)), Sense::hover()).on_hover_text(details(acc));
    p.rect_filled(r, 9.0, alpha(if hover.hovered() { Color32::from_rgb(30, 30, 34) } else { CARD }, a));
    if acc.active {
        p.rect_stroke(r, 9.0, Stroke::new(1.2, alpha(GOOD, a * 0.8)), egui::StrokeKind::Inside);
    }

    // in-use light, tool, who
    let mut x = r.left() + 12.0;
    if acc.active {
        p.circle_filled(pos2(x, mid), 4.0, alpha(GOOD, a));
    } else {
        p.circle_stroke(pos2(x, mid), 4.0, Stroke::new(1.0, alpha(DIM, a)));
    }
    x += 12.0;
    let (_, tool, col) = TOOLS.iter().find(|t| t.0 == acc.provider).copied().unwrap_or(("", "AI", DIM));
    p.text(pos2(x, mid), Align2::LEFT_CENTER, tool, f(12.0), alpha(col, a));
    x += 52.0;
    let user = acc.email.split('@').next().unwrap_or("");
    let who = if acc.name.is_empty() { user.to_string() } else { format!("{} · {user}", acc.name) };
    p.text(pos2(x, mid), Align2::LEFT_CENTER, crate::short(&who, 24), f(12.0), white);
    x += 176.0;
    let plan = match acc.price { Some(v) => format!("{} · ${v:.0}", acc.plan), None => acc.plan.clone() };
    p.text(pos2(x, mid), Align2::LEFT_CENTER, plan, f(12.0), alpha(DIM, a));
    x += 110.0;

    // 5-hour and weekly use
    if acc.error.as_deref() == Some("signed out") {
        p.text(pos2(x, mid), Align2::LEFT_CENTER, "signed out — add it again", f(12.0), alpha(FULL, a));
    } else {
        for label in ["5h", "wk"] {
            match acc.windows.iter().find(|w| w.label == label) {
                Some(w) => {
                    let c = if w.pct >= 90.0 { FULL } else { col };
                    let c = if old { c.gamma_multiply(0.45) } else { c };
                    p.text(pos2(x, mid), Align2::LEFT_CENTER, label, f(10.0), alpha(DIM, a));
                    bar(p, Rect::from_min_size(pos2(x + 20.0, mid - 2.5), vec2(56.0, 5.0)), &[(w.pct / 100.0, c)], a);
                    p.text(pos2(x + 82.0, mid), Align2::LEFT_CENTER, format!("{:.0}%", w.pct), f(12.0), if old { alpha(DIM, a) } else { white });
                }
                None => {
                    p.text(pos2(x, mid), Align2::LEFT_CENTER, label, f(10.0), alpha(FAINT, a));
                    p.text(pos2(x + 20.0, mid), Align2::LEFT_CENTER, "–", f(12.0), alpha(FAINT, a));
                }
            }
            x += 118.0;
        }
    }

    // most room left, and the switch
    let btn = Rect::from_min_size(pos2(r.right() - 64.0, mid - 11.0), vec2(56.0, 22.0));
    if acc.best {
        p.text(pos2(btn.left() - 10.0, mid), Align2::RIGHT_CENTER, "★", f(13.0), alpha(GOOD, a));
    }
    if acc.active {
        p.text(btn.center(), Align2::CENTER_CENTER, "In use", f(11.0), alpha(GOOD, a));
        return false;
    }
    let resp = ui.interact(btn, ui.scope_id().with(("use-account", i)), Sense::click());
    p.rect_filled(btn, 6.0, alpha(Color32::from_gray(if busy { 34 } else if resp.hovered() { 64 } else { 48 }), a));
    p.text(btn.center(), Align2::CENTER_CENTER, "Use", f(11.0), alpha(if busy { DIM } else { Color32::WHITE }, a));
    resp.clicked() && !busy
}

/// Hover text: the full address, when each window resets, how fresh the numbers are, any problem.
fn details(acc: &Account) -> String {
    let mut t = acc.email.clone();
    let now = unix_secs();
    for w in &acc.windows {
        if w.resets > now {
            t += &format!("\n{} {:.0}% · resets in {}", if w.label == "5h" { "5 hours" } else { "Week" }, w.pct, span(w.resets - now));
        }
    }
    if acc.at > 0 {
        t += &format!("\nread {}", ago(now.saturating_sub(acc.at / 1000)));
    }
    if let Some(e) = &acc.error {
        t += &format!("\n⚠ {e}");
    }
    if acc.best {
        t += "\n★ most room left of your accounts for this tool";
    }
    t
}

fn ago(s: u64) -> String {
    if s < 60 { "just now".into() } else if s < 5400 { format!("{} min ago", s / 60) } else { format!("{} h ago", s / 3600) }
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
        let j = r#"{"accounts":[{"provider":"codex","email":"a@b","name":"","plan":"Pro","price":200,"active":true,"best":false,
            "windows":[{"label":"wk","pct":11,"resets":100}],"at":1,"error":null},
            {"provider":"gemini","email":"c@d","name":"","plan":"","price":null,"active":false,"best":true,"windows":[],"at":0,"error":"not signed in"}]}"#;
        let l: List = serde_json::from_str(j).unwrap();
        assert_eq!(l.accounts[0].windows[0].pct, 11.0);
        assert_eq!(l.accounts[0].price, Some(200.0));
        assert!(l.accounts[1].price.is_none() && l.accounts[1].best);
    }

    #[test]
    fn reset_countdown() {
        assert_eq!(span(2 * 86400 + 4 * 3600 + 59), "2d 4h");
        assert_eq!(span(3 * 3600 + 5 * 60), "3h 05m");
        assert_eq!(span(720), "12m");
    }
}
