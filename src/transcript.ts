import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CliKind } from "./config.js";
import type { Session } from "./watch.js";

type Row = Record<string, any>;
export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string | null;
}
export interface TranscriptEvent {
  offset: number;
  message?: TranscriptMessage;
  outcome?: "completed" | "errored" | "quota-limited" | "aborted";
  evidence?: string;
}
interface Cursor {
  v: 1;
  cli: CliKind;
  id: string;
  offset: number;
  digest: string;
  expected?: string;
}

export const textHash = (text: string): string => createHash("sha256").update(text).digest("hex");
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
  return event;
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

export function tailTranscript(cli: CliKind, session: Session, limit: number, after?: string) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const snapshot = readTranscript(cli, session, after);
  const messages = snapshot.events.filter((e) => e.message);
  const selected = after === undefined ? messages.slice(-limit) : messages.slice(0, limit);
  const hasMore = after !== undefined && messages.length > selected.length;
  const cursor = snapshot.cursor(hasMore ? selected.at(-1)!.offset : undefined, null);
  return { messages: selected.map((e) => e.message!), cursor, hasMore };
}

const WAIT_POLL_MS = 1000;
export async function waitForTurn(cli: CliKind, session: Session, after: string, timeoutSeconds: number) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) throw new Error("timeout must be a nonnegative number of seconds");
  const deadline = Date.now() + timeoutSeconds * 1000;
  let cursor = after;
  let matching = false;
  let lastText = "";
  for (;;) {
    const snapshot = readTranscript(cli, session, cursor);
    if (!snapshot.expected) matching = true;
    for (const event of snapshot.events) {
      if (event.message?.role === "user") {
        if (snapshot.expected && textHash(event.message.text) === snapshot.expected) matching = true;
        if (matching) lastText = "";
      }
      if (matching && event.message?.role === "assistant") lastText = event.message.text;
      if (matching && event.outcome) {
        return { ok: event.outcome === "completed", status: event.outcome, evidence: event.evidence, text: lastText, cursor: snapshot.cursor(event.offset, null) };
      }
    }
    cursor = snapshot.cursor();
    if (Date.now() >= deadline) {
      // Preserve the original baseline so a later wait can reconstruct the same turn.
      return { ok: false, status: "timed-out", evidence: "No matching terminal event observed; outcome unknown", text: lastText, cursor: after };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_POLL_MS, deadline - Date.now())));
  }
}
