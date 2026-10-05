const { spawn } = require('child_process');
const config = require('../config');

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
  const timer = setTimeout(() => {
    log(`\nError: arduino-cli timed out after ${config.cliTimeout / 1000}s\n`);
    exec.kill('SIGKILL');
  }, config.cliTimeout);
  exec.stdout.on('data', (data) => log(data));
  exec.stderr.on('data', (data) => log(data));

  exec.on('error', (err) => log(`\nError: ${err.message}\n`));
  exec.on('close', () => {
    clearTimeout(timer);
    resolve(res);
  });
});
