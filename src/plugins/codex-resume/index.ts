import { mkdtempSync, readFileSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCli, runProcess } from "../recovery/process.js";
import { resumePlugin, isPongReply, type Availability } from "../recovery/monitor.js";

export function codexAvailability(value: unknown): Availability {
  if (!value || typeof value !== "object") throw Error("Invalid Codex quota response");
  const result = value as { ordinaryUsageAllowed?: unknown; rateLimits?: { rateLimitReachedType?: string | null } };
  if (result.ordinaryUsageAllowed === true) return { allowed: true, reason: "Codex permits ordinary usage" };
  if (result.ordinaryUsageAllowed === false) return { allowed: false, reason: result.rateLimits?.rateLimitReachedType ?? "Codex blocks ordinary usage" };
  // Current generated App Server schema explicitly forbids inferring recovery
  // from percentages/reset timestamps when this permission is unavailable.
  return { allowed: null, reason: "Codex did not supply ordinaryUsageAllowed; recovery is unconfirmed" };
}

export async function probeCodex(cwd: string, signal: AbortSignal): Promise<Availability> {
  const child = spawnCli(process.env.TIDE_CODEX_BIN || "codex", ["app-server"], cwd, process.env);
  return new Promise((resolve, reject) => {
    let buffer = "", bytes = 0, settled = false;
    const finish = (error?: Error, result?: Availability) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", cancel);
      child.stdin.end(); child.kill();
      if (error) reject(error); else resolve(result!);
    };
    const cancel = () => finish(Error("Codex quota probe cancelled"));
    const timer = setTimeout(() => finish(Error("Codex quota probe timed out after 30 seconds")), 30000);
    const write = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
    child.stdin.on("error", (error) => finish(error)); child.stderr.resume();
    child.on("error", (error) => finish(error));
    child.on("close", () => finish(Error("Codex App Server closed before replying")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(data); buffer += data;
      if (bytes > 1024 * 1024) { finish(Error("Codex response too large")); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0 && !settled) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== 1 && message.id !== 2) continue;
          if (message.error) { finish(Error(`Codex App Server request failed (${String(message.error.code ?? "unknown")}): ${String(message.error.message ?? "Unknown error").slice(0, 240)}`)); return; }
          if (message.id === 1) {
            write({ method: "initialized" });
            write({ id: 2, method: "account/rateLimits/read", params: {} });
          } else finish(undefined, codexAvailability(message.result));
        } catch (error) { finish(error instanceof Error ? error : Error(String(error))); }
      }
    });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    write({ id: 1, method: "initialize", params: { clientInfo: { name: "tide-resume", version: "0.1.0" }, capabilities: { experimentalApi: true } } });
  });
}

export function codexPongAvailability(code: number | null, message: string): Availability {
  return code === 0 && isPongReply(message)
    ? { allowed: true, reason: "Codex exec returned pong successfully" }
    : { allowed: null, reason: "Codex exec did not confirm a successful pong" };
}

export async function probeCodexConnection(cwd: string, signal: AbortSignal): Promise<Availability> {
  const directory = mkdtempSync(join(tmpdir(), "tide-codex-probe-"));
  const output = join(directory, "reply.txt");
  try {
    const args = ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never",
      "--disable", "hooks", "--disable", "shell_tool", "-c", 'approval_policy="never"',
      "--output-last-message", output];
    if (process.env.TIDE_CODEX_MODEL) args.push("--model", process.env.TIDE_CODEX_MODEL);
    args.push("Connectivity check only. Do not use tools or read project files. Respond with the single word: pong");
    const result = await runProcess(process.env.TIDE_CODEX_BIN || "codex", args, cwd, process.env, signal);
    // Consume the official final-message artifact, never console logs or history JSONL.
    return codexPongAvailability(result.code, existsSync(output) ? readFileSync(output, "utf8") : "");
  } finally {
    if (existsSync(output)) unlinkSync(output);
    rmdirSync(directory);
  }
}

export const createCodexResume = () => resumePlugin("cxr", "Codex interruption recovery", "codex", async (cwd, signal, interruption) => {
  if (interruption.kind === "connection") return probeCodexConnection(cwd, signal);
  return probeCodex(cwd, signal);
});
