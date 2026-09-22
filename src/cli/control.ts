import { readFileSync } from "node:fs";
import type { Config } from "../config.js";
import { buildAdapters } from "../providers/index.js";
import { locateSessions } from "../core/sessions.js";
import { tailTranscript, textHash, waitForTurn } from "../features/conversation.js";

export interface ControlOptions {
  command: string;
  cli?: string;
  id?: string;
  limit?: number;
  after?: string;
  timeout?: number;
  message?: string;
  messageFile?: string;
  mode?: "queue" | "interrupt";
  dryRun?: boolean;
  json: boolean;
}

export function inputMessage(options: Pick<ControlOptions, "message" | "messageFile">): string {
  if ((options.message === undefined) === (options.messageFile === undefined)) throw new Error("send requires exactly one of --message or --message-file");
  const text = options.message ?? readFileSync(options.messageFile!, "utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) throw new Error("Message must not be empty");
  return text;
}

export async function commandControl(config: Config, options: ControlOptions): Promise<number> {
  const print = (result: Record<string, unknown>) => {
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      const { messages, cursor } = result;
      if (result.sessionId) console.log(`${result.cli}/${result.sessionId}`);
      if (result.lastEvent) console.log(`Last recorded event: ${result.lastEvent}; current state: ${result.currentState}`);
      if (result.cwd) console.log(`Directory: ${result.cwd}`);
      if (result.observedAt) console.log(`Observed: ${result.observedAt}`);
      if (result.stage) console.log(`Delivery: ${result.stage}`);
      if (result.status) console.log(`Observed outcome: ${result.status}`);
      if (result.detail) console.log(`${result.ok === false ? "Not completed: " : ""}${result.detail}`);
      if (result.evidence) console.log(String(result.evidence));
      if (result.text) console.log(`\n[assistant]\n${result.text}`);
      for (const m of (messages ?? []) as Array<{ role: string; text: string }>) console.log(`\n[${m.role}]\n${m.text}`);
      if (Array.isArray(messages) && messages.length === 0) console.log("No recorded text in this view.");
      if (result.truncated) console.log("Showing a limited history snapshot.");
      if (result.hasMore) console.log("More messages available; use tail --after with the cursor below.");
      if (cursor) console.log(`\ncursor: ${cursor}`);
    }
  };
  try {
    if (!options.id || !options.cli) throw new Error(`${options.command} requires <session-id> and --cli codex|claude`);
    const message = options.command === "send" ? inputMessage(options) : undefined;
    if (options.command === "wait" && !options.after) throw new Error("wait requires --after <cursor> from send or tail");
    const { adapters, problems } = buildAdapters(config, options.cli);
    if (problems.length) throw new Error(problems.join("; "));
    const matches = await locateSessions(adapters, options.id);
    if (matches.length !== 1) throw new Error(matches.length
      ? `Ambiguous session ID "${options.id}"; use more of the ID: ${matches.map((m) => m.session.sessionId).join(", ")}`
      : `No session matching "${options.id}" in recent history. Use tide status --cli ${options.cli} to find an ID.`);
    const { adapter, session } = matches[0]!;
    const identity = { cli: adapter.kind, sessionId: session.sessionId };
    if (options.command === "snapshot") {
      print({ ok: true, ...adapter.snapshot(session, options.limit ?? 10) });
      return 0;
    }
    if (options.command === "tail") {
      print({ ok: true, ...identity, ...tailTranscript(adapter, session, options.limit ?? 10, options.after) });
      return 0;
    }
    if (options.command === "wait") {
      const result = await waitForTurn(adapter, session, options.after!, options.timeout ?? 60);
      print({ ...identity, ...result });
      return result.ok ? 0 : result.status === "timed-out" ? 3 : 1;
    }
    const snapshot = adapter.history(session);
    const cursor = snapshot.cursor(undefined, textHash(message!));
    const result = await adapter.send(session, message!, options.mode, options.dryRun);
    print({ ...identity, ...result, cursor,
      stage: result.delivered ? "queued" : result.unsupported ? "unsupported" : result.via === "dry-run" ? "dry-run" : "not-confirmed" });
    return result.ok ? 0 : 1;
  } catch (error) {
    print({ ok: false, detail: (error as Error).message });
    return 2;
  }
}
