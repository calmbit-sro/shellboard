use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

pub struct PtySession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
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

/// When auto cwd tracking is on, write a shell-specific init file into the
/// OS temp dir and wire it into the spawned shell via the right flag:
///   zsh  → ZDOTDIR  (custom .zshrc that sources user's then adds chpwd hook)
///   bash → --rcfile (sources ~/.bashrc then appends PROMPT_COMMAND)
///   fish → --init-command
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
            let body = r#"# Shellboard OSC 7 tracking
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
            let body = r#"# Shellboard OSC 7 tracking
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
            // Fish: one-liner via --init-command.
            let cmd = "function _shellboard_osc7 --on-variable PWD; printf '\\e]7;file://%s%s\\e\\\\' $hostname $PWD; end; _shellboard_osc7";
            (
                vec!["--init-command".into(), cmd.into()],
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

/// Return the current git branch name for a directory, or None if the
/// directory isn't a git repo / git isn't installed. Runs `git rev-parse`
/// which finishes in a few ms.
#[tauri::command]
pub fn git_branch(path: String) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() { None } else { Some(name) }
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

/// Full status for a directory: branch, dirty counts, ahead/behind vs upstream.
/// Returns None if the path isn't a git repo.
#[tauri::command]
pub fn git_status(path: String) -> Option<GitStatus> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["status", "--porcelain=v2", "--branch"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Some(parse_status_v2(&text))
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
    };

    state
        .sessions
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?
        .insert(id.clone(), session);

    // Reader is blocking I/O — run on a dedicated blocking task.
    let app_for_reader = app.clone();
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF, child exited
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if app_for_reader
                        .emit(&data_event, PtyDataPayload { data })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // Notify the frontend that this PTY has ended so it can remove the
        // panel. Session cleanup on the Rust side still happens via kill_pty
        // when the frontend reacts.
        let _ = app_for_reader.emit(&exit_event, ());
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
    let mut writer = writer.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    writer.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
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
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}
