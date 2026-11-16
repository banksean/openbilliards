// Pure adapter gate for app/railbird.js. No browser or wasm is required.
//
//   node web/tools/test-railbird.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aliasRailbirdShot, convertRailbirdShot, parseRailbirdExport,
} from '../app/railbird.js';

const fixture = {
  getOrderedShots: {
    shots: [{
      id: 42,
      cleanPaths: [
        { ballId: 99, isCueBall: false, restPoint: { x: 700, y: 450 } },
        { ballId: 7, isCueBall: true, restPoint: { x: 200, y: 200 } },
        { ballId: 12, isCueBall: false, restPoint: { x: 1200, y: 700 } },
      ],
    }],
  },
};

const [shot] = parseRailbirdExport(fixture);
assert.equal(shot.id, 42);
assert.deepEqual([...aliasRailbirdShot(shot)], [[7, 0], [12, 1], [99, 2]]);

const table = { length: 2.54, width: 1.27 };
const radius = 0.028575;
const converted = convertRailbirdShot(shot, table, radius);
assert.equal(converted.clamped, 2);
assert.deepEqual(converted.layout.map((b) => b.id), [0, 1, 2]);
assert.deepEqual(
  converted.layout.find((b) => b.id === 2),
  {
    id: 2, x: 0, y: 0, railbirdId: 99, isCueBall: false,
    source: { x: 700, y: 450 }, clamped: false,
  },
);
assert.deepEqual(
  converted.layout.find((b) => b.id === 0),
  {
    id: 0, x: table.width / 2 - radius, y: -table.length / 2 + radius,
    railbirdId: 7, isCueBall: true,
    source: { x: 200, y: 200 }, clamped: true,
  },
);

assert.throws(
  () => parseRailbirdExport({ getOrderedShots: { shots: [{ cleanPaths: [] }] } }),
  /exactly one cue ball/,
);
assert.throws(
  () => parseRailbirdExport({ getOrderedShots: { shots: [{ cleanPaths: [
    { ballId: 1, isCueBall: true, restPoint: { x: 1, y: 2 } },
    { ballId: 1, isCueBall: false, restPoint: { x: 3, y: 4 } },
  ] }] } }),
  /duplicates/,
);

// Exercise the supplied cross-application export when it is present in the
// checkout, without making that external fixture a repository dependency.
const here = path.dirname(fileURLToPath(import.meta.url));
const samplePath = path.resolve(here, '..', '..', 'railbird-example.json');
if (fs.existsSync(samplePath)) {
  const sample = parseRailbirdExport(JSON.parse(fs.readFileSync(samplePath, 'utf8')));
  assert.equal(sample.length, 10);
  assert.equal(sample[0].paths.length, 14);
  for (const s of sample) convertRailbirdShot(s, table, radius);
}

console.log('PASS Railbird export parsing, aliasing, coordinate conversion, and clamping');
