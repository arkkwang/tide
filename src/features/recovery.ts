import { resumeSession } from "./resume.js";
import { Sessions } from "../core/sessions.js";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { DeliveryResult, Session } from "../core/session.js";

export function sameInterruption(before: Session, after: Session | undefined): boolean {
  return !!after && after.sessionId === before.sessionId && after.lastEvent === "quota-limited" &&
    after.lastAssistantAt === before.lastAssistantAt && JSON.stringify(after.spoken) === JSON.stringify(before.spoken);
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Both launch monitoring and independent watch use this single recovery policy. */
export class Recovery {
  constructor(private config: Config) {}

  async attempt(adapter: Sessions, session: Session, stopped: () => boolean,
    deliver: () => Promise<DeliveryResult> = () => resumeSession(adapter, session, this.config.resume.prompt),
  ): Promise<string> {
    const config = this.config;
    const cancelled = () => stopped() || existsSync(join(config.stateDir, "monitors", `${adapter.kind}-${session.sessionId}.stop`));
    if (cancelled() || session.lastEvent !== "quota-limited" || session.isSubagent && config.watchPolicy.skipSubagents ||
        config.sessionDenyList.some((id) => session.sessionId.startsWith(id))) return "Not eligible";
    if (Date.now() - session.lastAssistantAt < config.watchPolicy.idleMinutesBeforeResume * 60_000) return "Waiting before recovery";
    if (config.dryRun) return "Would recover this session (dry run; no quota probe)";
    const key = `${adapter.kind}-${session.sessionId}`;
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error("Invalid session ID");
    const dir = join(config.stateDir, "recovery");
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, `${key}.lock`);
    const statePath = join(dir, `${key}.json`);
    const acquire = () => {
      const fd = openSync(lockPath, "wx");
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
    };
    try { acquire(); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner: number;
      try { owner = Number(readFileSync(lockPath, "utf8")); } catch { return "Recovery lock unavailable"; }
      if (!Number.isSafeInteger(owner) || owner <= 0 || processAlive(owner)) return "Another recovery owns this session";
      return `Recovery owner exited; inspect ${lockPath} before removing the stale lock`;
    }
    try {
      const event = JSON.stringify([session.lastAssistantAt, session.spoken]);
      if (existsSync(statePath)) {
        const previous = JSON.parse(readFileSync(statePath, "utf8"));
        if (previous.event === event && previous.outcome !== "waiting") return `Recovery already ${previous.outcome}; not sending again`;
        if (previous.event === event && Date.now() < previous.nextProbeAt) return "Waiting for next quota check";
      }
      const waiting = { event, outcome: "waiting", nextProbeAt: Date.now() + Math.max(1000, config.watchPolicy.sweepIntervalMinutes * 60_000) };
      writeFileSync(statePath, JSON.stringify(waiting));
      if (!config.skipQuotaCheck && !(await adapter.readQuota()).allowed) return "Quota still blocked";
      const current = (await adapter.list()).find((s) => s.sessionId === session.sessionId);
      if (cancelled() || !sameInterruption(session, current)) return "Session changed; old recovery cancelled";
      // A crash or missing receipt leaves an unknown result, never an invitation to resend.
      writeFileSync(statePath, JSON.stringify({ event, outcome: "unknown", at: Date.now() }));
      const result = await deliver();
      if (result.ok || result.uncertain) {
        writeFileSync(statePath, JSON.stringify({ event, outcome: result.uncertain ? "unknown" : result.delivered ? "delivered" : "launch-requested", at: Date.now() }));
      } else {
        // A known rejection (for example an occupied Claude session) sent nothing.
        writeFileSync(statePath, JSON.stringify(waiting));
      }
      return result.detail;
    } catch (e) {
      return `Recovery not confirmed: ${(e as Error).message}`;
    } finally {
      unlinkSync(lockPath);
    }
  }
}
