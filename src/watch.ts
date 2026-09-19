/**
 * The watch loop, and the contract it demands of a CLI. `Adapter` lives beside the watcher
 * that consumes it; each supported CLI implements it in its own file.
 */
import { type CliKind, type Config, type FilterPolicy } from "./config.js";
import { formatDuration, humanizeIdleDuration, localTimestamp, oneLine, short } from "./util.js";

export interface WindowInfo {
  usedPercent: number;
  resetsAt: number | null;
}

export interface QuotaInfo {
  allowed: boolean;
  blockedReason: "window" | "credits" | "rate_limit" | "unknown" | null;
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

export const SPOKEN_COUNT = 20;
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

/** Detect quota-interrupted sessions and apply the idle filter: a session must have been quiet
 * for at least `config.filter.minIdleMinutes` (default 5) since its last task_complete before the
 * watcher will resume it. The cutoff protects against resuming a session that just produced the
 * error — the user might be at the screen about to react, or the CLI might be retrying itself.
 * Returns the survivors and the count dropped here, so the operator can tell the difference
 * between "the watcher found nothing" and "the watcher found something but it is too fresh". */
export async function waitingSessions(
  adapter: Adapter,
  config: Config,
): Promise<{ sessions: InterruptedSession[]; notIdle: InterruptedSession[] }> {
  const quietCutoff = Date.now() - config.filter.minIdleMinutes * 60_000;
  const interrupted = await adapter.findInterrupted(config.filter);
  const sessions: InterruptedSession[] = [];
  const notIdle: InterruptedSession[] = [];
  for (const s of interrupted) {
    if (s.interruptedAt <= quietCutoff) sessions.push(s);
    else notIdle.push(s);
  }
  return { sessions, notIdle };
}

/** Apply the operator's allow list to the detected sessions. When sessionAll is set, returns them
 * all; otherwise each prefix narrows the list by `startsWith` (full ids always match themselves).
 * An ambiguous prefix is skipped with a warning rather than picking one — resuming the wrong
 * session is the worse error. */
function applyAllowList(
  adapter: Adapter,
  detected: InterruptedSession[],
  config: Config,
): InterruptedSession[] {
  if (config.sessionAll) {
    return [...detected];
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
  return sessions;
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

/** Print one waiting session in the multi-line format: an id/cwd header, then the detail line,
 * then the last thing the user actually said (skipping our own resume prompts), then how long
 * this session has been idle for. Shared by the watcher and the status command so the two views
 * never disagree — every line comes from the same helper. */
export function printWaitingSession(session: InterruptedSession, config: Config): void {
  const tags = [
    session.model ? `[${session.model}]` : null,
    session.source ? `[${session.source}]` : null,
  ].filter((s): s is string => s !== null);
  const tagStr = tags.length > 0 ? `  ${tags.join("  ")}` : "";
  console.info(`      ${short(session.sessionId)}  ${session.cwd}${tagStr}`);
  console.info(`          ${oneLine(session.detail)}`);
  const last = lastUserUtterance(session.spoken, config.resume.prompt);
  if (last) console.info(`          last you said: ${JSON.stringify(last.text)}`);
  console.info(`          idle for: ${humanizeIdleDuration(Date.now() - session.interruptedAt)}`);
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
    const allowed = applyAllowList(adapter, detected.sessions, config);
    const totalFound = detected.sessions.length + detected.notIdle.length;
    const allowFiltered = detected.sessions.length - allowed.length;
    const notes: string[] = [];
    if (totalFound > 0) notes.push(`${totalFound} detected`);
    if (detected.notIdle.length > 0) {
      const needMin = config.filter.minIdleMinutes;
      notes.push(`${detected.notIdle.length} not idle for ${needMin} minute${needMin === 1 ? "" : "s"} yet`);
    }
    if (allowFiltered > 0) notes.push(`${allowFiltered} not in --session allow list`);
    const note = notes.length > 0 ? ` (${notes.join(", ")})` : "";
    console.info(`  ${adapter.kind}: ${allowed.length} waiting${note}`);
    // Print every session through the same helper, so a `idle for:` line follows each block —
    // including the ones still too fresh to resume.
    for (const session of [...allowed, ...detected.notIdle]) {
      printWaitingSession(session, config);
    }
    if (allowed.length === 0) return;
    if ((await decideQuota(adapter, config)) === "blocked") return;
    console.info(`  ${adapter.kind}: quota ok — resuming ${allowed.length}${config.dryRun ? " (--dry-run)" : ""}`);
    for (const session of allowed) {
      if (this.stopping) break;
      await resumeSession(adapter, session, config);
    }
  }
}
