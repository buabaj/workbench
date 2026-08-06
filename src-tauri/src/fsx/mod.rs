//! Filesystem layer. `safe_path` is the single validation chokepoint — every
//! operation in `ops`/`walker` takes a `SafePath` or a `WorkspaceRoot`, never
//! a raw user path.

pub mod ops;
pub mod safe_path;
pub mod walker;
pub mod watcher;
