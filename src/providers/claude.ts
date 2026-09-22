import { executionSnapshot, readTranscript, parseEvent } from "./transcript.js";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SCAN_MTIME_CUTOFF_MS,
  type Config,
} from "../config.js";
import { messageText, oneLine, runChildProcess, short } from "../util.js";
import { claudeRecoveryArgs, launchWindow, posixQuote, resolveBash } from "./terminal.js";
import {
  SPOKEN_CHARS,
  SPOKEN_COUNT,
  type Adapter,
  type QuotaInfo,
  type LaunchReceipt,
  type Session,
  type RecordedEvent,
  type Utterance,
} from "../core/session.js";

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
export function deliveryEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of PARENT_SESSION_MARKERS) {
    delete env[name];
  }
  return env;
}

/** The `error` value Claude Code writes on a rate-limited API-error record. */

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

  history(session: Session, after?: string) { return readTranscript(this.kind, session, after); }

  snapshot(session: Session, limit: number) { return executionSnapshot(this.kind, session, limit); }

  private async processes(): Promise<Array<{ pid: number; sessionId: string; status: string }>> {
    const bash = resolveBash();
    if (!bash) throw new Error("No Git Bash found");
    const result = await runChildProcess(bash, ["-lc", `${posixQuote(this.bin.replaceAll("\\", "/"))} agents --json`], {
      timeoutMs: AGENTS_LIST_TIMEOUT_MS, env: deliveryEnv(),
    });
    if (result.code !== 0 || result.timedOut || result.spawnError) throw new Error("Cannot confirm Claude process ownership");
    const rows = JSON.parse(result.out);
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.sessionId !== "string" || !Number.isSafeInteger(r.pid))) throw new Error("Invalid Claude process list");
    return rows;
  }

  async sessionForProcess(pid: number): Promise<string | null> {
    return (await this.processes()).find((r) => r.pid === pid)?.sessionId ?? null;
  }

  async ownsIdleProcess(sessionId: string, pid: number): Promise<boolean> {
    const owners = (await this.processes()).filter((r) => r.sessionId === sessionId);
    return owners.length === 1 && owners[0]!.pid === pid && owners[0]!.status === "idle";
  }

  resolveBin(): string {
    return this.bin;
  }

  async readQuota(): Promise<QuotaInfo> {
    const bash = resolveBash();
    if (!bash) throw new Error("No Git Bash found for Claude quota probe");
    // --bare disables OAuth on current Claude versions; keep the user's normal auth environment.
    const args = ["-p", this.config.claude.probePrompt, "--no-session-persistence", "--output-format", "json"];
    const result = await runChildProcess(
      bash,
      ["-lc", [this.bin.replaceAll("\\", "/"), ...args].map(posixQuote).join(" ")],
      {
        cwd: process.cwd(),
        timeoutMs: this.config.claude.probeTimeoutSeconds * 1_000,
        env: { ...deliveryEnv(), CLAUDE_CODE_MAX_RETRIES: "0" },
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

  async launchSession(session: Session, prompt: string): Promise<LaunchReceipt> {
    if (!session.cwd || !existsSync(session.cwd)) {
      return { ok: false, requested: false, detail: `session cwd is not on disk: ${session.cwd || "(unset)"}` };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(session.sessionId) || session.isSubagent) {
      return { ok: false, requested: false, detail: "Only a main session with a valid ID can be resumed" };
    }
    const bash = resolveBash();
    if (!bash) return { ok: false, requested: false, detail: "No Git Bash found" };
    const holders = await runChildProcess(bash, ["-lc", `${posixQuote(this.bin.replaceAll("\\", "/"))} agents --json`], {
      timeoutMs: AGENTS_LIST_TIMEOUT_MS, env: deliveryEnv(),
    });
    const refusal = holderRefusal(holders, session.sessionId);
    if (refusal) return { ok: false, requested: false, deferred: true, detail: refusal };

    const deliveriesDir = join(this.config.stateDir, "deliveries");
    mkdirSync(deliveriesDir, { recursive: true });
    // Only the script path ever reaches a command line. The cwd and the prompt are read by the
    // window's shell, so POSIX quoting covers them on either platform.
    const scriptPath = join(deliveriesDir, `${session.sessionId}.sh`);
    const optionsPath = join(this.config.stateDir, "monitors", `claude-${session.sessionId}.options.json`);
    const originalArgs = existsSync(optionsPath) ? JSON.parse(readFileSync(optionsPath, "utf8")) : [];
    if (!Array.isArray(originalArgs) || originalArgs.some((a) => typeof a !== "string")) throw new Error("Invalid saved Claude launch options");
    const args = claudeRecoveryArgs(originalArgs, session.sessionId, prompt);
    writeFileSync(
      scriptPath,
      [
        "#!/bin/bash",
        `cd ${posixQuote(session.cwd)} || exit 1`,
        [this.bin.replaceAll("\\", "/"), ...args].map(posixQuote).join(" "),
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
      return { ok: false, requested: false, detail: launched.detail };
    }
    return {
      ok: true,
      requested: true,

      detail: `window requested via ${launched.detail}; not an acceptance or completion acknowledgement`,
    };
  }

}

export function holderRefusal(result: { spawnError: string | null; timedOut: boolean; code: number | null; out: string }, sessionId: string): string | null {
  const unknown = "Cannot confirm session ownership; no window opened. Inspect Claude Code before retrying.";
  if (result.spawnError || result.timedOut || result.code !== 0) return unknown;
  let entries: unknown;
  try { entries = JSON.parse(result.out); } catch { return unknown; }
  if (!Array.isArray(entries)) return unknown;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.sessionId !== "string") return unknown;
    if (entry.sessionId === sessionId) return "Session is held by Claude Code; use its visible window or close it before sending. Nothing was stopped.";
  }
  return null;
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
  const sessionId = isSubagent ? entry.replace(/\.jsonl$/, "") : state.sessionId;
  if (!sessionId) return;

  out.push({
    sessionId,
    transcriptPath: file,
    cwd: state.cwd,
    lastAssistantAt,
    model: state.model,
    lastEvent: state.status,
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
  sessionId: string | null;
  status: RecordedEvent;
  cwd: string;
  lastAssistantAt: number | null;
  model: string | null;
  spoken: Utterance[];
}

/** Bytes of transcript tail that decide what the session was doing. */
const TAIL_MAX_BYTES = 2_000_000;

export function inspectTranscriptTail(file: string): TailState | null {
  const lines = readTailLines(file, TAIL_MAX_BYTES);
  const model = newestModel(lines);
  const spoken = recentUtterances(lines);
  let cwd = "";
  let sessionId: string | null = null;
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (typeof row.sessionId === "string") sessionId = row.sessionId;
      if (typeof row.cwd === "string") cwd = row.cwd;
    } catch {}
  }

  let status: RecordedEvent = "unknown";
  let lastAssistantAt: number | null = null;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const event = parseEvent("claude", row, 0);
    if (event.state) status = event.state;
    if (row.type === "assistant") lastAssistantAt = Date.parse(row.timestamp ?? "") || lastAssistantAt;
  }
  return { sessionId, status, cwd, lastAssistantAt, model, spoken };
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
