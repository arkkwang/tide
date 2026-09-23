import { enableWindowsVTInput } from '../../src/terminal/windows-input.ts';

process.stdin.setRawMode(true);
enableWindowsVTInput();
let input = '';
process.stdin.on('data', (data) => {
  input += data.toString();
  if (input.endsWith('done')) {
    process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?2004l\r\nINPUT_HEX:' + Buffer.from(input).toString('hex') + '\r\n');
    process.exit(0);
  }
});
process.stdout.write('\x1b[?1000h\x1b[?1006h\x1b[?2004hMOUSE_READY');
