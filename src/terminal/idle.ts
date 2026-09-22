import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import type { IdleResult, Snapshot } from "./types.js";

export function validateWait(idleTime: number, timeout: number) {
  if (!Number.isFinite(idleTime) || idleTime <= 0 || idleTime > 3600) throw Error("--idle-time must be > 0 and <= 3600 seconds");
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 3600) throw Error("--timeout must be 0..3600 seconds");
}

export async function waitIdle(capture: () => Promise<Snapshot>, idleTime: number, timeout: number, signal?: AbortSignal): Promise<IdleResult> {
  validateWait(idleTime, timeout);
  const start = performance.now();
  let changed = start, previous = "";
  while (true) {
    signal?.throwIfAborted();
    const snapshot = await capture();
    const now = performance.now();
    const content = JSON.stringify([snapshot.cols, snapshot.rows, snapshot.buffer, snapshot.text]);
    if (previous && content !== previous) changed = now;
    previous = content;
    const elapsedMs = now - start, idleForMs = now - changed;
    // An idle window which first completes after the deadline is a timeout.
    const idle = idleForMs >= idleTime * 1000 && changed + idleTime * 1000 <= start + timeout * 1000;
    if (idle || elapsedMs >= timeout * 1000) return { id: snapshot.id, idle, elapsedMs: Math.round(elapsedMs), idleForMs: Math.round(idleForMs) };
    await sleep(Math.max(1, Math.min(100, idleTime * 1000 - idleForMs, timeout * 1000 - elapsedMs)), undefined, signal ? { signal } : {});
  }
}
