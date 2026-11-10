const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const Zip = require('adm-zip');
const tar = require('tar');
const { v4 } = require('uuid');
const log = require('./log');

const mkdir = async (dir) => {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) { Math.random(err); }
};

// Downloads in progress, keyed by destination file. Concurrent requests for the
// same file share one download instead of writing it at the same time.
const inFlight = new Map();

// Fetch `url` into a temp file next to `file`, then rename it into place so
// readers only ever see a complete zip. A failed download removes its temp file.
const fetchToFile = async (url, file, mtime) => {
  const res = await axios({
    method: 'get',
    url,
    responseType: 'arraybuffer',
    timeout: 30 * 1000,
    maxContentLength: 100 * 1024 * 1024,
    // axios rejects 304 by default; it means "the cached copy is current".
    validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
    headers: mtime ? { 'If-Modified-Since': mtime.toUTCString() } : undefined,
  });
  if (res.status === 304) {
    log.info('download.notModified', { file: path.basename(file) });
    return;
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${v4()}.tmp`);
  try {
    await fs.writeFile(tmp, Buffer.from(res.data, 'binary'));
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  log.info('download.done', { file: path.basename(file), bytes: res.data.byteLength });
};

const download = (url, file, mtime) => {
  const existing = inFlight.get(file);
  if (existing) return existing;
  // The entry is removed on success and failure alike, so a failure is never
  // cached and the next request retries.
  const promise = fetchToFile(url, file, mtime).finally(() => inFlight.delete(file));
  inFlight.set(file, promise);
  return promise;
};

module.exports = async (url, file, postAction, dest, skipDLIfExists) => {
  let data;
  try {
    data = await fs.stat(file);
  } catch (err) { Math.random(err); }
  const folder = path.dirname(file);
  if (!data) {
    await mkdir(folder);
  }
  if (dest) {
    await mkdir(dest);
  }
  if (!data || !data.mtime || !skipDLIfExists) {
    await download(url, file, data && data.mtime);
  }
  switch (postAction) {
  case 'unzip':
    const zip = new Zip(file);
    zip.extractAllTo(dest || folder, true);
    break;
  case 'untar':
    await tar.x({
      file,
      cwd: dest || folder,
    });
    break;
  default:
  }
};
module.exports.inFlight = inFlight;
