// One line per event, `event key=value ...`, so journalctl output can be
// grepped for a request id or event name when reconstructing a crash.
const fmt = (value) => {
  if (value === undefined) return undefined;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
};

const line = (event, fields = {}) => [
  event,
  ...Object.entries(fields)
    .map(([k, v]) => [k, fmt(v)])
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`),
].join(' ');

module.exports = {
  info: (event, fields) => console.log(line(event, fields)),
  error: (event, fields, err) => {
    console.error(line(event, { ...fields, error: err && err.message }));
    if (err && err.stack) console.error(err.stack);
  },
};
