import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Manual acceptance driver: every operation uses the built, public Tide CLI.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = join(root, '.tide/acceptance-latest.json');
const [action, target, ...args] = process.argv.slice(2);
let report;
async function cli(argv) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(root, 'dist/tide.mjs'), ...argv], { cwd: root, env: { ...process.env, TIDE_STATE_DIR: report.state }, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (s) => { out += s; }); child.stderr.on('data', (s) => { err += s; });
    child.on('error', fail); child.on('exit', (code) => code === 0 || code === 3 ? done({ code, out, err }) : fail(Error(err || out)));
  });
}
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
try {
  if (action === 'init') {
    mkdirSync(join(root, '.tide'), { recursive: true });
    const state = mkdtempSync(join(root, '.tide/acceptance-'));
    const work = join(state, 'work'); mkdirSync(work);
    report = { state, work, sessions: {}, checks: [], captures: [] };
    save();
    writeFileSync(join(state, 'plugins.json'), JSON.stringify({ plugins: [join(root, 'examples/screen-plugin.mjs')] }));
    for (const name of ['claude', 'repl']) { report.sessions[name] = JSON.parse((await cli(['launch', '--cwd', work])).out).id; save(); }
    console.log(JSON.stringify(report, null, 2));
  } else {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (action === 'validate') {
      const file = join(report.work, 'tags.mjs');
      assert(existsSync(file), 'Claude must create tags.mjs');
      const { normalizeTags } = await import(pathToFileURL(file).href);
      const input = [' Foo ', '', 'foo', 'BAR', ' bar ', ' 中文 ', '中文', '\t'];
      const original = [...input];
      assert.deepEqual(normalizeTags(input), ['foo', 'bar', '中文']);
      assert.deepEqual(input, original);
      assert.deepEqual(normalizeTags([]), []);
      assert.deepEqual(normalizeTags(['\u3000A\u3000', 'a']), ['a']);
      for (const invalid of [null, 'foo', [1], ['ok', null], {}]) assert.throws(() => normalizeTags(invalid), TypeError);
      report.checks.push('Claude artifact independently passed normalization, ordering, Unicode whitespace, immutability and invalid-input acceptance');
      save(); console.log(report.checks.at(-1));
    } else if (action === 'finish') {
      for (const id of Object.values(report.sessions)) { try { await cli(['close', id.slice(0, 8)]); } catch {} }
      save(); console.log(reportPath);
    } else {
      const id = report.sessions[target]?.slice(0, 8);
      if (!id) throw Error('Target must be claude or repl');
      const result = await cli([action, id, ...args]);
      if (action === 'capture') { report.captures.push({ target, at: new Date().toISOString(), output: result.out }); save(); }
      else { (report.operations ??= []).push({ action, target, args, code: result.code, output: result.out }); save(); }
      process.stdout.write(result.out); process.exitCode = result.code;
    }
  }
} catch (error) { console.error(error); process.exitCode = 1; }
