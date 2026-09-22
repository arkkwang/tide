import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Config, type CliKind } from "../config.js";
import { buildAdapters } from "../providers/index.js";
import { processAlive } from "./recovery.js";
import { spawnDetached } from "../util.js";
import { Watcher } from "./watch.js";

interface MonitorRecord {
  workerPid: number;
  parentPid: number;
  enabled: boolean;
  phase: "standby" | "watching" | "stopped";
  updatedAt: number;
}
function paths(config: Config, cli: CliKind, id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid monitor session ID");
  const dir = join(config.stateDir, "monitors");
  const stem = join(dir, `${cli}-${id}`);
  return { dir, state: stem + ".json", lock: stem + ".lock", stop: stem + ".stop", log: stem + ".log", options: stem + ".options.json" };
}
export function monitorEnabled(config: Config, cli: CliKind, id: string): boolean {
  return !existsSync(paths(config, cli, id).stop);
}
export function registeredSessionIds(config: Config, cli: CliKind): string[] {
  const dir = join(config.stateDir, "monitors");
  if (!existsSync(dir)) return [];
  return [...new Set(readdirSync(dir).flatMap((name) => {
    if (!name.startsWith(`${cli}-`)) return [];
    const id = name.slice(cli.length + 1).replace(/\.(json|stop)$/, "");
    return id !== "__all__" && /^[a-zA-Z0-9_-]+$/.test(id) && /\.(json|stop)$/.test(name) ? [id] : [];
  }))];
}
export function monitorState(config: Config, cli: CliKind, id: string) {
  const p = paths(config, cli, id);
  if (!existsSync(p.state)) return { phase: "unregistered", enabled: false };
  const r: MonitorRecord = JSON.parse(readFileSync(p.state, "utf8"));
  if (!Number.isSafeInteger(r.workerPid) || r.workerPid <= 0 || !Number.isFinite(r.updatedAt) ||
      !["standby", "watching", "stopped"].includes(r.phase)) throw new Error(`Invalid monitor record: ${p.state}`);
  const alive = processAlive(r.workerPid);
  return { ...r, enabled: r.enabled && monitorEnabled(config, cli, id), phase: alive && Date.now() - r.updatedAt < 10_000 ? r.phase : "stopped" };
}
export function stopMonitor(config: Config, cli: CliKind, id: string): void {
  const p = paths(config, cli, id);
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.stop, "Monitoring cancelled by user\n");
  if (id === "__all__") {
    for (const name of readdirSync(p.dir)) {
      if (name.startsWith(`${cli}-`) && name.endsWith(".json") && !name.endsWith(".options.json")) {
        const target = name.slice(cli.length + 1, -5);
        if (target !== "__all__") stopMonitor(config, cli, target);
      }
    }
  }
}
function save(path: string, record: MonitorRecord) {
  const tmp = path + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, path);
}

export async function ensureMonitor(config: Config, cli: CliKind, id: string, parentPid = 0, originalArgs?: string[]): Promise<void> {
  const p = paths(config, cli, id);
  mkdirSync(p.dir, { recursive: true });
  if (originalArgs) writeFileSync(p.options, JSON.stringify(originalArgs));
  // Keep cancellation visible until the previous worker releases ownership.
  if (existsSync(p.stop) || monitorState(config, cli, id).phase === "stopped") {
    const deadline = Date.now() + 5000;
    while (existsSync(p.lock)) {
      if (Date.now() >= deadline) throw new Error(`Previous monitor has not released ownership; inspect ${p.lock}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (existsSync(p.stop)) unlinkSync(p.stop);
  const existing = monitorState(config, cli, id);
  if (existing.phase !== "stopped" && existing.phase !== "unregistered") return;
  const child = spawnDetached(process.execPath, [resolve(process.argv[1]!), "__monitor", cli, id, String(parentPid)], {
    logPath: p.log, env: { ...process.env, TIDE_STATE_DIR: config.stateDir },
  });
  if (!child.pid) throw new Error(child.spawnError ?? "Monitor could not start");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = monitorState(config, cli, id);
    if (state.enabled && (state.phase === "standby" || state.phase === "watching")) return;
    if (!processAlive(child.pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Monitor did not confirm startup; inspect ${p.log}`);
}

export async function monitorWorker(cli: CliKind, id: string, parentPid: number): Promise<number> {
  const config = Config.fromFile(false).withOverrides({ sessionAll: id === "__all__", sessionAllowList: id === "__all__" ? [] : [id], dryRun: false, skipQuotaCheck: false });
  const p = paths(config, cli, id);
  mkdirSync(p.dir, { recursive: true });
  let fd: number;
  try { fd = openSync(p.lock, "wx"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    console.error(`Monitor owner already registered; inspect ${p.lock} if the prior process crashed`);
    return 1;
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  const record: MonitorRecord = { workerPid: process.pid, parentPid, enabled: true, phase: "standby", updatedAt: Date.now() };
  let watcher: Watcher | undefined;
  let failed = false;
  const cancelled = () => failed || !monitorEnabled(config, cli, id);
  const heartbeat = setInterval(() => {
    record.updatedAt = Date.now();
    try { save(p.state, record); } catch (e) { failed = true; console.error((e as Error).message); watcher?.stop(); }
  }, 1000);
  const stop = () => { stopMonitor(config, cli, id); watcher?.stop(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    save(p.state, record);
    // The foreground wrapper owns recovery until it exits. The detached worker survives its terminal.
    while (!cancelled() && parentPid > 0 && processAlive(parentPid)) await new Promise((r) => setTimeout(r, 250));
    if (cancelled()) return 0;
    const { adapters, problems } = buildAdapters(config, cli);
    if (problems.length) throw new Error(problems.join("; "));
    record.phase = "watching";
    save(p.state, record);
    watcher = new Watcher({ config, adapters, shouldStop: cancelled });
    await watcher.run();
    return 0;
  } finally {
    clearInterval(heartbeat);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    record.phase = "stopped";
    record.enabled = false;
    record.updatedAt = Date.now();
    try { save(p.state, record); } finally { unlinkSync(p.lock); }
  }
}
