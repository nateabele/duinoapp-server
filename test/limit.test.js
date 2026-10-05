const test = require('node:test');
const assert = require('node:assert');
const limit = require('../src/utils/limit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('runs at most `max` tasks at once', async () => {
  const run = limit({ max: 2, queueTimeout: 1000 });
  let active = 0;
  let peak = 0;
  const task = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(20);
    active -= 1;
  };
  await Promise.all(Array.from({ length: 6 }, () => run(task)));
  assert.strictEqual(peak, 2);
});

test('rejects a queued task that cannot start in time', async () => {
  const run = limit({ max: 1, queueTimeout: 30 });
  const slow = run(() => sleep(100));
  await assert.rejects(run(() => 'never'), /busy/);
  await slow;
});

test('a failing task frees its slot', async () => {
  const run = limit({ max: 1, queueTimeout: 1000 });
  await assert.rejects(run(async () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(await run(async () => 'ok'), 'ok');
  assert.deepStrictEqual(run.stats(), { active: 0, queued: 0, max: 1 });
});
