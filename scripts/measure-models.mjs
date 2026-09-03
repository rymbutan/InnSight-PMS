// Measure every .glb in web/public/models: native bounding box, triangle count,
// texture payload, and which glTF extensions it uses.
//
// WHY
// ---
// The 3D room's fixtures were scaled by guesswork against a loader that only ever
// matched a model's HORIZONTAL size, so heights came out as whatever each asset's
// native aspect ratio happened to be — a 4.8 m tall rug, a 2.37 m vanity, a king
// bed rendering as a 1 m tall cube. Fixing that needs the real numbers, per model,
// which is what this prints.
//
// It also reports triangles / texture bytes, which is the before-and-after for the
// asset-compression step.
//
//   node scripts/measure-models.mjs            # table, sorted by name
//   node scripts/measure-models.mjs --json     # machine-readable
//   node scripts/measure-models.mjs --heavy    # sorted by size, worst first
//   node scripts/measure-models.mjs <dir>      # measure some other directory
//                                              # (e.g. a compression staging dir)
//
// Parses the GLB container directly (12-byte header + JSON/BIN chunks) and derives
// the AABB from each POSITION accessor's mandatory min/max, transformed by its
// node's world matrix. No dependencies, no GPU, no network.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const args = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '')));
const dirArg = argv.find((a) => !a.startsWith('--'));
const MODELS_DIR = dirArg
  ? (dirArg.startsWith('/') ? dirArg : join(process.cwd(), dirArg))
  : join(here, '..', 'web', 'public', 'models');

// ── minimal mat4 (column-major, matching glTF) ───────────────────────────────
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
        + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

// glTF node TRS → matrix. Rotation is a quaternion [x,y,z,w].
function trs(t = [0, 0, 0], r = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function transformPoint(m, [x, y, z]) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

// ── GLB container ───────────────────────────────────────────────────────────
function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB (bad magic)');
  const total = buf.readUInt32LE(8);
  let off = 12;
  let json = null;
  let bin = null;
  while (off + 8 <= Math.min(total, buf.length)) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(start, start + len).toString('utf8'));
    else if (type === 0x004e4942) bin = buf.subarray(start, start + len);
    off = start + len + ((4 - (len % 4)) % 4); // chunks are 4-byte aligned
  }
  if (!json) throw new Error('no JSON chunk');
  return { json, bin };
}

function measure(file) {
  const buf = readFileSync(file);
  const { json: g } = parseGlb(buf);

  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let tris = 0;

  const meshAabb = (meshIndex, world) => {
    const mesh = g.meshes?.[meshIndex];
    if (!mesh) return;
    for (const prim of mesh.primitives || []) {
      // mode 4 = TRIANGLES (also the default when absent)
      const mode = prim.mode ?? 4;
      const posIdx = prim.attributes?.POSITION;
      const pos = posIdx != null ? g.accessors?.[posIdx] : null;

      if (mode === 4) {
        const count = prim.indices != null
          ? (g.accessors?.[prim.indices]?.count ?? 0)
          : (pos?.count ?? 0);
        tris += Math.floor(count / 3);
      }

      // glTF REQUIRES min/max on the POSITION accessor, so the AABB needs no
      // buffer decoding at all.
      if (!pos?.min || !pos?.max) continue;
      const [ax, ay, az] = pos.min;
      const [bx, by, bz] = pos.max;
      for (const cx of [ax, bx]) {
        for (const cy of [ay, by]) {
          for (const cz of [az, bz]) {
            const p = transformPoint(world, [cx, cy, cz]);
            for (let i = 0; i < 3; i++) {
              if (p[i] < lo[i]) lo[i] = p[i];
              if (p[i] > hi[i]) hi[i] = p[i];
            }
          }
        }
      }
    }
  };

  const walk = (nodeIndex, parent) => {
    const n = g.nodes?.[nodeIndex];
    if (!n) return;
    const local = n.matrix ? n.matrix : trs(n.translation, n.rotation, n.scale);
    const world = multiply(parent, local);
    if (n.mesh != null) meshAabb(n.mesh, world);
    for (const c of n.children || []) walk(c, world);
  };

  const sceneIdx = g.scene ?? 0;
  const roots = g.scenes?.[sceneIdx]?.nodes ?? g.nodes?.map((_, i) => i) ?? [];
  for (const r of roots) walk(r, identity());

  // Texture payload: images stored in bufferViews, plus any external URIs.
  let texBytes = 0;
  for (const img of g.images || []) {
    if (img.bufferView != null) texBytes += g.bufferViews?.[img.bufferView]?.byteLength ?? 0;
  }

  const size = [0, 1, 2].map((i) => (Number.isFinite(lo[i]) && Number.isFinite(hi[i]) ? hi[i] - lo[i] : 0));

  const extensions = g.extensionsUsed || [];
  // KHR_mesh_quantization stores POSITION as integers, so accessor min/max are in
  // quantized space and the reported size is meaningless here (you'd see numbers
  // in the tens of thousands). three.js dequantizes correctly at load time, so
  // this is a limitation of measuring the FILE, not a problem with the model —
  // measure a quantized asset by reading its Box3 in the running scene instead.
  const quantized = extensions.includes('KHR_mesh_quantization');

  return {
    file: file.split('/').pop(),
    bytes: buf.length,
    size,
    quantized,
    min: lo.map((v) => (Number.isFinite(v) ? v : 0)),
    tris,
    texBytes,
    images: (g.images || []).length,
    extensions,
  };
}

const files = readdirSync(MODELS_DIR).filter((f) => f.endsWith('.glb')).sort();
if (!files.length) {
  console.error(`No .glb found in ${MODELS_DIR}`);
  process.exit(1);
}

const rows = [];
for (const f of files) {
  try {
    rows.push(measure(join(MODELS_DIR, f)));
  } catch (e) {
    console.error(`  ! ${f}: ${e.message}`);
  }
}

if (args.has('json')) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

// --save writes the native dimensions to a committed snapshot, which
// scripts/check-room-layouts.mjs reads to compute RENDERED fixture sizes.
//
// A snapshot is necessary rather than measuring on demand, because the shipped
// models are meshopt-quantized and no longer report usable file-level dimensions.
// Regenerate from the uncompressed originals:
//   node scripts/measure-models.mjs .attic/models-uncompressed-originals --save
if (args.has('save')) {
  const quantized = rows.filter((r) => r.quantized);
  if (quantized.length) {
    console.error(`\nRefusing to save: ${quantized.length} model(s) are quantized, so their`);
    console.error('dimensions would be garbage. Point this at the uncompressed originals:');
    console.error('  node scripts/measure-models.mjs .attic/models-uncompressed-originals --save');
    process.exit(1);
  }
  const out = {};
  for (const r of rows) out[r.file.replace(/\.glb$/, '')] = r.size.map((v) => +v.toFixed(4));
  const dest = join(here, 'model-metrics.json');
  writeFileSync(dest, `${JSON.stringify({
    _comment: 'Native (unscaled) bounding-box size [x,y,z] in metres per .glb, from scripts/measure-models.mjs --save. Used by check-room-layouts.mjs to derive rendered fixture sizes. Regenerate from .attic/models-uncompressed-originals — the shipped models are quantized.',
    models: out,
  }, null, 2)}\n`);
  console.log(`\n✓ wrote ${Object.keys(out).length} model dimensions → scripts/model-metrics.json`);
  process.exit(0);
}

if (args.has('heavy')) rows.sort((a, b) => b.bytes - a.bytes);

const mb = (n) => (n / 1048576).toFixed(1).padStart(6);
const m3 = (n) => n.toFixed(3).padStart(7);
const name = (s) => s.replace(/\.glb$/, '').slice(0, 30).padEnd(30);

console.log('');
console.log(`${'model'.padEnd(30)} ${'MB'.padStart(6)} ${'tris'.padStart(9)} ${'texMB'.padStart(6)}  ${'native x'.padStart(7)} ${'y'.padStart(7)} ${'z'.padStart(7)}  tallest-axis`);
console.log('─'.repeat(110));
for (const r of rows) {
  const [x, y, z] = r.size;
  if (r.quantized) {
    console.log(`${name(r.file)} ${mb(r.bytes)} ${String(r.tris).padStart(9)} ${mb(r.texBytes)}  ${'quantized — file-level size not meaningful'.padStart(23)}`);
    continue;
  }
  // Which axis dominates tells you whether fitting on width or height is right.
  const dom = y > Math.max(x, z) ? 'Y (upright)' : x > z ? 'X (wide)' : 'Z (deep)';
  console.log(`${name(r.file)} ${mb(r.bytes)} ${String(r.tris).padStart(9)} ${mb(r.texBytes)}  ${m3(x)} ${m3(y)} ${m3(z)}  ${dom}`);
}

const totBytes = rows.reduce((s, r) => s + r.bytes, 0);
const totTris = rows.reduce((s, r) => s + r.tris, 0);
const totTex = rows.reduce((s, r) => s + r.texBytes, 0);
const compressed = rows.filter((r) => r.extensions.length).length;

console.log('─'.repeat(110));
console.log(`${rows.length} models · ${(totBytes / 1048576).toFixed(0)} MB total · ${totTris.toLocaleString()} triangles · ${(totTex / 1048576).toFixed(0)} MB textures`);
console.log(`${compressed}/${rows.length} use any glTF compression extension (Draco / meshopt / KTX2)`);
if (rows.some((r) => r.quantized)) {
  console.log('note: quantized models report no usable file-level dimensions — the');
  console.log('      fit modes in task3d.jsx measure the DECODED scene at runtime, so');
  console.log('      rendered size is unaffected. Verify those in the browser.');
}
const worst = [...rows].sort((a, b) => b.tris - a.tris).slice(0, 3);
console.log(`heaviest by triangles: ${worst.map((r) => `${r.file.replace(/\.glb$/, '')} (${r.tris.toLocaleString()})`).join(', ')}`);
