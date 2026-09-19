/**
 * The watch loop, and the contract it demands of a CLI. `Adapter` lives beside the watcher
 * that consumes it; each supported CLI implements it in its own file.
 */
import { type CliKind, type Config, type FilterPolicy, type Logger } from "./store.js";

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
      await this.sweep();
      if (this.stopping) {
        break;
      }
      await this.sleep(IDLE_INTERVAL_MS);
    }
    log.info("watcher stopped");
  }

  async runOnce(): Promise<void> {
    this.deps.log.info(`single pass (dry-run=${this.deps.config.dryRun})`);
    await this.sweep();
  }

  private async sweep(): Promise<void> {
    for (const adapter of this.deps.adapters) {
      if (this.stopping) {
        break;
      }
      await this.tryAdapter(adapter);
    }
  }

  private async tryAdapter(adapter: Adapter): Promise<void> {
    const { log, config } = this.deps;
    const waiting = await waitingSessions(adapter, config);
    if (waiting.length > 0) {
      const quota = await adapter.readQuota();
      if (quota.allowed) {
        for (const session of waiting) {
          if (this.stopping) {
            break;
          }
          if (config.dryRun) {
            log.info(`${adapter.kind}/${short(session.sessionId)}: [dry-run] would resume in ${session.cwd}`);
          } else {
            await adapter.resume(session, config.resume.prompt);
          }
        }
      }
    }
  }
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

export function short(id: string): string {
  return id.slice(0, 8);
}
