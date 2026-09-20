import { commandDenyCurrent, commandDoctor, commandResume, commandStatus, startWatch } from "./commands.js";
import { Config, DEFAULT_CONFIG_PATH, MAX_SESSIONS_RETURNED } from "./config.js";

const USAGE = `tide — resume Codex / Claude Code sessions after a quota limit resets

Usage:
  tide status [--cli <kind>] [--json] [--limit <n>]   Account state, and what is waiting to resume
  tide resume <session-id> [--cli <kind>] [--json]   Send one turn to one session, right now
  tide watch                                        Watch and resume until you stop it (Ctrl-C)
  tide doctor                                        Check that this machine can run it
  tide deny-current [--cli <kind>]                  Add every currently quota-limited session to sessionDenyList
  tide deny-current [--cli <kind>]                  Add every currently quota-limited session to sessionDenyList

Options:
  --cli <kind>      Only this CLI: codex, claude
  --dry-run         Say what would happen without resuming anything
  --config <path>   Use a specific config file
  --skip-quota-check  Skip the quota probe and resume any waiting session. Test/debug only.
  --session <id>    For watch: a session id the watcher may resume. Repeatable.
  --session-all     For watch: resume every waiting session regardless of --session list.
  --limit <n>       For status: cap how many sessions to show (default: ${MAX_SESSIONS_RETURNED}); watch ignores it
  --json            Machine-readable output (status, resume)
  -h, --help        Show this help
`;

interface Flags {
  command: string;
  positional: string[];
  cli?: string;
  configPath?: string;
  limit?: number;
  /** Config-mergeable. Absent means "don't override config". */
  dryRun?: boolean;
  skipQuotaCheck?: boolean;
  sessionAll?: boolean;
  sessionAllowList?: string[];
  json: boolean;
  parseErrors: string[];
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    command: argv[0] === "--help" || argv[0] === "-h" ? "help" : (argv[0] ?? "help"),
    positional: [],
    parseErrors: [],
    json: false,
  };
  const takesValue = ["--config", "--cli", "--session", "--limit"];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      flags.command = "help";
      continue;
    }
    if (takesValue.includes(arg)) {
      const value = argv[++i];
      if (value === undefined) {
        flags.parseErrors.push(`${arg} needs a value`);
        continue;
      }
      if (arg === "--config") {
        flags.configPath = value;
      } else if (arg === "--cli") {
        flags.cli = value;
      } else if (arg === "--session") {
        (flags.sessionAllowList ??= []).push(value);
      } else if (arg === "--limit") {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
          flags.parseErrors.push(`--limit must be a positive integer (got "${value}")`);
        } else {
          flags.limit = n;
        }
      }
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--skip-quota-check") {
      flags.skipQuotaCheck = true;
    } else if (arg === "--session-all") {
      flags.sessionAll = true;
    } else if (arg.startsWith("-")) {
      flags.parseErrors.push(`unknown option: ${arg}`);
    } else {
      flags.positional.push(arg);
    }
  }
  return flags;
}

function applyFlags(config: Config, flags: Flags): Config {
  const flagFields = flags as unknown as Record<string, unknown>;
  const overlay: Record<string, unknown> = {};
  for (const key of Object.keys(config)) {
    if (key in flagFields && flagFields[key] !== undefined) {
      overlay[key] = flagFields[key];
    }
  }
  return new Config({ ...config, ...overlay }, config.path);
}

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (flags.parseErrors.length > 0) {
    for (const complaint of flags.parseErrors) console.error(complaint);
    console.error(USAGE);
    return 2;
  }

  let config: Config;
  try {
    config = applyFlags(Config.fromFile(flags.configPath ?? DEFAULT_CONFIG_PATH), flags);
  } catch (err) {
    console.error(`config error: ${(err as Error).message}`);
    return 2;
  }

  switch (flags.command) {
    case "doctor":
      return commandDoctor(config);
    case "status":
      return await commandStatus(config, flags.cli, flags.json, flags.limit);
    case "resume":
      return await commandResume(config, flags.cli, flags.positional[0], flags.json);
    case "watch":
      if (!config.sessionAll && config.sessionAllowList.length === 0) {
        console.error("watch requires --session <id> (repeatable) or --session-all");
        console.error(USAGE);
        return 2;
      }
      return await startWatch(config, flags.cli);
    case "deny-current":
      return await commandDenyCurrent(config, flags.cli);
    default:
      console.error(`unknown command: ${flags.command}`);
      console.error(USAGE);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
