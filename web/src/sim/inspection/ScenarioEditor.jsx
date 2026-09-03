import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, TransformControls, Bounds } from '@react-three/drei';
import * as THREE from 'three';

import api from '../../api';
import { useToast, errMsg } from '../../components/Toast';
import { RoomShell, FixtureBody, itemY } from '../RoomFreeRoam';
import { refOf, scenarioCounts } from './scenario';
import { variantsFor, labelFor } from './assetFamilies';
import { getRoomPlan } from '../roomLayouts';
import { MODELS } from '../task3d';
import { offerableCategories } from './categories';
import { hydrateCategories } from './categorySync';
import InspectionShift from './InspectionShift';

// ─────────────────────────────────────────────────────────────────────────────
// Authoring what is WRONG with a room.
//
// The Room Layouts editor authors the room as it SHOULD be; this authors a
// specific room as it should NOT be. You edit the room into its faulted state
// directly — drag the sofa across the bathroom door, drop a vacuum mid-floor,
// delete the towels — then tag each wrong object with which of the six
// categories it is. What you see here is exactly what the student walks into.
//
// THE BOOKING IS NOT AUTHORED HERE. A scenario is drawn for any room of its
// tier, so it cannot know who is arriving in any of them; the clipboard is built
// from that room's real reservation at run time (see buildClipboard). Authoring
// one here put a guest nobody had booked on the clipboard of an occupied room,
// and a fault tagged for a couple was graded against a solo guest. A fault the
// real booking cannot support is demoted to a decoy instead — so tag what is
// wrong with the ROOM and let the reservation decide what that means.
//
// Deliberately a separate file from RoomLayoutEditor.jsx: that one is already
// 950+ lines, its output feeds roomLayouts.js and the geometry validator, and
// the two tools answer different questions. Sharing the gizmo wiring would mean
// refactoring a working admin tool to serve a second master; the duplication is
// the cheaper trade and is recorded in the design spec.
// ─────────────────────────────────────────────────────────────────────────────

const TIERS = ['Standard', 'Deluxe', 'Suite', 'Presidential'];

// The primitive props the inspection can draw. Anything without a .glb lives
// here — the model library has no vacuum, mop bucket or chemical bottle.
const PRIMS = [
  { prim: 'vacuum', label: 'Vacuum cleaner', size: [0.35, 0.95, 0.45] },
  { prim: 'bucket', label: 'Mop bucket', size: [0.42, 0.5, 0.42] },
  { prim: 'chemicals', label: 'Cleaning chemicals', size: [0.22, 0.34, 0.16] },
  { prim: 'rumpled', label: 'Unmade bedding', size: [1.5, 0.22, 1.1] },
  { prim: 'luggagerack', label: 'Luggage rack', size: [1.1, 0.6, 0.6] },
];
const PRIM_COLOR = {
  vacuum: '#334155',
  bucket: '#eab308',
  chemicals: '#16a34a',
  rumpled: '#e2e8f0',
  luggagerack: '#78350f',
};

const MODEL_KEYS = Object.keys(MODELS).sort();

let uid = 0;
const nextId = () => `o${Date.now().toString(36)}${(uid += 1)}`;

// ── One authored object in the scene ────────────────────────────────────────
function EditorObject({ item, selected, onSelect, objectRef }) {
  const ref = useRef();
  useEffect(() => {
    if (selected && ref.current) objectRef.current = ref.current;
  }, [selected, objectRef]);

  const isPrim = !!item.prim;
  const [w, h, d] = item.size || [0.4, 0.4, 0.4];
  // A prim's box is centred on the group origin, so the group has to sit half a
  // SCALED height up or a resized prop sinks through the floor.
  const sy = item.scale?.[1] ?? 1;

  return (
    <group
      ref={ref}
      position={[item.pos[0], isPrim ? (item.y ?? 0) + (h * sy) / 2 : itemY(item), item.pos[1]]}
      rotation={[0, item.ry || 0, 0]}
      scale={item.scale || [1, 1, 1]}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(item.id);
      }}
    >
      {isPrim ? (
        <mesh>
          <boxGeometry args={[w, h, d]} />
          <meshStandardMaterial color={PRIM_COLOR[item.prim] || '#94a3b8'} roughness={0.75} />
        </mesh>
      ) : (
        <FixtureBody item={item} />
      )}
      {/* Selection cage — drawn only for the selected object so the scene still
          reads as the room a student would see. */}
      {selected && (
        <mesh>
          <boxGeometry args={[Math.max(w, 0.6) * 1.1, Math.max(h, 0.6) * 1.1, Math.max(d, 0.6) * 1.1]} />
          <meshBasicMaterial color="#38bdf8" wireframe />
        </mesh>
      )}
      {/* A fault carries a coloured halo in the EDITOR only — never in the sim,
          where it would give the answer away. */}
      {item.defectId && (
        <mesh position={[0, Math.max(h, 0.6) / 2 + 0.35, 0]}>
          <sphereGeometry args={[0.12, 12, 12]} />
          <meshBasicMaterial color="#ef4444" />
        </mesh>
      )}
    </group>
  );
}

export default function ScenarioEditor({ onClose }) {
  const toast = useToast();
  const [tier, setTier] = useState('Standard');
  const [scenarios, setScenarios] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [name, setName] = useState('');
  // The shared category library. Authored here, usable by every scenario and
  // every room — which is the whole reason it is not per-scenario data.
  const [cats, setCats] = useState(() => offerableCategories());
  const [catForm, setCatForm] = useState({ label: '', why: '', feedback: '' });
  const [catBusy, setCatBusy] = useState(false);
  const [objects, setObjects] = useState([]); // authored furniture + tags
  const [selId, setSelId] = useState(null);
  const [mode, setMode] = useState('translate');
  const [addKey, setAddKey] = useState('sofa');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);

  const orbit = useRef();
  const selObjRef = useRef();

  const base = useMemo(() => getRoomPlan(tier), [tier]);

  // Every object carries an id so selection survives edits; the base layout's
  // furniture has none, so they are stamped on load.
  // Refresh the library from the server and mirror it into local state.
  async function reloadCategories() {
    await hydrateCategories({ force: true });
    setCats(offerableCategories());
  }

  useEffect(() => {
    reloadCategories();
  }, []);

  // Saving a category writes to the SHARED library, so it immediately becomes
  // available on every other scenario and room — not just this one.
  async function saveCategory(e) {
    e.preventDefault();
    const label = catForm.label.trim();
    const why = catForm.why.trim();
    if (!label) return toast.error('Give the category a name.');
    if (!why) return toast.error('Say why it is a fault — the student sees this after grading.');
    setCatBusy(true);
    try {
      await api.post('/api/training/categories', {
        label,
        why,
        feedback: catForm.feedback.trim() || null,
      });
      setCatForm({ label: '', why: '', feedback: '' });
      await reloadCategories();
      toast.success(`"${label}" saved — available on every room.`);
    } catch (err) {
      toast.error(err.response?.data?.error || err.message);
    } finally {
      setCatBusy(false);
    }
  }

  async function retireCategory(cat) {
    if (!window.confirm(`Retire "${cat.label}"? Scenarios already using it keep working.`)) return;
    try {
      await api.delete(`/api/training/categories/${encodeURIComponent(cat.id)}`);
      await reloadCategories();
      toast.success(`"${cat.label}" retired.`);
    } catch (err) {
      toast.error(err.response?.data?.error || err.message);
    }
  }

  function seedFromTier(t) {
    const plan = getRoomPlan(t);
    // `_ref` is the stable positional identity a saved scenario points at; `id` is
    // regenerated every load and cannot survive a save. `_baseModel` is what the
    // tier ships, so a swap back to it is recorded as "no swap" rather than as an
    // override that would freeze the fixture against future layout edits.
    return plan.furniture.map((f) => ({
      ...f,
      id: nextId(),
      _ref: refOf(f),
      _baseModel: f.model,
      _baseRy: f.ry ?? 0,
      _baseScale: f.scale || [1, 1, 1],
      _baseY: f.y ?? 0,
      defectId: undefined,
      label: undefined,
    }));
  }

  async function load() {
    try {
      const { data } = await api.get('/api/training/scenarios');
      setScenarios(data || []);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  useEffect(() => {
    load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start a fresh scenario from the tier's correct room.
  useEffect(() => {
    if (editingId) return;
    setObjects(seedFromTier(tier));
    setSelId(null); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, editingId]);

  const sel = objects.find((o) => o.id === selId) || null;

  function snapshot() {
    setHistory((h) => [...h.slice(-19), objects]);
  }
  function undo() {
    setHistory((h) => {
      if (!h.length) return h;
      setObjects(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }

  function patchSel(patch) {
    setObjects((list) => list.map((o) => (o.id === selId ? { ...o, ...patch } : o)));
  }

  function addObject() {
    snapshot();
    const p = PRIMS.find((x) => x.prim === addKey);
    const item = p
      ? { id: nextId(), added: true, prim: p.prim, size: p.size, pos: [0, 0], ry: 0, y: 0 }
      : { id: nextId(), added: true, model: addKey, pos: [0, 0], ry: 0 };
    setObjects((list) => [...list, item]);
    setSelId(item.id);
  }

  function removeSel() {
    if (!sel) return;
    snapshot();
    setObjects((list) => list.filter((o) => o.id !== selId));
    setSelId(null);
  }

  function duplicateSel() {
    if (!sel) return;
    snapshot();
    const copy = { ...sel, id: nextId(), pos: [sel.pos[0] + 0.5, sel.pos[1] + 0.5] };
    setObjects((list) => [...list, copy]);
    setSelId(copy.id);
  }

  // Read the gizmo's transform back onto the selected object.
  function commitGizmo() {
    const o = selObjRef.current;
    if (!o || !sel) return;
    const isPrim = !!sel.prim;
    const h = (sel.size || [0, 0, 0])[1];
    // A prim's box is centred on its group origin and the group rides half a
    // SCALED height up, so the inverse has to use the scaled height too —
    // otherwise resizing a prop makes it jump the moment you drag it.
    const sy = sel.scale?.[1] ?? 1;
    const y = isPrim ? o.position.y - (h * sy) / 2 : o.position.y;
    patchSel({
      pos: [round(o.position.x), round(o.position.z)],
      ry: round(o.rotation.y, 3),
      y: round(Math.max(-0.5, y)),
    });
  }
  const round = (n, p = 2) => Math.round(n * 10 ** p) / 10 ** p;

  // ── Horizontal rotation (yaw) ──
  // Exposed as DEGREES because the gizmo ring was the only way to turn anything,
  // and dragging a ring in a perspective view to hit 90° is guesswork. Stored as
  // radians, which is what the renderer and roomLayouts.js use.
  const yawDeg = Math.round((((sel?.ry ?? 0) * 180) / Math.PI + 360) % 360);
  function setYaw(deg) {
    const d = ((Math.round(deg) % 360) + 360) % 360;
    patchSel({ ry: (d * Math.PI) / 180 });
  }

  // ── Height ──
  // Metres off the floor. Everything can be raised now: a towel onto a rack, a
  // bottle onto a counter, a fixture up a wall.
  const heightM = Number((sel?.y ?? 0).toFixed(2));
  function setHeight(m) {
    const v = Math.min(6, Math.max(-0.5, Number.isFinite(m) ? m : 0));
    patchSel({ y: Math.round(v * 100) / 100 });
  }

  // ── Size ──
  // Uniform only. These are Meshy exports with no reliable metric basis, and
  // stretching one on a single axis is glaringly visible (see MODEL_CFG). Shown
  // as a percentage because "150%" is a decision a teacher can make; "[1.5, 1.5,
  // 1.5]" is not. Collision follows for free — blockersOf() multiplies the
  // collision box by the scale, so the thing you bump into stays what you see.
  const sizePct = Math.round((sel?.scale?.[0] ?? 1) * 100);
  function setSize(pct) {
    const s = Math.min(1000, Math.max(10, Math.round(pct || 100))) / 100;
    patchSel({ scale: [s, s, s] });
  }

  // ── Persistence ──
  function currentPayload() {
    // A scenario stores what is WRONG with the live tier layout, never a copy of
    // it. `furniture` and `anchors` go out empty: a NON-EMPTY furniture array is
    // how fromScenario() recognises a legacy snapshot, so sending [] keeps new
    // rows on the tracking path while old rows keep rendering as authored.
    const swaps = {};
    const added = [];
    const tags = [];
    for (const o of objects) {
      const ref = o.added ? o.id : o._ref;
      if (o.added) {
        added.push({
          id: o.id,
          ...(o.model ? { model: o.model } : { prim: o.prim, size: o.size }),
          pos: o.pos,
          ry: o.ry ?? 0,
          ...(o.y !== undefined ? { y: o.y } : {}),
          ...(o.scale ? { scale: o.scale } : {}),
        });
      } else {
        // Only record a difference. Swapping back to the shipped asset removes
        // the override rather than pinning the fixture.
        const modelChanged = o.model && o._baseModel && o.model !== o._baseModel;
        const ryChanged = Math.abs((o.ry ?? 0) - (o._baseRy ?? 0)) > 1e-6;
        const base = o._baseScale || [1, 1, 1];
        const cur = o.scale || [1, 1, 1];
        const scaleChanged = cur.some((n, i) => Math.abs(n - base[i]) > 1e-6);
        const yChanged = Math.abs((o.y ?? 0) - (o._baseY ?? 0)) > 1e-6;
        if (modelChanged || ryChanged || scaleChanged || yChanged) {
          swaps[ref] = {
            ...(modelChanged ? { model: o.model } : {}),
            ...(ryChanged ? { ry: o.ry ?? 0 } : {}),
            ...(scaleChanged ? { scale: cur } : {}),
            ...(yChanged ? { y: o.y ?? 0 } : {}),
          };
        }
      }
      if (o.defectId !== undefined) {
        tags.push({ ref, defectId: o.defectId || null, label: o.label || defaultLabel(o) });
      }
    }
    return {
      name: name.trim(),
      roomTier: tier,
      // Explicitly null, not omitted: a row authored before the clipboard came
      // from the reservation still carries one, and saving must clear it rather
      // than leave a stale guest behind on an otherwise-updated scenario.
      booking: null,
      furniture: [],
      anchors: [],
      swaps,
      added,
      tags,
    };
  }

  function defaultLabel(o) {
    if (o.prim) return PRIMS.find((p) => p.prim === o.prim)?.label || 'Item';
    return (o.model || 'Item').replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  }

  async function save() {
    const payload = currentPayload();
    if (!payload.name) return toast.error('Give the scenario a name first.');

    const { faults, decoys } = scenarioCounts(payload);
    if (!faults) return toast.error('Tag at least one object as a fault, or there is nothing to find.');
    // A warning, not a block: a room whose only clickable things are faults
    // teaches students to flag whatever highlights.
    if (!decoys) toast.error('Saved — but with no clean decoys, every clickable item is a fault.');

    setBusy(true);
    try {
      if (editingId) {
        await api.patch(`/api/training/scenarios/${editingId}`, payload);
        toast.success(`“${payload.name}” updated.`);
      } else {
        const { data } = await api.post('/api/training/scenarios', payload);
        setEditingId(data.id);
        toast.success(`“${payload.name}” created.`);
      }
      load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  function openScenario(s) {
    setEditingId(s.id);
    setTier(s.roomTier);
    setName(s.name);
    // Legacy rows carry a full furniture snapshot; render those as authored.
    if (Array.isArray(s.furniture) && s.furniture.length) {
      const tagged = new Map((s.anchors || []).map((a) => [a.id, a]));
      setObjects(
        s.furniture.map((f) => {
          const a = tagged.get(f.id);
          return {
            ...f,
            id: f.id || nextId(),
            defectId: a ? a.defectId || null : undefined,
            label: a?.label,
          };
        })
      );
      setSelId(null);
      return;
    }
    // Otherwise rebuild from the CURRENT tier layout and lay the overlay on top,
    // so a room edited since this scenario was saved shows its new state.
    const swaps = s.swaps || {};
    const tagByRef = new Map((s.tags || []).map((t) => [t.ref, t]));
    const objs = seedFromTier(s.roomTier).map((o) => {
      const sw = swaps[o._ref];
      const model = typeof sw === 'string' ? sw : sw?.model;
      const ry = sw && typeof sw === 'object' && sw.ry !== undefined ? sw.ry : o.ry;
      const scale = sw && typeof sw === 'object' && sw.scale ? sw.scale : o.scale;
      const y = sw && typeof sw === 'object' && sw.y !== undefined ? sw.y : o.y;
      const t = tagByRef.get(o._ref);
      return {
        ...o,
        ...(model ? { model } : {}),
        ...(scale ? { scale } : {}),
        ...(y !== undefined ? { y } : {}),
        ry,
        defectId: t ? (t.defectId ?? null) : undefined,
        label: t?.label,
      };
    });
    for (const a of s.added || []) {
      const t = tagByRef.get(a.id);
      objs.push({ ...a, added: true, defectId: t ? (t.defectId ?? null) : undefined, label: t?.label });
    }
    setObjects(objs);
    setSelId(null);
  }

  function newScenario() {
    setEditingId(null);
    setName('');
    setObjects(seedFromTier(tier));
    setSelId(null);
  }

  async function toggleActive(s) {
    try {
      await api.patch(`/api/training/scenarios/${s.id}`, { active: !s.active });
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function remove(s) {
    try {
      await api.delete(`/api/training/scenarios/${s.id}`);
      if (editingId === s.id) newScenario();
      toast.success(`“${s.name}” deleted.`);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  // Preview runs the REAL inspection on this exact scenario, with recording
  // suppressed — an instructor checking their authoring must not land in
  // anyone's competency record.
  function previewAsStudent() {
    const p = currentPayload();
    // Counted through scenarioCounts, not p.anchors: currentPayload() ships
    // anchors empty on purpose (see there) and puts the tagging in `tags`, so
    // reading anchors here rejected every scenario however many faults it had.
    if (!scenarioCounts(p).faults) return toast.error('Tag a fault before previewing.');
    setPreview({ ...p, id: editingId || 'preview', active: true });
  }

  if (preview) {
    return (
      <InspectionShift
        room={{ number: 'PREVIEW', roomType: { name: preview.roomTier } }}
        scenario={preview}
        recordResult={false}
        onExit={() => setPreview(null)}
      />
    );
  }

  const faultCount = objects.filter((o) => o.defectId).length;
  const decoyCount = objects.filter((o) => o.defectId === null).length;

  return (
    <div className="se-wrap">
      <div className="se-side">
        <div className="se-head">
          <strong>Inspection Scenarios</strong>
          <button className="secondary small" onClick={onClose}>
            Close
          </button>
        </div>

        <label>Room tier</label>
        <select value={tier} onChange={(e) => setTier(e.target.value)} disabled={!!editingId}>
          {TIERS.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        {editingId && <p className="muted se-note">Tier is fixed once a scenario exists.</p>}

        <label>Scenario name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Couple in a twin room"
        />

        <div className="se-section">Booking on the clipboard</div>
        <p className="se-hint">
          Not authored here. The student inspects against the{' '}
          <strong>real reservation on the room</strong> — guest, party size and special requests all
          come from the PMS, so this scenario works on any {tier} room. A fault that booking cannot
          support (twin beds tagged for a couple, on a solo stay) is shown as a clean decoy rather
          than graded. Previewing as a student uses a practice booking, marked as such.
        </p>

        <div className="se-section">Fault categories</div>
        <p className="se-hint">
          The six built-in categories cover most faults. Anything you add here is saved to the shared library
          and offered on <strong>every scenario and every room</strong>.
        </p>
        <ul className="se-cat-list">
          {cats.map((c) => (
            <li key={c.id} className={c.custom ? 'se-cat is-custom' : 'se-cat'}>
              <span className="se-cat-label">{c.label}</span>
              {c.custom ? (
                <button type="button" className="se-cat-retire" onClick={() => retireCategory(c)}>
                  Retire
                </button>
              ) : (
                <span className="se-cat-builtin">built-in</span>
              )}
            </li>
          ))}
        </ul>
        <form onSubmit={saveCategory} className="se-cat-form">
          <input
            value={catForm.label}
            onChange={(e) => setCatForm({ ...catForm, label: e.target.value })}
            placeholder="Category name — e.g. Pest or sanitation hazard"
          />
          <textarea
            value={catForm.why}
            onChange={(e) => setCatForm({ ...catForm, why: e.target.value })}
            rows={2}
            placeholder="Why is this a fault? The student reads this after grading. (required)"
          />
          <textarea
            value={catForm.feedback}
            onChange={(e) => setCatForm({ ...catForm, feedback: e.target.value })}
            rows={2}
            placeholder="Coaching note shown when they miscategorise it (optional)"
          />
          <button disabled={catBusy}>{catBusy ? 'Saving…' : 'Add category'}</button>
        </form>

        <div className="se-section">Add an object</div>
        <select value={addKey} onChange={(e) => setAddKey(e.target.value)}>
          <optgroup label="Props (no 3D model)">
            {PRIMS.map((p) => (
              <option key={p.prim} value={p.prim}>
                {p.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Room assets">
            {MODEL_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </optgroup>
        </select>
        <button onClick={addObject} style={{ width: '100%', marginTop: 6 }}>
          Add to room
        </button>

        <div className="se-section">
          Selected object {sel ? '' : <span className="muted">— click one in the room</span>}
        </div>
        {sel && (
          <>
            {/* ── OBJECT ─────────────────────────────────────────────── */}
            <div className="se-group">
              <div className="se-group-h">Object</div>
              <div className="se-objname">{defaultLabel(sel)}</div>
              {sel.model && variantsFor(sel.model).length > 0 && (
                <>
                  <label>Swap this asset</label>
                  <div className="se-swaps">
                    {[sel.model, ...variantsFor(sel.model)].map((k) => (
                      <button
                        key={k}
                        type="button"
                        className={`se-swap${k === sel.model ? ' on' : ''}`}
                        title={k}
                        onClick={() => {
                          if (k === sel.model) return;
                          snapshot();
                          patchSel({ model: k });
                        }}
                      >
                        {labelFor(k)}
                      </button>
                    ))}
                  </div>
                  <p className="muted se-note">
                    Only the asset changes — position and size stay exactly as the room has them.
                  </p>
                </>
              )}
            </div>

            {/* ── PLACEMENT ──────────────────────────────────────────── */}
            <div className="se-group">
              <div className="se-group-h">Placement</div>
              <div className="row" style={{ gap: 4 }}>
                <button
                  className={mode === 'translate' ? '' : 'secondary'}
                  onClick={() => setMode('translate')}
                >
                  Move
                </button>
                <button className={mode === 'rotate' ? '' : 'secondary'} onClick={() => setMode('rotate')}>
                  Rotate
                </button>
              </div>
              <label>Horizontal rotation</label>
              <div className="se-yaw">
                <input
                  type="range"
                  min="0"
                  max="359"
                  step="1"
                  value={yawDeg}
                  onChange={(e) => setYaw(Number(e.target.value))}
                />
                <input
                  type="number"
                  className="se-yaw-num"
                  value={yawDeg}
                  onChange={(e) => setYaw(Number(e.target.value) || 0)}
                />
                <span className="muted">deg</span>
              </div>
              <div className="row" style={{ gap: 4 }}>
                <button
                  className="secondary"
                  onClick={() => {
                    snapshot();
                    setYaw(yawDeg - 90);
                  }}
                >
                  &#8630; 90
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    snapshot();
                    setYaw(yawDeg + 90);
                  }}
                >
                  &#8631; 90
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    snapshot();
                    setYaw(0);
                  }}
                >
                  Face front
                </button>
              </div>

              <label>Height off the floor</label>
              <div className="se-yaw">
                <input
                  type="range"
                  min="0"
                  max="3"
                  step="0.05"
                  value={Math.min(3, Math.max(0, heightM))}
                  onChange={(e) => setHeight(Number(e.target.value))}
                />
                <input
                  type="number"
                  className="se-yaw-num"
                  step="0.05"
                  value={heightM}
                  onChange={(e) => setHeight(Number(e.target.value))}
                />
                <span className="muted">m</span>
              </div>
              <div className="row" style={{ gap: 4 }}>
                <button
                  className="secondary"
                  onClick={() => {
                    snapshot();
                    setHeight(heightM - 0.1);
                  }}
                >
                  Down
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    snapshot();
                    setHeight(heightM + 0.1);
                  }}
                >
                  Up
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    snapshot();
                    setHeight(sel.added ? 0 : (sel._baseY ?? 0));
                  }}
                >
                  On the floor
                </button>
              </div>

              <label>Size</label>
              <div className="se-yaw">
                <input
                  type="range"
                  min="25"
                  max="300"
                  step="5"
                  value={Math.min(300, Math.max(25, sizePct))}
                  onChange={(e) => setSize(Number(e.target.value))}
                />
                <input
                  type="number"
                  className="se-yaw-num"
                  value={sizePct}
                  onChange={(e) => setSize(Number(e.target.value))}
                />
                <span className="muted">%</span>
              </div>
              <div className="row" style={{ gap: 4 }}>
                <button
                  className="secondary"
                  onClick={() => {
                    snapshot();
                    setSize(sizePct - 10);
                  }}
                >
                  Smaller
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    snapshot();
                    setSize(sizePct + 10);
                  }}
                >
                  Bigger
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    snapshot();
                    patchSel({ scale: sel.added ? [1, 1, 1] : sel._baseScale || [1, 1, 1] });
                  }}
                >
                  Reset
                </button>
              </div>
            </div>

            {/* ── FAULT ──────────────────────────────────────────────── */}
            <div className="se-group">
              <div className="se-group-h">What the student should find</div>
              <select
                value={
                  sel.defectId === undefined ? 'untagged' : sel.defectId === null ? 'clean' : sel.defectId
                }
                onChange={(e) => {
                  const v = e.target.value;
                  patchSel({ defectId: v === 'untagged' ? undefined : v === 'clean' ? null : v });
                }}
              >
                <option value="untagged">Not inspectable (scenery)</option>
                <option value="clean">Inspectable, but correct (decoy)</option>
                {offerableCategories().map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              {sel.defectId !== undefined && (
                <>
                  <label>Label shown to the student</label>
                  <input
                    value={sel.label ?? defaultLabel(sel)}
                    onChange={(e) => patchSel({ label: e.target.value })}
                  />
                  <p className="muted se-note">Name the object, never its condition.</p>
                </>
              )}
            </div>

            {/* ── ACTIONS ────────────────────────────────────────────── */}
            <div className="row" style={{ gap: 4, marginTop: 6 }}>
              <button className="secondary" onClick={duplicateSel}>
                Duplicate
              </button>
              <button className="danger" onClick={removeSel}>
                Delete
              </button>
            </div>
          </>
        )}

        <div className="se-section">
          {faultCount} fault{faultCount === 1 ? '' : 's'} · {decoyCount} decoy{decoyCount === 1 ? '' : 's'}
        </div>
        <div className="row" style={{ gap: 4 }}>
          <button onClick={save} disabled={busy}>
            {editingId ? 'Save changes' : 'Create scenario'}
          </button>
          <button className="secondary" onClick={previewAsStudent}>
            Preview
          </button>
        </div>
        <div className="row" style={{ gap: 4, marginTop: 4 }}>
          <button className="secondary" onClick={undo} disabled={!history.length}>
            Undo
          </button>
          <button className="secondary" onClick={newScenario}>
            New
          </button>
        </div>

        <div className="se-section">Saved scenarios</div>
        {scenarios.length === 0 && <p className="muted se-note">None yet.</p>}
        {scenarios.map((s) => (
          <div key={s.id} className={`se-row${editingId === s.id ? ' se-row-open' : ''}`}>
            <button className="se-open" onClick={() => openScenario(s)}>
              {s.name}
              <span className="muted"> · {s.roomTier}</span>
            </button>
            <button className="secondary small" onClick={() => toggleActive(s)} title="Show to students">
              {s.active ? 'On' : 'Off'}
            </button>
            <button className="danger small" onClick={() => remove(s)}>
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="se-stage">
        <Canvas
          shadows
          dpr={[1, 2]}
          camera={{ position: [7, 6, 7], fov: 50 }}
          gl={{ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.15 }}
          onCreated={({ gl }) => gl.setClearColor('#d8cdb8')}
          onPointerMissed={() => setSelId(null)}
        >
          <Bounds fit clip observe margin={1.1}>
            <RoomShell layout={{ ...base, furniture: [] }} />
            {objects.map((o) => (
              <EditorObject
                key={o.id}
                item={o}
                selected={o.id === selId}
                onSelect={(id) => setSelId(id)}
                objectRef={selObjRef}
              />
            ))}
          </Bounds>
          {sel && selObjRef.current && (
            <TransformControls
              object={selObjRef.current}
              mode={mode}
              translationSnap={0.1}
              rotationSnap={Math.PI / 12}
              // Rotation here is HORIZONTAL only — yaw about Y, the axis that
              // turns a fixture to face a different way on the floor.
              //
              // It used to be the one axis you could NOT use. showY was false
              // whenever mode was 'rotate', while showX/showZ defaulted to true,
              // so the gizmo offered exactly the two rings that tumble an object
              // onto its side — and commitGizmo() persists `ry` and nothing else,
              // so those rotations were applied on screen and then silently
              // discarded on mouse-up. Showing only the Y ring makes the gizmo
              // match what can actually be saved. (RoomLayoutEditor already did
              // this correctly; this editor was the outlier.)
              showX={mode !== 'rotate'}
              showZ={mode !== 'rotate'}
              // Y is available to EVERYTHING in translate mode. It used to be
              // gated on `!!sel.prim`, so a model fixture had no vertical arrow at
              // all — and even if you found one, commitGizmo() only persisted `y`
              // for prims, so the height was discarded on mouse-up. itemY() has
              // always honoured `y` for models; only the authoring was missing.
              showY={mode === 'rotate' || mode === 'translate'}
              onMouseDown={() => {
                snapshot();
                if (orbit.current) orbit.current.enabled = false;
              }}
              onMouseUp={() => {
                if (orbit.current) orbit.current.enabled = true;
                commitGizmo();
              }}
            />
          )}
          <OrbitControls ref={orbit} makeDefault />
        </Canvas>
        <div className="se-legend">
          🔴 tagged fault · click any object to select · the halo is editor-only, students never see it
        </div>
      </div>
    </div>
  );
}
