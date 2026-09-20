import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SCAN_MTIME_CUTOFF_MS,
  type Config,
} from "./config.js";
import { messageText, oneLine, runChildProcess } from "./util.js";
import {
  SPOKEN_CHARS,
  SPOKEN_COUNT,
  type Adapter,
  type QuotaInfo,
  type ResumeResult,
  type Session,
  type SessionStatus,
  type Utterance,
} from "./watch.js";

function claudeConfigDir(): string {
  return process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
}

export function resolveClaudeBin(explicit?: string): string | null {
  const candidates: string[] = [];
  if (explicit) {
    candidates.push(explicit);
  }
  const fromEnv = process.env["CLAUDE_BIN"];
  if (fromEnv) {
    candidates.push(fromEnv);
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  const which = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["claude"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (which.status === 0) {
    for (const line of (which.stdout ?? "").split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate && existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** The `error` value Claude Code writes on a rate-limited API-error record. */
export const QUOTA_ERROR_TAG = "rate_limit";

interface ClaudeProbeResult {
  is_error?: boolean;
  result?: unknown;
  api_error_status?: unknown;
}

/** A 429 status is upstream's own verdict; the prose fallback covers envelopes that carry no status. */
function probeIsRateLimited(probe: ClaudeProbeResult): boolean {
  if (probe.api_error_status === 429) return true;
  const text = typeof probe.result === "string" ? probe.result : "";
  return /rate[ _-]?limit/i.test(text);
}

export class ClaudeAdapter implements Adapter {
  readonly kind = "claude" as const;

  constructor(
    private readonly bin: string,
    private readonly config: Config,
    private readonly execute: typeof runChildProcess = runChildProcess,
  ) {}

  resolveBin(): string {
    return this.bin;
  }

  async readQuota(): Promise<QuotaInfo> {
    if (process.platform !== "win32") {
      throw new Error("Claude quota probe supports Windows only");
    }
    // probe runs without hooks/plugins, leaves no transcript, fails fast on 429
    const result = await this.execute(
      this.bin,
      ["-p", this.config.claude.probePrompt, "--bare", "--no-session-persistence", "--output-format", "json"],
      {
        cwd: process.cwd(),
        timeoutMs: this.config.claude.probeTimeoutSeconds * 1_000,
        env: { ...process.env, CLAUDE_CODE_MAX_RETRIES: "0" },
      },
    );
    if (result.spawnError) {
      throw new Error(`probe could not be started: ${result.spawnError}`);
    }
    if (result.timedOut) {
      throw new Error(`probe timed out after ${this.config.claude.probeTimeoutSeconds}s`);
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

  async findSessions(): Promise<Session[]> {
    const resumed = this.config.claude.resumedSessions;
    const projectsDir = join(claudeConfigDir(), "projects");
    if (!existsSync(projectsDir)) {
      return [];
    }

    const cutoff = Date.now() - SCAN_MTIME_CUTOFF_MS;
    const found: Session[] = [];

    for (const project of safeReaddir(projectsDir)) {
      const projectDir = join(projectsDir, project);
      if (!isDir(projectDir)) {
        continue;
      }
      for (const entry of safeReaddir(projectDir)) {
        const entryPath = join(projectDir, entry);
        if (entry.endsWith(".jsonl")) {
          collectMainSession(found, null, entry, entryPath, cutoff, resumed);
          continue;
        }
        // `<parentSessionId>/subagents/agent-<agentId>.jsonl` lives one level deeper; the
        // session id stays the file name (`agent-<agentId>`) so it matches the transcript.
        if (!isDir(entryPath)) {
          continue;
        }
        const subagentsDir = join(entryPath, "subagents");
        if (!isDir(subagentsDir)) {
          continue;
        }
        for (const sub of safeReaddir(subagentsDir)) {
          if (!sub.startsWith("agent-") || !sub.endsWith(".jsonl")) {
            continue;
          }
          collectMainSession(found, entry, sub, join(subagentsDir, sub), cutoff, resumed);
        }
      }
    }

    return found.sort((a, b) => b.lastAssistantAt - a.lastAssistantAt);
  }

  async resume(session: Session, prompt: string): Promise<ResumeResult> {
    if (process.platform !== "win32") {
      return { ok: false, delivered: false, deferred: true, via: "none", detail: "This delivery build supports Windows only" };
    }

    const timeoutMs = this.config.claude.deliveryTimeoutSeconds * 1_000;
    // `--bg --resume` returns `backgrounded` on success and forks if the TUI is still open.
    // `--dangerously-skip-permissions` is needed because a background session otherwise runs
    // in `manual` mode where every tool call would wait on a headless-unreachable approval.
    // 当session还在前台时， 即使resume, 由于session被占用,还是会降级走到--fork-session 产生一个新的sesion
    // 只有session不在前台时, 才会直接resume到原来的session, 并且不会产生新的sessionId, 但是后续又有逻辑说处理过的sessionId不再会被二次处理, 因此, 这里直接显式传递--fork-session, 让每次resume都产生一个新的sessionId
    // 经测试, claude 命令暴露能够直接关闭yiyousession的命令, claude stop <id> 和 claude deamon stop <id> 都只负责管理后台session,即子Agent的session
    const result = await this.execute(
      this.bin,
      [
        "--bg", 
        "--resume", session.sessionId, 
        "--fork-session",
        "--dangerously-skip-permissions", 
        prompt
      ],
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
    if (result.code === 0 ) {
      this.config.claude.resumedSessions.add(session.sessionId);
      this.config.flush({ claude: { resumedSessions: this.config.claude.resumedSessions } });

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

}

function pickCwd(cwd: string): string {
  return cwd && existsSync(cwd) ? cwd : process.cwd();
}

/** True when this file lives under a `<sessionId>/subagents/` directory, i.e. it is a forked
 * sub-agent of the parent session that owns the directory. The transcript itself may not
 * carry a parent marker — Claude Code only puts sub-agents in that directory layout. */
function isSubagentTranscript(file: string): boolean {
  // `<...>/<parentSessionId>/subagents/agent-<id>.jsonl` — both path segments must be present.
  return /[\\/]subagents[\\/]agent-[^\\/]+\.jsonl$/i.test(file);
}

function collectMainSession(
  out: Session[],
  parentSessionId: string | null,
  entry: string,
  file: string,
  cutoff: number,
  resumedSessions: Set<string>,
): void {
  const sessionId = entry.replace(/\.jsonl$/, "");
  if (resumedSessions.has(sessionId)) {
    return;
  }
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return;
  }
  if (mtimeMs < cutoff) {
    return;
  }
  const state = inspectTranscriptTail(file);
  if (!state) {
    return;
  }
  const lastAssistantAt = state.lastAssistantAt ?? mtimeMs;
  const isSubagent = isSubagentTranscript(file);

  out.push({
    sessionId,
    cwd: state.cwd,
    lastAssistantAt,
    model: state.model,
    status: state.status,
    spoken: state.spoken,
    isSubagent,
    parentThreadId: isSubagent ? parentSessionId : null,
  });
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

/** The model name Claude Code writes on a record it composed itself, such as an API error. */
const SYNTHETIC_MODEL = "<synthetic>";

/** `promptSource` separates what a person typed from what a program stored in a `user` role. */
const HUMAN_PROMPT_SOURCES = new Set(["typed", "queued", "suggestion_accepted"]);
const PROMPT_SOURCE = "promptSource";

interface TailState {
  status: SessionStatus;
  cwd: string;
  lastAssistantAt: number | null;
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
  let cwd = "";

  // Newest assistant record wins: either text or tool_use blocks count as one response.
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = record["type"];
    if (!cwd && typeof record["cwd"] === "string") cwd = record["cwd"] as string;
    if (type !== "assistant") {
      continue;
    }
    const at = Date.parse(String(record["timestamp"] ?? "")) || null;
    if (record["isApiErrorMessage"] === true) {
      const tag = typeof record["error"] === "string" ? (record["error"] as string) : null;
      const status: SessionStatus = tag === QUOTA_ERROR_TAG ? "quota-limited" : "errored";
      return { status, cwd, lastAssistantAt: at, model, spoken };
    }
    return { status: "completed", cwd, lastAssistantAt: at, model, spoken };
  }

  // No assistant record in the tail window — only a human prompt without any reply yet,
  // so the session is waiting on the model, not on the user.
  return { status: "running", cwd, lastAssistantAt: null, model, spoken };
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
    if (record["type"] !== "user") {
      continue;
    }
    if (!HUMAN_PROMPT_SOURCES.has(String(record[PROMPT_SOURCE]))) {
      continue;
    }
    const at = Date.parse(String(record["timestamp"] ?? "")) || 0;
    const text = oneLine(
      messageText((record["message"] as { content?: unknown } | undefined)?.content),
      SPOKEN_CHARS,
    );
    if (at > 0 && text) {
      said.push({ text });
    }
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
    if (record["type"] !== "assistant") {
      continue;
    }
    const named = (record["message"] as { model?: unknown } | undefined)?.model;
    if (typeof named === "string" && named && named !== SYNTHETIC_MODEL) {
      return named;
    }
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
    if (length <= 0) {
      return [];
    }
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    if (start > 0) {
      lines.shift();
    }
    return lines.filter((l) => l.trim());
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}
