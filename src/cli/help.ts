const readOptions = `  --lines N      Last N lines of the selected range (1..2000).
  --full         Complete retained selected range; --full and --lines are mutually exclusive.`;
const timingOptions = `  --idle-time N  Quiet seconds, default 3 (>0..3600).
  --timeout N    Wait limit in seconds, default 30 (0..3600). Timings accept decimals.
  Idle timeout exits 3, leaves the task running and still reads if requested.`;
const observation = `  --wait-idle    Wait after the operation; --idle-time/--timeout require this flag.
${timingOptions}
  --with-read    Include a read after the operation/wait; alone it is immediate.
${readOptions}
  --lines/--full require --with-read. Observation errors retain the operation result;
  failed requests may have delivered input.`;
const shellOptions = `  --shell executable  Override TIDE_SHELL / SHELL / platform default.
  --cwd directory     Working directory; default is the caller's directory.`;

// One definition supplies both the overview and each command's local expansion.
const commands: Record<string, { usage: string[]; summary: string; details?: string }> = {
  launch: {
    usage: ['launch [--shell executable] [--cwd directory] [--with-command text] [--attach]'],
    summary: 'Start a background shell session (no window unless --attach); return its Tide ID.',
    details: `${shellOptions}
  --with-command text  Send a single-line command followed by Enter.
  -- args...           Shell arguments.
  --attach             Open a terminal display for this new session. Windows/macOS
                       only, and not the current terminal (no focus guarantee): Windows Terminal
                       tab / macOS Terminal window. Attach happens after command submission,
                       before --wait-idle/--with-read. Closing the display leaves the session running.
                       Attach failure skips observation and does not close the session; retry
                       tide attach <id>. Put --attach before the -- argument delimiter.
  Command startup waits for 3 quiet seconds (30-second limit).
  Startup timeout sends nothing; later failures may have delivered input.
  Observation options require --with-command:
${observation}`,
  },
  attach: {
    usage: ['attach <id>'],
    summary: 'Open a Windows Terminal tab / macOS Terminal window for an existing session.',
    details: '  One display per session; an attached or opening display rejects another attach.\n  Closing this display disconnects it without ending the session.',
  },
  list: {
    usage: ['list'],
    summary: 'List live sessions as JSON: id, cwd (initial directory), lastCommand (null when unknown), display, promptState, shell, createdAt, idleForMs.',
  },
  info: {
    usage: ['info <id>'],
    summary: 'Return one session with the same fields as list: id, cwd (initial directory), lastCommand, display, promptState, shell, createdAt, idleForMs; not semantic task status.',
  },
  send: {
    usage: ['send <id> <text> [--with-enter]', 'send <id> --stdin [--with-enter]', 'send <id> --key <key> [keys...]'],
    summary: 'Send literal text or ordered keys to the shared foreground program.',
    details: `  Quote text as one argument; --stdin reads UTF-8 until EOF, retaining newlines.
  Enter types the word; --key Enter presses Return. --with-enter submits text
  after a 150 ms pause. Put options AFTER text/keys.
  Multiline text/tabs require bracketed paste mode; control characters are rejected.
  Backslash escapes are not decoded. Literal --stdin/--key must be sent via stdin.
  --key cannot combine with text, --stdin or --with-enter.
  Keys run in order, not simultaneously; + joins chords (Ctrl+C). No pauses.
  Key names are case-sensitive (1..64 keys):
    Enter Escape Tab Backspace Space; Up Down Left Right Home End Insert Delete
    PageUp PageDown F1..F12; Ctrl+A..Z, Ctrl+Space, Alt+letters/digits,
    Ctrl+Alt+letters, Shift+Tab. Navigation/F-keys accept Ctrl/Alt/Shift.
    Ctrl+Enter, Shift+Enter and Win keys are unsupported.
${observation}`,
  },
  read: {
    usage: ['read <id> [--full | --lines N] [--plain-text]'],
    summary: 'Read the current/latest command, or current screen without command markers / in a TUI.',
    details: `${readOptions}
  --plain-text   Text instead of JSON; includes omission notices.
  Does not change the terminal. Full reads do not include old commands.
  cursor is zero-based within returned text; absent if its row was omitted.`,
  },
  'wait-idle': {
    usage: ['wait-idle <id> [--idle-time N] [--timeout N] [--with-read]'],
    summary: 'Wait for an unchanged screen without sending input.',
    details: `${timingOptions}
  --with-read    Include a read after idle or timeout.
${readOptions}
  --lines/--full require --with-read.`,
  },
  scroll: {
    usage: ['scroll <id> up|down [--steps N] [--x N] [--y N]'],
    summary: 'Send wheel input to an SGR-mouse-enabled TUI; changes the shared view.',
    details: `  --steps N      Wheel steps, default 3 (1..100), not text lines.
  --x N --y N    1-based target cell; defaults to screen center.
  Unsupported mouse modes fail; no arrow-key fallback.
${observation}`,
  },
  resize: {
    usage: ['resize <id> --cols N --rows N'],
    summary: 'Resize the background PTY, or request the attached terminal window size.',
    details: `  --cols N       Required columns, 20..500.
  --rows N       Required rows, 5..200.
  Waits up to 3 seconds for size confirmation; --timeout controls only idle wait.
  Unconfirmed size returns applied=false, exit 3; the resize may still apply later.
${observation}`,
  },
  close: {
    usage: ['close <id> | close --all | close --idle'],
    summary: 'Terminate the hosted shell/session, including ongoing work; --all targets this TIDE_STATE_DIR, --idle closes only sessions waiting at a bash prompt with no display attached, the two flags are mutually exclusive and take no ID, and both return per-session results (untouched sessions report skipped: attached | command-running | prompt-unknown; exit 1 on any failure).',
  },
  plugin: {
    usage: ['plugin list | status <id>', 'plugin enable|disable <path>'],
    summary: 'List plugins, inspect session plugins or change the registry.',
    details: `  Registry changes apply to NEW sessions. Enable loads and validates local code
  with your privileges; disable removes a configured entry.
  tide <plugin-id> --help lists plugin commands; commands marked * accept --all.
  Local module paths resolve relative to plugins.json. Details: docs/plugins.md.`,
  },
};

export const commandHelp: Record<string, string> = Object.fromEntries(
  Object.entries(commands).map(([name, command]) => [name,
    `${command.usage.map(usage => `tide ${usage}`).join('\n')}\n\n${command.summary}${command.details ? `\n\n${command.details}` : ''}`]),
);

export function isReservedName(name: string): boolean {
  return name === 'help' || Object.hasOwn(commandHelp, name);
}

const overview = `tide — visible interactive shells shared by humans and agents

USAGE
  tide <command> | tide help [command] | tide <command> --help
  <id>: Tide session ID from list; unique prefixes accepted.

COMMANDS
${Object.values(commands).map(command => command.usage.map(usage => `  ${usage}`).join('\n') + `\n    ${command.summary}`).join('\n')}
  <plugin-id> <command> <id> [args...] | <plugin-id> --help
    Run or list plugin-specific commands.

  launch/send/scroll/resize also accept --wait-idle [--idle-time N] [--timeout N]
  and --with-read [--full | --lines N]. Launch requires --with-command.
  launch --attach opens a terminal display for the new session (Windows/macOS).
  wait-idle --with-read also accepts --full | --lines N.

Text does not auto-submit; use --with-enter.
written acknowledges input delivery; idle means an unchanged screen, not completion.
promptState is a visible shell prompt/execution boundary, not process or task status.
`;

export function help(command?: string): string {
  if (!command || command === 'help') return overview;
  if (!Object.hasOwn(commandHelp, command)) throw Error(`Unknown help topic: ${command}; use tide --help`);
  return `${commandHelp[command]}\n`;
}
