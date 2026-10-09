//! Headless logging: tracing appends to `tfs.log` beside the binary.
//!
//! No new dependency for this — `tracing_subscriber` already accepts any
//! `MakeWriter`, and one shared handle behind a mutex keeps concurrent events
//! from interleaving partial lines.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tracing_subscriber::fmt::MakeWriter;

/// Where headless mode (the default) writes its log.
pub fn log_path() -> PathBuf {
    tfs_config::appdata::get_bin_dir().join("tfs.log")
}

/// One append-mode file handle, handed out to writers as cheap clones.
#[derive(Clone)]
pub struct SharedLog(Arc<Mutex<File>>);

impl SharedLog {
    pub fn open() -> std::io::Result<Self> {
        let path = log_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self(Arc::new(Mutex::new(file))))
    }
}

impl Write for SharedLog {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // Recover from a poisoned lock: losing log lines is better than
        // panicking the server over a log write.
        self.0.lock().unwrap_or_else(|e| e.into_inner()).write(buf)
    }

    fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .write_all(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).flush()
    }
}

impl<'a> MakeWriter<'a> for SharedLog {
    type Writer = SharedLog;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One test touching the shared file: two would race on it, since Rust
    /// runs test threads in parallel.
    #[test]
    fn opens_beside_the_binary_appends_and_stays_whole() {
        let path = log_path();
        assert_eq!(path.file_name().unwrap(), "tfs.log");
        let bin_dir = tfs_config::appdata::get_bin_dir();
        assert_eq!(path.parent(), Some(bin_dir.as_path()));

        let before = std::fs::read_to_string(&path).unwrap_or_default();

        let log = SharedLog::open().unwrap();
        let mut a = log.clone();
        let mut b = log.clone();
        a.write_all(b"first\n").unwrap();
        b.write_all(b"second\n").unwrap();
        a.flush().unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        // Opened in append mode, so nothing written earlier was lost ...
        assert!(after.len() >= before.len() + 13);
        // ... and clones share one handle, so the lines landed whole.
        assert!(after.ends_with("first\nsecond\n"), "{after:?}");
    }
}
