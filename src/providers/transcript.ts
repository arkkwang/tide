import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CliKind } from "../config.js";
import type { Session, ExecutionSnapshot, TranscriptEvent } from "../core/session.js";

type Row = Record<string, any>;
interface Cursor {
  v: 1;
  cli: CliKind;
  id: string;
  offset: number;
  digest: string;
  expected?: string;
}

const digest = (data: Buffer, offset: number): string => createHash("sha256").update(data.subarray(0, offset)).digest("hex");
const encode = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");

function decode(token: string): Cursor {
  try {
    if (token.length > 2048 || !/^[\w-]+$/.test(token)) throw new Error();
    const c = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (c.v !== 1 || !["codex", "claude"].includes(c.cli) || typeof c.id !== "string" ||
        !Number.isSafeInteger(c.offset) || c.offset < 0 || !/^[a-f0-9]{64}$/.test(c.digest) ||
        (c.expected !== undefined && !/^[a-f0-9]{64}$/.test(c.expected))) throw new Error();
    return c;
  } catch { throw new Error("Invalid cursor; obtain a new one with tail"); }
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && ["text", "input_text", "output_text"].includes(part.type) && typeof part.text === "string")
    .map((part) => part.text).join("\n");
}

export function parseEvent(cli: CliKind, row: Row, offset: number): TranscriptEvent {
  const event: TranscriptEvent = { offset };
  const message = (role: "user" | "assistant", content: unknown) => {
    const text = textContent(content);
    if (text) event.message = { role, text, timestamp: typeof row.timestamp === "string" ? row.timestamp : null };
  };
  if (cli === "claude") {
    if (row.type === "user" && !row.isMeta) message("user", row.message?.content);
    if (row.type === "assistant") {
      message("assistant", row.message?.content);
      if (row.message?.stop_reason === "tool_use" || row.message?.content?.some?.((p: Row) => p.type === "tool_use")) event.state = "running";
      if (row.isApiErrorMessage === true) {
        event.outcome = row.error === "rate_limit" ? "quota-limited" : "errored";
        event.evidence = "assistant.isApiErrorMessage";
      }
    }
    // end_turn can appear on multiple streamed blocks, including thinking blocks.
    // turn_duration is written after the whole interactive turn has ended.
    if (row.type === "system" && row.subtype === "turn_duration") {
      event.outcome = "completed";
      event.evidence = "system.turn_duration (turn ended; not task acceptance)";
    }
  } else if (row.type === "event_msg") {
    const p = row.payload ?? {};
    if (p.type === "task_started" || p.type === "item_completed" && p.item?.type === "FunctionCall") event.state = "running";
    if (p.type === "item_completed") {
      if (p.item?.type === "UserMessage") message("user", p.item.content);
      if (p.item?.type === "AssistantMessage") message("assistant", p.item.content ?? p.item.text);
    }
    if (p.type === "user_message") message("user", p.message);
    if (p.type === "agent_message") message("assistant", p.message);
    if (p.type === "task_complete") {
      const tag = p.error?.codex_error_info;
      event.outcome = ["usage_limit_exceeded", "rate_limit_exceeded"].includes(tag) ? "quota-limited" : p.error ? "errored" : "completed";
      event.evidence = "event_msg.task_complete";
    }
    if (p.type === "turn_aborted") {
      event.outcome = "aborted";
      event.evidence = "event_msg.turn_aborted";
    }
  }
  if (event.message?.role === "user") event.state = "running";
  if (event.outcome) event.state = event.outcome;
  return event;
}

export function executionSnapshot(cli: CliKind, session: Session, limit = 10): ExecutionSnapshot {
  const snapshot = readTranscript(cli, session);
  const lastEvent = snapshot.events.filter((e) => e.state).at(-1)?.state ?? "unknown";
  const messages = snapshot.events.flatMap((e) => e.message ? [e.message] : []);
  return { sessionId: session.sessionId, cli, cwd: session.cwd, observedAt: new Date().toISOString(),
    currentState: "unknown", lastEvent, messages: messages.slice(-limit), truncated: messages.length > limit };
}

export function readTranscript(cli: CliKind, session: Session, after?: string) {
  if (!session.transcriptPath) throw new Error("Session has no readable transcript");
  if (session.isSubagent) throw new Error("Session control currently supports main sessions only");
  const data = readFileSync(session.transcriptPath);
  const end = data.lastIndexOf(10) + 1;
  const baseline = after === undefined ? undefined : decode(after);
  if (baseline && (baseline.cli !== cli || baseline.id !== session.sessionId)) throw new Error("Cursor belongs to a different session");
  if (baseline && (baseline.offset > end || (baseline.offset > 0 && data[baseline.offset - 1] !== 10) || digest(data, baseline.offset) !== baseline.digest)) {
    throw new Error("Transcript changed or was truncated; cursor is stale");
  }
  let identity: string | undefined;
  const events: TranscriptEvent[] = [];
  let start = 0;
  while (start < end) {
    const next = data.indexOf(10, start) + 1;
    const line = data.subarray(start, next).toString("utf8").replace(/^\uFEFF/, "").trim();
    if (line) {
      let row: Row;
      try { row = JSON.parse(line); } catch { throw new Error(`Malformed transcript record at byte ${start}`); }
      if (!row || typeof row !== "object") throw new Error(`Invalid transcript record at byte ${start}`);
      const id = cli === "claude" ? row.sessionId : row.type === "session_meta" ? row.payload?.id : undefined;
      if (typeof id === "string") {
        if (identity && identity !== id) throw new Error("Transcript contains conflicting session IDs");
        identity = id;
      }
      if (next > (baseline?.offset ?? 0)) events.push(parseEvent(cli, row, next));
    }
    start = next;
  }
  if (identity !== session.sessionId) throw new Error("Transcript metadata does not match the selected session");
  const cursor = (offset = end, expected: string | null | undefined = baseline?.expected): string => encode({
    v: 1, cli, id: session.sessionId, offset, digest: digest(data, offset),
    ...(expected ? { expected } : {}),
  });
  return { events, cursor, expected: baseline?.expected };
}
