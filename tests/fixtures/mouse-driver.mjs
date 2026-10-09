import { resolve } from 'node:path';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const node = process.env.TIDE_TEST_NODE ?? process.execPath;
const child = pty.spawn(node, ['--import', 'tsx', resolve('tests/fixtures/launch-view.ts'), resolve(process.env.TIDE_TEST_ENTRY ?? 'dist/tide.mjs'), '--shell', process.env.TIDE_TEST_SHELL ?? 'bash', '--', '--noprofile', '--norc', '-c', 'exec "$@"', 'tide-fixture', node.replaceAll('\\', '/'), '--import', 'tsx', resolve('tests/fixtures/mouse-input.mjs').replaceAll('\\', '/')], {
  cols: 100, rows: 30, cwd: process.cwd(), env: process.env,
});
const screen = new xterm.Terminal({ cols: 100, rows: 30 });
screen.onData((data) => child.write(data));
let output = '', sent = false;
const timer = setTimeout(() => { child.kill(); console.error(JSON.stringify(output)); process.exit(1); }, 20000);
child.onData((data) => {
  output += data; screen.write(data);
  if (!sent && output.includes('MOUSE_READY')) {
    sent = true;
    let input = process.argv[2];
    if (process.argv[3] === 'public') {
      const id = readdirSync(join(process.env.TIDE_STATE_DIR, 'sessions'))[0].replace(/\.json$/, '');
      for (const direction of ['up', 'down']) {
        const r = spawnSync(node, [resolve(process.env.TIDE_TEST_ENTRY ?? 'dist/tide.mjs'), 'scroll', id.slice(0, 8), direction, '--steps', '1', '--x', '10', '--y', '10', '--with-read'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        if (r.status !== 0 || !JSON.parse(r.stdout).read) { console.error(r.stderr || r.stdout); child.kill(); process.exit(1); }
      }
      input = input.replace(/^\x1b\[<64;10;10M\x1b\[<65;10;10M/, '');
    }
    child.write(input);
  }
});
child.onExit(({ exitCode }) => {
  clearTimeout(timer); screen.dispose();
  process.stdout.write(JSON.stringify({ output, exitCode }) + '\n', () => process.exit(0));
});
