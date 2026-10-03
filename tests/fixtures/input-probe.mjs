// A deterministic foreground program: no echo, no pager dependency, exit on CR.
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('\x1b[?1lINPUT_PROBE_READY\r\n');
const chunks = [];
process.stdin.on('data', (data) => {
  chunks.push(data);
  if (data.includes(13)) {
    process.stdin.setRawMode(false);
    process.stdout.write(`INPUT_PROBE_BYTES:${Buffer.concat(chunks).toString('hex')}\r\n`);
    process.stdin.pause();
  }
});
