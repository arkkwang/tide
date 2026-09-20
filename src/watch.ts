/** The watch loop, and the `Adapter` contract each supported CLI implements in its own file. */
import { MAX_SESSIONS_RETURNED, type CliKind, type Config } from "./config.js";
import { humanizeIdleDuration, localTimestamp, oneLine, short } from "./util.js";

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
  text: string;
}

export const SPOKEN_COUNT = 10;
export const SPOKEN_CHARS = 80;

/** What the session was doing when its transcript / rollout file ended. Orthogonal to whether
 * the session is a subagent fork — `parentThreadId` carries that, not `status`. */
export type SessionStatus =
  | "completed"
  | "running"
  | "awaiting-input"
  | "aborted"
  | "errored"
  | "quota-limited";

export interface Session {
  sessionId: string;
  cwd: string;
  /** Timestamp of the most recent assistant response, in unix ms. An assistant response is
   * anything the model itself produced — a text reply or a tool call — regardless of whether
   * the turn has finished. Adapters must populate this — typically by falling back to the
   * file's mtime when the transcript records no assistant response. */
  lastAssistantAt: number;
  model?: string | null;
  source?: string | null;
  /** True only when this session is a subagent fork of another session. The watcher skips
   * subagents when `skipSubagents` is on; `parentThreadId` carries the parent id separately
   * for code that needs to follow the link. Orthogonal to `status` — a subagent can be in any
   * of the `SessionStatus` values. */
  isSubagent: boolean;
  parentThreadId?: string | null;
  status: SessionStatus;
  /** Human prompts, newest first. `lastUserUtterance` reads index 0 as the latest. */
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

  /** Read quota state. Claude uses a real probe request that consumes quota. */
  readQuota(): Promise<QuotaInfo>;

  /** All sessions the adapter can see, newest first. Each carries a `status` describing what the
   * session was doing when its file ended. Adapters return everything they found within their
   * scan cutoff; callers (status, watcher) decide how many to keep and apply their own filtering
   * on top. */
  findSessions(): Promise<Session[]>;

  resume(session: Session, prompt: string): Promise<ResumeResult>;
}

/** Trim the sorted session list down to `cap` entries, reserving the first `maxMain` slots
 * for top-level (non-subagent) sessions. Subagent forks fill whatever room is left.
 * Inputs must already be sorted newest-first by `lastAssistantAt`.
 *
 * Main sessions are the only ones the watcher may resume — guaranteeing them a slice keeps a
 * burst of subagent forks from pushing parent quota-limited sessions out of the visible window. */
export function capWithMainReserve(
  sorted: Session[],
  cap: number,
  maxMain: number,
): Session[] {
  const mainBudget = Math.min(maxMain, cap);
  const mains = sorted.filter((s) => !s.isSubagent).slice(0, mainBudget);
  if (mains.length >= cap) {
    return mains;
  }
  const subs = sorted.filter((s) => s.isSubagent).slice(0, cap - mains.length);
  return [...mains, ...subs];
}

/** Narrow detected sessions to the operator's allow list by `startsWith`. */
function applyAllowList(
  adapter: Adapter,
  detected: Session[],
  config: Config,
): Session[] {
  if (config.sessionAll) {
    return [...detected];
  }
  const sessions: Session[] = [];
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

/** Whether any `sessionDenyList` prefix matches this session id. Unlike the allow list there
 * is no "ambiguous" case to report: a prefix matching several sessions just excludes them all,
 * which is what a blacklist is for. */
export function isDenied(session: Session, config: Config): boolean {
  return config.sessionDenyList.some((prefix) => session.sessionId.startsWith(prefix));
}

/** The most recent utterance that is not the resume prompt we sent. `spoken` is ordered
 * newest-first by `recentUtterances`, so index 0 is the latest human prompt. */
function lastUserUtterance(
  spoken: Utterance[] | undefined,
  resumePrompt: string,
): Utterance | null {
  if (!spoken) {
    return null;
  }
  for (const said of spoken) {
    if (said.text !== resumePrompt) {
      return said;
    }
  }
  return null;
}

/** One session as a multi-line block, shared by the watcher and the `status` command. */
export function printWaitingSession(session: Session, config: Config): void {
  const tags = [
    `[${session.status}]`,
    session.model ? `[${session.model}]` : null,
    session.source ? `[${session.source}]` : null,
    session.isSubagent ? `[subagent]` : null,
    isDenied(session, config) ? `[excluded]` : null,
  ].filter((s): s is string => s !== null);
  const tagStr = `  ${tags.join("  ")}`;
  console.info(`      ${short(session.sessionId)}  ${session.cwd}${tagStr}`);
  const last = lastUserUtterance(session.spoken, config.resume.prompt);
  if (last) console.info(`          last you said: ${JSON.stringify(last.text)}`);
  console.info(`          idle for: ${humanizeIdleDuration(Date.now() - session.lastAssistantAt)}`);
}

async function decideQuota(adapter: Adapter, config: Config): Promise<"proceed" | "blocked"> {
  if (config.skipQuotaCheck) {
    console.info(`  ${adapter.kind}: quota check skipped (--skip-quota-check)`);
    return "proceed";
  }
  let quota: QuotaInfo;
  try {
    quota = await adapter.readQuota();
  } catch (err) {
    console.info(
      `  ${adapter.kind}: quota check failed (${oneLine((err as Error).message)}) — skipping resume`,
    );
    return "blocked";
  }
  if (quota.allowed) return "proceed";
  const reason = quota.blockedReason ?? "unknown";
  const when = quota.nextResetAt ? `, next reset ${localTimestamp(new Date(quota.nextResetAt * 1_000))}` : "";
  console.info(`  ${adapter.kind}: quota blocked (${reason})${when} — skipping resume`);
  return "blocked";
}

async function resumeSession(
  adapter: Adapter,
  session: Session,
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
    const { config } = this.deps;
    console.info(
      `watcher started (dry-run=${config.dryRun}, sweep every ${config.watchPolicy.sweepIntervalMinutes}m)`,
    );
    while (!this.stopping) {
      await this.sweep();
      if (this.stopping) {
        break;
      }
      await this.sleep(this.deps.config.watchPolicy.sweepIntervalMinutes * 60_000);
    }
    console.info("watcher stopped");
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
    // Deny first, before the cap: an excluded session must not hold a slot in the visible
    // window, or a pile of blacklisted test sessions could push a waiting one out of it.
    const detected = await adapter.findSessions();
    const kept = detected.filter((s) => !isDenied(s, config));
    const all = capWithMainReserve(kept, MAX_SESSIONS_RETURNED, config.watchPolicy.maxMainSessions);
    const denied = detected.length - kept.length;
    const policy = config.watchPolicy;

    // Only `quota-limited` sessions are eligible for auto-resume.
    const resumable = all.filter((s) => s.status === "quota-limited");
    const nonResumable = all.length - resumable.length;

    const afterSubagent = policy.skipSubagents
      ? resumable.filter((s) => !s.isSubagent)
      : [...resumable];
    const subagentSkipped = resumable.length - afterSubagent.length;

    const quietCutoff = Date.now() - policy.idleMinutesBeforeResume * 60_000;
    const idle: Session[] = [];
    const notIdle: Session[] = [];
    for (const s of afterSubagent) {
      if (s.lastAssistantAt <= quietCutoff) idle.push(s);
      else notIdle.push(s);
    }

    const allowed = applyAllowList(adapter, idle, config);
    const allowFiltered = idle.length - allowed.length;

    const notes: string[] = [];
    if (all.length > 0) {
      notes.push(`${all.length} detected (${nonResumable} non-resumable)`);
    }
    if (subagentSkipped > 0) {
      notes.push(`${subagentSkipped} subagent skipped`);
    }
    if (notIdle.length > 0) {
      notes.push(`${notIdle.length} not idle for ${policy.idleMinutesBeforeResume} minute${policy.idleMinutesBeforeResume === 1 ? "" : "s"} yet`);
    }
    if (allowFiltered > 0) {
      notes.push(`${allowFiltered} not in --session allow list`);
    }
    if (denied > 0) {
      notes.push(`${denied} excluded by sessionDenyList`);
    }
    const note = notes.length > 0 ? ` (${notes.join(", ")})` : "";
    console.info(`  ${adapter.kind}: ${allowed.length} waiting${note}`);
    for (const session of [...allowed, ...notIdle]) {
      printWaitingSession(session, config);
    }
    if (allowed.length === 0) {
      console.info(`  ${adapter.kind}: no sessions eligible for resume`);
      return;
    }
    if ((await decideQuota(adapter, config)) === "blocked") {
      return;
    }
    console.info(`  ${adapter.kind}: quota ok — resuming ${allowed.length}${config.dryRun ? " (--dry-run)" : ""}`);
    for (const session of allowed) {
      if (this.stopping) {
        break;
      }
      await resumeSession(adapter, session, config);
    }
  }
}
