// Counts the characters of a file the way the dream's guard does (Unicode code points, the file as
// it is), so the dream can measure MEMORY.md on any machine without depending on wc or a locale.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { process.stderr.write('usage: count-chars <file>\n'); process.exit(2); }
process.stdout.write(`${[...readFileSync(file, 'utf8')].length}\n`);
