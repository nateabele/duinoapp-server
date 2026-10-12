const config = require('./config');
const http = require('http');
const socketio = require('socket.io');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const info = require('./actions/info');
const program = require('./actions/program');
const { libPath } = require('./utils/files');
const downloadFile = require('./utils/download-file');
const log = require('./utils/log');

// A rejected promise nobody awaited belongs to one request; log it rather than
// taking down every compile in flight. A synchronous uncaught exception may
// leave state broken, so exit and let systemd restart a clean process.
// Every exit path logs what was in flight, so the journal shows which requests
// were running when the process went down.
const state = () => ({ ...program.compileStats(), inFlight: program.inFlight() });
process.on('unhandledRejection', (err) => log.error('process.unhandledRejection', state(), err));
process.on('uncaughtException', (err) => {
  log.error('process.uncaughtException exiting', state(), err);
  // Lands in --report-directory (set by the systemd unit), else the cwd.
  try { log.info('process.report', { file: process.report.writeReport(err) }); } catch (e) { /* best effort */ }
  process.exit(1);
});
['SIGTERM', 'SIGINT'].forEach((signal) => process.on(signal, () => {
  log.info('process.signal exiting', { signal, ...state() });
  process.exit(0);
}));
process.on('exit', (code) => log.info('process.exit', { code }));

// Heartbeat: memory and load trend leading up to an OOM kill or a hang.
setInterval(() => {
  const mem = process.memoryUsage();
  log.info('process.heartbeat', {
    rssMB: Math.round(mem.rss / 1048576),
    heapMB: Math.round(mem.heapUsed / 1048576),
    ...program.compileStats(),
  });
}, 5 * 60 * 1000).unref();

const app = express();
const server = http.Server(app);
const io = socketio(server);
server.listen(config.port, config.host);

app.options('*', cors());
app.use(cors());
app.use(helmet());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Run an info/action handler so a thrown error still answers the caller
// instead of leaving the request (or socket ack) hanging.
const safe = (fn) => (...args) => {
  const done = args[args.length - 1];
  return Promise.resolve()
    .then(() => fn(...args))
    .catch((err) => {
      log.error('handler.error', {}, err);
      if (typeof done === 'function') done({ error: { Cause: err.message, Message: err.message } });
    });
};
// Socket.io passes whatever the client sent, so the ack slot (last parameter)
// may be missing or not a function. Calling a non-function ack from an async
// handler is an unhandled rejection, which kills the process.
const ack = (fn) => (...args) => {
  const params = args.slice(0, fn.length);
  const last = fn.length - 1;
  if (typeof params[last] !== 'function') params[last] = () => {};
  return safe(fn)(...params);
};
const send = (res) => (data) => {
  if (res.headersSent) return;
  res.status(data && data.error ? 500 : 200).json(data);
};

const socketMeta = (socket) => ({
  via: 'socket',
  ip: socket.handshake.headers['x-forwarded-for'] || socket.handshake.address,
});

io.on('connection', async (socket) => {
  socket.on('info.server', ack((done) => info.server(socket, done)));
  socket.on('info.cores', ack((done) => info.cores(socket, done)));
  socket.on('info.libraries', ack((done) => info.libraries(socket, done)));
  socket.on('info.librariesSearch', ack((data, done) => info.librariesSearch(data, socket, done)));
  socket.on('info.boards', ack((done) => info.boards(socket, done)));

  socket.on('compile.start', ack((data, done) => program.compile(data, socket, done, socketMeta(socket))));
  socket.on('upload.start', ack((data, done) => program.upload(data, socket, done, socketMeta(socket))));

  socket.on('disconnect', () => socket.tmpDir && socket.tmpDir.cleanup());

  socket.emit('ready');
});

io.of('/ping').on('connect', (socket) => {
  socket.on('p', ack((done) => info.server(socket, done)));
});

app.set('trust proxy', 1); // trust first proxy

app.get('/version', (req, res) => res.json({ version: '0.0.1', program: 'chromeduino' }));

app.get('/boards', (req, res) => safe(info.legacyBoards)(null, send(res)));

app.get('/libraries', (req, res) => safe(info.libraries)(null, send(res)));

app.post('/compile', async (req, res) => {
  if (typeof req.body.sketch !== 'string' || typeof req.body.board !== 'string') {
    res.json({ success: false, msg: 'invalid parameters passed' });
  } else {
    try {
      res.json(await program.legacyCompile({ fqbn: req.body.board, content: req.body.sketch }));
    } catch (err) {
      log.error('legacyCompile.error', { ip: req.ip }, err);
      res.status(500).json({ success: false, msg: err.message });
    }
  }
});

app.post('/v3/compile', (req, res) => {
  const socket = {};
  program.compile(req.body, socket, (data) => {
    res.json(data);
    if (socket.tmpDir) socket.tmpDir.cleanup();
  }, { via: 'http', ip: req.ip });
});
app.get('/healthz', (req, res) => res.json({ status: 'ok', compiles: program.compileStats() }));
app.get('/v3/info/server', (req, res) => {
  // res.setHeader('Cache-Control', 'public, max-age=86400');
  safe(info.server)(null, send(res));
});
app.get('/v3/info/cores', (req, res) => {
  safe(info.cores)(null, send(res));
});
app.get('/v3/info/boards', (req, res) => {
  safe(info.boards)(null, send(res));
});
app.get('/v3/info/boards.jsonl', (req, res) => {
  res.setHeader('Content-Type', 'application/jsonl');
  // cache for 1 day
  // res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(config.dataPath('boards-processed.jsonl'));
});
app.get('/v3/info/libraries', (req, res) => {
  safe(info.librariesSearch)(req.query, null, send(res));
});
app.get('/v3/info/libraries.jsonl', (req, res) => {
  res.setHeader('Content-Type', 'application/jsonl');
  // cache for 1 day
  // res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(config.dataPath('libs-processed.jsonl'));
});
app.post('/v3/libraries/cache', (req, res) => {
  const libs = Array.isArray(req.body.libs) ? req.body.libs : [];
  Promise.all(libs.map(async (lib) => {
    const filePath = libPath(lib.url);
    await downloadFile(lib.url, filePath, null, null, true);
  }))
    .then(() => res.status(204).send())
    .catch((err) => res.status(400).json({ error: { Cause: err.message, Message: err.message } }));
});

// Malformed bodies (bad JSON, too large): one log line and a 400, not a stack dump.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.info('http.badRequest', {
    method: req.method, path: req.path, ip: req.ip, status: err.status, error: err.message,
  });
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: { Cause: err.message, Message: err.message } });
});

log.info('process.start', {
  pid: process.pid,
  node: process.version,
  url: `http://${config.host}:${config.port}`,
  data: config.dataDir,
  maxConcurrent: config.maxConcurrentCompiles,
  queueTimeoutMs: config.compileQueueTimeout,
  cliTimeoutMs: config.cliTimeout,
});
module.exports = app;
