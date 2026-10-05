// Minimal FIFO concurrency limiter: at most `max` tasks run at once, the rest
// wait in a queue. A queued task that can't start within `queueTimeout` ms
// rejects instead of waiting forever.
module.exports = ({ max, queueTimeout }) => {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= max || !queue.length) return;
    const job = queue.shift();
    clearTimeout(job.timer);
    active += 1;
    // Free the slot before settling so the caller never sees a stale count.
    const settle = (fn) => (value) => {
      active -= 1;
      fn(value);
      next();
    };
    Promise.resolve()
      .then(job.task)
      .then(settle(job.resolve), settle(job.reject));
  };

  const run = (task) => new Promise((resolve, reject) => {
    const job = { task, resolve, reject };
    job.timer = setTimeout(() => {
      const i = queue.indexOf(job);
      if (i !== -1) queue.splice(i, 1);
      reject(new Error(`Compile server busy: waited ${queueTimeout / 1000}s for a free slot, please try again.`));
    }, queueTimeout);
    queue.push(job);
    next();
  });

  run.stats = () => ({ active, queued: queue.length, max });
  return run;
};
