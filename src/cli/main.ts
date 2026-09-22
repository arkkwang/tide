import { readFileSync } from "node:fs";
import { runSession } from "../terminal/host.js";
import { launchSession, consumeLaunch } from "../terminal/launch.js";
import { liveSessions, requestSession } from "../terminal/ipc.js";
import { errorMessage, type ShellOptions, type Snapshot, type IdleResult, type Request } from "../terminal/types.js";
import { validateWait } from "../terminal/idle.js";

import { commandHelp, help } from "./help.js";

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

function expectCount(args: string[], minimum: number, maximum = minimum) {
  if (args.length < minimum || args.length > maximum) throw Error("Invalid arguments; use tide --help");
}

function afterSendOptions(args: string[]) {
  let wait = false, capture = false, idleTime = 2, timeout = 30, timing = false;
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === "--wait-idle") wait = true;
    else if (name === "--with-capture") capture = true;
    else if (name === "--idle-time" || name === "--timeout") {
      const raw = args[++i];
      if (!raw?.trim()) throw Error(`${name} needs seconds`);
      if (name === "--idle-time") idleTime = Number(raw); else timeout = Number(raw);
      timing = true;
    } else throw Error(`Unknown send option: ${name}; put options after the text/keys`);
  }
  if (timing && !wait) throw Error("--idle-time and --timeout require --wait-idle");
  validateWait(idleTime, timeout);
  return { wait, capture, idleTime, timeout };
}

async function sendAndObserve(id: string, request: Extract<Request, { command: "send" | "send-key" }>, options: ReturnType<typeof afterSendOptions>) {
  const result = await requestSession<{ id: string; written: true }>(id, request);
  const output: typeof result & { wait?: IdleResult; capture?: Snapshot; error?: { stage: string; message: string } } = { ...result };
  let stage = "wait-idle";
  try {
    // Pin follow-up requests to the acknowledged full ID, never re-resolve a prefix.
    if (options.wait) {
      output.wait = await requestSession<IdleResult>(result.id, { command: "wait-idle", idleTime: options.idleTime, timeout: options.timeout });
      if (!output.wait.idle) process.exitCode = 3;
    }
    stage = "capture";
    if (options.capture) output.capture = await requestSession<Snapshot>(result.id, { command: "capture" });
  } catch (error) {
    output.error = { stage, message: errorMessage(error) };
    console.error(`Input was written; ${stage} failed. Do not resend automatically: ${output.error.message}`);
    process.exitCode = 1;
  }
  print(output);
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) { expectCount(args, 0, 1); console.log(help(args[0])); return; }
  if (command !== "__host" && !Object.hasOwn(commandHelp, command)) throw Error(`Unknown command: ${command}; use tide --help`);
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) { console.log(help(command)); return; }
  // Native terminal handles may remain referenced after shell exit on Windows.
  // runSession has already stopped plugins, unregistered IPC and flushed the terminal.
  if (command === "__host") { expectCount(args, 1); process.exit(await runSession(consumeLaunch(args[0]!), args[0])); }
  if (command === "run") { process.exit(await runSession(shellOptions(args))); }
  if (command === "launch") { print(await launchSession(shellOptions(args))); return; }
  if (command === "list") { expectCount(args, 0); print((await liveSessions()).map(({ info }) => info)); return; }
  const [id, ...rest] = args;
  if (!id) throw Error(`${command} requires a session ID`);
  switch (command) {
    case "send": {
      expectCount(rest, 1, Infinity);
      const options = afterSendOptions(rest.slice(1));
      if (rest[0] === "--stdin" && process.stdin.isTTY) throw Error("--stdin requires piped input");
      const text = rest[0] === "--stdin" ? readFileSync(0, "utf8") : rest[0]!;
      await sendAndObserve(id, { command, text }, options); break;
    }
    case "send-key": {
      const optionIndex = rest.findIndex((arg) => arg.startsWith("--"));
      const keys = optionIndex < 0 ? rest : rest.slice(0, optionIndex);
      const options = afterSendOptions(optionIndex < 0 ? [] : rest.slice(optionIndex));
      expectCount(keys, 1, 64);
      await sendAndObserve(id, { command, keys }, options); break;
    }
    case "capture": {
      let lines: number | undefined, plain = false;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--plain-text") plain = true;
        else if (rest[i] === "--lines") {
          lines = Number(rest[++i]);
          if (!Number.isInteger(lines) || lines < 1 || lines > 2000) throw Error("--lines must be 1..2000");
        } else throw Error(`Unknown capture option: ${rest[i]}`);
      }
      const snapshot = await requestSession<Snapshot>(id, { command, ...(lines === undefined ? {} : { lines }) });
      if (plain) process.stdout.write(snapshot.text + "\n"); else print(snapshot);
      break;
    }
    case "wait-idle": {
      let idleTime = 2, timeout = 30;
      for (let i = 0; i < rest.length; i++) {
        const name = rest[i];
        if (name !== "--idle-time" && name !== "--timeout") throw Error(`Unknown wait-idle option: ${name}`);
        const raw = rest[++i];
        if (!raw?.trim()) throw Error(`${name} needs seconds`);
        if (name === "--idle-time") idleTime = Number(raw); else timeout = Number(raw);
      }
      validateWait(idleTime, timeout);
      const result = await requestSession<IdleResult>(id, { command, idleTime, timeout });
      print(result); if (!result.idle) process.exitCode = 3;
      break;
    }
    case "info": case "close": case "plugins": expectCount(rest, 0); print(await requestSession(id, { command })); break;
    case "plugin": expectCount(rest, 2, Infinity); print(await requestSession(id, { command, plugin: rest[0]!, action: rest[1]!, args: rest.slice(2) })); break;
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
