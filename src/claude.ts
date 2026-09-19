import { homedir } from "node:os";
import { closeSync, existsSync, openSync, readdirSync, readSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SPOKEN_CHARS, SPOKEN_COUNT, type Adapter, type InterruptedSession, type QuotaInfo, type ResumeResult, type Utterance } from "./watch.js";
import { type FilterPolicy } from "./config.js";
import { messageText, oneLine } from "./util.js";

function claudeConfigDir(): string {
  return process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
}

/** Claude Code writes a normalized `error` enum on every API-error record, decoded from whatever
 * the provider returned; quota is decided by that field alone, never by the prose beside it. */
export const QUOTA_ERROR_TAG = "rate_limit";

/**
 * Claude Code adapter: capability 1 (find interrupted sessions) is implemented and verified.
 * Capabilities 2 (quota probe) and 3 (resume a turn) are placeholders — see README.
 */
export class ClaudeAdapter implements Adapter {
  readonly kind = "claude" as const;

  constructor(
    private readonly bin: string,
    private readonly onDebug: (msg: string) => void,
    private readonly watch: FilterPolicy,
  ) {}

  resolveBin(): string {
    return this.bin;
  }

  async readQuota(): Promise<QuotaInfo> {
    throw new Error("Claude quota probe is not yet implemented");
  }

  async findInterrupted(filter: FilterPolicy): Promise<InterruptedSession[]> {
    const projectsDir = join(claudeConfigDir(), "projects");
    if (!existsSync(projectsDir)) return [];

    const cutoff = filter.maxAgeMinutes === null ? 0 : Date.now() - filter.maxAgeMinutes * 60_000;
    const quietCutoff = Date.now() - filter.minIdleMinutes * 60_000;
    const found: InterruptedSession[] = [];

    for (const project of safeReaddir(projectsDir)) {
      const projectDir = join(projectsDir, project);
      if (!isDir(projectDir)) continue;
      for (const entry of safeReaddir(projectDir)) {
        if (!entry.endsWith(".jsonl")) continue;
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

        if (state.spokenAt !== null && state.spokenAt > quietCutoff) continue;

        found.push({
          cli: "claude",
          sessionId: entry.replace(/\.jsonl$/, ""),
          turnId: state.tailKey,
          cwd: state.cwd,
          interruptedAt,
          detail: state.detail,
          resetsAt: null,
          model: state.model,
          spoken: state.spoken,
        });
      }
    }

    return found.sort((a, b) => b.interruptedAt - a.interruptedAt);
  }

  async resume(_session: InterruptedSession, _prompt: string): Promise<ResumeResult> {
    throw new Error("Claude resume is not yet implemented");
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
  detail: string;
  model: string | null;
  /** uuid of the newest record: the cheapest identity for how far the session got, and what tells
   * one quota interruption from the next — timestamps are too coarse to. */
  tailKey: string | null;
  spokenAt: number | null;
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

  let lastError: { at: number; text: string; tag: string | null } | null = null;
  let lastSuccessAfterError = false;
  let cwd = "";
  let tailKey: string | null = null;
  let spokenAt: number | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = record["type"];
    if (!tailKey && typeof record["uuid"] === "string") tailKey = record["uuid"] as string;
    if (!cwd && typeof record["cwd"] === "string") cwd = record["cwd"] as string;
    if (spokenAt === null) {
      const at = Date.parse(String(record["timestamp"] ?? "")) || 0;
      const said = type === "user" || (type === "assistant" && record["isApiErrorMessage"] !== true);
      if (said && at > 0) spokenAt = at;
    }

    if (type === "assistant") {
      if (record["isApiErrorMessage"] === true) {
        if (!lastError) {
          const message = record["message"] as { content?: unknown } | undefined;
          lastError = {
            at: Date.parse(String(record["timestamp"] ?? "")) || 0,
            tag: typeof record["error"] === "string" ? (record["error"] as string) : null,
            text: messageText(message?.content),
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
      detail: "no recent error",
      tailKey,
      spokenAt,
      spoken,
      model,
    };
  }
  if (lastSuccessAfterError) {
    return {
      quotaError: false,
      cwd,
      errorAt: null,
      detail: "last turn succeeded",
      tailKey,
      spokenAt,
      spoken,
      model,
    };
  }

  const { tag, text } = lastError;
  return {
    quotaError: tag === QUOTA_ERROR_TAG,
    cwd,
    errorAt: lastError.at || null,
    detail: oneLine(text) || (tag ? `error: ${tag}` : "unrecognized API error"),
    tailKey,
    spokenAt,
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
    if (at > 0 && text) said.push({ at, text });
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
