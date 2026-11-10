const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const program = require('../src/actions/program');

test('upload proxy is off by default', () => {
  assert.strictEqual(config.uploadProxyEnabled, false);
});

test('upload.start answers the ack with an error and does not start an upload', async () => {
  const emitted = [];
  const socket = { emit: (...args) => emitted.push(args), on: () => assert.fail('listener registered') };
  let acked;
  const res = await program.upload({ fqbn: 'arduino:avr:uno' }, socket, (r) => { acked = r; });
  assert.match(acked.error.Message, /disabled/);
  assert.match(acked.error.Cause, /UPLOAD_PROXY_ENABLED/);
  assert.strictEqual(res, acked);
  assert.strictEqual(socket.uploading, undefined);
  assert.deepStrictEqual(emitted, []);
  assert.strictEqual(program.inFlight().length, 0);
});

test('upload.start tolerates a missing ack and payload', async () => {
  const res = await program.upload(undefined, { emit: () => {} }, undefined);
  assert.ok(res.error);
});
