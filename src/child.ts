import { spawn, type ChildProcess } from "node:child_process";

export const KEEP_BYTES = 64 * 1024;

const MESSAGE_CHARS = 300;

export function oneLine(text: string, maxChars = MESSAGE_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > maxChars ? `${t.slice(0, maxChars)}…` : t;
}

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

/** Windows Store app-execution aliases sit under `\WindowsApps\` and exist as far as the
 * filesystem is concerned, but fail to launch with `Access is denied` (WinError 5). */
export function isStoreShim(path: string): boolean {
  return /[\\/]WindowsApps[\\/]/i.test(path);
}

class Tail {
  private text = "";

  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > KEEP_BYTES) this.text = this.text.slice(-KEEP_BYTES);
  }

  value(): string {
    return this.text;
  }
}

/** Fed as it arrives, because `run` keeps only the last `KEEP_BYTES` and the records worth
 * watching for are written early. Line buffered: a chunk boundary is not a line boundary. */
export class Witness {
  private buffer = "";
  private found = false;

  constructor(private readonly accepts: (record: Record<string, unknown>) => boolean) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (this.found || !line.trim()) continue;
      try {
        if (this.accepts(JSON.parse(line) as Record<string, unknown>)) this.found = true;
      } catch {
      }
    }
  }

  get seen(): boolean {
    return this.found;
  }
}

export interface RunResult {
  /** Exit code; null when the process never started, or was killed on timeout. */
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
  onStdout?: (chunk: string) => void;
}

export async function run(bin: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const child: ChildProcess = spawn(bin, args, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Killing a child mid-write surfaces as EPIPE here; an unhandled `error` event on a stream
  // takes the whole watcher down with it.
  const ignore = () => {};
  child.stdin?.on("error", ignore);
  child.stdout?.on("error", ignore);
  child.stderr?.on("error", ignore);

  const out = new Tail();
  const err = new Tail();
  let spawnError: string | null = null;
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;

  const onOut = (chunk: Buffer) => {
    const text = chunk.toString();
    out.push(text);
    opts.onStdout?.(text);
  };
  const onErr = (chunk: Buffer) => err.push(chunk.toString());
  child.stdout?.on("data", onOut);
  child.stderr?.on("data", onErr);

  return await new Promise<RunResult>((resolve) => {
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdout?.off("data", onOut);
      child.stderr?.off("data", onErr);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, timedOut, spawnError, out: out.value(), err: err.value() });
    };

    child.once("error", (e) => {
      spawnError = e.message;
      settle(null);
    });
    // `close`, not `exit`: it fires once the stdio streams have ended too, so the output
    // collected by the time this resolves is complete.
    child.once("close", (code) => settle(code));

    timer = setTimeout(() => {
      timedOut = true;
      void killTree(child).then(() => settle(child.exitCode));
    }, opts.timeoutMs);
  });
}

/** On Windows `child.kill()` signals only the process we spawned, and both CLIs are launchers
 * that fork the real worker, so killing the launcher leaves the worker holding the session. */
export function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return new Promise<void>((resolve) => {
        killer.once("exit", () => resolve());
        killer.once("error", () => resolve());
      });
    } catch {
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
  }
  return Promise.resolve();
}
