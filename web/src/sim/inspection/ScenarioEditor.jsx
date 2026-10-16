import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, TransformControls, Bounds } from '@react-three/drei';
import * as THREE from 'three';
import { TOUCH } from 'three';

import api from '../../api';
import { useToast, errMsg } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import Icon from '../../components/Icon';
import { useTheme } from '../../theme';
import { RoomShell, FixtureBody, itemY } from '../RoomFreeRoam';
import { refOf, scenarioCounts } from './scenario';
import { generateRandomScenario, fitAddedToLayout, newSeed, LEVELS } from './randomScenario';
import {
  yawFromQuaternion,
  isLockedBase,
  duplicateAdded,
  buildScenarioPayload,
  savableProblem,
  objectsFromScenario,
} from './scenarioEdit';
import { variantsFor, labelFor } from './assetFamilies';
import { getRoomPlan } from '../roomLayouts';
import { stageColor } from '../stageColor';
import SaveChip from '../SaveChip';
import { MODELS } from '../task3d';
import { offerableCategories, allCategories, BUILTIN_CATEGORIES } from './categories';
import { hydrateCategories } from './categorySync';
import InspectionShift from './InspectionShift';
import { useSavedScenarios, STATUS } from './useSavedScenarios';
import SavedScenarioList from './SavedScenarioList';
import useInlineGuide from '../../guides/useInlineGuide';
import scenarioEditorGuide from '../../guides/scenario-editor';

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

// Primitive props (vacuum, mop bucket ...) can no longer be authored: the server
// rejects an added object without a model. PRIM_COLOR stays only so an object
// that somehow still carries a `prim` renders rather than crashing.
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
function EditorObject({ item, selected, onSelect, onAttach }) {
  const ref = useRef();
  useEffect(() => {
    // Mutating a ref doesn't trigger a re-render, so the gizmo below would
    // still be reading the PREVIOUS selection's object on the very render
    // where selection changes (a new object added, or a different object
    // clicked) — it attached one step late, which read as the move tool
    // being on the wrong object or "teleporting". Going through state makes
    // the gizmo pick up the right object on the next render instead.
    if (!selected) return;
    onAttach(ref.current);
    return () => onAttach(null);
  }, [selected, onAttach]);

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

// The left panel's three tabs, ordered by how often you are in each.
const SE_TABS = [
  { id: 'build', label: 'Build', icon: 'armchair', title: 'Add objects and edit the selected one' },
  { id: 'scenario', label: 'Scenario', icon: 'file-text', title: 'Tier and name' },
  { id: 'faults', label: 'Faults', icon: 'alert-circle', title: 'The shared fault-category library' },
];

// Shortcuts and a short guide, in the same panel shape the layout editor uses.
const SE_KEYS = [
  ['⌘S / Ctrl+S', 'Save the scenario'],
  ['M', 'Move gizmo'],
  ['R', 'Rotate gizmo (yaw only)'],
  ['⌘Z / Ctrl+Z', 'Undo'],
  ['⇧⌘Z / Ctrl+Y', 'Redo'],
];

function ScenarioHelp({ onClose }) {
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
          <strong>Scenario editor — guide</strong>
          <button className="tool-btn" onClick={onClose} aria-label="Close help" title="Close (Esc)">
            <Icon name="x" size={16} strokeWidth={2} />
          </button>
        </div>
        <div className="ed-help-body">
          <h4>What you are authoring</h4>
          <p className="ed-help-note">
            The room as it should <em>not</em> be. Break it the way a rushed turnover would, then tag each
            wrong object with the kind of fault it is. What you see here is what the student walks into.
          </p>
          <h4>Steps</h4>
          <ol className="ed-help-steps">
            <li>
              Pick a <strong>tier</strong> and name the scenario.
            </li>
            <li>
              <strong>Add objects</strong> from the picker, or select ones already in the room.
            </li>
            <li>
              <strong>Place them</strong> with the gizmo — Move and Rotate on the toolbar.
            </li>
            <li>
              <strong>Tag the faults.</strong> An untagged object is a decoy, and decoys are what stop
              students flagging everything that highlights.
            </li>
            <li>
              <strong>Preview</strong> runs the real inspection with recording off, then <strong>Save</strong>
              .
            </li>
          </ol>
          <h4>Shortcuts</h4>
          <table className="ed-help-keys">
            <tbody>
              {SE_KEYS.map(([k, what]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>The booking on the clipboard</h4>
          <p className="ed-help-note">
            Not authored here. The student inspects against the <strong>real reservation on the room</strong>{' '}
            — guest, party size and special requests all come from the PMS, so one scenario works on any room
            of its tier. A fault that booking cannot support (twin beds tagged for a couple, on a solo stay)
            is shown as a clean decoy rather than graded. Previewing as a student uses a practice booking,
            marked as such.
          </p>
          <h4>Careful with</h4>
          <p className="ed-help-note">
            A new scenario is created <strong>inactive</strong> and does not autosave until you press Create
            scenario; once it exists, edits autosave. It only reaches students after you press{' '}
            <strong>Activate</strong> in the saved list, and edits to an active scenario are live for them
            immediately. Objects that come from the room&apos;s built-in layout can be turned, resized,
            swapped and tagged, but not moved, deleted or duplicated; objects you add can do all three. You
            are asked before unsaved work is discarded.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function ScenarioEditor({ onClose, initialScenarioId = null, onScenarioChange }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [tier, setTier] = useState('Standard');
  // The library lives in its own hook — see useSavedScenarios. The callbacks are
  // memoised because the hook fetches in an effect keyed on them; a fresh arrow
  // each render would re-fetch the list on every keystroke in the editor.
  const onListError = useCallback((m) => toast.error(m), [toast]);
  const onListSuccess = useCallback((m) => toast.success(m), [toast]);
  const {
    savedScenarios,
    loaded: listLoaded,
    reload: reloadScenarios,
    setStatus: setScenarioStatus,
    remove: removeScenario,
  } = useSavedScenarios({ onError: onListError, onSuccess: onListSuccess, confirm });
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
  // The randomizer's knobs, and the seed of the last roll so a good one can be
  // told apart from the next.
  const [randLevel, setRandLevel] = useState('medium');
  const [randBooking, setRandBooking] = useState(false);
  const [lastSeed, setLastSeed] = useState(null);
  // The `keys` of the last two rolls, newest first — fed back so a re-roll varies.
  const recentRolls = useRef([]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  // idle | saving | saved | error — what the autosave is doing, mirrored into
  // the SaveChip in the toolbar. Only meaningful once the scenario exists; the
  // chip shows 'pending' until then.
  const [saveState, setSaveState] = useState('idle');
  const [saveError, setSaveError] = useState('');
  // The payload JSON the editor last loaded or saved — "dirty" means the current
  // payload differs from it. null until a scenario exists; drafts compare against
  // the untouched tier layout instead (see draftBaseline).
  const [baseline, setBaseline] = useState(null);
  // A row in the pre-overlay format (full furniture snapshot). It renders as
  // authored but has no stable refs, so this editor cannot save it back.
  const [legacy, setLegacy] = useState(false);
  // Size box text while it is being typed; committed on blur/Enter. Clamping on
  // every keystroke made "150" impossible to type (the 1 became 10).
  const [sizeDraft, setSizeDraft] = useState(null);
  const [history, setHistory] = useState([]);
  // The redo branch, plus the chrome state the toolbar drives.
  const [future, setFuture] = useState([]);
  const [sideOpen, setSideOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [panelTab, setPanelTab] = useState('build');
  const { theme, toggle: toggleTheme } = useTheme();
  const guide = useInlineGuide(scenarioEditorGuide, { ready: listLoaded });

  const orbit = useRef();
  const [selObj, setSelObj] = useState(null);
  const attachSelObj = useCallback((node) => setSelObj(node), []);
  // A gizmo arrow is deliberately drawn away from the object it moves, so a
  // drag routinely ends with the mouse over a totally different mesh (or
  // empty floor) rather than the object just dropped. The browser's native
  // `click` fires there right after mouseup, which — left unguarded —
  // reselects whatever's underneath (or clears selection via
  // onPointerMissed), which is what reads as the move tool "teleporting".
  // Set true for the whole drag gesture and cleared on a macrotask (after
  // that trailing click has already been ignored), so onSelect/
  // onPointerMissed can tell a drag-release click apart from a real one.
  const draggingRef = useRef(false);

  const base = useMemo(() => getRoomPlan(tier), [tier]);

  // Every object carries an id so selection survives edits; the base layout's
  // furniture has none, so they are stamped on load.
  // Refresh the library from the server and mirror it into local state.
  async function reloadCategories() {
    const rows = await hydrateCategories({ force: true });
    setCats(offerableCategories());
    // hydrateCategories swallows a failure (the built-ins still work), which left
    // the author looking at a stale list with no hint that it was stale.
    if (rows === null) {
      toast.warning(
        'Could not refresh the fault-category list — it may be out of date. Reload the page to retry.'
      );
      return false;
    }
    return true;
  }

  useEffect(() => {
    reloadCategories();
  }, []);

  // The id to restore, captured ONCE at mount. It cannot read the prop later:
  // the mirror effect below rewrites the URL, which changes the prop, so the
  // thing we are trying to restore would be erased by the act of syncing.
  const wanted = useRef(initialScenarioId);
  const restored = useRef(false);

  // Mirror the open scenario into the URL. Driven off `editingId` rather than
  // called from each of the three places that set it — save, open and new — so
  // a fourth caller added later cannot forget to keep the address bar honest.
  //
  // HELD until the restore has run. On mount `editingId` is null, so without
  // this guard the very first pass wrote "no scenario open" to the URL and
  // deleted the `?scenario=` it was about to be restored from — the reload
  // feature undoing itself one render before it worked.
  useEffect(() => {
    if (wanted.current && !restored.current) return;
    onScenarioChange?.(editingId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  // Clicking an object in the 3D view jumps to the tab that can edit it.
  // Without this, selecting something while on Scenario or Faults appeared to
  // do nothing — the inspector was rendered, just on a tab you were not
  // looking at.
  useEffect(() => {
    if (selId) setPanelTab('build');
  }, [selId]);

  // Editor shortcuts. Only M and R — this editor persists position and yaw, so
  // there is no scale gizmo for T to switch to. Guarded on the modifier keys so
  // ⌘R still reloads, and skipped entirely while a field has focus, since every
  // one of these is a bare letter and the panel is full of text inputs.
  useEffect(() => {
    const onKey = (e) => {
      // The preview is the student's inspection; none of the editor's shortcuts
      // (least of all ⌘S) may act on the scenario behind it.
      if (preview) return;
      // ⌘S / Ctrl+S is checked BEFORE the focus guard below, deliberately.
      // Naming a scenario and pressing save without leaving the field is the
      // normal way to use it, so a shortcut that stops working the moment the
      // cursor is in an input is a shortcut nobody can rely on. preventDefault
      // is what stops the browser opening its own "Save page as" dialog.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!busy) save();
        return;
      }
      const t = e.target.tagName;
      // Everything below is a bare letter or a text-editing chord, so it stays
      // out of the way while a field has focus — ⌘Z in a text box has to mean
      // "undo my typing", not "undo the scene".
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redoAction();
        else undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redoAction();
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setMode('translate');
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        setMode('rotate');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Saving a category writes to the SHARED library, so it immediately becomes
  // available on every other scenario and room — not just this one.
  async function saveCategory(e) {
    e.preventDefault();
    const label = catForm.label.trim();
    const why = catForm.why.trim();
    if (!label) return toast.error('Give the category a name.');
    if (!why) return toast.error('Say why it is a fault — the student sees this after grading.');
    // The server derives the id from the label, so a label that matches a
    // built-in or an existing category would collide with it. Say so up front.
    const key = (v) =>
      String(v || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    if (BUILTIN_CATEGORIES.some((c) => key(c.label) === key(label) || key(c.title) === key(label))) {
      return toast.error(`"${label}" is already a built-in category — pick a different name.`);
    }
    if (allCategories().some((c) => c.custom && c.active !== false && key(c.label) === key(label))) {
      return toast.error(`A category named "${label}" already exists.`);
    }
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
    const ok = await confirm({
      title: 'Retire category',
      message: `Retire “${cat.label}”?`,
      detail: 'Scenarios already using it keep working.',
      confirmLabel: 'Retire',
    });
    if (!ok) return;
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

  // Reopen the scenario named in the URL, once, after the list arrives.
  // `restored` is a ref rather than state so it cannot re-trigger: without the
  // guard, `scenarios` changing after any save would reopen the stored copy and
  // throw away whatever was on screen.
  useEffect(() => {
    if (restored.current || !listLoaded) return;
    if (!wanted.current) {
      // Nothing to restore — open the gate so the mirror effect can run.
      restored.current = true;
      return;
    }
    const found = savedScenarios.find((s) => s.id === wanted.current);
    // Set BEFORE dispatching either branch, so the mirror effect above is
    // released in the same pass rather than staying blocked if openScenario
    // throws.
    restored.current = true;
    // A missing id means the scenario was deleted, or the link is stale. Drop
    // it from the URL rather than leaving an address that describes nothing.
    if (found) openScenario(found);
    else onScenarioChange?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedScenarios, listLoaded]);

  // Start a fresh scenario from the tier's correct room.
  useEffect(() => {
    if (editingId) return;
    setObjects(seedFromTier(tier));
    setSelId(null);
    // The stacks hold objects seeded from the PREVIOUS tier; one Undo would paste
    // another room's furniture into this one.
    resetHistory(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, editingId]);

  const sel = objects.find((o) => o.id === selId) || null;

  // Loading a DIFFERENT scenario has to drop both stacks. They hold object
  // arrays from whatever was open before, and nothing in them is tagged with
  // which scenario it came from — so one press of Undo after opening scenario B
  // restored scenario A's objects into B, and Save would then persist the mix.
  // Called from every path that replaces `objects` wholesale.
  function resetHistory() {
    setHistory([]);
    setFuture([]);
  }

  function snapshot() {
    setHistory((h) => [...h.slice(-19), objects]);
    // A new edit invalidates the redo branch: the future it led to no longer
    // follows from the present, so replaying it would paste a state that was
    // never reachable from what is on screen.
    setFuture([]);
  }
  // FLAT, not nested. These used to call setObjects/setFuture from INSIDE a
  // setHistory updater. A state updater must be a pure function of its previous
  // value — React is free to call it more than once for a single update, and in
  // StrictMode it deliberately does. Every extra call replayed the side effects,
  // pushing the same state onto the redo stack twice, so undo/redo drifted out
  // of step after a few presses.
  //
  // Both run from event handlers, so `objects`, `history` and `future` from the
  // render closure are the current values — no updater callback is needed to
  // read them correctly.
  function undo() {
    if (!history.length) return;
    const prev = history[history.length - 1];
    setHistory(history.slice(0, -1));
    setFuture((f) => [...f.slice(-19), objects]);
    setObjects(prev);
    // The object you were editing may not exist in the state being restored.
    setSelId((id) => (prev.some((o) => o.id === id) ? id : null));
  }
  function redoAction() {
    if (!future.length) return;
    const next = future[future.length - 1];
    setFuture(future.slice(0, -1));
    setHistory((h) => [...h.slice(-19), objects]);
    setObjects(next);
    setSelId((id) => (next.some((o) => o.id === id) ? id : null));
  }

  // Camera presets, same two the layout editor has. The offset on the bird's-eye
  // position is deliberate: OrbitControls has no azimuth at the pole, so a
  // perfectly vertical camera leaves the first drag snapping wildly.
  function birdsEye() {
    const c = orbit.current;
    if (!c) return;
    const h = Math.max(base.w, base.l) * 1.3 + 4;
    c.object.position.set(0, h, 0.001);
    c.target.set(0, 0, 0);
    c.object.up.set(0, 1, 0);
    c.object.lookAt(0, 0, 0);
    c.update();
  }
  function defaultView() {
    const c = orbit.current;
    if (!c) return;
    c.object.position.set(7, 6, 7);
    c.target.set(0, 0, 0);
    c.object.up.set(0, 1, 0);
    c.object.lookAt(0, 0, 0);
    c.update();
  }

  function patchSel(patch) {
    setObjects((list) => list.map((o) => (o.id === selId ? { ...o, ...patch } : o)));
  }

  // Build a whole scenario from the tier's CURRENT layout in one click. It lands
  // as an ordinary unsaved edit — snapshot() first, so Undo brings back whatever
  // was here — and the author can tweak, re-roll or save it like any other.
  async function randomize() {
    if (legacy) {
      return toast.error('This scenario uses an older format that cannot be edited here.');
    }
    const hasWork = !!editingId || objects.some((o) => o.added || o.defectId !== undefined);
    if (hasWork) {
      const ok = await confirm({
        title: 'Randomize this scenario?',
        message: 'This replaces the faults, decoys and added props you have here with a new random set.',
        detail: 'You can undo it straight afterwards.',
        confirmLabel: 'Randomize',
      });
      if (!ok) return;
    }
    snapshot();
    const seed = newSeed();
    const r = generateRandomScenario({
      plan: getRoomPlan(tier),
      baseObjects: seedFromTier(tier),
      makeId: nextId,
      seed,
      level: randLevel,
      includeBookingFaults: randBooking,
      recent: recentRolls.current,
    });
    // Remember the last two rolls so the next one leans away from them.
    recentRolls.current = [r.keys, ...recentRolls.current].slice(0, 2);
    setObjects(r.objects);
    setSelId(null);
    setLastSeed(seed);
    if (!name.trim()) setName(`${tier} · Random ${seed.toString(36).slice(-4).toUpperCase()}`);
    const short = r.faults < r.wanted;
    toast.success(
      `Randomized: ${r.faults} fault${r.faults === 1 ? '' : 's'} and ${r.decoys} decoy${r.decoys === 1 ? '' : 's'}.` +
        (short ? ` This room only supports ${r.faults} of the ${r.wanted} you asked for.` : '')
    );
  }

  function addObject() {
    snapshot();
    const item = { id: nextId(), added: true, model: addKey, pos: [0, 0], ry: 0 };
    setObjects((list) => [...list, item]);
    setSelId(item.id);
  }

  // Fixtures from the room's built-in layout are LOCKED for delete / duplicate /
  // move: a scenario stores only an overlay on that layout (asset, facing, size,
  // height, tags), so a moved, deleted or copied fixture could be shown here and
  // then silently not saved. Only objects the author ADDED can do these.
  const LOCKED_WHY =
    'Built-in room fixtures cannot be moved, deleted or duplicated in a scenario — only objects you add can. You can still turn, resize, swap and tag it.';

  function removeSel() {
    if (!sel || isLockedBase(sel)) return;
    snapshot();
    setObjects((list) => list.filter((o) => o.id !== selId));
    setSelId(null);
  }

  function duplicateSel() {
    if (!sel || isLockedBase(sel)) return;
    snapshot();
    const copy = duplicateAdded(sel, nextId());
    setObjects((list) => [...list, copy]);
    setSelId(copy.id);
  }

  // Read the gizmo's transform back onto the selected object.
  function commitGizmo() {
    const o = selObj;
    if (!o || !sel) return;
    // A built-in fixture's position is not persisted, so only its facing is read
    // back; the translate gizmo is hidden for it anyway.
    const locked = isLockedBase(sel);
    const isPrim = !!sel.prim;
    const h = (sel.size || [0, 0, 0])[1];
    // A prim's box is centred on its group origin and the group rides half a
    // SCALED height up, so the inverse has to use the scaled height too —
    // otherwise resizing a prop makes it jump the moment you drag it.
    const sy = sel.scale?.[1] ?? 1;
    const y = isPrim ? o.position.y - (h * sy) / 2 : o.position.y;
    // Yaw from the quaternion, NOT o.rotation.y: three re-derives the Euler
    // angles after the gizmo turns the object, confining y to [-90, 90] degrees,
    // so any facing past 90 came back mirrored.
    const ry = round(yawFromQuaternion(o.quaternion), 3);
    if (locked) {
      patchSel({ ry });
      return;
    }
    patchSel({
      pos: [round(o.position.x), round(o.position.z)],
      ry,
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

  // Slider / number edits arrive as a stream of onChange events; one undo entry per
  // gesture (pointer-down or focus to the next one) rather than one per tick.
  const editSnap = useRef(false);
  const beginEdit = () => {
    editSnap.current = false;
  };
  const edit = (fn) => {
    if (!editSnap.current) {
      snapshot();
      editSnap.current = true;
    }
    fn();
  };
  const editProps = { onPointerDown: beginEdit, onFocus: beginEdit, onBlur: beginEdit };

  function commitSize() {
    if (sizeDraft === null) return;
    const raw = sizeDraft;
    const n = Number(raw);
    setSizeDraft(null);
    if (raw.trim() === '' || !Number.isFinite(n)) return;
    if (Math.min(1000, Math.max(10, Math.round(n))) === sizePct) return;
    snapshot();
    setSize(n);
  }
  useEffect(() => {
    setSizeDraft(null);
  }, [selId]);

  // ── Persistence ──
  // What a scenario stores is built by a pure function (see scenarioEdit.js).
  const payloadObj = useMemo(() => buildScenarioPayload({ objects, name, tier }), [objects, name, tier]);
  const payloadJson = useMemo(() => JSON.stringify(payloadObj), [payloadObj]);
  const currentPayload = () => payloadObj;
  // An untouched draft is the bare tier layout with no name; anything else is work.
  const draftBaseline = useMemo(
    () => JSON.stringify(buildScenarioPayload({ objects: seedFromTier(tier), name: '', tier })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tier]
  );
  const dirty = payloadJson !== (editingId ? (baseline ?? payloadJson) : draftBaseline);

  function defaultLabel(o) {
    return (o.model || 'Item').replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  }

  const timerRef = useRef(null);
  // The newest state, for code that outlives a render (the autosave callbacks,
  // the unmount flush).
  const liveRef = useRef({ editingId: null, legacy: false, dirty: false, payload: null, problem: '' });
  useEffect(() => {
    liveRef.current = {
      editingId,
      legacy,
      dirty,
      payload: payloadObj,
      problem: savableProblem(payloadObj, scenarioCounts(payloadObj).faults),
    };
  });

  // Last-chance flush: leaving the editor (route change, tab switch on the host
  // page) used to cancel the 900ms debounce and lose the final edit.
  useEffect(
    () => () => {
      const L = liveRef.current;
      if (L.editingId && L.dirty && !L.legacy && !L.problem) {
        api.patch(`/api/training/scenarios/${L.editingId}`, L.payload).catch(() => {});
      }
    },
    []
  );

  // Closing the tab with unsaved work.
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  async function save() {
    if (legacy) {
      return toast.error(
        'This scenario uses an older format that this editor cannot save. You can preview it; to change it, recreate it as a new scenario.'
      );
    }
    const payload = currentPayload();
    const { faults, decoys } = scenarioCounts(payload);
    const problem = savableProblem(payload, faults);
    if (problem) return toast.error(problem);

    clearTimeout(timerRef.current);
    setBusy(true);
    try {
      if (editingId) {
        await api.patch(`/api/training/scenarios/${editingId}`, payload);
        toast.success(`“${payload.name}” updated.`);
      } else {
        // Created INACTIVE: the schema default is active, which put a half-built
        // scenario in front of students the moment it was created (and autosave
        // then streamed every later edit to them). Activate is the author's call.
        const { data } = await api.post('/api/training/scenarios', { ...payload, active: false });
        setBaseline(JSON.stringify(payload));
        setEditingId(data.id);
        toast.success(`“${payload.name}” created — inactive until you press Activate in the saved list.`);
      }
      setBaseline(JSON.stringify(payload));
      setSaveState('saved');
      setSaveError('');
      // After the save, as a warning: it is advice, not a failure, and it used to
      // be an error toast fired before anything had been sent.
      if (!decoys) {
        toast.warning('Saved — but with no clean decoys, every clickable item is a fault.');
      }
      reloadScenarios();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  // ── Autosave, once the scenario exists ────────────────────────────────────
  // Deliberately NOT from the first keystroke: a scenario needs a name and at
  // least one tagged fault before it is savable (see save()), and creating is an
  // explicit act — autosave never invents a row. Once it exists, 900ms of
  // stillness ends an edit.
  //
  // Only when something CHANGED. Merely opening a scenario used to fire a PATCH
  // with zero edits, which could silently drop tags whose fixture had moved.
  async function autosave(payload, id) {
    try {
      await api.patch(`/api/training/scenarios/${id}`, payload);
      if (liveRef.current.editingId === id) {
        setBaseline(JSON.stringify(payload));
        setSaveState('saved');
        setSaveError('');
      }
      reloadScenarios();
      return true;
    } catch (e) {
      // Quiet on success — a toast every 900ms while dragging is noise. A failure
      // still speaks, because silently not saving is the bad case.
      if (liveRef.current.editingId === id) {
        setSaveState('error');
        setSaveError(e.response?.data?.error || e.message);
      }
      toast.error(errMsg(e));
      return false;
    }
  }

  useEffect(() => {
    if (!editingId || legacy) return;
    if (!dirty) {
      setSaveState((st) => (st === 'saving' ? 'saved' : st));
      return;
    }
    const payload = currentPayload();
    const problem = savableProblem(payload, scenarioCounts(payload).faults);
    if (problem) {
      // Not 'saved': the server does NOT have these edits, and saying so is the
      // whole point of the chip.
      setSaveState('error');
      setSaveError(`Not autosaving — ${problem}`);
      return;
    }
    setSaveState('saving');
    timerRef.current = setTimeout(() => autosave(payload, editingId), 900);
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadJson, baseline, editingId, legacy]);

  // Send any pending autosave now. True when the server has the latest state.
  async function flushSave() {
    clearTimeout(timerRef.current);
    setSaveState('saving');
    return autosave(currentPayload(), editingId);
  }

  // Resolves true when it is safe to replace what is on screen: nothing unsaved,
  // the pending edits were flushed to the server, or the author agreed to discard.
  async function guardLeave() {
    if (!dirty) return true;
    if (editingId && !legacy && !savableProblem(payloadObj, scenarioCounts(payloadObj).faults)) {
      if (await flushSave()) return true;
    }
    return confirm({
      title: 'Unsaved changes',
      message: editingId ? 'Discard the changes that could not be saved?' : 'Discard this unsaved scenario?',
      detail: editingId
        ? 'They are not on the server yet.'
        : 'It has not been created yet, so nothing of it has been saved.',
      confirmLabel: 'Discard',
    });
  }

  async function requestClose() {
    if (await guardLeave()) onClose();
  }
  async function requestOpen(s) {
    if (await guardLeave()) openScenario(s);
  }
  async function requestNew() {
    if (await guardLeave()) newScenario();
  }

  // Changing tier on a draft reseeds the room from that tier and throws away
  // everything placed, edited or tagged — so ask first when there is any.
  async function changeTier(next) {
    if (next === tier) return;
    const p = payloadObj;
    const hasWork = p.added.length || p.tags.length || Object.keys(p.swaps).length;
    if (hasWork) {
      const ok = await confirm({
        title: 'Change room tier',
        message: `Switch to ${next}?`,
        detail:
          'The room is rebuilt from that tier’s layout; objects you added, edited or tagged will be discarded.',
        confirmLabel: 'Change tier',
      });
      if (!ok) return;
    }
    setTier(next);
  }

  function openScenario(s) {
    const {
      objects: objs,
      legacy: isLegacy,
      droppedTags,
      droppedPrims,
    } = objectsFromScenario(s, seedFromTier(s.roomTier), nextId);
    setEditingId(s.id);
    setTier(s.roomTier);
    setName(s.name);
    setObjects(objs);
    setSelId(null);
    resetHistory();
    setLegacy(isLegacy);
    // Baseline = what was LOADED, so the dropped tags/props below do not count as
    // an edit and nothing autosaves until the author actually changes something.
    setBaseline(JSON.stringify(buildScenarioPayload({ objects: objs, name: s.name, tier: s.roomTier })));
    setSaveState('idle');
    setSaveError('');
    if (isLegacy) {
      toast.warning(
        'This scenario uses an older format. You can preview it, but it cannot be edited or saved here.'
      );
    }
    if (droppedTags) {
      const one = droppedTags === 1;
      toast.warning(
        `${droppedTags} tag${one ? '' : 's'} on this scenario pointed at room fixtures that have moved or been removed since it was saved, so ${one ? 'it was' : 'they were'} dropped. Your next change will save without ${one ? 'it' : 'them'}.`
      );
    }
    // The layout may have been edited since this was saved. Say so rather than
    // changing the scenario underneath the author: the objects stay as saved, and
    // the inspection nudges or drops what no longer fits when it is played.
    if (!isLegacy && Array.isArray(s.added) && s.added.length) {
      const fit = fitAddedToLayout(s.added, getRoomPlan(s.roomTier), s.tags);
      const n = fit.moved.length + fit.dropped.length;
      if (n) {
        toast.warning(
          `${n} added item${n === 1 ? '' : 's'} no longer fit${n === 1 ? 's' : ''} this room's layout (it was edited after this scenario was saved). ` +
            `They will be ${fit.dropped.length ? 'moved or removed' : 'moved'} when it is played — move ${n === 1 ? 'it' : 'them'} here and save to fix that.`
        );
      }
    }
    if (droppedPrims) {
      const one = droppedPrims === 1;
      toast.warning(
        `${droppedPrims} primitive prop${one ? '' : 's'} (no 3D model) ${one ? 'was' : 'were'} removed — they are no longer supported.`
      );
    }
  }

  // Reset the form to defaults. Also clears the URL's ?scenario= — leaving it
  // pointed at the row you just stopped editing would restore that row on the
  // next reload and quietly discard the blank scenario you had started.
  function newScenario() {
    setEditingId(null);
    setName('');
    setObjects(seedFromTier(tier));
    setSelId(null);
    resetHistory();
    setLegacy(false);
    setBaseline(null);
    setSaveState('idle');
    setSaveError('');
    onScenarioChange?.(null);
  }

  // Delete lives in the hook; the only editor-specific part is that deleting the
  // row currently open has to empty the form behind it.
  async function removeAndClear(s) {
    const gone = await removeScenario(s);
    if (gone && editingId === s.id) newScenario();
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

  const isLive = savedScenarios.find((x) => x.id === editingId)?.status === STATUS.ACTIVE;
  const faultCount = objects.filter((o) => o.defectId).length;
  const decoyCount = objects.filter((o) => o.defectId === null).length;

  return (
    <div
      className="se-wrap"
      data-tour="g-scenario-editor-root"
      // Claims the keyboard from the app's global shortcuts. Without it, bare
      // `d`, `r`, `g`, `n` and `c` navigate away from a scenario you have not
      // saved yet — and `t` toggled the theme mid-edit. The room layout editor
      // has always had this; this editor was the one full-screen surface that
      // did not, so authoring here could be thrown away by a stray keystroke.
      // See components/KeyboardShortcuts.jsx.
      data-keyboard-capture=""
    >
      {/* ── Toolbar strip, full width ──
          Same shape and same `.tool-*` classes as the room layout editor, so
          Move means the same tile in both. Full width rather than inside the
          stage column, so the centre group does not shift when the panel
          collapses. */}
      {guide.element}
      <div className="tool-bar tool-bar--strip">
        <div className="tool-group" data-tour="g-scenario-editor-camera">
          <button
            onClick={undo}
            disabled={!history.length}
            className="tool-btn"
            title="Undo (⌘Z)"
            aria-label="Undo"
          >
            <Icon name="undo" size={18} strokeWidth={1.9} />
          </button>
          <button
            onClick={redoAction}
            disabled={!future.length}
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
            title="Bird's-eye view"
            aria-label="Bird's-eye view"
          >
            <Icon name="bird-eye" size={18} strokeWidth={1.9} />
          </button>
          <button onClick={defaultView} className="tool-btn" title="Default view" aria-label="Default view">
            <Icon name="home" size={18} strokeWidth={1.9} />
          </button>
        </div>

        {/* Two modes, not three: this editor persists position and yaw only, so
            a scale gizmo would move things on screen and discard it on save. */}
        <div className="tool-group tool-group--mid" data-tour="g-scenario-editor-gizmo">
          <button
            className={`tool-btn${mode === 'translate' ? ' is-on' : ''}`}
            onClick={() => setMode('translate')}
            title="Move — M"
            aria-label="Move"
            aria-pressed={mode === 'translate'}
          >
            <Icon name="move" size={18} strokeWidth={1.9} />
          </button>
          <button
            className={`tool-btn${mode === 'rotate' ? ' is-on' : ''}`}
            onClick={() => setMode('rotate')}
            title="Rotate — R"
            aria-label="Rotate"
            aria-pressed={mode === 'rotate'}
          >
            <Icon name="rotate-cw" size={18} strokeWidth={1.9} />
          </button>
        </div>

        <div className="tool-group tool-group--end">
          {/* Same chip the room-layout editor uses. `pending` is the state that
              only exists here: a scenario is not autosaved until it has been
              created once, and showing "Autosave on" over a draft that is not
              being saved would be the one message that actively misleads. */}
          <SaveChip state={editingId ? saveState : 'pending'} error={saveError} />
          {editingId && (
            <span
              className="tool-note"
              title={
                isLive
                  ? 'This scenario is active: students inspecting this tier may get it, and your edits autosave straight to them.'
                  : 'Not live: students do not get this scenario until you press Activate in the saved list.'
              }
            >
              {isLive ? 'Live — edits reach students' : 'Not live'}
            </span>
          )}
          <span className="tool-note" data-tour="g-scenario-editor-counts">
            {faultCount} fault{faultCount === 1 ? '' : 's'} · {decoyCount} decoy
            {decoyCount === 1 ? '' : 's'}
          </span>
          <button
            onClick={toggleTheme}
            className="tool-btn"
            title={theme === 'dark' ? 'Day mode' : 'Night mode'}
            aria-label={theme === 'dark' ? 'Switch to day mode' : 'Switch to night mode'}
            aria-pressed={theme === 'dark'}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} strokeWidth={1.9} />
          </button>
          <button
            onClick={guide.start}
            className="tool-btn"
            title="Guide for this editor"
            aria-label="Guide for this editor"
            data-tour="g-scenario-editor-guide-btn"
          >
            <Icon name="graduation-cap" size={18} strokeWidth={1.9} />
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
      {helpOpen && <ScenarioHelp onClose={() => setHelpOpen(false)} />}

      <div className="se-body">
        {!sideOpen && (
          <div className="ed-rail">
            <button
              className="tool-btn"
              onClick={() => setSideOpen(true)}
              title="Show the scenario panel"
              aria-label="Show the scenario panel"
            >
              <Icon name="chevron-right" size={17} strokeWidth={2} />
            </button>
          </div>
        )}
        {/* Hidden by a class, not an inline `display`, so the stylesheet keeps
            control of the panel's layout — an inline display:block outranks the
            flex column .se-side needs to stretch the saved-scenarios list. */}
        <div className={`se-side${sideOpen ? '' : ' se-side--hidden'}`} data-tour="g-scenario-editor-panel">
          <div className="se-head">
            <strong>Inspection Scenarios</strong>
            <span style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
              <button
                className="tool-btn"
                onClick={() => setSideOpen(false)}
                title="Hide this panel"
                aria-label="Hide the scenario panel"
              >
                <Icon name="chevron-left" size={16} strokeWidth={2} />
              </button>
              <button className="tool-btn" onClick={requestClose} title="Close the editor" aria-label="Close">
                <Icon name="x" size={16} strokeWidth={2} />
              </button>
            </span>
          </div>

          {/* Three tabs instead of one nine-section scroll. The panel was every
            control the editor has, stacked: tier, name, a paragraph about the
            booking, the category library, its add-form, the object picker, a
            four-group inspector, the actions and the saved list — so the thing
            you wanted was almost always below the fold, and finding it meant
            reading past six things you were not doing.

            The split is by WHEN you use them: Build is the loop you are in
            almost all the time, Scenario is opening/naming/saving, Faults is
            the category library you touch rarely. Nothing is removed and no
            handler changes — this only decides what is on screen at once. */}
          <div className="pal-tabs" role="tablist" data-tour="g-scenario-editor-tabs">
            {SE_TABS.map((t) => (
              <button
                key={t.id}
                data-tour={`g-scenario-editor-tab-${t.id}`}
                type="button"
                role="tab"
                aria-selected={panelTab === t.id}
                className={`pal-tab${panelTab === t.id ? ' is-on' : ''}`}
                title={t.title}
                onClick={() => setPanelTab(t.id)}
              >
                <Icon name={t.icon} size={16} strokeWidth={1.9} />
                <span className="se-tab-label">{t.label}</span>
              </button>
            ))}
          </div>

          {panelTab === 'scenario' && (
            <>
              <label>Room tier</label>
              <select
                value={tier}
                onChange={(e) => changeTier(e.target.value)}
                disabled={!!editingId}
                data-tour="g-scenario-editor-tier"
              >
                {TIERS.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              {editingId && <p className="muted se-note">Tier is fixed once a scenario exists.</p>}

              <label>Scenario name</label>
              <input
                data-tour="g-scenario-editor-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Couple in a twin room"
              />
              {/* The booking explanation was a six-line paragraph holding
                permanent space for something you read once. It is in the help
                panel now, one click away and out of the way. */}
              <p className="muted se-note">The booking is not authored here — see Help for why.</p>
            </>
          )}

          {panelTab === 'faults' && (
            <>
              <div className="se-section">Fault categories</div>
              <p className="se-hint">
                The six built-in categories cover most faults. Anything you add here is saved to the shared
                library and offered on <strong>every scenario and every room</strong>.
              </p>
              <ul className="se-cat-list" data-tour="g-scenario-editor-cat-list">
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
              <form onSubmit={saveCategory} className="se-cat-form" data-tour="g-scenario-editor-cat-form">
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
            </>
          )}

          {panelTab === 'build' && (
            <>
              <div className="se-section" data-tour="g-scenario-editor-randomize">
                Randomize
              </div>
              <p className="muted se-note" style={{ marginTop: 0 }}>
                Builds a whole scenario from this room's layout: some faults, some clean decoys, props placed
                on free floor. Built-in furniture never moves.
              </p>
              <select
                value={randLevel}
                onChange={(e) => setRandLevel(e.target.value)}
                aria-label="Difficulty"
              >
                {Object.entries(LEVELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label} — about {v.faults} faults
                  </option>
                ))}
              </select>
              <label
                style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '6px 0', fontWeight: 400 }}
              >
                <input
                  type="checkbox"
                  checked={randBooking}
                  onChange={(e) => setRandBooking(e.target.checked)}
                />
                Include faults that depend on the booking
              </label>
              <button
                onClick={randomize}
                className="tool-btn has-label is-on"
                style={{ width: '100%' }}
                title="Replace this scenario with a random one for the room layout"
              >
                <Icon name="sparkles" size={15} strokeWidth={1.9} />
                Randomize scenario
              </button>
              {lastSeed && (
                <p className="muted se-note" style={{ marginBottom: 0 }}>
                  Last roll: {lastSeed.toString(36).toUpperCase()}. Press again for a different one, or Undo.
                </p>
              )}

              <div className="se-section">Add an object</div>
              <select
                value={addKey}
                onChange={(e) => setAddKey(e.target.value)}
                data-tour="g-scenario-editor-add-select"
              >
                <optgroup label="Room assets">
                  {MODEL_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </optgroup>
              </select>
              <button
                onClick={addObject}
                className="tool-btn has-label is-on"
                style={{ width: '100%', marginTop: 6 }}
                title="Place the selected asset in the room"
              >
                <Icon name="armchair" size={15} strokeWidth={1.9} />
                Add to room
              </button>

              <div className="se-section" data-tour="g-scenario-editor-selected">
                Selected object {sel ? '' : <span className="muted">— click one in the room</span>}
              </div>
              {sel && (
                <>
                  {/* ── OBJECT ─────────────────────────────────────────────── */}
                  <div className="se-group">
                    <div className="se-group-h">Object</div>
                    <div className="se-objname">{defaultLabel(sel)}</div>
                    {isLockedBase(sel) && (
                      <p className="muted se-note" title={LOCKED_WHY}>
                        Built-in fixture — position is locked, and it cannot be deleted or duplicated. You can
                        still turn, resize, swap and tag it.
                      </p>
                    )}
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
                  <div className="se-group" data-tour="g-scenario-editor-placement">
                    <div className="se-group-h">Placement</div>
                    {/* Same handlers and the same two mode values as before — the
                  buttons are the shared `.tool-btn` tiles the room layout
                  editor uses, so Move and Rotate are one shape across both
                  editors instead of two differently-styled text buttons. */}
                    <div className="tool-bar">
                      <button
                        className={`tool-btn${mode === 'translate' ? ' is-on' : ''}`}
                        onClick={() => setMode('translate')}
                        title="Move"
                        aria-label="Move"
                        aria-pressed={mode === 'translate'}
                      >
                        <Icon name="move" size={17} strokeWidth={1.9} />
                      </button>
                      <button
                        className={`tool-btn${mode === 'rotate' ? ' is-on' : ''}`}
                        onClick={() => setMode('rotate')}
                        title="Rotate"
                        aria-label="Rotate"
                        aria-pressed={mode === 'rotate'}
                      >
                        <Icon name="rotate-cw" size={17} strokeWidth={1.9} />
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
                        {...editProps}
                        onChange={(e) => edit(() => setYaw(Number(e.target.value)))}
                      />
                      <input
                        type="number"
                        className="se-yaw-num"
                        value={yawDeg}
                        {...editProps}
                        onChange={(e) => edit(() => setYaw(Number(e.target.value) || 0))}
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
                        {...editProps}
                        onChange={(e) => edit(() => setHeight(Number(e.target.value)))}
                      />
                      <input
                        type="number"
                        className="se-yaw-num"
                        step="0.05"
                        value={heightM}
                        {...editProps}
                        onChange={(e) => edit(() => setHeight(Number(e.target.value)))}
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
                        {...editProps}
                        onChange={(e) => edit(() => setSize(Number(e.target.value)))}
                      />
                      <input
                        type="number"
                        className="se-yaw-num"
                        value={sizeDraft ?? sizePct}
                        onChange={(e) => setSizeDraft(e.target.value)}
                        onBlur={commitSize}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitSize();
                          }
                        }}
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
                  <div className="se-group" data-tour="g-scenario-editor-fault">
                    <div className="se-group-h">What the student should find</div>
                    <select
                      value={
                        sel.defectId === undefined
                          ? 'untagged'
                          : sel.defectId === null
                            ? 'clean'
                            : sel.defectId
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        snapshot();
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
                      {/* A category retired AFTER this fault was tagged is no longer
                          offered, but the tag still holds it — without an option for
                          it the select fell back to showing "Not inspectable". */}
                      {sel.defectId && !offerableCategories().some((o) => o.id === sel.defectId) && (
                        <option value={sel.defectId}>
                          {allCategories().find((c) => c.id === sel.defectId)?.label || sel.defectId}{' '}
                          (retired)
                        </option>
                      )}
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
                  <div className="tool-bar" style={{ marginTop: 6 }}>
                    <button
                      className="tool-btn has-label"
                      onClick={duplicateSel}
                      disabled={isLockedBase(sel)}
                      title={isLockedBase(sel) ? LOCKED_WHY : 'Duplicate this object'}
                    >
                      <Icon name="copy" size={15} strokeWidth={1.9} />
                      Duplicate
                    </button>
                    <button
                      className="tool-btn has-label is-danger"
                      onClick={removeSel}
                      disabled={isLockedBase(sel)}
                      title={isLockedBase(sel) ? LOCKED_WHY : 'Delete this object'}
                      style={{
                        background: 'var(--danger-soft)',
                        borderColor: 'var(--danger)',
                        color: 'var(--on-danger-soft)',
                      }}
                    >
                      <Icon name="trash" size={15} strokeWidth={1.9} />
                      Delete
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {/* Save / Preview / New and the saved list stay OUTSIDE the tabs. They
            are the way out of whatever you are doing, and hiding Save behind a
            tab in an editor that does not autosave is how work gets lost. The
            fault/decoy count moved to the toolbar; Undo moved there beside
            Redo. */}
          <div className="se-section">Scenario</div>
          <div className="row" style={{ gap: 4 }} data-tour="g-scenario-editor-save">
            {/* The shortcut is in the tooltip rather than on the button face: the
              label already switches between two words depending on whether this
              creates or updates, and a chord appended to both makes the button
              the widest thing in a 320px panel. */}
            <button
              onClick={save}
              disabled={busy || legacy}
              title={legacy ? 'Older-format scenario — preview only' : 'Save the scenario (⌘S / Ctrl+S)'}
            >
              {editingId ? 'Save changes' : 'Create scenario'}
            </button>
            <button className="secondary" onClick={previewAsStudent}>
              Preview
            </button>
            {/* "New" used to sit here as well. It is the + New Scenario button
                at the head of the list below — two controls doing the same thing
                a few pixels apart. */}
          </div>

          <div className="se-section" data-tour="g-scenario-editor-saved">
            Saved scenarios
          </div>
          <SavedScenarioList
            scenarios={savedScenarios}
            loaded={listLoaded}
            editingId={editingId}
            onNew={requestNew}
            onEdit={requestOpen}
            onActivate={(s) => setScenarioStatus(s, STATUS.ACTIVE)}
            onDisable={(s) => setScenarioStatus(s, STATUS.DISABLED)}
            onDelete={removeAndClear}
          />
        </div>

        <div className="se-stage" data-tour="g-scenario-editor-stage">
          <div className="cv-unzoom">
            <Canvas
              shadows
              dpr={[1, 2]}
              camera={{ position: [7, 6, 7], fov: 50 }}
              gl={{ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.15 }}
              onCreated={({ gl }) => gl.setClearColor(stageColor())}
              onPointerMissed={() => {
                if (draggingRef.current) return;
                setSelId(null);
              }}
            >
              {/* No `observe`: that made Bounds continuously recompute the scene's
                bounding box and replay its fit/zoom animation on every geometry
                change (adding, dragging, or resizing an object) — fighting the
                user's own OrbitControls zoom and reading as a random zoom-out
                while scrolling. Fit once on mount instead, like RoomLayoutEditor
                already does. */}
              <Bounds fit clip margin={1.1}>
                <RoomShell layout={{ ...base, furniture: [] }} />
                {objects.map((o) => (
                  <EditorObject
                    key={o.id}
                    item={o}
                    selected={o.id === selId}
                    onSelect={(id) => {
                      if (draggingRef.current) return;
                      setSelId(id);
                    }}
                    onAttach={attachSelObj}
                  />
                ))}
              </Bounds>
              {sel && selObj && (
                <TransformControls
                  object={selObj}
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
                  showX={mode !== 'rotate' && !isLockedBase(sel)}
                  showZ={mode !== 'rotate' && !isLockedBase(sel)}
                  // Y is available to EVERYTHING in translate mode. It used to be
                  // gated on `!!sel.prim`, so a model fixture had no vertical arrow at
                  // all — and even if you found one, commitGizmo() only persisted `y`
                  // for prims, so the height was discarded on mouse-up. itemY() has
                  // always honoured `y` for models; only the authoring was missing.
                  // A built-in fixture cannot be moved (its position is not persisted), so
                  // the translate gizmo is hidden for it; rotate still works.
                  showY={mode === 'rotate' || (mode === 'translate' && !isLockedBase(sel))}
                  enabled={mode === 'rotate' || !isLockedBase(sel)}
                  onMouseDown={() => {
                    draggingRef.current = true;
                    snapshot();
                    if (orbit.current) orbit.current.enabled = false;
                  }}
                  onMouseUp={() => {
                    if (orbit.current) orbit.current.enabled = true;
                    commitGizmo();
                    setTimeout(() => {
                      draggingRef.current = false;
                    }, 0);
                  }}
                />
              )}
              <OrbitControls
                ref={orbit}
                makeDefault
                // Same touch mapping as RoomLayoutEditor - the two editors must
                // not need different fingers for the same job.
                touches={{ ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }}
                rotateSpeed={0.55}
                zoomSpeed={0.8}
              />
            </Canvas>
          </div>
          {/* The emoji is gone; the swatch is the same red the halo is drawn in,
            so the key matches what is on screen instead of approximating it
            with whatever red the reader's emoji font happens to use. */}
          <div className="se-legend">
            <span className="se-legend-dot" /> tagged fault · click any object to select · the halo is
            editor-only, students never see it
          </div>
        </div>
      </div>
    </div>
  );
}
