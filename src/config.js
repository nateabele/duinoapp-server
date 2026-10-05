require('dotenv').config();
const os = require('os');
const path = require('path');

// All runtime state (arduino-cli, cores, indexes, processed data, library cache)
// lives under DATA_DIR. The Docker image sets DATA_DIR=/mnt/duino-data.
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

const list = (value, fallback) => (value || fallback)
  .split(',').map((s) => s.trim()).filter(Boolean);

module.exports = {
  dataDir,
  dataPath: (...parts) => path.join(dataDir, ...parts),
  cliPath: path.join(dataDir, 'arduino-cli'),
  cliConfigPath: path.join(dataDir, 'arduino-cli.yml'),
  libDownloadPath: path.join(dataDir, 'lib-downloads'),

  // Environment for arduino-cli child processes. TMPDIR matters on macOS,
  // where the build fails without the per-user temp dir.
  cliEnv: () => ({
    HOME: dataDir,
    PATH: process.env.PATH,
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  }),

  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT) || 3030,

  // Compiles are CPU and memory heavy; queue anything beyond this many at once.
  maxConcurrentCompiles: Number(process.env.MAX_CONCURRENT_COMPILES) || os.cpus().length,
  // Give up on a queued compile if it can't start within this many ms.
  compileQueueTimeout: Number(process.env.COMPILE_QUEUE_TIMEOUT_MS) || 60 * 1000,
  // Kill a single arduino-cli invocation that runs longer than this.
  cliTimeout: Number(process.env.CLI_TIMEOUT_MS) || 120 * 1000,

  // Library zips may only be fetched from these hosts.
  libAllowedHosts: list(
    process.env.LIB_ALLOWED_HOSTS,
    'downloads.arduino.cc,github.com,codeload.github.com,objects.githubusercontent.com,raw.githubusercontent.com',
  ),
};
