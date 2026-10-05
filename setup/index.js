/* eslint-disable no-console */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs').promises;
const _ = require('lodash');
const tar = require('tar');
const YAML = require('yaml');
const config = require('../src/config');
const downloadFile = require('../src/utils/download-file');
const processData = require('./process-data');
const versions = require('./versions.json');

const cli = (commands, args, { consoleLog = false, json = true } = {}) => new Promise((resolve, reject) => {
  let res = '';
  const exec = spawn(config.cliPath, [
    ...(Array.isArray(commands) ? commands : commands.split('.')),
    ...(Array.isArray(args) ? args : [args]).map((arg) => `${`${arg}`.replace(/"/g, '')}`),
    '--config-file', config.cliConfigPath,
    ...(json ? ['--format', 'json'] : []),
  ], { cwd: config.dataDir, env: config.cliEnv() });

  const log = (data) => {
    if (consoleLog) process.stdout.write(data.toString('utf-8'));
    res += data.toString('utf-8');
  };
  exec.stdout.on('data', log);
  exec.stderr.on('data', log);
  exec.on('error', reject);
  exec.on('close', (code) => (code ? reject(new Error(`arduino-cli ${[].concat(commands).join(' ')} exited ${code}:\n${res}`)) : resolve(res)));
});

// Cores to install: CORES env (comma-separated ids) or every core pinned in versions.json.
const coreVersions = () => {
  const wanted = process.env.CORES
    ? process.env.CORES.split(',').map((s) => s.trim()).filter(Boolean)
    : Object.keys(versions.cores);
  return wanted.reduce((a, id) => {
    if (!versions.cores[id]) throw new Error(`Core ${id} has no pinned version in setup/versions.json`);
    return { ...a, [id]: versions.cores[id] };
  }, {});
};

const sha256 = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

const loadCli = async () => {
  const { version, assets } = versions.arduinoCli;
  const platform = `${process.platform}-${process.arch}`;
  const asset = assets[platform];
  if (!asset) throw new Error(`No pinned arduino-cli build for ${platform}`);

  await fs.mkdir(config.dataDir, { recursive: true });
  const installed = await cli('version', [], { json: true }).then(JSON.parse).catch(() => null);
  if (installed && installed.VersionString === version) {
    console.log(`arduino-cli ${version} already installed`);
  } else {
    const tarball = config.dataPath(asset.file);
    await downloadFile(`https://github.com/arduino/arduino-cli/releases/download/v${version}/${asset.file}`, tarball);
    const actual = await sha256(tarball);
    if (actual !== asset.sha256) {
      await fs.rm(tarball, { force: true });
      throw new Error(`Checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${actual}`);
    }
    await tar.x({ file: tarball, cwd: config.dataDir });
    await fs.rm(tarball, { force: true });
    console.log(`Installed arduino-cli ${version} (${platform}, sha256 verified)`);
  }

  // arduino-cli 0.35 reads `directories.*`; the old top-level `arduino_data`
  // key is silently ignored, so write the config it actually understands.
  await fs.writeFile(config.cliConfigPath, YAML.stringify({
    board_manager: { additional_urls: versions.boardManagerUrls },
    directories: {
      data: config.dataPath('.arduino15'),
      downloads: config.dataPath('.arduino15', 'staging'),
      user: config.dataPath('Arduino'),
    },
    library: { enable_unsafe_install: false },
    metrics: { enabled: false },
    updater: { enable_notification: false },
  }));
};

// Refresh package/library indexes and dump the raw search results that
// process-data turns into the /v3/info payloads.
const loadIndexes = async () => {
  console.log('Updating core and library indexes');
  await cli('core.update-index', []);
  await fs.writeFile(config.dataPath('cores.json'), await cli('core.search', ['']));
  await cli('lib.update-index', []);
  await fs.writeFile(config.dataPath('libs.json'), await cli('lib.search', ['']));
};

const loadCores = async () => {
  const pinned = coreVersions();
  await Object.entries(pinned).reduce(async (a, [id, version]) => {
    await a;
    console.log(`Installing core ${id}@${version}`);
    await cli('core.install', `${id}@${version}`, { consoleLog: true, json: false });
  }, Promise.resolve());
};

const loadBoards = async () => {
  const response = JSON.parse(await cli('board.listall', []));
  console.log(`Compiling ${response.boards.length} board details...`);
  const boards = [];
  await _.chunk(response.boards, 10).reduce(async (a, boardChunk, i) => {
    await a;
    await Promise.all(boardChunk.map(async (board) => {
      // Some third-party boards ship broken definitions; skip them like before.
      const details = await cli('board.details', ['-b', board.fqbn, '--full'])
        .then(JSON.parse)
        .catch((err) => ({ error: err.message.split('\n').slice(1).join(' ').trim() }));
      if (!details.name) {
        console.log('Skipping', board.fqbn, details);
        return;
      }
      boards.push({
        fqbn: board.fqbn,
        ...details,
      });
    }));
    console.log(Math.min((i + 1) * 10, response.boards.length), response.boards.length);
  }, Promise.resolve());
  await fs.writeFile(config.dataPath('boards.json'), JSON.stringify(boards, null, 2));
};

const loadLibs = async () => {
  const libs = JSON.parse(await fs.readFile(config.dataPath('libs.json'), 'utf-8')).libraries;
  return libs.reduce(async (a, lib, i) => {
    await a;
    console.log(`Libs (${i + 1}/${libs.length}) Installing ${lib.name}`);
    await cli('lib.install', lib.name, { consoleLog: true });
  }, Promise.resolve());
};

module.exports = {
  loadCli,
  loadIndexes,
  loadCores,
  loadBoards,
  loadLibs,
  coreVersions,
  processData: () => processData(coreVersions()),
};
