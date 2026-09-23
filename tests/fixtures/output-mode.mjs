import { configureWindowsConsole } from '../../src/terminal/windows-console.ts';
import { writeTerminalOutput } from '../../src/terminal/output.ts';

process.stdin.setRawMode(true);
configureWindowsConsole();
const write = process.argv[2] === 'legacy' ? data => process.stdout.write(data) : writeTerminalOutput;
write('\x1b[2J\x1b[H\x1b[2;2Hh\ni');
// Erase the correct column: an unwanted CR would leave i stuck at column one.
write('\x1b[3;3H \x1b[5;1HOUTPUT_DONE\x1b[6;1H中文 😀');
setTimeout(() => process.exit(0), 300);
