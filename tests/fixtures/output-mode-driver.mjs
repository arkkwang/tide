import pty from 'node-pty';
import { resolve } from 'node:path';

let output = '';
const child = pty.spawn(process.execPath, [
  '--import', 'tsx', resolve('tests/fixtures/output-mode.mjs'), process.argv[2] || 'fixed',
], { cols: 40, rows: 10, cwd: process.cwd(), env: process.env });
child.onData(data => { output += data; });
child.onExit(({ exitCode }) => {
  console.log(JSON.stringify({ output, exitCode }));
  process.exit(0);
});
setTimeout(() => { child.kill(); process.exit(1); }, 12000);
