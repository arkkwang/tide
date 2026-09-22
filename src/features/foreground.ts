import { Recovery, sameInterruption } from "../features/recovery.js";
import { ensureMonitor, monitorEnabled } from "../features/monitor.js";
import { Execution } from "../core/process.js";
import { Sessions } from "../core/sessions.js";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Config, type CliKind } from "../config.js";
import { CodexAdapter, resolveCodexBin } from "../providers/codex.js";
import { ClaudeAdapter, deliveryEnv, resolveClaudeBin } from "../providers/claude.js";
import { claudeRecoveryArgs, posixQuote, resolveBash } from "../providers/terminal.js";
import type { Session } from "../core/session.js";

const DISCOVERY_MS = 3000;

/** The first boundary consumes only Tide's provider selector. All following argv remain CLI-owned. */
export function wrapperInvocation(argv: string[]): { cli: CliKind; args: string[] } | null {
  const cli = argv[0];
  return cli === "codex" || cli === "claude" ? { cli, args: argv.slice(1) } : null;
}

export function passthroughOnly(cli: CliKind, args: string[]): boolean {
  if (args.some((a) => ["--help", "-h", "--version", "-v", "-V"].includes(a))) return true;
  const commands = cli === "codex"
    ? ["exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server", "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug", "apply", "queue", "agents", "archive", "delete", "migrate-rollouts", "unarchive", "cloud", "exec-server", "features", "help", "fork"]
    : ["agents", "attach", "auth", "doctor", "install", "logs", "mcp", "plugin", "plugins", "project", "rm", "respawn", "stop", "kill", "setup-token", "update", "upgrade", "ultrareview", "cloud", "gateway", "import"];
  return commands.includes(args[0] ?? "") || (cli === "claude" && args.some((a) => ["-p", "--print", "--bg", "--background"].includes(a)));
}

export function stillQuotaLimited(before: Session, current: Session | undefined): boolean {
  return sameInterruption(before, current);
}

/** Enter Git Bash once, then the inner Node supervisor owns the native CLI PID and inherited TTY. */
export async function launchThroughBash(cli: CliKind, args: string[]): Promise<number> {
  const bash = resolveBash();
  if (!bash) throw new Error("tide launch requires Git Bash; set CLAUDE_CODE_GIT_BASH_PATH");
  const node = process.execPath.replaceAll("\\", "/");
  const entry = resolve(process.argv[1]!).replaceAll("\\", "/");
  const child = Execution.launch(bash, ["-lc", `exec ${posixQuote(node)} ${posixQuote(entry)} __foreground ${cli} "$@"`, "tide", ...args], {
    stdio: "inherit", env: deliveryEnv(), windowsHide: false,
  });
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try { return await child.exited; }
  finally { process.off("SIGINT", ignore); }
}

export async function foreground(cli: CliKind, originalArgs: string[]): Promise<number> {
  const config = Config.fromFile(false);
  const bin = cli === "codex" ? resolveCodexBin(config.codex.bin, true) : resolveClaudeBin(config.claude.bin);
  if (!bin) throw new Error(`${cli} executable not found`);
  if (passthroughOnly(cli, originalArgs)) return Execution.launch(bin, originalArgs).exited;
  mkdirSync(join(config.stateDir, "launches"), { recursive: true });
  const logPath = join(config.stateDir, "launches", `${cli}-${randomUUID()}.log`);
  const log = (message: string) => appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  const adapter = new Sessions(cli === "codex" ? new CodexAdapter(bin, config.codex) : new ClaudeAdapter(bin, config));
  const prepared = await adapter.prepareLaunch(originalArgs);
  let sessionId = prepared.sessionId;
  log(`binary ${bin}`);
  if (sessionId) {
    await ensureMonitor(config, cli, sessionId, process.pid, originalArgs);
    log(`bound session ${sessionId}`);
  }
  console.error(`[tide] Monitoring will continue after this terminal exits. Log: ${logPath}`);
  if (config.dryRun || config.skipQuotaCheck) console.error("[tide] dryRun / skipQuotaCheck in Tide config are ignored by the launch wrapper; real quota checks apply.");
  let stopping = false;
  let recovering = false;
  let child: Execution;
  let result: Promise<number>;
  const start = (argv: string[]) => {
    child = Execution.launch(bin, argv);
    result = child.exited;
    result.then(() => { if (!recovering) stopping = true; }, () => { stopping = true; });
  };
  start(prepared.args);
  const interrupt = () => {}; // The foreground CLI owns Ctrl-C and may use it to cancel only a turn.
  const terminate = () => { stopping = true; void child.stop().catch((error) => log(String(error))); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const recovery = new Recovery(config.withOverrides({ dryRun: false, skipQuotaCheck: false }));
  const monitor = async () => {
    while (!stopping) {
      try {
        if (child.pid !== undefined) {
          const bound = await adapter.sessionForProcess(child.pid);
          if (bound && bound !== sessionId) {
            await ensureMonitor(config, cli, bound, process.pid, originalArgs);
            sessionId = bound;
            log(`bound session ${sessionId}`);
          }
        }
        const session = sessionId ? (await adapter.list()).find((s) => s.sessionId === sessionId) : undefined;
        if (session && monitorEnabled(config, cli, session.sessionId)) {
          const detail = await recovery.attempt(adapter, session, () => stopping || !monitorEnabled(config, cli, session.sessionId), async () => {
            if (adapter.canSend) return adapter.send(session, config.resume.prompt);
            const refuse = (detail: string) => ({ ok: false, delivered: false, deferred: true, via: "foreground", detail });
            if (child.pid === undefined || !await adapter.ownsIdleProcess(session.sessionId, child.pid)) return refuse("Ownership or idle state uncertain; no restart");
            const latest = (await adapter.list()).find((s) => s.sessionId === sessionId);
            if (!stillQuotaLimited(session, latest) || stopping || !monitorEnabled(config, cli, session.sessionId) || !child.running) return refuse("Session changed; no restart");
            recovering = true;
            try {
              if (!await child.stop()) return refuse("Owned process could not be stopped; no restart");
              await result;
              start(claudeRecoveryArgs(originalArgs, sessionId!, config.resume.prompt));
              return { ok: true, delivered: false, launchRequested: true, via: "foreground", detail: "Original Claude session restart requested in current terminal" };
            } finally { recovering = false; }
          });
          if (session.lastEvent === "quota-limited") log(detail);
        }
      } catch (error) { log(`watch: ${(error as Error).message}`); }
      if (!stopping) await new Promise<void>((r) => {
        const timer = setTimeout(r, sessionId ? Math.max(1000, config.watchPolicy.sweepIntervalMinutes * 60_000) : DISCOVERY_MS);
        // Exit wakes the monitor even if the next quota sweep is minutes away.
        result.then(() => { clearTimeout(timer); r(); }, () => { clearTimeout(timer); r(); });
      });
    }
  };
  try {
    await monitor();
    return await result!;
  } finally {
    stopping = true;
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    log("foreground CLI exited; detached monitor retains this session");
  }
}
