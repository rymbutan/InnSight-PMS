import test from 'node:test';
import assert from 'node:assert';

import {
  yawFromQuaternion,
  isLockedBase,
  duplicateAdded,
  buildScenarioPayload,
  savableProblem,
  objectsFromScenario,
} from './scenarioEdit.js';
import { refOf, fromScenario, scenarioCounts } from './scenario.js';
import { getRoomPlan } from '../roomLayouts.js';

// The editor's seedFromTier, minus the id generator.
function seed(tier) {
  let n = 0;
  return getRoomPlan(tier).furniture.map((f) => ({
    ...f,
    id: `s${(n += 1)}`,
    _ref: refOf(f),
    _baseModel: f.model,
    _baseRy: f.ry ?? 0,
    _baseScale: f.scale || [1, 1, 1],
    _baseY: f.y ?? 0,
    defectId: undefined,
    label: undefined,
  }));
}
const mkId = () => 'fresh';

// ── yaw ─────────────────────────────────────────────────────────────────────
const quatY = (a) => ({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) });

test('yawFromQuaternion round-trips facings beyond 90 degrees', () => {
  for (const deg of [-170, -135, -90, -45, 0, 30, 90, 135, 170]) {
    const a = (deg * Math.PI) / 180;
    assert.ok(Math.abs(yawFromQuaternion(quatY(a)) - a) < 1e-9, `${deg}`);
  }
});

test('yawFromQuaternion survives the Euler flip three applies past 90 degrees', () => {
  // 135 deg yaw is what three reports as rotation.y = 45 deg with x and z at 180.
  // Build the same orientation as a quaternion with a tiny pitch and check the
  // yaw is still 135, not 45.
  const yaw = (135 * Math.PI) / 180;
  const pitch = 0.05;
  // q = qy * qx (YXZ order: yaw about Y applied last)
  const qy = quatY(yaw);
  const qx = { x: Math.sin(pitch / 2), y: 0, z: 0, w: Math.cos(pitch / 2) };
  const q = {
    w: qy.w * qx.w - qy.x * qx.x - qy.y * qx.y - qy.z * qx.z,
    x: qy.w * qx.x + qy.x * qx.w + qy.y * qx.z - qy.z * qx.y,
    y: qy.w * qx.y - qy.x * qx.z + qy.y * qx.w + qy.z * qx.x,
    z: qy.w * qx.z + qy.x * qx.y - qy.y * qx.x + qy.z * qx.w,
  };
  assert.ok(Math.abs(yawFromQuaternion(q) - yaw) < 1e-6);
});

// ── locks and duplicates ────────────────────────────────────────────────────
test('only base fixtures are locked', () => {
  assert.equal(isLockedBase({ id: 'a', _ref: 'bed@0,0' }), true);
  assert.equal(isLockedBase({ id: 'a', added: true, model: 'sofa' }), false);
});

test('duplicating an added object gives a fresh id, keeps added, drops private fields', () => {
  const orig = { id: 'o1', added: true, model: 'sofa', pos: [1, 2], ry: 1, _ref: 'x', _baseY: 0, defectId: null };
  const copy = duplicateAdded(orig, 'o2');
  assert.equal(copy.id, 'o2');
  assert.equal(copy.added, true);
  assert.deepEqual(copy.pos, [1.5, 2.5]);
  assert.ok(!('_ref' in copy) && !('_baseY' in copy));
  const payload = buildScenarioPayload({ objects: [orig, copy], name: 'n', tier: 'Standard' });
  assert.equal(new Set(payload.tags.map((t) => t.ref)).size, 2);
  assert.equal(payload.added.length, 2);
});

// ── payload / open round trip ───────────────────────────────────────────────
function authored() {
  const objs = seed('Standard');
  const swappedIdx = objs.findIndex((o) => o.model);
  const taggedIdx = objs.findIndex((o, i) => i !== swappedIdx && o.model);
  objs[swappedIdx] = { ...objs[swappedIdx], ry: (objs[swappedIdx].ry ?? 0) + 1, scale: [1.5, 1.5, 1.5], y: 0.3 };
  objs[taggedIdx] = { ...objs[taggedIdx], defectId: null, label: 'Decoy thing' };
  objs.push({ id: 'oAdd', added: true, model: 'sofa', pos: [1.1, -0.4], ry: 0.5, y: 0, defectId: 'blocked_path', label: 'Sofa' });
  return { objs, swappedIdx, taggedIdx };
}

test('payload records only what differs, plus added objects and tags', () => {
  const { objs, swappedIdx, taggedIdx } = authored();
  const p = buildScenarioPayload({ objects: objs, name: '  Test  ', tier: 'Standard' });
  assert.equal(p.name, 'Test');
  assert.deepEqual(p.furniture, []);
  assert.deepEqual(Object.keys(p.swaps), [objs[swappedIdx]._ref]);
  assert.deepEqual(p.swaps[objs[swappedIdx]._ref].scale, [1.5, 1.5, 1.5]);
  assert.equal(p.added.length, 1);
  assert.equal(p.added[0].id, 'oAdd');
  const refs = p.tags.map((t) => t.ref);
  assert.ok(refs.includes('oAdd') && refs.includes(objs[taggedIdx]._ref));
  assert.deepEqual(scenarioCounts(p), { faults: 1, decoys: 1 });
});

test('opening a saved payload rebuilds the same payload (no drift, nothing dropped)', () => {
  const { objs } = authored();
  const p = buildScenarioPayload({ objects: objs, name: 'Test', tier: 'Standard' });
  const stored = JSON.parse(JSON.stringify({ ...p, id: 'sc1' }));
  const opened = objectsFromScenario(stored, seed('Standard'), mkId);
  assert.equal(opened.legacy, false);
  assert.equal(opened.droppedTags, 0);
  assert.equal(opened.droppedPrims, 0);
  const again = buildScenarioPayload({ objects: opened.objects, name: 'Test', tier: 'Standard' });
  assert.deepEqual(again, p);
});

test('the saved payload plays back: swaps and added objects reach the layout', () => {
  const { objs, swappedIdx } = authored();
  const p = buildScenarioPayload({ objects: objs, name: 'Test', tier: 'Standard' });
  const { layout, anchors } = fromScenario({ ...p, id: 'x', active: true }, { rng: () => 0.5 });
  assert.ok(layout.furniture.some((f) => f.added && f.model === 'sofa'));
  assert.equal(layout.furniture[swappedIdx].scale[0], 1.5);
  assert.ok(anchors.length >= 2);
});

test('opening drops prim props and unresolved tags, and counts them', () => {
  const s = {
    id: 'sc1',
    name: 'Old',
    roomTier: 'Standard',
    furniture: [],
    swaps: {},
    added: [
      { id: 'p1', prim: 'vacuum', pos: [0, 0], size: [1, 1, 1] },
      { id: 'o1', model: 'sofa', pos: [1, 1], ry: 0 },
    ],
    tags: [
      { ref: 'p1', defectId: 'lingering_equipment', label: 'Vacuum' },
      { ref: 'o1', defectId: 'blocked_path', label: 'Sofa' },
      { ref: 'gone@9,9', defectId: null, label: 'Gone' },
    ],
  };
  const r = objectsFromScenario(s, seed('Standard'), mkId);
  assert.equal(r.droppedPrims, 1);
  assert.equal(r.droppedTags, 1); // the prim's own tag is not double-counted
  assert.ok(!r.objects.some((o) => o.prim));
  assert.equal(r.objects.find((o) => o.id === 'o1').defectId, 'blocked_path');
});

test('a legacy furniture snapshot opens as legacy without crashing, prims dropped', () => {
  const s = {
    id: 'old',
    name: 'Legacy',
    roomTier: 'Standard',
    furniture: [
      { id: 'f1', model: 'twin', pos: [0, 0], ry: 0 },
      { id: 'f2', prim: 'bucket', pos: [1, 1], size: [1, 1, 1] },
      { model: 'desk', pos: [2, 2] },
    ],
    anchors: [{ id: 'f1', defectId: 'room_mismatch', label: 'Beds', pos: [0, 0] }],
  };
  const r = objectsFromScenario(s, seed('Standard'), mkId);
  assert.equal(r.legacy, true);
  assert.equal(r.droppedPrims, 1);
  assert.equal(r.objects.length, 2);
  assert.equal(r.objects[0].defectId, 'room_mismatch');
  assert.equal(r.objects[1].id, 'fresh');
});

test('savableProblem explains why a payload cannot be saved', () => {
  assert.match(savableProblem({ name: '' }, 1), /name/i);
  assert.match(savableProblem({ name: 'x' }, 0), /fault/i);
  assert.equal(savableProblem({ name: 'x' }, 1), '');
});
