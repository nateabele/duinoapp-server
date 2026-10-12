/* eslint-disable no-param-reassign */
const fs = require('fs').promises;
const net = require('net');
const cli = require('../utils/arduino-exec');
const tmpFiles = require('../utils/files');
const json = require('../utils/json');
const config = require('../config');
const limit = require('../utils/limit');
const log = require('../utils/log');

const compileSlot = limit({ max: config.maxConcurrentCompiles, queueTimeout: config.compileQueueTimeout });

// Compiles and uploads in progress, so a crash or shutdown can log what was running.
const inFlight = new Map();
let lastJobId = 0;
const newJobId = () => { lastJobId += 1; return lastJobId; };

// Request bodies come from clients; describe them without trusting their shape.
const describe = (opts) => {
  const o = opts && typeof opts === 'object' ? opts : {};
  const files = Array.isArray(o.files) ? o.files : [];
  return {
    fqbn: typeof o.fqbn === 'string' ? o.fqbn : typeof o.fqbn,
    files: files.length,
    bytes: files.reduce((n, f) => n + (f && typeof f.content === 'string' ? f.content.length : 0), 0),
    libs: Array.isArray(o.libs) ? o.libs.map((l) => l && l.name).join(',') : undefined,
  };
};


const program = {

  randId: () => Math.random().toString(16).substr(2),

  getError: (res) => {
    let error;
    try {
      error = JSON.parse(res.split('\n').pop());
    } catch (err) {
      return {};
    }
    if (error && error.Cause) return { error };
    return {};
  },

  compileStats: () => compileSlot.stats(),

  inFlight: () => [...inFlight.values()].map((job) => ({ ...job, ageMs: Date.now() - job.since })),

  // Never leave a caller hanging: any failure becomes an error response.
  // `meta` ({ via, ip }) only labels the log lines.
  compile: async (opts, socket, done, meta = {}) => {
    const job = {
      id: newJobId(), kind: 'compile', state: 'queued', since: Date.now(), ...meta, ...describe(opts),
    };
    inFlight.set(job.id, job);
    log.info('compile.queued', {
      ...job, kind: undefined, state: undefined, since: undefined, ...compileSlot.stats(),
    });
    let response;
    let started;
    try {
      response = await compileSlot(() => {
        started = Date.now();
        job.state = 'running';
        return program.compileUnsafe(opts, socket);
      });
    } catch (err) {
      log.error('compile.failed', { id: job.id }, err);
      response = { error: { Cause: err.message, Message: err.message }, log: err.message };
    }
    inFlight.delete(job.id);
    const end = Date.now();
    log.info('compile.done', {
      id: job.id,
      ok: !response.error && (!!response.hex || !!response.files),
      waitMs: (started || end) - job.since,
      runMs: started ? end - started : undefined,
      error: response.error && response.error.Message && response.error.Message.slice(0, 200),
    });
    if (done) done(response);
    return response;
  },

  compileUnsafe: async ({
    fqbn, files, noHex = false, flags = {}, libs = [],
  }, socket) => {
    await tmpFiles.loadTempFiles(files, socket);
    const libRes = await tmpFiles.loadTempLibs(libs, socket);
    const res = await cli('compile', [
      ...(flags.verbose ? ['-v'] : []),
      '--warnings', 'all',
      '--fqbn', fqbn,
      '--libraries', socket.libPath,
      ...(!noHex ? ['--output-dir', `${socket.sketchPath}/output`] : []),
      socket.sketchPath,
    ], socket, { noJson: true });
    const response = program.getError(res);
    if (!response.error && !noHex) {
      const ref = socket.sketchPath.split('/').pop();
      if (fqbn.indexOf('esp') !== 0) {
        try {
          const hex = await fs.readFile(`${socket.sketchPath}/output/${ref}.ino.hex`, 'base64');
          response.hex = hex;
        } catch (err) {
          console.error(err);
        }
      } else if (fqbn.indexOf('esp8266') === 0) {
        try {
          const bin = await fs.readFile(`${socket.sketchPath}/output/${ref}.ino.bin`, 'base64');
          response.files = [{ data: bin, address: 0 }];
        } catch (err) {
          console.error(err);
        }
      } else if (fqbn.indexOf('esp32') === 0) {
        const boards = await json.loadLargeData('boards');
        const baseFqbn = fqbn.split(':').slice(0, 3).join(':');
        const board = boards.find((b) => b.fqbn === baseFqbn);
        if (board) {
          const flashFreq = `${
            (fqbn.split(':').find((part) => part.includes('FlashFreq=')) || '').replace('FlashFreq=', '')
            || (board.config_options.find((o) => o.option === 'FlashFreq')
              || { values: [{ selected: true, value: '' }] }).values.find((v) => v.selected).value
            || board.properties.build.flash_freq
          }m`.replace('mm', 'm');
          const flashMode = (fqbn.split(':').find((part) => part.includes('FlashMode=')) || '').replace('FlashMode=', '')
            || (board.config_options.find((o) => o.option === 'FlashMode')
              || { values: [{ selected: true, value: '' }] }).values.find((v) => v.selected).value
            || board.properties.build.boot;
          const esp32Path = config.dataPath('.arduino15/packages/esp32/hardware/esp32');
          const [version] = await fs.readdir(esp32Path);
          const espToolsPath = `${esp32Path}/${version}/tools`;
          try {
            const appBin = await fs.readFile(`${socket.sketchPath}/output/${ref}.ino.bin`, 'base64');
            const partBin = await fs.readFile(`${socket.sketchPath}/output/${ref}.ino.partitions.bin`, 'base64');
            const app0Bin = await fs.readFile(`${espToolsPath}/partitions/boot_app0.bin`, 'base64');
            const bootBin = await fs.readFile(`${socket.sketchPath}/output/${ref}.ino.bootloader.bin`, 'base64');
            response.files = [
              { data: app0Bin, address: 0xe000 },
              { data: bootBin, address: Number(board.properties.build.bootloader_addr) || 0x1000 },
              { data: appBin, address: 0x10000 },
              { data: partBin, address: 0x8000 },
            ];
            response.flash_freq = flashFreq;
            response.flash_mode = flashMode;
          } catch (err) {
            console.error(err);
          }
        }
      }
    }
    response.log = libRes + res;
    // strip the sketch path from the log
    response.log = response.log.replaceAll(socket.sketchPath, '');
    // tmpFiles.cleanup(socket);
    return response;
  },

  upload: async ({ id = program.randId(), fqbn, flags = {} }, socket, done, meta = {}) => {
    if (socket.uploading) return { Message: 'Already uploading, please hold.', Cause: 'Upload already initiated.' };
    socket.uploading = id;
    socket.emit('upload.id', id);
    const job = {
      id: newJobId(), kind: 'upload', uploadId: id, state: 'running', since: Date.now(), ...meta, fqbn,
    };
    inFlight.set(job.id, job);
    log.info('upload.start', job);
    // await tmpFiles.loadTempFiles(files, socket);

    const sock = net.createServer((stream) => {
      // A reset connection emits 'error'; unhandled, it would crash the process.
      stream.on('error', (err) => log.error('upload.stream.error', { id: job.id }, err));
      stream.on('data', (buff) => {
        socket.emit(`upload.dataDown.${id}`, buff);
      });
      stream.on('end', () => {
        sock.close();
      });

      socket.on(`upload.dataUp.${id}`, (buff) => { if (!stream.destroyed) stream.write(buff); });
    });
    sock.on('error', (err) => log.error('upload.proxy.error', { id: job.id }, err));

    // Port 0 lets the OS pick a free port; a random fixed port can collide with
    // another upload. Loopback only: arduino-cli is the only client.
    const port = await new Promise((resolve, reject) => {
      sock.once('error', reject);
      sock.listen(0, '127.0.0.1', () => resolve(sock.address().port));
    }).catch((err) => {
      socket.uploading = null;
      inFlight.delete(job.id);
      throw err;
    });

    const res = await cli('upload', [
      '-p', `net:localhost:${port}`,
      ...(flags.verbose ? ['-v'] : []),
      ...(flags.programmer ? ['-P', flags.programmer] : []),
      '--fqbn', fqbn,
      socket.sketchPath,
    ], socket, { noJson: true });

    sock.close();
    socket.uploading = null;
    inFlight.delete(job.id);
    const response = program.getError(res);
    log.info('upload.done', {
      id: job.id, ms: Date.now() - job.since, error: response.error && response.error.Message,
    });
    // tmpFiles.cleanup(socket);
    if (done) done(response);
    return response;
  },

  legacyCompile: (opts) => compileSlot(() => program.legacyCompileUnsafe(opts)),

  legacyCompileUnsafe: async ({ fqbn, content }) => {
    const session = {};
    const files = [{ name: 'legacy/legacy.ino', content }];
    await tmpFiles.loadTempFiles(files, session);
    const res = await cli('compile', [
      '-v',
      '--warnings',
      'all',
      '--fqbn',
      fqbn,
      '--output-dir',
      `${session.sketchPath}/legacy`,
      session.sketchPath,
    ], null, { noJson: true });
    const response = program.getError(res);
    if (response.error) {
      return {
        success: false,
        msg: response.error.Cause,
        code: response.error.Code,
        stdout: '',
        stderr: res,
      };
    }
    const ref = session.sketchPath.split('/').pop();
    const hex = await fs.readFile(`${session.sketchPath}/legacy/${ref}.ino.hex`, 'base64');
    tmpFiles.cleanup(session);
    return {
      success: true,
      hex,
      stdout: res,
      stderr: '',
    };
  },

};

module.exports = program;
