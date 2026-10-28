//! The shelf: files and images parked for a while. Drop or paste them in, drag them out or click to
//! copy, as often as needed; each one is deleted 3 days after it came in.
//! Every item sits in its own folder named after when it came in, so the file keeps its own name.

use crate::stats::{data_dir, unix_secs};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const KEEP_S: u64 = 3 * 86400;

#[derive(Clone, PartialEq, Debug)]
pub struct Item {
    pub path: PathBuf,
    pub added: u64, // unix s
}

pub fn dir() -> PathBuf {
    data_dir().join("shelf")
}

/// What is on the shelf, newest first.
pub fn list(root: &Path) -> Vec<Item> {
    let mut v: Vec<Item> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|slot| {
            let added = slot.file_name().to_string_lossy().split('-').next()?.parse().ok()?;
            let file = std::fs::read_dir(slot.path()).ok()?.flatten().find(|f| !f.file_name().to_string_lossy().starts_with('.'))?;
            Some(Item { path: file.path(), added })
        })
        .collect();
    v.sort_by(|a, b| b.added.cmp(&a.added).then_with(|| a.path.cmp(&b.path)));
    v
}

/// A fresh folder for one item: "<unix s>-<ns>", unique even for several items dropped together.
fn new_slot(root: &Path) -> std::io::Result<PathBuf> {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let slot = root.join(format!("{}-{}", d.as_secs(), d.subsec_nanos()));
    std::fs::create_dir_all(&slot)?;
    Ok(slot)
}

/// Copies a file or folder onto the shelf (an APFS clone: instant and takes no extra space).
/// Things already on the shelf (dragged out and dropped back) are left alone.
pub fn add(root: &Path, src: &Path) -> bool {
    if src.starts_with(root) || !src.exists() {
        return false;
    }
    let Ok(slot) = new_slot(root) else { return false };
    let ok = std::process::Command::new("/bin/cp").arg("-Rc").arg(src).arg(&slot).status().is_ok_and(|s| s.success());
    if !ok {
        let _ = std::fs::remove_dir_all(&slot);
    }
    ok
}

/// Puts pasted image data on the shelf as a file.
pub fn add_bytes(root: &Path, name: &str, bytes: &[u8]) -> bool {
    new_slot(root).is_ok_and(|slot| std::fs::write(slot.join(name), bytes).is_ok())
}

/// Loose files in the shelf folder itself (macOS writes screenshots there) each move into their own
/// slot, so they show up like anything dropped in. Hidden files are skipped: macOS writes a screenshot
/// as ".Screenshot…" first and renames it only when it is complete. Returns where they landed.
pub fn adopt_loose(root: &Path) -> Vec<PathBuf> {
    let loose: Vec<PathBuf> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()) && !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .collect();
    loose
        .into_iter()
        .filter_map(|f| {
            let slot = new_slot(root).ok()?;
            let to = slot.join(f.file_name()?);
            std::fs::rename(&f, &to).map(|_| to).map_err(|_| std::fs::remove_dir_all(&slot)).ok()
        })
        .collect()
}

pub fn remove(item: &Item) {
    if let Some(slot) = item.path.parent() {
        let _ = std::fs::remove_dir_all(slot);
    }
}

/// Deletes everything that came in more than 3 days ago.
pub fn sweep(root: &Path, now: u64) {
    for item in list(root) {
        if now.saturating_sub(item.added) >= KEEP_S {
            remove(&item);
        }
    }
}

/// Opens / thumbnails / copies as a picture rather than as a file.
pub fn is_image(p: &Path) -> bool {
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    ["png", "jpg", "jpeg", "gif", "heic", "heif", "tif", "tiff", "webp", "bmp"].contains(&ext.as_str())
}

/// "3m", "5h", "2d": how long ago it came in.
pub fn age(added: u64) -> String {
    let s = unix_secs().saturating_sub(added);
    if s < 3600 { format!("{}m", s / 60) } else if s < 86400 { format!("{}h", s / 3600) } else { format!("{}d", s / 86400) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let r = std::env::temp_dir().join(format!("notch-shelf-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&r);
        std::fs::create_dir_all(&r).unwrap();
        r
    }

    #[test]
    fn add_keeps_name_and_sweep_drops_only_old_items() {
        let root = temp_root("sweep");
        let src = root.with_extension("src.png");
        std::fs::write(&src, b"x").unwrap();
        assert!(add(&root, &src));
        assert!(add_bytes(&root, "pasted.png", b"y"));
        let items = list(&root);
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|i| i.path.file_name() == src.file_name()));
        assert!(!add(&root, &items[0].path), "dropping a shelf item back must not duplicate it");

        let now = unix_secs();
        sweep(&root, now + KEEP_S - 60);
        assert_eq!(list(&root).len(), 2, "younger than 3 days stays");
        sweep(&root, now + KEEP_S + 60);
        assert!(list(&root).is_empty(), "older than 3 days goes");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn loose_files_move_into_their_own_slot() {
        let root = temp_root("loose");
        std::fs::write(root.join("Screenshot 1.png"), b"a").unwrap();
        std::fs::write(root.join(".Screenshot 2.png"), b"half written").unwrap();
        let moved = adopt_loose(&root);
        assert_eq!(moved.len(), 1);
        let items = list(&root);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].path.file_name().unwrap(), "Screenshot 1.png");
        assert!(root.join(".Screenshot 2.png").exists(), "files still being written stay put");
        assert!(adopt_loose(&root).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn images_are_told_apart_from_other_files() {
        assert!(is_image(Path::new("a/Shot.PNG")));
        assert!(!is_image(Path::new("a/spec.pdf")));
    }
}
