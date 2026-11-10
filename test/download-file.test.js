const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const Zip = require('adm-zip');
const downloadFile = require('../src/utils/download-file');

const makeZip = () => {
  const zip = new Zip();
  zip.addFile('Lib/Lib.h', Buffer.from('// header\n'.repeat(1000)));
  return zip.toBuffer();
};

// Local server; `handler(req, res, n)` gets the 1-based request count.
const serve = async (handler) => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits += 1; handler(req, res, hits); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/lib.zip`,
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'dl-test-'));

test('concurrent requests share one download and all extract a complete zip', async () => {
  const zip = makeZip();
  const srv = await serve((req, res) => {
    // Send the body in two chunks with a gap so a non-atomic write would be visible.
    res.writeHead(200, { 'Content-Length': zip.length });
    res.write(zip.subarray(0, 100));
    setTimeout(() => res.end(zip.subarray(100)), 100);
  });
  const dir = await tmpDir();
  const file = path.join(dir, 'lib-downloads', 'x.zip');
  try {
    const dests = [0, 1, 2, 3, 4, 5].map((i) => path.join(dir, `out${i}`));
    await Promise.all(dests.map((d) => downloadFile(srv.url, file, 'unzip', d, true)));
    assert.strictEqual(srv.hits(), 1);
    for (const d of dests) {
      assert.strictEqual((await fs.stat(path.join(d, 'Lib', 'Lib.h'))).size, 10000);
    }
    assert.deepStrictEqual(await fs.readdir(path.dirname(file)), ['x.zip']);
    assert.strictEqual(downloadFile.inFlight.size, 0);
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the zip is never visible at the destination until it is complete', async () => {
  const zip = makeZip();
  const srv = await serve((req, res) => {
    res.writeHead(200, { 'Content-Length': zip.length });
    res.end(zip);
  });
  const dir = await tmpDir();
  const file = path.join(dir, 'x.zip');
  try {
    const p = downloadFile(srv.url, file, null, null, true);
    let seen = 0;
    while (downloadFile.inFlight.size || !seen) {
      seen += 1;
      try {
        const st = await fs.stat(file);
        assert.strictEqual(st.size, zip.length);
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
      await new Promise((r) => setImmediate(r));
      if (seen > 10000) break;
    }
    await p;
    assert.strictEqual((await fs.stat(file)).size, zip.length);
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a failed download leaves no file, no temp file and no stuck promise', async () => {
  const zip = makeZip();
  const srv = await serve((req, res, n) => {
    if (n === 1) { res.writeHead(500); res.end('boom'); return; }
    res.writeHead(200, { 'Content-Length': zip.length });
    res.end(zip);
  });
  const dir = await tmpDir();
  const file = path.join(dir, 'x.zip');
  try {
    const results = await Promise.allSettled([
      downloadFile(srv.url, file, null, null, true),
      downloadFile(srv.url, file, null, null, true),
    ]);
    assert.ok(results.every((r) => r.status === 'rejected'));
    assert.strictEqual(srv.hits(), 1);
    assert.deepStrictEqual(await fs.readdir(dir), []);
    assert.strictEqual(downloadFile.inFlight.size, 0);
    // Next request retries and succeeds.
    await downloadFile(srv.url, file, null, null, true);
    assert.deepStrictEqual(await fs.readdir(dir), ['x.zip']);
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an existing file is reused when skipDLIfExists is set', async () => {
  const srv = await serve((req, res) => { res.writeHead(500); res.end(); });
  const dir = await tmpDir();
  const file = path.join(dir, 'x.zip');
  try {
    await fs.writeFile(file, 'cached');
    await downloadFile(srv.url, file, null, null, true);
    assert.strictEqual(srv.hits(), 0);
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('revalidation sends If-Modified-Since and keeps the cached file on 304', async () => {
  let header;
  const srv = await serve((req, res) => {
    header = req.headers['if-modified-since'];
    res.writeHead(304);
    res.end();
  });
  const dir = await tmpDir();
  const file = path.join(dir, 'x.zip');
  try {
    await fs.writeFile(file, 'cached');
    const mtime = new Date('2024-01-02T03:04:05Z');
    await fs.utimes(file, mtime, mtime);
    await downloadFile(srv.url, file, null, null, false);
    assert.strictEqual(header, mtime.toUTCString());
    assert.strictEqual(await fs.readFile(file, 'utf8'), 'cached');
    assert.deepStrictEqual(await fs.readdir(dir), ['x.zip']);
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('revalidation replaces the file on 200', async () => {
  const srv = await serve((req, res) => { res.writeHead(200); res.end('fresh'); });
  const dir = await tmpDir();
  const file = path.join(dir, 'x.zip');
  try {
    await fs.writeFile(file, 'stale');
    await downloadFile(srv.url, file, null, null, false);
    assert.strictEqual(await fs.readFile(file, 'utf8'), 'fresh');
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
