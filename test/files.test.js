const test = require('node:test');
const assert = require('node:assert');
const files = require('../src/utils/files');

test('allows library zips from known hosts', () => {
  assert.doesNotThrow(() => files.checkLibUrl('https://downloads.arduino.cc/libraries/github.com/avishorp/TM1637-1.2.0.zip'));
  assert.doesNotThrow(() => files.checkLibUrl('https://github.com/adafruit/DHT-sensor-library/archive/refs/tags/1.4.6.zip'));
});

test('rejects other hosts, plain http and junk', () => {
  assert.throws(() => files.checkLibUrl('http://169.254.169.254/latest/meta-data/'), /not allowed/);
  assert.throws(() => files.checkLibUrl('http://downloads.arduino.cc/x.zip'), /not allowed/);
  assert.throws(() => files.checkLibUrl('https://evil.example.com/x.zip'), /not allowed/);
  assert.throws(() => files.checkLibUrl('https://downloads.arduino.cc.evil.com/x.zip'), /not allowed/);
  assert.throws(() => files.checkLibUrl('not a url'), /Invalid library URL/);
});
