import { commandDoctor, commandResume, commandStatus, startWatch } from "./commands.js";
import { loadConfig, type Config } from "./config.js";

const USAGE = `tide — resume Codex / Claude Code sessions after a quota limit resets

Usage:
  tide status [--cli <kind>] [--json]                Account state, and what is waiting to resume
  tide resume <session-id> [--cli <kind>] [--json]   Send one turn to one session, right now
  tide watch [--once]                                Watch and resume until you stop it (Ctrl-C)
  tide doctor                                        Check that this machine can run it

Options:
  --cli <kind>      Only this CLI: codex
  --prompt <text>   What resume sends (default: the configured resume prompt)
  --once            For watch: one pass instead of a loop
  --dry-run         Say what would happen without resuming anything
  --config <path>   Use a specific config file
  --debug           Verbose logging
  --json            Machine-readable output (status, resume)
  -h, --help        Show this help
`;

interface Flags {
  command: string;
  positional: string[];
  cli?: string;
  prompt?: string;
  configPath?: string;
  dryRun: boolean;
  debug: boolean;
  once: boolean;
  json: boolean;
  bad: string[];
}

function parseArgs(argv: string[]): Flags {
  const first = argv[0];
  const flags: Flags = {
    command: first === "--help" || first === "-h" ? "help" : (first ?? "help"),
    positional: [],
    bad: [],
    dryRun: false,
    debug: false,
    once: false,
    json: false,
  };
  const takesValue = ["--config", "--cli", "--prompt"];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      flags.command = "help";
      continue;
    }
    if (takesValue.includes(arg)) {
      const value = argv[++i];
      if (value === undefined) {
        flags.bad.push(`${arg} needs a value`);
        continue;
      }
      if (arg === "--config") flags.configPath = value;
      else if (arg === "--cli") flags.cli = value;
      else flags.prompt = value;
    } else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--debug") flags.debug = true;
    else if (arg === "--once") flags.once = true;
    else if (arg === "--json") flags.json = true;
    else if (arg.startsWith("-")) flags.bad.push(`unknown option: ${arg}`);
    else flags.positional.push(arg);
  }
  return flags;
}

function applyFlags(config: Config, flags: Flags): Config {
  return {
    ...config,
    dryRun: flags.dryRun || config.dryRun,
    debug: flags.debug || config.debug,
    resume: { ...config.resume, prompt: flags.prompt ?? config.resume.prompt },
  };
}

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (flags.bad.length > 0) {
    for (const complaint of flags.bad) console.error(complaint);
    console.error(USAGE);
    return 2;
  }

  let config: Config;
  let configPath: string | null;
  try {
    const loaded = loadConfig(flags.configPath);
    config = applyFlags(loaded.config, flags);
    configPath = loaded.path;
  } catch (err) {
    console.error(`config error: ${(err as Error).message}`);
    return 2;
  }

  switch (flags.command) {
    case "doctor":
      return commandDoctor(config, configPath);
    case "status":
      return await commandStatus(config, configPath, flags.cli, flags.json);
    case "resume":
      return await commandResume(config, flags.cli, flags.positional[0], flags.json);
    case "watch":
      return await startWatch(config, flags.cli, flags.once);
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
