import { CodexAdapter, resolveCodexBin } from "./codex.js";
import { ClaudeAdapter, resolveClaudeBin } from "./claude/adapter.js";
import type { Config } from "../config.js";
import { Sessions } from "../core/sessions.js";

export function buildAdapters(
  config: Config,
  cli?: string,
): { adapters: Sessions[]; problems: string[] } {
  const adapters: Sessions[] = [];
  const problems: string[] = [];

  if (cli !== undefined && cli !== "codex" && cli !== "claude") {
    return { adapters, problems: [`unknown --cli "${cli}" — this build watches codex, claude`] };
  }

  if ((cli === undefined || cli === "codex") && config.codex.enabled) {
    const bin = resolveCodexBin(config.codex.bin);
    if (bin) {
      adapters.push(new Sessions(new CodexAdapter(bin, config.codex)));
    } else {
      problems.push("codex: could not locate the CLI (set codex.bin or CODEX_BIN)");
    }
  }

  if ((cli === undefined || cli === "claude") && config.claude.enabled) {
    const bin = resolveClaudeBin(config.claude.bin);
    if (bin) {
      adapters.push(new Sessions(new ClaudeAdapter(bin, config)));
    } else {
      problems.push("claude: could not locate the CLI (set claude.bin or CLAUDE_BIN)");
    }
  }
  if (adapters.length === 0 && problems.length === 0) {
    problems.push(
      cli !== undefined ? `${cli}: not enabled in config` : "no CLI is enabled — check the config",
    );
  }
  return { adapters, problems };
}
