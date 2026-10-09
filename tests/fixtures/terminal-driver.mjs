import pty from 'node-pty';
import xterm from '@xterm/headless';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Emulate a terminal for the test-only launch/view fixture, without a desktop window.
const child = pty.spawn(process.execPath, process.argv.slice(2), {
  cols: 100, rows: 30, cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' },
});
const screen = new xterm.Terminal({ cols: 100, rows: 30 });
screen.onData((data) => child.write(data));
let startup = '', reported = false;
child.onData((data) => {
  screen.write(data);
  if (!reported) {
    startup += data;
    const match = /\[tide\] ([a-f0-9-]{36})/.exec(startup);
    if (match) {
      const record = JSON.parse(readFileSync(join(process.env.TIDE_STATE_DIR, 'sessions', `${match[1]}.json`), 'utf8'));
      console.log(record.pid); reported = true;
    }
  }
});
child.onExit(({ exitCode }) => { if (!reported) console.error(startup); screen.dispose(); process.exit(exitCode ?? 0); });
process.on('SIGTERM', () => { child.kill(); process.exit(0); });
