/* eslint-disable no-param-reassign */
const fs = require('fs').promises;
const path = require('path');
const tmp = require('tmp-promise');
const { v3 } = require('uuid');
const Zip = require('adm-zip');
const downloadFile = require('./download-file');

const libNS = '404e901a-0521-47f5-8fcf-74f7f7a1dfc9';
const libDownloadPath = '/mnt/duino-data/lib-downloads';
const libExtractedPath = '/mnt/duino-data/lib-extracted';

const files = {

  checkPath: (filepath, socket, sub = '') => {
    if (filepath.indexOf(path.join(socket.tmpDir.path, sub)) !== 0) {
      const msg = `Security error, path "${filepath}" went out of bounds.`;
      socket.emit('console.error', msg);
      throw new Error(msg);
    }
  },

  _initTmp: async () => {
    const tmpDir = await tmp.dir({ prefix: 'duino-', unsafeCleanup: true });
    return tmpDir;
  },

  cleanup: (socket) => {
    if (socket.tmpDir) {
      socket.tmpDir.cleanup();
      delete socket.tmpDir;
    }
  },

  loadTempFiles: async (fileItems, socket, sub = '', done) => {
    if (typeof sub !== 'string') {
      done = sub;
      sub = '';
    }
    // eslint-disable-next-line no-param-reassign
    socket.tmpDir = socket.tmpDir || await files._initTmp();
    // const id = socket.tmpDir.path.split('/').pop();
    await Promise.all(fileItems.map(async (file) => {
      const filepath = path.join(socket.tmpDir.path, sub, file.name);
      files.checkPath(filepath, socket, sub);
      const parts = filepath.split('/');
      parts.pop();
      const folder = parts.join('/');
      try {
        await fs.mkdir(folder, { recursive: true });
      } catch (err) { console.error(err); }
      await fs.writeFile(filepath, file.content);
      if (/.ino$/.test(file.name)) socket.sketchPath = folder;
    }));
    if (done) done();
  },

  libPath: (url) => path.join(libDownloadPath, `${v3(url, libNS)}.zip`),

  loadTempLibs: async (libs, socket, done) => {
    const libPath = path.join(socket.tmpDir.path, 'libraries');
    await fs.mkdir(libPath, { recursive: true });
    const results = await Promise.all(libs.map(async (lib) => {
      const filePath = files.libPath(lib.url);
      const extractId = v3(lib.url, libNS);
      const extractDir = path.join(libExtractedPath, extractId);
      console.log(lib.url, filePath, extractDir);
      try {
        // Download ZIP if not already cached (no extraction here)
        await downloadFile(lib.url, filePath, null, null, true);

        // Extract to persistent cache only if not already extracted
        let needsExtract = false;
        try {
          await fs.access(extractDir);
        } catch {
          needsExtract = true;
        }
        if (needsExtract) {
          await fs.mkdir(extractDir, { recursive: true });
          const zip = new Zip(filePath);
          zip.extractAllTo(extractDir, true);
        }

        // Symlink each library subdirectory into the per-compile library path
        const entries = await fs.readdir(extractDir);
        for (const entry of entries) {
          const versionMatch = entry.match(/^(.+)-\d+\.\d+\.\d+$/);
          const targetName = versionMatch ? versionMatch[1] : entry;
          const source = path.join(extractDir, entry);
          const link = path.join(libPath, targetName);
          try {
            await fs.access(link);
          } catch {
            await fs.symlink(source, link);
          }
        }
      } catch (err) {
        return err;
      }
      return null;
    }));
    socket.libPath = libPath;
    const res = `${libs
      .map((lib, i) => `Installing ${lib.name}..... ${results[i] ? `Failed: ${results[i].message}` : 'Success'}\r\n`)
      .join('')}${libs.length ? '\r\n' : ''}`;
    if (done) done(res);
    return res;
  },
};

module.exports = files;
