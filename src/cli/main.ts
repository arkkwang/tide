import { readFileSync } from "node:fs";
import { runSession } from "../session/host.js";
import { launchSession, consumeLaunch, attachSession } from "../session/launch.js";
import { viewSession } from "../session/view.js";
import { liveSessions, requestSession } from "../session/ipc.js";
import { stateDirectory } from "../session/registry.js";
import { errorMessage, type SessionInfo, type ShellOptions, type Snapshot, type IdleResult } from "../session/types.js";
import { validateSize } from "../terminal/resize.js";
import { buildLaunchShellCommand, findProfile, loadProfiles, type ProfileEntry } from "../profile-config/index.js";
import { loadPlugins, pluginList, setPluginEnabled, type TidePlugin } from "../plugins/runtime.js";

import { commandHelp, help } from "./help.js";
import { afterSendOptions, sendAndObserve, attachOnce, readLines, assertAttachSupported } from "./workflow.js";

function shellOptions(args: string[]): ShellOptions {
  const options: ShellOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { options.args = args.slice(i + 1); break; }
    if (arg !== "--shell" && arg !== "--cwd") throw Error(`Unknown launch option: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw Error(`${arg} needs a value`);
    if (arg === "--shell") options.shell = value; else options.cwd = value;
  }
  return options;
}

type AugmentedSession = SessionInfo & { profile?: string; index?: number; command?: string; commands?: string[] };

// Adds profile identity fields for JSON output. `command` (the binary name)
// is omitted when the first command's argv is empty; this is only possible
// when a profile's commands array is malformed, since loadProfiles rejects it.
function augmentedSession(info: SessionInfo, profile: ProfileEntry): AugmentedSession {
  const first = profile.commands[0]?.[0];
  return {
    ...info,
    profile: profile.label,
    index: profile.index,
    commands: profile.commands.map((argv) => argv.join(" ")),
    ...(first === undefined ? {} : { command: first }),
  };
}

function expectCount(args: string[], minimum: number, maximum = minimum) {
  if (args.length < minimum || args.length > maximum) throw Error("Invalid arguments; use tide --help");
}

// `tide <plugin id> <command> <session id> [args...]`. The plugin id is its own
// namespace, so plugin commands can never shadow a core command or another
// plugin's. The CLI only resolves the namespace against plugin metadata and
// routes to the named session's host, where the command's code runs; the CLI
// never executes plugin code itself.
async function pluginCommand(id: string, args: string[]): Promise<void> {
  const plugin = (await loadPlugins(stateDirectory())).find((candidate) => candidate.id === id);
  if (!plugin) throw Error(`Unknown command: ${id}; use tide --help`);
  const [name, ...rest] = args;
  if (name === undefined || ["--help", "-h"].includes(name)) { console.log(pluginHelp(plugin)); return; }
  if (!Object.hasOwn(plugin.commands ?? {}, name)) throw Error(`Unknown command: ${id} ${name}; use tide ${id} --help`);
  const command = plugin.commands![name]!;
  const [sessionId, ...commandArgs] = rest;
  if (sessionId === "--all") {
    if (!command.all) throw Error(`tide ${id} ${name} does not take --all; it needs one session ID`);
    print(await everySession(plugin, name, commandArgs));
    return;
  }
  if (!sessionId) throw Error(`tide ${id} ${name} requires a session ID${command.all ? " or --all" : ""}; use tide list`);
  print(await requestSession(sessionId, { command: "plugin", plugin: id, action: name, args: commandArgs }));
}

// A command marked `all` is meaningful for every matching session, so `--all`
// may stand in for the session id. The CLI asks each live session which plugins
// it matches and runs the command in those hosts; the result is one
// {id, result|error} per matching session, and one session's failure never
// hides the others' results.
async function everySession(plugin: TidePlugin, name: string, args: string[]) {
  const results = await Promise.all((await liveSessions()).map(async ({ info }) => {
    try {
      const matches = await requestSession<Array<{ id: string; matched: boolean }>>(info.id, { command: "plugins" });
      if (!matches.some((entry) => entry.id === plugin.id && entry.matched)) return null;
      return { id: info.id, result: await requestSession(info.id, { command: "plugin", plugin: plugin.id, action: name, args }) };
    } catch (error) { return { id: info.id, error: errorMessage(error) }; }
  }));
  return results.filter((entry) => entry !== null);
}

function pluginHelp(plugin: TidePlugin): string {
  const commands = Object.entries(plugin.commands ?? {});
  const note = commands.some(([, command]) => command.all)
    ? "\n* Accepts --all: runs in each matching session; returns [{id, result|error}]."
    : "";
  return `tide ${plugin.id} <command> <session id> [args...]

${plugin.name}

COMMANDS
${commands.length ? commands.map(([name, command]) => `  ${(name + (command.all ? "*" : "")).padEnd(10)} ${command.description}`).join("\n") : "  (none)"}

Use a Tide ID from tide list. Commands run in that session only if the plugin
matches; extra arguments are passed unchanged.${note}
`;
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) { expectCount(args, 0, 1); console.log(help(args[0])); return; }
  // Background hosts drain node-pty's cleanup naturally after unregistering.
  if (command === "__host") { if (args.length !== 1 && args.length !== 2) throw Error("Invalid terminal launch arguments"); process.exitCode = await runSession(consumeLaunch(args[0]!, args[1]), args[0]); return; }
  if (command === "__view") { expectCount(args, 3); process.exitCode = await viewSession(args[0]!, args[1]!, args[2]!); return; }
  // Anything that is not a core command can only be a plugin namespace.
  if (!Object.hasOwn(commandHelp, command)) { await pluginCommand(command, args); return; }
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) { console.log(help(command)); return; }

  if (command === "run") {
    const options = shellOptions(args);
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error("tide run needs an interactive terminal; use tide launch for a background session");
    const session = await launchSession(options);
    console.error(`[tide] ${session.id}`);
    const { ticket } = await requestSession<{ ticket: string }>(session.id, { command: "attach-reserve" });
    try { process.exitCode = await viewSession(session.id, stateDirectory(), ticket); }
    finally { await requestSession(session.id, { command: "attach-cancel", ticket }).catch(() => {}); }
    return;
  }
  if (command === "launch") {
    const shellArgs: string[] = [], observation: string[] = [];
    let text: string | undefined;
    let profile: ProfileEntry | undefined;
    let binArgs: string[] = [];
    let attach = false;
    const profileCache = (process.env.TIDE_LAUNCH_PROFILES || args.some((arg) => arg === "--profile"))
      ? loadProfiles(stateDirectory())
      : { path: "", profiles: [] };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--") {
        if (profile) binArgs = args.slice(i + 1);
        else shellArgs.push(...args.slice(i));
        break;
      }
      if (arg === "--with-command") {
        if (text !== undefined) throw Error("--with-command may only be supplied once");
        if (profile !== undefined) throw Error("--with-command cannot combine with --profile");
        text = args[++i];
        if (!text?.trim() || text.startsWith("--")) throw Error("--with-command needs a command");
      } else if (arg === "--profile") {
        if (profile !== undefined) throw Error("--profile may only be supplied once");
        if (text !== undefined) throw Error("--profile cannot combine with --with-command");
        const label = args[++i];
        if (!label || label.startsWith("--")) throw Error("--profile needs a label");
        profile = findProfile(profileCache.profiles, label) ?? undefined;
        if (!profile) {
          const list = profileCache.profiles.map((p) => `  ${p.index}. ${p.label}${p.description ? ` — ${p.description}` : ""}`).join("\n");
          throw Error(`Unknown profile: ${label}\nLoaded from ${profileCache.path}\nAvailable:\n${list}`);
        }
      } else if (arg === "--attach") {
        if (attach) throw Error("--attach may only be supplied once");
        attach = true;
      } else if (arg === "--shell" || arg === "--cwd") {
        shellArgs.push(arg);
        if (args[i + 1] !== undefined) shellArgs.push(args[++i]!);
      } else {
        observation.push(arg);
        if (["--idle-time", "--timeout", "--lines"].includes(arg) && args[i + 1] !== undefined) observation.push(args[++i]!);
      }
    }
    const shell = shellOptions(shellArgs);
    const options = afterSendOptions(observation);
    if (profile) {
      const cwd = shell.cwd;
      text = buildLaunchShellCommand(profile, profileCache.profiles, binArgs, cwd);
    }
    if (text === undefined && observation.length) throw Error("Launch observation options require --with-command or --profile");
    if (text !== undefined && /[\x00-\x1f\x7f-\x9f]/.test(text)) throw Error("--with-command requires a single line without control characters");
    // Reject unsupported platforms before creating the session.
    if (attach) assertAttachSupported();
    const launched = await launchSession(shell);
    if (text === undefined) {
      if (!attach) { print(launched); return; }
      const attached = await attachOnce(launched);
      print(attached);
      if ("error" in attached) { console.error(`Attach failed; session ${launched.id} was not closed; retry with: tide attach ${launched.id}: ${attached.error.message}`); process.exitCode = 1; }
      return;
    }
    const launchedForPrint = profile ? augmentedSession(launched, profile) : launched;
    let stage = "startup";
    try {
      const startup = await requestSession<IdleResult>(launched.id, { command: "wait-idle", idleTime: 3, timeout: 30 });
      if (!startup.idle) throw Error("Startup screen did not settle within 30 seconds; command was not sent");
      stage = "send";
      await sendAndObserve(launched.id, { command: "send", text }, { ...options, enter: true, attach }, launchedForPrint);
    } catch (error) {
      print({ ...launchedForPrint, error: { stage, message: errorMessage(error) } });
      console.error("Session was launched; " + stage + " failed. Inspect this session before retrying: " + errorMessage(error));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "profiles") {
    expectCount(args, 0);
    const loaded = loadProfiles(stateDirectory());
    print({
      path: loaded.path,
      profiles: loaded.profiles.map((p) => ({ index: p.index, label: p.label, description: p.description, command: p.commands[0]?.[0], commands: p.commands.map((argv) => argv.join(" ")), envKeyCount: Object.keys(p.env).length })),
    });
    return;
  }
  if (command === "plugin") {
    const [action, ...rest] = args;
    if (action === undefined) { console.log(help("plugin")); return; }
    if (action === "list") { expectCount(rest, 0); print(await pluginList(stateDirectory())); return; }
    if (action === "enable" || action === "disable") {
      const [selector, ...extra] = rest;
      if (!selector) throw Error(`plugin ${action} requires a bundled plugin name or a module path`);
      expectCount(extra, 0);
      const file = await setPluginEnabled(stateDirectory(), selector, action === "enable");
      // The file is the whole state: a host already running keeps what it loaded.
      console.error(`Saved ${file}; the change applies to new sessions.`);
      print(await pluginList(stateDirectory())); return;
    }
    if (action !== "status") throw Error(`Unknown command: plugin ${action}; use tide --help`);
    const [id, ...extra] = rest;
    if (!id) throw Error("plugin status requires a session ID");
    expectCount(extra, 0);
    print(await requestSession(id, { command: "plugins" }));
    return;
  }
  if (command === "list") { expectCount(args, 0); print((await liveSessions()).map(({ info }) => info)); return; }
  const [id, ...rest] = args;
  if (!id) throw Error(`${command} requires a session ID`);
  switch (command) {
    case "scroll": case "resize": {
      const values: Record<string, number> = {};
      const observation: string[] = [];
      const names = command === "scroll" ? ["--steps", "--x", "--y"] : ["--cols", "--rows"];
      for (let i = command === "scroll" ? 1 : 0; i < rest.length; i++) {
        const arg = rest[i]!;
        if (names.includes(arg)) {
          const raw = rest[++i];
          if (!raw?.trim() || !Number.isInteger(Number(raw))) throw Error(`${arg} requires an integer`);
          values[arg] = Number(raw);
        } else observation.push(arg);
      }
      const options = afterSendOptions(observation);
      if (command === "scroll") {
        const direction = rest[0], steps = values["--steps"] ?? 3;
        if (direction !== "up" && direction !== "down") throw Error("scroll requires up or down");
        if (steps < 1 || steps > 100) throw Error("--steps must be 1..100");
        await sendAndObserve(id, { command, direction, steps, ...(values["--x"] === undefined ? {} : { x: values["--x"] }), ...(values["--y"] === undefined ? {} : { y: values["--y"] }) }, options);
      } else {
        const cols = values["--cols"]!, rows = values["--rows"]!;
        validateSize(cols, rows);
        await sendAndObserve(id, { command, cols, rows }, options);
      }
      break;
    }
    case "send": {
      expectCount(rest, 1, Infinity);
      if (rest[0] === "--key") {
        const input = rest.slice(1);
        if (input.includes("--stdin") || input.includes("--key")) throw Error("Choose one input mode: text, --stdin, or --key; mixed input is not supported");
        if (input.includes("--with-enter")) throw Error("--with-enter is for text only; append Enter to the --key sequence instead");
        const optionIndex = input.findIndex((arg) => arg.startsWith("--"));
        const keys = optionIndex < 0 ? input : input.slice(0, optionIndex);
        if (keys.length < 1 || keys.length > 64) throw Error("--key requires 1..64 keys; e.g. --key Up Enter (in order), or --key Ctrl+C (a chord)");
        const options = afterSendOptions(optionIndex < 0 ? [] : input.slice(optionIndex));
        await sendAndObserve(id, { command, keys }, options);
      } else {
        if (rest.slice(1).includes("--key")) throw Error("Text cannot combine with --key; use --with-enter to submit text, or separate send calls for other keys");
        const options = afterSendOptions(rest.slice(1), { allowEnter: true });
        if (rest[0] === "--stdin" && process.stdin.isTTY) throw Error("--stdin requires piped input");
        const text = rest[0] === "--stdin" ? readFileSync(0, "utf8") : rest[0]!;
        await sendAndObserve(id, { command, text }, options);
      }
      break;
    }
    case "read": {
      let lines: number | undefined, plain = false, full = false;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--plain-text") plain = true;
        else if (rest[i] === "--full") full = true;
        else if (rest[i] === "--lines") {
          lines = readLines(rest[++i]);
        } else throw Error(`Unknown read option: ${rest[i]}`);
      }
      if (full && lines !== undefined) throw Error("--full and --lines are mutually exclusive");
      const snapshot = await requestSession<Snapshot>(id, { command, full, ...(lines === undefined ? {} : { lines }) });
      if (plain) process.stdout.write(snapshot.text + "\n"); else print(snapshot);
      break;
    }
    case "wait-idle": {
      const options = afterSendOptions(rest, { waitImplied: true });
      const result = await requestSession<IdleResult>(id, { command, idleTime: options.idleTime, timeout: options.timeout });
      if (!result.idle) process.exitCode = 3;
      const output: IdleResult & { read?: Snapshot; error?: { stage: string; message: string } } = { ...result };
      if (options.read) {
        try {
          output.read = await requestSession<Snapshot>(result.id, { command: "read", full: options.full, ...(options.lines === undefined ? {} : { lines: options.lines }) });
        } catch (error) {
          output.error = { stage: "read", message: errorMessage(error) };
          console.error(`Read after waiting failed: ${output.error.message}`);
          process.exitCode = 1;
        }
      }
      print(output);
      break;
    }
    case "attach": expectCount(rest, 0); print(await attachSession(id)); break;
    case "info": case "close": expectCount(rest, 0); print(await requestSession(id, { command })); break;
    default: throw Error(`Unknown command: ${command}; use tide --help`);
  }
}
function print(value: unknown) { console.log(JSON.stringify(value ?? null, null, 2)); }
main().catch((error) => {
  console.error(errorMessage(error));
  const command = process.argv[2];
  if (command && Object.hasOwn(commandHelp, command)) console.error(`Usage help: tide help ${command}`);
  process.exitCode = 1;
});
