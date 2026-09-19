import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type FilterPolicy, type CodexConfig } from "./config.js";
import { messageText, oneLine, runChildProcess } from "./util.js";
import {
  SPOKEN_CHARS,
  SPOKEN_COUNT,
  type Adapter,
  type InterruptedSession,
  type QuotaInfo,
  type ResumeResult,
  type Utterance,
  type WindowInfo,
} from "./watch.js";

/** Windows Store app-execution aliases sit under `\WindowsApps\` and exist as far as the
 * filesystem is concerned, but fail to launch with `Access is denied` (WinError 5). */
function isStoreShim(path: string): boolean {
  return /[\\/]WindowsApps[\\/]/i.test(path);
}

const QUOTA_ERROR_TAGS = new Set(["usage_limit_exceeded", "rate_limit_exceeded"]);

const STDERR_KEEP = 20;
const STDERR_SHOW = 3;

const CLIENT_INFO = { name: "tide", title: "Tide", version: "0.1.0" };

const RPC_TIMEOUT_MS = 20_000;

interface RateLimitWindow {
  usedPercent?: number;
  used_percent?: number;
  windowDurationMins?: number | null;
  window_minutes?: number | null;
  resetsAt?: number | null;
  resets_at?: number | null;
}

export interface RateLimitsReadResult {
  ordinaryUsageAllowed?: boolean | null;
  rateLimits?: {
    limitId?: string;
    planType?: string | null;
    primary?: RateLimitWindow | null;
    secondary?: RateLimitWindow | null;
    rateLimitReachedType?: string | null;
    credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string } | null;
  } | null;
  rateLimitsByLimitId?: Record<string, RateLimitsReadResult["rateLimits"]> | null;
  rateLimitResetCredits?: { availableCount?: number } | null;
}

function windowUsed(w: RateLimitWindow | null | undefined): number | null {
  const used = w?.usedPercent ?? w?.used_percent;
  return typeof used === "number" ? used : null;
}

function windowReset(w: RateLimitWindow | null | undefined): number | null {
  const reset = w?.resetsAt ?? w?.resets_at ?? null;
  return typeof reset === "number" ? reset : null;
}

function normWindow(w: RateLimitWindow | null | undefined): WindowInfo | null {
  if (!w) return null;
  const used = windowUsed(w);
  if (used === null) return null;
  return { usedPercent: used, resetsAt: windowReset(w) };
}

async function askAppServer<T>(
  bin: string,
  method: string,
  params: unknown,
  onDebug: (msg: string) => void,
): Promise<T> {
  const child = spawn(bin, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const ignore = () => {};
  child.stdin?.on("error", ignore);
  child.stdout?.on("error", ignore);
  child.stderr?.on("error", ignore);

  const stderr: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) if (line.trim()) stderr.push(line);
    if (stderr.length > STDERR_KEEP) stderr.splice(0, stderr.length - STDERR_KEEP);
  });
  const stderrSummary = () => (stderr.length ? `; stderr: ${stderr.slice(-STDERR_SHOW).join(" | ")}` : "");

  let buffer = "";
  let waiting: { id: number; resolve: (v: unknown) => void; reject: (e: Error) => void } | null = null;

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line || !waiting) continue;
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        onDebug(`app-server: unparseable line: ${oneLine(line)}`);
        continue;
      }
      if (message.id === undefined || message.id !== waiting.id) continue;
      const { resolve, reject } = waiting;
      waiting = null;
      if (message.error) reject(new Error(`${message.error.message ?? "app-server error"}${stderrSummary()}`));
      else resolve(message.result);
    }
  });

  const fail = (why: string) => {
    const current = waiting;
    waiting = null;
    current?.reject(new Error(`${why}${stderrSummary()}`));
  };
  child.once("error", (e) => fail(`app-server could not be started: ${e.message}`));
  child.once("exit", (code, signal) =>
    fail(`app-server exited (${signal ? `signal ${signal}` : `code ${code}`})`),
  );

  const request = (id: number, m: string, p: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (waiting?.id === id) waiting = null;
        reject(new Error(`${m} timed out after ${RPC_TIMEOUT_MS}ms${stderrSummary()}`));
      }, RPC_TIMEOUT_MS);
      waiting = {
        id,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p })}\n`);
    });

  try {
    await request(1, "initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true },
    });
    // The protocol requires this notification before any real call; a request that arrives
    // first is rejected as a protocol error rather than answered.
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    return (await request(2, method, params)) as T;
  } finally {
    try { child.kill(); } catch {}
  }
}

/** On Windows `which codex` finds the Store shim under `WindowsApps`, which exists on disk but
 * fails with `Access is denied` (WinError 5); the real binary is `CODEX_CLI_PATH` in `~/.codex/config.toml`. */
export function resolveCodexBin(explicit?: string): string | null {
  const candidates: string[] = [];

  if (explicit) candidates.push(explicit);
  const fromEnv = process.env["CODEX_BIN"];
  if (fromEnv) candidates.push(fromEnv);

  const fromConfig = readCodexCliPathFromConfig();
  if (fromConfig) candidates.push(fromConfig);

  for (const candidate of candidates) {
    if (candidate && isUsable(candidate)) return candidate;
  }

  const which = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["codex"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (which.status === 0) {
    for (const line of (which.stdout ?? "").split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate && isUsable(candidate)) return candidate;
    }
  }
  return null;
}

function isUsable(path: string): boolean {
  return existsSync(path) && !isStoreShim(path);
}

function readCodexCliPathFromConfig(): string | null {
  const codexHome = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const configPath = join(codexHome, "config.toml");
  if (!existsSync(configPath)) return null;
  try {
    const text = readFileSync(configPath, "utf8");
    const match = /^\s*CODEX_CLI_PATH\s*=\s*['"](.+?)['"]\s*$/m.exec(text);
    return match?.[1] ? match[1] : null;
  } catch {
    return null;
  }
}

export function quotaFromRateLimits(result: RateLimitsReadResult): QuotaInfo {
    const limits = result.rateLimitsByLimitId?.["codex"] ?? result.rateLimits ?? null;
    const primary = normWindow(limits?.primary);
    const secondary = normWindow(limits?.secondary);
    const credits = limits?.credits ?? null;
    const notes: string[] = [];

    const explicitlyAllowed = result.ordinaryUsageAllowed;
    const reached = limits?.rateLimitReachedType ?? null;
    if (typeof explicitlyAllowed !== "boolean" && !primary && !secondary && !reached) {
      throw new Error("Codex returned no usable quota fields");
    }
    const allowed = explicitlyAllowed ?? (reached === null && [primary, secondary].every((w) => !w || w.usedPercent < 100));

    if (!allowed && reached) notes.push(`reached: ${reached}`);
    if (credits && credits.hasCredits === false && credits.unlimited !== true) {
      notes.push(`credits: ${credits.balance ?? "0"}`);
    }
    const resetCredits = result.rateLimitResetCredits?.availableCount;
    if (typeof resetCredits === "number" && resetCredits > 0) {
      notes.push(`reset credits available: ${resetCredits}`);
    }
    if (!allowed) {
      const soonest = [windowReset(limits?.primary), windowReset(limits?.secondary)]
        .filter((v): v is number => typeof v === "number")
        .sort((a, b) => a - b)[0];
      if (soonest !== undefined) notes.push(`window resets in ${describeIn(soonest)}`);
    }

    const exhausted = [primary, secondary].filter(
      (w): w is WindowInfo => w !== null && w.usedPercent >= 100,
    );
    const blockedReason: QuotaInfo["blockedReason"] = allowed
      ? null
      : exhausted.length > 0
        ? "window"
        : primary !== null || secondary !== null
          ? "credits"
          : "unknown";

    const resets = exhausted.map((window) => window.resetsAt).filter(
      (v): v is number => typeof v === "number",
    );

    return {
      allowed,
      blockedReason,
      primary,
      secondary,
      nextResetAt: allowed ? null : (resets.length ? Math.max(...resets) : null),
      plan: limits?.planType ?? null,
      notes,
    };
}

export class CodexAdapter implements Adapter {
  readonly kind = "codex" as const;

  constructor(
    private readonly bin: string,
    private readonly onDebug: (msg: string) => void,
    private readonly watch: FilterPolicy,
    private readonly config: CodexConfig,
    private readonly execute: typeof runChildProcess = runChildProcess,
  ) {}

  resolveBin(): string {
    return this.bin;
  }

  async readQuota(): Promise<QuotaInfo> {
    const result = await askAppServer<RateLimitsReadResult>(
      this.bin,
      "account/rateLimits/read",
      {},
      this.onDebug,
    );
    return quotaFromRateLimits(result);
  }

  async probe(): Promise<boolean> {
    const quota = await this.readQuota();
    return quota.allowed;
  }

  async findInterrupted(filter: FilterPolicy): Promise<InterruptedSession[]> {
    const roots = sessionRoots();
    const cutoff = filter.maxAgeMinutes === null ? 0 : Date.now() - filter.maxAgeMinutes * 60_000;
    const files: string[] = [];

    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const file of walkRollouts(root)) {
        try {
          // Fresh files can contain a newer active turn that supersedes an older quota file.
          const mtimeMs = Math.floor(statSync(file).mtimeMs);
          if (mtimeMs >= cutoff) files.push(file);
        } catch {
        }
      }
    }

    const byThread = new Map<string, ThreadState>();
    for (const file of files) {
      const parsed = parseRollout(file);
      if (!parsed || (filter.skipSubagents && parsed.parentThreadId)) continue;
      const previous = byThread.get(parsed.sessionId);
      if (!previous || parsed.at > previous.at) byThread.set(parsed.sessionId, parsed);
    }

    return [...byThread.values()]
      .filter((s) => s.quota && s.at >= cutoff)
      .map((s) => ({
        cli: "codex" as const,
        sessionId: s.sessionId,
        turnId: s.turnId,
        cwd: s.cwd,
        interruptedAt: s.at,
        detail: s.detail,
        resetsAt: null,
        source: s.source,
        spoken: s.spoken,
      }))
      .sort((a, b) => b.interruptedAt - a.interruptedAt);
  }

  async resume(session: InterruptedSession, prompt: string): Promise<ResumeResult> {
    if (process.platform !== "win32") {
      return { ok: false, delivered: false, deferred: true, via: "none", detail: "This delivery build supports Windows only" };
    }
    const timeoutMs = this.config.deliveryTimeoutSeconds * 1_000;
    // Codex's `queue` command routes by thread id and does not distinguish session source.
    const result = await this.execute(this.bin, ["queue", "--thread", session.sessionId, "--message", prompt], {
      cwd: pickCwd(session.cwd), timeoutMs,
    });
    if (result.spawnError) return { ok: false, delivered: false, via: "cli-queue", detail: result.spawnError };
    if (result.timedOut) return { ok: false, delivered: false, uncertain: true, via: "cli-queue",
      detail: "Queue acknowledgement timed out; inspect Codex before retrying. The Codex session was not stopped." };
    if (result.code === 0) return { ok: true, delivered: true, via: "cli-queue", detail: "Message queued in Codex; this does not mean the task has finished" };
    return { ok: false, delivered: false, uncertain: true, via: "cli-queue", detail: oneLine(result.err || result.out) || `queue exit ${result.code}` };
  }

  close(): void {
  }
}

function pickCwd(cwd: string): string {
  return cwd && existsSync(cwd) ? cwd : process.cwd();
}

function describeIn(unixSeconds: number): string {
  const ms = unixSeconds * 1_000 - Date.now();
  if (ms <= 0) return "under a minute (may already have reset)";
  const mins = Math.floor(ms / 60_000);
  const hours = Math.floor(mins / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

export function sessionRoots(): string[] {
  const codexHome = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  return [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
}

export function* walkRollouts(root: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry);
    if (entry.endsWith(".jsonl")) {
      yield full;
      continue;
    }
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) yield* walkRollouts(full);
  }
}

export interface ThreadState {
  sessionId: string;
  cwd: string;
  parentThreadId: string | null;
  source: string | null;
  at: number;
  quota: boolean;
  turnId: string | null;
  detail: string;
  spoken: Utterance[];
}
/** Reads one rollout file and reports the thread's latest turn outcome (`at` in unix ms); a
 * thread's rollout can span several files, so the newest turn wins and a clean finish counts. */
export function parseRollout(file: string): ThreadState | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  // A byte-order mark makes the first line unparseable, and the first line is `session_meta`
  // — the only record carrying the session id — so strip it once here.
  text = text.replace(/^﻿/, "");

  let sessionId: string | null = null;
  let cwd = "";
  let source: string | null = null;
  let parentThreadId: string | null = null;
  let latest: { at: number; quota: boolean; turnId: string | null; detail: string } | null = null;
  const spoken: Utterance[] = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record.payload ?? {};
    const at = Date.parse(record.timestamp ?? "");

    if (record.type === "session_meta") {
      sessionId = typeof payload["id"] === "string" ? payload["id"] : null;
      source = typeof payload["source"] === "string" ? payload["source"] : null;
      cwd = typeof payload["cwd"] === "string" ? payload["cwd"] : "";
      parentThreadId =
        typeof payload["parent_thread_id"] === "string" ? payload["parent_thread_id"] : null;
      continue;
    }
    if (record.type !== "event_msg" || !Number.isFinite(at)) continue;

    if (payload["type"] === "task_complete") {
      const error = payload["error"] as { codex_error_info?: string; message?: string } | null;
      const tag = error?.codex_error_info ?? "";
      latest = {
        at,
        quota: QUOTA_ERROR_TAGS.has(tag),
        turnId: typeof payload["turn_id"] === "string" ? (payload["turn_id"] as string) : null,
        detail: tag || (error?.message ? "error" : "completed"),
      };
    }

    // New activity supersedes an old quota interruption, even in a separate rollout.
    if (payload["type"] === "task_started" || payload["type"] === "turn_aborted") {
      latest = { at, quota: false, turnId: typeof payload["turn_id"] === "string" ? payload["turn_id"] : null, detail: String(payload["type"]) };
    }

    // Only a submitted message emits this item; the transcript's `user` role is shared with
    // injected context, so the role cannot tell the two apart.
    if (payload["type"] === "item_completed") {
      const item = payload["item"] as { type?: string; content?: unknown } | undefined;
      if (item?.type === "UserMessage") {
        latest = { at, quota: false, turnId: null, detail: "new user input" };
        const said = oneLine(messageText(item.content), SPOKEN_CHARS);
        if (said) {
          spoken.push({ at, text: said });
          if (spoken.length > SPOKEN_COUNT) spoken.shift();
        }
      }
    }
  }

  if (!sessionId || !latest) return null;
  return { sessionId, cwd, source, parentThreadId, ...latest, spoken };
}
