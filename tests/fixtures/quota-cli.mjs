import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

if (process.argv.includes('app-server')) {
  let initialized = false;
  createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n');
    else if (request.method === 'initialized') initialized = true;
    else if (request.method === 'account/rateLimits/read' && initialized) {
      process.stdout.write(JSON.stringify({ id: request.id, result: { ordinaryUsageAllowed: true } }) + '\n');
    } else process.stdout.write(JSON.stringify({ id: request.id, error: { message: 'bad handshake' } }) + '\n');
  });
} else if (process.argv.includes('exec')) {
  if (!process.argv.includes('--ephemeral') || !process.argv.includes('read-only')) process.exit(1);
  const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
  writeFileSync(output, 'pong\n');
  process.stdout.write('fixture console noise is not the final response');
} else if (process.argv.includes('-p')) {
  if (!process.argv.includes('--no-session-persistence') || !process.argv.includes('--output-format')) process.exit(1);
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'pong' }));
} else {
  const kind = process.argv[2];
  let input = '', limited = false, count = 0, connection = false;
  function draw() {
    const body = [kind === 'claude' ? 'Claude Code' : 'OpenAI Codex', connection ? '● API Error: Connection error.' : "● You've hit your limit · resets 8pm"];
    if (!limited) body.push('● Task completed normally', `RESUME_COUNT=${count}`);
    body.push('', `${kind === 'claude' ? '❯' : '›'} ${input}`, kind === 'claude' ? '  bypass permissions on · shift+tab to cycle' : '  90% context left · ? for shortcuts');
    const col = 3 + [...input].reduce((width, char) => width + (char.codePointAt(0) > 255 ? 2 : 1), 0);
    process.stdout.write('\x1b[?2004h\x1b[2J\x1b[H' + body.join('\r\n') + `\x1b[${body.length - 1};${col}H`);
  }
  process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume(); draw();
  process.stdin.on('data', (chunk) => {
    if (chunk.includes('\x03')) process.exit(0);
    input += chunk.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '');
    if (input.includes('\r')) {
      const command = input.replaceAll('\r', '');
      if (command === '/limit') limited = true;
      else if (command === '/connection') { limited = true; connection = true; }
      else if (command === '继续完成刚才因限额中断的任务。' || command === '继续完成刚才因连接中断的任务。') { count++; limited = false; }
      input = '';
    }
    draw();
  });
}
