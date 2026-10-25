//! ⌘V while the panel is open pastes onto the shelf, when the clipboard holds a picture or a file
//! (plain text still pastes wherever you were typing). The window never takes the keyboard, so this
//! listens system-wide, which needs Accessibility permission once; macOS asks on first start.

use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use std::ffi::c_void;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const KEY_DOWN: u32 = 10;
const TAP_OFF_TIMEOUT: u32 = 0xFFFF_FFFE;
const TAP_OFF_USER: u32 = 0xFFFF_FFFF;
const KEYCODE_FIELD: u32 = 9;
const KEY_V: i64 = 9;
const COMMAND: u64 = 1 << 20;
const OTHER_MODS: u64 = (1 << 17) | (1 << 18) | (1 << 19); // shift, control, option

type TapCallback = extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventTapCreate(tap: u32, place: u32, options: u32, mask: u64, cb: TapCallback, user: *mut c_void) -> *mut c_void;
    fn CGEventTapEnable(tap: *mut c_void, on: bool);
    fn CGEventGetIntegerValueField(e: *mut c_void, field: u32) -> i64;
    fn CGEventGetFlags(e: *mut c_void) -> u64;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFMachPortCreateRunLoopSource(alloc: *const c_void, port: *mut c_void, order: isize) -> *mut c_void;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopAddSource(rl: *mut c_void, src: *mut c_void, mode: *const c_void);
    fn CFRunLoopRun();
    static kCFRunLoopCommonModes: *const c_void;
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

struct State {
    open: Arc<AtomicBool>,
    paste: Arc<AtomicBool>,
    ctx: eframe::egui::Context,
    tap: AtomicPtr,
}

type AtomicPtr = std::sync::atomic::AtomicPtr<c_void>;

fn trusted(prompt: bool) -> bool {
    let opts: CFDictionary<CFString, CFType> =
        CFDictionary::from_CFType_pairs(&[(unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) }, CFBoolean::from(prompt).as_CFType())]);
    unsafe { AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef() as _) }
}

extern "C" fn on_key(_proxy: *mut c_void, kind: u32, event: *mut c_void, user: *mut c_void) -> *mut c_void {
    let st = unsafe { &*(user as *const State) };
    if kind == TAP_OFF_TIMEOUT || kind == TAP_OFF_USER {
        unsafe { CGEventTapEnable(st.tap.load(Ordering::Relaxed), true) };
        return event;
    }
    if kind != KEY_DOWN || !st.open.load(Ordering::Relaxed) {
        return event;
    }
    let flags = unsafe { CGEventGetFlags(event) };
    let is_cmd_v = unsafe { CGEventGetIntegerValueField(event, KEYCODE_FIELD) } == KEY_V && flags & COMMAND != 0 && flags & OTHER_MODS == 0;
    if !is_cmd_v || !crate::shelf_mac::has_file_or_picture() {
        return event;
    }
    st.paste.store(true, Ordering::Relaxed);
    st.ctx.request_repaint();
    std::ptr::null_mut() // swallowed: the app underneath does not paste too
}

/// Starts listening; `paste` turns true for every ⌘V meant for the shelf.
pub fn listen(open: Arc<AtomicBool>, ctx: eframe::egui::Context) -> Arc<AtomicBool> {
    let paste = Arc::new(AtomicBool::new(false));
    let st = State { open, paste: paste.clone(), ctx, tap: AtomicPtr::new(std::ptr::null_mut()) };
    std::thread::Builder::new()
        .name("cmd-v".into())
        .spawn(move || {
            // ask once per start; then wait quietly until the switch is turned on in System Settings
            if !trusted(true) {
                while !trusted(false) {
                    std::thread::sleep(Duration::from_secs(5));
                }
            }
            let st: &'static State = Box::leak(Box::new(st));
            unsafe {
                let tap = CGEventTapCreate(1 /* session */, 0 /* head */, 0 /* may swallow */, 1 << KEY_DOWN, on_key, st as *const State as *mut c_void);
                if tap.is_null() {
                    return;
                }
                st.tap.store(tap, Ordering::Relaxed);
                let src = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
                CFRunLoopAddSource(CFRunLoopGetCurrent(), src, kCFRunLoopCommonModes);
                CGEventTapEnable(tap, true);
                CFRunLoopRun();
            }
        })
        .expect("cmd-v thread");
    paste
}
