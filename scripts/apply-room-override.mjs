// Bake a browser-authored room layout into web/src/sim/roomLayouts.js.
//
// The layout editor (sim/RoomLayoutEditor.jsx) autosaves to localStorage under
// `roomedit:<Tier>` and nothing else ever persists it — so a customised room
// lives in ONE browser and every other user still sees the committed layout.
// This turns such an override into the real, checked-in layout.
//
// Input: the JSON produced by, in DevTools console on the origin that has it —
//   copy(JSON.stringify(Object.fromEntries(Object.keys(localStorage)
//     .filter(k => k.startsWith('roomedit:'))
//     .map(k => [k, JSON.parse(localStorage[k])])), null, 1))
//
// Usage:
//   node scripts/apply-room-override.mjs dump.json            # write
//   node scripts/apply-room-override.mjs dump.json --dry-run  # print only
//
// It emits the SAME text the editor's "Copy block → clipboard" button emits,
// so the result is identical to pasting by hand — just without the hand.
// Always re-run `node scripts/check-room-layouts.mjs` afterwards.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'web/src/sim/roomLayouts.js');
const TIERS = ['Standard', 'Deluxe', 'Suite', 'Presidential'];

const [file, ...flags] = process.argv.slice(2);
const dry = flags.includes('--dry-run');
if (!file) {
  console.error('usage: node scripts/apply-room-override.mjs <dump.json> [--dry-run]');
  process.exit(2);
}

// ── serialisers: byte-for-byte the editor's own (RoomLayoutEditor.jsx) ───────
// NOT the editor's 2-decimal rounding. localStorage holds full precision, and
// r2() moves a wall-flush fixture by up to 5mm — past the validator's 1e-6
// tolerance, which reports every such fixture as OUT-OF-BOUNDS. 9 decimals keeps
// clean values short (3.775 -> "3.775") while staying lossless in practice.
const r2 = (n) => parseFloat(Number(n).toFixed(9));
function ryStr(ry) {
  const n = ((ry % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const table = [
    [0, '0'],
    [Math.PI / 2, 'Math.PI / 2'],
    [Math.PI, 'Math.PI'],
    [(3 * Math.PI) / 2, '-Math.PI / 2'],
    [2 * Math.PI, '0'],
  ];
  for (const [v, s] of table) if (Math.abs(n - v) < 0.12) return s;
  return r2(ry).toString();
}
function furnLine(it) {
  const p = [it.model ? `model: '${it.model}'` : `type: '${it.type}'`];
  p.push(`pos: [${r2(it.pos[0])}, ${r2(it.pos[1])}]`);
  if (it.ry || it._hadRy) p.push(`ry: ${ryStr(it.ry || 0)}`);
  if (it.scale && (it.scale[0] !== 1 || it.scale[1] !== 1 || it.scale[2] !== 1))
    p.push(`scale: [${r2(it.scale[0])}, ${r2(it.scale[1])}, ${r2(it.scale[2])}]`);
  if (it.wall) p.push('wall: true');
  if (it.y != null) p.push(`y: ${r2(it.y)}`);
  if (it.w != null) p.push(`w: ${r2(it.w)}`);
  if (it.box) p.push(`box: [${r2(it.box[0])}, ${r2(it.box[1])}]`);
  if (it.s) p.push(`s: [${r2(it.s[0])}, ${r2(it.s[1])}]`);
  if (it.c) p.push(`c: '${it.c}'`);
  return `      { ${p.join(', ')} },`;
}
const wallLine = (w) =>
  `      { p: [${r2(w.p[0])}, ${r2(w.p[1])}], w: ${r2(w.w)}, d: ${r2(w.d)}` +
  `${w.ry ? `, ry: ${ryStr(w.ry)}` : ''}${w.c ? `, c: '${w.c}'` : ''} },`;
const stationLine = (s) =>
  `      { key: '${s.key}', taskType: '${s.taskType}', title: '${s.title}', emoji: '${s.emoji}',` +
  `${s.y != null ? ` y: ${r2(s.y)},` : ''} pos: [${r2(s.pos[0])}, ${r2(s.pos[1])}] },`;

function serializeBlock(tier, room, walls, furniture, stations) {
  const hPart = room.h && room.h !== 3 ? ` h: ${r2(room.h)},` : '';
  return (
    `  ${tier}: {\n    tier: '${tier}', w: ${r2(room.w)}, l: ${r2(room.l)},${hPart}` +
    ` spawn: [${r2(room.spawn[0])}, ${r2(room.spawn[1])}], floor: '${room.floor}',\n` +
    `    walls: [\n${walls.map(wallLine).join('\n')}\n    ],\n` +
    `    furniture: [\n${furniture.map(furnLine).join('\n')}\n    ],\n` +
    `    stations: [\n${stations.map(stationLine).join('\n')}\n    ],\n  },`
  );
}

// ── locate a tier entry in LAYOUTS, whatever its current form ───────────────
// Entries are either `Tier: (() => { … })(),` or `Tier: { … },`. Walk brackets
// from the colon to the matching close, so both shapes are handled and a stray
// brace inside a string can't truncate the splice.
function tierSpan(src, tier) {
  const start = src.indexOf(`\n  ${tier}: `);
  if (start < 0) return null;
  let i = src.indexOf(':', start) + 1;
  let depth = 0,
    seen = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      seen = true;
    } else if (c === '}' || c === ')' || c === ']') depth--;
    if (seen && depth === 0) break;
  }
  while (i < src.length && src[i] !== ',') i++;
  return [start + 1, i + 1];
}

const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
let src = fs.readFileSync(TARGET, 'utf8');
const applied = [];

for (const [key, ov] of Object.entries(dump)) {
  const tier = key.replace(/^roomedit:/, '');
  if (!TIERS.includes(tier)) {
    console.error(`  ! skipping unknown tier "${tier}"`);
    continue;
  }
  if (!ov || !Array.isArray(ov.furniture) || !ov.room) {
    console.error(`  ! skipping "${tier}" — malformed override (need .room and .furniture[])`);
    continue;
  }
  const span = tierSpan(src, tier);
  if (!span) {
    console.error(`  ! "${tier}" not found in roomLayouts.js`);
    continue;
  }
  // Stations aren't authored here, so keep whatever the tier already ships with
  // unless the override carries its own.
  const block = serializeBlock(tier, ov.room, ov.walls || [], ov.furniture, ov.stations || []);
  src = src.slice(0, span[0]) + block + src.slice(span[1]);
  applied.push(
    `${tier}: ${ov.furniture.length} fixtures, ${(ov.walls || []).length} walls, ${(ov.stations || []).length} stations`
  );
}

if (!applied.length) {
  console.error('\nNothing applied.');
  process.exit(1);
}
console.log('\nApplied:');
for (const a of applied) console.log('  ✓ ' + a);

if (dry) {
  console.log('\n--dry-run: roomLayouts.js NOT written.');
  process.exit(0);
}
fs.writeFileSync(TARGET + '.bak', fs.readFileSync(TARGET));
fs.writeFileSync(TARGET, src);
console.log(`\nWrote ${path.relative(ROOT, TARGET)} (backup at roomLayouts.js.bak)`);
console.log('Next: node scripts/check-room-layouts.mjs');
