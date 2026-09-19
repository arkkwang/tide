import { spawn, type ChildProcess } from "node:child_process";

const STDOUT_TAIL_BYTES = 64 * 1024;

export interface RunResult {
  /** Exit code; null when the process never started or was killed on timeout. */
  code: number | null;
  timedOut: boolean;
  /** Why it failed to start, as opposed to starting and then failing. */
  spawnError: string | null;
  out: string;
  err: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

/** Spawn a one-shot child process, capturing stdout (tailed) and stderr (full). */
export async function runChildProcess(
  bin: string,
  args: string[],
  opts: RunOptions,
): Promise<RunResult> {
  const child: ChildProcess = spawn(bin, args, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const ignore = () => {};
  child.stdin?.on("error", ignore);
  child.stdout?.on("error", ignore);
  child.stderr?.on("error", ignore);

  let out = "";
  let err = "";
  let spawnError: string | null = null;
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    out += chunk;
    if (out.length > STDOUT_TAIL_BYTES) {
      out = out.slice(-STDOUT_TAIL_BYTES);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    err += chunk;
  });

  return await new Promise<RunResult>((resolve) => {
    const settle = (code: number | null) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({ code, timedOut, spawnError, out, err });
    };
    child.once("error", (e) => {
      spawnError = e.message;
      settle(null);
    });
    // `close`, not `exit`: it fires after stdio ends, so `out` and `err` are complete.
    child.once("close", (code) => settle(code));

    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
      settle(null);
    }, opts.timeoutMs);
  });
}

/** Flatten an OpenAI/Claude-style `content` payload to a string; non-text parts contribute nothing. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "",
      )
      .join(" ");
  }
  return "";
}

const MESSAGE_CHARS = 300;

/** Collapse whitespace and truncate to one line. */
export function oneLine(text: string, maxChars = MESSAGE_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > maxChars ? `${t.slice(0, maxChars)}…` : t;
}

/** Render a duration in milliseconds as `Nh Nm`, `Nm Ns`, or `Ns`. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

/** The first 8 characters of a session id. */
export function short(id: string): string {
  return id.slice(0, 8);
}

/** Local-time `HH:MM:SS`, for operator-facing logs. */
export function localTimestamp(d: Date = new Date()): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/** A duration as "X hour(s) Y minute(s) Z second(s)"; `formatDuration` is the compact form. */
export function humanizeIdleDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  }
  if (seconds > 0) {
    parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) {
    parts.push("0 seconds");
  }
  return parts.join(" ");
}