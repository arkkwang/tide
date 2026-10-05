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
    usage: ['launch [--shell executable] [--cwd directory] [--with-command text | --profile label]'],
    summary: 'Start a background shell session without opening a window; return its Tide ID.',
    details: `${shellOptions}
  --with-command text  Send a single-line command followed by Enter.
  --profile label      Run a saved profile; exclusive with --with-command.
  -- args...           Shell arguments, or arguments for the profile's last command.
  Command/profile startup waits for 3 quiet seconds (30-second limit).
  Startup timeout sends nothing; later failures may have delivered input.
  Observation options require --with-command or --profile:
${observation}`,
  },
  attach: {
    usage: ['attach <id>'],
    summary: 'Open a Windows Terminal tab / macOS Terminal window for an existing session.',
    details: '  One display per session; an attached or opening display rejects another attach.\n  Closing this display disconnects it without ending the session.',
  },
  run: {
    usage: ['run [--shell executable] [--cwd directory] [-- shell-args...]'],
    summary: 'Create a background session and attach this real TTY; exit code follows the shell.',
    details: `${shellOptions}\n  Closing the terminal disconnects the display; the session keeps running.`,
  },
  list: {
    usage: ['list'],
    summary: 'List live Tide sessions as JSON, including lastCommand (null when unknown).',
  },
  info: {
    usage: ['info <id>'],
    summary: 'Return shell metadata and lastCommand as JSON, not semantic task status.',
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
    usage: ['close <id>'],
    summary: 'Terminate the hosted shell/session, including ongoing work.',
  },
  profiles: {
    usage: ['profiles'],
    summary: 'List saved launch profiles as JSON.',
    details: '  Source: TIDE_STATE_DIR/launch-profiles.json; override with TIDE_LAUNCH_PROFILES.',
  },
  plugin: {
    usage: ['plugin list | status <id>', 'plugin enable|disable <name|path>'],
    summary: 'List plugins, inspect session plugins or change the registry.',
    details: `  Registry changes apply to NEW sessions. Enable loads and validates local code
  with your privileges; disable removes a configured entry.
  tide <plugin-id> --help lists plugin commands; commands marked * accept --all.
  Recovery plugins cxr/ccr are off until watch; recovery can send input and probes
  consume tokens. Details: docs/plugins.md and docs/resume-plugins.md.`,
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
  and --with-read [--full | --lines N]. Launch requires --with-command/--profile.
  wait-idle --with-read also accepts --full | --lines N.

Text does not auto-submit; use --with-enter.
written acknowledges input delivery; idle means an unchanged screen, not completion.
`;

export function help(command?: string): string {
  if (!command || command === 'help') return overview;
  if (!Object.hasOwn(commandHelp, command)) throw Error(`Unknown help topic: ${command}; use tide --help`);
  return `${commandHelp[command]}\n`;
}
