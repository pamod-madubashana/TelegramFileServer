//! Command line surface: `tfs` (headless by default), `tfs --showlogs`,
//! `tfs --stop`, `tfs --wipe-users --yes`.
//!
//! Headless is the default: no window, logs on disk, stoppable without a
//! console. `--showlogs` opts back into a console with logs on stdout.

use anyhow::Context;
use std::path::PathBuf;

pub const HELP_FLAG: &str = "--help";
pub const HEADLESS_FLAG: &str = "--headless";
pub const SHOWLOGS_FLAG: &str = "--showlogs";
pub const STOP_FLAG: &str = "--stop";
pub const WIPE_FLAG: &str = "--wipe-users";
pub const YES_FLAG: &str = "--yes";

const USAGE: &str = "\
TelegramFileServer

USAGE:
    tfs [--showlogs]
    tfs --stop
    tfs --wipe-users --yes
    tfs --help

OPTIONS:
    (default)     Run headless: no window; logs go to tfs.log beside the binary.
    --showlogs    Run with a console; logs also go to stdout.
    --headless    Accepted for compatibility — headless is already the default.
    --stop        Stop a running background instance.
    --wipe-users  Delete every user account (requires --yes).
    --help        Show this help.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Serve { headless: bool },
    Stop,
    WipeUsers,
}

/// Parse the arguments after argv[0].
///
/// An unknown flag is a hard error: silently serving when the operator
/// meant `--stop` would leave a process they think they killed.
pub fn parse(args: impl IntoIterator<Item = String>) -> anyhow::Result<Command> {
    // Headless unless a console is asked for explicitly.
    let mut showlogs = false;
    let mut headless_flag = false;
    let mut stop = false;
    let mut wipe = false;
    let mut yes = false;

    for arg in args {
        match arg.as_str() {
            SHOWLOGS_FLAG => showlogs = true,
            HEADLESS_FLAG => headless_flag = true,
            STOP_FLAG => stop = true,
            WIPE_FLAG => wipe = true,
            YES_FLAG => yes = true,
            HELP_FLAG | "-h" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            other => anyhow::bail!("unknown argument {other:?}\n\n{USAGE}"),
        }
    }

    if stop && (showlogs || headless_flag || wipe || yes) {
        anyhow::bail!("--stop cannot be combined with the other flags\n\n{USAGE}");
    }
    if showlogs && headless_flag {
        anyhow::bail!("--showlogs cannot be combined with --headless\n\n{USAGE}");
    }
    if wipe && (showlogs || headless_flag) {
        anyhow::bail!("--wipe-users cannot be combined with serve flags\n\n{USAGE}");
    }
    if wipe && !yes {
        anyhow::bail!("--wipe-users deletes every account — confirm with --yes\n\n{USAGE}");
    }

    Ok(if stop {
        Command::Stop
    } else if wipe {
        Command::WipeUsers
    } else {
        Command::Serve {
            headless: !showlogs,
        }
    })
}

/// Machine-local pid file. Deliberately in the temp dir, not beside the
/// binary: a copied install must not carry a stale pid that `--stop` would
/// resolve against some unrelated process on another machine.
pub fn pid_file(port: u16) -> PathBuf {
    std::env::temp_dir().join(format!("tfs-{port}.pid"))
}

/// Record this process so `tfs --stop` can find it. Only background
/// instances are recorded — a console instance is already stoppable with
/// Ctrl+C, and a stale pid from one would be a hazard.
pub fn write_pid(port: u16) -> anyhow::Result<()> {
    std::fs::write(pid_file(port), std::process::id().to_string())
        .with_context(|| format!("could not write {}", pid_file(port).display()))
}

pub fn remove_pid(port: u16) {
    let _ = std::fs::remove_file(pid_file(port));
}

/// Terminate the instance recorded in the pid file.
pub fn stop(port: u16) -> anyhow::Result<()> {
    let path = pid_file(port);
    let raw = std::fs::read_to_string(&path).with_context(|| {
        format!(
            "no background instance recorded at {} — is one running?",
            path.display()
        )
    })?;

    let pid: u32 = raw
        .trim()
        .parse()
        .with_context(|| format!("stale pid file at {}", path.display()))?;

    terminate(pid)?;
    // Drop the file only after the kill actually landed, so a failed stop
    // leaves the pid in place for a retry.
    let _ = std::fs::remove_file(&path);
    println!("stopped tfs (pid {pid})");
    Ok(())
}

/// Windows console plumbing. The binary links as a no-console app so that
/// the default headless serve starts with no window; `--showlogs` (and
/// every other command) asks for one here.
#[cfg(windows)]
mod sys {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn AttachConsole(dw_process_id: u32) -> i32;
        pub fn AllocConsole() -> i32;
        pub fn GetStdHandle(which: u32) -> isize;
        pub fn SetStdHandle(which: u32, handle: isize) -> i32;
        pub fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: isize,
            disposition: u32,
            flags: u32,
            template: isize,
        ) -> isize;
    }

    pub const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF;
    pub const STD_OUTPUT_HANDLE: u32 = (-11i32) as u32;
    pub const STD_ERROR_HANDLE: u32 = (-12i32) as u32;
    pub const GENERIC_WRITE: u32 = 0x4000_0000;
    pub const FILE_SHARE_READ: u32 = 0x0000_0001;
    pub const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    pub const OPEN_EXISTING: u32 = 3;
    pub const INVALID_HANDLE_VALUE: isize = -1;

    /// L"CONOUT$" — the attached console's output.
    pub const CONOUT: [u16; 7] = [
        b'C' as u16,
        b'O' as u16,
        b'N' as u16,
        b'O' as u16,
        b'U' as u16,
        b'T' as u16,
        0,
    ];

    /// `GetStdHandle` reports "nothing here" as 0 or -1.
    pub fn valid(handle: isize) -> bool {
        handle != 0 && handle != INVALID_HANDLE_VALUE
    }

    /// The attached console's output, or an invalid handle when the process
    /// has no console at all.
    pub fn open_conout() -> isize {
        unsafe {
            CreateFileW(
                CONOUT.as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                0,
                OPEN_EXISTING,
                0,
                0,
            )
        }
    }
}

/// Give default mode somewhere to print.
///
/// Output already redirected to a pipe or file is left alone — that is how
/// `cargo run` and `tfs --stop | Out-String` still capture the text.
/// Otherwise a console may already exist with nothing pointing at it, so try
/// `CONOUT$` first, then attach to the terminal that launched us (logs
/// appear there exactly as they did when this was a console app), and only
/// allocate a new window when there is no parent console — the double-click
/// case, where a window with logs is what we want.
#[cfg(windows)]
pub fn ensure_console() {
    use sys::*;

    unsafe {
        if !valid(GetStdHandle(STD_OUTPUT_HANDLE)) {
            let mut conout = open_conout();
            if !valid(conout) {
                if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
                    AllocConsole();
                }
                conout = open_conout();
            }
            if valid(conout) {
                SetStdHandle(STD_OUTPUT_HANDLE, conout);
            }
        }

        // stderr follows stdout unless it already has somewhere to go.
        if !valid(GetStdHandle(STD_ERROR_HANDLE)) {
            let out = GetStdHandle(STD_OUTPUT_HANDLE);
            if valid(out) {
                SetStdHandle(STD_ERROR_HANDLE, out);
            }
        }
    }
}

/// Headless must never create a console, but stdio still needs a valid
/// handle: `eprintln!` panics rather than ignore a failed write, and the
/// storage layer reports corrupt files through it. Point whatever is
/// missing at the log file.
#[cfg(windows)]
pub fn point_stdio_at(log: &std::path::Path) -> anyhow::Result<()> {
    use sys::*;

    unsafe {
        let need_out = !valid(GetStdHandle(STD_OUTPUT_HANDLE));
        let need_err = !valid(GetStdHandle(STD_ERROR_HANDLE));
        if !need_out && !need_err {
            return Ok(());
        }

        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .with_context(|| format!("could not open {}", log.display()))?;
        let raw = std::os::windows::io::AsRawHandle::as_raw_handle(&file) as isize;
        // The OS handle has to outlive the process; nothing else owns it.
        std::mem::forget(file);

        if need_out {
            SetStdHandle(STD_OUTPUT_HANDLE, raw);
        }
        if need_err {
            SetStdHandle(STD_ERROR_HANDLE, raw);
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn ensure_console() {}

#[cfg(not(windows))]
pub fn point_stdio_at(_log: &std::path::Path) -> anyhow::Result<()> {
    Ok(())
}

/// Terminate a process by pid.
#[cfg(windows)]
fn terminate(pid: u32) -> anyhow::Result<()> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> isize;
        fn TerminateProcess(handle: isize, exit_code: u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
        fn GetLastError() -> u32;
    }

    const PROCESS_TERMINATE: u32 = 0x0001;

    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle == 0 {
            anyhow::bail!(
                "could not open pid {pid} (win32 error {}) — already stopped?",
                GetLastError()
            );
        }
        let ok = TerminateProcess(handle, 1);
        let err = GetLastError();
        CloseHandle(handle);
        if ok == 0 {
            anyhow::bail!("failed to terminate pid {pid} (win32 error {err})");
        }
    }
    Ok(())
}

/// Terminate a process by pid.
#[cfg(unix)]
fn terminate(pid: u32) -> anyhow::Result<()> {
    const SIGTERM: i32 = 15;

    unsafe extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }

    if unsafe { kill(pid as i32, SIGTERM) } != 0 {
        anyhow::bail!("could not signal pid {pid} — already stopped?");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_args(args: &[&str]) -> anyhow::Result<Command> {
        parse(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn default_is_serve_headless() {
        assert_eq!(parse_args(&[]).unwrap(), Command::Serve { headless: true });
    }

    #[test]
    fn showlogs_flag_selects_console_mode() {
        assert_eq!(
            parse_args(&[SHOWLOGS_FLAG]).unwrap(),
            Command::Serve { headless: false }
        );
    }

    #[test]
    fn headless_flag_still_selects_background_mode() {
        assert_eq!(
            parse_args(&[HEADLESS_FLAG]).unwrap(),
            Command::Serve { headless: true }
        );
    }

    #[test]
    fn showlogs_and_headless_conflict() {
        let err = parse_args(&[SHOWLOGS_FLAG, HEADLESS_FLAG]).unwrap_err();
        assert!(err.to_string().contains("--showlogs cannot be combined"));
    }

    #[test]
    fn stop_flag_is_distinct_from_serve() {
        assert_eq!(parse_args(&[STOP_FLAG]).unwrap(), Command::Stop);
    }

    #[test]
    fn stop_cannot_be_combined_with_serve_flags() {
        let err = parse_args(&[STOP_FLAG, HEADLESS_FLAG]).unwrap_err();
        assert!(err.to_string().contains("--stop cannot be combined"));
        let err = parse_args(&[STOP_FLAG, SHOWLOGS_FLAG]).unwrap_err();
        assert!(err.to_string().contains("--stop cannot be combined"));
    }

    #[test]
    fn wipe_requires_yes() {
        let err = parse_args(&[WIPE_FLAG]).unwrap_err();
        assert!(err.to_string().contains("confirm with --yes"));
    }

    #[test]
    fn wipe_with_yes_is_its_own_command() {
        assert_eq!(
            parse_args(&[WIPE_FLAG, YES_FLAG]).unwrap(),
            Command::WipeUsers
        );
    }

    #[test]
    fn wipe_cannot_be_combined_with_serve_or_stop() {
        let err = parse_args(&[WIPE_FLAG, YES_FLAG, SHOWLOGS_FLAG]).unwrap_err();
        assert!(err.to_string().contains("--wipe-users cannot be combined"));
        let err = parse_args(&[STOP_FLAG, WIPE_FLAG, YES_FLAG]).unwrap_err();
        assert!(err.to_string().contains("--stop cannot be combined"));
    }

    #[test]
    fn unknown_flags_are_rejected_rather_than_ignored() {
        let err = parse_args(&["--detach"]).unwrap_err();
        assert!(err.to_string().contains("unknown argument"));
    }

    #[test]
    fn pid_file_is_machine_local_not_beside_the_binary() {
        let pid = pid_file(8090);
        assert_eq!(pid.file_name().unwrap(), "tfs-8090.pid");
        assert_ne!(
            pid.parent(),
            Some(tfs_config::appdata::get_bin_dir().as_path())
        );
    }
}
