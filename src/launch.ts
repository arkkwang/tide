import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Config, type CliKind } from "./config.js";
import { askAppServer, CodexAdapter, resolveCodexBin } from "./codex.js";
import { ClaudeAdapter, deliveryEnv, resolveClaudeBin } from "./claude.js";
import { posixQuote, resolveBash } from "./window.js";
import { runChildProcess } from "./util.js";
import type { Adapter, Session } from "./watch.js";

const DISCOVERY_MS = 3000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

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

export function explicitCodexResume(args: string[]): string | null {
  if (args[0] !== "resume") return null;
  const id = args[1];
  if (!id || !UUID.test(id)) throw new Error("Watched Codex resume needs an explicit UUID: tide codex resume <id>. Use codex directly for the session picker.");
  return id;
}

export function stillQuotaLimited(before: Session, current: Session | undefined): boolean {
  return !!current && current.sessionId === before.sessionId && current.status === "quota-limited" && current.lastAssistantAt === before.lastAssistantAt;
}

// Preserve safety/model/environment options on recovery. Initial launch argv are always untouched.
// Positional initial prompts and session selection flags must not be replayed as a second task.
export function claudeRecoveryArgs(args: string[], id: string, prompt: string): string[] {
  const values = new Set(["--model", "--effort", "--permission-mode", "--settings", "--setting-sources", "--agent", "--system-prompt", "--append-system-prompt", "--fallback-model"]);
  const lists = new Set(["--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--tools", "--mcp-config", "--plugin-dir"]);
  const switches = new Set(["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--strict-mcp-config", "--disable-slash-commands", "--bare", "--safe-mode", "--restricted", "--chrome"]);
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    const name = arg.split("=", 1)[0]!;
    if (switches.has(name) || ((values.has(name) || lists.has(name)) && arg.includes("="))) kept.push(arg);
    else if (values.has(name) && args[i + 1] !== undefined) kept.push(arg, args[++i]!);
    else if (lists.has(name)) {
      kept.push(arg);
      while (args[i + 1] !== undefined && !args[i + 1]!.startsWith("-")) kept.push(args[++i]!);
    }
  }
  return [...kept, "--resume", id, "--", prompt];
}

/** Enter Git Bash once, then the inner Node supervisor owns the native CLI PID and inherited TTY. */
export async function launchThroughBash(cli: CliKind, args: string[]): Promise<number> {
  const bash = resolveBash();
  if (!bash) throw new Error("tide launch requires Git Bash; set CLAUDE_CODE_GIT_BASH_PATH");
  const node = process.execPath.replaceAll("\\", "/");
  const entry = resolve(process.argv[1]!).replaceAll("\\", "/");
  const child = spawn(bash, ["-lc", `exec ${posixQuote(node)} ${posixQuote(entry)} __foreground ${cli} "$@"`, "tide", ...args], {
    stdio: "inherit", env: deliveryEnv(), windowsHide: false,
  });
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try { return await exitCode(child); }
  finally { process.off("SIGINT", ignore); }
}

function exitCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 130));
  });
}

export async function foreground(cli: CliKind, originalArgs: string[]): Promise<number> {
  const config = Config.fromFile(false);
  const bin = cli === "codex" ? resolveCodexBin(config.codex.bin, true) : resolveClaudeBin(config.claude.bin);
  if (!bin) throw new Error(`${cli} executable not found`);
  if (passthroughOnly(cli, originalArgs)) return exitCode(spawn(bin, originalArgs, { stdio: "inherit", windowsHide: false }));
  if (cli === "codex" && originalArgs.some((a) => a === "--remote" || a.startsWith("--remote="))) throw new Error("Tide can only watch local Codex sessions; run codex directly for --remote");
  mkdirSync(join(config.stateDir, "launches"), { recursive: true });
  const logPath = join(config.stateDir, "launches", `${cli}-${randomUUID()}.log`);
  const log = (message: string) => appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  let sessionId: string | null = null;
  let args = [...originalArgs];
  if (cli === "codex") {
    sessionId = explicitCodexResume(args);
    if (!sessionId) {
      let cwd = process.cwd();
      for (let i = 0; i < args.length; i++) {
        if (["-C", "--cd"].includes(args[i]!)) cwd = resolve(args[++i]!);
        else if (args[i]!.startsWith("--cd=")) cwd = resolve(args[i]!.slice(5));
      }
      // Creating an empty native thread performs no model turn; resume gives the TUI that exact ID.
      const result = await askAppServer<{ thread: { id: string } }>(bin, "thread/start", { cwd }, true);
      sessionId = result.thread.id;
      args = ["resume", sessionId, ...args];
    }
  }
  const adapter: Adapter = cli === "codex" ? new CodexAdapter(bin, config.codex) : new ClaudeAdapter(bin, config);
  log(`binary ${bin}`);
  if (sessionId) log(`bound session ${sessionId}`);
  console.error(`[tide] Watching this CLI until it exits. Log: ${logPath}`);
  if (config.dryRun || config.skipQuotaCheck) console.error("[tide] dryRun / skipQuotaCheck in Tide config are ignored by the launch wrapper; real quota checks apply.");
  let stopping = false;
  let recovering = false;
  let child: ChildProcess;
  let result: Promise<number>;
  const start = (argv: string[]) => {
    child = spawn(bin, argv, { stdio: "inherit", windowsHide: false });
    result = exitCode(child);
    result.then(() => { if (!recovering) stopping = true; }, () => { stopping = true; });
  };
  start(args);
  const interrupt = () => {}; // The foreground CLI owns Ctrl-C and may use it to cancel only a turn.
  const terminate = () => { stopping = true; child.kill(); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let nextProbe = 0;
  let deliveredEvent: number | null = null;
  const monitor = async () => {
    while (!stopping) {
      try {
        if (cli === "claude") {
          const list = await runChildProcess(bin, ["agents", "--json"], { timeoutMs: 5000 });
          if (list.code === 0 && !list.timedOut) {
            const rows = JSON.parse(list.out);
            const row = Array.isArray(rows) ? rows.find((r) => r.pid === child.pid) : undefined;
            if (typeof row?.sessionId === "string" && sessionId !== row.sessionId) {
              sessionId = row.sessionId;
              deliveredEvent = null;
              log(`bound session ${sessionId}`);
            }
          }
        }
        const session = sessionId ? (await adapter.findSessions()).find((s) => s.sessionId === sessionId) : undefined;
        if (session && !session.isSubagent && session.status === "quota-limited" &&
            !config.sessionDenyList.some((id) => session.sessionId.startsWith(id)) &&
            session.lastAssistantAt !== deliveredEvent && Date.now() >= nextProbe &&
            session.lastAssistantAt <= Date.now() - config.watchPolicy.idleMinutesBeforeResume * 60_000) {
          nextProbe = Date.now() + Math.max(1000, config.watchPolicy.sweepIntervalMinutes * 60_000);
          log(`checking quota for ${sessionId}`);
          const quota = await adapter.readQuota();
          const current = (await adapter.findSessions()).find((s) => s.sessionId === sessionId);
          if (!stopping && quota.allowed && stillQuotaLimited(session, current)) {
            if (cli === "codex") {
              const sent = await adapter.resume(session, config.resume.prompt);
              log(`resume: ${JSON.stringify(sent)}`);
              // An uncertain delivery must never be retried against the same event.
              if (sent.ok || sent.uncertain) deliveredEvent = session.lastAssistantAt;
            } else {
              const holders = await runChildProcess(bin, ["agents", "--json"], { timeoutMs: 5000 });
              const rows = holders.code === 0 && !holders.timedOut ? JSON.parse(holders.out) : null;
              const owners = Array.isArray(rows) ? rows.filter((r) => r.sessionId === sessionId) : [];
              if (owners.length !== 1 || owners[0].pid !== child.pid || owners[0].status !== "idle") { log("ownership or idle state uncertain; no restart"); continue; }
              const latest = (await adapter.findSessions()).find((s) => s.sessionId === sessionId);
              if (!stillQuotaLimited(session, latest)) continue;
              if (stopping || child.exitCode !== null) continue;
              recovering = true;
              try {
                if (!child.kill()) { log("owned process could not be stopped; no restart"); continue; }
                await result;
                log(`restarting owned Claude session ${sessionId} in current terminal`);
                start(claudeRecoveryArgs(originalArgs, sessionId!, config.resume.prompt));
              } finally { recovering = false; }
              deliveredEvent = session.lastAssistantAt;
            }
          }
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
    log("watch stopped with foreground CLI");
  }
}
