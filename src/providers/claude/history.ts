import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SCAN_MTIME_CUTOFF_MS } from "../../config.js";
import { messageText, oneLine } from "../../util.js";
import { SPOKEN_CHARS, SPOKEN_COUNT, type Session, type RecordedEvent, type Utterance } from "../../core/session.js";
import { parseEvent } from "../transcript.js";

// Read-only observations of Claude's current file format, not a live control protocol.

function claudeConfigDir(): string {
  return process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
}

export async function findClaudeSessions(): Promise<Session[]> {
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
