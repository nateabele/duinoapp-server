const test = require('node:test');
const assert = require('node:assert');
const { decide } = require('../setup/stamp');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-01-10T00:00:00Z');
const stamp = { hash: 'abc', completedAt: new Date(now - 2 * DAY).toISOString() };
const base = {
  stamp, hash: 'abc', now, outputsExist: true,
};

test('skips when the hash matches, outputs exist and data is fresh', () => {
  assert.strictEqual(decide(base).skip, true);
});

test('runs when there is no stamp', () => {
  assert.strictEqual(decide({ ...base, stamp: null }).skip, false);
});

test('runs when the inputs changed', () => {
  assert.match(decide({ ...base, hash: 'def' }).reason, /inputs changed/);
});

test('runs when an output file is missing', () => {
  assert.match(decide({ ...base, outputsExist: false }).reason, /missing/);
});

test('runs when forced', () => {
  assert.strictEqual(decide({ ...base, force: true }).skip, false);
});

test('runs when the data is older than the max age', () => {
  assert.strictEqual(decide({ ...base, maxAgeDays: 1 }).skip, false);
  assert.strictEqual(decide({ ...base, maxAgeDays: 3 }).skip, true);
  assert.strictEqual(decide({ ...base, maxAgeDays: 0 }).skip, false);
});

test('runs when the stamp timestamp is unreadable or in the future', () => {
  assert.strictEqual(decide({ ...base, stamp: { hash: 'abc', completedAt: 'nope' } }).skip, false);
  assert.strictEqual(decide({ ...base, stamp: { hash: 'abc', completedAt: new Date(now + DAY).toISOString() } }).skip, false);
});
