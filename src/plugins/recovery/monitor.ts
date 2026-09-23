import type { PluginContext, TidePlugin } from "../runtime.js";
import { errorMessage, type Snapshot } from "../../session/types.js";
import { inspectScreen, type CliKind, type Interruption } from "./screen.js";

export const PROBE_INTERVAL_MS = 5 * 60 * 1000;
export const RESUME_DELAY_MS = 3 * 60 * 1000;
export interface Availability { allowed: boolean | null; reason: string }
export type Probe = (cwd: string, signal: AbortSignal, interruption: Interruption) => Promise<Availability>;

interface Episode {
  interruption: Interruption;
  screen: string;
  stableSince: number;
  nextProbeAt: number;
  attempted: boolean;
}
const fingerprint = (screen: Snapshot) => JSON.stringify([screen.text, screen.cols, screen.rows, screen.buffer]);
const sameInterruption = (a: Interruption | null, b: Interruption) => a?.kind === b.kind && a.message === b.message;

export class ResumeMonitor {
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

  status() {
    return { id: this.context.session.id, enabled: this.enabled, phase: this.phase,
      interruption: this.episode?.interruption ?? null, stableSince: this.episode?.stableSince ?? null,
      resumeAfter: this.episode ? this.episode.stableSince + this.quietMs : null,
      nextProbeAt: this.episode && !this.episode.attempted ? this.episode.nextProbeAt : null,
      lastProbe: this.lastProbe, lastError: this.lastError, lastResumeAt: this.lastResumeAt };
  }
  start() {
    this.unsubscribe = this.context.onOutput(() => { void this.observe().catch((error) => { this.lastError = errorMessage(error); }); });
    this.schedule(0);
  }
  check() { void this.observe(true).catch((error) => { this.lastError = errorMessage(error); }); }
  private schedule(delay: number) {
    if (this.disposed || !this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.observe().catch((error) => { this.lastError = errorMessage(error); }); }, delay);
    this.timer.unref();
  }
  private cancelEpisode() { this.episode = null; this.abort?.abort(); }
  async observe(force = false) {
    if (this.disposed || !this.enabled || this.phase === "sending") return;
    const snapshot = await this.context.capture();
    const view = inspectScreen(this.kind, snapshot);
    if (this.disposed || !this.enabled) return;
    if (!view.interruption) {
      this.cancelEpisode(); this.phase = view.matched ? "watching" : "inactive"; return;
    }
    if (!this.episode || !sameInterruption(view.interruption, this.episode.interruption)) {
      this.cancelEpisode();
      const delay = view.interruption.kind === "connection" ? this.quietMs : Math.max(this.initialDelay, this.quietMs);
      this.episode = { interruption: view.interruption, screen: fingerprint(snapshot), stableSince: this.now(), nextProbeAt: this.now() + delay, attempted: false };
      this.lastError = null;
    }
    if (this.episode.attempted) return;
    if (this.episode.screen !== fingerprint(snapshot)) {
      this.abort?.abort();
      this.episode.screen = fingerprint(snapshot); this.episode.stableSince = this.now();
      this.episode.nextProbeAt = Math.max(this.episode.nextProbeAt, this.now() + this.quietMs);
    }
    const remaining = this.episode.stableSince + this.quietMs - this.now();
    if (remaining > 0) { this.phase = "cooldown"; this.schedule(remaining); return; }
    this.phase = this.pending ? "probing" : "waiting";
    if (this.pending) return;
    if (!force && this.now() < this.episode.nextProbeAt) { this.schedule(this.episode.nextProbeAt - this.now()); return; }
    const episode = this.episode;
    const abort = new AbortController(); this.abort = abort;
    this.phase = "probing";
    this.pending = this.attempt(episode, abort.signal).finally(() => {
      this.pending = null; this.abort = null;
      if (this.episode && !this.episode.attempted) this.schedule(Math.max(300, this.episode.nextProbeAt - this.now()));
    });
    await this.pending;
  }
  private async attempt(episode: Episode, signal: AbortSignal) {
    try {
      const availability = await this.probe(this.context.session.cwd, signal, episode.interruption);
      if (this.disposed || !this.enabled || signal.aborted || this.episode !== episode) return;
      this.lastProbe = availability; this.lastError = null;
      episode.nextProbeAt = this.now() + PROBE_INTERVAL_MS;
      if (availability.allowed !== true) { this.phase = availability.allowed === false ? "limited" : "unknown"; return; }
      const snapshot = await this.context.capture();
      const current = inspectScreen(this.kind, snapshot);
      if (this.disposed || !this.enabled || signal.aborted || this.episode !== episode) return;
      if (!sameInterruption(current.interruption, episode.interruption) || fingerprint(snapshot) !== episode.screen) {
        this.cancelEpisode(); this.phase = "watching"; this.schedule(0); return;
      }
      // Commit before either write: a partial/uncertain delivery must never be retried.
      episode.attempted = true; this.phase = "sending";
      const prompt = episode.interruption.kind === "quota" ? "继续完成刚才因限额中断的任务。" : "继续完成刚才因连接中断的任务。";
      await this.context.send(prompt);
      // Allow the TUI to render the inserted text before pressing Enter.
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (this.disposed || !this.enabled || signal.aborted) throw Error("Recovery cancelled after text input; Enter was not sent");
      const filled: Snapshot = await this.context.capture();
      const marker = this.kind === "claude" ? /^[ \t]*[❯>][ \t]*/ : /^[ \t]*›[ \t]*/;
      const lines = filled.text.split("\n");
      const input = lines.findLast((line) => marker.test(line));
      if (!inspectScreen(this.kind, filled).matched || input?.replace(marker, "").trim() !== prompt) throw Error("Input changed before submit; Enter was not sent");
      await this.context.sendKey("Enter");
      this.lastResumeAt = this.now(); this.phase = "resumed";
    } catch (error) {
      if (this.disposed || this.episode !== episode) return;
      if (signal.aborted && !episode.attempted) return;
      this.lastError = errorMessage(error);
      this.phase = episode.attempted ? "delivery-unknown" : "unknown";
      episode.nextProbeAt = this.now() + PROBE_INTERVAL_MS;
    }
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled; clearTimeout(this.timer);
    if (!enabled) {
      if (!this.episode?.attempted) this.cancelEpisode(); else this.abort?.abort();
      this.phase = "disabled";
    }
    else { this.phase = "watching"; this.schedule(0); }
    return this.status();
  }
  async dispose() {
    this.disposed = true; clearTimeout(this.timer); this.unsubscribe?.(); this.abort?.abort(); await this.pending;
  }
}

export function resumePlugin(id: string, kind: CliKind, probe: Probe): TidePlugin {
  let monitor: ResumeMonitor | undefined;
  const run = (action: (value: ResumeMonitor) => unknown) => (_context: PluginContext, args: string[]) => {
    if (args.length) throw Error("This command takes no arguments");
    if (!monitor) throw Error("Plugin has not started");
    return action(monitor);
  };
  return {
    id, detect: async (context) => inspectScreen(kind, await context.capture()).matched,
    start(context) {
      const seconds = Number(process.env.TIDE_RESUME_DELAY_SECONDS ?? RESUME_DELAY_MS / 1000);
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) throw Error("TIDE_RESUME_DELAY_SECONDS must be 1..3600");
      monitor = new ResumeMonitor(context, kind, probe, kind === "claude" ? PROBE_INTERVAL_MS : 0, Date.now, seconds * 1000);
      monitor.start(); return () => monitor!.dispose();
    },
    commands: {
      status: { description: "Usage: status (no args). Read-only: phase, interruption {kind: quota|connection, message}, stableSince, resumeAfter, nextProbeAt (epoch ms), lastProbe, lastError, lastResumeAt. No network call.", run: run((value) => value.status()) },
      check: { description: "Usage: check (no args). Queue a recovery check for the latest interruption; never bypasses the stable-screen cooldown (default 180 seconds). May send continuation. Claude and Codex connection probes use model tokens; Codex quota errors use App Server. Returns current status; poll status for completion.", run: run((value) => { value.check(); return value.status(); }) },
      disable: { description: "Usage: disable (no args). Stop automatic probes/recovery in this session and cancel an in-flight probe; returns status.", run: run((value) => value.setEnabled(false)) },
      enable: { description: "Usage: enable (no args). Enable monitoring of new/current quota interruptions; returns status. Does not force input.", run: run((value) => value.setEnabled(true)) },
    },
  };
}
