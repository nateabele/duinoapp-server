/* eslint-disable no-console */
// One-shot install of everything the server needs under DATA_DIR:
//   npm run setup                 # all pinned cores (avr, esp8266, esp32)
//   CORES=arduino:avr npm run setup
//   FORCE_SETUP=1 npm run setup   # always redo the index/board processing
// Safe to re-run; arduino-cli skips cores that are already installed.
//
// The expensive part (index download, board details, pre-processing: minutes
// of CPU and ~3 GB of memory) is skipped when setup/versions.json, the setup
// code and the CORES selection are unchanged since the last successful run and
// the data is younger than SETUP_MAX_AGE_DAYS (default 7). See setup/stamp.js.
// The arduino-cli checksum check and pinned core installs always run.
const config = require('../src/config');
const {
  loadCli, loadIndexes, loadCores, loadBoards, processData, coreVersions,
} = require('./index');
const stamp = require('./stamp');

(async () => {
  const started = Date.now();
  console.log(`Data dir: ${config.dataDir}`);
  const cores = coreVersions();
  console.log(`Cores: ${Object.entries(cores).map(([id, v]) => `${id}@${v}`).join(', ')}`);
  await loadCli();
  const { hash, skip, reason } = await stamp.check(cores);
  if (skip) {
    console.log(`Skipping index and board processing: ${reason} (FORCE_SETUP=1 to redo)`);
  } else {
    console.log(`Running index and board processing: ${reason}`);
    await loadIndexes();
  }
  await loadCores();
  if (!skip) {
    await loadBoards();
    await processData();
    await stamp.write(hash);
  }
  console.log(`Setup complete in ${Math.round((Date.now() - started) / 1000)}s`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
