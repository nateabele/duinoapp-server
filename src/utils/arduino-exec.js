const { spawn } = require('child_process');
const config = require('../config');
const logger = require('./log');

module.exports = (commands, args, socket, options) => new Promise((resolve) => {
  const opts = {
    emit: !!socket,
    ...options,
  };
  let res = '';
  const log = (data) => {
    res += data.toString('utf-8');
    // console.log(data.toString('utf-8'));
    if (opts.emit && socket.emit) socket.emit('console.log', data.toString('utf-8'));
  };
  let cliArgs = process.env.CLI_ARGS || `--config-file ${config.cliConfigPath} --format json`;
  if (opts.noJson) cliArgs = cliArgs.replace(' --format json', '');

  const exec = spawn(config.cliPath, [
    ...(Array.isArray(commands) ? commands : commands.split('.')),
    ...(Array.isArray(args) ? args : [args]).map((arg) => `${`${arg}`.replace(/"/g, '')}`),
    ...(cliArgs).split(' '),
  ], {
    cwd: socket && socket.tmpDir ? socket.tmpDir.path : `${__dirname}/../../`,
    env: config.cliEnv(),
  });
  const started = Date.now();
  const command = Array.isArray(commands) ? commands.join('.') : commands;
  const timer = setTimeout(() => {
    log(`\nError: arduino-cli timed out after ${config.cliTimeout / 1000}s\n`);
    logger.error('cli.timeout', { command, pid: exec.pid, ms: Date.now() - started });
    exec.kill('SIGKILL');
  }, config.cliTimeout);
  exec.stdout.on('data', (data) => log(data));
  exec.stderr.on('data', (data) => log(data));

  exec.on('error', (err) => {
    log(`\nError: ${err.message}\n`);
    logger.error('cli.spawn.error', { command }, err);
  });
  exec.on('close', (code, signal) => {
    clearTimeout(timer);
    // A signal here means something killed the child (timeout above, or the
    // kernel OOM killer when the service hits MemoryMax).
    if (signal) {
      logger.error('cli.killed', {
        command, pid: exec.pid, signal, ms: Date.now() - started,
      });
    }
    resolve(res);
  });
});
