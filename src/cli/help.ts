const afterSend = `AFTER SENDING (options must follow the text/keys)
  --wait-idle       Wait for an unchanged screen after sending.
  --idle-time N     Quiet seconds, default 2 (>0..3600); requires --wait-idle.
  --timeout N       Maximum wait seconds, default 30 (0..3600); requires --wait-idle.
  --with-capture    Include a rendered snapshot after sending and optional waiting.
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
  exited, exitCode. These describe the shell, not the foreground agent's state.`;
const shell = `  --shell executable   Override TIDE_SHELL / SHELL / platform default.
  --cwd directory      Working directory; default is the caller's directory.
  -- shell-args...     Override default interactive shell arguments.
  Inherits exported environment; the selected shell reads its startup files.
  Child processes receive TIDE_SESSION_ID, TIDE_STATE_DIR and TIDE_ENTRY.
  Exiting a CLI returns to the same shell/ID; exiting the shell ends the session.`;

export const commandHelp: Record<string, string> = {
  scroll: `tide scroll <id> up|down [--steps N] [--x N] [--y N] [--wait-idle] [--idle-time N] [--timeout N] [--with-capture]

Send mouse wheel events to the foreground TUI. Requires enabled SGR cell mouse
reporting. Unsupported modes fail before sending; never substitutes arrow keys.
This changes the shared application view, not a private Agent viewport.
${session}

OPTIONS
  --steps N        Wheel steps, default 3, range 1..100; not a count of text lines.
  --x N --y N      1-based screen cell, default screen center for each coordinate.
                  Use a point inside the intended pane in multi-pane applications.
  Ordinary shell history: use capture --lines N instead of scroll.

${afterSend}

OUTPUT
  JSON {id, written: true}, plus optional wait/capture. Acknowledges wheel input,
  not movement: the application may already be at the beginning/end of content.
EXAMPLE
  tide scroll abc123 up --steps 5 --wait-idle --with-capture`,
  resize: `tide resize <id> --cols N --rows N [--wait-idle] [--idle-time N] [--timeout N] [--with-capture]

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
  Defaults: 2 quiet seconds, 30 seconds idle timeout. --timeout affects only idle.
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
EXAMPLE
  tide run --shell bash --cwd .
  tide run --shell bash -- --noprofile --norc -i`,
  launch: `tide launch [--shell executable] [--cwd directory] [-- shell-args...]

Open a visible terminal on Windows or macOS and host an interactive shell.
Returns once the session registers; capture it to check the prompt is ready.
${shell}

OUTPUT
  ${info}
  If launch fails or times out, inspect tide list before launching again.
EXAMPLE
  tide launch --shell bash --cwd .`,
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
  send: `tide send <id> <text> [--with-enter] [--wait-idle] [--idle-time N] [--timeout N] [--with-capture]
tide send <id> --stdin [same options]

Fill the current terminal input with literal text. No Enter by default.
Add --with-enter after the text to send Enter before optional waiting/capture.
First capture the screen to check which program or prompt will receive it.
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
  tide send abc123 'claude'
  tide send-key abc123 Enter
  tide send abc123 '/help'
  tide send abc123 '/help' --with-enter --wait-idle --with-capture
  tide send-key abc123 Enter --wait-idle --timeout 60 --with-capture
  printf '%s' 'Explain this function' | tide send abc123 --stdin`,
  "send-key": `tide send-key <id> <key> [keys...] [--wait-idle] [--idle-time N] [--timeout N] [--with-capture]

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
  "wait-idle": `tide wait-idle <id> [--idle-time seconds] [--timeout seconds]

Wait until the rendered screen stays unchanged for a continuous interval.
Observation starts now, not at the last historical output. Does not send input.
${session}

OPTIONS
  --idle-time seconds   Required quiet interval; default 2, range >0 to 3600.
  --timeout seconds     Maximum wait; default 30, range 0..3600. 0 times out now.
  Both accept decimal seconds. Text, dimensions and buffer changes reset the
  quiet interval; colors, titles and redraws of identical text do not.

OUTPUT
  JSON {id, idle, elapsedMs, idleForMs}; durations in milliseconds.
  Exit 0: idle=true. Exit 3: deadline reached, idle=false. Exit 1: error.
  Timeout leaves the target running. Idle does NOT prove task completion: an
  approval prompt or a stalled task can be quiet. Always capture after waiting.
EXAMPLE
  tide wait-idle abc123 --idle-time 2 --timeout 60
  tide capture abc123 --plain-text`,
  close: `tide close <id>

Terminate the hosted shell and unregister its Tide session. This can end ongoing
work. To interrupt only the foreground task, consider send-key <id> Ctrl+C.
${session}

OUTPUT
  JSON {id, closing: true} acknowledges shutdown, not completion of cleanup.
  Use list to verify removal. Captures are not retained after the session ends.
EXAMPLE
  tide close abc123`,
  plugins: `tide plugins <id>

Discover explicitly configured plugins and the commands matching this session now.
${session}

OUTPUT
  JSON array of {id, matched, commands: [{name, description}], error}.
  [] means no plugins configured. Commands appear only for matched plugins.
  Read each command's description for arguments/behavior before calling plugin.
  Detection is checked again at invocation; the foreground program can change.

CONFIGURATION
  TIDE_STATE_DIR/plugins.json (default installation .tide/plugins.json) contains
  {"plugins":["codex-resume","claude-code-resume"]} enables bundled automatic
  interruption recovery. Or list explicit local module paths; relative paths resolve from that
  file. Modules load at shell launch; configure before starting a new session.
  Plugins run as local code with the user's privileges. Recovery plugins act only
  on the latest quota/connection-interrupted response with an empty input, after
  180 seconds of stable screen (TIDE_RESUME_DELAY_SECONDS configures 1..3600).
  Active retries cancel this countdown; check cannot bypass it. Codex quota errors
  use App Server permission; connection errors probe with codex exec --ephemeral.
  Claude probes with claude -p JSON. Failed probes retry every 5 minutes.
  Model probes consume tokens. Discover status/check/disable/enable via
  this command. check can cause recovery; status is read-only.
EXAMPLE
  tide plugins abc123`,
  plugin: `tide plugin <id> <plugin> <command> [args...]

Invoke a matching plugin's extension command. Discover names, descriptions and
argument requirements with tide plugins <id>; there are no universal plugin args.
${session}

OUTPUT
  JSON result defined by the plugin (null if it returns no value).
  Errors, unconfigured plugins and detection mismatch exit 1.
  Commands may write input or otherwise act on the session: read their description.
  Trailing arguments, including --help, are passed unchanged to the plugin.
EXAMPLE (requires the repository's screen example plugin)
  tide plugins abc123
  tide plugin abc123 screen contains 'Ready'`,
};

const overview = `tide — visible interactive shells shared by humans and agents

USAGE
  tide help [command]             Read help without opening/contacting a session
  tide <command> --help           Same command help (put --help immediately here)

COMMANDS
  run [shell options]             Host a shell in this TTY; blocks until shell exit
  launch [shell options]          Open a visible terminal; return its session JSON
  list                           Discover live sessions and IDs
  info <id>                      Read shell metadata (not agent/task status)
  send <id> <text> | --stdin       Fill text; --with-enter optionally submits
  send-key <id> <key> [keys...]    Send named keys/chords, e.g. Enter or Ctrl+C
  scroll <id> up|down [--steps N]  Send wheel events to a mouse-enabled TUI
  resize <id> --cols N --rows N    Request visible window size; report actual size
  capture <id> [--lines N] [--plain-text]   Read the rendered terminal screen
  wait-idle <id> [--idle-time seconds] [--timeout seconds]   Wait for a quiet screen
  close <id>                      Terminate the hosted shell/session
  plugins <id>                    Discover matching extensions and their commands
  plugin <id> <plugin> <command> [args...]   Invoke an extension

AGENT WORKFLOW
  1. tide list                    Choose an existing ID, or tide launch for a new one.
  2. tide capture <id>            Check the foreground program and input prompt.
  3. tide send <id> 'your text'    Fill input. User and agent input share the terminal.
  4. tide send-key <id> Enter     Submit only when appropriate for that prompt.
  5. tide wait-idle <id> --idle-time 2 --timeout 30
  6. tide capture <id>            Interpret the screen; continue waiting/interacting.
  Combine steps 3-6: tide send <id> 'your text' --with-enter --wait-idle --with-capture
  Combine steps 4-6: tide send-key <id> Enter --wait-idle --with-capture
  Both send and send-key support these options after their text/keys. Waiting
  defaults to 2 quiet seconds, 30 seconds maximum; --idle-time/--timeout customize it.
  Replace <id> with a real ID from list; unique prefixes are accepted.
  Inside a hosted shell, TIDE_SESSION_ID identifies that shell. Use another ID
  from list to control a different session. All callers must share TIDE_STATE_DIR.

RESULTS AND RECOVERY
  Control commands return JSON; capture --plain-text prints only rendered text.
  Help is text; run is a live terminal. Exit 0 means command success, not task
  completion. Exit 1 means an error (stderr). Idle-wait timeout returns JSON and
  exit 3, leaving the target running. Always capture after waiting, even on timeout.
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
  detection or automatic recovery in the core. Explicitly enable codex-resume or
  claude-code-resume for quota/connection recovery; see tide help plugins.
`;

export function help(command?: string): string {
  if (!command || command === "help") return overview;
  if (!Object.hasOwn(commandHelp, command)) throw Error(`Unknown help topic: ${command}; use tide --help`);
  return `${commandHelp[command]}\n\nHELP\n  tide help ${command} | tide ${command} --help\n  Control commands: exit 0 success, 1 error on stderr; idle-wait timeout uses 3.\n`;
}
