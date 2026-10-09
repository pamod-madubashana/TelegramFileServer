//! Part of `cargo build`: compile the React webUI into `static/webui`.
//!
//! Best-effort and pure std:
//! - only runs when a webui source changed (cargo `rerun-if-changed`)
//! - only invokes npm when the output is older than the newest source
//! - if npm or node_modules is unavailable (CI without Node), cargo still
//!   succeeds and the last-built bundle checked into `static/webui` is served
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let webui = manifest.join("../../webui");
    let src = webui.join("src");
    let public = webui.join("public");
    let template = webui.join("index.html");
    let vite_config = webui.join("vite.config.ts");
    let out_index = manifest.join("static/webui/index.html");

    for path in [&src, &public, &template, &vite_config] {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    if out_index.exists() {
        let out = mtime(&out_index);
        let mut sources = newest(&src).or_else(|| mtime(&template));
        for extra in [&public, &template, &vite_config] {
            if let (Some(a), Some(b)) = (sources, mtime(extra)) {
                sources = Some(a.max(b));
            }
        }
        if let (Some(out), Some(sources)) = (out, sources)
            && sources <= out
        {
            return;
        }
    }

    if !webui.join("package.json").exists() {
        return;
    }

    #[cfg(windows)]
    let npm = "npm.cmd";
    #[cfg(not(windows))]
    let npm = "npm";

    let run = Command::new(npm)
        .args(["run", "build"])
        .current_dir(&webui)
        .status();

    match run {
        Ok(status) if status.success() => {}
        Ok(status) => println!(
            "cargo:warning=webui build failed (exit {}); keeping the existing static/webui bundle",
            status
        ),
        Err(err) => println!(
            "cargo:warning=webui build skipped ({err}); run scripts/build.ps1 or scripts/build.sh once"
        ),
    }
}

fn mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok()?.modified().ok()
}

fn newest(dir: &Path) -> Option<SystemTime> {
    let meta = fs::metadata(dir).ok()?;
    let mut latest = meta.modified().ok()?;
    if !meta.is_dir() {
        return Some(latest);
    }
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let time = if path.is_dir() {
            newest(&path)
        } else {
            mtime(&path)
        };
        if let Some(time) = time {
            latest = latest.max(time);
        }
    }
    Some(latest)
}
