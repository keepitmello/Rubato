// The server reports each failed send. When one connection drops, every send already
// queued behind it fails the same way, and the log used to fill with thousands of
// identical "Unix connection is closed" lines and no time to place the drop. Each line
// now carries its time, and a run of the same message becomes one count.
export function errorLog({ write = (line) => console.error(line), now = () => new Date() } = {}) {
  let last;
  let repeats = 0;
  const flush = () => {
    if (repeats > 0) write(`${now().toISOString()} (repeated ${repeats} more time${repeats === 1 ? '' : 's'})`);
    repeats = 0;
  };
  const report = (error) => {
    const message = error?.message ?? String(error);
    if (message === last) { repeats += 1; return; }
    flush();
    last = message;
    write(`${now().toISOString()} ${message}`);
  };
  report.flush = flush;
  return report;
}
