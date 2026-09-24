const afterSend = `AFTER SENDING (options must follow the text/keys)
  --wait-idle       Wait for an unchanged screen after sending.
  --idle-time N     Quiet seconds, default 3 (>0..3600); requires --wait-idle.
  --timeout N       Maximum wait seconds, default 30 (0..3600); requires --wait-idle.
  --with-capture    Include a rendered snapshot after sending and optional waiting.
  --lines N         Capture last N available lines (1..2000); requires --with-capture.
                    Affects capture only; waiting still observes the whole screen.
  Both timings accept decimals. Capture alone is immediate and may precede the
  program's response. Idle is not proof of task completion or prompt readiness.
  JSON keeps {id, written} and adds wait: {id, idle, elapsedMs, idleForMs} and/or
  capture: {id, capturedAt, cols, rows, buffer, title, text, cursor} when requested.
  Idle timeout still captures if requested, returns idle=false and exits 3.
  If an observation fails after delivery, JSON keeps written=true and adds
  error: {stage, message}; stderr explains the error and exit code is 1. Do not
  resend automatically. Operations share the terminal with users/other agents;
  the sequence is not an exclusive lock on input.`;

const session = `SESSION
  <id> is a Tide session ID, not a Codex/Claude conversation ID.
  Use tide list; a unique ID prefix is accepted. Ambiguous prefixes fail without
  sending input: use a longer prefix or the full ID. No live match means the
  session ended, uses another TIDE_STATE_DIR, or was not launched by Tide.`;

const info = `JSON session fields: id, pid (host), shellPid, shell, cwd, createdAt,
  exited, exitCode, idleForMs, lastOutputAt.
  idleForMs: milliseconds since the rendered screen last changed (dimensions,
  active buffer or text). Identical redraws, colors, cursor and title do not reset it.
  lastOutputAt: UTC ISO time of the last PTY output, even an identical redraw;
  null until first output. Neither field proves completion or need for intervention.
  These live fields may be absent on older hosts; reopen the session to enable them.`;
const shell = `  --shell executable   Override TIDE_SHELL / SHELL / platform default.
  --cwd directory      Working directory; default is the caller's directory.
  -- shell-args...     Override default interactive shell arguments.
  Inherits exported environment; the selected shell reads its startup files.
  Child processes receive TIDE_SESSION_ID, TIDE_STATE_DIR and TIDE_ENTRY.
  Exiting a CLI returns to the same shell/ID; exiting the shell ends the session.`;

export const commandHelp: Record<string, string> = {
  scroll: `tide scroll <id> up|down [--steps N] [--x N] [--y N] [--wait-idle] [--idle-time N] [--timeout N] [--with-capture] [--lines N]

Send mouse wheel events to the foreground TUI. Requires enabled SGR cell mouse
reporting. Unsupported modes fail before sending; never substitutes arrow keys.
This changes the shared application view, not a private Agent viewport.
${session}

OPTIONS
  --steps N        Wheel steps, default 3, range 1..100; not a count of text lines.
  --x N --y N      1-based screen cell, default screen center for each coordinate.
                  Use a point inside the intended pane in multi-pane applications.
  Occasional shell context: use capture --lines N instead of scroll.
  Frequent scrolling through old output suggests a different workflow: use a
  Bash/shell execution tool, redirect output to a file, then Read or grep/rg it.
  Scroll is for TUI interaction, not the recommended way to analyze long logs.

${afterSend}

OUTPUT
  JSON {id, written: true}, plus optional wait/capture. Acknowledges wheel input,
  not movement: the application may already be at the beginning/end of content.
EXAMPLE
  tide scroll abc123 up --steps 5 --wait-idle --with-capture`,
  resize: `tide resize <id> --cols N --rows N [--wait-idle] [--idle-time N] [--timeout N] [--with-capture] [--lines N]

Request a visible terminal resize through its window-control protocol. The PTY
and capture follow actual outer dimensions; never forces a different inner size.
This changes the user's visible window. Later manual resizing takes precedence.
${session}

OPTIONS
  --cols N         Required columns, 20..500.
  --rows N         Required rows, 5..200.
  Waits up to 3 seconds for the requested size. Terminal support, screen bounds,
  maximization and split panes may prevent an exact match. No desktop fallback.
  --wait-idle, --idle-time N, --timeout N, --with-capture observe after resizing.
  --lines N limits capture to N available lines (1..2000); requires --with-capture.
  Defaults: 3 quiet seconds, 30 seconds idle timeout. --timeout affects only idle.
  Capture alone may show a redraw in progress. Idle does not prove task completion.

OUTPUT
  JSON {id, requested: {cols, rows}, actual: {cols, rows}, applied: boolean}.
  Already at the requested size succeeds without writing a control sequence.
  Unconfirmed size: applied=false, exit 3; requested observation still runs.
  Optional wait/capture fields match send; an observation error retains the resize
  result and adds error: {stage, message}, exit 1. A timeout is not cancellation:
  the outer terminal may apply the request later. Inspect before retrying.
EXAMPLE
  tide resize abc123 --cols 120 --rows 35 --wait-idle --with-capture`,
  run: `tide run [--shell executable] [--cwd directory] [-- shell-args...]

Host an interactive shell in the current terminal. Requires a real TTY.
This command occupies the terminal until the shell exits; use another terminal
or agent process for control commands. Use launch for a command that returns.
${shell}

OUTPUT
  Live terminal output, not JSON. Exit code follows the hosted shell.
  On Windows the terminal is released about 6 seconds after the shell ends:
  node-pty's own cleanup keeps the host process alive that long. Not a hang.
EXAMPLE
  tide run --shell bash --cwd .`,
  launch: `tide launch [--shell executable] [--cwd directory] [--with-command text | --profile label] [--wait-idle] [--with-capture] [--lines N] [--idle-time N] [--timeout N] [-- shell-args... | -- <bin-args...>]

Open a visible terminal on Windows or macOS and host an interactive shell.
For a new session with a known command, combine launch, text, Enter and observation:
  tide launch --with-command "echo hello" --wait-idle --with-capture
Use the returned id for subsequent commands and inspect the returned capture;
no separate send, Enter or capture call is needed for this startup sequence.
Windows requires Windows Terminal (wt.exe). Uses the current WT profile when
available, otherwise its default profile, including its colors and font.
Without --with-command / --profile, returns once the session registers; use
wait-idle <id> --with-capture to inspect startup. Registration alone is not
readiness. --with-command text waits for 3 quiet startup seconds (30-second
limit), sends the single-line command, then Enter after a 150 ms pause.
--profile label switches to a saved profile from TIDE_STATE_DIR/launch-profiles.json
(set TIDE_LAUNCH_PROFILES=<path> to override):
unset every key any profile defines, export the chosen profile's env, then
(optionally) "cd <cwd>", then run the profile's commands in order joined with ";".
--cwd before the embedded cd is honored; commands run in the requested directory.
label is case-insensitive and must match [a-zA-Z0-9_-]+. --profile is mutually
exclusive with --with-command. Use "tide profiles" to list labels; "tide launch
--profile ?" is rejected.
Startup timeout returns the session and error.stage=startup, exit 1, without
sending the command. Inspect the existing session before retrying.
Observation options require --with-command / --profile and run after Enter.
Quote --with-command as one argument; -- <bin-args...> passes through to the
LAST command in the profile (not the shell).
--wait-idle, --idle-time N, --timeout N, --with-capture and --lines N have the
same meanings as send (defaults: 3 quiet seconds, 30-second post-command limit).
Capture without --wait-idle is immediate and may precede the command response.
${shell}

OUTPUT
  ${info}
  With --with-command / --profile, keeps session fields and adds written,
  enterWritten, profile, index, command, commands (when --profile), and
  optional wait/capture, as for send. Failures retain the session ID and
  error: {stage, message}, exit 1. Post-command idle timeout exits 3 and still
  captures when requested. Delivery errors may mean input arrived; inspect first.
  If launch fails or times out, inspect tide list before launching again.
EXAMPLES
  tide launch --with-command "echo hello" --wait-idle --with-capture
  tide launch --cwd . --with-command "echo hello" --wait-idle --timeout 60 --with-capture
  tide launch --shell bash --cwd .
  tide launch --profile minimax --cwd /d/foo
  tide launch --profile minimax --cwd /d/foo -- --model claude-sonnet-4-20250514`,
  list: `tide list

Discover live Tide shells in the current state directory. No arguments.
Does not discover arbitrary terminal windows or scan CLI conversation history.

OUTPUT
  JSON array of sessions; [] means none are registered and reachable.
  ${info}
  An unresponsive registration can cause an error rather than an incomplete list.
EXAMPLE
  tide list`,
  info: `tide info <id>

Read shell process metadata. This does not identify task completion or rate limits.
${session}

OUTPUT
  ${info}
EXAMPLE
  tide info abc123`,
  send: `tide send <id> <text> [--with-enter] [--wait-idle] [--idle-time N] [--timeout N] [--with-capture] [--lines N]
tide send <id> --stdin [same options]

Fill the current terminal input with literal text. No Enter by default.
Add --with-enter after the text to send Enter before optional waiting/capture.
Inspect the latest returned capture to check the receiving program and prompt.
Use a separate capture if the screen is unknown or may have changed since then.
Use send-key for keys/chords; backslash escape notation is not decoded.
${session}

INPUT
  Quote text as one argument using your calling shell's quoting rules.
  --with-enter sends one Enter after a short paste-processing pause (150 ms).
  This is not a readiness check; only use it when the current prompt can submit.
  --stdin reads UTF-8 until EOF. It preserves newlines, including a trailing one.
  Multiline text and tabs require the target to enable bracketed paste; otherwise
  they are rejected. Other control characters are rejected; use send-key.
  The literal text --help is allowed after <id>. To send the literal --stdin,
  supply it through stdin instead.
  Git Bash: use bin/tide (or its installed tide entry) to preserve /help. Quotes
  do not disable MSYS path conversion when calling node dist/tide.mjs directly.

${afterSend}

OUTPUT
  JSON {id, written: true}: text written to the PTY, not proof of completion.
  With --with-enter, enterWritten: true confirms the Enter write was acknowledged.
  If Enter fails, written remains true with error.stage=send-key and exit 1;
  delivery may be uncertain. Inspect the screen before retrying.
  On transport failure, capture before retrying: input may already have arrived.
EXAMPLES (Bash)
  tide send abc123 'echo hello' --with-enter --wait-idle --with-capture
  tide send abc123 '/help' --with-enter --wait-idle --with-capture
  tide send abc123 'draft text' --with-capture
  tide send-key abc123 Enter --wait-idle --timeout 60 --with-capture
  printf '%s' 'Explain this function' | tide send abc123 --stdin --with-enter --wait-idle --with-capture`,
  "send-key": `tide send-key <id> <key> [keys...] [--wait-idle] [--idle-time N] [--timeout N] [--with-capture] [--lines N]

Send 1..64 named keys/chords in order, with no pauses between them.
All keys are validated before any are written. Separate calls and capture between
them when the next key depends on a changed screen. Use send for ordinary text.
${session}

KEYS (case-sensitive names)
  Enter Escape Tab Backspace Space
  Up Down Left Right Home End Insert Delete PageUp PageDown F1..F12
  Ctrl+A..Ctrl+Z, Ctrl+Space, Alt+letters/digits, Ctrl+Alt+letters, Shift+Tab
  Navigation/function keys accept Ctrl/Alt/Shift combinations, e.g. Ctrl+Left,
  Ctrl+Shift+Left. Alt+letter preserves the letter's case.
  Ctrl+Enter, Shift+Enter and Win keys are unsupported and fail explicitly.
  Supply names, not raw ANSI escape codes. The foreground program decides what
  a key does: Ctrl+C usually interrupts; it does not mean close the Tide session.

${afterSend}

OUTPUT
  JSON {id, written: true}; delivery does not confirm the program acted on it.
  After a transport failure, capture before retrying.
EXAMPLES
  tide send-key abc123 Enter
  tide send-key abc123 Ctrl+C
  tide send-key abc123 Up Enter
  tide send-key abc123 Enter --wait-idle --timeout 60 --with-capture
  tide send-key abc123 Ctrl+Shift+Left`,
  capture: `tide capture <id> [--lines N] [--plain-text]

Read a rendered terminal snapshot after parsing cursor movement and ANSI controls.
${session}

OPTIONS
  --lines N       Last N available rendered lines, 1..2000; default current screen.
                  Includes available scrollback in the normal buffer. Full-screen
                  alternate buffers usually have no shell scrollback.
                  Intended for occasional context. For frequent long-output reads,
                  use a Bash/shell execution tool with output redirected to a file,
                  then Read selected portions or search with grep/rg.
  --plain-text    Print text with spaces/newlines, no JSON wrapper or ANSI colors.

OUTPUT
  JSON {id, capturedAt, cols, rows, buffer, title, text, cursor} by default.
  cursor has zero-based row (relative to returned text) and col; row can be
  negative when --lines excludes it. Older hosts may omit cursor.
  buffer is normal or alternate. This is a screen, not a structured transcript.
  Use the text to decide whether input, approval, recovery or more waiting is needed.
EXAMPLES
  tide capture abc123
  tide capture abc123 --lines 100 --plain-text`,
  "wait-idle": `tide wait-idle <id> [--idle-time seconds] [--timeout seconds] [--with-capture] [--lines N]

Wait until the rendered screen stays unchanged for a continuous interval.
Observation starts now, not at the last historical output. Does not send input.
${session}

OPTIONS
  --idle-time seconds   Required quiet interval; default 3, range >0 to 3600.
  --timeout seconds     Maximum wait; default 30, range 0..3600. 0 times out now.
                       For expected long tasks, increase this (e.g. 300 seconds)
                       to reduce repeated waits. Returns earlier if idle is reached.
  Both accept decimal seconds. Text, dimensions and buffer changes reset the
  quiet interval; colors, titles and redraws of identical text do not.
  --with-capture        Include a rendered snapshot after idle or timeout.
  --lines N            Last N available lines (1..2000); requires --with-capture.
                       Only crops capture; idle still compares the whole screen.

OUTPUT
  JSON {id, idle, elapsedMs, idleForMs}; durations in milliseconds.
  --with-capture adds capture (a full snapshot). Capture failure preserves the
  wait result and adds error {stage: "capture", message}, with exit 1.
  Exit 0: idle=true. Exit 3: deadline reached, idle=false. Exit 1: error.
  Timeout leaves the target running. Idle does NOT prove task completion: an
  approval prompt or a stalled task can be quiet. Inspect the captured screen.
EXAMPLE
  tide wait-idle abc123 --idle-time 3 --timeout 60 --with-capture`,
  close: `tide close <id>

Terminate the hosted shell and unregister its Tide session. This can end ongoing
work. To interrupt only the foreground task, consider send-key <id> Ctrl+C.
${session}

OUTPUT
  JSON {id, closing: true} acknowledges shutdown, not completion of cleanup.
  Use list to verify removal: it drops the session at once, while on Windows the
  terminal window itself is released about 6 seconds later (see tide help run).
  Captures are not retained after the session ends.
EXAMPLE
  tide close abc123`,
  profiles: `tide profiles

List launch profiles parsed from TIDE_STATE_DIR/launch-profiles.json
(set TIDE_LAUNCH_PROFILES=<path> to override). Read-only; never modifies state.

OUTPUT
  JSON {path, profiles: [{index, label, description, command, commands, envKeyCount}]}.
  label must match [a-zA-Z0-9_-]+ and is unique (case-insensitive). command is
  the binary of the first command (argv[0]); commands is the full ordered list
  of argv arrays (one per "commands" entry in the file). Anything after -- is
  appended to the last command. envKeyCount hints at how much the profile mutates env.
  A missing or invalid file is an error with a path + a minimal template; the
  file is otherwise not touched.
EXAMPLE
  tide profiles`,
  plugin: `tide plugin list
tide plugin status <id>
tide plugin enable <name|path>
tide plugin disable <name|path>
tide <plugin-id> <command> <session id> [args...]

List the plugins Tide knows about, or report which of them are active in one
session. Each plugin's own commands live in that plugin's namespace: run
tide <plugin-id> --help for them. The CLI resolves the namespace and forwards to
the named session's host, where the command's code runs; the plugin never sees
the session id. A command that is meaningful for every session at once is
marked * in that help: it accepts --all in place of the session id, and the CLI
then runs it in each session whose host reports a match, returning one
{id, result|error} per session.

enable/disable edit plugins.json, the only configuration the core writes, and
print the resulting registry. They apply to sessions started afterwards, because
a running host loaded its plugins at launch. <name> is a bundled name and <path>
a module path: the same string the file stores. Enabling loads and validates the
module before writing it, so one that cannot load is never saved; disabling needs
an entry that is there and loads nothing.

OUTPUT
  list:   JSON array of {id, name, source, enabled}, in configuration order
          followed by bundled plugins that are switched off. id is the namespace
          addressing the plugin's commands; source is "bundled" or the module
          path written in the configuration file; enabled means that file lists
          it. Never contacts a session. An id that is also a core command name
          (or help) is an error wherever this file is read — list, enable and
          session start alike — because the CLI dispatches those names first and
          such a plugin could never be addressed. enable/disable print the same
          array.
  status: JSON array of {id, name, matched, commands: [{name, description}],
          error} for one session. [] means no plugins configured. Commands appear
          only for plugins matching it now; read each description before calling
          the command. Detection is checked again at invocation, because the
          foreground program can change.

CONFIGURATION
  TIDE_STATE_DIR/plugins.json (default installation .tide/plugins.json) contains
  {"plugins":["cxr","ccr"]} to enable the bundled interruption-recovery plugins,
  or explicit local module paths resolved from that file. Modules load at shell
  launch; configure before starting a new session (tide plugin enable/disable
  write this file). Plugins run as local code with
  the user's privileges. The bundled recovery plugins act only on the latest
  quota/connection-interrupted response with an empty input, after 180 seconds of
  stable screen (TIDE_RESUME_DELAY_SECONDS configures 1..3600); active retries
  cancel that countdown. Codex quota errors use App Server permission and
  connection errors probe with codex exec --ephemeral; Claude probes with
  claude -p JSON. Failed probes retry every 5 minutes, and model probes consume
  tokens. Their own commands are status (read-only), watch and unwatch; the
  monitor is off by default and watch <id> must be called after the foreground
  CLI is ready. status accepts --all to report every session the plugin matches
  at once; watch and unwatch act on one session.
EXAMPLES
  tide plugin list
  tide plugin enable ccr
  tide plugin disable ccr
  tide plugin status abc123
  tide ccr --help
  tide ccr watch abc123
  tide ccr status abc123`,
};

// Names the CLI handles before it can fall through to a plugin namespace:
// `help` is dispatched by name, and every key of commandHelp is a core command.
// A plugin carrying one of these ids loads and runs, but nothing can address it.
export function isReservedName(name: string): boolean {
  return name === "help" || Object.hasOwn(commandHelp, name);
}

const overview = `tide — visible interactive shells shared by humans and agents

USAGE
  tide help [command]             Read help without opening/contacting a session
  tide <command> --help           Same command help (put --help immediately here)

COMMANDS
  run [shell options]             Host a shell in this TTY; blocks until shell exit
  launch [options]                Open a terminal; --with-command submits a command
  list                           Discover live sessions and IDs
  info <id>                      Read shell metadata (not agent/task status)
  send <id> <text> | --stdin       Fill text; --with-enter optionally submits
  send-key <id> <key> [keys...]    Send named keys/chords, e.g. Enter or Ctrl+C
  scroll <id> up|down [--steps N]  Send wheel events to a mouse-enabled TUI
  resize <id> --cols N --rows N    Request visible window size; report actual size
  capture <id> [--lines N] [--plain-text]   Read the rendered terminal screen
  wait-idle <id> [--idle-time seconds] [--timeout seconds] [--with-capture]
                                                         Wait for a quiet screen
  close <id>                      Terminate the hosted shell/session
  plugin list | status <id>       List plugins, or one session's active plugins
  plugin enable|disable <name|path>   Edit plugins.json; new sessions only
  <plugin-id> <command> <id> [args...]  Run a plugin's own command, e.g. tide ccr status <id>
  profiles                       List launch profiles from .tide/launch-profiles.json

AGENT WORKFLOW
  New session with a known startup command:
  1. tide launch --with-command "echo hello" --wait-idle --with-capture
     Starts the shell, sends the command and Enter, waits, and returns id + capture.
     Use when shell startup needs no interaction; inspect capture before proceeding.
  2. tide send <id> 'echo world' --with-enter --wait-idle --with-capture
     Use the returned id and check that the captured prompt is ready for this input.
  3. If still working: tide wait-idle <id> --timeout 300 --with-capture
     Read the returned capture; continue waiting without resending the task.
  4. When the whole session is no longer needed: tide close <id>

  Existing session: tide list, then tide capture <id> to check its current prompt;
  continue from step 2. Reuse a fresh returned capture instead of capturing twice.
  If startup needs inspection: tide launch, then tide wait-idle <id> --with-capture.
  Submit existing input or confirm a prompt: tide send-key <id> Enter --wait-idle --with-capture
  Fill without submitting: tide send <id> 'your text' --with-capture
  Interrupt foreground work: tide send-key <id> Ctrl+C --wait-idle --with-capture
  Choose keys from the current prompt. User and agent input share the terminal.
  --with-command includes Enter; send requires --with-enter to submit text.
  Observation options follow send text/send-key keys; launch options go before
  -- shell-args. Post-command waiting defaults to 3 quiet seconds, 30 seconds
  maximum; --idle-time/--timeout customize it. Every combined
  capture accepts --lines N (1..2000) for occasional additional context.
  For expected long tasks, increase --timeout (e.g. 300, maximum 3600 seconds)
  to reduce repeated waits; reaching idle still returns early.
  If you frequently capture long output or scroll back through history, switch to
  a Bash/shell execution tool or another suitable tool: redirect output to a file,
  then Read what you need or search with grep/rg. Bash: your-command > output.log 2>&1
  Use tee when output should also remain visible. Capture/scroll support does not
  make repeated screen reading the recommended workflow for logs or bulk output.
  Replace <id> with a real ID returned by launch or list; unique prefixes are accepted.
  Inside a hosted shell, TIDE_SESSION_ID identifies that shell. Use another ID
  from list to control a different session. All callers must share TIDE_STATE_DIR.

RESULTS AND RECOVERY
  Control commands return JSON; capture --plain-text prints only rendered text.
  Help is text; run is a live terminal. Exit 0 means command success, not task
  completion. Exit 1 means an error (stderr). Idle-wait timeout returns JSON and
  exit 3, leaving the target running. Inspect the returned capture even on timeout;
  without --with-capture, capture separately. Continue waiting without resending.
  written=true only acknowledges a PTY write. Idle is not a task/status detector.
  A failed/timeout input request may have arrived: inspect before resending.
  Ambiguous IDs require a longer prefix. Use help <command> for exact options,
  key names, output fields, defaults and examples. Unknown options are errors.

ENVIRONMENT
  Default state: installation .tide directory; override with TIDE_STATE_DIR.
  launch opens Windows/macOS terminals; run requires an existing real TTY.
  Git Bash: use the supplied bin/tide entry to preserve slash text such as /help;
  quoting alone does not prevent MSYS path conversion with direct node invocation.
  Core controls Tide-hosted shells only; no CLI history scanning, semantic status
  detection or automatic recovery in the core. Explicitly enable cxr (Codex) or
  ccr (Claude Code) for quota/connection recovery; see tide help plugin.
`;

export function help(command?: string): string {
  if (!command || command === "help") return overview;
  if (!Object.hasOwn(commandHelp, command)) throw Error(`Unknown help topic: ${command}; use tide --help`);
  return `${commandHelp[command]}\n\nHELP\n  tide help ${command} | tide ${command} --help\n  Control commands: exit 0 success, 1 error on stderr; idle-wait timeout uses 3.\n`;
}
