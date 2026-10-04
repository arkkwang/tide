// Real PTY application: no window or desktop automation is used by this fixture.
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let count = 0, reports = 0, pendingInput = '';
const draw = () => process.stdout.write(`\x1b[2J\x1b[H\x1b[32mATTACH_APP pid=${process.pid} count=${count}\x1b[0m\r\nsize=${process.stdout.columns}x${process.stdout.rows}`);
process.stdout.write('\x1b[31mNORMAL_BUFFER\x1b[0m\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?25l');
process.stdin.on('data', chunk => {
  pendingInput += chunk;
  while (true) {
    const report = /^\x1b\[\d+;\d+R/.exec(pendingInput);
    if (!report) break;
    pendingInput = pendingInput.slice(report[0].length);
    process.stdout.write(`\r\nREPORTS:${++reports}`);
  }
  if (!pendingInput || /^\x1b(?:\[[\d;]*)?$/.test(pendingInput)) return;
  const data = pendingInput; pendingInput = '';
  if (data === 'query') { process.stdout.write('\x1b[6n'); return; }
  if (data === 'quit') { process.stdout.write('\r\nFINAL_OUTPUT', () => process.exit(7)); return; }
  count++;
  draw();
  process.stdout.write(`\r\nINPUT:${Buffer.from(data).toString('hex')}`);
});
process.stdout.on('resize', draw);
draw();
