import { setTimeout as sleep } from "node:timers/promises";
import { requestSession } from "../session/ipc.js";
import { attachSession } from "../session/launch.js";
import { errorMessage, type Request, type SessionInfo, type IdleResult, type Snapshot } from "../session/types.js";
import { validateWait } from "../terminal/idle.js";
import { MAX_CAPTURE_LINES } from "../terminal/screen.js";

export interface WorkflowOptions {
  enter: boolean;
  attach?: boolean;
  wait: boolean;
  idleTime: number;
  timeout: number;
  read: boolean;
  full: boolean;
  lines?: number | undefined;
}

export interface WorkflowDeps {
  request: <T>(id: string, request: Request) => Promise<T>;
  attach: (id: string) => Promise<unknown>;
}

const workflow: WorkflowDeps = { request: requestSession, attach: attachSession };

// `waitImplied` is for the wait-idle command, where the command name itself is
// the wait, so --idle-time/--timeout are valid without --wait-idle.
export function afterSendOptions(args: string[], { allowEnter = false, waitImplied = false } = {}) {
  let wait = false, read = false, full = false, enter = false, idleTime = 3, timeout = 30, timing = false;
  let lines: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === "--wait-idle") wait = true;
    else if (name === "--with-enter" && allowEnter) enter = true;
    else if (name === "--with-read") read = true;
    else if (name === "--full") full = true;
    else if (name === "--lines") lines = readLines(args[++i]);
    else if (name === "--idle-time" || name === "--timeout") {
      const raw = args[++i];
      if (!raw?.trim()) throw Error(`${name} needs seconds`);
      if (name === "--idle-time") idleTime = Number(raw); else timeout = Number(raw);
      timing = true;
    } else throw Error(`Unknown operation option: ${name}; use tide help <command>`);
  }
  if (timing && !wait && !waitImplied) throw Error("--idle-time and --timeout require --wait-idle");
  if (lines !== undefined && !read) throw Error("--lines requires --with-read");
  if (full && !read) throw Error("--full requires --with-read");
  if (full && lines !== undefined) throw Error("--full and --lines are mutually exclusive");
  validateWait(idleTime, timeout);
  return { wait: wait || waitImplied, read, enter, idleTime, timeout, lines, full };
}

export function readLines(raw: string | undefined) {
  const lines = Number(raw);
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_CAPTURE_LINES) throw Error(`--lines must be 1..${MAX_CAPTURE_LINES}`);
  return lines;
}

export async function sendAndObserve(id: string, request: Extract<Request, { command: "send" | "scroll" | "resize" }>, options: WorkflowOptions, launched?: SessionInfo, deps: WorkflowDeps = workflow) {
  const result = await deps.request<{ id: string; written?: true; applied?: boolean }>(id, request);
  if (result.applied === false) process.exitCode = 3;
  const output: typeof result & { enterWritten?: true; attached?: true; display?: SessionInfo["display"]; wait?: IdleResult; read?: Snapshot; error?: { stage: string; message: string } } = { ...launched, ...result };
  let stage = "enter";
  try {
    // Pin follow-up requests to the acknowledged full ID, never re-resolve a prefix.
    if (options.enter) {
      // Let the foreground TUI process pasted text before submitting it.
      await sleep(150);
      await deps.request(result.id, { command: "send", keys: ["Enter"] });
      output.enterWritten = true;
    }
    if (options.attach) {
      stage = "attach";
      // Attachment may fail after opening a window; never close the session or resend.
      await deps.attach(result.id);
      output.attached = true;
      output.display = "attached";
    }
    stage = "wait-idle";
    if (options.wait) {
      output.wait = await deps.request<IdleResult>(result.id, { command: "wait-idle", idleTime: options.idleTime, timeout: options.timeout });
      if (!output.wait.idle) process.exitCode = 3;
    }
    stage = "read";
    if (options.read) output.read = await deps.request<Snapshot>(result.id, { command: "read", full: options.full, ...(options.lines === undefined ? {} : { lines: options.lines }) });
  } catch (error) {
    output.error = { stage, message: errorMessage(error) };
    if (stage === "attach") console.error(`Attach failed; the session was not closed; retry with: tide attach ${result.id}: ${output.error.message}`);
    else console.error(`Operation was acknowledged; ${stage} failed. Do not resend automatically: ${output.error.message}`);
    process.exitCode = 1;
  }
  console.log(JSON.stringify(output, null, 2));
}

// Rejects --attach on unsupported platforms before any session is launched.
export function assertAttachSupported(platform: NodeJS.Platform = process.platform) {
  if (!["win32", "darwin"].includes(platform)) throw Error("Opening a display supports Windows and macOS");
}

export type AttachResult = (SessionInfo & { attached: true; display: "attached" }) | (SessionInfo & { error: { stage: "attach"; message: string } });

// Attach a display to a session that has already been launched, keeping the
// session's own metadata in the result. Never closes or resends on failure.
export async function attachOnce(launched: SessionInfo, deps: Pick<WorkflowDeps, "attach"> = workflow): Promise<AttachResult> {
  try {
    await deps.attach(launched.id);
    return { ...launched, attached: true, display: "attached" };
  } catch (error) {
    return { ...launched, error: { stage: "attach", message: errorMessage(error) } };
  }
}
