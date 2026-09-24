import type { PluginContext, TidePlugin } from "../runtime.js";
import { errorMessage, type Snapshot } from "../../session/types.js";
import { inspectScreen, type ResumeScreen, type CliKind, type Interruption } from "./screen.js";

export const PROBE_INTERVAL_MS = 5 * 60 * 1000;
export const RESUME_DELAY_MS = 3 * 60 * 1000;
export interface Availability { allowed: boolean | null; reason: string }
export type Probe = (cwd: string, signal: AbortSignal, interruption: Interruption) => Promise<Availability>;

// A successful recovery probe is a literal pong reply (with optional trailing
// punctuation). The two bundled probe plugins share this contract.
export function isPongReply(text: string): boolean {
  return /^\s*pong[.!]?\s*$/i.test(text);
}

// Helper for callers; the monitor itself only deals in epoch ms.
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

interface Episode {
  interruption: Interruption;
  fingerprint: string;
  stableSince: number;
  nextProbeAt: number;
  attempted: boolean;
}

const fingerprint = (screen: Snapshot) => JSON.stringify([screen.text, screen.cols, screen.rows, screen.buffer]);
const sameInterruption = (a: Interruption | null, b: Interruption) => a?.kind === b.kind && a.message === b.message;

type Observation =
  | { kind: "inactive" }
  | { kind: "screen"; view: ResumeScreen; fingerprint: string };

type Decision =
  | { kind: "noop" }
  | { kind: "clear"; matched: boolean }
  | { kind: "wait"; remainingMs: number; phase: "cooldown" | "waiting" }
  | { kind: "probe" };

// decide() returns the change it would make without committing it, so status()
// (which calls only observe + decide) cannot mutate episode / abort probes.
type EpisodeUpdate =
  | { kind: "set"; episode: Episode; clearError: boolean }
  | { kind: "clear" };

export interface StatusReport {
  observation: { matched: boolean; ready: boolean; interruption: Interruption | null; fingerprint: string } | null;
  decision: Decision;
  monitor: {
    enabled: boolean;
    phase: string;
    interruption: Interruption | null;          // currently tracked (persists across screen blips during recovery)
    stableSince: number | null;
    nextProbeAt: number | null;
    lastProbe: Availability | null;
    lastError: string | null;
    lastResumeAt: number | null;
  };
}

export class ResumeMonitor {
  // Bundled plugins flip this off in start() so they ship unwatched by default
  // and require an explicit `watch` command before any recovery runs.
  private enabled = true;
  private disposed = false;
  private episode: Episode | null = null;
  private pending: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private lastProbe: Availability | null = null;
  private lastError: string | null = null;
  private lastResumeAt: number | null = null;
  private phase = "watching";

  constructor(private context: PluginContext, private kind: CliKind, private probe: Probe,
    private initialDelay: number, private now = Date.now, private quietMs = RESUME_DELAY_MS) {}

  // Layer 1: OBSERVE — pure read
  private async observe(): Promise<Observation> {
    if (this.disposed || !this.enabled) return { kind: "inactive" };
    const snapshot = await this.context.capture();
    if (this.disposed || !this.enabled) return { kind: "inactive" };
    const view = inspectScreen(this.kind, snapshot);
    return { kind: "screen", view, fingerprint: fingerprint(snapshot) };
  }

  // Layer 2: DECIDE — pure logic on Observation + episode state.
  // Decides what to do and what episode update would commit; never touches
  // this.episode, this.lastError or this.abort. act() commits the update.
  private decide(obs: Observation, force: boolean, now: number): { decision: Decision; update: EpisodeUpdate | null } {
    if (obs.kind === "inactive") return { decision: { kind: "noop" }, update: null };
    const { view, fingerprint: fp } = obs;
    let update: EpisodeUpdate | null = null;
    let episode: Episode | null = this.episode;

    if (!view.interruption) {
      // Recovery-in-flight: the prompt text overlays the error momentarily.
      // Keep the episode so attempt() can finish.
      if (this.episode?.attempted) return { decision: { kind: "noop" }, update: null };
      return { decision: { kind: "clear", matched: view.matched }, update: null };
    }

    if (!episode || !sameInterruption(view.interruption, episode.interruption)) {
      const delay = view.interruption.kind === "connection"
        ? this.quietMs
        : Math.max(this.initialDelay, this.quietMs);
      episode = { interruption: view.interruption, fingerprint: fp, stableSince: now, nextProbeAt: now + delay, attempted: false };
      update = { kind: "set", episode, clearError: true };
    } else if (episode.fingerprint !== fp) {
      episode = { ...episode, fingerprint: fp, stableSince: now, nextProbeAt: Math.max(episode.nextProbeAt, now + this.quietMs) };
      update = { kind: "set", episode, clearError: false };
    }

    if (episode.attempted || this.pending) return { decision: { kind: "noop" }, update };

    const cooldownRemaining = episode.stableSince + this.quietMs - now;
    if (cooldownRemaining > 0) return { decision: { kind: "wait", remainingMs: cooldownRemaining, phase: "cooldown" }, update };

    const throttleRemaining = episode.nextProbeAt - now;
    if (!force && throttleRemaining > 0) return { decision: { kind: "wait", remainingMs: throttleRemaining, phase: "waiting" }, update };

    return { decision: { kind: "probe" }, update };
  }

  // Layer 3: ACT — commit decide()'s update, then execute the decision.
  private async act(result: { decision: Decision; update: EpisodeUpdate | null }): Promise<void> {
    if (result.update) this.commit(result.update);
    switch (result.decision.kind) {
      case "noop":
        return;
      case "clear":
        this.episode = null;
        this.abort?.abort();
        this.phase = result.decision.matched ? "watching" : "inactive";
        return;
      case "wait":
        this.phase = result.decision.phase;
        this.schedule(result.decision.remainingMs);
        return;
      case "probe":
        await this.runProbe();
        // Probe finished without recovery — schedule next probe at nextProbeAt.
        if (this.episode && !this.episode.attempted) {
          this.schedule(Math.max(300, this.episode.nextProbeAt - this.now()));
        }
        return;
    }
  }

  private commit(update: EpisodeUpdate) {
    if (update.kind === "clear") { this.episode = null; this.abort?.abort(); return; }
    this.abort?.abort();
    this.episode = update.episode;
    if (update.clearError) this.lastError = null;
  }

  // Orchestration: TICK — one full iteration
  async tick(force: boolean): Promise<void> {
    const obs = await this.observe();
    const result = this.decide(obs, force, this.now());
    await this.act(result);
  }

  // User-facing read. observe + decide are both pure; this cannot mutate state.
  async status(): Promise<StatusReport> {
    const obs = await this.observe();
    const { decision } = this.decide(obs, false, this.now());
    return this.buildStatusReport(obs, decision);
  }

  private buildStatusReport(obs: Observation, decision: Decision): StatusReport {
    return {
      observation: obs.kind === "screen"
        ? { matched: obs.view.matched, ready: obs.view.ready, interruption: obs.view.interruption, fingerprint: obs.fingerprint }
        : null,
      decision,
      monitor: this.readMonitor(),
    };
  }

  private readMonitor(): StatusReport["monitor"] {
    const episode = this.episode;
    return {
      enabled: this.enabled,
      phase: this.phase,
      interruption: episode?.interruption ?? null,
      stableSince: episode?.stableSince ?? null,
      nextProbeAt: episode && !episode.attempted ? episode.nextProbeAt : null,
      lastProbe: this.lastProbe,
      lastError: this.lastError,
      lastResumeAt: this.lastResumeAt,
    };
  }

  // Lifecycle
  start() {
    this.unsubscribe = this.context.onOutput(() => {
      void this.tick(false).catch((error) => { this.lastError = errorMessage(error); });
    });
    this.schedule(0);
  }

  setEnabled(enabled: boolean): StatusReport["monitor"] {
    this.enabled = enabled;
    clearTimeout(this.timer);
    if (!enabled) {
      if (!this.episode?.attempted) this.cancelEpisode();
      else this.abort?.abort();
      this.phase = "disabled";
    } else {
      this.phase = "watching";
      this.schedule(0);
    }
    return this.readMonitor();
  }

  async dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.unsubscribe?.();
    this.abort?.abort();
    await this.pending;
  }

  private schedule(delay: number) {
    if (this.disposed || !this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick(false).catch((error) => { this.lastError = errorMessage(error); });
    }, delay);
    this.timer.unref();
  }

  private cancelEpisode() {
    this.episode = null;
    this.abort?.abort();
  }

  // Whether this episode is no longer the one the in-flight probe is working
  // on. Every site that awaits async work inside attempt() must recheck —
  // omitting a clause at a subset site is a bug, so they all share this.
  private isStale(episode: Episode, signal: AbortSignal): boolean {
    return this.disposed || !this.enabled || signal.aborted || this.episode !== episode;
  }

  private async runProbe(): Promise<void> {
    if (!this.episode || this.episode.attempted || this.pending) return;
    const episode = this.episode;
    const abort = new AbortController();
    this.abort = abort;
    this.phase = "probing";
    this.pending = this.attempt(episode, abort.signal);
    await this.pending;
    this.pending = null;
    this.abort = null;
  }

  private async attempt(episode: Episode, signal: AbortSignal): Promise<void> {
    try {
      const availability = await this.probe(this.context.session.cwd, signal, episode.interruption);
      if (this.isStale(episode, signal)) return;
      this.lastProbe = availability;
      this.lastError = null;
      episode.nextProbeAt = this.now() + PROBE_INTERVAL_MS;
      if (availability.allowed !== true) {
        this.phase = availability.allowed === false ? "limited" : "unknown";
        return;
      }
      const snapshot = await this.context.capture();
      const current = inspectScreen(this.kind, snapshot);
      if (this.isStale(episode, signal)) return;
      if (!sameInterruption(current.interruption, episode.interruption) || fingerprint(snapshot) !== episode.fingerprint) {
        this.cancelEpisode();
        this.phase = "watching";
        this.schedule(0);
        return;
      }
      // Commit before either write: a partial/uncertain delivery must never be retried.
      episode.attempted = true;
      this.phase = "sending";
      const prompt = episode.interruption.kind === "quota" ? "继续完成刚才因限额中断的任务。" : "继续完成刚才因连接中断的任务。";
      await this.context.send(prompt);
      // Allow the TUI to render the inserted text before pressing Enter.
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Intentional subset: a delivery in flight must never be cancelled by a
      // disable/episode swap — only host disposal or the probe signal can stop it.
      if (this.disposed || signal.aborted) throw Error("Recovery cancelled after text input; Enter was not sent");
      const filled = await this.context.capture();
      const marker = this.kind === "claude" ? /^[ \t]*[❯>][ \t]*/ : /^[ \t]*›[ \t]*/;
      const lines = filled.text.split("\n");
      const input = lines.findLast((line) => marker.test(line));
      if (!inspectScreen(this.kind, filled).matched || input?.replace(marker, "").trim() !== prompt) throw Error("Input changed before submit; Enter was not sent");
      await this.context.sendKey("Enter");
      this.lastResumeAt = this.now();
      this.phase = "resumed";
    } catch (error) {
      if (this.disposed || this.episode !== episode) return;
      if (signal.aborted && !episode.attempted) return;
      this.lastError = errorMessage(error);
      this.phase = episode.attempted ? "delivery-unknown" : "unknown";
      episode.nextProbeAt = this.now() + PROBE_INTERVAL_MS;
    }
  }
}

export function resumePlugin(id: string, name: string, kind: CliKind, probe: Probe): TidePlugin {
  let monitor: ResumeMonitor | undefined;
  // Commands run only in a session host: the CLI routes to the addressed session,
  // and this process owns that session's monitor.
  const run = (command: string, action: (value: ResumeMonitor) => unknown) => (args: string[]) => {
    if (args.length) throw Error(`tide ${id} ${command} takes no arguments`);
    if (!monitor) throw Error("Plugin has not started");
    return action(monitor);
  };
  return {
    id, name, detect: async (context) => inspectScreen(kind, await context.capture()).matched,
    start(context) {
      const quietSeconds = Number(process.env.TIDE_RESUME_DELAY_SECONDS ?? RESUME_DELAY_MS / 1000);
      if (!Number.isFinite(quietSeconds) || quietSeconds < 1 || quietSeconds > 3600) throw Error("TIDE_RESUME_DELAY_SECONDS must be 1..3600");
      const initialDelaySeconds = Number(process.env.TIDE_INITIAL_DELAY_SECONDS ?? PROBE_INTERVAL_MS / 1000);
      if (!Number.isFinite(initialDelaySeconds) || initialDelaySeconds < 1 || initialDelaySeconds > 3600) throw Error("TIDE_INITIAL_DELAY_SECONDS must be 1..3600");
      monitor = new ResumeMonitor(context, kind, probe, kind === "claude" ? initialDelaySeconds * 1000 : 0, Date.now, quietSeconds * 1000);
      monitor.start();
      // Default policy: the plugin is loaded (opt-in via plugins.json) but does
      // not watch the session until the user calls `watch <id>`. Flipping this
      // off clears any pending tick scheduled by start() and sets the phase.
      monitor.setEnabled(false);
      return () => monitor!.dispose();
    },
    commands: {
      status: {
        description: "Read-only: capture screen + decide + read monitor state. Returns observation {matched, ready, interruption, fingerprint}, decision {kind, remainingMs?, phase?}, monitor {enabled, phase, interruption, stableSince, nextProbeAt, lastProbe, lastError, lastResumeAt}. No probe, no send. Epoch ms fields can be formatted with the exported formatDuration helper.",
        all: true,
        run: run("status", (value) => value.status()),
      },
      watch: {
        description: "Start automatic recovery for this session. The monitor is off by default; call this after the foreground CLI is ready. Schedules an immediate observe. Returns monitor state.",
        run: run("watch", (value) => value.setEnabled(true)),
      },
      unwatch: {
        description: "Stop automatic recovery for this session; cancels any in-flight probe. The plugin stays loaded; `watch` resumes it. Returns monitor state.",
        run: run("unwatch", (value) => value.setEnabled(false)),
      },
    },
  };
}
