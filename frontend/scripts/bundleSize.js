// Prints the size of every file in dist/ and fails if the gzipped JS+CSS+HTML total exceeds the budget.
// Usage: npm run build && npm run size        (budget: BUDGET_KB, default 200)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BUDGET_KB = Number(process.env.BUDGET_KB ?? 200);
const dist = path.resolve(process.argv[2] ?? 'dist');
if (!fs.existsSync(dist)) {
  console.error(`No build found at ${dist}. Run "npm run build" first.`);
  process.exit(2);
}

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
})(dist);

let rawTotal = 0;
let gzipTotal = 0;
console.log('file'.padEnd(40), 'raw KB'.padStart(9), 'gzip KB'.padStart(9));
for (const file of files.sort()) {
  const buf = fs.readFileSync(file);
  const gz = zlib.gzipSync(buf, { level: 9 }).length;
  rawTotal += buf.length;
  gzipTotal += gz;
  console.log(path.relative(dist, file).padEnd(40), (buf.length / 1024).toFixed(1).padStart(9), (gz / 1024).toFixed(1).padStart(9));
}
console.log('TOTAL'.padEnd(40), (rawTotal / 1024).toFixed(1).padStart(9), (gzipTotal / 1024).toFixed(1).padStart(9));

const ok = gzipTotal / 1024 <= BUDGET_KB;
console.log(`\nBudget ${BUDGET_KB} KB (gzip): ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
