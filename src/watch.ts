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

/** Apply the operator's allow list to the detected sessions. When sessionAll is set, returns them
 * all; otherwise each prefix narrows the list by `startsWith` (full ids always match themselves).
 * An ambiguous prefix is skipped with a warning rather than picking one — resuming the wrong
 * session is the worse error. */
function applyAllowList(
  adapter: Adapter,
  detected: InterruptedSession[],
  config: Config,
): { sessions: InterruptedSession[]; filteredNote: string } {
  if (config.sessionAll) {
    return { sessions: [...detected], filteredNote: "" };
  }
  const sessions: InterruptedSession[] = [];
  const seen = new Set<string>();
  for (const prefix of config.sessionAllowList) {
    const matches = detected.filter((s) => s.sessionId.startsWith(prefix));
    if (matches.length === 1) {
      const only = matches[0]!;
      if (!seen.has(only.sessionId)) {
        sessions.push(only);
        seen.add(only.sessionId);
      }
    } else if (matches.length > 1) {
      console.info(`  ${adapter.kind}: --session ${prefix} is ambiguous (${matches.length} matches), skipped — be more specific`);
      for (const m of matches) {
        console.info(`    candidate: ${m.sessionId}`);
      }
    }
  }
  const filteredCount = detected.length - sessions.length;
  const note = filteredCount > 0 ? ` (${filteredCount} not in --session allow list)` : "";
  return { sessions, filteredNote: note };
}

/** Render one waiting session as a single line: id, optional [source], cwd, detail, last user utterance. */
function summarizeSession(
  adapter: Adapter,
  session: InterruptedSession,
  config: Config,
): string {
  const parts = [`${adapter.kind}/${short(session.sessionId)}`];
  if (session.source) parts.push(`[${session.source}]`);
  parts.push(session.cwd, oneLine(session.detail));
  const last = lastUserUtterance(session.spoken, config.resume.prompt);
  if (last) parts.push(`you said: ${JSON.stringify(oneLine(last.text, 80))}`);
  return parts.join("  ");
}

/** Run the quota probe (unless skipped), report the outcome, and say whether resume should proceed. */
async function decideQuota(adapter: Adapter, config: Config): Promise<"proceed" | "blocked"> {
  if (config.skipQuotaCheck) {
    console.info(`  ${adapter.kind}: quota check skipped (--skip-quota-check)`);
    return "proceed";
  }
  const quota = await adapter.readQuota();
  if (quota.allowed) return "proceed";
  const reason = quota.blockedReason ?? "unknown";
  const when = quota.nextResetAt ? `, next reset ${localTimestamp(new Date(quota.nextResetAt * 1_000))}` : "";
  console.info(`  ${adapter.kind}: quota blocked (${reason})${when} — skipping resume`);
  return "blocked";
}

/** Resume one session and log the outcome. In dry-run mode, just describe what would happen. */
async function resumeSession(
  adapter: Adapter,
  session: InterruptedSession,
  config: Config,
): Promise<void> {
  const id = `${adapter.kind}/${short(session.sessionId)}`;
  if (config.dryRun) {
    console.info(`    ${id}: would resume in ${session.cwd}`);
    return;
  }
  const result = await adapter.resume(session, config.resume.prompt);
  console.info(`    ${id}: ${result.ok ? "ok" : "FAIL"} via ${result.via} — ${oneLine(result.detail)}`);
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
    const detected = await waitingSessions(adapter, config);
    const allowed = applyAllowList(adapter, detected, config);
    console.info(`  ${adapter.kind}: ${allowed.sessions.length} waiting${allowed.filteredNote}`);
    if (allowed.sessions.length === 0) return;
    for (const session of allowed.sessions) {
      console.info(`    ${summarizeSession(adapter, session, config)}`);
    }
    if ((await decideQuota(adapter, config)) === "blocked") return;
    console.info(`  ${adapter.kind}: quota ok — resuming ${allowed.sessions.length}${config.dryRun ? " (--dry-run)" : ""}`);
    for (const session of allowed.sessions) {
      if (this.stopping) break;
      await resumeSession(adapter, session, config);
    }
  }
}
