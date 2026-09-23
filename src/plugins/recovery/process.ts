import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function spawnCli(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  let binary = name;
  if (process.platform === "win32") {
    if (!existsSync(binary)) {
      const found = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true, env });
      const paths = (found.stdout ?? "").trim().split(/\r?\n/).filter((path) => path && existsSync(path));
      binary = paths.find((path) => /\.exe$/i.test(path)) ?? paths[0] ?? name;
    }
    if (!/\.exe$/i.test(binary)) {
      const script = binary.replace(/\.cmd$/i, "");
      if (!existsSync(script)) throw Error(`Cannot launch ${name}; configure a native executable or npm shell entry`);
      const bash = env.CLAUDE_CODE_GIT_BASH_PATH || "bash.exe";
      return spawn(bash, ["-c", [script.replaceAll("\\", "/"), ...args].map(quote).join(" ")], {
        cwd, env: { ...env, MSYS2_ARG_CONV_EXCL: "*" }, windowsHide: true, stdio: "pipe",
      });
    }
  }
  return spawn(binary, args, { cwd, env, windowsHide: true, stdio: "pipe" });
}

export async function runProcess(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ code: number | null; out: string }> {
  const child = spawnCli(name, args, cwd, env);
  return new Promise((resolve, reject) => {
    let out = "", settled = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", cancel);
      child.kill();
      if (error) reject(error);
      else resolve({ code, out });
    };
    const cancel = () => finish(Error("Probe cancelled"));
    const timer = setTimeout(() => finish(Error("Probe timed out after 30 seconds")), 30000);
    child.stdin.on("error", () => {}); child.stdin.end();
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      out += data;
      if (Buffer.byteLength(out) > 1024 * 1024) finish(Error("Probe response too large"));
    });
    child.on("error", finish); child.on("close", (code) => finish(undefined, code));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

export async function runJson(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ code: number | null; value: unknown }> {
  const result = await runProcess(name, args, cwd, env, signal);
  try { return { code: result.code, value: JSON.parse(result.out) }; }
  catch { throw Error("Probe did not return valid JSON"); }
}
