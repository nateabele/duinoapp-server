/* eslint-disable no-console */
// One-shot install of everything the server needs under DATA_DIR:
//   npm run setup                 # all pinned cores (avr, esp8266, esp32)
//   CORES=arduino:avr npm run setup
// Safe to re-run; arduino-cli skips cores that are already installed.
const config = require('../src/config');
const {
  loadCli, loadIndexes, loadCores, loadBoards, processData, coreVersions,
} = require('./index');

(async () => {
  const started = Date.now();
  console.log(`Data dir: ${config.dataDir}`);
  console.log(`Cores: ${Object.entries(coreVersions()).map(([id, v]) => `${id}@${v}`).join(', ')}`);
  await loadCli();
  await loadIndexes();
  await loadCores();
  await loadBoards();
  await processData();
  console.log(`Setup complete in ${Math.round((Date.now() - started) / 1000)}s`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
