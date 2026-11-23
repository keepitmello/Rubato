#!/usr/bin/env node
// Where a V8 CPU profile spent its time (engine-flows.mjs --cpu-profiles writes them): the functions
// by self time and by inclusive time, paths cut to the package or the checkout.
//
//   node harness/bench/cpu-profile-summary.mjs run.cpuprofile [self rows] [inclusive rows]
import { readFileSync } from 'node:fs';

export function summarize(profile, { self: selfRows = 25, inclusive: inclusiveRows = 40 } = {}) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const time = new Map();
  profile.samples.forEach((sample, i) => time.set(sample, (time.get(sample) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const total = [...time.values()].reduce((a, b) => a + b, 0);
  const key = (node) => {
    const frame = node.callFrame;
    const url = frame.url.replace(/.*node_modules\//, '').replace(/.*\/rubato\/harness\//, 'harness/').replace(/.*\.rubato-pi\/pi\//, 'pi/');
    return `${frame.functionName || '(anonymous)'} ${url}:${frame.lineNumber + 1}`;
  };
  const self = new Map();
  const inclusive = new Map();
  for (const [id, spent] of time) {
    const name = key(nodes.get(id));
    self.set(name, (self.get(name) ?? 0) + spent);
    const seen = new Set();
    for (let at = id; at !== undefined; at = parent.get(at)) {
      const frame = key(nodes.get(at));
      if (seen.has(frame)) continue;
      seen.add(frame); inclusive.set(frame, (inclusive.get(frame) ?? 0) + spent);
    }
  }
  const top = (map, rows) => [...map].sort((a, b) => b[1] - a[1]).slice(0, rows)
    .map(([name, spent]) => `${(spent / 1000).toFixed(0).padStart(7)}ms ${(100 * spent / total).toFixed(1).padStart(5)}%  ${name}`).join('\n');
  return `total ${(total / 1000).toFixed(0)} ms\n--- self\n${top(self, selfRows)}\n--- inclusive\n${top(inclusive, inclusiveRows)}`;
}

if (process.argv[2]) console.log(summarize(JSON.parse(readFileSync(process.argv[2], 'utf8')),
  { self: Number(process.argv[3] ?? 25), inclusive: Number(process.argv[4] ?? 40) }));
