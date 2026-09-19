/**
 * The watch loop, and the contract it demands of a CLI. `Adapter` lives beside the watcher
 * that consumes it; each supported CLI implements it in its own file.
 */
import {
  StateStore,
  unixMs,
  type CliKind,
  type Config,
  type FilterPolicy,
  type Logger,
  type SessionRecord,
} from "./store.js";

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
  /** Codex: delivery acknowledged, not model work completed. Claude retains legacy semantics. */
  ok: boolean;
  /** Whether the message reached the session, whatever the account said to it afterwards. */
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

  probe(sessions: InterruptedSession[]): Promise<boolean>;

  findInterrupted(filter: FilterPolicy): Promise<InterruptedSession[]>;

  resume(session: InterruptedSession, prompt: string): Promise<ResumeResult>;

  close?(): void;
}

export const IDLE_INTERVAL_MS = 30_000;

export const MIN_INTERVAL_MS = 1_000;

const RESET_GRACE_MS = 15_000;

export const MAX_RESET_WAIT_MS = 6 * 60 * 60_000;

function turnKeyOf(session: InterruptedSession): string {
  return session.turnId ?? String(session.interruptedAt);
}

function settledReason(
  record: SessionRecord | undefined,
  session: InterruptedSession,
  maxAttempts: number,
): string | null {
  if (!record) return null;
  if (record.turnKey !== turnKeyOf(session)) return null;
  if (record.deliveryUnknown) return "delivery outcome unknown; inspect the target before retrying";
  if (record.closed) return "closed";
  if (record.resumedAt) return "already resumed";
  if (record.attempts >= maxAttempts) return `gave up after ${record.attempts} attempts`;
  return null;
}

export async function waitingSessions(
  adapter: Adapter,
  state: StateStore,
  config: Config,
): Promise<InterruptedSession[]> {
  const quietCutoff = Date.now() - config.filter.minIdleMinutes * 60_000;
  const interrupted = await adapter.findInterrupted(config.filter);
  return interrupted.filter(
    (s) =>
      s.interruptedAt <= quietCutoff &&
      !settledReason(state.get(adapter.kind, s.sessionId), s, config.resume.maxAttempts),
  );
}

export interface WatcherDeps {
  config: Config;
  state: StateStore;
  log: Logger;
  adapters: Adapter[];
}

interface Pass {
  wakeMs: number;
  askAfterMs: number;
}

function answered(ms: number): Pass {
  return { wakeMs: ms, askAfterMs: ms };
}

export class Watcher {
  private stopping = false;
  private wake: (() => void) | null = null;

  /**
   * Per adapter: the instant before which that provider is not worth asking again. Kept across
   * sweeps, since a sweep sleeps for the earliest answer and would otherwise re-ask the rest.
   */
  private readonly askAfter = new Map<CliKind, number>();

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

  /**
   * One full sweep: sleeps for the earliest moment any adapter asked to be revisited, with no
   * ceiling — `IDLE_INTERVAL_MS` is what an adapter with nothing to report answers, not a cap.
   */
  private async pass(): Promise<number> {
    let sleepMs = Number.POSITIVE_INFINITY;
    for (const adapter of this.deps.adapters) {
      if (this.stopping) break;
      const askInMs = (this.askAfter.get(adapter.kind) ?? 0) - Date.now();
      try {
        const answer = await this.tick(adapter, askInMs);
        this.askAfter.set(adapter.kind, Date.now() + answer.askAfterMs);
        sleepMs = Math.min(sleepMs, answer.wakeMs);
      } catch (err) {
        this.askAfter.delete(adapter.kind);
        this.deps.log.error(`${adapter.kind}: ${(err as Error).message}`);
      }
    }
    return Number.isFinite(sleepMs) ? sleepMs : IDLE_INTERVAL_MS;
  }

  private async tick(adapter: Adapter, askInMs: number): Promise<Pass> {
    const { log, config, state } = this.deps;

    const waiting = await waitingSessions(adapter, state, config);
    if (waiting.length === 0) return { wakeMs: IDLE_INTERVAL_MS, askAfterMs: askInMs };

    const notBeforeMs = Math.max(this.untilAttemptable(adapter, waiting), askInMs);
    if (notBeforeMs > 0) return { wakeMs: notBeforeMs, askAfterMs: askInMs };

    const now = Date.now();
    const quota = await adapter.readQuota();
    log.debug(
      `${adapter.kind}: allowed=${quota.allowed} reason=${quota.blockedReason} ` +
        `primary=${quota.primary ? `${quota.primary.usedPercent}%` : "-"} ` +
        `reset=${quota.nextResetAt ? new Date(unixMs(quota.nextResetAt)).toISOString() : "-"}`,
    );

    if (!quota.allowed) {
      if (quota.blockedReason === "credits") {
        log.warn(
          `${adapter.kind}: out of credits, not a waitable window — ${waiting.length} session(s) waiting. ` +
            `Top up and they will resume automatically.`,
        );
        return this.probeNow(adapter, waiting);
      }

      if (quota.nextResetAt) {
        const untilResetMs = unixMs(quota.nextResetAt) - now;
        if (untilResetMs > 0) {
          log.info(
            `${adapter.kind}: window closed, resets at ` +
              `${new Date(unixMs(quota.nextResetAt)).toISOString()} ` +
              `(in ${formatDuration(untilResetMs)}), ${waiting.length} session(s) waiting`,
          );
          return answered(Math.min(untilResetMs + RESET_GRACE_MS, MAX_RESET_WAIT_MS));
        }
      }
      return this.probeNow(adapter, waiting);
    }

    for (const session of waiting) {
      if (this.stopping) return answered(IDLE_INTERVAL_MS);
      await this.maybeResume(adapter, session);
    }
    return answered(IDLE_INTERVAL_MS);
  }

  /**
   * A retry cooldown is an input to this wait, not a per-round veto: a session inside one is
   * waiting but not attemptable, so it pushes the next ask out instead of being re-asked now.
   */
  private untilAttemptable(adapter: Adapter, sessions: InterruptedSession[]): number {
    let earliest = Number.POSITIVE_INFINITY;
    for (const session of sessions) {
      earliest = Math.min(earliest, this.heldBack(adapter, session)?.retryInMs ?? 0);
    }
    return Number.isFinite(earliest) ? earliest : IDLE_INTERVAL_MS;
  }

  private async probeNow(adapter: Adapter, waiting: InterruptedSession[]): Promise<Pass> {
    const { log } = this.deps;
    const intervalMs = this.deps.config.resume.probeIntervalSeconds * 1_000;
    const usable = await adapter.probe(waiting);
    if (usable) {
      log.info(`${adapter.kind}: quota recovered, ${waiting.length} session(s) can resume`);
      for (const session of waiting) {
        if (this.stopping) break;
        await this.maybeResume(adapter, session);
      }
      return answered(intervalMs);
    }
    log.debug(`${adapter.kind}: still blocked, probing again in ${formatDuration(intervalMs)}`);
    return answered(intervalMs);
  }

  /**
   * Why this interruption cannot be resumed at this moment, and how long that lasts —
   * `Infinity` for one finished with for good, so it can never pull a sweep earlier.
   */
  private heldBack(
    adapter: Adapter,
    session: InterruptedSession,
  ): { reason: string; retryInMs: number } | null {
    const { maxAttempts, minIntervalMinutes } = this.deps.config.resume;
    const record = this.deps.state.get(adapter.kind, session.sessionId);

    if (!record || record.turnKey !== turnKeyOf(session)) return null;

    const settled = settledReason(record, session, maxAttempts);
    if (settled) return { reason: settled, retryInMs: Number.POSITIVE_INFINITY };

    const cooldownMs = minIntervalMinutes * 60_000;
    const sinceMs = Date.now() - (Date.parse(record.lastAttemptAt ?? record.interruptedAt) || 0);
    if (record.attempts > 0 && sinceMs < cooldownMs) {
      const retryInMs = cooldownMs - sinceMs;
      return { reason: `cooldown (${formatDuration(retryInMs)} left)`, retryInMs };
    }
    return null;
  }

  private async maybeResume(adapter: Adapter, session: InterruptedSession): Promise<void> {
    const { log, state, config } = this.deps;
    const held = this.heldBack(adapter, session);
    if (held) {
      log.debug(`${adapter.kind}/${short(session.sessionId)}: skipping (${held.reason})`);
      return;
    }
    await resumeSession(adapter, session, config.resume.prompt, state, config, log);
  }
}

/**
 * Resume one interruption and record it: that record, written by this and by `tide resume`
 * before the attempt, is what stops a resume being repeated while its turn still runs.
 */
export async function resumeSession(
  adapter: Adapter,
  session: InterruptedSession,
  prompt: string,
  state: StateStore,
  config: Config,
  log: Logger,
): Promise<ResumeResult> {
  const existing = state.get(adapter.kind, session.sessionId);
  const turnKey = turnKeyOf(session);

  const carryOver = existing && existing.turnKey === turnKey ? existing : null;
  const record: SessionRecord = carryOver ?? {
    cli: adapter.kind,
    sessionId: session.sessionId,
    cwd: session.cwd,
    reason: "quota",
    detail: session.detail,
    interruptedAt: new Date(session.interruptedAt).toISOString(),
    turnKey,
    resumedAt: null,
    lastAttemptAt: null,
    attempts: 0,
    lastError: null,
    closed: false,
  };
  record.cwd = session.cwd || record.cwd;
  record.detail = session.detail;
  record.turnKey = turnKey;

  if (config.dryRun) {
    // Nothing is written: a record either marks the interruption handled or counts an attempt
    // against it, and a dry run must not change the thing it exists to predict.
    log.info(`${adapter.kind}/${short(session.sessionId)}: [dry-run] would resume in ${session.cwd}`);
    return { ok: true, delivered: false, via: "dry-run", detail: `would resume in ${session.cwd}` };
  }

  log.info(`${adapter.kind}/${short(session.sessionId)}: resuming in ${session.cwd}`);
  record.attempts += 1;
  // Stamped before the attempt, not after: an attempt that hangs until the timeout, or that
  // takes the CLI down with it, still has to push the next one out by the retry cooldown.
  record.lastAttemptAt = new Date().toISOString();
  if (adapter.kind === "codex") record.deliveryUnknown = true;
  state.upsert(record);
  state.save();
  let result: ResumeResult;
  try {
    result = await adapter.resume(session, prompt);
  } catch (err) {
    result = { ok: false, delivered: false, via: "none", detail: (err as Error).message,
      uncertain: adapter.kind === "codex" };
  }

  record.deliveryUnknown = result.uncertain ?? false;
  if (result.deferred) record.attempts -= 1;

  if (result.ok) {
    record.resumedAt = new Date().toISOString();
    record.lastError = null;
    record.closed = true;
    log.info(`${adapter.kind}/${short(session.sessionId)}: resumed via ${result.via}`);
  } else {
    record.lastError = result.detail;
    if (record.attempts >= config.resume.maxAttempts) record.closed = true;
    log.warn(
      `${adapter.kind}/${short(session.sessionId)}: resume failed via ${result.via} — ${result.detail}`,
    );
  }
  state.upsert(record);
  state.save();
  return result;
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
