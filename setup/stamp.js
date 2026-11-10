const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const config = require('../src/config');

// The slow half of setup (index download, board details, pre-processing) only
// needs to run again when its inputs change, or when the data gets old.
// After a successful run we write a stamp (hash of the inputs + timestamp) to
// DATA_DIR; the next run skips that half if the stamp still matches.

const DAY_MS = 24 * 60 * 60 * 1000;
// Refresh the library/board indexes at least this often (SETUP_MAX_AGE_DAYS=0 means every run).
const DEFAULT_MAX_AGE_DAYS = 7;

// Everything process-data and the loaders read, besides the downloaded indexes themselves.
const INPUT_FILES = [
  'versions.json', 'index.js', 'install.js', 'process-data.js', 'stamp.js', '../src/utils/json.js', '../package-lock.json',
].map((f) => path.join(__dirname, f));

// Files the skipped steps produce; all must exist for a skip.
const OUTPUT_FILES = [
  'cores.json', 'libs.json', 'boards.json', 'cores-processed.json', 'legacy-boards-processed.json',
  'boards-processed.jsbin', 'boards-processed.jsonl', 'libs-processed.jsbin', 'libs-processed.jsonl',
];

const stampPath = () => config.dataPath('setup-stamp.json');

const hashInputs = async (cores) => {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(cores));
  await INPUT_FILES.reduce(async (a, file) => {
    await a;
    hash.update(`\0${path.basename(file)}\0`);
    hash.update(await fs.readFile(file).catch(() => ''));
  }, Promise.resolve());
  return hash.digest('hex');
};

const exists = (file) => fs.stat(file).then((s) => s.size > 0, () => false);

// Pure decision: returns { skip, reason }.
const decide = ({
  stamp, hash, force = false, maxAgeDays = DEFAULT_MAX_AGE_DAYS, now = Date.now(), outputsExist = true,
}) => {
  if (force) return { skip: false, reason: 'FORCE_SETUP is set' };
  if (!stamp) return { skip: false, reason: 'no previous successful run recorded' };
  if (stamp.hash !== hash) return { skip: false, reason: 'setup inputs changed (versions, setup code or CORES)' };
  if (!outputsExist) return { skip: false, reason: 'processed data files are missing' };
  const ageMs = now - Date.parse(stamp.completedAt);
  if (!(ageMs >= 0) || ageMs >= maxAgeDays * DAY_MS) {
    return { skip: false, reason: `index data is older than ${maxAgeDays} day(s)` };
  }
  return { skip: true, reason: `inputs unchanged, data refreshed ${(ageMs / DAY_MS).toFixed(1)} day(s) ago` };
};

const check = async (cores) => {
  const hash = await hashInputs(cores);
  const stamp = await fs.readFile(stampPath(), 'utf-8').then(JSON.parse).catch(() => null);
  const outputsExist = (await Promise.all(OUTPUT_FILES.map((f) => exists(config.dataPath(f))))).every(Boolean);
  const envDays = process.env.SETUP_MAX_AGE_DAYS;
  return {
    hash,
    ...decide({
      stamp,
      hash,
      outputsExist,
      force: ['1', 'true'].includes(process.env.FORCE_SETUP),
      maxAgeDays: envDays !== undefined && envDays !== '' && Number(envDays) >= 0 ? Number(envDays) : DEFAULT_MAX_AGE_DAYS,
    }),
  };
};

const write = (hash) => fs.writeFile(stampPath(), JSON.stringify({ hash, completedAt: new Date().toISOString() }));

module.exports = {
  check, write, decide, hashInputs, DEFAULT_MAX_AGE_DAYS,
};
