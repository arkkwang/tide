/**
 * The watch loop, and the contract it demands of a CLI. `Adapter` lives beside the watcher
 * that consumes it; each supported CLI implements it in its own file.
 */
import { unixMs, type CliKind, type Config, type FilterPolicy, type Logger } from "./store.js";

export interface WindowInfo {
  usedPercent: number;
  resetsAt: number | null;
}

export interface QuotaInfo {
  allowed: boolean;
  blockedReason: "window" | "credits" | "unknown" | null;
  primary: WindowInfo | null;
  secondary: WindowInfo | null;
  nextResetAt: number | null;
  plan: string | null;
  notes: string[];
}

export interface Utterance {
  at: number;
  text: string;
}

export const SPOKEN_COUNT = 3;
export const SPOKEN_CHARS = 80;

export interface InterruptedSession {
  cli: CliKind;
  sessionId: string;
  turnId: string | null;
  cwd: string;
  interruptedAt: number;
  detail: string;
  resetsAt: number | null;
  model?: string | null;
  source?: string | null;
  spoken?: Utterance[];
}

export interface ResumeResult {
  ok: boolean;
  delivered: boolean;
  via: string;
  detail: string;
  uncertain?: boolean;
  deferred?: boolean;
}

export interface Adapter {
  readonly kind: CliKind;

  resolveBin(): string | null;

  /** Read the account's current quota state. Must not consume quota. */
  readQuota(): Promise<QuotaInfo>;

  findInterrupted(filter: FilterPolicy): Promise<InterruptedSession[]>;

  resume(session: InterruptedSession, prompt: string): Promise<ResumeResult>;

  close?(): void;
}

export const IDLE_INTERVAL_MS = 30_000;
export const MIN_INTERVAL_MS = 1_000;
const RESET_GRACE_MS = 15_000;
export const MAX_RESET_WAIT_MS = 6 * 60 * 60_000;

export async function waitingSessions(
  adapter: Adapter,
  config: Config,
): Promise<InterruptedSession[]> {
  const quietCutoff = Date.now() - config.filter.minIdleMinutes * 60_000;
  const interrupted = await adapter.findInterrupted(config.filter);
  return interrupted.filter((s) => s.interruptedAt <= quietCutoff);
}

export interface WatcherDeps {
  config: Config;
  log: Logger;
  adapters: Adapter[];
}

export class Watcher {
  private stopping = false;
  private wake: (() => void) | null = null;

  constructor(private readonly deps: WatcherDeps) {}

  stop(): void {
    this.stopping = true;
    this.wake?.();
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  async run(): Promise<void> {
    const { log } = this.deps;
    log.info(`watcher started (dry-run=${this.deps.config.dryRun})`);
    while (!this.stopping) {
      const sleepMs = await this.pass();
      if (this.stopping) break;
      await this.sleep(Math.max(MIN_INTERVAL_MS, sleepMs));
    }
    log.info("watcher stopped");
  }

  async runOnce(): Promise<number> {
    this.deps.log.info(`single pass (dry-run=${this.deps.config.dryRun})`);
    return await this.pass();
  }

  private async pass(): Promise<number> {
    let sleepMs = IDLE_INTERVAL_MS;
    for (const adapter of this.deps.adapters) {
      if (this.stopping) break;
      sleepMs = Math.min(sleepMs, await this.tick(adapter));
    }
    return sleepMs;
  }

  private async tick(adapter: Adapter): Promise<number> {
    const { log, config } = this.deps;
    const waiting = await waitingSessions(adapter, config);
    if (waiting.length === 0) return IDLE_INTERVAL_MS;

    const quota = await adapter.readQuota();
    log.debug(
      `${adapter.kind}: allowed=${quota.allowed} reason=${quota.blockedReason}` +
        ` reset=${quota.nextResetAt ? new Date(unixMs(quota.nextResetAt)).toISOString() : "-"}`,
    );

    if (!quota.allowed) {
      if (quota.nextResetAt) {
        const untilResetMs = unixMs(quota.nextResetAt) - Date.now();
        if (untilResetMs > 0) return Math.min(untilResetMs + RESET_GRACE_MS, MAX_RESET_WAIT_MS);
      }
      return IDLE_INTERVAL_MS;
    }

    for (const session of waiting) {
      if (this.stopping) break;
      if (config.dryRun) {
        log.info(`${adapter.kind}/${short(session.sessionId)}: [dry-run] would resume in ${session.cwd}`);
        continue;
      }
      await adapter.resume(session, config.resume.prompt);
    }
    return IDLE_INTERVAL_MS;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

export function short(id: string): string {
  return id.slice(0, 8);
}
