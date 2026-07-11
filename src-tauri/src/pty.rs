use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct PtySession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    // OS pid of the spawned shell, captured once at spawn. Immutable for the
    // session's life, so the running-apps poll can read it under the sessions
    // lock without contending with the reader/kill on the `child` mutex.
    shell_pid: Option<u32>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Kill (no-op if already exited) and reap the child so it never
        // lingers as a zombie holding one of the finite PTY slots (macOS caps
        // ptmx at kern.tty.ptmx_max = 511). Both calls can block on process
        // teardown, so sessions must be dropped off the async worker pool.
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

#[derive(Clone, Serialize)]
struct PtyDataPayload {
    data: String,
}

fn default_home() -> Option<String> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE")
            .ok()
            .or_else(|| std::env::var("HOMEPATH").ok())
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok()
    }
}

fn shell_basename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// Returns the index up to which `bytes` can be safely UTF-8 decoded without
/// truncating a multi-byte char. Trailing bytes that look like the start of
/// an incomplete sequence (lead byte without all its continuations) are
/// excluded so the caller can carry them into the next read.
///
/// Invalid bytes that are *not* the start of an incomplete sequence are left
/// in — `from_utf8_lossy` will substitute them with U+FFFD as before.
fn utf8_safe_split(bytes: &[u8]) -> usize {
    let len = bytes.len();
    // A UTF-8 char is at most 4 bytes, so the lead of an incomplete trailing
    // sequence must be within the last 3 positions.
    let start = len.saturating_sub(3);
    for i in (start..len).rev() {
        let b = bytes[i];
        // Continuation byte: keep walking back to find the lead.
        if b & 0b1100_0000 == 0b1000_0000 {
            continue;
        }
        let expected = if b & 0b1000_0000 == 0 {
            1
        } else if b & 0b1110_0000 == 0b1100_0000 {
            2
        } else if b & 0b1111_0000 == 0b1110_0000 {
            3
        } else if b & 0b1111_1000 == 0b1111_0000 {
            4
        } else {
            // Not a valid lead byte — leave it for lossy to replace.
            return len;
        };
        let have = len - i;
        return if have < expected { i } else { len };
    }
    // No lead byte in the trailing window. Either the buffer is empty or
    // it ends with stray continuation bytes; either way, don't hold back.
    len
}

#[cfg(test)]
mod tests {
    use super::utf8_safe_split;

    #[test]
    fn holds_back_split_three_byte_char() {
        // `❯` is E2 9D AF. Split after the lead byte.
        let bytes = b"hi \xe2";
        assert_eq!(utf8_safe_split(bytes), 3);
        let bytes = b"hi \xe2\x9d";
        assert_eq!(utf8_safe_split(bytes), 3);
        let bytes = b"hi \xe2\x9d\xaf";
        assert_eq!(utf8_safe_split(bytes), 6);
    }

    #[test]
    fn holds_back_split_four_byte_char() {
        // U+1F600 is F0 9F 98 80.
        let bytes = b"x\xf0\x9f\x98";
        assert_eq!(utf8_safe_split(bytes), 1);
    }

    #[test]
    fn passes_through_ascii() {
        assert_eq!(utf8_safe_split(b"hello"), 5);
        assert_eq!(utf8_safe_split(b""), 0);
    }

    #[test]
    fn does_not_hold_back_invalid_bytes() {
        // Stray continuation byte at the end is invalid, not incomplete —
        // let lossy replace it instead of carrying forever.
        let bytes = b"x\x80";
        assert_eq!(utf8_safe_split(bytes), 2);
    }

    #[cfg(not(windows))]
    #[test]
    fn shell_integration_bodies_emit_osc133() {
        // The init files are opaque strings — assert the load-bearing marks
        // and guards are present so a refactor can't silently drop them.
        let (_, envs) = super::osc7_wiring("/bin/zsh");
        assert!(!envs.is_empty(), "zsh should wire ZDOTDIR");
        let zshrc = std::env::temp_dir()
            .join("shellboard-shell-init")
            .join(".zshrc");
        let body = std::fs::read_to_string(zshrc).unwrap();
        assert!(body.contains("133;A"));
        assert!(body.contains("133;C"));
        assert!(body.contains("133;D"));
        assert!(body.contains("_shellboard_cmd_ran"));
        assert!(body.contains("POWERLEVEL9K_INSTANT_PROMPT=off"));

        let (args, _) = super::osc7_wiring("/bin/bash");
        assert_eq!(args[0], "--rcfile");
        let rc = std::fs::read_to_string(&args[1]).unwrap();
        assert!(rc.contains("133;A") && rc.contains("133;C") && rc.contains("133;D"));
        assert!(rc.contains("trap -p DEBUG"));

        let (args, _) = super::osc7_wiring("/usr/bin/fish");
        let joined = args.join(" ");
        assert!(joined.contains("133;A") && joined.contains("133;D"));
    }
}

/// When shell integration is on, write a shell-specific init file into the
/// OS temp dir and wire it into the spawned shell via the right flag:
///   zsh  → ZDOTDIR  (custom .zshrc that sources user's then adds hooks)
///   bash → --rcfile (sources ~/.bashrc then appends PROMPT_COMMAND + traps)
///   fish → --init-command
///
/// The hooks emit OSC 7 (cwd tracking for session restore) and OSC 133
/// prompt marks (A = prompt, C = command start, D;<code> = command end)
/// that the frontend turns into prompt jumping, the failed-command dot and
/// long-command notifications.
///
/// Returns the list of extra args and any env var overrides the caller must
/// apply on the CommandBuilder.
#[cfg(not(windows))]
fn osc7_wiring(shell_path: &str) -> (Vec<String>, Vec<(String, String)>) {
    let base = shell_basename(shell_path);
    let tmp = std::env::temp_dir().join("shellboard-shell-init");
    // Best-effort; if we can't write the init file we just skip injection.
    if std::fs::create_dir_all(&tmp).is_err() {
        return (Vec::new(), Vec::new());
    }

    match base {
        "zsh" => {
            let zshrc = tmp.join(".zshrc");
            let body = r#"# Shellboard shell integration (OSC 7 cwd + OSC 133 marks)
# powerlevel10k's "instant prompt" paints a provisional prompt at startup
# and repaints the screen ~1 s later when real init finishes — that repaint
# yanks a restored scrollback out of view (session restore / reopen tab).
# Disable the two-phase repaint for shells we spawn; the prompt simply
# appears once init completes.
export POWERLEVEL9K_INSTANT_PROMPT=off
# ZDOTDIR redirects zsh away from $HOME for .z*-style config files, so
# source user's files manually. /etc/zprofile + /etc/zshrc still run
# automatically in login mode (PATH on macOS comes from there).
[ -f "$HOME/.zshenv" ] && ZDOTDIR="$HOME" source "$HOME/.zshenv"
[ -f "$HOME/.zprofile" ] && ZDOTDIR="$HOME" source "$HOME/.zprofile"
[ -f "$HOME/.zshrc" ] && ZDOTDIR="$HOME" source "$HOME/.zshrc"
_shellboard_osc7() { printf '\e]7;file://%s%s\e\\' "${HOST:-$HOSTNAME}" "$PWD" }
typeset -ga chpwd_functions
chpwd_functions+=(_shellboard_osc7)
_shellboard_osc7
# OSC 133: D;<exit> after a command (guarded so the first prompt gets no D),
# A before each prompt, C when a command starts.
_shellboard_osc133_precmd() {
  local code=$?
  if [ -n "${_shellboard_cmd_ran:-}" ]; then
    printf '\e]133;D;%s\e\\' "$code"
  fi
  _shellboard_cmd_ran=""
  printf '\e]133;A\e\\'
}
_shellboard_osc133_preexec() {
  _shellboard_cmd_ran=1
  printf '\e]133;C\e\\'
}
typeset -ga precmd_functions preexec_functions
precmd_functions+=(_shellboard_osc133_precmd)
preexec_functions+=(_shellboard_osc133_preexec)
"#;
            if std::fs::write(&zshrc, body).is_err() {
                return (Vec::new(), Vec::new());
            }
            (
                Vec::new(),
                vec![("ZDOTDIR".into(), tmp.to_string_lossy().to_string())],
            )
        }
        "bash" => {
            let rc = tmp.join("shellboard.bashrc");
            let body = r#"# Shellboard shell integration (OSC 7 cwd + OSC 133 marks)
# --rcfile forces bash into non-login mode, so source the profile files
# manually so PATH additions from ~/.bash_profile still apply.
[ -f "/etc/profile" ] && source "/etc/profile"
if [ -f "$HOME/.bash_profile" ]; then source "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then source "$HOME/.bash_login"
elif [ -f "$HOME/.profile" ]; then source "$HOME/.profile"
fi
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"
_shellboard_osc7() { printf '\e]7;file://%s%s\e\\' "${HOSTNAME}" "$PWD"; }
case "$PROMPT_COMMAND" in
    *_shellboard_osc7*) ;;
    *) PROMPT_COMMAND="_shellboard_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
_shellboard_osc7
# OSC 133 prompt marks. The prompt handler must run FIRST in PROMPT_COMMAND
# so `$?` is still the user command's exit code — prepending it after the
# OSC 7 prepend above puts it at the front.
_shellboard_osc133_prompt() {
  local code=$?
  if [ -n "${_shellboard_cmd_ran:-}" ]; then
    printf '\e]133;D;%s\e\\' "$code"
  fi
  _shellboard_cmd_ran=""
  printf '\e]133;A\e\\'
}
case "$PROMPT_COMMAND" in
    *_shellboard_osc133_prompt*) ;;
    *) PROMPT_COMMAND="_shellboard_osc133_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
# C (command start) via DEBUG trap — best-effort: installed only when the
# user has no DEBUG trap of their own. Skips commands that are part of
# PROMPT_COMMAND itself.
_shellboard_osc133_preexec() {
  [ -n "${_shellboard_cmd_ran:-}" ] && return 0
  case ";$PROMPT_COMMAND;" in
    *";$BASH_COMMAND;"*) return 0 ;;
  esac
  _shellboard_cmd_ran=1
  printf '\e]133;C\e\\'
}
if [ -z "$(trap -p DEBUG)" ]; then
  trap '_shellboard_osc133_preexec' DEBUG
fi
"#;
            if std::fs::write(&rc, body).is_err() {
                return (Vec::new(), Vec::new());
            }
            (
                vec!["--rcfile".into(), rc.to_string_lossy().to_string()],
                Vec::new(),
            )
        }
        "fish" => {
            // Fish: OSC 7 + OSC 133 via --init-command (repeatable flag).
            // fish_postexec fires only after a real command, so D needs no
            // first-prompt guard.
            let osc7 = "function _shellboard_osc7 --on-variable PWD; printf '\\e]7;file://%s%s\\e\\\\' $hostname $PWD; end; _shellboard_osc7";
            let osc133 = "function _shellboard_osc133_prompt --on-event fish_prompt; printf '\\e]133;A\\e\\\\'; end; function _shellboard_osc133_preexec --on-event fish_preexec; printf '\\e]133;C\\e\\\\'; end; function _shellboard_osc133_postexec --on-event fish_postexec; printf '\\e]133;D;%s\\e\\\\' $status; end";
            (
                vec![
                    "--init-command".into(),
                    osc7.into(),
                    "--init-command".into(),
                    osc133.into(),
                ],
                Vec::new(),
            )
        }
        "nu" | "nushell" => {
            // Nushell: write a custom env script that (a) sources the
            // user's env.nu if present, (b) installs a PWD env_change hook
            // emitting OSC 7. Loaded via --env-config which REPLACES the
            // default env config — so sourcing the user's env.nu is how we
            // preserve their customizations.
            //
            // Syntax targets nushell 0.90+; older versions may reject the
            // string interpolation or upsert pattern. Best-effort.
            let env_file = tmp.join("shellboard-env.nu");
            let body = r#"# Shellboard OSC 7 tracking for nushell.
# We loaded via --env-config, so source the user's env.nu manually first.
let user_env = ("~/.config/nushell/env.nu" | path expand)
if ($user_env | path exists) { source $user_env }

# Install OSC 7 hook on PWD change. Replaces any existing PWD hooks.
$env.config = ($env.config? | default {})
$env.config.hooks = ($env.config.hooks? | default {})
$env.config.hooks.env_change = ($env.config.hooks.env_change? | default {})
$env.config.hooks.env_change.PWD = [
    {|before, after|
        let host = (try { hostname | str trim } catch { "" })
        print -n $"(char esc)]7;file://($host)($after)(char esc)\\"
    }
]

# OSC 133 marks — same best-effort caveat as above (syntax targets 0.90+).
$env.config.hooks.pre_prompt = ($env.config.hooks.pre_prompt? | default []) ++ [{||
    if ($env.SHELLBOARD_CMD_RAN? | default "") == "1" {
        print -n $"(char esc)]133;D;($env.LAST_EXIT_CODE)(char esc)\\"
    }
    $env.SHELLBOARD_CMD_RAN = "0"
    print -n $"(char esc)]133;A(char esc)\\"
}]
$env.config.hooks.pre_execution = ($env.config.hooks.pre_execution? | default []) ++ [{||
    $env.SHELLBOARD_CMD_RAN = "1"
    print -n $"(char esc)]133;C(char esc)\\"
}]
"#;
            if std::fs::write(&env_file, body).is_err() {
                return (Vec::new(), Vec::new());
            }
            (
                vec![
                    "--env-config".into(),
                    env_file.to_string_lossy().to_string(),
                ],
                Vec::new(),
            )
        }
        _ => (Vec::new(), Vec::new()),
    }
}

fn default_shell(
    cwd: Option<String>,
    auto_cwd_tracking: bool,
    shell_override: Option<String>,
    shell_args: Option<Vec<String>>,
) -> CommandBuilder {
    #[cfg(windows)]
    let mut cmd = {
        let _ = auto_cwd_tracking; // not supported on Windows for now
        let _ = &shell_args;
        let exe = if let Some(p) = shell_override.as_ref().filter(|s| !s.trim().is_empty()) {
            p.clone()
        } else {
            ["pwsh.exe", "powershell.exe", "cmd.exe"]
                .into_iter()
                .find(|c| which::which(c).is_ok())
                .unwrap_or("cmd.exe")
                .to_string()
        };
        let mut c = CommandBuilder::new(exe);
        if let Some(args) = &shell_args {
            for a in args {
                c.arg(a);
            }
        }
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let shell = shell_override
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
            });
        let mut c = CommandBuilder::new(&shell);

        // If the user provided explicit shell args, they own argv entirely
        // (we don't auto-add `-l`). Otherwise default to login mode for
        // known POSIX shells so ~/.zprofile / .bash_profile / fish config
        // get sourced and PATH reflects the user's real environment.
        if let Some(args) = &shell_args {
            for a in args {
                c.arg(a);
            }
        } else {
            let base = shell_basename(&shell);
            // Login shell unless it would conflict with OSC 7 injection:
            // bash in login mode ignores `--rcfile`, so the OSC 7 hook
            // wouldn't load. The bash rc file sources the profile itself.
            let use_login = match base {
                "bash" => !auto_cwd_tracking,
                "zsh" | "sh" | "fish" | "dash" | "ksh" => true,
                _ => false,
            };
            if use_login {
                c.arg("-l");
            }
        }

        if auto_cwd_tracking {
            let (args, envs) = osc7_wiring(&shell);
            for a in args {
                c.arg(a);
            }
            for (k, v) in envs {
                c.env(k, v);
            }
        }
        c
    };

    // TERM / COLORTERM are not set when the app is launched from Finder or
    // a Linux app menu — unlike when launched from an existing terminal.
    // Without TERM, the shell can't load proper terminfo and readline
    // breaks in subtle ways (backspace echo, arrow keys, colors).
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Shellboard");
    if let Some(v) = option_env!("CARGO_PKG_VERSION") {
        cmd.env("TERM_PROGRAM_VERSION", v);
    }

    let resolved_cwd = cwd.or_else(default_home);
    if let Some(dir) = resolved_cwd {
        cmd.cwd(dir);
    }
    cmd
}

#[tauri::command]
pub fn home_dir() -> String {
    default_home().unwrap_or_else(|| "/".to_string())
}

/// Build a `git -C <path>` command with stdin closed so git can never block
/// waiting for input, and — on Windows — the `CREATE_NO_WINDOW` flag so a
/// console window doesn't flash each time git runs under our GUI-subsystem
/// process. Always run the resulting command on a blocking thread, never the
/// Tauri main thread (a slow/hung git would otherwise freeze the whole UI).
fn git_command(path: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(path).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // winbase.h CREATE_NO_WINDOW — suppress the console window Windows
        // would otherwise allocate for git.exe (a console subsystem binary)
        // when spawned from our windowed process.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn git_branch_blocking(path: &str) -> Option<String> {
    let out = git_command(path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() { None } else { Some(name) }
}

/// Return the current git branch name for a directory, or None if the
/// directory isn't a git repo / git isn't installed. The `git` invocation runs
/// on a blocking thread (via `spawn_blocking`) so it never stalls the main
/// thread's event loop, even if git is slow to start or hangs.
#[tauri::command]
pub async fn git_branch(path: String) -> Option<String> {
    tokio::task::spawn_blocking(move || git_branch_blocking(&path))
        .await
        .ok()
        .flatten()
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub modified: u32,
    pub untracked: u32,
    pub conflicts: u32,
}

/// Parse `git status --porcelain=v2 --branch` output into a GitStatus.
/// Porcelain v2 is designed for machine consumption — the format is stable
/// across git versions. See `git help status` "--porcelain=v2" section.
fn parse_status_v2(text: &str) -> GitStatus {
    let mut s = GitStatus::default();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            let rest = rest.trim();
            if rest != "(detached)" {
                s.branch = Some(rest.to_string());
            } else {
                s.branch = Some("(detached)".to_string());
            }
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // e.g. "+2 -1"
            let mut parts = rest.split_whitespace();
            if let Some(a) = parts.next() {
                s.ahead = a.trim_start_matches('+').parse().unwrap_or(0);
            }
            if let Some(b) = parts.next() {
                s.behind = b.trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // Tracked changes. Char layout: "1 XY ...". X = staged status,
            // Y = unstaged status. '.' means unchanged in that column.
            let xy: Vec<char> = line.chars().skip(2).take(2).collect();
            if xy.len() == 2 {
                if xy[0] != '.' {
                    s.staged += 1;
                }
                if xy[1] != '.' {
                    s.modified += 1;
                }
            }
        } else if line.starts_with("u ") {
            s.conflicts += 1;
        } else if line.starts_with("? ") {
            s.untracked += 1;
        }
    }
    s
}

fn git_status_blocking(path: &str) -> Option<GitStatus> {
    let out = git_command(path)
        .args(["status", "--porcelain=v2", "--branch"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Some(parse_status_v2(&text))
}

/// Full status for a directory: branch, dirty counts, ahead/behind vs upstream.
/// Returns None if the path isn't a git repo. Runs the `git` invocation on a
/// blocking thread so a slow/hung git never freezes the main thread — this is
/// polled every 5 s from the frontend and fires immediately when a project's
/// terminal cwd is first set.
#[tauri::command]
pub async fn git_status(path: String) -> Option<GitStatus> {
    tokio::task::spawn_blocking(move || git_status_blocking(&path))
        .await
        .ok()
        .flatten()
}

#[tauri::command]
pub async fn spawn_pty(
    app: AppHandle,
    state: State<'_, PtyManager>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    auto_cwd_tracking: Option<bool>,
    shell_path: Option<String>,
    shell_args: Option<Vec<String>>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let cmd = default_shell(
        cwd,
        auto_cwd_tracking.unwrap_or(false),
        shell_path,
        shell_args,
    );
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn_command failed: {e}"))?;
    // Snapshot the shell pid now, before `child` is moved into the session
    // mutex — the running-apps detector walks descendants of this pid.
    let shell_pid = child.process_id();

    // Drop the slave so the child is the only holder of the slave fd;
    // otherwise the reader won't see EOF when the child exits.
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader failed: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let data_event = format!("pty://{id}/data");
    let exit_event = format!("pty://{id}/exit");

    let session = PtySession {
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(pair.master)),
        child: Arc::new(Mutex::new(child)),
        shell_pid,
    };

    state
        .sessions
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?
        .insert(id.clone(), session);

    // Reader is blocking I/O — run on a dedicated blocking task. It forwards
    // raw bytes to an async emitter task that coalesces bursts into fewer,
    // larger `data` events: under heavy output (builds, `cat` of a big file)
    // one event per 8 KB read floods the IPC bridge with per-event JSON
    // serialization the frontend can't keep up with.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();

    let app_for_emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        // Cap a coalesced batch so a single event payload stays bounded.
        const MAX_BATCH: usize = 64 * 1024;
        // Carries 0–3 trailing bytes that look like the start of an
        // incomplete multi-byte UTF-8 sequence, so we don't decode a
        // chunk-boundary split as replacement chars. e.g. `❯` is E2 9D AF
        // and a read that ends mid-glyph would otherwise emit `��`.
        let mut pending: Vec<u8> = Vec::new();
        while let Some(chunk) = rx.recv().await {
            pending.extend_from_slice(&chunk);
            // Drain whatever the reader already queued. Batching kicks in
            // exactly when output outpaces emission; an interactive keystroke
            // echo (empty queue) is emitted with zero added latency.
            while pending.len() < MAX_BATCH {
                match rx.try_recv() {
                    Ok(next) => pending.extend_from_slice(&next),
                    Err(_) => break,
                }
            }
            let split = utf8_safe_split(&pending);
            if split == 0 {
                continue; // only an incomplete sequence so far — wait for more
            }
            let tail = pending.split_off(split);
            let data = String::from_utf8_lossy(&pending).to_string();
            pending = tail;
            if app_for_emitter
                .emit(&data_event, PtyDataPayload { data })
                .is_err()
            {
                // Webview is gone. Dropping rx makes the reader's send fail,
                // which stops the read loop and reaps the session.
                return;
            }
        }
        // Channel closed — the reader hit EOF. Flush whatever's still
        // buffered (an incomplete sequence will never complete now, so let
        // lossy substitute replacement chars), then notify the frontend that
        // this PTY has ended so it can remove the panel.
        if !pending.is_empty() {
            let data = String::from_utf8_lossy(&pending).to_string();
            let _ = app_for_emitter.emit(&data_event, PtyDataPayload { data });
        }
        let _ = app_for_emitter.emit(&exit_event, ());
    });

    let app_for_reader = app.clone();
    let id_for_reader = id.clone();
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF, child exited
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break; // emitter gone (webview closed)
                    }
                }
                Err(_) => break,
            }
        }
        // Close the channel so the emitter flushes and emits the exit event.
        drop(tx);
        // Reap the session ourselves instead of relying on the frontend's
        // kill_pty round-trip — if the exit event is missed (webview gone,
        // listener already torn down) the session would otherwise leak its
        // PTY slot forever. kill_pty on the removed id stays a no-op Ok.
        // We're on a blocking thread, so dropping (kill + wait) here is fine.
        // try_state: during process teardown managed state may already be
        // gone, and state() would panic this task.
        let session = app_for_reader.try_state::<PtyManager>().and_then(|state| {
            state
                .sessions
                .lock()
                .ok()
                .and_then(|mut sessions| sessions.remove(&id_for_reader))
        });
        drop(session);
    });

    Ok(id)
}

#[tauri::command]
pub async fn write_to_pty(
    state: State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    let writer = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;
        let session = sessions.get(&id).ok_or_else(|| format!("no session {id}"))?;
        session.writer.clone()
    };
    // A PTY write blocks when the kernel buffer is full and the child isn't
    // draining it (e.g. a stopped process). Run it off the async workers so a
    // few stuck writes can't starve every other command.
    tokio::task::spawn_blocking(move || {
        let mut writer = writer.lock().map_err(|e| format!("lock poisoned: {e}"))?;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("write failed: {e}"))?;
        writer.flush().map_err(|e| format!("flush failed: {e}"))
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

#[tauri::command]
pub async fn resize_pty(
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let master = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;
        let session = sessions.get(&id).ok_or_else(|| format!("no session {id}"))?;
        session.master.clone()
    };
    let master = master.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn kill_pty(state: State<'_, PtyManager>, id: String) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?
        .remove(&id);
    if let Some(session) = session {
        // Drop kills + waits (reaps) the child — blocking process teardown,
        // so keep it off the async worker pool.
        tokio::task::spawn_blocking(move || drop(session))
            .await
            .map_err(|e| format!("join failed: {e}"))?;
    }
    Ok(())
}

/// A non-shell process running inside a terminal, surfaced by `running_apps_snapshot`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningApp {
    /// pid of the chosen descendant process.
    pub pid: u32,
    /// Short executable name, e.g. "node", "vim", "python3".
    pub name: String,
    /// Best-effort full command line (argv joined), trimmed. Falls back to the
    /// name when the kernel doesn't expose argv.
    pub command: String,
    /// Resident set size (RSS) in bytes of the chosen process plus all of its
    /// descendants. Approximate — summing RSS double-counts shared pages.
    pub memory_bytes: u64,
}

/// Whether `name` is one of the shells we spawn / nest. Used to skip the shell
/// itself (and intermediate wrapper shells) when deciding what's "running".
fn is_shell_name(name: &str) -> bool {
    // Login shells may report argv[0] as "-zsh".
    let n = name.strip_prefix('-').unwrap_or(name);
    matches!(
        shell_basename(n),
        "zsh" | "bash" | "sh" | "dash" | "fish" | "ksh" | "nu" | "nushell" | "tcsh" | "csh"
            | "cmd" | "cmd.exe" | "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe"
    )
}

/// Walk the descendants of `shell_pid` and pick the process that best represents
/// "what's running" in that terminal: the shallowest non-shell descendant (the
/// command the user typed; deeper processes are its workers), breaking ties by
/// lowest pid for determinism. Returns None when the shell is idle (only shells
/// below it). Keeps descending through intermediate shells so that, e.g.,
/// `npm` spawning `sh -c "node ..."` still surfaces `node`.
fn pick_running_app(
    shell_pid: Pid,
    sys: &System,
    children: &HashMap<Pid, Vec<Pid>>,
) -> Option<RunningApp> {
    let mut best: Option<(u32, Pid)> = None; // (depth, pid)
    let mut queue: std::collections::VecDeque<(Pid, u32)> = std::collections::VecDeque::new();
    if let Some(kids) = children.get(&shell_pid) {
        for &k in kids {
            queue.push_back((k, 1));
        }
    }
    while let Some((pid, depth)) = queue.pop_front() {
        if let Some(proc_) = sys.process(pid) {
            let name = proc_.name().to_string_lossy();
            if !is_shell_name(&name) {
                let replace = match best {
                    None => true,
                    // Prefer shallower; at equal depth prefer the lower pid.
                    Some((bd, bp)) => depth < bd || (depth == bd && pid < bp),
                };
                if replace {
                    best = Some((depth, pid));
                }
            }
            if let Some(kids) = children.get(&pid) {
                for &k in kids {
                    queue.push_back((k, depth + 1));
                }
            }
        }
    }

    let (_, chosen) = best?;
    let proc_ = sys.process(chosen)?;
    let name = shell_basename(&proc_.name().to_string_lossy()).to_string();
    let command = proc_
        .cmd()
        .iter()
        .map(|s| s.to_string_lossy().into_owned())
        .collect::<Vec<String>>()
        .join(" ")
        .trim()
        .to_string();
    // Sum RSS of the chosen process plus all of its descendants, so a command
    // that spawns workers (a dev server, npm -> node, etc.) reports its full
    // footprint rather than just the parent.
    let memory_bytes = subtree_memory(chosen, sys, children);
    Some(RunningApp {
        pid: chosen.as_u32(),
        command: if command.is_empty() {
            name.clone()
        } else {
            command
        },
        name,
        memory_bytes,
    })
}

/// Sum the resident memory (bytes) of `root` and every descendant, using the
/// pre-built pid -> children map. RSS double-counts shared pages, so this is an
/// upper-bound approximation — fine for spotting heavy terminals.
fn subtree_memory(root: Pid, sys: &System, children: &HashMap<Pid, Vec<Pid>>) -> u64 {
    let mut total: u64 = 0;
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if let Some(p) = sys.process(pid) {
            total += p.memory();
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    total
}

/// Shellboard's own memory footprint, distinct from the apps running inside
/// terminals (which `apps` reports).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfMemory {
    /// Best-effort RSS in bytes of the Shellboard process tree (the main process
    /// plus WebKit/helper descendants) with the terminal subtrees subtracted, so
    /// it reflects the app itself and not the programs the user runs in terminals.
    pub app_rss_bytes: u64,
    /// Number of live PTY sessions (terminals) currently open.
    pub terminal_count: usize,
}

/// Everything the Running-apps modal polls: the per-terminal app (with RSS) plus
/// Shellboard's own footprint — both derived from one process-table snapshot.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningAppsSnapshot {
    /// Non-shell app per session id (== mosaic leaf id). Idle shells are omitted.
    pub apps: HashMap<String, RunningApp>,
    pub self_memory: SelfMemory,
}

/// Single snapshot serving the Running-apps modal: the app running in each
/// terminal (with its subtree RSS) and Shellboard's own memory + terminal count.
/// Takes ONE process-table refresh regardless of terminal count. Polled from the
/// frontend (~2s) only while the modal is open.
///
/// `self_memory.app_rss_bytes` = RSS of the main process subtree minus every
/// tracked terminal-shell subtree. On macOS the WebView (where the xterm
/// scrollback buffers live) runs out-of-process; this captures it only if that
/// helper is a descendant of the main process, so treat the number as approximate.
#[tauri::command]
pub async fn running_apps_snapshot(
    state: State<'_, PtyManager>,
) -> Result<RunningAppsSnapshot, String> {
    // Copy out (sessionId, shell_pid) and the count, then release the lock.
    let (shell_pids, terminal_count): (Vec<(String, u32)>, usize) = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;
        (
            sessions
                .iter()
                .filter_map(|(id, s)| s.shell_pid.map(|p| (id.clone(), p)))
                .collect(),
            sessions.len(),
        )
    };

    // The full process-table refresh takes tens of ms on a busy machine —
    // run it on a blocking thread so the ~2 s poll never stalls the async
    // workers (or, as before this was async, the main thread / UI).
    tokio::task::spawn_blocking(move || {
        let main_pid = sysinfo::get_current_pid().map_err(|e| format!("current pid: {e}"))?;

        // One snapshot: process name + parent pid (always populated) + cmdline + RSS.
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_cmd(UpdateKind::Always)
                .with_memory(),
        );

        // Build pid -> children once from the snapshot.
        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, proc_) in sys.processes() {
            if let Some(parent) = proc_.parent() {
                children.entry(parent).or_default().push(*pid);
            }
        }

        // Per-terminal apps.
        let mut apps = HashMap::new();
        for (session_id, shell_pid) in &shell_pids {
            if let Some(app) = pick_running_app(Pid::from_u32(*shell_pid), &sys, &children) {
                apps.insert(session_id.clone(), app);
            }
        }

        // Shellboard's own footprint: main subtree minus the terminal subtrees.
        let main_total = subtree_memory(main_pid, &sys, &children);
        let terminals_total: u64 = shell_pids
            .iter()
            .map(|(_, p)| subtree_memory(Pid::from_u32(*p), &sys, &children))
            .sum();

        Ok(RunningAppsSnapshot {
            apps,
            self_memory: SelfMemory {
                app_rss_bytes: main_total.saturating_sub(terminals_total),
                terminal_count,
            },
        })
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}
