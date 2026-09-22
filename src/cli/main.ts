import { commandDenyCurrent, commandDoctor, commandQuota, commandResume, commandStatus, commandUnwatch, startWatch } from "./commands.js";
import { Config, MAX_SESSIONS_RETURNED } from "../config.js";
import { commandControl } from "./control.js";
import { foreground, launchNative, wrapperInvocation } from "../features/foreground.js";
import { monitorWorker } from "../features/monitor.js";



const USAGE = `tide — native CLI sessions with automatic quota recovery

Start:
  tide claude [CLI args...]       Native Claude here, with automatic monitoring
  tide codex [CLI args...]        Native Codex here, with automatic monitoring

Inspect:
  tide status [--cli <kind>] [--limit N] [--json]
  tide snapshot <id> --cli <kind> [--limit N] [--json]

Manage recovery:
  tide watch [--cli <kind>] (--session <id> | --session-all)
  tide unwatch --cli <kind> (<id> | --session-all) [--json]
  tide resume <id> [--cli <kind>] [--dry-run] [--json]

Script collaboration:
  tide send <id> --cli <kind> (--message text | --message-file path) [--mode queue|interrupt] [--dry-run] [--json]
  tide tail <id> --cli <kind> [--limit N] [--after cursor] [--json]
  tide wait <id> --cli <kind> --after cursor [--timeout seconds] [--json]

Diagnostics and configuration:
  tide doctor
  tide quota [--cli <kind>] [--dry-run] [--json]
  tide deny-current [--cli <kind>]

Behavior:
  <kind> is claude or codex. Use status to find IDs.
  Session IDs accept unique prefixes; exact matches take priority.
  status is read-only; lastEvent is historical, not live process state.
  snapshot shows recent text; tail/wait provide incremental script observation.
  watch enables automatic recovery and persists after this terminal closes.
  unwatch cancels monitoring, not the CLI or its current turn.
  resume uses the configured prompt: Codex queues it; Claude requests a visible
    window for a closed session. Neither confirms task completion.
  send supports Codex queue only. Claude send and interrupt fail explicitly.
  quota probes Claude with a real model request; doctor checks config/binaries only.
  deny-current persists exclusions for all recorded quota-limited sessions.

Options:
  --session <id>       Repeatable for watch; cannot combine with --session-all
  --session-all        Watch/unwatch all sessions of the selected CLI
  --limit N            status default ${MAX_SESSIONS_RETURNED}; snapshot/tail default 10
  --timeout seconds    wait default 60; timeout never stops or resends
  --dry-run            resume/send/quota: no action; watch: foreground simulation
  --skip-quota-check   watch only: foreground recovery without probing (debug)
  --json               Structured output for inspect, resume, collaboration, quota, unwatch
  -h, --help           Show help; arguments after claude/codex belong to that CLI
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
  const allowed: Record<string, string[]> = {
    status: ["cli", "limit", "json"],
    snapshot: ["cli", "limit", "json"],
    tail: ["cli", "limit", "after", "json"],
    send: ["cli", "message", "messageFile", "dryRun", "mode", "json"],
    wait: ["cli", "after", "timeout", "json"],
    resume: ["cli", "dryRun", "json"],
    watch: ["cli", "sessionAllowList", "sessionAll", "dryRun", "skipQuotaCheck"],
    unwatch: ["cli", "sessionAll", "json"],
    quota: ["cli", "dryRun", "json"],
    doctor: [],
    "deny-current": ["cli"],
  };
  const names: Record<string, string> = {
    cli: "--cli", limit: "--limit", after: "--after", message: "--message",
    messageFile: "--message-file", mode: "--mode", timeout: "--timeout",
    dryRun: "--dry-run", skipQuotaCheck: "--skip-quota-check",
    sessionAll: "--session-all", sessionAllowList: "--session", json: "--json",
  };
  const options = allowed[flags.command];
  if (!options) flags.parseErrors.push(`unknown command: ${flags.command}`);
  else {
    for (const [key, option] of Object.entries(names)) {
      const value = flags[key as keyof Flags];
      if (value !== undefined && value !== false && !options.includes(key)) {
        flags.parseErrors.push(`${option} is not supported by ${flags.command}`);
      }
    }
    if (flags.cli !== undefined && !["claude", "codex"].includes(flags.cli)) {
      flags.parseErrors.push("--cli must be claude or codex");
    }
    const required = ["snapshot", "tail", "send", "wait", "resume"].includes(flags.command)
      || (flags.command === "unwatch" && !flags.sessionAll) ? 1 : 0;
    if (flags.positional.length !== required) flags.parseErrors.push(
      required ? `${flags.command} requires exactly one session ID` : `${flags.command} does not accept positional arguments`);
    if (flags.sessionAll && flags.sessionAllowList) flags.parseErrors.push("--session and --session-all cannot be combined");
    if (["snapshot", "tail", "send", "wait", "unwatch"].includes(flags.command) && !flags.cli) {
      flags.parseErrors.push(`${flags.command} requires --cli claude|codex`);
    }
  }
  if (flags.parseErrors.length > 0) {
    const detail = flags.parseErrors.join("; ");
    if (flags.json) console.log(JSON.stringify({ ok: false, detail }));
    else console.error(detail + "\nRun tide --help for usage.");
    return 2;
  }

  let config: Config;
  try {
    config = applyFlags(Config.fromFile(false), flags);
  } catch (err) {
    const detail = `config error: ${(err as Error).message}`;
    if (flags.json) console.log(JSON.stringify({ ok: false, detail }));
    else console.error(detail);
    return 2;
  }
  if (["snapshot", "tail", "send", "wait"].includes(flags.command)) {
    return commandControl(config, { ...flags, id: flags.positional[0]! });
  }

  switch (flags.command) {
    case "doctor":
      return commandDoctor(config);
    case "status":
      return await commandStatus(config, flags.cli, flags.json, flags.limit);
    case "quota":
      if (flags.dryRun) {
        console.log(flags.json ? JSON.stringify({ dryRun: true, detail: "No quota query performed" }) : "Dry run: no quota query performed.");
        return 0;
      }
      return await commandQuota(config, flags.cli, flags.json);
    case "resume":
      return await commandResume(config, flags.cli, flags.positional[0], flags.json);
    case "watch":
      if (!config.sessionAll && config.sessionAllowList.length === 0) {
        console.error("watch requires --session <id> (repeatable) or --session-all");
        console.error(USAGE);
        return 2;
      }
      return await startWatch(config, flags.cli);
    case "unwatch":
      return commandUnwatch(config, flags.cli as "claude" | "codex", flags.positional[0] ?? "", flags.sessionAll ?? false, flags.json);
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
    const argv = process.argv.slice(2);
    if (!wrapperInvocation(argv) && !argv[0]?.startsWith("__") && argv.includes("--json")) {
      console.log(JSON.stringify({ ok: false, detail: (err as Error).message }));
    } else console.error((err as Error).message);
    process.exit(1);
  });
