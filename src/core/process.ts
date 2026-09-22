import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** This handle controls only the process created by this launch, never a discovered PID. */
export class Execution {
  readonly exited: Promise<number>;
  private constructor(private readonly child: ChildProcess) {
    this.exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 130));
    });
    // A caller may inspect the handle before awaiting exit.
    void this.exited.catch(() => {});
  }

  static launch(binary: string, args: string[], options: SpawnOptions = {}): Execution {
    return new Execution(spawn(binary, args, { stdio: "inherit", windowsHide: false, ...options }));
  }

  get pid() { return this.child.pid; }
  get running() { return this.child.exitCode === null && this.child.signalCode === null && this.child.pid !== undefined; }

  async stop(graceMs = 3000): Promise<boolean> {
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error("Stop grace period must be nonnegative");
    if (!this.running) return true;
    if (!this.child.kill()) return false;
    const wait = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          this.exited.then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), graceMs); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    if (await wait()) return true;
    if (!this.running) return true;
    if (!this.child.kill("SIGKILL")) return false;
    return wait();
  }
}
