English | [简体中文](README.md)

# Tide

**Let an agent operate a terminal—and let a human step into the same session.**

Tide is an interactive terminal tool for humans and agents working together. It hosts Bash sessions in the background so an agent can send text and keys and read the screen through a CLI. When a person needs to get involved, they can open a terminal window and continue with the program already running there.

## Why Tide exists

For running a command and collecting its output, a regular shell execution tool is enough. But many tasks span more than one call: a coding assistant keeps a conversation open, a REPL retains variables, and an installer pauses for a choice. An agent needs to continue interacting, while a person may want to inspect the work or handle a step themselves.

The missing piece is not another command invocation. It is **keeping that interaction alive and making it accessible to both the human and the agent**.

Tide separates the session from its window. Programs run in the background, where an agent can operate them without opening a window. A person can `attach` to the same session; closing that window leaves the program running. Attaching again does not restart it or require rebuilding its interactive state.

## What it offers

- **Continue the same work.** The shell's directory, environment and foreground program stay in one session. Keep entering expressions into a Node REPL or continue a conversation with a CLI assistant.
- **One terminal for the human and the agent.** The agent uses `send` and `read`; the person uses a real terminal for viewing and input. They are not running separate copies and synchronizing results.
- **Read a screen, not just concatenated output.** Tide interprets cursor movement, clearing and overwriting to produce a text view of the terminal. Menus, progress displays and text-based terminal interfaces (TUIs) can be operated through screen reads and keys without controlling desktop focus.
- **An explicit agent interface.** Stable session IDs, JSON output and combined “send → wait for a quiet screen → read” operations let callers inspect the result before deciding what to do next. Default reads preview the current/latest command instead of requiring the whole terminal history.
- **No dependency on a particular AI product.** Claude Code, Codex, REPLs and other interactive CLIs are ordinary programs inside Bash. The core provides terminal operations; plugins can add application-specific detection and actions.

## When to use it

| What you need | Better fit |
| --- | --- |
| An agent operates an interactive CLI while a person occasionally inspects or takes over | Tide |
| Repeated input into the same REPL, menu or terminal application, guided by its screen | Tide |
| Run a script, execute tests or collect a one-shot command result | A regular shell / command execution tool |
| Keep complete logs or search large amounts of output | Write to a file, then use file-reading and search tools |

Tide manages **sessions it launches**, not arbitrary existing terminal windows. It does not decide whether a business task is complete or recover sessions after a host crash or machine reboot.

## Install

Requires **Node.js 20+ and Bash >= 4.4**. Only supported Bash versions are accepted; older Bash and other shells are rejected before a session is created.

```bash
npm install -g @arkkwang/tide
```

- **Windows:** Install an up-to-date Git Bash and add it to PATH. Opening a display requires Windows Terminal. Use `tide` from Git Bash where possible.
- **macOS:** The system Bash 3.2 is too old. Install a newer Bash and select it for Tide; there is no need to change your default login shell:

  ```bash
  brew install bash
  export TIDE_SHELL=/opt/homebrew/bin/bash
  # Intel Macs usually use /usr/local/bin/bash
  ```

You can also choose Bash with `--shell` on each `launch`. On macOS, Tide automatically adds missing execute permission to the `node-pty` helper before startup. If it cannot do so, it reports the path and error; it never uses `sudo`.

## Try a human–agent handoff

Use the Node REPL—no additional application is required:

```bash
# 1. Start a background Node REPL; return a session ID and screen
#    Inspect the result and confirm that Node's > prompt is visible
#    Add --cwd /path/to/project to choose a working directory
tide launch --with-command "node" --wait-idle --with-read
```

Replace `5fefa` below with the returned session ID or an unambiguous prefix:

```bash
# 2. The agent enters an expression into this REPL and reads the result
tide send 5fefa '1 + 1' --with-enter --wait-idle --with-read

# 3. A person opens the same REPL and can enter expressions themselves
tide attach 5fefa

# 4. After closing the display window, the REPL remains in the background
tide read 5fefa

# 5. End the entire session when it is no longer needed
tide close 5fefa
```

`attach` opens a Windows Terminal tab or a macOS Terminal window, not the current terminal. A session can have at most one display connected.

For a CLI assistant, replace `node` with an installed `claude` or `codex`. If startup needs interaction or readiness is uncertain, first use `tide launch`, then inspect the screen with `tide wait-idle <id> --with-read` before sending a command.

## Use it from an agent

Tide provides a CLI. An agent that can execute local commands can call it; there are no model or API-key settings in Tide.

```bash
tide --help              # Discover core commands
tide help send           # Check parameters and result semantics
tide list                # Find existing sessions
tide read 5fefa           # Inspect the current screen before deciding what to send
```

Keep three things in mind:

1. **Text is not submitted by default.** `send` fills in text; add `--with-enter` to submit it, or use `--key Enter` separately.
2. **A quiet screen does not mean completion.** `wait-idle` only watches for an unchanged screen. A timeout neither stops the program nor justifies resending the task. Judge from the returned screen.
3. **This is a shared, live session.** Human and agent input can interleave, and the foreground program may exit. Confirm the current program and environment before important actions; a sequence of calls is not an exclusive transaction.

By default, `read` returns the first 10 and last 30 lines of the current/latest command. Use `--full` or `--lines N` when more is needed. TUIs are read as the current screen. See the [CLI reference](docs/cli-reference.en.md) for text, keys, scrolling, sizing and plugins.

## State, support and limits

- **State defaults to `~/.tide` on both platforms**, overridable with `TIDE_STATE_DIR`, separate from the installation and system temporary directories. Unix sockets use short paths inside it; Windows uses named pipes.
- **Background sessions do not depend on a display window**, but do depend on their host process staying alive. Closing a window disconnects the display; `close` terminates the whole session and its work.
- **Windows and macOS** background PTY flows have test coverage. Windows Terminal has desktop acceptance evidence; macOS window interaction still needs hands-on acceptance. Linux and other platforms are unverified.
- **Terminal emulation has limits.** Retained screen content is not a complete log. Image protocols, vendor-specific extensions and untested applications are not guaranteed to restore correctly.

Upgrading involves the state directory and the removed `run` command, launch profiles and recovery plugins. Read the [migration notes](docs/cli-reference.en.md#verification-and-migration). Upgrading does not automatically move old state directories or stop existing sessions.

## Develop and extend

```bash
git clone https://github.com/arkkwang/tide.git
cd tide
npm install
npm run link:local       # Build and register the local tide command
npm run typecheck
npm test
```

Use `npm run build` after ordinary source changes. Link again after changing the npm command entry point. `npm test` includes real PTY tests and rebuilds `dist`.

- [CLI reference](docs/cli-reference.en.md): commands, results, startup troubleshooting and migration.
- [Background sessions and displays](docs/background-sessions.md) (Chinese): session lifetime and reattachment.
- [Plugin contract and examples](docs/plugins.md) (Chinese): add application-specific capabilities; load only trusted local code.
- [Terminal read boundaries](docs/open-questions.md) (Chinese): current guarantees and open questions.

## License

[MIT](LICENSE)
