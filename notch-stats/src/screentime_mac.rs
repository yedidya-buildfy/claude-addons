//! The macOS side of screen time: the app in front, its focused window's title (Accessibility, the same
//! permission ⌘V on the shelf already asks for) and seconds since the last keyboard / mouse input.

use crate::shelf_mac::text;
use core_foundation::base::{CFRelease, TCFType};
use core_foundation::string::{CFString, CFStringRef};
use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use std::ffi::c_void;

pub struct Front {
    pub bundle: String,
    pub name: String,
    pub pid: i32,
}

/// The app in front now.
pub fn front() -> Option<Front> {
    autoreleasepool(|_| unsafe {
        let ws: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: *mut AnyObject = msg_send![ws, frontmostApplication];
        if app.is_null() {
            return None;
        }
        let pid: i32 = msg_send![app, processIdentifier];
        let bundle = text(msg_send![app, bundleIdentifier]).unwrap_or_default();
        let name = text(msg_send![app, localizedName]).unwrap_or_default();
        Some(Front { bundle, name, pid })
    })
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> *mut c_void;
    fn AXUIElementCopyAttributeValue(el: *mut c_void, attr: CFStringRef, out: *mut *mut c_void) -> i32;
    fn AXUIElementSetMessagingTimeout(el: *mut c_void, secs: f32) -> i32;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state: i32, kind: u32) -> f64;
}

/// The focused window's title; empty without the Accessibility permission or for windowless apps.
pub fn window_title(pid: i32) -> String {
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return String::new();
        }
        AXUIElementSetMessagingTimeout(app, 0.5); // a hung app must not stall the sampler
        let mut win: *mut c_void = std::ptr::null_mut();
        let mut title = String::new();
        if AXUIElementCopyAttributeValue(app, CFString::new("AXFocusedWindow").as_concrete_TypeRef(), &mut win) == 0 && !win.is_null() {
            let mut t: *mut c_void = std::ptr::null_mut();
            if AXUIElementCopyAttributeValue(win, CFString::new("AXTitle").as_concrete_TypeRef(), &mut t) == 0 && !t.is_null() {
                title = CFString::wrap_under_create_rule(t as CFStringRef).to_string();
            }
            CFRelease(win as _);
        }
        CFRelease(app as _);
        title
    }
}

/// Seconds since the last keyboard, mouse or trackpad input anywhere.
pub fn idle_secs() -> f64 {
    unsafe { CGEventSourceSecondsSinceLastEventType(0 /* combined session */, u32::MAX /* any input */) }
}
