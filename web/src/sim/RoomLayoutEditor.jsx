import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, TransformControls, ContactShadows, RoundedBox, Bounds } from '@react-three/drei';
import * as THREE from 'three';
import { getRoomPlan, FOOTPRINTS, storedLayoutFor } from './roomLayouts';
import { hydrateRoomLayouts } from './layoutSync';
import api from '../api';
import { FixtureBody, itemY, MODEL_CFG } from './RoomFreeRoam';
import { MODELS, GLBoundary } from './task3d';
import {
  has,
  toggle,
  replace as replaceSel,
  rangeIn,
  selectAllLike,
  selectAllOfKind,
  selectAll,
  duplicateAll,
  deleteAll,
  nudgeAll,
  groupPivot,
  applyPivotDelta,
  countByKind,
} from './editorSelection';

// ─────────────────────────────────────────────────────────────────────────────
// Dev-only WYSIWYG layout editor — full customization.
//  • Add any asset (model .glb or procedural type) from the palette.
//  • Select + Move / Rotate / Resize furniture, walls and stations with the gizmo.
//  • Inspector: exact pos, rotation, scale, height (y), collision box, colour,
//    wall-mount + solid toggles; station title/emoji; room size/floor/spawn.
//  • Duplicate / Delete, Undo (Ctrl+Z), arrow-key nudge.
//  • "Copy block" emits the ENTIRE Presidential { walls, furniture, stations }
//    object to paste straight into roomLayouts.js.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n) => Math.round(n * 100) / 100;
const MODEL_KEYS = Object.keys(MODELS).sort();
const TYPE_KEYS = Object.keys(FOOTPRINTS).sort();

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
  const p = [];
  p.push(it.model ? `model: '${it.model}'` : `type: '${it.type}'`);
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
function wallLine(w) {
  return `      { p: [${r2(w.p[0])}, ${r2(w.p[1])}], w: ${r2(w.w)}, d: ${r2(w.d)}${w.ry ? `, ry: ${ryStr(w.ry)}` : ''}${w.c ? `, c: '${w.c}'` : ''} },`;
}
function stationLine(s) {
  const yPart = s.y != null ? ` y: ${r2(s.y)},` : '';
  return `      { key: '${s.key}', taskType: '${s.taskType}', title: '${s.title}', emoji: '${s.emoji}',${yPart} pos: [${r2(s.pos[0])}, ${r2(s.pos[1])}] },`;
}
function serializeBlock(tier, room, walls, furniture, stations) {
  const hPart = room.h && room.h !== 3 ? ` h: ${r2(room.h)},` : '';
  return (
    `  ${tier}: {\n    tier: '${tier}', w: ${r2(room.w)}, l: ${r2(room.l)},${hPart} spawn: [${r2(room.spawn[0])}, ${r2(room.spawn[1])}], floor: '${room.floor}',\n` +
    `    walls: [\n${walls.map(wallLine).join('\n')}\n    ],\n` +
    `    furniture: [\n${furniture.map(furnLine).join('\n')}\n    ],\n` +
    `    stations: [\n${stations.map(stationLine).join('\n')}\n    ],\n  },`
  );
}

const WALL_C = '#e3edef';

function Env({ room, _walls, _onPickWall, _sel }) {
  const W = room.w,
    L = room.l,
    H = room.h ?? 3;
  return (
    <group>
      <ambientLight intensity={0.7} />
      <directionalLight position={[4, 9, 5]} intensity={1.2} castShadow shadow-mapSize={[1024, 1024]} />
      <hemisphereLight args={['#fff7e8', '#6b5a44', 0.4]} />
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[W, L]} />
        <meshStandardMaterial color={room.floor || '#b88f5e'} roughness={0.8} />
      </mesh>
      <mesh position={[0, H / 2, -L / 2]}>
        <planeGeometry args={[W, H]} />
        <meshStandardMaterial color="#e7ddcc" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[-W / 2, H / 2, 0]} rotation-y={Math.PI / 2}>
        <planeGeometry args={[L, H]} />
        <meshStandardMaterial color={WALL_C} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[W / 2, H / 2, 0]} rotation-y={-Math.PI / 2}>
        <planeGeometry args={[L, H]} />
        <meshStandardMaterial color={WALL_C} side={THREE.DoubleSide} />
      </mesh>
      <ContactShadows position={[0, 0.02, 0]} opacity={0.3} scale={Math.max(W, L) + 4} blur={2.4} far={6} />
      <gridHelper args={[Math.max(W, L), Math.max(W, L), '#8a7f6a', '#6f6552']} position={[0, 0.015, 0]} />
    </group>
  );
}

export default function RoomLayoutEditor({ typeName = 'Presidential', onClose }) {
  const plan = useMemo(() => getRoomPlan(typeName), [typeName]);
  const fromPlan = () => ({
    furniture: plan.furniture.map((it) => ({ ...it, _hadRy: 'ry' in it })),
    walls: (plan.walls || []).map((w) => ({ ...w })),
    stations: plan.stations.map((s) => ({ ...s })),
    room: { w: plan.w, l: plan.l, h: plan.h ?? 3, floor: plan.floor || '#5a3d28', spawn: [...plan.spawn] },
  });
  // getRoomPlan already reflects the shared layout, so this is simply "what
  // everyone is currently looking at" — there is no browser-local draft any more.
  const initial = useMemo(() => fromPlan(), []);
  const [furniture, setFurniture] = useState(initial.furniture);
  const [walls, setWalls] = useState(initial.walls);
  const [stations, setStations] = useState(initial.stations);
  const [room, setRoom] = useState(initial.room);
  // idle | saving | saved | error — what the autosave is doing right now.
  const [saveState, setSaveState] = useState(storedLayoutFor(typeName) ? 'saved' : 'idle');
  const [saveError, setSaveError] = useState('');
  // A SET of { kind, i }. `single` is the one-item case, and every pre-existing
  // single-selection path (the three inspectors, patch(), scale) reads it, so
  // selecting one thing behaves exactly as it always did.
  const [sel, setSel] = useState([]);
  const [pivotEpoch, setPivotEpoch] = useState(0);
  const [pivotObj, setPivotObj] = useState(null);
  const [mode, setMode] = useState('translate');
  const [snap, setSnap] = useState(true);
  const [addKey, setAddKey] = useState('model:armchair');
  const [out, setOut] = useState('');

  const refs = { furniture: useRef({}), wall: useRef({}), station: useRef({}) };
  const orbit = useRef();
  const anchor = useRef(null); // last plain-clicked row, for shift-range in the lists
  const dragStart = useRef(null); // per-object transforms captured at gizmo mousedown
  const hist = useRef([]);
  const firstRun = useRef(true);

  // Autosave to the SHARED layout. Every browser reads this, so a save here
  // changes the room for everyone — which is the point.
  //
  // Debounced: dragging a fixture fires a state change per frame, and each save
  // appends a version. 800ms of stillness is what ends an edit.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setSaveState('saving');
    const t = setTimeout(() => {
      api
        .put(`/api/room-layouts/${encodeURIComponent(typeName)}`, {
          room,
          furniture,
          walls,
          stations,
        })
        .then(() => {
          setSaveState('saved');
          setSaveError('');
          // Keep this tab's own reads in step with what it just wrote.
          return hydrateRoomLayouts({ force: true });
        })
        .catch((e) => {
          setSaveState('error');
          setSaveError(e.response?.data?.error || e.message);
        });
    }, 800);
    return () => clearTimeout(t);
  }, [furniture, walls, stations, room, typeName]);

  // Drop every stored version for this tier, so it falls back to the layout
  // committed in roomLayouts.js — globally, not just here.
  async function resetToFile() {
    if (
      !window.confirm(`Discard the saved ${typeName} layout for EVERYONE and go back to the one in the code?`)
    ) {
      return;
    }
    try {
      await api.delete(`/api/room-layouts/${encodeURIComponent(typeName)}`);
      await hydrateRoomLayouts({ force: true });
      revertToFile();
      setSaveState('idle');
    } catch (e) {
      setSaveState('error');
      setSaveError(e.response?.data?.error || e.message);
    }
  }
  // Reset the editor's canvas to the committed layout. Does NOT touch the server
  // on its own — resetToFile() above does that first.
  function revertToFile() {
    const p = fromPlan();
    firstRun.current = true;
    setFurniture(p.furniture);
    setWalls(p.walls);
    setStations(p.stations);
    setRoom(p.room);
    setSel([]);
  }

  const snapshot = () => {
    hist.current.push(JSON.stringify({ furniture, walls, stations, room }));
    if (hist.current.length > 60) hist.current.shift();
  };
  const undo = () => {
    const s = hist.current.pop();
    if (!s) return;
    const d = JSON.parse(s);
    setFurniture(d.furniture);
    setWalls(d.walls);
    setStations(d.stations);
    setRoom(d.room);
    setSel([]);
  };

  const single = sel.length === 1 ? sel[0] : null;
  const multi = sel.length > 1;
  // The editor's three state arrays under their kind names — the shape every
  // editorSelection helper takes.
  const arrays = { furniture, wall: walls, station: stations };
  const setKind = { furniture: setFurniture, wall: setWalls, station: setStations };
  /** Push a whole {furniture, wall, station} result back into React state. */
  function applyArrays(next) {
    if (next.furniture !== furniture) setFurniture(next.furniture);
    if (next.wall !== walls) setWalls(next.wall);
    if (next.station !== stations) setStations(next.station);
  }
  /** Indices are ref keys, so any bulk reshuffle must drop the stale objects. */
  function dropRefs(kinds) {
    for (const k of kinds) refs[k].current = {};
  }

  const selObj = () => single && refs[single.kind].current[single.i];
  const selItem = () => (single ? arrays[single.kind][single.i] : null);

  const pivot = groupPivot(arrays, sel);

  // ── group gizmo ──
  // TransformControls binds exactly one Object3D, so a multi-selection is driven
  // through an invisible pivot group at the centroid: capture every selected
  // object's start transform on mousedown, mirror the pivot's delta onto them
  // live, then commit the same delta to the DATA on mouseup.
  function groupDragStart() {
    snapshot();
    if (orbit.current) orbit.current.enabled = false;
    dragStart.current = {
      px: pivot[0],
      pz: pivot[1],
      items: sel
        .map((r) => {
          const obj = refs[r.kind].current[r.i];
          return obj ? { obj, x: obj.position.x, z: obj.position.z, ry: obj.rotation.y } : null;
        })
        .filter(Boolean),
    };
  }
  function groupDragMove() {
    const st = dragStart.current;
    if (!st || !pivotObj) return;
    const dx = pivotObj.position.x - st.px;
    const dz = pivotObj.position.z - st.pz;
    const dRy = pivotObj.rotation.y;
    const cos = Math.cos(dRy);
    const sin = Math.sin(dRy);
    // Same Y-rotation convention as applyPivotDelta, so what you drag is what
    // gets committed.
    for (const m of st.items) {
      const rx = m.x - st.px;
      const rz = m.z - st.pz;
      m.obj.position.x = st.px + (rx * cos + rz * sin) + dx;
      m.obj.position.z = st.pz + (-rx * sin + rz * cos) + dz;
      m.obj.rotation.y = m.ry + dRy;
    }
  }
  function groupDragEnd() {
    if (orbit.current) orbit.current.enabled = true;
    const st = dragStart.current;
    if (st && pivotObj) {
      applyArrays(
        applyPivotDelta(arrays, sel, [st.px, st.pz], {
          dx: pivotObj.position.x - st.px,
          dz: pivotObj.position.z - st.pz,
          dRy: pivotObj.rotation.y,
        })
      );
    }
    dragStart.current = null;
    // Remount the pivot so it re-centres on the new centroid with rotation cleared.
    setPivotEpoch((n) => n + 1);
  }

  /** Click routing shared by the 3D scene and the side lists. */
  function pick(kind, i, e) {
    if (e?.shiftKey && anchor.current && anchor.current.kind === kind) {
      setSel((cur) => rangeIn(cur, kind, anchor.current.i, i));
      return;
    }
    if (e?.shiftKey || e?.metaKey || e?.ctrlKey) {
      setSel((cur) => toggle(cur, { kind, i }));
      anchor.current = { kind, i };
      return;
    }
    setSel(replaceSel({ kind, i }));
    anchor.current = { kind, i };
  }

  function commit() {
    const o = selObj();
    if (!o || !single) return;
    const sel = single; // one-item gizmo path — identical to before multi-select
    if (sel.kind === 'furniture')
      setFurniture((f) =>
        f.map((it, j) =>
          j === sel.i
            ? {
                ...it,
                pos: [r2(o.position.x), r2(o.position.z)],
                y: Math.abs(o.position.y) < 0.01 ? undefined : r2(o.position.y),
                ry: o.rotation.y,
                scale: [r2(o.scale.x), r2(o.scale.y), r2(o.scale.z)],
              }
            : it
        )
      );
    else if (sel.kind === 'wall') {
      if (mode === 'scale')
        setWalls((w) =>
          w.map((it, j) =>
            j === sel.i
              ? { ...it, w: Math.max(0.1, r2(it.w * o.scale.x)), d: Math.max(0.1, r2(it.d * o.scale.z)) }
              : it
          )
        );
      else
        setWalls((w) =>
          w.map((it, j) =>
            j === sel.i ? { ...it, p: [r2(o.position.x), r2(o.position.z)], ry: o.rotation.y } : it
          )
        );
    } else if (sel.kind === 'station')
      setStations((s) =>
        s.map((it, j) =>
          j === sel.i
            ? {
                ...it,
                pos: [r2(o.position.x), r2(o.position.z)],
                // Persist height like furniture, so a station can float over the bed
                // etc. ~0 collapses back to a floor ring (no `y` key).
                y: Math.abs(o.position.y) < 0.01 ? undefined : r2(o.position.y),
              }
            : it
        )
      );
  }

  // ── mutations ──
  function patch(patchObj) {
    if (!single) return;
    setKind[single.kind]((arr) => arr.map((it, j) => (j === single.i ? { ...it, ...patchObj } : it)));
  }
  function addAsset() {
    snapshot();
    const [kind, key] = addKey.split(':');
    let it;
    // Deliberately does NOT set `w`/`h`/`size`: a fixture-level fit value overrides
    // the MODEL_CFG default, so hardcoding one here would hand you a mis-scaled
    // model. (The old `w: MODEL_CFG[key]?.w ?? 1` was worse than it looks — most
    // keys now define `h` or `size` rather than `w`, so it silently fell through to
    // `w: 1` and rendered every new fixture one metre wide.) Omitting them lets the
    // model's real-world size apply, and the collision box is derived from it.
    if (kind === 'model') {
      const cfg = MODEL_CFG[key] || {};
      const box = cfg.size ? [cfg.size[0], cfg.size[2]] : [0.8, 0.8];
      it = { model: key, pos: [0, 0], ry: 0, box };
    } else {
      it = { type: key, pos: [0, 0], ry: 0 };
      if (['rug', 'panel', 'drape'].includes(key)) it.s = [2, 2];
    }
    setFurniture((f) => [...f, it]);
    setSel([{ kind: 'furniture', i: furniture.length }]);
  }
  function addWall() {
    snapshot();
    setWalls((w) => [...w, { p: [0, 0], w: 2, d: 0.2, c: '#9a9ba2' }]);
    setSel([{ kind: 'wall', i: walls.length }]);
  }
  function addStation() {
    snapshot();
    const n = stations.length;
    setStations((s) => [
      ...s,
      { key: `custom${n}`, taskType: 'inspect', title: 'New Station', emoji: '⭐', pos: [0, 0] },
    ]);
    setSel([{ kind: 'station', i: n }]);
  }
  function removeSel() {
    if (!sel.length) return;
    snapshot();
    // Filter against an index SET rather than splicing one at a time: sequential
    // splices renumber the array under the remaining indices and delete the
    // wrong rows. deleteAll() is unit-tested for exactly that.
    dropRefs(Object.keys(countByKind(sel)));
    applyArrays(deleteAll(arrays, sel));
    setSel([]);
  }
  function duplicateSel() {
    if (!sel.length) return;
    snapshot();
    // One uniform offset is what preserves the arrangement — duplicating a laid
    // floor gives you the same floor beside it rather than a pile.
    const { arrays: next, sel: clones } = duplicateAll(arrays, sel, 0.4);
    applyArrays(next);
    setSel(clones);
    setPivotEpoch((n) => n + 1);
  }

  // keyboard: delete / undo / nudge
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')
        return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) {
        e.preventDefault();
        removeSel();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSel();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSel(selectAll(arrays));
      } else if (sel.length && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        snapshot();
        const dx = e.key === 'ArrowRight' ? 0.1 : e.key === 'ArrowLeft' ? -0.1 : 0;
        const dz = e.key === 'ArrowDown' ? 0.1 : e.key === 'ArrowUp' ? -0.1 : 0;
        applyArrays(nudgeAll(arrays, sel, dx, dz));
        setPivotEpoch((n) => n + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const item = selItem();

  return (
    <div
      // Claims the keyboard from the app's global shortcuts — see
      // components/KeyboardShortcuts.jsx. Without this, `d` navigates to the
      // dashboard and throws away the editing session, and Delete/⌘Z/arrows
      // compete with navigation shortcuts.
      data-keyboard-capture=""
      style={{
        position: 'fixed',
        inset: 0,
        // Must clear the app chrome: `.cb-topbar` is sticky at z-index 100. This used to
        // be 50, which was fine when the editor lived on the standalone /sim-demo page —
        // inside the app shell the header painted over the editor's own title bar and
        // mode toolbar. 400 matches `.cg-overlay`, the mini-game overlay convention.
        zIndex: 400,
        background: '#cfc4ad',
        display: 'flex',
        fontSize: 13,
        color: '#e7ecf2',
      }}
    >
      {/* ── LEFT: palette + lists + room ── */}
      <div style={{ width: 250, background: '#1f242c', display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            padding: '10px 12px',
            fontWeight: 700,
            borderBottom: '1px solid #333b46',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>Layout editor · {typeName}</span>
          <button onClick={onClose} style={icobtn}>
            ✕
          </button>
        </div>
        <div style={{ padding: 8, borderBottom: '1px solid #333b46' }}>
          <div style={{ fontSize: 11, color: '#9aa6b2', marginBottom: 4 }}>ADD ASSET</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <select
              value={addKey}
              onChange={(e) => setAddKey(e.target.value)}
              style={{
                flex: 1,
                background: '#2a313b',
                color: '#e7ecf2',
                border: '1px solid #3a4452',
                borderRadius: 5,
                padding: 4,
              }}
            >
              <optgroup label="Models (.glb)">
                {MODEL_KEYS.map((k) => (
                  <option key={k} value={`model:${k}`}>
                    {k}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Procedural types">
                {TYPE_KEYS.map((k) => (
                  <option key={k} value={`type:${k}`}>
                    {k}
                  </option>
                ))}
              </optgroup>
            </select>
            <button onClick={addAsset} style={btn(true)}>
              Add
            </button>
          </div>
          <PalettePreview addKey={addKey} />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button onClick={addWall} style={btn(false)}>
              + Wall
            </button>
            <button onClick={addStation} style={btn(false)}>
              + Station
            </button>
          </div>
          <div style={{ fontSize: 11, color: '#9aa6b2', margin: '10px 0 4px' }}>SELECT</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              onClick={() => sel.length && setSel(selectAllLike(arrays, sel[sel.length - 1]))}
              disabled={!sel.length}
              title="Every fixture sharing this model — the whole floor in one click"
              style={{ ...btn(false), opacity: sel.length ? 1 : 0.45 }}
            >
              All like this
            </button>
            <button
              onClick={() => setSel(selectAll(arrays))}
              style={btn(false)}
              title="Everything, walls included"
            >
              All
            </button>
            <button onClick={() => setSel(selectAllOfKind(arrays, 'furniture'))} style={btn(false)}>
              Furniture
            </button>
            <button onClick={() => setSel(selectAllOfKind(arrays, 'wall'))} style={btn(false)}>
              Walls
            </button>
            <button
              onClick={() => setSel([])}
              disabled={!sel.length}
              style={{ ...btn(false), opacity: sel.length ? 1 : 0.45 }}
            >
              None
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <List
            title={`Furniture (${furniture.length})`}
            items={furniture}
            kind="furniture"
            sel={sel}
            onPick={pick}
            label={(it) => it.model || it.type}
          />
          <List
            title={`Walls (${walls.length})`}
            items={walls}
            kind="wall"
            sel={sel}
            onPick={pick}
            label={() => 'wall'}
          />
          <List
            title={`Stations (${stations.length})`}
            items={stations}
            kind="station"
            sel={sel}
            onPick={pick}
            label={(it) => it.title}
          />
        </div>
        <div style={{ padding: 8, borderTop: '1px solid #333b46' }}>
          <div style={{ fontSize: 11, color: '#9aa6b2', marginBottom: 4 }}>ROOM</div>
          <Row>
            <Lbl>floor</Lbl>
            <input
              type="color"
              value={room.floor}
              onChange={(e) => setRoom({ ...room, floor: e.target.value })}
              style={{ width: 38, height: 22, background: 'none', border: 'none' }}
            />
            <span style={{ fontSize: 11 }}>{room.floor}</span>
          </Row>
          <Row>
            <Lbl>width</Lbl>
            <Num v={room.w} on={(n) => setRoom({ ...room, w: n })} />
            <Lbl>length</Lbl>
            <Num v={room.l} on={(n) => setRoom({ ...room, l: n })} />
          </Row>
          <Row>
            <Lbl>height</Lbl>
            <Num v={room.h ?? 3} step={0.25} on={(n) => setRoom({ ...room, h: n })} />
          </Row>
          <Row>
            <Lbl>spawn</Lbl>
            <Num v={room.spawn[0]} on={(n) => setRoom({ ...room, spawn: [n, room.spawn[1]] })} />
            <Num v={room.spawn[1]} on={(n) => setRoom({ ...room, spawn: [room.spawn[0], n] })} />
          </Row>
          <div
            style={{
              fontSize: 11,
              color: saveState === 'error' ? '#ff8f8f' : saveState === 'saved' ? '#6fcf97' : '#9aa6b2',
              margin: '8px 0 4px',
            }}
          >
            {saveState === 'saving'
              ? '⏳ Saving for everyone…'
              : saveState === 'saved'
                ? '✅ Saved — live for every browser'
                : saveState === 'error'
                  ? `⚠ Not saved: ${saveError}`
                  : 'edits save for everyone as you go'}
          </div>
          <button
            onClick={() => {
              const s = serializeBlock(typeName, room, walls, furniture, stations);
              setOut(s);
              navigator.clipboard?.writeText(s).catch(() => {});
            }}
            style={{ ...btn(true), width: '100%', padding: 8 }}
          >
            Copy block → clipboard
          </button>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button onClick={undo} style={{ ...btn(false), flex: 1 }}>
              Undo (⌘Z)
            </button>
            <button onClick={resetToFile} style={{ ...btn(false), flex: 1 }}>
              Reset to file
            </button>
          </div>
        </div>
      </div>

      {/* ── CENTER: 3D ── */}
      <div style={{ flex: 1, position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            left: 12,
            top: 12,
            zIndex: 2,
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            background: 'rgba(17,21,27,0.85)',
            padding: 6,
            borderRadius: 8,
          }}
        >
          <button onClick={() => setMode('translate')} style={btn(mode === 'translate')}>
            Move
          </button>
          <button onClick={() => setMode('rotate')} style={btn(mode === 'rotate')}>
            Rotate
          </button>
          <button onClick={() => setMode('scale')} style={btn(mode === 'scale')}>
            Resize
          </button>
          <label style={{ fontSize: 11, marginLeft: 6 }}>
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> snap
          </label>
          {multi && (
            <span style={{ fontSize: 11, color: '#fbbf24', marginLeft: 6 }}>
              {sel.length} selected · {countByKind(sel).furniture}f {countByKind(sel).wall}w{' '}
              {countByKind(sel).station}s
            </span>
          )}
          {!multi && item && (
            <span style={{ fontSize: 11, color: '#9aa6b2', marginLeft: 6 }}>
              {single.kind}: {item.model || item.type || item.title}
            </span>
          )}
        </div>
        <Canvas
          shadows
          dpr={[1, 2]}
          camera={{ position: [0, 13, 12], fov: 50, near: 0.1, far: 120 }}
          onCreated={({ gl }) => gl.setClearColor('#cfc4ad')}
          onPointerMissed={() => setSel([])}
        >
          <Env room={room} walls={walls} />
          {furniture.map((it, i) => (
            <group
              key={`f${i}`}
              ref={(el) => {
                if (el) refs.furniture.current[i] = el;
              }}
              position={[it.pos[0], itemY(it), it.pos[1]]}
              rotation={[0, it.ry || 0, 0]}
              scale={it.scale || [1, 1, 1]}
              onClick={(e) => {
                e.stopPropagation();
                pick('furniture', i, e);
              }}
            >
              <GLBoundary fallback={null}>
                <FixtureBody item={it} />
              </GLBoundary>
            </group>
          ))}
          {walls.map((w, i) => (
            <group
              key={`w${i}`}
              ref={(el) => {
                if (el) refs.wall.current[i] = el;
              }}
              position={[w.p[0], (room.h ?? 3) / 2, w.p[1]]}
              rotation={[0, w.ry || 0, 0]}
              scale={[1, 1, 1]}
              onClick={(e) => {
                e.stopPropagation();
                pick('wall', i, e);
              }}
            >
              <RoundedBox args={[w.w, room.h ?? 3, w.d]} radius={0.01}>
                <meshStandardMaterial color={w.c || '#cdb391'} />
              </RoundedBox>
            </group>
          ))}
          {stations.map((s, i) => (
            <group
              key={`s${i}`}
              ref={(el) => {
                if (el) refs.station.current[i] = el;
              }}
              // Group sits at the station's real height; the ring is offset a hair
              // above the group origin so a floor station (y=0) still reads, and the
              // gizmo's Y drag maps 1:1 to the stored `y` with no drift.
              position={[s.pos[0], s.y ?? 0, s.pos[1]]}
              onClick={(e) => {
                e.stopPropagation();
                pick('station', i, e);
              }}
            >
              <mesh rotation-x={-Math.PI / 2} position-y={0.04}>
                <ringGeometry args={[0.42, 0.6, 32]} />
                <meshBasicMaterial
                  color={has(sel, 'station', i) ? '#fbbf24' : '#38bdf8'}
                  transparent
                  opacity={0.7}
                  side={THREE.DoubleSide}
                />
              </mesh>
              <mesh position={[0, 0.5, 0]}>
                <sphereGeometry args={[0.08, 10, 10]} />
                <meshBasicMaterial color="#38bdf8" />
              </mesh>
            </group>
          ))}
          {/* Amber floor rings mark a multi-selection. depthTest off so a marker
              under the bed is still visible while you work. */}
          {multi &&
            sel.map((r) => {
              const it = arrays[r.kind]?.[r.i];
              if (!it) return null;
              const [mx, mz] = r.kind === 'wall' ? it.p : it.pos;
              return (
                <mesh key={`mk${r.kind}${r.i}`} rotation-x={-Math.PI / 2} position={[mx, 0.03, mz]}>
                  <ringGeometry args={[0.3, 0.44, 24]} />
                  <meshBasicMaterial
                    color="#fbbf24"
                    transparent
                    opacity={0.9}
                    side={THREE.DoubleSide}
                    depthTest={false}
                  />
                </mesh>
              );
            })}
          {/* Invisible pivot the group gizmo drives. Keyed so it remounts at the
              fresh centroid after every commit. */}
          {multi && <group key={pivotEpoch} ref={setPivotObj} position={[pivot[0], 0.01, pivot[1]]} />}
          {multi && pivotObj && (
            <TransformControls
              object={pivotObj}
              // Group SCALE is deliberately unsupported: a wall stores w/d while
              // furniture stores a scale triple, so one gizmo handle has no single
              // correct meaning and would silently deform walls.
              mode={mode === 'scale' ? 'translate' : mode}
              translationSnap={snap ? 0.1 : null}
              rotationSnap={snap ? Math.PI / 12 : null}
              showX={mode !== 'rotate'}
              showZ={mode !== 'rotate'}
              showY={mode === 'rotate'}
              onMouseDown={groupDragStart}
              onObjectChange={groupDragMove}
              onMouseUp={groupDragEnd}
            />
          )}
          {single &&
            selObj() &&
            (() => {
              const m = single.kind === 'station' ? 'translate' : mode; // stations move only; walls + furniture use the active mode
              return (
                <TransformControls
                  object={selObj()}
                  mode={m}
                  translationSnap={snap ? 0.1 : null}
                  rotationSnap={snap ? Math.PI / 12 : null}
                  scaleSnap={snap ? 0.1 : null}
                  showX={m !== 'rotate'}
                  showZ={m !== 'rotate'}
                  showY={
                    m === 'translate' || m === 'rotate' || (m === 'scale' && single.kind === 'furniture')
                  }
                  onMouseDown={() => {
                    snapshot();
                    if (orbit.current) orbit.current.enabled = false;
                  }}
                  onMouseUp={() => {
                    if (orbit.current) orbit.current.enabled = true;
                    commit();
                  }}
                />
              );
            })()}
          <OrbitControls ref={orbit} makeDefault target={[0, 0.8, 0]} maxPolarAngle={Math.PI / 2.05} />
        </Canvas>
        {out && (
          <textarea
            readOnly
            value={out}
            onFocus={(e) => e.target.select()}
            style={{
              position: 'absolute',
              right: 12,
              bottom: 12,
              width: 480,
              height: 220,
              fontFamily: 'monospace',
              fontSize: 10.5,
              padding: 8,
              background: '#11151b',
              color: '#cfe',
              border: '1px solid #333b46',
              borderRadius: 6,
              resize: 'both',
            }}
          />
        )}
      </div>

      {/* ── RIGHT: inspector ── */}
      <div
        style={{
          width: 232,
          background: '#1f242c',
          borderLeft: '1px solid #333b46',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '10px 12px', fontWeight: 700, borderBottom: '1px solid #333b46' }}>
          Inspector
        </div>
        {!sel.length && (
          <div style={{ padding: 12, color: '#9aa6b2', fontSize: 12, lineHeight: 1.6 }}>
            Select an item (list or 3D) to edit its properties.
            <div style={{ marginTop: 10, color: '#7d8a99' }}>
              ⇧-click adds to the selection · ⇧-click a list row for a range · ⌘A all · ⌘D duplicate
            </div>
          </div>
        )}
        {multi && <MultiSummary sel={sel} />}
        {item && single.kind === 'furniture' && <FurnitureInspector it={item} patch={patch} />}
        {item && single.kind === 'wall' && <WallInspector it={item} patch={patch} />}
        {item && single.kind === 'station' && <StationInspector it={item} patch={patch} />}
        {!!sel.length && (
          <div
            style={{ marginTop: 'auto', padding: 8, borderTop: '1px solid #333b46', display: 'flex', gap: 6 }}
          >
            <button onClick={duplicateSel} style={btn(false)}>
              Duplicate{multi ? ` ${sel.length}` : ''}
            </button>
            <button
              onClick={removeSel}
              style={{ ...btn(false), background: '#7a2f2f', borderColor: '#9a3f3f', flex: 1 }}
            >
              Delete{multi ? ` ${sel.length}` : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Inspector panels ──
function MultiSummary({ sel }) {
  const c = countByKind(sel);
  return (
    <div style={{ padding: 10, fontSize: 12, lineHeight: 1.7 }}>
      <div style={{ fontWeight: 700, color: '#fbbf24' }}>{sel.length} items selected</div>
      <div style={{ color: '#9aa6b2' }}>
        {c.furniture} furniture · {c.wall} walls · {c.station} stations
      </div>
      <div style={{ marginTop: 10, color: '#7d8a99' }}>
        The gizmo moves and rotates the whole group about its centre. Per-item fields are editable one at a
        time — select a single item to see them.
      </div>
      <div style={{ marginTop: 8, color: '#7d8a99' }}>
        Scale is single-selection only: walls store width/depth while furniture stores a scale triple, so one
        handle cannot mean both.
      </div>
    </div>
  );
}
function FurnitureInspector({ it, patch }) {
  const sc = it.scale || [1, 1, 1];
  const box = it.box || null;
  return (
    <div style={{ padding: 10, overflowY: 'auto' }}>
      <div style={{ fontSize: 11, color: '#9aa6b2', marginBottom: 6 }}>
        {it.model ? `model · ${it.model}` : `type · ${it.type}`}
      </div>
      <Field label="pos x/z">
        <Num v={it.pos[0]} on={(n) => patch({ pos: [n, it.pos[1]] })} />
        <Num v={it.pos[1]} on={(n) => patch({ pos: [it.pos[0], n] })} />
      </Field>
      <Field label="rotation°">
        <Num
          v={Math.round(((it.ry || 0) * 180) / Math.PI)}
          step={15}
          on={(d) => patch({ ry: (d * Math.PI) / 180, _hadRy: true })}
        />
      </Field>
      <Field label="scale x/y/z">
        <Num v={sc[0]} step={0.1} on={(n) => patch({ scale: [n, sc[1], sc[2]] })} />
        <Num v={sc[1]} step={0.1} on={(n) => patch({ scale: [sc[0], n, sc[2]] })} />
        <Num v={sc[2]} step={0.1} on={(n) => patch({ scale: [sc[0], sc[1], n] })} />
      </Field>
      {it.model && (
        <Field label="fit width (w)">
          <Num v={it.w ?? 1} step={0.1} on={(n) => patch({ w: n })} />
        </Field>
      )}
      {it.s && (
        <Field label="size s (w/h)">
          <Num v={it.s[0]} step={0.1} on={(n) => patch({ s: [n, it.s[1]] })} />
          <Num v={it.s[1]} step={0.1} on={(n) => patch({ s: [it.s[0], n] })} />
        </Field>
      )}
      <Field label="height (y)">
        <Num v={it.y ?? 0} step={0.1} on={(n) => patch({ y: n })} />
      </Field>
      <Field label="wall-mounted">
        <input
          type="checkbox"
          checked={!!it.wall}
          onChange={(e) => patch(e.target.checked ? { wall: true, y: it.y ?? 1.7 } : { wall: undefined })}
        />
      </Field>
      <Field label="solid (collision)">
        <input
          type="checkbox"
          checked={!!box}
          onChange={(e) => patch(e.target.checked ? { box: [it.w ?? 1, it.w ?? 1] } : { box: undefined })}
        />
      </Field>
      {box && (
        <Field label="box w/d">
          <Num v={box[0]} step={0.1} on={(n) => patch({ box: [n, box[1]] })} />
          <Num v={box[1]} step={0.1} on={(n) => patch({ box: [box[0], n] })} />
        </Field>
      )}
      <Field label="colour (c)">
        <input
          type="color"
          value={it.c || '#888888'}
          onChange={(e) => patch({ c: e.target.value })}
          style={swatch}
        />
        {it.c && (
          <button onClick={() => patch({ c: undefined })} style={miniBtn}>
            clear
          </button>
        )}
      </Field>
    </div>
  );
}
function WallInspector({ it, patch }) {
  return (
    <div style={{ padding: 10 }}>
      <div style={{ fontSize: 11, color: '#9aa6b2', marginBottom: 6 }}>interior wall</div>
      <Field label="pos x/z">
        <Num v={it.p[0]} on={(n) => patch({ p: [n, it.p[1]] })} />
        <Num v={it.p[1]} on={(n) => patch({ p: [it.p[0], n] })} />
      </Field>
      <Field label="rotation°">
        <Num
          v={Math.round(((it.ry || 0) * 180) / Math.PI)}
          step={15}
          on={(d) => patch({ ry: (d * Math.PI) / 180 })}
        />
      </Field>
      <Field label="width (x)">
        <Num v={it.w} step={0.1} on={(n) => patch({ w: n })} />
      </Field>
      <Field label="depth (z)">
        <Num v={it.d} step={0.1} on={(n) => patch({ d: n })} />
      </Field>
      <Field label="colour">
        <input
          type="color"
          value={it.c || '#9a9ba2'}
          onChange={(e) => patch({ c: e.target.value })}
          style={swatch}
        />
      </Field>
    </div>
  );
}
function StationInspector({ it, patch }) {
  return (
    <div style={{ padding: 10 }}>
      <div style={{ fontSize: 11, color: '#9aa6b2', marginBottom: 6 }}>station · {it.key}</div>
      <Field label="pos x/z">
        <Num v={it.pos[0]} on={(n) => patch({ pos: [n, it.pos[1]] })} />
        <Num v={it.pos[1]} on={(n) => patch({ pos: [it.pos[0], n] })} />
      </Field>
      <Field label="height (y)">
        <Num v={it.y ?? 0} step={0.1} on={(n) => patch({ y: n || undefined })} />
      </Field>
      <Field label="title">
        <input value={it.title} onChange={(e) => patch({ title: e.target.value })} style={txt} />
      </Field>
      <Field label="emoji">
        <input
          value={it.emoji}
          onChange={(e) => patch({ emoji: e.target.value })}
          style={{ ...txt, width: 50 }}
        />
      </Field>
      <Field label="taskType">
        <input value={it.taskType} onChange={(e) => patch({ taskType: e.target.value })} style={txt} />
      </Field>
    </div>
  );
}

// ── Live 3D preview of the currently-selected palette asset (auto-rotating) ──
function SpinGroup({ children }) {
  const ref = useRef();
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.5;
  });
  return <group ref={ref}>{children}</group>;
}
function PalettePreview({ addKey }) {
  const [kind, key] = addKey.split(':');
  const item = useMemo(() => (kind === 'model' ? { model: key } : { type: key }), [addKey]);
  return (
    <div
      style={{
        height: 132,
        background: '#11151b',
        borderRadius: 6,
        marginTop: 6,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <span style={{ position: 'absolute', left: 6, top: 4, fontSize: 10, color: '#6b7480', zIndex: 1 }}>
        preview
      </span>
      <Canvas camera={{ position: [1.9, 1.5, 2.3], fov: 45 }} dpr={[1, 1.5]}>
        <ambientLight intensity={0.95} />
        <directionalLight position={[3, 5, 3]} intensity={1.1} />
        <hemisphereLight args={['#ffffff', '#444a55', 0.5]} />
        <Suspense fallback={null}>
          <GLBoundary key={addKey} fallback={null}>
            <Bounds fit clip margin={1.35}>
              <SpinGroup>
                <FixtureBody item={item} />
              </SpinGroup>
            </Bounds>
          </GLBoundary>
        </Suspense>
      </Canvas>
    </div>
  );
}

// ── tiny UI atoms ──
function List({ title, items, kind, sel, onPick, label }) {
  return (
    <div>
      <div
        style={{
          padding: '6px 12px',
          fontSize: 11,
          color: '#9aa6b2',
          background: '#262d36',
          position: 'sticky',
          top: 0,
        }}
      >
        {title}
      </div>
      {items.map((it, i) => (
        <div
          key={i}
          onClick={(e) => onPick(kind, i, e)}
          style={{
            padding: '4px 14px',
            cursor: 'pointer',
            background: has(sel, kind, i) ? '#2f6fb0' : 'transparent',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {i}· {label(it)}
        </div>
      ))}
    </div>
  );
}
function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: '#9aa6b2', marginBottom: 3 }}>{label}</div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>{children}</div>
    </div>
  );
}
function Num({ v, on, step = 0.1 }) {
  return (
    <input
      type="number"
      step={step}
      value={v}
      onChange={(e) => on(parseFloat(e.target.value) || 0)}
      style={{
        width: 56,
        background: '#2a313b',
        color: '#e7ecf2',
        border: '1px solid #3a4452',
        borderRadius: 4,
        padding: '3px 5px',
        fontSize: 12,
      }}
    />
  );
}
function Row({ children }) {
  return <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginBottom: 5 }}>{children}</div>;
}
function Lbl({ children }) {
  return <span style={{ fontSize: 11, color: '#9aa6b2', width: 34 }}>{children}</span>;
}
const swatch = { width: 40, height: 24, background: 'none', border: '1px solid #3a4452', borderRadius: 4 };
const txt = {
  flex: 1,
  background: '#2a313b',
  color: '#e7ecf2',
  border: '1px solid #3a4452',
  borderRadius: 4,
  padding: '3px 5px',
  fontSize: 12,
};
const miniBtn = {
  background: '#2a313b',
  color: '#9aa6b2',
  border: '1px solid #3a4452',
  borderRadius: 4,
  fontSize: 10,
  cursor: 'pointer',
};
const icobtn = { background: 'none', border: 'none', color: '#9aa6b2', cursor: 'pointer', fontSize: 16 };
function btn(active) {
  return {
    padding: '5px 9px',
    borderRadius: 5,
    border: '1px solid #3a4452',
    cursor: 'pointer',
    background: active ? '#2f6fb0' : '#2a313b',
    color: '#e7ecf2',
    fontSize: 12,
  };
}
