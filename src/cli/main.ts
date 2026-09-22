import { commandDenyCurrent, commandDoctor, commandQuota, commandResume, commandStatus, startWatch } from "./commands.js";
import { Config, MAX_SESSIONS_RETURNED } from "../config.js";
import { commandControl } from "./control.js";
import { foreground, launchNative, wrapperInvocation } from "../features/foreground.js";
import { monitorWorker, stopMonitor } from "../features/monitor.js";

const USAGE = `tide — resume Codex / Claude Code sessions after a quota limit resets

Usage:
  tide claude [CLI args...]                         Run Claude here and watch this session
  tide codex [CLI args...]                          Run Codex here and watch this session
  tide tail <session-id> --cli <kind> [--limit N] [--after cursor] [--json]
  tide snapshot <session-id> --cli <kind> [--limit N] [--json]
  tide send <session-id> --cli <kind> (--message text | --message-file path) [--dry-run] [--json]
  tide wait <session-id> --cli <kind> --after cursor [--timeout seconds] [--json]
  tide status [--cli <kind>] [--json] [--limit <n>]   Recorded events and monitor state (no quota probe)
  tide quota [--cli <kind>]                        Explicit quota check (Claude sends a real probe)
  tide resume <session-id> [--cli <kind>] [--json]   Queue continuation or explicitly launch a closed Claude session
  tide watch --session <id> | --session-all           Register persistent monitoring
  tide unwatch <id> | --session-all --cli <kind>      Cancel monitoring; leave CLI processes alone
  tide doctor                                        Check that this machine can run it
  tide deny-current [--cli <kind>]                  Add every currently quota-limited session to sessionDenyList

Options:
  --after <cursor>  Read/wait after a cursor returned by tail or send
  --message <text>  Send literal text, without changing the configured resume prompt
  --message-file <path>  Read the message from a UTF-8 file
  --mode <queue|interrupt>  send only; default queue. Unsupported interruption fails explicitly.
  --timeout <seconds>  Bounded wait (default 60); timeout never stops the session
  --cli <kind>      Only this CLI: codex, claude
  --dry-run         Say what would happen without resuming anything
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
  limit?: number;
  after?: string;
  message?: string;
  messageFile?: string;
  mode?: "queue" | "interrupt";
  timeout?: number;
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
  const takesValue = ["--cli", "--session", "--limit", "--after", "--message", "--message-file", "--timeout", "--mode"];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      flags.command = "help";
      continue;
    }
    if (takesValue.includes(arg)) {
      const value = argv[++i];
      if (value === undefined || (value.startsWith("--") && arg !== "--message")) {
        flags.parseErrors.push(`${arg} needs a value`);
        continue;
      }
      if (arg === "--mode") {
        if (value !== "queue" && value !== "interrupt") flags.parseErrors.push("--mode must be queue or interrupt");
        else flags.mode = value;
      } else if (arg === "--message") {
        flags.message = value;
      } else if (arg === "--message-file") {
        flags.messageFile = value;
      } else if (arg === "--after") {
        flags.after = value;
      } else if (arg === "--timeout") {
        const n = Number(value);
        if (!value.trim() || !Number.isFinite(n) || n < 0) flags.parseErrors.push("--timeout needs nonnegative seconds");
        else flags.timeout = n;
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
  if (flags.sessionAllowList && flags.sessionAll === undefined) overlay.sessionAll = false;
  if (Object.keys(overlay).length > 0) {
    return config.withOverrides(overlay);
  }
  return config;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "__monitor") {
    if (!["claude", "codex"].includes(argv[1] ?? "") || !argv[2] || !/^\d+$/.test(argv[3] ?? "")) throw new Error("Invalid monitor invocation");
    return monitorWorker(argv[1] as "claude" | "codex", argv[2], Number(argv[3]));
  }
  const wrapper = wrapperInvocation(argv);
  if (wrapper) return launchNative(wrapper.cli, wrapper.args);
  if (argv[0] === "__foreground") {
    const inner = wrapperInvocation(argv.slice(1));
    if (!inner) throw new Error("Invalid foreground CLI");
    return foreground(inner.cli, inner.args);
  }
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
  if (flags.mode !== undefined && flags.command !== "send") throw new Error("--mode is only supported by send");

  let config: Config;
  if (["snapshot", "tail", "send", "wait"].includes(flags.command)) {
    const allowed: Record<string, string[]> = {
      snapshot: ["--cli", "--limit", "--json"],
      tail: ["--cli", "--limit", "--after", "--json"],
      send: ["--cli", "--message", "--message-file", "--dry-run", "--json", "--mode"],
      wait: ["--cli", "--after", "--timeout", "--json"],
    };
    const used: Record<string, unknown> = { "--limit": flags.limit, "--after": flags.after, "--message": flags.message, "--message-file": flags.messageFile, "--timeout": flags.timeout, "--dry-run": flags.dryRun, "--skip-quota-check": flags.skipQuotaCheck, "--session-all": flags.sessionAll, "--session": flags.sessionAllowList };
    const invalid = Object.entries(used).find(([key, value]) => value !== undefined && !allowed[flags.command]!.includes(key));
    if (flags.positional.length !== 1 || invalid) {
      console.error(invalid ? `${invalid[0]} is not supported by ${flags.command}` : `${flags.command} requires exactly one session ID`);
      return 2;
    }
    return commandControl(Config.fromFile(false), { ...flags, id: flags.positional[0]! });
  }
  try {
    config = applyFlags(Config.fromFile(false), flags);
  } catch (err) {
    console.error(`config error: ${(err as Error).message}`);
    return 2;
  }

  switch (flags.command) {
    case "doctor":
      return commandDoctor(config);
    case "status":
      return await commandStatus(config, flags.cli, flags.json, flags.limit);
    case "quota":
      if (flags.dryRun) {
        console.log(JSON.stringify({ dryRun: true, detail: "No quota query performed" }));
        return 0;
      }
      return await commandQuota(config, flags.cli);
    case "resume":
      return await commandResume(config, flags.cli, flags.positional[0], flags.json);
    case "watch":
      if (!config.sessionAll && config.sessionAllowList.length === 0) {
        console.error("watch requires --session <id> (repeatable) or --session-all");
        console.error(USAGE);
        return 2;
      }
      return await startWatch(config, flags.cli);
    case "unwatch": {
      if (!["claude", "codex"].includes(flags.cli ?? "") || (flags.sessionAll ? flags.positional.length !== 0 : flags.positional.length !== 1)) throw new Error("unwatch requires a full session ID or --session-all, and --cli");
      const cli = flags.cli as "claude" | "codex";
      const id = flags.sessionAll ? "__all__" : flags.positional[0]!;
      stopMonitor(config, cli, id);
      console.log(JSON.stringify({ cli, sessionId: id, monitoring: false }));
      return 0;
    }
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
