//! The bits of macOS that egui can't reach: notch geometry, window level above the menu bar,
//! and a cheap global mouse watcher (so the window can stay click-through until hovered).

use objc2::encode::{Encode, Encoding};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use std::ffi::c_void;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGPoint {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGSize {
    w: f64,
    h: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct EdgeInsets {
    top: f64,
    left: f64,
    bottom: f64,
    right: f64,
}
unsafe impl Encode for CGPoint {
    const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for CGSize {
    const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for CGRect {
    const ENCODING: Encoding = Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
}
unsafe impl Encode for EdgeInsets {
    const ENCODING: Encoding = Encoding::Struct("NSEdgeInsets", &[f64::ENCODING; 4]);
}

#[derive(Clone, Copy)]
pub struct Geometry {
    pub screen_w: f32,
    pub notch_w: f32,
    pub bar_h: f32,
}

fn main_screen() -> *mut AnyObject {
    unsafe {
        let _: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        // the built-in display (has the notch); falls back to the main screen
        let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
        let n: usize = msg_send![screens, count];
        for i in 0..n {
            let s: *mut AnyObject = msg_send![screens, objectAtIndex: i];
            let inset: EdgeInsets = msg_send![s, safeAreaInsets];
            if inset.top > 0.0 {
                return s;
            }
        }
        msg_send![class!(NSScreen), mainScreen]
    }
}

pub fn geometry() -> Geometry {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: bool = msg_send![app, setActivationPolicy: 1isize]; // accessory: no Dock icon, may sit over full-screen apps
        let s = main_screen();
        let frame: CGRect = msg_send![s, frame];
        let visible: CGRect = msg_send![s, visibleFrame];
        let inset: EdgeInsets = msg_send![s, safeAreaInsets];
        let w = frame.size.w as f32;
        if inset.top > 0.0 {
            let l: CGRect = msg_send![s, auxiliaryTopLeftArea];
            let r: CGRect = msg_send![s, auxiliaryTopRightArea];
            Geometry { screen_w: w, notch_w: (frame.size.w - l.size.w - r.size.w) as f32, bar_h: inset.top as f32 }
        } else {
            // no notch: pretend there is one, so the pill still sits top-centre
            let bar = (frame.origin.y + frame.size.h) - (visible.origin.y + visible.size.h);
            Geometry { screen_w: w, notch_w: 160.0, bar_h: bar.max(24.0) as f32 }
        }
    }
}

/// Above the menu bar, on every Space and over full-screen apps, flush with the top of the notched screen.
pub fn pin_to_notch(w: f32, h: f32) {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        // winit makes the app "regular" once launched; only an accessory app may sit over other apps' full screen
        let _: bool = msg_send![app, setActivationPolicy: 1isize];
        let s = main_screen();
        let f: CGRect = msg_send![s, frame];
        let rect = CGRect {
            origin: CGPoint { x: f.origin.x + (f.size.w - w as f64) / 2.0, y: f.origin.y + f.size.h - h as f64 },
            size: CGSize { w: w as f64, h: h as f64 },
        };
        let windows: *mut AnyObject = msg_send![app, windows];
        let n: usize = msg_send![windows, count];
        for i in 0..n {
            let win: *mut AnyObject = msg_send![windows, objectAtIndex: i];
            // a window only joins other Spaces when it is ordered in with the behaviour already set
            let _: () = msg_send![win, orderOut: std::ptr::null::<AnyObject>()];
            let _: () = msg_send![win, setLevel: 27isize]; // NSMainMenuWindowLevel + 3
            // canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary
            let _: () = msg_send![win, setCollectionBehavior: (1usize | 16 | 64 | 256)];
            let _: () = msg_send![win, setHasShadow: false];
            let _: () = msg_send![win, setFrame: rect, display: true];
            let _: () = msg_send![win, orderFrontRegardless];
        }
    }
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreate(source: *const c_void) -> *mut c_void;
    fn CGEventGetLocation(e: *mut c_void) -> CGPoint;
    fn CFRelease(p: *mut c_void);
}

/// Global mouse position, top-left origin (main display).
fn mouse() -> (f32, f32) {
    unsafe {
        let e = CGEventCreate(std::ptr::null());
        let p = CGEventGetLocation(e);
        CFRelease(e);
        (p.x as f32, p.y as f32)
    }
}

/// Opens as soon as the mouse is over the collapsed pill, closes 300 ms after it leaves the open panel.
/// Polls at 20 Hz on its own thread and only wakes the UI when the state changes.
pub fn watch_hover(ctx: eframe::egui::Context, open: Arc<AtomicBool>, screen_w: f32, small: eframe::egui::Vec2, big: eframe::egui::Vec2) {
    std::thread::Builder::new()
        .name("hover".into())
        .spawn(move || {
            let mut left_at: Option<Instant> = None;
            loop {
                std::thread::sleep(Duration::from_millis(50));
                let (x, y) = mouse();
                let is_open = open.load(Ordering::Relaxed);
                let zone = if is_open { big } else { small };
                let inside = (x - screen_w / 2.0).abs() <= zone.x / 2.0 && (0.0..=zone.y).contains(&y);
                let want = if inside {
                    left_at = None;
                    true
                } else if is_open {
                    let t = *left_at.get_or_insert_with(Instant::now);
                    t.elapsed() < Duration::from_millis(300)
                } else {
                    false
                };
                if want != is_open {
                    open.store(want, Ordering::Relaxed);
                    ctx.request_repaint();
                }
            }
        })
        .expect("hover thread");
}


/// True when our window is not on the Space the user is looking at (it can miss a full-screen Space
/// if it was ordered in too early); the caller then pins it again.
pub fn off_active_space() -> bool {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let windows: *mut AnyObject = msg_send![app, windows];
        let n: usize = msg_send![windows, count];
        (0..n).any(|i| {
            let win: *mut AnyObject = msg_send![windows, objectAtIndex: i];
            let level: isize = msg_send![win, level];
            let on: bool = msg_send![win, isOnActiveSpace];
            level == 27 && !on
        })
    }
}
