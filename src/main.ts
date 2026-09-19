import { ClaudeAdapter, claudeConfigDir, resolveClaudeBin, resolveEndpoint } from "./claude.js";
import { CodexAdapter, resolveCodexBin } from "./codex.js";
import { isStoreShim, oneLine } from "./child.js";
import {
  Watcher,
  formatDuration,
  resumeSession,
  short,
  waitingSessions,
  type Adapter,
  type InterruptedSession,
  type QuotaInfo,
} from "./watch.js";
import {
  BoundaryError,
  StateStore,
  createLogger,
  ensureStateDir,
  loadConfig,
  silentLogger,
  unixMs,
  type Config,
  type FilterPolicy,
  type Logger,
} from "./store.js";

const USAGE = `tide — resume Codex / Claude Code sessions after a quota limit resets

Usage:
  tide status [--cli <kind>] [--json]                Account state, and what is waiting to resume
  tide resume <session-id> [--cli <kind>] [--json]   Send one turn to one session, right now
  tide watch [--once]                                Watch and resume until you stop it (Ctrl-C)
  tide doctor                                        Check that this machine can run it

Options:
  --cli <kind>      Only this CLI: codex or claude
  --prompt <text>   What resume sends (default: the configured resume prompt)
  --once            For watch: one pass instead of a loop
  --dry-run         Say what would happen without resuming anything
  --config <path>   Use a specific config file
  --debug           Verbose logging
  --json            Machine-readable output (status, resume)
  -h, --help        Show this help
`;

const RESUMED_SHOWN = 10;

interface Flags {
  command: string;
  /** Bare arguments, in order. `resume` takes a session id here. */
  positional: string[];
  cli?: string;
  prompt?: string;
  configPath?: string;
  dryRun: boolean;
  debug: boolean;
  once: boolean;
  json: boolean;
  /** Ready-to-print complaints: options we do not know, and ones left without their value. */
  bad: string[];
}

function parseArgs(argv: string[]): Flags {
  const first = argv[0];
  const flags: Flags = {
    command: first === "--help" || first === "-h" ? "help" : (first ?? "help"),
    positional: [],
    bad: [],
    dryRun: false,
    debug: false,
    once: false,
    json: false,
  };
  const takesValue = ["--config", "--cli", "--prompt"];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      flags.command = "help";
      continue;
    }
    if (takesValue.includes(arg)) {
      const value = argv[++i];
      // `undefined`, not falsy: `--cli ""` did supply a value, and it is a wrong one.
      if (value === undefined) {
        flags.bad.push(`${arg} needs a value`);
        continue;
      }
      if (arg === "--config") flags.configPath = value;
      else if (arg === "--cli") flags.cli = value;
      else flags.prompt = value;
    } else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--debug") flags.debug = true;
    else if (arg === "--once") flags.once = true;
    else if (arg === "--json") flags.json = true;
    // Recorded rather than thrown, so `--help` still answers over a typo.
    else if (arg.startsWith("-")) flags.bad.push(`unknown option: ${arg}`);
    else flags.positional.push(arg);
  }
  return flags;
}

/** Build the adapters to work with, optionally narrowed to the one `--cli` names. */
function buildAdapters(
  config: Config,
  log: Logger,
  cli?: string,
): { adapters: Adapter[]; problems: string[] } {
  const adapters: Adapter[] = [];
  const problems: string[] = [];

  if (cli !== undefined && cli !== "codex" && cli !== "claude") {
    return { adapters, problems: [`unknown --cli "${cli}" — this build watches codex and claude`] };
  }

  if ((cli === undefined || cli === "codex") && config.codex.enabled) {
    const bin = resolveCodexBin(config.codex.bin);
    if (bin) adapters.push(new CodexAdapter(bin, log.debug, config.filter, config.codex));
    else problems.push("codex: could not locate the CLI (set codex.bin or CODEX_BIN)");
  }
  if ((cli === undefined || cli === "claude") && config.claude.enabled) {
    const bin = resolveClaudeBin(config.claude.bin);
    if (bin) {
      adapters.push(
        new ClaudeAdapter(bin, log.debug, config.filter, config.claude, config.resume),
      );
    } else problems.push("claude: could not locate the CLI (set claude.bin or CLAUDE_BIN)");
  }
  // Never silent: an empty adapter list with no explanation is the one failure a user
  // cannot act on.
  if (adapters.length === 0 && problems.length === 0) {
    problems.push(
      cli !== undefined ? `${cli}: not enabled in config` : "no CLI is enabled — check the config",
    );
  }
  return { adapters, problems };
}

function applyFlags(config: Config, flags: Flags): Config {
  return {
    ...config,
    dryRun: flags.dryRun || config.dryRun,
    debug: flags.debug || config.debug,
    resume: { ...config.resume, prompt: flags.prompt ?? config.resume.prompt },
  };
}

/**
 * One adapter's answer, gathered before it is rendered either way.
 *
 * `usable: null` is not "blocked" — it is "could not be read", which is a different answer
 * and has to stay one.
 */
interface StatusReport {
  cli: string;
  /** Null when the adapter has no binary to name — reported as null, not as the word. */
  binary: string | null;
  usable: boolean | null;
  unreadable: string | null;
  quota: QuotaInfo | null;
  waiting: InterruptedSession[];
}

async function commandStatus(
  config: Config,
  configPath: string | null,
  cli: string | undefined,
  json: boolean,
): Promise<number> {
  const { adapters, problems } = buildAdapters(config, silentLogger, cli);
  for (const problem of problems) console.error(`  ! ${problem}`);
  if (adapters.length === 0) return 2;

  const state = new StateStore(config.stateDir);
  const reports: StatusReport[] = [];

  for (const adapter of adapters) {
    const report: StatusReport = {
      cli: adapter.kind,
      binary: adapter.resolveBin(),
      usable: null,
      unreadable: null,
      quota: null,
      // The call the watcher itself makes, so the two listings cannot disagree.
      waiting: await waitingSessions(adapter, state, config),
    };
    try {
      report.quota = await adapter.readQuota();
      report.usable = report.quota.allowed;
    } catch (err) {
      report.unreadable = (err as Error).message;
    }
    reports.push(report);
    adapter.close?.();
  }

  const resumed = state.all().filter((r) => r.resumedAt);

  if (json) {
    console.log(
      JSON.stringify(
        {
          clis: reports.map((r) => ({
            cli: r.cli,
            binary: r.binary,
            usable: r.usable,
            unreadable: r.unreadable,
            blockedReason: r.quota?.blockedReason ?? null,
            plan: r.quota?.plan ?? null,
            primary: r.quota?.primary ?? null,
            secondary: r.quota?.secondary ?? null,
            nextResetAt: r.quota?.nextResetAt ?? null,
            notes: r.quota?.notes ?? [],
            waiting: r.waiting,
          })),
          resumed: resumed.slice(-RESUMED_SHOWN),
          needsAttention: state.all().filter((r) => r.deliveryUnknown),
          // The rules that produced the list above.
          policy: {
            source: configPath,
            filter: config.filter,
            resume: config.resume,
            codex: config.codex,
            claude: config.claude,
          },
        },
        null,
        2,
      ),
    );
    return 0;
  }

  for (const report of reports) {
    const { quota } = report;
    console.log(`\n=== ${report.cli} ===`);
    console.log(`  binary: ${report.binary ?? "(not found)"}`);

    if (quota) {
      const allowed = quota.allowed ? "yes" : "NO";
      console.log(`  usable now:  ${allowed}`);
      if (quota.blockedReason) console.log(`  blocked by:  ${quota.blockedReason}`);
      if (quota.plan) console.log(`  plan:        ${quota.plan}`);
      if (quota.primary) {
        console.log(
          `  5h window:   ${quota.primary.usedPercent}%` +
            (quota.primary.resetsAt ? `  resets ${new Date(unixMs(quota.primary.resetsAt)).toISOString()}` : ""),
        );
      }
      if (quota.secondary) {
        console.log(
          `  7d window:   ${quota.secondary.usedPercent}%` +
            (quota.secondary.resetsAt
              ? `  resets ${new Date(unixMs(quota.secondary.resetsAt)).toISOString()}`
              : ""),
        );
      }
      if (quota.nextResetAt) {
        const untilMs = unixMs(quota.nextResetAt) - Date.now();
        console.log(
          `  next reset:  ${new Date(unixMs(quota.nextResetAt)).toISOString()} (in ${formatDuration(untilMs)})`,
        );
      }
      for (const note of quota.notes) console.log(`  note:        ${note}`);
    } else {
      console.log(`  usable now:  unknown (${report.unreadable})`);
    }

    console.log(
      `  waiting:     ${report.waiting.length} interrupted session(s) matching the policy` +
        ` (idle ${config.filter.minIdleMinutes}m, ${maxAgeLabel(config.filter)})`,
    );
    for (const session of report.waiting) {
      // The model is the account this session belongs to, not just which cwd is waiting.
      const account = session.model ? `  [${session.model}]` : "";
      console.log(`      ${short(session.sessionId)}  ${session.cwd}${account}`);
      console.log(`          ${oneLine(session.detail)}`);
      // Quoted, so an utterance that begins or ends in punctuation stays legible as one.
      for (const said of session.spoken ?? []) {
        console.log(`          said: ${JSON.stringify(said.text)}`);
      }
    }
  }

  if (resumed.length > 0) {
    console.log(`\n=== resume history (${resumed.length}) ===`);
    for (const record of resumed.slice(-RESUMED_SHOWN)) {
      console.log(
        `  ${record.resumedAt}  ${record.cli}/${short(record.sessionId)}  via ${record.cwd}`,
      );
    }
  }

  for (const record of state.all().filter((r) => r.deliveryUnknown)) {
    console.log(`\n  ! ${record.cli}/${record.sessionId}: delivery outcome unknown; inspect the task before manually retrying`);
  }

  console.log(`\n=== policy (${configPath ?? "built-in defaults, no config file"}) ===`);
  console.log(
    `  resume:  ${JSON.stringify(config.resume.prompt)} x${config.resume.maxAttempts},` +
      ` no sooner than ${config.resume.minIntervalMinutes}m apart; Codex delivery timeout ${config.codex.deliveryTimeoutSeconds}s`,
  );
  console.log(`  probe:   every ${config.resume.probeIntervalSeconds}s, for providers that give no reset time`);
  console.log(
    `  codex:   ${config.codex.enabled ? "enabled" : "disabled"}` +
      `, claude: ${config.claude.enabled ? "enabled" : "disabled"} (autonomy ${config.claude.autonomy})`,
  );
  return 0;
}

/**
 * Send one turn to one session, right now, skipping both gates the watcher applies: naming a
 * session is an instruction, not a candidate for a filter.
 */
async function commandResume(
  config: Config,
  cli: string | undefined,
  id: string | undefined,
  json: boolean,
): Promise<number> {
  /** The one sentence a caller reads instead of a paragraph it would have to parse. */
  const refuse = (detail: string, code: number): number => {
    if (json) console.log(JSON.stringify({ ok: false, detail }, null, 2));
    else console.error(detail);
    return code;
  };

  if (!id) {
    return refuse("resume needs a session id: tide resume <session-id> [--cli <kind>]", 2);
  }

  const { adapters, problems } = buildAdapters(config, silentLogger, cli);
  for (const problem of problems) console.error(`  ! ${problem}`);
  if (adapters.length === 0) return 2;

  const matches = await locateSessions(adapters, id);
  if (matches.length === 0) {
    for (const adapter of adapters) adapter.close?.();
    return refuse(
      `no interrupted session matching "${id}" — only sessions stopped by a quota limit can be` +
        ` resumed; tide status lists them.`,
      1,
    );
  }
  if (matches.length > 1) {
    const candidates = matches.map((m) => `${m.adapter.kind}/${m.session.sessionId}`).join(", ");
    for (const adapter of adapters) adapter.close?.();
    return refuse(`"${id}" matches ${matches.length} sessions — use more of the id: ${candidates}`, 2);
  }

  const { adapter, session } = matches[0]!;
  const text = config.resume.prompt;

  if (!json) {
    console.log(`=== resume ${adapter.kind} ===`);
    console.log(`  session:  ${session.sessionId}`);
    console.log(`  cwd:      ${session.cwd}`);
    console.log(`  stopped:  ${session.detail}`);
    for (const said of session.spoken ?? []) {
      console.log(`  said:     ${JSON.stringify(said.text)}`);
    }
    console.log(`  prompt:   ${text}`);
  }

  // `resumeSession` writes the record either way, so the watcher will not repeat this while
  // the turn we just started is still running.
  const state = new StateStore(config.stateDir);
  const result = await resumeSession(adapter, session, text, state, config, silentLogger);
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          delivered: result.delivered,
          uncertain: result.uncertain ?? false,
          deferred: result.deferred ?? false,
          via: result.via,
          detail: result.detail,
          cli: adapter.kind,
          sessionId: session.sessionId,
          cwd: session.cwd,
          prompt: text,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`\n  ${result.ok ? "ok  " : "FAIL"}  via ${result.via} — ${result.detail}`);
  }

  for (const a of adapters) a.close?.();
  return result.ok ? 0 : 1;
}

/**
 * Every session a user-supplied id refers to, scanned with an empty filter. A prefix is
 * accepted because `status` prints 8 characters, which is what a user copies from.
 */
async function locateSessions(
  adapters: Adapter[],
  id: string,
): Promise<Array<{ adapter: Adapter; session: InterruptedSession }>> {
  const everything: FilterPolicy = { minIdleMinutes: 0, maxAgeMinutes: null, skipSubagents: false };
  const matches: Array<{ adapter: Adapter; session: InterruptedSession }> = [];
  for (const adapter of adapters) {
    for (const session of await adapter.findInterrupted(everything)) {
      if (session.sessionId === id || session.sessionId.startsWith(id)) {
        matches.push({ adapter, session });
      }
    }
  }
  return matches;
}

/** "the last 24h", or "any age" when the window is unbounded. */
function maxAgeLabel(filter: FilterPolicy): string {
  if (filter.maxAgeMinutes === null) return "any age";
  const hours = filter.maxAgeMinutes / 60;
  return hours % 24 === 0 ? `the last ${hours / 24}d` : `the last ${formatDuration(filter.maxAgeMinutes * 60_000)}`;
}

function commandDoctor(config: Config, configPath: string | null): number {
  console.log("tide doctor\n");
  let failures = 0;
  const check = (label: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(22)} ${detail}`);
    if (!ok) failures++;
  };

  check("config", true, configPath ?? "built-in defaults, no config file");
  check("state dir", true, config.stateDir);
  try {
    ensureStateDir(config.stateDir);
    check("state dir writable", true, "yes");
  } catch (err) {
    check("state dir writable", false, (err as Error).message);
  }

  const codexBin = resolveCodexBin(config.codex.bin);
  check("codex binary", !!codexBin, codexBin ?? "not found — set codex.bin or CODEX_BIN");
  if (codexBin && isStoreShim(codexBin)) {
    check("codex binary usable", false, "resolved to the Store shim, which cannot be launched");
  }

  const claudeBin = resolveClaudeBin(config.claude.bin);
  check("claude binary", !!claudeBin, claudeBin ?? "not found — set claude.bin or CLAUDE_BIN");
  if (claudeBin && isStoreShim(claudeBin)) {
    check("claude binary usable", false, "resolved to the Store shim, which cannot be launched");
  }

  const endpoint = resolveEndpoint();
  check("claude endpoint", true, endpoint ?? "not set (Claude Code will use its own default)");
  check("claude config dir", true, claudeConfigDir());

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  return failures === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  // `--help` next to a typo is still someone asking what the options are.
  if (flags.command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (flags.bad.length > 0) {
    for (const complaint of flags.bad) console.error(complaint);
    console.error(USAGE);
    return 2;
  }

  let config: Config;
  let configPath: string | null;
  try {
    const loaded = loadConfig(flags.configPath);
    config = applyFlags(loaded.config, flags);
    configPath = loaded.path;
  } catch (err) {
    console.error(`config error: ${(err as Error).message}`);
    return 2;
  }

  ensureStateDir(config.stateDir);
  const log = createLogger(config.stateDir, config.debug);

  switch (flags.command) {
    case "doctor":
      return commandDoctor(config, configPath);
    case "status":
      return await commandStatus(config, configPath, flags.cli, flags.json);
    case "resume":
      return await commandResume(config, flags.cli, flags.positional[0], flags.json);
    case "watch":
      break;
    default:
      console.error(`unknown command: ${flags.command}`);
      console.error(USAGE);
      return 2;
  }

  const { adapters, problems } = buildAdapters(config, log, flags.cli);
  for (const problem of problems) log.warn(problem);
  if (adapters.length === 0) {
    log.error("no usable adapters — nothing to watch");
    return 1;
  }

  const watcher = new Watcher({ config, state: new StateStore(config.stateDir), log, adapters });
  const shutdown = () => {
    log.info("shutting down…");
    watcher.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (flags.once) await watcher.runOnce();
  else await watcher.run();
  // Kills are asynchronous on Windows (`taskkill /T`), so let the event loop drain here:
  // calling `process.exit` would abandon them and leak the process trees.
  for (const adapter of adapters) adapter.close?.();
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof BoundaryError ? err.message : err);
    process.exit(1);
  });
