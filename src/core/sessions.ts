import { setTimeout as delay } from "node:timers/promises";
import type { Adapter, DeliveryResult, Session } from "./session.js";

/** Session operations share selection, validation and acknowledgement semantics here. */
export class Sessions {
  constructor(private readonly provider: Adapter) {}

  get kind() { return this.provider.kind; }
  get canSend() { return this.provider.send !== undefined; }
  resolveBin() { return this.provider.resolveBin(); }
  readQuota() { return this.provider.readQuota(); }
  list() { return this.provider.findSessions(); }
  history(session: Session, after?: string) { return this.provider.history(session, after); }
  async sessionForProcess(pid: number) { return this.provider.sessionForProcess?.(pid) ?? null; }
  async ownsIdleProcess(sessionId: string, pid: number) { return this.provider.ownsIdleProcess?.(sessionId, pid) ?? false; }
  async prepareLaunch(args: string[]) { return this.provider.prepareLaunch?.(args) ?? { args: [...args], sessionId: null }; }

  async find(id: string) {
    if (!id) throw new Error("Session ID must not be empty");
    return (await this.list()).filter((s) => s.sessionId.startsWith(id));
  }

  state(session: Session) {
    return { sessionId: session.sessionId, cwd: session.cwd, currentState: "unknown" as const,
      lastEvent: session.lastEvent, lastAssistantAt: session.lastAssistantAt, isSubagent: session.isSubagent };
  }

  snapshot(session: Session, limit = 10) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    return this.provider.snapshot(session, limit);
  }

  async send(session: Session, message: string, mode: "queue" | "interrupt" = "queue", dryRun = false): Promise<DeliveryResult> {
    if (mode !== "queue" && mode !== "interrupt") throw new Error("Message mode must be queue or interrupt");
    if (!message.trim()) throw new Error("Message must not be empty");
    if (session.isSubagent) throw new Error("Session control supports main sessions only");
    if (mode === "interrupt" || !this.provider.send) return {
      ok: false, delivered: false, unsupported: true, via: "none",
      detail: mode === "interrupt" ? "Immediate interruption is not supported by this integration" :
        "Live messaging is not supported by this integration; use resume explicitly to launch a closed session",
    };
    if (dryRun) return { ok: true, delivered: false, via: "dry-run", detail: "No message sent" };
    return this.provider.send(session, message);
  }

  async launchSession(session: Session, initialMessage: string) {
    if (session.isSubagent) throw new Error("Only main sessions can be launched");
    if (!initialMessage.trim()) throw new Error("Initial message must not be empty");
    if (!this.provider.launchSession) return { ok: false, requested: false, detail: "Launching an existing session in a new window is not supported by this integration" };
    return this.provider.launchSession(session, initialMessage);
  }

  /** Observation only. Consumers choose whether and how to act on each sample. */
  async *monitor(intervalMs: number, signal: AbortSignal): AsyncGenerator<Session[]> {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("Monitor interval must be positive");
    while (!signal.aborted) {
      const sample = await this.list();
      if (signal.aborted) return;
      yield sample;
      try { await delay(intervalMs, undefined, { signal }); }
      catch (error) { if (signal.aborted) return; throw error; }
    }
  }
}

export async function locateSessions(systems: Sessions[], id: string) {
  const matches: Array<{ adapter: Sessions; session: Session }> = [];
  for (const adapter of systems) for (const session of await adapter.find(id)) matches.push({ adapter, session });
  return matches;
}
