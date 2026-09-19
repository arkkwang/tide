/** Self-contained smoke tests for src/watch.ts. Run with `npm test`. */
import { lastUserUtterance, type Utterance } from "./watch.js";

const RESUME = "继续刚才的任务。先检查当前状态和上次做到哪里，再继续执行。";

const cases: Array<{ name: string; run: () => void }> = [];

function test(name: string, run: () => void): void {
  cases.push({ name, run });
}

function eq<T>(actual: T, expected: T, name: string): void {
  if (actual === expected) return;
  throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function arr(items: Array<string | null>): Utterance[] {
  return items.filter((t): t is string => t !== null).map((text) => ({ text }));
}

// --- lastUserUtterance: spoken is newest-first, so index 0 is the latest human prompt ---

test("returns the first (newest) utterance when none match resumePrompt", () => {
  const spoken = arr(["新", "中", "旧"]);
  eq(lastUserUtterance(spoken, RESUME)?.text, "新", "newest-first[0]");
});

test("skips a leading resumePrompt and returns the next entry", () => {
  const spoken = arr([RESUME, "新", "旧"]);
  eq(lastUserUtterance(spoken, RESUME)?.text, "新", "skip-leading-resume");
});

test("skips consecutive resumePrompt entries", () => {
  const spoken = arr([RESUME, RESUME, "实际最近的一条"]);
  eq(lastUserUtterance(spoken, RESUME)?.text, "实际最近的一条", "skip-multiple-resume");
});

test("returns null when every entry is resumePrompt", () => {
  const spoken = arr([RESUME, RESUME]);
  eq(lastUserUtterance(spoken, RESUME), null, "all-resume");
});

test("returns null when spoken is undefined", () => {
  eq(lastUserUtterance(undefined, RESUME), null, "undefined-spoken");
});

test("returns null when spoken is empty", () => {
  eq(lastUserUtterance([], RESUME), null, "empty-spoken");
});

test("treats a single non-resume entry as the latest", () => {
  const spoken = arr(["only"]);
  eq(lastUserUtterance(spoken, RESUME)?.text, "only", "single-entry");
});

// --- run ---

let failed = 0;
for (const { name, run } of cases) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n     ${(err as Error).message}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\nall ${cases.length} tests passed`);
