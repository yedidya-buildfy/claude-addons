//! The macOS side of the shelf: the clipboard, thumbnails (ImageIO, so any picture macOS can open,
//! otherwise the file's Finder icon) and dragging a shelf file out into another app.

use crate::mac::{CGPoint, CGRect, CGSize};
use crate::shelf::is_image;
use core_foundation::base::{CFRelease, CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use core_foundation::url::CFURL;
use objc2::rc::autoreleasepool;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{ClassType, class, define_class, msg_send};
use std::ffi::{CStr, CString, c_char, c_void};
use std::path::{Path, PathBuf};

unsafe fn ns(s: &str) -> *mut AnyObject {
    let c = CString::new(s).unwrap_or_default();
    unsafe { msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()] }
}

unsafe fn text(s: *mut AnyObject) -> Option<String> {
    if s.is_null() {
        return None;
    }
    let p: *const c_char = unsafe { msg_send![s, UTF8String] };
    (!p.is_null()).then(|| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
}

unsafe fn bytes(d: *mut AnyObject) -> Option<Vec<u8>> {
    if d.is_null() {
        return None;
    }
    let len: usize = unsafe { msg_send![d, length] };
    let p: *const u8 = unsafe { msg_send![d, bytes] };
    (!p.is_null()).then(|| unsafe { std::slice::from_raw_parts(p, len) }.to_vec())
}

unsafe fn ns_data(b: &[u8]) -> *mut AnyObject {
    unsafe { msg_send![class!(NSData), dataWithBytes: b.as_ptr() as *const c_void, length: b.len()] }
}

/// Any bitmap macOS can read (TIFF from the clipboard, a JPEG file …) as PNG bytes.
unsafe fn to_png(data: *mut AnyObject) -> Option<Vec<u8>> {
    if data.is_null() {
        return None;
    }
    unsafe {
        let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: data];
        if rep.is_null() {
            return None;
        }
        let props: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
        bytes(msg_send![rep, representationUsingType: 4usize /* PNG */, properties: props])
    }
}

unsafe fn pasteboard() -> *mut AnyObject {
    unsafe { msg_send![class!(NSPasteboard), generalPasteboard] }
}

/// True when the clipboard holds a copied file or picture (what ⌘V onto the shelf takes).
pub fn has_file_or_picture() -> bool {
    autoreleasepool(|_| unsafe {
        let types: *mut AnyObject = msg_send![pasteboard(), types];
        !types.is_null()
            && ["public.file-url", "public.png", "public.tiff"].iter().any(|t| {
                let has: bool = msg_send![types, containsObject: ns(t)];
                has
            })
    })
}

pub enum Pasted {
    File(PathBuf),
    Png(Vec<u8>),
}

/// What the clipboard holds: copied files (Finder ⌘C), else a copied picture (screenshot ⌃⌘⇧4, browser).
pub fn paste() -> Vec<Pasted> {
    autoreleasepool(|_| unsafe {
        let items: *mut AnyObject = msg_send![pasteboard(), pasteboardItems];
        let n: usize = if items.is_null() { 0 } else { msg_send![items, count] };
        let mut out = Vec::new();
        for i in 0..n {
            let it: *mut AnyObject = msg_send![items, objectAtIndex: i];
            if let Some(u) = text(msg_send![it, stringForType: ns("public.file-url")]) {
                let url: *mut AnyObject = msg_send![class!(NSURL), URLWithString: ns(&u)];
                if !url.is_null()
                    && let Some(p) = text(msg_send![url, path])
                {
                    out.push(Pasted::File(p.into()));
                    continue;
                }
            }
            if let Some(png) = bytes(msg_send![it, dataForType: ns("public.png")]) {
                out.push(Pasted::Png(png));
            } else if let Some(png) = to_png(msg_send![it, dataForType: ns("public.tiff")]) {
                out.push(Pasted::Png(png));
            }
        }
        out
    })
}

/// Puts one shelf item on the clipboard: a picture pastes as the picture (Claude, chats, docs),
/// any other file as the file (Finder) or its path (terminal, text fields).
pub fn copy(path: &Path) {
    autoreleasepool(|_| unsafe {
        let p = path.to_string_lossy();
        let item: *mut AnyObject = msg_send![class!(NSPasteboardItem), new];
        let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: ns(&p)];
        let abs: *mut AnyObject = msg_send![url, absoluteString];
        let _: bool = msg_send![item, setString: abs, forType: ns("public.file-url")];
        let png = if !is_image(path) {
            None
        } else if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("png")) {
            std::fs::read(path).ok()
        } else {
            let img: *mut AnyObject = msg_send![class!(NSImage), alloc];
            let img: *mut AnyObject = msg_send![img, initWithContentsOfFile: ns(&p)];
            let png = if img.is_null() { None } else { to_png(msg_send![img, TIFFRepresentation]) };
            if !img.is_null() {
                let _: () = msg_send![img, release];
            }
            png
        };
        match png {
            Some(b) => {
                let _: bool = msg_send![item, setData: ns_data(&b), forType: ns("public.png")];
            }
            None => {
                let _: bool = msg_send![item, setString: ns(&p), forType: ns("public.utf8-plain-text")];
            }
        }
        let pb = pasteboard();
        let _: isize = msg_send![pb, clearContents];
        let list: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: item];
        let _: bool = msg_send![pb, writeObjects: list];
        let _: () = msg_send![item, release];
    })
}

#[link(name = "ImageIO", kind = "framework")]
unsafe extern "C" {
    fn CGImageSourceCreateWithURL(url: *const c_void, options: *const c_void) -> *mut c_void;
    fn CGImageSourceCreateWithData(data: *const c_void, options: *const c_void) -> *mut c_void;
    fn CGImageSourceCreateThumbnailAtIndex(src: *mut c_void, index: usize, options: *const c_void) -> *mut c_void;
    static kCGImageSourceCreateThumbnailFromImageAlways: CFStringRef;
    static kCGImageSourceCreateThumbnailWithTransform: CFStringRef;
    static kCGImageSourceThumbnailMaxPixelSize: CFStringRef;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGImageGetWidth(img: *mut c_void) -> usize;
    fn CGImageGetHeight(img: *mut c_void) -> usize;
    fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
    fn CGBitmapContextCreate(data: *mut c_void, w: usize, h: usize, bits: usize, row: usize, cs: *mut c_void, info: u32) -> *mut c_void;
    fn CGContextDrawImage(ctx: *mut c_void, r: CGRect, img: *mut c_void);
}

unsafe fn icon(path: &Path) -> *mut AnyObject {
    unsafe {
        let ws: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        msg_send![ws, iconForFile: ns(&path.to_string_lossy())]
    }
}

/// Up to `px` on the long side, premultiplied RGBA, top row first.
pub fn thumbnail(path: &Path, px: u32) -> Option<([usize; 2], Vec<u8>)> {
    autoreleasepool(|_| unsafe {
        let src = if is_image(path) {
            let url = CFURL::from_path(path, false)?;
            CGImageSourceCreateWithURL(url.as_concrete_TypeRef() as _, std::ptr::null())
        } else {
            let tiff: *mut AnyObject = msg_send![icon(path), TIFFRepresentation];
            if tiff.is_null() {
                return None;
            }
            CGImageSourceCreateWithData(tiff as _, std::ptr::null())
        };
        if src.is_null() {
            return None;
        }
        let key = |k: CFStringRef| CFString::wrap_under_get_rule(k);
        let opts: CFDictionary<CFString, CFType> = CFDictionary::from_CFType_pairs(&[
            (key(kCGImageSourceCreateThumbnailFromImageAlways), CFBoolean::true_value().as_CFType()),
            (key(kCGImageSourceCreateThumbnailWithTransform), CFBoolean::true_value().as_CFType()),
            (key(kCGImageSourceThumbnailMaxPixelSize), CFNumber::from(px as i32).as_CFType()),
        ]);
        let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts.as_concrete_TypeRef() as _);
        CFRelease(src as _);
        if img.is_null() {
            return None;
        }
        let (w, h) = (CGImageGetWidth(img), CGImageGetHeight(img));
        let mut buf = vec![0u8; w * h * 4];
        let cs = CGColorSpaceCreateDeviceRGB();
        let ctx = CGBitmapContextCreate(buf.as_mut_ptr() as _, w, h, 8, w * 4, cs, 1 /* premultiplied RGBA */);
        if !ctx.is_null() {
            CGContextDrawImage(ctx, CGRect { origin: CGPoint::default(), size: CGSize { w: w as f64, h: h as f64 } }, img);
            CFRelease(ctx as _);
        }
        CFRelease(cs as _);
        CFRelease(img as _);
        (!ctx.is_null()).then_some(([w, h], buf))
    })
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "NotchStatsDragSource"]
    struct DragSource;

    impl DragSource {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn operations(&self, _session: *mut AnyObject, _context: isize) -> usize {
            1 // NSDragOperationCopy: the shelf keeps its own copy
        }
    }
);

/// Starts a real macOS drag of the given files, each from where its tile is drawn (`tile` = x, y, w, h
/// in window points, top-left origin); the app under the pointer receives them all when the mouse is let go.
pub fn drag_out(files: &[(PathBuf, [f32; 4])]) {
    autoreleasepool(|_| unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let windows: *mut AnyObject = msg_send![app, windows];
        let n: usize = msg_send![windows, count];
        let Some(win) = (0..n).map(|i| -> *mut AnyObject { msg_send![windows, objectAtIndex: i] }).find(|&w| {
            let level: isize = msg_send![w, level];
            level == 27
        }) else {
            return;
        };
        let view: *mut AnyObject = msg_send![win, contentView];
        let flipped: bool = msg_send![view, isFlipped];
        let bounds: CGRect = msg_send![view, bounds];
        let list: *mut AnyObject = msg_send![class!(NSMutableArray), array];
        for (path, tile) in files {
            let [x, y, w, h] = tile.map(|v| v as f64);
            let frame = CGRect { origin: CGPoint { x, y: if flipped { y } else { bounds.size.h - y - h } }, size: CGSize { w, h } };
            let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: ns(&path.to_string_lossy())];
            let item: *mut AnyObject = msg_send![class!(NSDraggingItem), alloc];
            let item: *mut AnyObject = msg_send![item, initWithPasteboardWriter: url];
            let _: () = msg_send![item, setDraggingFrame: frame, contents: icon(path)];
            let _: () = msg_send![list, addObject: item];
            let _: () = msg_send![item, release];
        }

        // egui has already eaten the real mouse event; AppKit only needs one that says "left button, dragging, here"
        let at: CGPoint = msg_send![win, mouseLocationOutsideOfEventStream];
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        let uptime: f64 = msg_send![info, systemUptime];
        let number: isize = msg_send![win, windowNumber];
        let event: *mut AnyObject = msg_send![class!(NSEvent), mouseEventWithType: 6usize /* left mouse dragged */, location: at, modifierFlags: 0usize, timestamp: uptime, windowNumber: number, context: std::ptr::null_mut::<AnyObject>(), eventNumber: 0isize, clickCount: 1isize, pressure: 1.0f32];
        if event.is_null() {
            return;
        }
        // ponytail: one tiny source object per drag is never freed; AppKit holds it only weakly
        let source: *mut AnyObject = msg_send![DragSource::class(), new];
        let _: *mut AnyObject = msg_send![view, beginDraggingSessionWithItems: list, event: event, source: source];
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn thumbnails_a_picture_and_an_icon() {
        let dir = std::env::temp_dir().join(format!("notch-thumb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("dot.png");
        // 2×1 PNG, one red and one blue pixel
        let bytes: [u8; 70] = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 1, 8, 2, 0, 0, 0, 123, 64, 232, 221, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 0, 4, 255, 1, 7, 0, 1, 255, 226, 35, 158, 89, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
        std::fs::write(&png, bytes).unwrap();
        let (size, rgba) = super::thumbnail(&png, 64).expect("png thumbnail");
        assert_eq!(rgba.len(), size[0] * size[1] * 4);
        assert!(rgba[0] > 200 && rgba[2] < 50, "first pixel red: {:?}", &rgba[..4]);
        let txt = dir.join("note.txt");
        std::fs::write(&txt, "hi").unwrap();
        assert!(super::thumbnail(&txt, 64).is_some(), "non-pictures get their Finder icon");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
