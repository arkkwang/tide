import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SCAN_MTIME_CUTOFF_MS,
  type Config,
} from "./config.js";
import { messageText, oneLine, runChildProcess, short } from "./util.js";
import { launchWindow, posixQuote } from "./window.js";
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

/** Claude Code marks the processes it starts so that they know they are nested. A TUI that
 * inherits the marker reports "transcript saving is off" and persists nothing; the session id
 * and the messaging socket name the session tide itself runs under. */
const PARENT_SESSION_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
];

/** What a delivered session runs under: tide's own environment (credentials, model, the Git
 * Bash path), minus the markers of whichever session started tide. */
function deliveryEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of PARENT_SESSION_MARKERS) {
    delete env[name];
  }
  return env;
}

/** The `error` value Claude Code writes on a rate-limited API-error record. */
const QUOTA_ERROR_TAG = "rate_limit";

/** `agents --json` lists local processes; anything slower than this is not going to answer. */
const AGENTS_LIST_TIMEOUT_MS = 5_000;

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
  ) {}

  resolveBin(): string {
    return this.bin;
  }

  async readQuota(): Promise<QuotaInfo> {
    // probe runs without hooks/plugins, leaves no transcript, fails fast on 429
    const result = await runChildProcess(
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
          collectMainSession(found, null, entry, entryPath, cutoff);
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
          collectMainSession(found, entry, sub, join(subagentsDir, sub), cutoff);
        }
      }
    }

    return found.sort((a, b) => b.lastAssistantAt - a.lastAssistantAt);
  }

  async resume(session: Session, prompt: string): Promise<ResumeResult> {
    if (!session.cwd || !existsSync(session.cwd)) {
      return { ok: false, delivered: false, via: "cli-resume", detail: `session cwd is not on disk: ${session.cwd || "(unset)"}` };
    }
    // Resuming a session id that a live claude process holds does not fork: it interrupts that
    // process's in-flight turn and takes the session over, leaving the holder alive but out of
    // sync with the transcript. The holder is terminated first.
    const killed = await this.killHolders(session.sessionId);

    const deliveriesDir = join(this.config.stateDir, "deliveries");
    mkdirSync(deliveriesDir, { recursive: true });
    // Only the script path ever reaches a command line. The cwd and the prompt are read by the
    // window's shell, so POSIX quoting covers them on either platform.
    const scriptPath = join(deliveriesDir, `${session.sessionId}.sh`);
    writeFileSync(
      scriptPath,
      [
        "#!/bin/bash",
        `cd ${posixQuote(session.cwd)} || exit 1`,
        // Unattended, the session otherwise waits on approvals nothing can answer.
        `${posixQuote(this.bin)} --resume ${session.sessionId} --dangerously-skip-permissions ${posixQuote(prompt)}`,
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(scriptPath, 0o700);

    const launched = launchWindow({
      scriptPath,
      title: `tide ${short(session.sessionId)}`,
      logPath: join(deliveriesDir, `${session.sessionId}.log`),
      env: deliveryEnv(),
    });
    if (!launched.ok) {
      return { ok: false, delivered: false, via: "cli-resume", detail: launched.detail };
    }
    const cleared = killed.length > 0 ? `; terminated ${killed.map((pid) => `pid ${pid}`).join(", ")}` : "";
    return {
      ok: true,
      delivered: true,
      via: "cli-resume",
      detail: `window requested via ${launched.detail}${cleared}`,
    };
  }

  /** Terminate every live process holding `sessionId`, and return their pids. Reads only
   * `sessionId` and `pid` from `agents --json`; `pid` is present on interactive entries only,
   * so a background job holding the same id is left alone. An empty result means nothing held
   * it or the listing failed — delivery proceeds either way. */
  private async killHolders(sessionId: string): Promise<number[]> {
    const result = await runChildProcess(this.bin, ["agents", "--json"], {
      timeoutMs: AGENTS_LIST_TIMEOUT_MS,
    });
    if (result.spawnError || result.timedOut || result.code !== 0) {
      return [];
    }
    let entries: unknown;
    try {
      entries = JSON.parse(result.out);
    } catch {
      return [];
    }
    if (!Array.isArray(entries)) {
      return [];
    }
    const killed: number[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      if (row["sessionId"] !== sessionId) continue;
      const pid = row["pid"];
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
      if (terminate(pid)) {
        killed.push(pid);
      }
    }
    return killed;
  }
}

/** `process.kill` is TerminateProcess on Windows and SIGTERM elsewhere. A pid that is already
 * gone throws instead of reporting anything the caller can use, so failure reads as "not
 * terminated". */
function terminate(pid: number): boolean {
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
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
): void {
  const sessionId = entry.replace(/\.jsonl$/, "");
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

/** Bytes of transcript tail that decide what the session was doing. */
const TAIL_MAX_BYTES = 2_000_000;

function inspectTranscriptTail(file: string): TailState | null {
  const lines = readTailLines(file, TAIL_MAX_BYTES);
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
