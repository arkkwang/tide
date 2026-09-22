import { readFileSync } from "node:fs";
import type { Config } from "./config.js";
import { buildAdapters, locateSessions } from "./commands.js";
import { readTranscript, tailTranscript, textHash, waitForTurn } from "./transcript.js";

export interface ControlOptions {
  command: string;
  cli?: string;
  id?: string;
  limit?: number;
  after?: string;
  timeout?: number;
  message?: string;
  messageFile?: string;
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
      const { messages, cursor, ...rest } = result;
      console.log(JSON.stringify(rest, null, 2));
      for (const m of (messages ?? []) as Array<{ role: string; text: string }>) console.log(`\n[${m.role}]\n${m.text}`);
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
    if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous session ID; use the full ID" : "Session not found in recent transcripts");
    const { adapter, session } = matches[0]!;
    const identity = { cli: adapter.kind, sessionId: session.sessionId };
    if (options.command === "tail") {
      print({ ok: true, ...identity, ...tailTranscript(adapter.kind, session, options.limit ?? 10, options.after) });
      return 0;
    }
    if (options.command === "wait") {
      const result = await waitForTurn(adapter.kind, session, options.after!, options.timeout ?? 60);
      print({ ...identity, ...result });
      return result.ok ? 0 : result.status === "timed-out" ? 3 : 1;
    }
    const snapshot = readTranscript(adapter.kind, session);
    const cursor = snapshot.cursor(undefined, textHash(message!));
    const result = options.dryRun
      ? { ok: true, delivered: false, via: "dry-run", detail: "No message sent or window opened" }
      : await adapter.resume(session, message!);
    print({ ...identity, ...result, cursor,
      stage: !result.delivered ? "not-confirmed" : adapter.kind === "codex" ? "queued" : "window-requested" });
    return result.ok ? 0 : 1;
  } catch (error) {
    print({ ok: false, detail: (error as Error).message });
    return 2;
  }
}
