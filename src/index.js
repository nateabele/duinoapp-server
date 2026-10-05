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
      console.error(err);
      if (typeof done === 'function') done({ error: { Cause: err.message, Message: err.message } });
    });
};
const send = (res) => (data) => {
  if (res.headersSent) return;
  res.status(data && data.error ? 500 : 200).json(data);
};

io.on('connection', async (socket) => {
  socket.on('info.server', safe((done) => info.server(socket, done)));
  socket.on('info.cores', safe((done) => info.cores(socket, done)));
  socket.on('info.libraries', safe((done) => info.libraries(socket, done)));
  socket.on('info.librariesSearch', safe((data, done) => info.librariesSearch(data, socket, done)));
  socket.on('info.boards', safe((done) => info.boards(socket, done)));

  socket.on('compile.start', (data, done) => program.compile(data, socket, done));
  socket.on('upload.start', safe((data, done) => program.upload(data, socket, done)));

  socket.on('disconnect', () => socket.tmpDir && socket.tmpDir.cleanup());

  socket.emit('ready');
});

io.of('/ping').on('connect', (socket) => {
  socket.on('p', safe((done) => info.server(socket, done)));
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
      console.error(err);
      res.status(500).json({ success: false, msg: err.message });
    }
  }
});

app.post('/v3/compile', (req, res) => {
  const socket = {};
  program.compile(req.body, socket, (data) => {
    res.json(data);
    if (socket.tmpDir) socket.tmpDir.cleanup();
  });
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

console.log(`🚀 Server Launched on http://${config.host}:${config.port} (data: ${config.dataDir})`);
module.exports = app;
