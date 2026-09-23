import { runJson } from "../recovery/process.js";
import { resumePlugin, type Availability } from "../recovery/monitor.js";

export function claudeAvailability(value: unknown, code: number | null): Availability {
  if (!value || typeof value !== "object") throw Error("Invalid Claude probe response");
  const result = value as { type?: string; subtype?: string; is_error?: boolean; result?: unknown; api_error_status?: number };
  if (code === 0 && result.type === "result" && result.subtype === "success" && result.is_error === false
    && typeof result.result === "string" && /^\s*pong[.!]?\s*$/i.test(result.result)) return { allowed: true, reason: "Claude returned pong successfully" };
  if (result.api_error_status === 429 || (typeof result.result === "string" && /rate[ _-]?limit|hit your limit|usage limit/i.test(result.result))) {
    return { allowed: false, reason: "Claude probe is rate/usage limited" };
  }
  return { allowed: null, reason: "Claude probe did not confirm a successful pong" };
}

export async function probeClaude(cwd: string, signal: AbortSignal): Promise<Availability> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_MAX_RETRIES: "0" };
  for (const name of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_PID"]) delete env[name];
  const args = ["-p", "Respond with the single word: pong", "--no-session-persistence", "--output-format", "json",
    "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"disableAllHooks":true}'];
  if (process.env.TIDE_CLAUDE_MODEL) args.push("--model", process.env.TIDE_CLAUDE_MODEL);
  const result = await runJson(process.env.TIDE_CLAUDE_BIN || "claude", args, cwd, env, signal);
  return claudeAvailability(result.value, result.code);
}

export const createClaudeResume = () => resumePlugin("claude-code-resume", "claude", probeClaude);
