import { executionSnapshot, readTranscript } from "../transcript.js";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../config.js";
import { oneLine, runChildProcess, short } from "../../util.js";
import { claudeRecoveryArgs, launchWindow, posixQuote, resolveBash } from "../terminal.js";
import type { Adapter, QuotaInfo, LaunchReceipt, Session } from "../../core/session.js";
import { findClaudeSessions } from "./history.js";

// Native CLI operations only. launchSession supplies bootstrap input; it is not live send.

export function resolveClaudeBin(explicit?: string): string | null {
  const candidates: string[] = [];
  if (explicit) {
    candidates.push(explicit);
  }
  const fromEnv = process.env["CLAUDE_BIN"];
  if (fromEnv) {
    candidates.push(fromEnv);
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  const which = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["claude"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (which.status === 0) {
    for (const line of (which.stdout ?? "").split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate && existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** Claude Code marks the processes it starts so that they know they are nested. A TUI that
 * inherits the marker reports "transcript saving is off" and persists nothing; the session id
 * and the messaging socket name the session tide itself runs under. */
const PARENT_SESSION_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
];

/** What a delivered session runs under: tide's own environment (credentials, model, the Git
 * Bash path), minus the markers of whichever session started tide. */
export function deliveryEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of PARENT_SESSION_MARKERS) {
    delete env[name];
  }
  return env;
}

/** `agents --json` lists local processes; anything slower than this is not going to answer. */
const AGENTS_LIST_TIMEOUT_MS = 5_000;

interface ClaudeProbeResult {
  is_error?: boolean;
  result?: unknown;
  api_error_status?: unknown;
}

/** A 429 status is upstream's own verdict; the prose fallback covers envelopes that carry no status. */
function probeIsRateLimited(probe: ClaudeProbeResult): boolean {
  if (probe.api_error_status === 429) return true;
  const text = typeof probe.result === "string" ? probe.result : "";
  return /rate[ _-]?limit/i.test(text);
}

export class ClaudeAdapter implements Adapter {
  readonly kind = "claude" as const;

  constructor(
    private readonly bin: string,
    private readonly config: Config,
  ) {}

  history(session: Session, after?: string) { return readTranscript(this.kind, session, after); }

  snapshot(session: Session, limit: number) { return executionSnapshot(this.kind, session, limit); }

  private async processes(): Promise<Array<{ pid: number; sessionId: string; status: string }>> {
    const bash = resolveBash();
    if (!bash) throw new Error("No Git Bash found");
    const result = await runChildProcess(bash, ["-lc", `${posixQuote(this.bin.replaceAll("\\", "/"))} agents --json`], {
      timeoutMs: AGENTS_LIST_TIMEOUT_MS, env: deliveryEnv(),
    });
    if (result.code !== 0 || result.timedOut || result.spawnError) throw new Error("Cannot confirm Claude process ownership");
    const rows = JSON.parse(result.out);
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.sessionId !== "string" || !Number.isSafeInteger(r.pid))) throw new Error("Invalid Claude process list");
    return rows;
  }

  async sessionForProcess(pid: number): Promise<string | null> {
    return (await this.processes()).find((r) => r.pid === pid)?.sessionId ?? null;
  }

  async ownsIdleProcess(sessionId: string, pid: number): Promise<boolean> {
    const owners = (await this.processes()).filter((r) => r.sessionId === sessionId);
    return owners.length === 1 && owners[0]!.pid === pid && owners[0]!.status === "idle";
  }

  resolveBin(): string {
    return this.bin;
  }

  async readQuota(): Promise<QuotaInfo> {
    const bash = resolveBash();
    if (!bash) throw new Error("No Git Bash found for Claude quota probe");
    // --bare disables OAuth on current Claude versions; keep the user's normal auth environment.
    const args = ["-p", this.config.claude.probePrompt, "--no-session-persistence", "--output-format", "json"];
    const result = await runChildProcess(
      bash,
      ["-lc", [this.bin.replaceAll("\\", "/"), ...args].map(posixQuote).join(" ")],
      {
        cwd: process.cwd(),
        timeoutMs: this.config.claude.probeTimeoutSeconds * 1_000,
        env: { ...deliveryEnv(), CLAUDE_CODE_MAX_RETRIES: "0" },
      },
    );
    if (result.spawnError) {
      throw new Error(`probe could not be started: ${result.spawnError}`);
    }
    if (result.timedOut) {
      throw new Error(`probe timed out after ${this.config.claude.probeTimeoutSeconds}s`);
    }

    let parsed: ClaudeProbeResult;
    try {
      parsed = JSON.parse(result.out) as ClaudeProbeResult;
    } catch (err) {
      throw new Error(`probe stdout was not JSON: ${oneLine(result.out)}${(err as Error).message ? ` — ${(err as Error).message}` : ""}`);
    }

    if (parsed.is_error === false) {
      return {
        allowed: true,
        blockedReason: null,
        primary: null,
        secondary: null,
        nextResetAt: null,
        plan: null,
        notes: [`probe ok via ${this.bin}`],
      };
    }
    if (probeIsRateLimited(parsed)) {
      return {
        allowed: false,
        blockedReason: "rate_limit",
        primary: null,
        secondary: null,
        nextResetAt: null,
        plan: null,
        notes: ["probe hit rate_limit"],
      };
    }
    return {
      allowed: false,
      blockedReason: "unknown",
      primary: null,
      secondary: null,
      nextResetAt: null,
      plan: null,
      notes: [`probe errored: ${oneLine(typeof parsed.result === "string" ? parsed.result : result.err || result.out)}`],
    };
  }

  findSessions(): Promise<Session[]> { return findClaudeSessions(); }

  async launchSession(session: Session, prompt: string): Promise<LaunchReceipt> {
    if (!session.cwd || !existsSync(session.cwd)) {
      return { ok: false, requested: false, detail: `session cwd is not on disk: ${session.cwd || "(unset)"}` };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(session.sessionId) || session.isSubagent) {
      return { ok: false, requested: false, detail: "Only a main session with a valid ID can be resumed" };
    }
    const bash = resolveBash();
    if (!bash) return { ok: false, requested: false, detail: "No Git Bash found" };
    const holders = await runChildProcess(bash, ["-lc", `${posixQuote(this.bin.replaceAll("\\", "/"))} agents --json`], {
      timeoutMs: AGENTS_LIST_TIMEOUT_MS, env: deliveryEnv(),
    });
    const refusal = holderRefusal(holders, session.sessionId);
    if (refusal) return { ok: false, requested: false, deferred: true, detail: refusal };

    const deliveriesDir = join(this.config.stateDir, "deliveries");
    mkdirSync(deliveriesDir, { recursive: true });
    // Only the script path ever reaches a command line. The cwd and the prompt are read by the
    // window's shell, so POSIX quoting covers them on either platform.
    const scriptPath = join(deliveriesDir, `${session.sessionId}.${process.platform === "darwin" ? "command" : "sh"}`);
    const optionsPath = join(this.config.stateDir, "monitors", `claude-${session.sessionId}.options.json`);
    const originalArgs = existsSync(optionsPath) ? JSON.parse(readFileSync(optionsPath, "utf8")) : [];
    if (!Array.isArray(originalArgs) || originalArgs.some((a) => typeof a !== "string")) throw new Error("Invalid saved Claude launch options");
    const args = claudeRecoveryArgs(originalArgs, session.sessionId, prompt);
    writeFileSync(
      scriptPath,
      [
        "#!/bin/bash",
        `cd ${posixQuote(session.cwd)} || exit 1`,
        [this.bin.replaceAll("\\", "/"), ...args].map(posixQuote).join(" "),
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(scriptPath, 0o700);

    const launched = launchWindow({
      scriptPath,
      title: `tide ${short(session.sessionId)}`,
      logPath: join(deliveriesDir, `${session.sessionId}.log`),
      env: deliveryEnv(),
    });
    if (!launched.ok) {
      return { ok: false, requested: false, detail: launched.detail };
    }
    return {
      ok: true,
      requested: true,

      detail: `window requested via ${launched.detail}; not an acceptance or completion acknowledgement`,
    };
  }

}

export function holderRefusal(result: { spawnError: string | null; timedOut: boolean; code: number | null; out: string }, sessionId: string): string | null {
  const unknown = "Cannot confirm session ownership; no window opened. Inspect Claude Code before retrying.";
  if (result.spawnError || result.timedOut || result.code !== 0) return unknown;
  let entries: unknown;
  try { entries = JSON.parse(result.out); } catch { return unknown; }
  if (!Array.isArray(entries)) return unknown;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.sessionId !== "string") return unknown;
    if (entry.sessionId === sessionId) return "Session is held by Claude Code; use its visible window or close it before sending. Nothing was stopped.";
  }
  return null;
}
