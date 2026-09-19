import { mkdirSync } from "node:fs";
import { CodexAdapter, resolveCodexBin } from "./codex.js";
import {
  Watcher,
  printWaitingSession,
  type Adapter,
  type InterruptedSession,
  type QuotaInfo,
} from "./watch.js";
import { formatDuration, oneLine, short } from "./util.js";
import { type Config, type FilterPolicy } from "./config.js";

/** Build the adapters to work with, optionally narrowed to the one `--cli` names. */
export function buildAdapters(
  config: Config,
  cli?: string,
): { adapters: Adapter[]; problems: string[] } {
  const adapters: Adapter[] = [];
  const problems: string[] = [];

  if (cli !== undefined && cli !== "codex") {
    return { adapters, problems: [`unknown --cli "${cli}" — this build watches codex`] };
  }

  if ((cli === undefined || cli === "codex") && config.codex.enabled) {
    const bin = resolveCodexBin(config.codex.bin);
    if (bin) adapters.push(new CodexAdapter(bin, () => {}, config.filter, config.codex));
    else problems.push("codex: could not locate the CLI (set codex.bin or CODEX_BIN)");
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

interface StatusReport {
  cli: string;
  /** Null when the adapter has no binary to name — reported as null, not as the word. */
  binary: string | null;
  usable: boolean | null;
  unreadable: string | null;
  quota: QuotaInfo | null;
  waiting: InterruptedSession[];
}

export async function commandStatus(
  config: Config,
  configPath: string | null,
  cli: string | undefined,
  json: boolean,
): Promise<number> {
  const { adapters, problems } = buildAdapters(config, cli);
  for (const problem of problems) console.error(`  ! ${problem}`);
  if (adapters.length === 0) return 2;

  const reports: StatusReport[] = [];
  for (const adapter of adapters) {
    const report: StatusReport = {
      cli: adapter.kind,
      binary: adapter.resolveBin(),
      usable: null,
      unreadable: null,
      quota: null,
      // All quota-interrupted sessions, so the operator can see what just failed.
      // The watcher applies its own idle filter (`waitingSessions`) before resuming.
      waiting: await adapter.findInterrupted(config.filter),
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
          // The rules that produced the list above.
          policy: {
            source: configPath,
            filter: config.filter,
            resume: config.resume,
            codex: config.codex,
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
            (quota.primary.resetsAt ? `  resets ${new Date(quota.primary.resetsAt * 1_000).toISOString()}` : ""),
        );
      }
      if (quota.secondary) {
        console.log(
          `  7d window:   ${quota.secondary.usedPercent}%` +
            (quota.secondary.resetsAt
              ? `  resets ${new Date(quota.secondary.resetsAt * 1_000).toISOString()}`
              : ""),
        );
      }
      if (quota.nextResetAt) {
        const untilMs = quota.nextResetAt * 1_000 - Date.now();
        console.log(
          `  next reset:  ${new Date(quota.nextResetAt * 1_000).toISOString()} (in ${formatDuration(untilMs)})`,
        );
      }
      for (const note of quota.notes) console.log(`  note:        ${note}`);
    } else {
      console.log(`  usable now:  unknown (${report.unreadable})`);
    }

    console.log(
      `  waiting:     ${report.waiting.length} quota-interrupted session(s) (${maxAgeLabel(config.filter)})`,
    );
    for (const session of report.waiting) {
      printWaitingSession(session, config);
    }
  }

  console.log(`\n=== policy (${configPath ?? "built-in defaults, no config file"}) ===`);
  console.log(
    `  resume:  ${JSON.stringify(config.resume.prompt)}; Codex delivery timeout ${config.codex.deliveryTimeoutSeconds}s`,
  );
  console.log(
    `  codex:   ${config.codex.enabled ? "enabled" : "disabled"}`,
  );
  return 0;
}

/** Every session a user-supplied id refers to, scanned with an empty filter. */
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
  return hours % 24 === 0
    ? `the last ${hours / 24}d`
    : `the last ${formatDuration(filter.maxAgeMinutes * 60_000)}`;
}

export async function commandResume(
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

  const { adapters, problems } = buildAdapters(config, cli);
  for (const problem of problems) console.error(`  ! ${problem}`);
  if (adapters.length === 0) return 2;

  const matches = await locateSessions(adapters, id);
  if (matches.length === 0) {
    for (const adapter of adapters) adapter.close?.();
    return refuse(
      `no interrupted session matching "${id}" — only sessions stopped by a quota limit can be` +
        " resumed; tide status lists them.",
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

  const result = config.dryRun
    ? { ok: true, delivered: false, via: "dry-run", detail: `would resume in ${session.cwd}` }
    : await adapter.resume(session, text);
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

export function commandDoctor(config: Config, configPath: string | null): number {
  console.log("tide doctor\n");
  let failures = 0;
  const check = (label: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(22)} ${detail}`);
    if (!ok) failures++;
  };

  check("config", true, configPath ?? "built-in defaults, no config file");
  check("state dir", true, config.stateDir);
  try {
    mkdirSync(config.stateDir, { recursive: true });
    check("state dir writable", true, "yes");
  } catch (err) {
    check("state dir writable", false, (err as Error).message);
  }

  const codexBin = resolveCodexBin(config.codex.bin);
  check("codex binary", !!codexBin, codexBin ?? "not found — set codex.bin or CODEX_BIN");

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  return failures === 0 ? 0 : 1;
}

export async function startWatch(
  config: Config,
  cli: string | undefined,
  once: boolean,
): Promise<number> {
  const { adapters, problems } = buildAdapters(config, cli);
  for (const problem of problems) console.error(`  ! ${problem}`);
  if (adapters.length === 0) {
    console.error("no usable adapters — nothing to watch");
    return 1;
  }

  const watcher = new Watcher({ config, adapters });
  const shutdown = () => watcher.stop();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (once) await watcher.runOnce();
  else await watcher.run();
  // Kills are asynchronous on Windows (`taskkill /T`), so let the event loop drain here:
  // calling `process.exit` would abandon them and leak the process trees.
  for (const adapter of adapters) adapter.close?.();
  return 0;
}
