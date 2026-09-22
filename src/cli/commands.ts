import { Sessions, locateSessions } from "../core/sessions.js";
import { resumeSession } from "../features/resume.js";
import { buildAdapters } from "../providers/index.js";
import type { QuotaInfo, Session } from "../core/session.js";
import { ensureMonitor, monitorEnabled, monitorState } from "../features/monitor.js";
import { resolveCodexBin } from "../providers/codex.js";
import { resolveClaudeBin } from "../providers/claude/adapter.js";
import {
  Watcher,
  capWithMainReserve,
} from "../features/watch.js";
import { type Config, MAX_SESSIONS_RETURNED } from "../config.js";

export async function commandStatus(config: Config, cli: string | undefined, json: boolean, limit: number | undefined): Promise<number> {
  const { adapters, problems } = buildAdapters(config, cli);
  const reports = [];
  for (const adapter of adapters) {
    const sessions = capWithMainReserve(await adapter.list(), limit ?? MAX_SESSIONS_RETURNED, config.watchPolicy.maxMainSessions);
    reports.push({ cli: adapter.kind, binary: adapter.resolveBin(), sessions: sessions.map((s) => ({
      ...adapter.state(s),
      monitors: { session: monitorState(config, adapter.kind, s.sessionId), all: monitorState(config, adapter.kind, "__all__") },
      excluded: config.sessionDenyList.some((id) => s.sessionId.startsWith(id)) || !monitorEnabled(config, adapter.kind, s.sessionId),
    })) });
  }
  const result = { clis: reports, problems };
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const report of result.clis) {
      console.log(report.cli + " — historical observations; current runtime state unknown");
      if (report.sessions.length === 0) console.log("  No recent sessions found.");
      for (const s of report.sessions) console.log(s.sessionId + "  " + s.cwd + "  last=" + s.lastEvent + "  monitor=" + s.monitors.session.phase + "  all=" + s.monitors.all.phase + (s.excluded ? " [excluded]" : ""));
    }
    for (const problem of result.problems) console.error(problem);
  }
  return problems.length ? 2 : 0;
}

export async function commandQuota(config: Config, cli: string | undefined, json = false): Promise<number> {
  const { adapters, problems } = buildAdapters(config, cli);
  const quotas: Array<{ cli: string; quota: QuotaInfo | null; error: string | null }> = [];
  for (const adapter of adapters) {
    try { quotas.push({ cli: adapter.kind, quota: await adapter.readQuota(), error: null }); }
    catch (error) { quotas.push({ cli: adapter.kind, quota: null, error: (error as Error).message }); }
  }
  if (json) console.log(JSON.stringify({ quotas, problems }, null, 2));
  else {
    for (const { cli, quota, error } of quotas) {
      console.log(`${cli}: ${error ? "check failed — " + error : quota?.allowed ? "available for this check" : "unavailable — " + quota?.blockedReason}`);
      for (const note of quota?.notes ?? []) console.log(`  ${note}`);
    }
    for (const problem of problems) console.error(problem);
  }
  return problems.length || quotas.some((q) => q.error) ? 2 : 0;
}

export async function commandResume(
  config: Config,
  cli: string | undefined,
  id: string | undefined,
  json: boolean,
): Promise<number> {
  const refuse = (detail: string, code: number): number => {
    if (json) console.log(JSON.stringify({ ok: false, detail }, null, 2));
    else console.error(detail);
    return code;
  };

  if (!id) {
    return refuse("resume needs a session id: tide resume <session-id> [--cli <kind>]", 2);
  }

  const { adapters, problems } = buildAdapters(config, cli);
  for (const problem of problems) {
    console.error(`  ! ${problem}`);
  }
  if (adapters.length === 0) {
    return refuse("No usable CLI; check tide doctor and CLI configuration.", 2);
  }

  const matches = await locateSessions(adapters, id);
  if (matches.length === 0) {
    return refuse(
      `no session matching "${id}" — tide status shows the current list.`,
      1,
    );
  }
  if (matches.length > 1) {
    const candidates = matches.map((m) => `${m.adapter.kind}/${m.session.sessionId}`).join(", ");
    return refuse(`"${id}" matches ${matches.length} sessions — use more of the id: ${candidates}`, 2);
  }

  const { adapter, session } = matches[0]!;
  const text = config.resume.prompt;

  if (!json) {
    console.log(`=== resume ${adapter.kind} ===`);
    console.log(`  session:  ${session.sessionId}`);
    console.log(`  cwd:      ${session.cwd}`);
    for (const said of session.spoken ?? []) {
      console.log(`  said:     ${JSON.stringify(said.text)}`);
    }
    console.log(`  prompt:   ${text}`);
  }

  const result = config.dryRun
    ? { ok: true, delivered: false, via: "dry-run", detail: `would resume in ${session.cwd}` }
    : await resumeSession(adapter, session, text);
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          delivered: result.delivered,
          launchRequested: result.launchRequested ?? false,
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

  return result.ok ? 0 : 1;
}

export function commandDoctor(config: Config): number {
  console.log("tide doctor\n");
  let failures = 0;
  const check = (label: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(22)} ${detail}`);
    if (!ok) failures++;
  };

  check("config", true, config.path);

  const codexBin = resolveCodexBin(config.codex.bin);
  check("codex binary", !!codexBin, codexBin ?? "not found — set codex.bin or CODEX_BIN");

  const claudeBin = resolveClaudeBin(config.claude.bin);
  check("claude binary", !!claudeBin, claudeBin ?? "not found — set claude.bin or CLAUDE_BIN");

  console.log(failures === 0 ? "\nConfig and binaries found. Authentication and session control were not tested." : `\n${failures} check(s) failed`);
  return failures === 0 ? 0 : 1;
}

export async function commandDenyCurrent(
  config: Config,
  cli: string | undefined,
): Promise<number> {
  const { adapters, problems } = buildAdapters(config, cli);
  for (const problem of problems) {
    console.error(`  ! ${problem}`);
  }
  if (adapters.length === 0) {
    console.error("no usable adapters — nothing to deny");
    return 1;
  }

  const ids: string[] = [];
  for (const adapter of adapters) {
    const sessions = await adapter.list();
    for (const s of sessions) {
      if (s.lastEvent === "quota-limited") ids.push(s.sessionId);
    }
  }

  if (ids.length === 0) {
    console.log("no quota-limited sessions found");
    return 0;
  }

  const before = config.sessionDenyList.length;
  const set = new Set(config.sessionDenyList);
  for (const id of ids) {
    set.add(id);
  }
  const addedBeforeSave = set.size - before;

  try {
    config.update({ sessionDenyList: [...set] });
  } catch (err) {
    console.error(`config error: ${(err as Error).message}`);
    return 1;
  }

  console.log(
    `added ${addedBeforeSave} session(s) to sessionDenyList (now ${config.sessionDenyList.length} total)`,
  );
  for (const id of ids) {
    console.log(`  ${id}`);
  }
  return 0;
}

export async function startWatch(
  config: Config,
  cli: string | undefined,
): Promise<number> {
  const { adapters, problems } = buildAdapters(config, cli);
  for (const problem of problems) {
    console.error(`  ! ${problem}`);
  }
  if (adapters.length === 0) {
    console.error("no usable adapters — nothing to watch");
    return 1;
  }

  if (!config.dryRun && !config.skipQuotaCheck) {
    if (config.sessionAll) {
      for (const adapter of adapters) await ensureMonitor(config, adapter.kind, "__all__");
    } else {
      const targets: Array<{ adapter: Sessions; session: Session }> = [];
      for (const id of config.sessionAllowList) {
        const matches = await locateSessions(adapters, id);
        if (matches.length !== 1) throw new Error(`Session ${id} is missing or ambiguous`);
        targets.push(matches[0]!);
      }
      for (const { adapter, session } of targets) await ensureMonitor(config, adapter.kind, session.sessionId);
    }
    console.log("Monitoring registered; it continues after this terminal closes. Use tide unwatch to cancel.");
    return 0;
  }

  const watcher = new Watcher({ config, adapters });
  const shutdown = () => watcher.stop();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await watcher.run();
    return 0;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
