import { setTimeout as sleep } from "node:timers/promises";

export function validateSize(cols: number, rows: number) {
  if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200) throw Error("resize requires --cols 20..500 and --rows 5..200");
}

export async function requestResize(cols: number, rows: number, current: () => { cols: number; rows: number }, write: (data: string) => void, signal: AbortSignal, timeoutMs = 3000) {
  validateSize(cols, rows);
  signal.throwIfAborted();
  let actual = current();
  if (actual.cols !== cols || actual.rows !== rows) {
    write(`\x1b[8;${rows};${cols}t`);
    const deadline = Date.now() + timeoutMs;
    do {
      await sleep(50, undefined, { signal });
      actual = current();
    } while ((actual.cols !== cols || actual.rows !== rows) && Date.now() < deadline);
  }
  return { requested: { cols, rows }, actual, applied: actual.cols === cols && actual.rows === rows };
}
