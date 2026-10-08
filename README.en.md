English | [简体中文](README.md)

# Tide

Persistent interactive shells shared by humans and Agents: sessions are created in the background by default, an Agent can send input and read the screen, and a human can open a terminal with `attach` when they want to look. Claude Code / Codex are ordinary programs running inside the shell; a Session ID identifies a session, not a window.

> The documents linked under `docs/` are currently written in Chinese only.

## Platform support

Windows (via Git Bash) and macOS are supported, with Node 20+. CI runs on those two systems only.

- `attach` and `launch --attach` are implemented on Windows and macOS only. Other platforms get an explicit error, never a silent downgrade.
- Linux and other platforms are unverified. `node-pty` ships prebuilt binaries for win32 and darwin only; on Linux installation falls back to a `node-gyp` source build, which may or may not succeed depending on your build environment.
- Terminal behaviour has only been verified on Windows Terminal; other terminals are not guaranteed to work.

## Quick start

From npm (Node 20+):

```bash
npm install -g @arkkwang/tide
```

From source:

```bash
git clone https://github.com/arkkwang/tide.git
cd tide
npm install
npm run link:local   # build, then register the global tide command
```

Then create a session:

```bash
# Create a background session, run echo hello, wait and return the ID and screen
tide launch --with-command "echo hello" --wait-idle --with-read
```

`npm run link:local` builds first and then refreshes the global npm entry point. For ordinary code changes `npm run build` is enough; after changing `bin` in `package.json` you must link again, because `build` does not regenerate the launcher npm created. This matters when upgrading from the older `dist/tide.mjs` entry point, and it is what enables the Git Bash text protection. `npm pack` builds automatically; the package contains only the entry point, build output, examples and docs — never local session data.

`launch` creates no window and requests no input focus by default. `launch --attach` opens a viewer for the session it just created — a Windows Terminal tab (Windows) or a Terminal window (macOS). That is not the current terminal, and the OS is not guaranteed to grant it foreground focus. `tide attach <id>` opens a Windows Terminal tab (Windows) or Terminal window (macOS) that connects to the existing shell and the program already running in it, without re-running the command. On Windows it uses `wt -w 0`, creating a tab in the most recently used window on the current virtual desktop, or a new window when there is none. It reuses the caller's `WT_PROFILE_ID` and otherwise falls back to the user's default profile. A successful `attach` means the viewer connected; it does not mean the OS granted keyboard focus.

At most one viewer per session: while one is opening or attached, a repeated `attach` is rejected outright — Tide does not look for or activate an old tab. Closing the tab only disconnects the viewer, the task keeps running, and `attach` again resumes watching. Only `close` or shell exit ends the session. Without a viewer the size is 100×30; once attached it follows the viewer's size, and it keeps the last size after a disconnect. Background host errors are logged to `TIDE_STATE_DIR/session-logs/<id>.log` — that is not command output.

The bash prompt inside a session is prefixed with a `T<short id>` marker (for example `T3c3375b9`) so Tide-managed shells can be told apart from terminals you opened yourself. The marker has no colour and is inserted on the same line, in front of the original prompt, without altering it. It is injected through `PROMPT_COMMAND`, so startup files that rewrite PS1 (such as Git Bash's `git-prompt.sh`) do not overwrite it, and your `.bashrc` needs no changes. Other shells have no equivalent environment hook and keep their own prompt.

Once the returned `read` confirms the shell prompt is ready, keep using the `id` returned by that same call:

```bash
tide send 5fefa 'echo world' --with-enter --wait-idle --with-read
# A long task is still running: wait again, do not resend
tide wait-idle 5fefa --timeout 300 --with-read
# Once the whole session is definitely no longer needed
tide close 5fefa
```

Replace `5fefa` with the actual ID prefix returned by `launch` or `tide list`. Every command that takes a Session ID accepts an unambiguous prefix, with an exact full-ID match taking priority; multiple candidates are listed and the command is rejected. When reusing an existing session, run `tide list` first, then `tide read <id>` to confirm the current prompt. If you already hold a fresh combined `read`, decide the next step from it — there is no need to grab the screen again.

`tide run` creates a background session and attaches the current terminal to it without opening another window; closing that terminal likewise only disconnects the viewer. When a startup file needs interaction, or you must inspect the boot screen first, use `tide launch` with no command and then `tide wait-idle <id> --with-read`.

Common paths (always confirm the current screen before sending input):

| Situation | Action |
| --- | --- |
| Create a background session running a known command | `tide launch --with-command "echo hello" --wait-idle --with-read` — Enter is sent automatically |
| Submit content and read the response | `tide send <id> 'text' --with-enter --wait-idle --with-read` |
| Type content only, leaving it for a human to inspect | `tide send <id> 'text' --with-read` |
| Answer a menu or permission prompt | `tide send <id> --key Enter --wait-idle --with-read`, choosing the right key for the prompt shown |
| A long task is still running | `tide wait-idle <id> --timeout 60 --with-read` — do not resend the task; raise `--timeout` (e.g. 300 s, max 3600 s) for long runs to avoid repeated waits |
| Occasionally look at output around the screen | `tide wait-idle <id> --with-read --lines 100` |
| Interrupt a foreground task and read the result | `tide send <id> --key Ctrl+C --wait-idle --with-read` |
| Open the original session for a human | `tide attach <id>`; a repeated attach is rejected |
| Just look at the current screen | `tide read <id>`; add `--plain-text` for plain text |
| End the whole managed session | `tide close <id>` |

`read` and the combined `--with-read` select only the current/latest command: the first 10 and last 30 lines by default, or the whole region when it is 40 lines or fewer. `--full` returns the entire retained region, `--lines N` returns the last N lines, and the two are mutually exclusive. Without command markers, or in a TUI, the whole current screen is returned by default. Every read strips the cursor and the useless blank lines below the last content, keeping interior blank lines and original spacing. Internal plugin capture and idle detection are unaffected.

`--with-command` takes one quoted single-line command. Tide first waits for the boot screen to stay unchanged for 3 consecutive seconds (30 s at most), then sends the text and, 150 ms later, Enter. The accompanying `--wait-idle`, `--idle-time`, `--timeout`, `--with-read` and `--lines` reuse `send` semantics and apply after the command is submitted; put all options before `-- shell-args...`. A quiet screen does not prove the prompt is ready — when a startup file needs interaction, still check step by step. If the boot wait times out the command is not sent: session info plus an `error` are returned with exit code 1, and later failures still keep the session ID. On success the session fields are returned together with `written`, `enterWritten` and the requested `wait` / `read`. With `--attach`, the viewer opens after Enter and before `--wait-idle`/`--with-read`; success additionally returns `attached: true` and `display: "attached"`. If attach fails, the result carries `error.stage: "attach"` with exit code 1: the session is not closed, the already-sent command is not resent, the remaining wait/read steps are skipped, and you retry with `tide attach <id>`.

A `launch` without `--with-command` only reports that the session is registered; follow it with `wait-idle <id> --with-read` to inspect the boot screen. `launch --attach` opens the viewer immediately after creating the session. An idle timeout (exit code 3) does not stop the target — read the returned screen, then decide whether to keep waiting, answer a prompt, or end the task. Use `close` only to end the whole shell.

**Grabbing long output repeatedly, or scrolling back through history, usually means the wrong tool is being used.** Tide is for collaborating with a visible interactive terminal: checking the current screen and handling input prompts. For build logs, test results, bulk command output and the like, prefer a Bash / Shell execution tool or another suitable tool — redirect to a file, then read it on demand, or search it with grep / rg. For example, run `your-command > output.log 2>&1` in Bash and then `rg -n 'error|failed' output.log`. Use `tee` when you also want to watch it in the terminal. `--lines` and `scroll` exist for the occasional look at surrounding context or for driving a TUI; supporting them is not a recommendation to turn repeated screen grabs and scrolling into a log-analysis workflow.

`list` and `info` return `lastCommand`: the most recent shell command recognized as having started executing (for example `"claude --resume"`). It is kept after the command finishes and updated when the next one starts; unsubmitted input, program output and TUI chat do not update it. It reuses the Bash 4.4+ prompt-end / execution boundary and extracts the command from the terminal echo — it does not scan history and does not store anything extra on disk. Screen wrapping of single-line commands is supported; multiline input, an unrecognized shell, or a lost input boundary yields `null`. Clearing the screen or resizing the window does not delete a recorded command, but may affect the next recognition. It is neither the current process name nor a trustworthy execution audit, and sensitive arguments in the command may be visible. Older hosts lack this field — open a new session.

`list` and `info` also return live activity: `idleForMs` is how long the current screen has stayed unchanged, in milliseconds; `lastOutputAt` is the UTC ISO time of the last PTY output received, or `null` before any output. Text, size or activity-buffer changes reset idle; repeated repainting, colours, title and cursor changes do not, although any non-empty output updates `lastOutputAt`. With no output at all, idle starts counting when the screen is initialized; queries and screen grabs do not reset it. Use `list` to find long-quiet sessions and then grab their screens; these fields do not mean the task finished, failed, or needs attention. Older hosts may lack both fields — they appear after opening a new session.

Git Bash should use the `bin/tide` entry point. Before Node starts it disables MSYS path conversion for text and plugin arguments, so `/help` is not rewritten to `D:/.../Git/help`; quoting alone cannot prevent that conversion. PowerShell can call `node dist/tide.mjs ...` directly. When calling Node directly from Git Bash, text commands need `MSYS2_ARG_CONV_EXCL='*' node dist/tide.mjs send ...`.

The package `bin` also points at that shell entry point; the npm-installed Windows command requires Git Bash on `PATH`. Before installing globally, `bash bin/tide ...` works as-is.

`tide close --all` needs no IDs and asks for no confirmation. It only handles the sessions registered in the current state directory at the moment of the call: it does not touch other `TIDE_STATE_DIR`s and does not include sessions created afterwards. It returns one JSON result per session: `closing: true` means the close was accepted (not that host cleanup has finished), `stale: true` means the endpoint no longer exists and the dead record was removed, and `error` means that item failed or its outcome is uncertain. One failure does not block the others; the exit code is 1 when any failed, and `[]` with exit code 0 when there are no sessions. `--all` cannot be combined with an ID or any other argument.

## Commands

Commands carry their own complete help, so an Agent need not read this README first: `tide --help` shows capabilities and workflow, and `tide help send` or `tide send --help` shows arguments, output, examples and failure handling. `--help` must follow the command and be used alone; `tide send <id> '--help'` still sends the literal text. Plugins are discovered with `tide plugin list`, and a plugin's own commands with `tide <plugin-id> --help`; command descriptions should state their arguments, behaviour and return value.

| Command | Behaviour |
| --- | --- |
| `run [--shell executable] [--cwd directory] [-- shell-args...]` | Create a background session and attach the current terminal |
| `launch [--shell executable] [--cwd directory] [--with-command text \| --profile label] [--attach] [--wait-idle] [--with-read] [-- shell-args... \| -- <bin-args...>]` | Create a background session (no window by default) with a `T<short id>` bash prompt; can send a command and Enter, open a viewer, then wait for and return the screen |
| `attach <id>` | Open a terminal that connects to the existing session; closing it does not end the session |
| `profiles` | List the label, description and env key count of each `.tide/launch-profiles.json` entry |
| `list` | List the shell sessions managed on this machine plus each `lastCommand`; does not scan CLI history |
| `info <id>` | Return process information such as Tide ID, PID, shell and directory |
| `send <id> <text>` | Write text; `--with-enter` sends Enter after the text |
| `send <id> --stdin` | Read verbatim UTF-8 from a pipe, suited to long and multiline text |
| `send <id> --key <key> [keys...]` | Send named keys or key combinations in order |
| `scroll <id> up\|down [--steps N]` | Send wheel events to a TUI that supports mouse input |
| `resize <id> --cols N --rows N` | Resize the PTY directly when detached, or ask the outer window to resize when attached |
| `read <id> [--lines N] [--full] [--plain-text]` | Fetch the parsed terminal screen |
| `wait-idle <id> [--idle-time seconds] [--timeout seconds] [--with-read]` | Wait for the screen to stop changing, or until timeout, optionally returning the screen |
| `close <id>` / `close --all` | End one session, or every session under the current `TIDE_STATE_DIR`, including running tasks; this is not a CLI turn interrupt |
| `plugin list` | List the plugins Tide knows about and whether they are enabled, without touching any session |
| `plugin enable <name\|path>` / `plugin disable <name\|path>` | Rewrite the plugin list in `.tide/plugins.json`; only affects sessions started afterwards |
| `plugin status <id>` | Show that session's plugin matches, commands and plugin errors |
| `<plugin-id> <command> <id> [args...]` | Invoke a plugin's own command, for example `ccr status <id>`; an `all` command accepts `--all` in place of the id and returns one result per matching session |

Output is JSON by default. `read --plain-text` prints only the snapshot text, preserving spaces, newlines and omission notices, with no JSON and no colour escapes; if the output region is narrower than the original window, the outer terminal may still wrap it.

`send` handles text and keys uniformly: literal text with no Enter by default, and `--key` to select key mode explicitly. Keys are separated by spaces and `+` denotes a combination; the mode is never guessed from the content.

```bash
tide send 5fefa Enter       # type the word Enter
tide send 5fefa --key Enter # press Enter
tide send 5fefa q --wait-idle --with-read # when the current pager exits on q
```

Key examples:

```bash
tide send 5fefa --key Ctrl+U
tide send 5fefa --key Ctrl+C
tide send 5fefa --key Up Enter # Up first, then Enter, with no wait in between
tide send 5fefa --key Ctrl+Left
tide send 5fefa --key Ctrl+Shift+Left
tide send 5fefa --key Shift+Tab
tide send 5fefa --key Alt+b
```

Enter/Escape/Tab/Backspace/Space, the arrow keys, Home/End, Insert/Delete, PageUp/PageDown and F1–F12 are supported, along with Ctrl/Alt/Shift combinations that can be encoded unambiguously. Ctrl+letter maps to a control character and Alt+letter is encoded literally with its case preserved; navigation keys use xterm modifier sequences. Keys that depend on extra protocols or desktop behaviour — Shift+Enter, Ctrl+Enter, Win — are reported as errors rather than guessed or silently downgraded. Each call accepts 1..64 keys and validates all of them before delivering any; split calls when you need to observe the screen in between. `--key` is not mixed with text, `--stdin` or `--with-enter`; to get a newline, put Enter in the key sequence. Plain characters such as `q` are sent in text mode. Mixed modes, invalid keys or bad options are rejected as a whole before anything is written — the first half is never executed.

`written: true` only means the input was written to the PTY; it does not confirm that the CLI submitted, executed or completed anything. A disconnected or timed-out request may still have been delivered, and Tide does not resend. Manual user input and Agent input can interleave, so the caller should look at the screen before acting; the core does not decide whether an input box or permission dialog is currently focused.

Both `send` modes accept `--wait-idle` and `--with-read` after the text or keys, alone or combined:

```bash
tide send 5fefa '/help' --with-enter --wait-idle --with-read
tide send 5fefa --key Enter --wait-idle --idle-time 3 --timeout 60 --with-read
```

The order of execution is send, optional wait, optional screen read; the JSON keeps `id` and `written` and adds `wait` (the wait result) and `read` (the terminal read result) according to the options. `--idle-time` and `--timeout` must be used together with `--wait-idle` and have the same defaults as the standalone wait command. A wait timeout still performs the requested read, with exit code 3. Adding only `--with-read` reads the screen immediately, possibly before the program has responded. `send` does not submit by default; with `--with-enter` it sends the text, pauses briefly, sends Enter once, then waits and reads. A successful response adds `enterWritten: true`, which only means Enter was written; if Enter fails, `written: true` is kept together with `error.stage: "enter"`, so check the screen before deciding whether to retry. The text is the first argument after the ID; only `--stdin` and `--key` select a mode, and anything else (such as `--help` or `--wait-idle`) is sent literally. To type the literal `--stdin` or `--key`, pipe it in through `--stdin`. Options may follow `--stdin` as well.

If the wait or read fails after the send was acknowledged, the result still returns `written: true` and adds `error: {stage, message}`, the stderr error and exit code 1, so an observation failure is not mistaken for undelivered input. These steps do not take exclusive control of the terminal; other people or Agents can still type at the same time.

`wait-idle` starts observing at the moment of the call. It returns `idle: true` (exit code 0) when the screen is unchanged for 3 consecutive seconds, waiting up to 30 seconds; on timeout it returns `idle: false` (exit code 3). Both arguments are in seconds, accept fractions, and are capped at 3600 seconds; `--idle-time` must be greater than 0, and `--timeout 0` times out immediately. It compares the parsed screen text, size and buffer type, ignoring repaints of identical content, colour codes and title changes, and it does not read accumulated idle time.

The standalone wait can also read the screen: `tide wait-idle <id> --idle-time 3 --timeout 30 --with-read`. The screen is fetched both on idle and on timeout, adding a `read` result alongside the existing `id`, `idle`, `elapsedMs` and `idleForMs` fields; a timeout still returns exit code 3. If the read fails, the wait result is kept and `error: {stage: "read", message}` is added with exit code 1.

Every combined read (`launch`, `send`, `scroll`, `resize`, `wait-idle`) uses the same rules as the standalone `read`. `--full` and `--lines N` (1..2000) are mutually exclusive and must be used with `--with-read`; they affect only the read and do not change the full screen observed while waiting. Combined operations keep the execution results and errors in the JSON; for plain text output use the standalone `read --plain-text`.

A quiet screen does not mean the task is finished or the input box is ready; check the returned `read` or grab the screen again — a program that is still loading may produce no output. Waiting does not resend input and does not stop the target, and the observation ends when the calling connection drops.

## Terminal and environment

The background host runs the shell with `node-pty`, and `@xterm/headless` maintains the screen; a separate viewer handles terminal output, manual input and size changes. The viewer parses colours, clears, cursor movement, overwrites and the alternate screen, rather than faking snapshots by stripping colour codes with a regex.

The Windows viewer enables VT input and enters raw mode so that a TUI's mouse wheel, arrow keys and bracketed paste sequences pass through (including on Node 20). At startup it sets the current console input mode through the system PowerShell, without keeping an extra process around; scrolling behaviour is still decided by the foreground CLI and the terminal.

The default shell is chosen from `--shell`, `TIDE_SHELL`, then `SHELL`; on Windows, when nothing is specified, Git Bash is located and otherwise the system shell is used. Bash/zsh/sh/fish get the usual interactive login arguments and PowerShell loads its normal profile, and shell arguments can be given explicitly after `--`. Exported environment variables are inherited and startup files are still read by the shell itself; variables not exported in the parent shell, and temporary aliases or functions, are not copied automatically.

Child processes inherit `TIDE_SESSION_ID`, `TIDE_STATE_DIR` and `TIDE_ENTRY`, so they can call Tide to reach other sessions. The background host inherits the environment it was started with directly, and the one-shot file carries only shell arguments, never a whole environment. The viewer neither recreates the shell nor changes its environment.

### Terminal reads and output preview

The public entry points are `read` / `--with-read`; there is no `capture` CLI alias. After upgrading, reopen old sessions.

Bash 4.4+ locates the prompt and the execution boundary through invisible OSC 133 markers in PS1 / PS0, without changing the command or clearing the screen. A read selects only the region of the current/latest started command, including the prompt before it, the output, and the new prompt after it, with no limit from the window height. The just-finished result is retained after the next prompt appears, until the following command starts; older commands no longer participate in selection whether or not they were ever read.

| Usage | Returned content |
| --- | --- |
| `read <id>` | First 10 and last 30 lines of the current/latest command; the whole region when it is 40 lines or fewer |
| `read <id> --full` | The whole retained region of the same command, without reading older command history |
| `read <id> --lines 20` | At most the last 20 lines of the same region, not padded from older commands |

`--full` and `--lines` are mutually exclusive; the combined `--with-read` follows the same rules. Shells without command markers, older Bash versions and alternate-screen TUIs are always scoped to the current screen: the default and `--full` return that screen in full, and `--lines` only trims its tail without padding from the top of the screen.

The preview is usually enough to judge the current situation, and there is no requirement to routinely fill in the middle of the output. Widen the read only when the clues are insufficient, when locating a specific problem, or when the task demands a full check. Omissions use a short text notice, do not report how many lines were dropped and do not prompt for a follow-up read; neither the first and last output nor a quiet screen proves on its own that a task has finished.

Reads are counted in display lines (including prompt lines), not raw log lines. `--lines N` accepts 1..2000; `--full` returns everything still retained in the selected region and is not clipped to 2000 lines. There is no separate character limit. Content already evicted from the buffer cannot be recovered; when you need a complete raw log, redirect the original command to a file when you run it.

Every read strips trailing blank lines below the last content or the cursor, keeping interior blank lines and content spacing. Omission notices do not count as content lines. `--plain-text` includes the omission notices; in JSON, `cols` / `rows` are the terminal size and `cursor.row` is relative to the returned text (including notice lines). When the cursor's line is trimmed, `cursor` is omitted and the notice says `cursor omitted`.

Reads keep no read state and consume nothing; reading again observes the currently retained region. Internal idle detection and plugin `capture()` still read the whole screen. Clearing the screen or a size change resets the command boundary, which is restored when a new marker arrives; if a startup file overrides the relevant shell integration the markers may stop working, in which case reads fall back to the current screen. This is not a lossless log or a trustworthy execution audit.

After the foreground CLI exits you are still in the same shell with the same Tide ID, and closing the viewer window does not end it. The session is deregistered and the viewer is told to exit when the shell exits or `close` runs; on Windows the background host may take about 6 more seconds to finish node-pty cleanup, but it no longer holds the viewer window. Sessions do not support recovery across a host crash. Hosts started before the upgrade do not support attach — open a new session.

Attaching restores the retained screen using xterm serialization and then forwards output continuously, rather than restoring a TUI from the plain-text preview of `read`. Colours, cursor, normal/alternate screen, common input modes and split control sequences have automated coverage; states xterm does not support, such as image protocols, are not guaranteed to be restored. See [Background sessions and viewers](docs/background-sessions.md).

## Scrolling and window size

Scroll and resize examples:

```bash
tide scroll 5fefa up --steps 5 --wait-idle --with-read
tide scroll 5fefa down --x 30 --y 10 --with-read
tide resize 5fefa --cols 120 --rows 35 --wait-idle --with-read
```

`scroll` defaults to 3 steps (1..100), which is not the same as text lines; the position is a 1-based screen column and row, defaulting to the centre of the screen. Only the SGR cell mouse protocol enabled by the foreground application is supported — when it is not enabled Tide reports an error instead of falling back to arrow keys. Scrolling changes the application view shared by the user and the Agent; it is not a shell history interface, and long logs should be read from files with Read / grep / rg.

`resize` requires 20..500 columns and 5..200 rows. When detached it adjusts the PTY and the screen copy directly; when attached it waits up to 3 seconds to confirm the outer size, and the PTY and screen copy follow the outer window rather than forcing an artificial internal size difference. It returns `requested`, `actual` and `applied`, and exits with code 3 when the target is not reached — waiting and reading still work. Terminals that do not support it, maximized windows, split screens and screen edges can all affect the result; a request timeout does not mean the terminal will not handle it later. A later manual window resize by the user keeps syncing normally. Verified on Windows Terminal; other terminals are not guaranteed.

An unconfirmed observation: under ConPTY, MSYS bash was once seen dropping the first byte written immediately after a size change. This was seen outside Tide, cannot be reproduced on demand, and did not reappear when typing again after a manual resize; the trigger is unknown. If it happens, retype the input.

## Launch profiles

`tide launch --profile <label>` does "start session + switch env + run command" in one step, saving the round trips of opening a bash, changing environment, and then starting the CLI. The config lives in Tide's own `.tide/launch-profiles.json` and does not depend on external shell configuration or aliases.

```json
{
  "profiles": [
    {
      "label": "claude-alt",
      "description": "Claude Code against an alternate Anthropic-compatible endpoint",
      "commands": ["claude"],
      "env": {
        "ANTHROPIC_BASE_URL": "https://example.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "<token>",
        "ANTHROPIC_MODEL": "<model-id>"
      }
    },
    {
      "label": "codex-alt",
      "description": "Codex against an alternate OpenAI-compatible endpoint",
      "commands": ["codex"],
      "env": {
        "OPENAI_BASE_URL": "https://example.com/v1",
        "OPENAI_API_KEY": "<key>"
      }
    },
    {
      "label": "setup-then-run",
      "description": "Pull latest changes, then start the CLI",
      "commands": ["git pull", "claude"]
    }
  ]
}
```

Common commands:

```bash
# List available profiles (label + description + command + commands + env key count)
tide profiles

# One step: start a session, switch to claude-alt, cd to /path/to/project, start claude
tide launch --profile claude-alt --cwd /path/to/project

# Pass extra arguments through to the last command
tide launch --profile claude-alt --cwd /path/to/project -- --model <model-id>

# Create the session and open a viewer (Windows/macOS); attach happens after the command is sent
tide launch --profile claude-alt --cwd /path/to/project --attach

# Run git pull and then claude
tide launch --profile setup-then-run --cwd /path/to/project

# Without --profile the behaviour is unchanged: a bare bash that receives nothing
tide launch --cwd /path/to/project
```

Label rules: matches `[a-zA-Z0-9_-]+`, case-insensitive, must be unique. `commands` is a non-empty array of single-line shell commands, each tokenized with shell-quote rules (single and double quotes preserve spaces, whitespace splits); they are joined with `;` in order, and a failure of one does not block the next. Arguments after `--` are appended to the last command, replacing any trailing arguments. `--profile` and `--with-command` are mutually exclusive. After launch the JSON gains a few profile fields:

- `profile`: the selected label
- `index`: the position of the profile in the config array
- `command`: `argv[0]` of the first command (the binary name, such as `claude`)
- `commands`: the full command list, each already joined into a string, so it is easy to see what ran

A missing or invalid config produces an error with a minimal template, to help new users get started. The default path is `${TIDE_STATE_DIR}/launch-profiles.json`, overridable with `TIDE_LAUNCH_PROFILES=<path>`. Secrets are stored in plain text in that JSON, so `chmod 600` it if needed.

## Plugins

Plugins are loaded explicitly through `.tide/plugins.json`. Each declares an `id` (the addressing namespace, globally unique), a `name` (display name) and `commands` (its own commands), and may also provide `detect`, an optional `start`, and output-change subscriptions. Plugin commands are invoked as `tide <plugin-id> <command> <session id> [args...]` and do not occupy core command names; the CLI only parses the namespace and routes to that session's host, where the plugin code runs. A command declared with `all: true` accepts `--all` in place of the session ID, and the CLI runs it once per matching session and returns `[{id, result}]`; aggregation happens in the CLI while the state stays in each session's host. A plugin ID may not collide with a core command name: the CLI dispatches core commands first, so a colliding plugin could never be reached — therefore config loading (starting a session, `tide plugin list`, `tide plugin enable`) fails outright instead of loading it. The recovery plugins reuse the same `send` and `sendKey` paths rather than a separate delivery route.

[Plugin contract and example](docs/plugins.md). The optional built-ins are `cxr` (Codex) and `ccr` (Claude Code); enable them with `tide plugin enable ccr` (editing `.tide/plugins.json` directly is equivalent) and reopen the session for it to take effect:

```json
{"plugins":["cxr","ccr"]}
```

```bash
tide plugin list          # all plugins and whether they are enabled
tide plugin status 5fefa  # which plugins are active in that session
tide ccr --help           # ccr's own commands
tide ccr status --all     # status for every matching session
tide ccr status 5fefa
tide ccr watch 5fefa      # start watching that session
tide ccr unwatch 5fefa
```

The recovery plugins handle rate limits and API connection interruptions, and only take over the latest response window when the interruption is explicit and the input box is empty. The final error screen must stay stable for 3 consecutive minutes by default, and they will not take over while the CLI is still retrying or a new reply or user input appears. Codex quota is queried through the App Server and network interruptions are probed independently with `codex exec --ephemeral`; Claude is probed with a `claude -p` JSON ping/pong. Only after recovery is confirmed is "continue" sent to the original window, and an unsuccessful probe is rechecked every 5 minutes. Plugins do not watch sessions by default: configuration only means the plugin process is loaded, and `watch` is what starts observing and timing. `status` is read-only and triggers no probes or sends. Configuration, limits and verification scope are in [Interruption recovery plugins](docs/resume-plugins.md).

## Verification and migration

The source is organised by responsibility:

```text
src/
  cli/                      command parsing and help
  session/                  session host, launch, registry and IPC
  terminal/                 screen rendering, keys, shell and idle detection
  profile-config/           launch profile loading, validation, shell command generation
  plugins/
    runtime.ts              plugin contract, loading and lifecycle
    codex-resume/           Codex probe and recovery entry points
    claude-code-resume/     Claude Code probe and recovery entry points
    recovery/               shared recovery flow, screen recognition and probe processes
tests/
  unit/                     unit tests
  integration/              integration tests with real PTYs and sessions
  fixtures/                 terminal and CLI fixtures for tests
```

Open questions are tracked in [Open questions](docs/open-questions.md): snapshot token consumption and call counts, and how multiple reads interact.

```bash
npm run typecheck
npm test
```

Tests cover terminal control sequences, key combinations, short-ID ambiguity, Git Bash slash arguments, real PTYs and shells, plain-text output, plugin detection and lifecycle, local communication and close deregistration. Windows has been verified on real hardware; macOS window behaviour still needs real-device acceptance, and CI keeps the Windows/macOS matrix.

`scripts/acceptance.mjs` is a manual acceptance script covering paths that automated tests cannot: driving Claude through a small task via Tide and checking the artefact, Node REPL expressions and Ctrl+U, calling Tide from inside one session to operate another, the timeout and idle behaviour after continuous screen output, long waits, and returning to the same shell after the CLI exits.

The old `watch/unwatch/resume/quota/status/snapshot/tail/wait`, the CLI history scan and automatic recovery implementations have been removed. `tide send` now means terminal text input, and the old `--cli/--message/--mode` usage no longer applies. Old configuration and history state are not imported into new sessions and are not read by the new core; processes started by older versions must be ended — the new version will not take them over.

Local runtime data lives in `TIDE_STATE_DIR` (by default `.tide` next to the installation directory): `sessions/` holds the current host's private registrations, `terminal-launches/` holds one-shot launch handoffs, and `session-logs/` holds background host diagnostics. Apart from `tide plugin enable/disable` rewriting `.tide/plugins.json`, Tide writes no CLI history or configuration. Dead registrations left by an abnormal exit are cleaned up once the endpoint is confirmed absent; an endpoint that cannot be confirmed produces an error, so short-ID ambiguity is never resolved incorrectly.

## License

MIT, see [LICENSE](LICENSE).
