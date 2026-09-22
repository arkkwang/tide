import pty from 'node-pty';
import xterm from '@xterm/headless';

// Supply the existing-terminal side of a real `tide run` during integration tests.
const child = pty.spawn(process.execPath, process.argv.slice(2), {
  cols: 100, rows: 30, cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' },
});
const screen = new xterm.Terminal({ cols: 100, rows: 30 });
screen.onData((data) => child.write(data));
child.onData((data) => screen.write(data));
console.log(child.pid);
child.onExit(({ exitCode }) => { screen.dispose(); process.exit(exitCode ?? 0); });
process.on('SIGTERM', () => { child.kill(); process.exit(0); });
