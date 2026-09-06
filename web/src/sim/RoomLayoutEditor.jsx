import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, TransformControls, ContactShadows, RoundedBox, Bounds } from '@react-three/drei';
import * as THREE from 'three';
import { getRoomPlan, FOOTPRINTS, storedLayoutFor } from './roomLayouts';
import { hydrateRoomLayouts } from './layoutSync';
import api from '../api';
import { FixtureBody, itemY, MODEL_CFG } from './RoomFreeRoam';
import Icon from '../components/Icon';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { useTheme } from '../theme';
import { stageColor } from './stageColor';
import SaveChip from './SaveChip';
import { MODELS, GLBoundary } from './task3d';
import { hydrateAssets, onAssetsChanged, uploadedAssets, uploadAsset } from './assetSync';
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
//  • Duplicate / Delete, Undo (Ctrl+Z), Redo (⇧Ctrl+Z), arrow-key nudge.
//  • Edits autosave to the shared layout — every browser sees them at once.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n) => Math.round(n * 100) / 100;
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
// Emits the whole tier as a literal { walls, furniture, stations } block for
// pasting into roomLayouts.js.
//
// CURRENTLY UNREFERENCED. The button that called it has been removed from the
// panel, and layouts autosave to the server, so hand-pasting into source is no
// longer how a layout ships. Kept rather than deleted because it is the only
// code that knows how to turn live editor state back into the source format —
// re-deriving that is a morning's work, and re-adding a caller is one line. It
// tree-shakes out of the build, so it costs nothing but these lines.
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

// Bare-key gizmo shortcuts. T for the scale gizmo because it is the Transform
// handle in the tools this editor is modelled on, and S is already spoken for
// by ⌘S habits.
const GIZMO_KEYS = { m: 'translate', r: 'rotate', t: 'scale' };

// stageColor lives in ./stageColor.js — the free-roam room, the inspection
// shift and the scenario editor need the same value, and each of them used to
// carry its own copy of the same literal.

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

// `isNew` opens the editor on a layout that does NOT exist on the server yet.
// It gates the autosave: a brand-new layout is not written until the author
// says so, because autosave-from-the-first-keystroke would publish an empty
// room to every browser the instant the editor opened. `seed` is that starting
// room — dimensions only; everything in it is placed by hand.
export default function RoomLayoutEditor({
  typeName = 'Presidential',
  onClose,
  isNew = false,
  seed = null,
  // Called after "Save as" writes a copy under a new key, so the page can
  // re-point the editor at it — the author is now editing the new layout, not
  // the one they branched from.
  onSavedAs,
}) {
  const plan = useMemo(() => {
    if (isNew) {
      const base = getRoomPlan(typeName);
      return {
        ...base,
        w: seed?.w ?? base.w,
        l: seed?.l ?? base.l,
        // An empty room, not a copy of whatever tier this folds to. Starting
        // from Standard's furniture would make "new layout" mean "duplicate".
        furniture: [],
        walls: [],
        stations: [],
        spawn: [0, 0],
      };
    }
    return getRoomPlan(typeName);
  }, [typeName, isNew, seed]);
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
  const confirm = useConfirm();
  const toast = useToast();
  const [saveState, setSaveState] = useState(storedLayoutFor(typeName) ? 'saved' : 'idle');
  // Flipped false by the first successful save; after that this editor behaves
  // exactly as it always has.
  const [needsFirstSave, setNeedsFirstSave] = useState(isNew);
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
  // Panel visibility. Purely layout — collapsing a panel unmounts nothing that
  // holds editing state, so reopening one shows exactly what it showed before.
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const glRef = useRef(null);
  const { theme, toggle: toggleTheme } = useTheme();

  // Repaint the 3D backdrop when the theme flips or the accent is re-tinted.
  // Every other surface in the editor is a CSS variable and follows on its own;
  // the WebGL clear colour is the one value the browser will not update for us,
  // because it was copied into the renderer at creation time.
  //
  // Watches the <html> attributes as well as `theme`: the accent changer writes
  // custom properties onto the root element without touching this component, so
  // a theme-only dependency would leave the stage on the previous palette.
  useEffect(() => {
    const repaint = () => glRef.current?.setClearColor(stageColor());
    repaint();
    const mo = new MutationObserver(repaint);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => mo.disconnect();
  }, [theme]);

  const refs = { furniture: useRef({}), wall: useRef({}), station: useRef({}) };
  const orbit = useRef();
  const anchor = useRef(null); // last plain-clicked row, for shift-range in the lists
  const dragStart = useRef(null); // per-object transforms captured at gizmo mousedown
  const hist = useRef([]);
  // The redo branch. A ref like `hist`, plus a counter that exists only to make
  // the two toolbar buttons re-render when the stacks change — a ref mutation
  // is invisible to React, so without it Undo and Redo would never grey out.
  const redo = useRef([]);
  const [histEpoch, setHistEpoch] = useState(0);
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
    // A layout that does not exist yet is not autosaved. Until the author
    // presses Save the first time there is nothing on the server to keep in
    // step — and writing one would publish a half-placed room to every browser
    // reading this tier.
    if (needsFirstSave) return;
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
  }, [furniture, walls, stations, room, typeName, needsFirstSave]);

  // The explicit first save. Same payload as the autosave, so version 1 of a new
  // layout is shaped exactly like every version after it — and once it lands,
  // autosave takes over for the rest of the session.
  async function saveFirst() {
    setSaveState('saving');
    try {
      await api.put(`/api/room-layouts/${encodeURIComponent(typeName)}`, {
        room,
        furniture,
        walls,
        stations,
      });
      setNeedsFirstSave(false);
      setSaveState('saved');
      setSaveError('');
      await hydrateRoomLayouts({ force: true });
      toast.success(`${typeName} layout saved — autosave is on from here.`);
    } catch (e) {
      setSaveState('error');
      setSaveError(e.response?.data?.error || e.message);
      toast.error(e.response?.data?.error || e.message);
    }
  }

  // Save the room currently on screen as a NEW layout under its own name.
  //
  // The point of it is branching: the four committed tiers are the only rooms
  // that exist, so authoring a fifth meant starting from an empty floor. This
  // takes what is in front of you — a Suite you have half-rearranged — and
  // makes it the first version of "Cabana", leaving the Suite untouched.
  //
  // Once written it behaves like any other saved layout, which is what makes
  // autosave safe to hand over: there is now a row to keep in step with.
  async function saveAs() {
    const raw = window.prompt('Save this layout as — name:', `${typeName} copy`);
    if (raw === null) return; // cancelled
    const key = raw.trim();
    // Same rule the server enforces, checked here so a bad name costs no round
    // trip. Kept in sync with TIER_KEY in services/auth/src/routes/layouts.routes.js.
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(key)) {
      return toast.error('Use letters, numbers, spaces, hyphens or underscores (max 40).');
    }
    if (key === typeName) return toast.error('That is the layout you are already editing.');
    setSaveState('saving');
    try {
      await api.put(`/api/room-layouts/${encodeURIComponent(key)}`, {
        room,
        furniture,
        walls,
        stations,
      });
      setSaveState('saved');
      setSaveError('');
      // The copy exists, so the editor is no longer authoring an unsaved thing
      // whichever state it was in a moment ago.
      setNeedsFirstSave(false);
      await hydrateRoomLayouts({ force: true });
      toast.success(`Saved as “${key}” — autosave now writes to it.`);
      onSavedAs?.(key);
    } catch (e) {
      setSaveState('error');
      setSaveError(e.response?.data?.error || e.message);
      toast.error(e.response?.data?.error || e.message);
    }
  }

  // Drop every stored version for this tier, so it falls back to the layout
  // committed in roomLayouts.js — globally, not just here.
  async function resetToFile() {
    const ok = await confirm({
      title: 'Discard saved layout',
      message: `Discard the saved ${typeName} layout and go back to the one in the code?`,
      detail: 'This affects every browser, not just this one. Saved versions are removed.',
      confirmLabel: 'Discard',
    });
    if (!ok) return;
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
    // Both stacks go with it. The confirmation says this discards every edit
    // for the tier — but the history still held them, so one press of Undo
    // brought the whole discarded layout back and the next autosave wrote it
    // to the server. The dialog's promise and the editor's behaviour have to
    // agree, and the dialog is the one that is right.
    hist.current = [];
    redo.current = [];
    setHistEpoch((n) => n + 1);
  }

  // The scene as one serialisable value — the unit both stacks store.
  const sceneJSON = () => JSON.stringify({ furniture, walls, stations, room });
  const restore = (s) => {
    const d = JSON.parse(s);
    setFurniture(d.furniture);
    setWalls(d.walls);
    setStations(d.stations);
    setRoom(d.room);
    setSel([]);
  };
  const snapshot = () => {
    hist.current.push(sceneJSON());
    if (hist.current.length > 60) hist.current.shift();
    // A new edit invalidates the redo branch — the future you could have gone
    // back to no longer follows from the present. Keeping it would let Redo
    // paste a state that was never reachable from what is on screen now.
    if (redo.current.length) {
      redo.current = [];
      setHistEpoch((n) => n + 1);
    }
  };
  const undo = () => {
    const s = hist.current.pop();
    if (!s) return;
    // Push where we ARE before stepping back, so Redo has somewhere to return
    // to. Without this the two stacks are not inverses and Redo would replay
    // the state you just undid *to*, not the one you undid *from*.
    redo.current.push(sceneJSON());
    restore(s);
    setHistEpoch((n) => n + 1);
  };
  const redoAction = () => {
    const s = redo.current.pop();
    if (!s) return;
    hist.current.push(sceneJSON());
    restore(s);
    setHistEpoch((n) => n + 1);
  };

  // Drops the camera straight above the room's centre and looks down. The
  // height is derived from the room, not a constant, so a Presidential suite
  // frames the same way a Standard does.
  //
  // Not exactly vertical: OrbitControls has no azimuth at the pole, so a camera
  // at (0, y, 0) leaves the controls unable to work out which way is "around"
  // and the first drag snaps wildly. A few centimetres of offset keeps the view
  // effectively top-down while giving the controls a heading to work from —
  // which is also why `maxPolarAngle` on the controls below stops just short of
  // the horizon for the same reason at the other end.
  const birdsEye = () => {
    const c = orbit.current;
    if (!c) return;
    const h = Math.max(room.w, room.l) * 1.25 + 4;
    c.object.position.set(0, h, 0.001);
    c.target.set(0, 0, 0);
    c.object.up.set(0, 1, 0);
    c.object.lookAt(0, 0, 0);
    c.update();
  };

  // The three-quarter view the editor opens on — the way out of bird's-eye, and
  // out of any other angle you have orbited yourself into. Same numbers as the
  // Canvas camera's initial `position`, so "default" means what it says rather
  // than approximately where you started.
  const defaultView = () => {
    const c = orbit.current;
    if (!c) return;
    c.object.position.set(0, 13, 12);
    c.target.set(0, 0.8, 0);
    c.object.up.set(0, 1, 0);
    c.object.lookAt(0, 0.8, 0);
    c.update();
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
        // ⇧⌘Z is redo on every platform that has ⌘Z, so it is checked as part
        // of the same key rather than as a separate branch.
        if (e.shiftKey) redoAction();
        else undo();
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        // ⇧⌘S / Ctrl+Shift+S — Save as. Checked BEFORE the plain-⌘S branch
        // below, or the unshifted match would swallow it.
        e.preventDefault();
        saveAs();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        // ⌘S. The layout already autosaves, so on an existing layout this is
        // only the browser's Save dialog being suppressed — but on an UNSAVED
        // one it is the first save, which is the whole point of the gate.
        e.preventDefault();
        if (needsFirstSave) saveFirst();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redoAction();
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && GIZMO_KEYS[e.key.toLowerCase()]) {
        // Bare M / R / T switch the gizmo, the way every 3D tool does it. Guarded
        // on the modifier keys so ⌘R still reloads and ⌘T still opens a tab, and
        // the handler already returns early for INPUT/TEXTAREA/SELECT targets so
        // typing a name into the station title cannot switch tools underneath you.
        e.preventDefault();
        setMode(GIZMO_KEYS[e.key.toLowerCase()]);
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
        background: 'var(--stage)',
        display: 'flex',
        // Column now: the toolbar is a full-width row above the three panels.
        flexDirection: 'column',
        fontSize: 13,
        color: 'var(--text)',
      }}
    >
      {/* ── TOP: toolbar strip, FULL WIDTH ──
          It spans the whole overlay rather than sitting inside the centre
          column, because the centre group has to stay put as panels open and
          close. Inside the column, "centred" meant centred in whatever width
          was left: collapsing the left panel and expanding the right moved the
          gizmo tools 207px across the screen, so the tool under your cursor was
          no longer the tool you reached for. Anchored to the viewport, the
          centre is the centre whatever the panels are doing. */}
      <div className="tool-bar tool-bar--strip">
        {/* Undo and Reset lead the bar, as the reference has them. Same two
            handlers that were in the side panel — moved, not rewritten. */}
        <div className="tool-group">
          {/* `histEpoch` is read here purely so this row re-renders when the
              stacks change — they live in refs, which React cannot see. */}
          <button
            onClick={undo}
            disabled={histEpoch >= 0 && hist.current.length === 0}
            className="tool-btn"
            title="Undo (⌘Z)"
            aria-label="Undo"
          >
            <Icon name="undo" size={18} strokeWidth={1.9} />
          </button>
          <button
            onClick={redoAction}
            disabled={histEpoch >= 0 && redo.current.length === 0}
            className="tool-btn"
            title="Redo (⇧⌘Z)"
            aria-label="Redo"
          >
            <Icon name="redo" size={18} strokeWidth={1.9} />
          </button>
          <span className="tool-sep" />
          <button
            onClick={birdsEye}
            className="tool-btn"
            title="Bird's-eye view — look straight down on the plan"
            aria-label="Bird's-eye view"
          >
            <Icon name="bird-eye" size={18} strokeWidth={1.9} />
          </button>
          <button
            onClick={defaultView}
            className="tool-btn"
            title="Default view — back to the three-quarter angle"
            aria-label="Default view"
          >
            <Icon name="home" size={18} strokeWidth={1.9} />
          </button>
          <button
            onClick={resetToFile}
            className="tool-btn"
            title="Discard edits and reload the checked-in layout"
            aria-label="Reset to file"
          >
            <Icon name="refresh-cw" size={18} strokeWidth={1.9} />
          </button>
        </div>

        {/* The gizmo modes, centred — the three that decide what dragging in
            the viewport does, which is what the bar is mostly for. */}
        <div className="tool-group tool-group--mid">
          {/* Same three handlers, same three mode values — only the label is
              now a glyph. `title` carries the word that used to be the button
              face, so nothing is lost for anyone hovering or using a reader. */}
          <button
            onClick={() => setMode('translate')}
            className={`tool-btn${mode === 'translate' ? ' is-on' : ''}`}
            title="Move — M (drag along the ground plane)"
            aria-label="Move"
            aria-pressed={mode === 'translate'}
          >
            <Icon name="move" size={18} strokeWidth={1.9} />
          </button>
          <button
            onClick={() => setMode('rotate')}
            className={`tool-btn${mode === 'rotate' ? ' is-on' : ''}`}
            title="Rotate — R"
            aria-label="Rotate"
            aria-pressed={mode === 'rotate'}
          >
            <Icon name="rotate-cw" size={18} strokeWidth={1.9} />
          </button>
          <button
            onClick={() => setMode('scale')}
            className={`tool-btn${mode === 'scale' ? ' is-on' : ''}`}
            title="Resize — T"
            aria-label="Resize"
            aria-pressed={mode === 'scale'}
          >
            <Icon name="maximize" size={18} strokeWidth={1.9} />
          </button>
          <span className="tool-sep" />
          {/* Snap is a toggle like the modes, so it is a tile like the modes —
              the same checked value driving the same onChange, just expressed
              as a pressed button instead of a checkbox. */}
          <button
            onClick={() => setSnap(!snap)}
            className={`tool-btn${snap ? ' is-on' : ''}`}
            title="Snap to grid"
            aria-label="Snap to grid"
            aria-pressed={snap}
          >
            <Icon name="magnet" size={18} strokeWidth={1.9} />
          </button>
        </div>

        {/* Save state, readout and help, hard right. */}
        <div className="tool-group tool-group--end">
          {/* Only while the layout has never been saved. Once it exists the
              autosave owns saving and a manual button would be a second, slower
              way to do the same thing. */}
          {needsFirstSave && (
            <button
              className="tool-btn tool-btn--text is-on"
              onClick={saveFirst}
              disabled={saveState === 'saving'}
              title="Create this layout on the server. Autosave starts after this."
            >
              <Icon name="check" size={16} strokeWidth={2.4} />
              {saveState === 'saving' ? 'Saving…' : 'Save layout'}
            </button>
          )}
          <button
            className="tool-btn tool-btn--text"
            onClick={saveAs}
            disabled={saveState === 'saving'}
            title="Save this room as a new layout under its own name (⇧⌘S / Ctrl+Shift+S)"
          >
            <Icon name="copy" size={16} strokeWidth={1.9} />
            Save as
          </button>
          <SaveChip state={saveState} error={saveError} />
          {multi && (
            <span className="tool-note" style={{ color: 'var(--text-warn)' }}>
              {sel.length} selected · {countByKind(sel).furniture}f {countByKind(sel).wall}w{' '}
              {countByKind(sel).station}s
            </span>
          )}
          {!multi && item && (
            <span className="tool-note">
              {single.kind}: {item.model || item.type || item.title}
            </span>
          )}
          {/* The app's own theme toggle, reachable from in here. The editor
              covers the whole screen, so the top bar's toggle sits behind it —
              changing the light in the room you are dressing meant leaving the
              room. Same `useTheme` context as the app's button, so the two stay
              in step and the choice still persists across reloads. */}
          <button
            onClick={toggleTheme}
            className="tool-btn"
            title={theme === 'dark' ? 'Day mode' : 'Night mode'}
            aria-label={theme === 'dark' ? 'Switch to day mode' : 'Switch to night mode'}
            aria-pressed={theme === 'dark'}
          >
            {/* Shows the mode you would switch TO — a sun while dark, a moon
                while light — matching the app's top-bar toggle. */}
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} strokeWidth={1.9} />
          </button>
          <button
            onClick={() => setHelpOpen(true)}
            className={`tool-btn${helpOpen ? ' is-on' : ''}`}
            title="Shortcuts and a short guide"
            aria-label="Help"
          >
            <Icon name="help-circle" size={18} strokeWidth={1.9} />
          </button>
        </div>
      </div>
      {helpOpen && <EditorHelp onClose={() => setHelpOpen(false)} />}

      {/* ── The three columns, below the bar ── */}
      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex' }}>
        {/* ── LEFT: palette + room ── */}
        {/* Collapsed, the panel becomes a 34px rail holding only the reopen
          button. It is NOT unmounted: the palette keeps its tab, its search
          text and its rendered thumbnails, so reopening is instant and shows
          exactly what you left. */}
        {!leftOpen && (
          <div className="ed-rail">
            <button
              className="tool-btn"
              onClick={() => setLeftOpen(true)}
              title="Show the asset palette"
              aria-label="Show the asset palette"
            >
              <Icon name="chevron-right" size={17} strokeWidth={2} />
            </button>
          </div>
        )}
        <div
          style={{
            width: 250,
            flex: 'none',
            background: 'var(--panel)',
            display: leftOpen ? 'flex' : 'none',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              padding: '10px 12px',
              fontWeight: 700,
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              justifyContent: 'space-between',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Layout editor · {typeName}
            </span>
            <span style={{ display: 'flex', gap: 2, flex: 'none' }}>
              <button
                className="tool-btn"
                onClick={() => setLeftOpen(false)}
                title="Hide this panel"
                aria-label="Hide the asset palette"
              >
                <Icon name="chevron-left" size={16} strokeWidth={2} />
              </button>
              <button onClick={onClose} className="tool-btn" aria-label="Close" title="Close the editor">
                <Icon name="x" size={16} strokeWidth={2} />
              </button>
            </span>
          </div>
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
            {/* The catalogue as a browsable grid rather than a dropdown. Same
              `addKey` values (`model:x` / `type:x`), same `setAddKey`, same
              `addAsset` — a card just writes the value the <select> used to. */}
            <AssetPalette
              addKey={addKey}
              setAddKey={setAddKey}
              onAdd={addAsset}
              // The editor covers the whole screen at z-index 400, and the toast
              // stack renders in the app beneath it — so import feedback is
              // passed down rather than raised, and shown inside the palette.
              onNotify={(kind, msg) => (kind === 'error' ? toast.error(msg) : toast.success(msg))}
            />
            <div className="tool-bar" style={{ marginTop: 8 }}>
              <button onClick={addWall} className="tool-btn has-label" title="Add a wall segment">
                <Icon name="wall" size={15} strokeWidth={1.9} />
                Wall
              </button>
              <button onClick={addStation} className="tool-btn has-label" title="Add a task station">
                <Icon name="map-pin" size={15} strokeWidth={1.9} />
                Station
              </button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', margin: '10px 0 4px' }}>SELECT</div>
            {/* The `disabled` attribute now does the dimming, where an inline
              `opacity: 0.45` used to. Same condition, same handlers — but the
              disabled STATE is what CSS reads, so a greyed tool is also
              genuinely unclickable and announces itself as unavailable. */}
            <div className="tool-bar">
              <button
                onClick={() => sel.length && setSel(selectAllLike(arrays, sel[sel.length - 1]))}
                disabled={!sel.length}
                title="Every fixture sharing this model — the whole floor in one click"
                aria-label="Select all like this"
                className="tool-btn"
              >
                <Icon name="copy" size={16} strokeWidth={1.9} />
              </button>
              <button
                onClick={() => setSel(selectAll(arrays))}
                className="tool-btn"
                title="Select everything, walls included"
                aria-label="Select all"
              >
                <Icon name="select-all" size={16} strokeWidth={1.9} />
              </button>
              <button
                onClick={() => setSel(selectAllOfKind(arrays, 'furniture'))}
                className="tool-btn"
                title="Select all furniture"
                aria-label="Select all furniture"
              >
                <Icon name="armchair" size={16} strokeWidth={1.9} />
              </button>
              <button
                onClick={() => setSel(selectAllOfKind(arrays, 'wall'))}
                className="tool-btn"
                title="Select all walls"
                aria-label="Select all walls"
              >
                <Icon name="wall" size={16} strokeWidth={1.9} />
              </button>
              <span className="tool-sep" />
              <button
                onClick={() => setSel([])}
                disabled={!sel.length}
                className="tool-btn"
                title="Clear the selection"
                aria-label="Select none"
              >
                <Icon name="square-dashed" size={16} strokeWidth={1.9} />
              </button>
            </div>
          </div>
          {/* The scene lists moved to the right panel, under the inspector — they
            describe what is IN the room, which is what the inspector is about;
            this side is the catalogue of what you can add. Same <List>, same
            `pick`. */}
          <div style={{ flex: 1, overflowY: 'auto' }} />
          {/* The extra bottom padding is a footer gutter: without it the last
            field sits flush against the panel's bottom edge, which reads as
            content that has been cut off rather than content that has ended. */}
          <div style={{ padding: '8px 8px 20px', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>ROOM</div>
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
            {/* "Copy block → clipboard" and the autosave line above it are gone.
              The live save state lives on the toolbar, and Undo/Reset moved
              there earlier — nothing in this panel reports status any more. */}
          </div>
        </div>

        {/* ── CENTER: the 3D viewport ── */}
        {/* `minWidth: 0` still matters even now the toolbar has moved out: a flex
          item's min-width defaults to its CONTENT, and a wide canvas would
          otherwise set this column's floor and push the far panel off the edge
          of the screen. With the floor at 0 the column yields instead. */}
        <div
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Canvas
            shadows
            dpr={[1, 2]}
            camera={{ position: [0, 13, 12], fov: 50, near: 0.1, far: 120 }}
            // WebGL cannot read a CSS variable, so the stage colour is resolved
            // from the live computed style once here and again whenever the theme
            // flips (see the effect above). `--stage` is the same token the app's
            // other 3D surface uses, so the backdrop behind the room matches the
            // rest of the product in both themes and under a custom accent.
            onCreated={({ gl }) => {
              glRef.current = gl;
              gl.setClearColor(stageColor());
            }}
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
                    color={has(sel, 'station', i) ? 'var(--warn)' : '#38bdf8'}
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
                      color="var(--warn)"
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
        </div>

        {/* ── RIGHT: inspector + scene lists ── */}
        <div
          style={{
            width: 232,
            flex: 'none',
            background: 'var(--panel)',
            borderLeft: '1px solid var(--border)',
            display: rightOpen ? 'flex' : 'none',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              padding: '10px 12px',
              fontWeight: 700,
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
            }}
          >
            <span>Inspector</span>
            <button
              className="tool-btn"
              onClick={() => setRightOpen(false)}
              title="Hide this panel"
              aria-label="Hide the inspector"
            >
              <Icon name="chevron-right" size={16} strokeWidth={2} />
            </button>
          </div>
          {/* The inspector body owns the flexible space and scrolls inside it.
            It used to have none of its own, so a tall inspector simply ran off
            the bottom of the panel with no way to reach the last field. */}
          <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', paddingBottom: 12 }}>
            {!sel.length && (
              <div style={{ padding: 12, color: 'var(--muted)', fontSize: 12, lineHeight: 1.6 }}>
                Select an item (list or 3D) to edit its properties.
                <div style={{ marginTop: 10, color: 'var(--muted-2)' }}>
                  ⇧-click adds to the selection · ⇧-click a list row for a range · ⌘A all · ⌘D duplicate
                  <br />M move · R rotate · T resize
                </div>
              </div>
            )}
            {multi && <MultiSummary sel={sel} />}
            {item && single.kind === 'furniture' && <FurnitureInspector it={item} patch={patch} />}
            {item && single.kind === 'wall' && <WallInspector it={item} patch={patch} />}
            {item && single.kind === 'station' && <StationInspector it={item} patch={patch} />}
          </div>
          {/* No `marginTop: auto` here any more. There were two of them in this
            column — this row and the lists below — and two auto margins SPLIT
            the free space between them, so the action row floated into the
            middle of the panel instead of sitting under the inspector. */}
          {!!sel.length && (
            <div
              style={{
                flex: 'none',
                padding: 8,
                borderTop: '1px solid var(--border)',
                display: 'flex',
                gap: 6,
              }}
            >
              <button
                onClick={duplicateSel}
                className="tool-btn has-label"
                title={`Duplicate${multi ? ` ${sel.length} items` : ''}`}
              >
                <Icon name="copy" size={15} strokeWidth={1.9} />
                Duplicate{multi ? ` ${sel.length}` : ''}
              </button>
              <button
                onClick={removeSel}
                className="tool-btn has-label is-danger"
                title={`Delete${multi ? ` ${sel.length} items` : ''}`}
                style={{
                  flex: 1,
                  background: 'var(--danger-soft)',
                  borderColor: 'var(--danger)',
                  color: 'var(--on-danger-soft)',
                }}
              >
                <Icon name="trash" size={15} strokeWidth={1.9} />
                Delete{multi ? ` ${sel.length}` : ''}
              </button>
            </div>
          )}

          {/* ── Scene contents, below the inspector ──
            `flex: none` with its own max-height: the inspector above takes the
            flexible space, this takes a fixed share of the panel and scrolls
            within it. Both being flexible is what made the column fight itself. */}
          <div
            style={{
              flex: 'none',
              borderTop: '1px solid var(--border)',
              maxHeight: '40vh',
              overflowY: 'auto',
              // Matching gutter at the foot of the scroll. Scrolled to the end,
              // the last row otherwise stops exactly on the panel edge and reads
              // as clipped — you cannot tell you have reached the bottom.
              paddingBottom: 20,
            }}
          >
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
        </div>

        {/* `--right` moves the divider to the rail's LEFT edge. Sharing one class
          with the left rail put the line on the outer edge of the window, where
          it divided the panel from nothing, and left no seam at all between the
          viewport and the rail. */}
        {!rightOpen && (
          <div className="ed-rail ed-rail--right">
            <button
              className="tool-btn"
              onClick={() => setRightOpen(true)}
              title="Show the inspector"
              aria-label="Show the inspector"
            >
              <Icon name="chevron-left" size={17} strokeWidth={2} />
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
      <div style={{ fontWeight: 700, color: 'var(--text-warn)' }}>{sel.length} items selected</div>
      <div style={{ color: 'var(--muted)' }}>
        {c.furniture} furniture · {c.wall} walls · {c.station} stations
      </div>
      <div style={{ marginTop: 10, color: 'var(--muted-2)' }}>
        The gizmo moves and rotates the whole group about its centre. Per-item fields are editable one at a
        time — select a single item to see them.
      </div>
      <div style={{ marginTop: 8, color: 'var(--muted-2)' }}>
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
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
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
      {/* Both toggles on ONE line, label beside the box. `Field` stacks its
          label above its control, which is right for a pair of number inputs
          and wrong for a checkbox: it gave each one a caption of its own and a
          full-width row underneath, so two booleans ate four rows of a 232px
          panel. Same two handlers, same two values. */}
      <div className="ed-check-row">
        <Check
          label="wall-mounted"
          checked={!!it.wall}
          onChange={(e) => patch(e.target.checked ? { wall: true, y: it.y ?? 1.7 } : { wall: undefined })}
        />
        <Check
          label="solid (collision)"
          checked={!!box}
          onChange={(e) => patch(e.target.checked ? { box: [it.w ?? 1, it.w ?? 1] } : { box: undefined })}
        />
      </div>
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
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>interior wall</div>
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
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>station · {it.key}</div>
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
// ── Autosave indicator ──────────────────────────────────────────────────────
// Lives on the toolbar because that is the one strip always in view. The save
// state used to be a line in the left panel, below the room fields — a panel
// that scrolls, and can be collapsed entirely. An autosave failure you cannot
// see is the one that costs you an afternoon's work.
//
// Four states, and each says what it means for OTHER people, because that is
// what is surprising here: this editor writes the shared layout, so "saved"
// means every browser now has it.
// ── Help ────────────────────────────────────────────────────────────────────
// The shortcuts and a short guide, in the editor rather than in a markdown file
// nobody has open while they are dragging a sofa.
//
// It is a panel inside the editor overlay, NOT the app's <Modal>: this editor
// sets `data-keyboard-capture` and sits at z-index 400 over the whole app, so a
// modal rendered into the app's own layer would either land underneath it or
// hand the keyboard back to the global shortcut handler mid-edit.
const HELP_KEYS = [
  ['⇧⌘S / Ctrl+Shift+S', 'Save as — a copy under a new name'],
  ['⌘S / Ctrl+S', 'Save an unsaved layout (existing ones autosave)'],
  ['M', 'Move gizmo'],
  ['R', 'Rotate gizmo'],
  ['T', 'Resize gizmo'],
  ['⌘Z / Ctrl+Z', 'Undo'],
  ['⇧⌘Z / Ctrl+Y', 'Redo'],
  ['⌘D / Ctrl+D', 'Duplicate selection'],
  ['⌘A / Ctrl+A', 'Select everything'],
  ['Delete / ⌫', 'Delete selection'],
  ['Arrow keys', 'Nudge selection by 10 cm'],
  ['⇧-click', 'Add to the selection'],
  ['⇧-click a row', 'Select a range in the lists'],
];

function EditorHelp({ onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="ed-help-backdrop" onClick={onClose}>
      <div className="ed-help" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Editor help">
        <div className="ed-help-head">
          <strong>Layout editor — guide</strong>
          <button className="tool-btn" onClick={onClose} aria-label="Close help" title="Close (Esc)">
            <Icon name="x" size={16} strokeWidth={2} />
          </button>
        </div>
        <div className="ed-help-body">
          <h4>Getting around</h4>
          <ol className="ed-help-steps">
            <li>
              <strong>Pick an asset</strong> from the palette on the left — click a card to preview it,
              double-click to drop it in the room. <em>+ Wall</em> and <em>+ Station</em> add those.
            </li>
            <li>
              <strong>Select</strong> by clicking an object in the viewport or a row in the lists under the
              inspector.
            </li>
            <li>
              <strong>Move it</strong> with the gizmo. The three tools in the middle of the toolbar decide
              what dragging does — move, rotate, resize.
            </li>
            <li>
              <strong>Fine-tune</strong> exact numbers in the inspector on the right: position, rotation,
              scale, height, collision box, colour.
            </li>
            <li>
              <strong>It saves itself.</strong> Every change autosaves to the server for every browser — the
              line above the Copy button tells you where that stands.
            </li>
          </ol>

          <h4>Camera</h4>
          <p className="ed-help-note">
            Drag to orbit, scroll to zoom, right-drag to pan. The two view buttons on the toolbar jump to
            bird&apos;s-eye (straight down) and back to the default three-quarter angle.
          </p>

          <h4>Shortcuts</h4>
          <table className="ed-help-keys">
            <tbody>
              {HELP_KEYS.map(([k, what]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="ed-help-note">
            Shortcuts are ignored while you are typing in a field, so naming a station cannot switch tools
            underneath you.
          </p>

          <h4>Careful with</h4>
          <p className="ed-help-note">
            <strong>Reset to file</strong> discards every edit for this tier and reloads the checked-in layout
            — it is not an undo, and Undo will not bring the edits back.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Asset thumbnails ────────────────────────────────────────────────────────
// Yes, the cards can show the real asset — but NOT by giving each card its own
// <Canvas>. Every Canvas is a WebGL context and browsers cap those at roughly a
// dozen per page; forty of them would evict contexts, the editor's own viewport
// among them.
//
// So there is exactly ONE hidden renderer. It draws one asset at a time,
// rasterises it with toDataURL, caches the PNG against its key and moves to the
// next. Cards read the cache and swap their glyph for the picture as it lands,
// so the grid fills in over a few seconds instead of all at once. The cache is
// module-level, so reopening the editor is instant.
const thumbCache = new Map(); // addKey -> data URL, or null when it cannot be drawn
const thumbSubs = new Set();
function publishThumb(key, url) {
  thumbCache.set(key, url);
  thumbSubs.forEach((fn) => fn());
}
function useThumb(key) {
  const [url, setUrl] = useState(() => thumbCache.get(key) ?? null);
  useEffect(() => {
    const read = () => setUrl(thumbCache.get(key) ?? null);
    read();
    thumbSubs.add(read);
    return () => thumbSubs.delete(read);
  }, [key]);
  return url;
}

// Counts frames, then grabs the pixels. The delay matters: `Bounds fit` needs a
// few frames to frame the object, and a .glb may still be downloading — a
// capture taken too early is a transparent square.
function ThumbCapture({ itemKey, onCapture }) {
  const { gl } = useThree();
  const frames = useRef(0);
  const tries = useRef(0);
  useEffect(() => {
    frames.current = 0;
    tries.current = 0;
  }, [itemKey]);
  useFrame(() => {
    frames.current += 1;
    if (frames.current < 12) return;
    frames.current = 0;
    let url = null;
    try {
      url = gl.domElement.toDataURL('image/png');
    } catch {
      // Tainted or context-lost — give up on this one rather than retry forever.
      onCapture(itemKey, null);
      return;
    }
    // A frame that drew nothing compresses to almost nothing. Retry a few times
    // before accepting the blank, since the model may still be loading.
    if (url.length < 2500) {
      tries.current += 1;
      if (tries.current < 8) return;
      onCapture(itemKey, null);
      return;
    }
    onCapture(itemKey, url);
  });
  return null;
}

function ThumbForge({ keys }) {
  // The next key with no cache entry. Recomputed on every publish, so the forge
  // walks the queue without holding an index that could drift as the grid
  // filters underneath it.
  const [, bump] = useState(0);
  useEffect(() => {
    const read = () => bump((n) => n + 1);
    thumbSubs.add(read);
    return () => thumbSubs.delete(read);
  }, []);
  const next = keys.find((k) => !thumbCache.has(k));
  if (!next) return null;

  const [kind, name] = next.split(':');
  const item = kind === 'model' ? { model: name } : { type: name };
  return (
    // Off-screen rather than `display: none` — a hidden canvas is never
    // composited and WebGL will not render into it.
    <div aria-hidden="true" style={{ position: 'fixed', left: -9999, top: 0, width: 96, height: 96 }}>
      <Canvas
        key={next}
        camera={{ position: [1.9, 1.5, 2.3], fov: 45 }}
        dpr={1}
        // Required for toDataURL: without it the drawing buffer is cleared
        // before we can read it back.
        gl={{ preserveDrawingBuffer: true, alpha: true, antialias: true }}
        onCreated={({ gl }) => gl.setClearAlpha(0)}
      >
        <ambientLight intensity={1.05} />
        <directionalLight position={[3, 5, 3]} intensity={1.15} />
        <hemisphereLight args={['#ffffff', '#444a55', 0.55]} />
        <Suspense fallback={null}>
          <GLBoundary key={next} fallback={null}>
            <Bounds fit clip margin={1.25}>
              <FixtureBody item={item} />
            </Bounds>
          </GLBoundary>
        </Suspense>
        <ThumbCapture itemKey={next} onCapture={publishThumb} />
      </Canvas>
    </div>
  );
}

// ── Asset palette ───────────────────────────────────────────────────────────
// The catalogue browser: tabs, a filter row, a card grid and a size slider.
//
// It replaces a single <select> with optgroups. The dropdown listed every model
// by raw key in a 4-row-tall box, so choosing a sofa meant scrolling a list of
// forty identifiers with nothing to look at — you picked a name and hoped.
//
// WHAT THE CARDS SHOW, and why it is not a render: each live preview is a
// <Canvas>, i.e. its own WebGL context, and browsers cap those at roughly a
// dozen per page. A grid of forty rendered thumbnails would exhaust the pool
// and start evicting contexts — including the editor's main viewport. So the
// cards are glyph tiles, and the ONE live 3D preview sits above the grid
// showing whichever card is selected. Real per-asset thumbnails would need a
// pre-rendered sprite sheet or an offscreen renderer that rasterises each model
// once and caches it; both are real work, neither is a style change.
//
// Everything here is local view state — tab, search text, card size. Nothing
// touches the scene.
const PAL_TABS = [
  { id: 'model', label: 'Models', icon: 'armchair', title: 'Imported .glb models' },
  { id: 'type', label: 'Types', icon: 'box', title: 'Procedural primitives' },
  { id: 'all', label: 'All', icon: 'select-all', title: 'Everything in the catalogue' },
];

function AssetPalette({ addKey, setAddKey, onAdd, onNotify }) {
  const [tab, setTab] = useState('model');
  const [q, setQ] = useState('');
  // Bumped whenever the uploaded catalogue changes, so the grid recomputes —
  // MODELS is a plain object being mutated, which React cannot observe.
  const [assetEpoch, setAssetEpoch] = useState(0);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    hydrateAssets();
    return onAssetsChanged(() => setAssetEpoch((n) => n + 1));
  }, []);

  async function onFiles(files) {
    const list = Array.from(files || []).filter((f) => /\.(glb|gltf)$/i.test(f.name));
    if (!list.length) {
      onNotify?.('error', 'Pick a .glb file — that is the format the room loads.');
      return;
    }
    setImporting(true);
    let ok = 0;
    for (const f of list) {
      try {
        const saved = await uploadAsset(f);
        ok += 1;
        // Select what was just imported: you uploaded it to place it.
        setAddKey(`model:${saved.key}`);
        setTab('model');
      } catch (err) {
        onNotify?.('error', err.response?.data?.error || err.message);
      }
    }
    setImporting(false);
    if (ok) onNotify?.('success', `Imported ${ok} model${ok > 1 ? 's' : ''}.`);
  }
  // Card width in px, driven by the slider at the foot of the panel — the same
  // control the reference puts there. Held as a CSS custom property so the grid
  // reflows from one number.
  const [cardW, setCardW] = useState(62);

  const items = useMemo(() => {
    // Read off MODELS rather than the module-load snapshot, so an imported
    // fixture appears without a reload. Uploaded keys sort in with the rest —
    // once it is in the room nothing treats it differently, so nothing here
    // should either, beyond the badge that says where it came from.
    const models = Object.keys(MODELS)
      .sort()
      .map((k) => ({ key: `model:${k}`, name: k, kind: 'model', custom: uploadedAssets.has(k) }));
    const types = TYPE_KEYS.map((k) => ({ key: `type:${k}`, name: k, kind: 'type' }));
    const pool = tab === 'model' ? models : tab === 'type' ? types : [...models, ...types];
    const term = q.trim().toLowerCase();
    return term ? pool.filter((it) => it.name.toLowerCase().includes(term)) : pool;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q, assetEpoch]);

  return (
    <div className="pal">
      <div className="pal-tabs" role="tablist">
        {PAL_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`pal-tab${tab === t.id ? ' is-on' : ''}`}
            title={t.title}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={17} strokeWidth={1.9} />
          </button>
        ))}
      </div>

      <div className="pal-filter">
        <span className="pal-search">
          <Icon name="search" size={13} strokeWidth={2} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search assets"
            aria-label="Search assets"
          />
        </span>
        {/* Import from this machine. A hidden <input type="file"> behind a
            styled button, because the native control cannot be restyled and
            would be the only piece of stock browser chrome in the editor. */}
        <input
          ref={fileRef}
          type="file"
          accept=".glb,model/gltf-binary"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            onFiles(e.target.files);
            // Cleared so re-picking the SAME file fires change again — without
            // this, re-importing a corrected export appears to do nothing.
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="tool-btn"
          onClick={() => fileRef.current?.click()}
          disabled={importing}
          title="Import a .glb from this computer"
          aria-label="Import a model"
        >
          <Icon name={importing ? 'refresh-cw' : 'upload-cloud'} size={17} strokeWidth={1.9} />
        </button>
        <button
          type="button"
          className="tool-btn tool-btn--text is-on"
          onClick={onAdd}
          title="Add the selected asset to the room"
          aria-label="Add selected asset"
        >
          <Icon name="plus" size={17} strokeWidth={2.2} />
        </button>
      </div>

      <PalettePreview addKey={addKey} />

      {items.length === 0 ? (
        <p className="pal-empty">No asset matches “{q}”.</p>
      ) : (
        <div className="pal-grid" style={{ '--pal-card': `${cardW}px` }}>
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              className={`pal-card${addKey === it.key ? ' is-on' : ''}`}
              title={`${it.name} — click to select, double-click to place`}
              // Single click selects (drives the live preview above), double
              // click places it. Both write through the same two functions the
              // dropdown and Add button already used.
              onClick={() => setAddKey(it.key)}
              onDoubleClick={() => {
                setAddKey(it.key);
                onAdd();
              }}
            >
              <PalCardThumb itemKey={it.key} kind={it.kind} />
              <span className="pal-card-name">{it.name}</span>
              {/* Marks an imported fixture, so it is obvious which models came
                  from this machine and can be replaced or removed. */}
              {it.custom && <span className="pal-card-tag">imported</span>}
            </button>
          ))}
        </div>
      )}

      <div className="pal-size">
        <input
          type="range"
          min="48"
          max="96"
          step="2"
          value={cardW}
          onChange={(e) => setCardW(Number(e.target.value))}
          aria-label="Thumbnail size"
          title="Thumbnail size"
        />
      </div>

      {/* The single hidden renderer, fed only the keys currently on screen — so
          filtering to "sofa" rasterises those three next instead of grinding
          through the whole catalogue first. */}
      <ThumbForge keys={items.map((it) => it.key)} />
    </div>
  );
}

// The picture if it has been rendered, the glyph until then. Both sit in the
// same fixed-ratio tile, so a card never changes size as its thumbnail lands
// and the grid does not reflow while it fills in.
function PalCardThumb({ itemKey, kind }) {
  const url = useThumb(itemKey);
  return (
    <span className="pal-card-thumb">
      {url ? (
        <img src={url} alt="" loading="lazy" />
      ) : (
        <Icon name={kind === 'model' ? 'armchair' : 'box'} size={22} strokeWidth={1.6} />
      )}
    </span>
  );
}

function PalettePreview({ addKey }) {
  const [kind, key] = addKey.split(':');
  const item = useMemo(() => (kind === 'model' ? { model: key } : { type: key }), [addKey]);
  return (
    <div
      // `--stage`, same as every other 3D backdrop in the app. That token is
      // now the neutral grey rather than the old khaki, so this needs no
      // exception of its own — one token, one colour, everywhere a model is
      // shown against a background.
      style={{
        height: 132,
        background: 'var(--stage)',
        borderRadius: 6,
        marginTop: 6,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <span
        style={{ position: 'absolute', left: 6, top: 4, fontSize: 10, color: 'var(--muted-2)', zIndex: 1 }}
      >
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
          color: 'var(--muted)',
          background: 'var(--surface-2)',
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
            background: has(sel, kind, i) ? 'var(--accent)' : 'transparent',
            // Ink has to flip with the fill. In light mode the accent is a deep
            // green and in dark mode a pale one, so a single fixed text colour
            // is unreadable in one of the two — `--on-accent` is the pairing
            // the palette already guarantees.
            color: has(sel, kind, i) ? 'var(--on-accent)' : 'var(--text)',
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
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 3 }}>{label}</div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>{children}</div>
    </div>
  );
}
// A boolean: small box, label beside it, the whole thing clickable because it
// is a <label> wrapping its own input.
function Check({ label, checked, onChange }) {
  return (
    <label className="ed-check">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
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
        background: 'var(--field)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
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
  return <span style={{ fontSize: 11, color: 'var(--muted)', width: 34 }}>{children}</span>;
}
const swatch = {
  width: 40,
  height: 24,
  background: 'none',
  border: '1px solid var(--border)',
  borderRadius: 4,
};
const txt = {
  flex: 1,
  background: 'var(--field)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '3px 5px',
  fontSize: 12,
};
const miniBtn = {
  background: 'var(--field)',
  color: 'var(--muted)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontSize: 10,
  cursor: 'pointer',
};
const icobtn = { background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16 };
function btn(active) {
  return {
    padding: '5px 9px',
    borderRadius: 5,
    border: '1px solid var(--border)',
    cursor: 'pointer',
    background: active ? 'var(--accent)' : 'var(--field)',
    color: active ? 'var(--on-accent)' : 'var(--text)',
    fontSize: 12,
  };
}
