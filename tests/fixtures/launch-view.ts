import { spawnSync } from "node:child_process";
import { requestSession } from "../../src/session/ipc.ts";
import { stateDirectory } from "../../src/session/registry.ts";
import { viewSession } from "../../src/session/view.ts";
import type { SessionInfo } from "../../src/session/types.ts";

// Test-only display wiring: public launch, then the same reservation/view protocol
// attach uses. The outer PTY emulates a terminal; no desktop window is opened.
const [entry, ...args] = process.argv.slice(2);
if (!entry) throw Error("Expected CLI entry path");
const launched = spawnSync(process.execPath, [entry, "launch", ...args], {
  encoding: "utf8", windowsHide: true, timeout: 15000, env: process.env,
});
if (launched.status !== 0) throw launched.error ?? Error(launched.stderr || launched.stdout);
const session = JSON.parse(launched.stdout) as SessionInfo;
console.error(`[tide] ${session.id}`);
try {
  const { ticket } = await requestSession<{ ticket: string }>(session.id, { command: "attach-reserve" });
  try { process.exitCode = await viewSession(session.id, stateDirectory(), ticket); }
  finally { await requestSession(session.id, { command: "attach-cancel", ticket }).catch(() => {}); }
} catch (error) {
  await requestSession(session.id, { command: "close" }).catch(() => {});
  throw error;
}
