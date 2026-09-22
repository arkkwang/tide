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

  async stop(): Promise<boolean> {
    if (!this.running) return true;
    if (!this.child.kill()) return false;
    await this.exited;
    return true;
  }
}
