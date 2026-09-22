import { Sessions } from "../core/sessions.js";
/** Session discovery and selection; recovery decisions live in recovery.ts. */
import { MAX_SESSIONS_RETURNED, type Config } from "../config.js";
import { humanizeIdleDuration, localTimestamp, short } from "../util.js";

import type { Session, Utterance } from "../core/session.js";
import { Recovery } from "./recovery.js";
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
  adapter: Sessions,
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
    `[${session.lastEvent}]`,
    session.model ? `[${session.model}]` : null,
    session.source ? `[${session.source}]` : null,
    session.isSubagent ? `[subagent]` : null,
    isDenied(session, config) ? `[excluded]` : null,
  ].filter((s): s is string => s !== null);
  const tagStr = `  ${tags.join("  ")}`;
  console.info(`      ${short(session.sessionId)}  ${session.cwd}${tagStr}`);
  const last = lastUserUtterance(session.spoken, config.resume.prompt);
  if (last) console.info(`          last you said: ${JSON.stringify(last.text)}`);
  console.info(`          last assistant output: ${humanizeIdleDuration(Date.now() - session.lastAssistantAt)} ago`);
}

export interface WatcherDeps {
  config: Config;
  adapters: Sessions[];
  recovery?: Recovery;
  shouldStop?: () => boolean;
}

export class Watcher {
  private readonly abort = new AbortController();
  private readonly recovery: Recovery;

  constructor(private readonly deps: WatcherDeps) {
    this.recovery = deps.recovery ?? new Recovery(deps.config);
  }

  stop(): void { this.abort.abort(); }
  private get stopping() { return this.abort.signal.aborted || !!this.deps.shouldStop?.(); }

  async run(): Promise<void> {
    const timer = setInterval(() => { if (this.deps.shouldStop?.()) this.stop(); }, 250);
    try {
      await Promise.all(this.deps.adapters.map(async (adapter) => {
        const interval = Math.max(1000, this.deps.config.watchPolicy.sweepIntervalMinutes * 60_000);
        for await (const sessions of adapter.monitor(interval, this.abort.signal)) {
          if (this.stopping) break;
          console.info(`sweep @${localTimestamp()}`);
          await this.tryAdapter(adapter, sessions);
        }
      }));
    } finally {
      this.stop();
      clearInterval(timer);
    }
  }

  private async tryAdapter(adapter: Sessions, detected: Session[]): Promise<void> {
    const { config } = this.deps;
    // Deny first, before the cap: an excluded session must not hold a slot in the visible
    // window, or a pile of blacklisted test sessions could push a waiting one out of it.
    const kept = detected.filter((s) => !isDenied(s, config));
    const all = capWithMainReserve(kept, MAX_SESSIONS_RETURNED, config.watchPolicy.maxMainSessions);
    const denied = detected.length - kept.length;
    const policy = config.watchPolicy;

    // Only `quota-limited` sessions are eligible for auto-resume.
    const resumable = all.filter((s) => s.lastEvent === "quota-limited");
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
    for (const session of allowed) {
      if (this.stopping) break;
      const detail = await this.recovery.attempt(adapter, session, () => this.stopping || !!this.deps.shouldStop?.());
      console.info('    ' + adapter.kind + '/' + short(session.sessionId) + ': ' + detail);
    }
  }
}
