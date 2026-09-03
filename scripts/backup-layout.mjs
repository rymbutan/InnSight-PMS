// Snapshot a baked room layout to web/src/sim/layout-backups/ as a new version.
//
// Layouts authored in the Room Layout editor live only in that browser's
// localStorage until they are baked into web/src/sim/roomLayouts.js. Once baked,
// this script keeps an append-only history beside the code, so a later revision
// never destroys an earlier one. Nothing here overwrites: each run writes the
// next -vN file for that tier.
//
// Usage:
//   node scripts/backup-layout.mjs              # every tier
//   node scripts/backup-layout.mjs Deluxe       # one tier
//
// Restore: copy the `room`/`furniture`/`walls`/`stations` out of the JSON and
// back into the tier's block in roomLayouts.js.

import fs from 'node:fs';
import path from 'node:path';
import { LAYOUTS } from '../web/src/sim/roomLayouts.js';

const DIR = 'web/src/sim/layout-backups';
const tiers = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(LAYOUTS);

fs.mkdirSync(DIR, { recursive: true });

for (const tier of tiers) {
  const plan = LAYOUTS[tier];
  if (!plan) {
    console.error(`✗ unknown tier "${tier}" — have: ${Object.keys(LAYOUTS).join(', ')}`);
    process.exitCode = 1;
    continue;
  }

  // Next free version for this tier, so an earlier snapshot is never clobbered.
  const taken = fs
    .readdirSync(DIR)
    .map((f) => new RegExp(`^${tier}-.*-v(\\d+)\\.json$`).exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const version = (taken.length ? Math.max(...taken) : 0) + 1;

  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(DIR, `${tier}-${stamp}-v${version}.json`);
  const payload = {
    tier,
    version,
    savedAt: new Date().toISOString(),
    source: 'baked into web/src/sim/roomLayouts.js',
    room: { w: plan.w, l: plan.l, h: plan.h, floor: plan.floor, spawn: plan.spawn },
    furniture: plan.furniture,
    walls: plan.walls || [],
    stations: plan.stations || [],
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `✓ ${file}  (${plan.furniture.length} fixtures, ${(plan.walls || []).length} walls, ` +
      `${(plan.stations || []).length} stations)`
  );
}
