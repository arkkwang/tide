import { createHash } from "node:crypto";
import type { Sessions } from "../core/sessions.js";
import type { Session } from "../core/session.js";

export const textHash = (text: string): string => createHash("sha256").update(text).digest("hex");

export function tailTranscript(system: Sessions, session: Session, limit: number, after?: string) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const snapshot = system.history(session, after);
  const messages = snapshot.events.filter((e) => e.message);
  const selected = after === undefined ? messages.slice(-limit) : messages.slice(0, limit);
  const hasMore = after !== undefined && messages.length > selected.length;
  const cursor = snapshot.cursor(hasMore ? selected.at(-1)!.offset : undefined, null);
  return { messages: selected.map((e) => e.message!), cursor, hasMore };
}

const WAIT_POLL_MS = 1000;
export async function waitForTurn(system: Sessions, session: Session, after: string, timeoutSeconds: number) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) throw new Error("timeout must be a nonnegative number of seconds");
  const deadline = Date.now() + timeoutSeconds * 1000;
  let cursor = after;
  let matching = false;
  let lastText = "";
  for (;;) {
    const snapshot = system.history(session, cursor);
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
