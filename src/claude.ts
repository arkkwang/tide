import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ClaudeConfig, defaultStateDir, type FilterPolicy } from "./config.js";
import { messageText, oneLine, runChildProcess } from "./util.js";
import {
  SPOKEN_CHARS,
  SPOKEN_COUNT,
  type Adapter,
  type InterruptedSession,
  type QuotaInfo,
  type ResumeResult,
  type Utterance,
} from "./watch.js";

function claudeConfigDir(): string {
  return process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
}

const RESUMED_FILENAME = "claude-resumed.json";

/** Find the Claude Code CLI binary. Order: explicit arg → `CLAUDE_BIN` env → `where.exe/which claude`. */
export function resolveClaudeBin(explicit?: string): string | null {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const fromEnv = process.env["CLAUDE_BIN"];
  if (fromEnv) candidates.push(fromEnv);

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  const which = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["claude"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (which.status === 0) {
    for (const line of (which.stdout ?? "").split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Claude Code writes a normalized `error` enum on every API-error record, decoded from whatever
 * the provider returned; quota is decided by that field alone, never by the prose beside it. */
export const QUOTA_ERROR_TAG = "rate_limit";

interface ClaudeProbeResult {
  is_error?: boolean;
  result?: unknown;
  /** HTTP status of the upstream failure, when there was one (`api_error_status` in the envelope). */
  api_error_status?: unknown;
}

/**
 * Decide whether the probe output tells us the account is currently rate-limited. The status code
 * is the primary signal: it is upstream's own verdict, and it is the only one that survives a
 * provider whose error prose we cannot read — MiniMax answers a 429 with Chinese text containing
 * nothing matching `rate limit`, so a text-only test called a definite block "unknown".
 *
 * The prose match stays as a fallback for envelopes that carry a rate-limit message but no status.
 * Anything else still falls through to `unknown`, which is what that value is for.
 */
function probeIsRateLimited(probe: ClaudeProbeResult): boolean {
  if (probe.api_error_status === 429) return true;
  const text = typeof probe.result === "string" ? probe.result : "";
  return /rate[ _-]?limit/i.test(text);
}

/**
 * Claude Code adapter. The transcript-scan path (`findInterrupted`) reads `~/.claude/projects/...`
 * for tail errors tagged `rate_limit`. The probe path (`readQuota`) sends a minimal prompt via
 * `claude -p` and parses the JSON envelope. The delivery path (`resume`) runs
 * `claude --bg --resume <id> "<msg>"` — Claude Code's queue equivalent: starts a background
 * session and returns immediately with a `backgrounded · <id>` line.
 *
 * Because Claude Code has no real "queue into an existing session" command, `--bg --resume`
 * on a session whose TUI is still open forks a new session id per call. To keep that from
 * blowing up into one fork per sweep, the adapter remembers every session it has already
 * queued — loaded from `<stateDir>/claude-resumed.json` on construction, flushed after every
 * successful resume, and again on `close()`. That ledger is what `findInterrupted` filters on,
 * so a queued session stops being reported as interrupted at all. The operator brings one back
 * by deleting it from that file by hand; there is no in-band way to re-queue it.
 */
export class ClaudeAdapter implements Adapter {
  readonly kind = "claude" as const;

  /** Session ids we have already queued in this run (or any previous run that wrote the file). */
  private readonly resumedSessions: Set<string>;

  constructor(
    private readonly bin: string,
    private readonly config: ClaudeConfig,
    private readonly execute: typeof runChildProcess = runChildProcess,
  ) {
    this.resumedSessions = loadResumedFromDisk();
  }

  resolveBin(): string {
    return this.bin;
  }

  async readQuota(): Promise<QuotaInfo> {
    if (process.platform !== "win32") {
      throw new Error("Claude quota probe supports Windows only");
    }
    // `--bare` skips hooks / CLAUDE.md / plugins so a probe never fires user-defined side
    // effects. `--no-session-persistence` keeps the throwaway probe out of the transcript tree.
    // `CLAUDE_CODE_MAX_RETRIES=0` is what makes the probe answerable: on a 429 the CLI retries
    // with backoff for minutes, so a throttled account used to blow through any sane timeout and
    // report "unknown" instead of "blocked". With retries off it fails in ~2s.
    const result = await this.execute(
      this.bin,
      ["-p", this.config.probePrompt, "--bare", "--no-session-persistence", "--output-format", "json"],
      {
        cwd: process.cwd(),
        timeoutMs: this.config.probeTimeoutSeconds * 1_000,
        env: { ...process.env, CLAUDE_CODE_MAX_RETRIES: "0" },
      },
    );
    if (result.spawnError) {
      throw new Error(`probe could not be started: ${result.spawnError}`);
    }
    if (result.timedOut) {
      throw new Error(`probe timed out after ${this.config.probeTimeoutSeconds}s`);
    }

    let parsed: ClaudeProbeResult;
    try {
      parsed = JSON.parse(result.out) as ClaudeProbeResult;
    } catch (err) {
      throw new Error(`probe stdout was not JSON: ${oneLine(result.out)}${(err as Error).message ? ` — ${(err as Error).message}` : ""}`);
    }

    if (parsed.is_error === false) {
      return {
        allowed: true,
        blockedReason: null,
        primary: null,
        secondary: null,
        nextResetAt: null,
        plan: null,
        notes: [`probe ok via ${this.bin}`],
      };
    }
    if (probeIsRateLimited(parsed)) {
      return {
        allowed: false,
        blockedReason: "rate_limit",
        primary: null,
        secondary: null,
        nextResetAt: null,
        plan: null,
        notes: ["probe hit rate_limit"],
      };
    }
    return {
      allowed: false,
      blockedReason: "unknown",
      primary: null,
      secondary: null,
      nextResetAt: null,
      plan: null,
      notes: [`probe errored: ${oneLine(typeof parsed.result === "string" ? parsed.result : result.err || result.out)}`],
    };
  }

  async findInterrupted(filter: FilterPolicy): Promise<InterruptedSession[]> {
    const projectsDir = join(claudeConfigDir(), "projects");
    if (!existsSync(projectsDir)) return [];

    const cutoff = filter.maxAgeMinutes === null ? 0 : Date.now() - filter.maxAgeMinutes * 60_000;
    const found: InterruptedSession[] = [];

    for (const project of safeReaddir(projectsDir)) {
      const projectDir = join(projectsDir, project);
      if (!isDir(projectDir)) continue;
      for (const entry of safeReaddir(projectDir)) {
        if (!entry.endsWith(".jsonl")) continue;
        const sessionId = entry.replace(/\.jsonl$/, "");
        // Already queued by tide, so nobody is waiting on it: the ledger exists to stop the
        // watcher forking the session again, and reporting it here would promise an action that
        // will not happen. `resume` refuses it too, so it is absent from `tide status` as well.
        if (this.resumedSessions.has(sessionId)) continue;
        const file = join(projectDir, entry);
        let mtimeMs: number;
        try {
          mtimeMs = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (mtimeMs < cutoff) continue;
        const state = inspectTranscriptTail(file);
        if (!state || !state.quotaError) continue;

        // Age is taken from the interruption, not the file: housekeeping records land after the
        // turn ended, and a refused-and-retried session stays fresh while nobody has spoken.
        const interruptedAt = state.errorAt ?? mtimeMs;
        if (interruptedAt < cutoff) continue;

        found.push({
          sessionId,
          cwd: state.cwd,
          interruptedAt,
          model: state.model,
          spoken: state.spoken,
        });
      }
    }

    return found.sort((a, b) => b.interruptedAt - a.interruptedAt);
  }

  async resume(session: InterruptedSession, prompt: string): Promise<ResumeResult> {
    if (process.platform !== "win32") {
      return { ok: false, delivered: false, deferred: true, via: "none", detail: "This delivery build supports Windows only" };
    }
    const timeoutMs = this.config.deliveryTimeoutSeconds * 1_000;
    // `claude --bg --resume <id> "<msg>"` queues the message into a background session and
    // returns immediately (~1s) with a `backgrounded · <id>` line — Claude Code's queue
    // equivalent. If the original TUI is still open, Claude Code forks a copy and prints
    // `note: started a copy as <id>`. Either way tide's job is done once that line lands.
    const result = await this.execute(
      this.bin,
      ["--bg", "--resume", session.sessionId, prompt],
      { cwd: pickCwd(session.cwd), timeoutMs },
    );
    if (result.spawnError) return { ok: false, delivered: false, via: "cli-resume", detail: result.spawnError };
    if (result.timedOut) {
      return {
        ok: false,
        delivered: false,
        uncertain: true,
        via: "cli-resume",
        detail: "Queue acknowledgement timed out; inspect Claude Code before retrying. The Claude Code session was not stopped.",
      };
    }
    if (result.code === 0 && result.out.includes("backgrounded")) {
      this.resumedSessions.add(session.sessionId);
      flushResumedToDisk(this.resumedSessions);
      return {
        ok: true,
        delivered: true,
        via: "cli-resume",
        detail: "Message queued in Claude Code; this does not mean the task has finished",
      };
    }
    return {
      ok: false,
      delivered: false,
      uncertain: true,
      via: "cli-resume",
      detail: oneLine(result.err || result.out) || `resume exit ${result.code}`,
    };
  }

  close(): void {
    // Best-effort: flush again so a SIGINT between two successful resumes doesn't lose the last id.
    flushResumedToDisk(this.resumedSessions);
  }
}

function pickCwd(cwd: string): string {
  return cwd && existsSync(cwd) ? cwd : process.cwd();
}

/** Load the persisted "already-resumed" list. Bad files are treated as empty — losing a few
 * recorded ids is acceptable, refusing to start the watcher because of a corrupt JSON is not. */
function loadResumedFromDisk(): Set<string> {
  try {
    const file = join(defaultStateDir(), RESUMED_FILENAME);
    if (!existsSync(file)) return new Set();
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((s): s is string => typeof s === "string"));
  } catch {
    return new Set();
  }
}

/** Persist the current "already-resumed" list. Best-effort: a failed write does not change
 * the caller's success — the in-memory set is still authoritative for this run. */
function flushResumedToDisk(set: Set<string>): void {
  try {
    const dir = defaultStateDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, RESUMED_FILENAME);
    const sorted = [...set].sort();
    writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  } catch {
    // ignored on purpose: see header
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The model Claude Code writes on a record it composed itself (an API error, say), so a session
 * whose newest records are all of these still belongs to whatever account answered last. */
const SYNTHETIC_MODEL = "<synthetic>";

/** `promptSource` is the only thing separating what a person typed from what the program stored in
 * a `user` role; a record without the field is not speech, so old transcripts show none of it. */
const HUMAN_PROMPT_SOURCES = new Set(["typed", "queued", "suggestion_accepted"]);
const PROMPT_SOURCE = "promptSource";

interface TailState {
  quotaError: boolean;
  cwd: string;
  errorAt: number | null;
  model: string | null;
  spoken: Utterance[];
}

export function inspectTranscriptTail(
  file: string,
  options: { maxBytes?: number } = {},
): TailState | null {
  const maxBytes = options.maxBytes ?? 2_000_000;
  const lines = readTailLines(file, maxBytes);
  const model = newestModel(lines);
  const spoken = recentUtterances(lines);

  let lastError: { at: number; tag: string | null } | null = null;
  let lastSuccessAfterError = false;
  let cwd = "";

  for (let i = lines.length - 1; i >= 0; i--) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = record["type"];
    if (!cwd && typeof record["cwd"] === "string") cwd = record["cwd"] as string;

    if (type === "assistant") {
      if (record["isApiErrorMessage"] === true) {
        if (!lastError) {
          lastError = {
            at: Date.parse(String(record["timestamp"] ?? "")) || 0,
            tag: typeof record["error"] === "string" ? (record["error"] as string) : null,
          };
        }
      } else if (!lastError) {
        lastSuccessAfterError = true;
        break;
      }
    }
    if (type === "user") {
      // A `user` record is also what our own resume writes, so it is not evidence the person came
      // back: reading it that way would erase the finding that triggered the resume.
      if (lastError) break;
    }
  }

  if (!lastError) {
    return {
      quotaError: false,
      cwd,
      errorAt: null,
      spoken,
      model,
    };
  }
  if (lastSuccessAfterError) {
    return {
      quotaError: false,
      cwd,
      errorAt: null,
      spoken,
      model,
    };
  }

  return {
    quotaError: lastError.tag === QUOTA_ERROR_TAG,
    cwd,
    errorAt: lastError.at || null,
    spoken,
    model,
  };
}

function recentUtterances(lines: string[]): Utterance[] {
  const said: Utterance[] = [];
  for (let i = lines.length - 1; i >= 0 && said.length < SPOKEN_COUNT; i--) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record["type"] !== "user") continue;
    if (!HUMAN_PROMPT_SOURCES.has(String(record[PROMPT_SOURCE]))) continue;
    const at = Date.parse(String(record["timestamp"] ?? "")) || 0;
    const text = oneLine(
      messageText((record["message"] as { content?: unknown } | undefined)?.content),
      SPOKEN_CHARS,
    );
    if (at > 0 && text) said.push({ text });
  }
  return said;
}

function newestModel(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record["type"] !== "assistant") continue;
    const named = (record["message"] as { model?: unknown } | undefined)?.model;
    if (typeof named === "string" && named && named !== SYNTHETIC_MODEL) return named;
  }
  return null;
}

function readTailLines(file: string, maxBytes: number): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return [];
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
