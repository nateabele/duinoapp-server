const fs = require('fs').promises;
const properties = require('properties');
const _ = require('lodash');
const json = require('../src/utils/json');
const config = require('../src/config');

// coreVersions: { 'arduino:avr': '1.8.7', ... } — the cores that were installed.
module.exports = async (coreVersions) => {
  console.log('Pre-Processing Data');
  const supportedCores = Object.keys(coreVersions);
  const cores = await json.parse(config.dataPath('cores.json'));
  const libs = await json.parse(config.dataPath('libs.json'));
  const boards = await json.parse(config.dataPath('boards.json'));

  const processFile = async (path) => {
    let file = await fs.readFile(path, 'utf8');
    // make boards.txt file compatible
    file = file.replace(/(\n\r)|(\n)|(\r)/g, '\n');
    file = file.split('\n').map((line) => {
      if (!line.includes('=')) return line;
      const key = line.replace(/=.*/, '=');
      let newLine = line;
      if (!/\.(upload\.\w+=|build\.(mcu|bootloader_addr|boot|flash_freq))/.test(key)) newLine = '';
      return newLine;
    }).join('\n');
    return properties.parse(file, { namespaces: true });
  };

  const lowerCaseKeys = (obj) => Object.keys(obj).reduce((a, i) => {
  // eslint-disable-next-line no-param-reassign
    a[i.toLowerCase()] = obj[i];
    return a;
  }, {});

  const processedLibs = libs.libraries.map((lib) => ({
    name: lib.name,
    ...(lib.latest || lib.releases[Object.keys(lib.releases).pop()]),
    urls: [
      ...(_.get(lib, 'latest.resources.url') ? [{ version: 'latest', url: _.get(lib, 'latest.resources.url') }] : []),
      ...[...Object.keys(lib.releases)]
        .reverse()
        .reduce((a, version) => {
          a.push({ version, url: _.get(lib.releases[version], 'resources.url') });
          return a;
        }, []),
    ],
  }));

  const processedCores = cores.map(lowerCaseKeys)
    .filter((c) => supportedCores.includes(c.id))
    .map((c) => ({ ...c, installed: coreVersions[c.id] }));

  let processedBoards = boards;
  await Promise.all(processedCores.map(async (core) => {
    const [pack, arch] = core.id.split(':');
    const path = config.dataPath(`.arduino15/packages/${pack}/hardware/${arch}/${core.installed}/boards.txt`);
    let props;
    try {
      props = await processFile(path);
    } catch (err) {
      if (!err.message.includes('no such file or directory')) throw err;
      props = await processFile(path.replace('arduino-beta', 'arduino'));
    }
    processedBoards = processedBoards.map((board) => (!board.fqbn.includes(`${core.id}:`) ? board : {
      ..._.omit(board, ['programmers', 'toolsDependencies']),
      properties: props[board.fqbn.split(':')[2]],
    }));
  }));

  const legacyBoards = {};
  processedBoards
    .filter((board) => board.fqbn.includes('arduino:avr'))
    .forEach((board) => {
      const cpuOpt = board.config_options && board.config_options.find((opt) => opt.option === 'cpu');
      if (cpuOpt) {
        cpuOpt.values.forEach((cpuVal) => {
          legacyBoards[`${board.fqbn}:cpu=${cpuVal.value}`] = {
            name: `${board.name} / ${cpuVal.value_label}`,
            upload_speed: board.properties.upload && board.properties.upload.speed,
          };
        });
      } else {
        legacyBoards[board.fqbn] = {
          name: board.name,
          upload_speed: board.properties.upload && board.properties.upload.speed,
        };
      }
    });

  await json.stringify(config.dataPath('cores-processed.json'), processedCores);
  await json.saveLargeData('boards', processedBoards);
  await json.saveLargeData('libs', processedLibs);
  await json.saveDataAsJSONL('boards', processedBoards);
  await json.saveDataAsJSONL('libs', processedLibs);
  await json.stringify(config.dataPath('legacy-boards-processed.json'), legacyBoards);
  console.log('Done Pre-Processing Data');
};
