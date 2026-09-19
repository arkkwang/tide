/**
 * The watch loop, and the contract it demands of a CLI. `Adapter` lives beside the watcher
 * that consumes it; each supported CLI implements it in its own file.
 */
import { type CliKind, type Config, type FilterPolicy } from "./config.js";
import { localTimestamp, oneLine, short } from "./util.js";

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

/** The most recent utterance that is not the resume prompt we sent — i.e. the last thing the
 * person actually said. Null when every recorded utterance is one of our own resumes. */
export function lastUserUtterance(
  spoken: Utterance[] | undefined,
  resumePrompt: string,
): Utterance | null {
  if (!spoken) return null;
  for (let i = spoken.length - 1; i >= 0; i--) {
    const said = spoken[i]!;
    if (said.text !== resumePrompt) return said;
  }
  return null;
}

export interface WatcherDeps {
  config: Config;
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
    console.info(`watcher started (dry-run=${this.deps.config.dryRun})`);
    while (!this.stopping) {
      await this.sweep();
      if (this.stopping) {
        break;
      }
      await this.sleep(IDLE_INTERVAL_MS);
    }
    console.info("watcher stopped");
  }

  async runOnce(): Promise<void> {
    console.info(`single pass (dry-run=${this.deps.config.dryRun})`);
    await this.sweep();
  }

  private async sweep(): Promise<void> {
    if (!this.stopping) {
      console.info(`sweep @${localTimestamp()}`);
    }
    for (const adapter of this.deps.adapters) {
      if (this.stopping) {
        break;
      }
      await this.tryAdapter(adapter);
    }
  }

  private async tryAdapter(adapter: Adapter): Promise<void> {
    const { config } = this.deps;
    const waiting = await waitingSessions(adapter, config);
    console.info(`  ${adapter.kind}: ${waiting.length} waiting`);
    if (waiting.length === 0) return;
    for (const session of waiting) {
      const parts = [`${adapter.kind}/${short(session.sessionId)}`];
      if (session.source) parts.push(`[${session.source}]`);
      parts.push(session.cwd, oneLine(session.detail));
      const last = lastUserUtterance(session.spoken, config.resume.prompt);
      if (last) parts.push(`you said: ${JSON.stringify(oneLine(last.text, 80))}`);
      console.info(`    ${parts.join("  ")}`);
    }
    if (!config.skipQuotaCheck) {
      const quota = await adapter.readQuota();
      if (!quota.allowed) {
        const reason = quota.blockedReason ?? "unknown";
        const when = quota.nextResetAt ? `, next reset ${localTimestamp(new Date(quota.nextResetAt * 1_000))}` : "";
        console.info(`  ${adapter.kind}: quota blocked (${reason})${when} — skipping resume`);
        return;
      }
    } else {
      console.info(`  ${adapter.kind}: quota check skipped (--skip-quota-check)`);
    }
    console.info(`  ${adapter.kind}: quota ok — resuming ${waiting.length}${config.dryRun ? " (--dry-run)" : ""}`);
    for (const session of waiting) {
      if (this.stopping) {
        break;
      }
      if (config.dryRun) {
        console.info(`    ${adapter.kind}/${short(session.sessionId)}: would resume in ${session.cwd}`);
      } else {
        const result = await adapter.resume(session, config.resume.prompt);
        console.info(
          `    ${adapter.kind}/${short(session.sessionId)}: ${result.ok ? "ok" : "FAIL"} via ${result.via} — ${oneLine(result.detail)}`,
        );
      }
    }
  }
}
