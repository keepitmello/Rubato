#!/usr/bin/env node
// Check push from this Mac without waiting for a thread to finish:
//   node mac/cli.mjs phones          the phones paired for push
//   node mac/cli.mjs test [text]     one alert to each of them
import { createGrantStore } from './grants.mjs';

const grants = createGrantStore({ log: (message, detail) => console.error(message, detail ?? '') });
const [command, ...rest] = process.argv.slice(2);
if (command === 'phones') console.log(JSON.stringify(grants.list(), null, 2));
else if (command === 'test') console.log(JSON.stringify(await grants.pushAll({ kind: 'alert', title: 'Rubato', body: rest.join(' ') || 'Push from this Mac works.' }), null, 2));
else { console.error('usage: node mac/cli.mjs phones | test [text]'); process.exit(2); }
