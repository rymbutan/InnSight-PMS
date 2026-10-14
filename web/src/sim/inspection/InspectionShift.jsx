import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { RoomShell, Player } from '../RoomFreeRoam';
import TouchControls, { makeTouchInput } from '../../components/TouchControls';
import { useCoarsePointer } from '../../lib/touchInput';
import { getRoomPlan } from '../roomLayouts';
import { stageColor } from '../stageColor';
import Assessment from '../Assessment';
import api from '../../api';
import { makeCaseFile } from './caseFile';
import { applyDefects } from './defects';
import { fromScenario, pickScenario } from './scenario';
import { scoreInspection, isCorrectChoice } from './inspectionScore';
import Clipboard from './Clipboard';
import FlagMenu from './FlagMenu';
import Icon from '../../components/Icon';
import useInlineGuide from '../../guides/useInlineGuide';
import inspectionGuide from '../../guides/inspection-shift';

// ─────────────────────────────────────────────────────────────────────────────
// The inspection case study (Changes-to-be-made doc, item 3).
//
// The student is handed a booking and a room that someone else already turned
// over, and must judge the room AGAINST the booking. The 3D room, its furniture
// data and the walk/look controls are the existing ones — the reviewer's note on
// the screenshot was "retain layout", and this is what that means: only the task
// layer on top changed.
// ─────────────────────────────────────────────────────────────────────────────

// Invisible hitboxes over the inspectable objects. They must not look like
// targets until hovered, or the room would advertise its own answers.
const VERDICT_GREEN = '#22c55e';
const VERDICT_RED = '#ef4444';

// The outline round a judged item. A component so the geometry is built once per
// size, not on every render of the whole shift.
function VerdictEdges({ size, color }) {
  const geo = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(...size)),
    [size[0], size[1], size[2]]
  ); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color={color} />
    </lineSegments>
  );
}

function Anchors({ anchors, resolved, hover, groupRef }) {
  return (
    <group ref={groupRef}>
      {anchors.map((a) => {
        const done = resolved[a.id];
        const active = hover === a.id;
        const [w, h, d] = a.size || [1, 1, 1];
        // Once judged, the box turns green if the call was right and red if it
        // was wrong, and gets an outline so it still reads over a busy model.
        const verdict = done ? (isCorrectChoice(a, done) ? VERDICT_GREEN : VERDICT_RED) : null;
        return (
          <group key={a.id} position={[a.pos[0], (a.y ?? 0) + h / 2, a.pos[1]]}>
            {/* No onClick and no cursor swapping any more. Under pointer lock
                there is no OS cursor to raycast from — r3f would keep firing off
                the last position it saw — so what you are aiming at is decided by
                <CrosshairAim> below, and the click that acts on it is handled
                once, at the document level, rather than per mesh. `userData` is
                how the raycast hit gets back to an anchor id. */}
            <mesh userData={{ anchorId: a.id, done: !!done }}>
              <boxGeometry args={[w, h, d]} />
              <meshBasicMaterial
                color={verdict || '#38bdf8'}
                transparent
                opacity={done ? 0.3 : active ? 0.22 : 0.0}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
            {verdict && <VerdictEdges size={[w, h, d]} color={verdict} />}
          </group>
        );
      })}
    </group>
  );
}

// What the crosshair is on. Raycasts from the exact centre of the frame every
// frame — NDC (0, 0) is the crosshair's own position, so the two can never drift
// apart — and reports the nearest unresolved anchor.
//
// Only fires the callback when the answer CHANGES: this runs at 60fps, and a
// setState per frame would re-render the whole shift sixty times a second.
function CrosshairAim({ groupRef, onAim, paused }) {
  const { camera } = useThree();
  const ray = useRef(new THREE.Raycaster());
  const last = useRef(null);
  useFrame(() => {
    let id = null;
    if (!paused && groupRef.current) {
      ray.current.setFromCamera(CENTRE, camera);
      const hits = ray.current.intersectObjects(groupRef.current.children, true);
      for (const h of hits) {
        const ud = h.object.userData;
        if (!ud?.anchorId) continue;
        // An already-flagged item is not a target. `continue`, not `break`, so a
        // resolved anchor cannot mask an unresolved one standing behind it.
        if (ud.done) continue;
        id = ud.anchorId;
        break;
      }
    }
    if (id !== last.current) {
      last.current = id;
      onAim(id);
    }
  });
  return null;
}
const CENTRE = new THREE.Vector2(0, 0);

export default function InspectionShift({
  room,
  reservation = null,
  scenario = null,
  // Already-loaded scenarios for this tier. Housekeeping holds these from page
  // load, so passing them here means opening an inspection costs no request at
  // all — which is the difference between instant and a 15s timeout offline.
  // `null` means "not supplied, fetch them yourself"; an ARRAY (even empty) means
  // "these are all there are".
  scenarioPool = null,
  recordResult = true,
  onComplete,
  onExit,
}) {
  const tier = room?.roomType?.name || 'Standard';

  // An instructor-authored scenario for this tier wins over generation; with
  // none authored (or the lookup failing) the procedural case still runs, so a
  // tier nobody has authored for keeps working.
  //
  // `scenario` prop = the editor's "preview as student", which pins one exact
  // scenario instead of drawing from the pool.
  const [pooled, setPooled] = useState(null);
  // Nothing to resolve when the caller already handed us a scenario, or a pool to
  // choose from. Only an unsupplied pool costs a request.
  const [loading, setLoading] = useState(!scenario && !Array.isArray(scenarioPool));

  useEffect(() => {
    if (scenario) return undefined;

    // The caller already has the scenarios — use them and render immediately.
    if (Array.isArray(scenarioPool)) {
      setPooled(pickScenario(scenarioPool, tier));
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    // Bounded well below the client default of 15s. This lookup is optional —
    // without it the room generates its own faults — so a slow or absent network
    // must not hold a student in front of a "Preparing the room…" panel.
    api
      .get(`/api/training/scenarios?roomTier=${encodeURIComponent(tier)}&active=true`, {
        timeout: 4000,
      })
      .then(({ data }) => {
        if (!cancelled) setPooled(pickScenario(data, tier));
      })
      .catch(() => {
        if (!cancelled) setPooled(null); // fall back to generation
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tier, scenario, scenarioPool]);

  const chosen = scenario || pooled;

  // One case per mount. Regenerating on re-render would move the answers around
  // underneath the student mid-inspection.
  const built = useMemo(() => {
    if (chosen) {
      const s = { ...chosen, baseLayout: getRoomPlan(chosen.roomTier || tier) };
      // The reservation goes down BOTH paths. A scenario authors what is wrong
      // with the room, never who is arriving — it is drawn for any room of its
      // tier, so it cannot know. Dropping `reservation` here is what once put an
      // invented guest on the clipboard of a real, occupied room while the page
      // that launched the inspection promised the opposite.
      const r = fromScenario(s, { reservation });
      return {
        caseFile: r.caseFile,
        layout: { ...s.baseLayout, furniture: r.layout.furniture },
        anchors: r.anchors,
      };
    }
    const cf = makeCaseFile({ roomTier: tier, reservation });
    const r = applyDefects(getRoomPlan(tier), cf);
    return { caseFile: cf, layout: r.layout, anchors: r.anchors };
  }, [chosen, tier, reservation]);

  const caseFile = built.caseFile;
  const builtLayout = built.layout;
  const anchors = built.anchors;

  // A stocked minibar shows drink cans; an emptied one shows
  // neither. Without the stocked version to compare against, "empty" would be
  // invisible — absence is only legible next to presence.
  const stockProps = useMemo(() => {
    const bar = builtLayout.furniture.find((f) => f.model === 'minibar' || f.model === 'wetbar');
    if (!bar || bar.emptied) return [];
    // Drink cans (real .glb models) standing along the unit's own width axis,
    // so they follow its facing.
    const ry = bar.ry || 0;
    const sx = bar.scale?.[0] ?? 1;
    const y = (bar.y ?? 0) + 0.95 * (bar.scale?.[1] ?? 1);
    return [-0.18, -0.02, 0.14].map((d, i) => ({
      model: i === 1 ? 'canB' : 'canA',
      pos: [bar.pos[0] + Math.cos(ry) * d * sx, bar.pos[1] - Math.sin(ry) * d * sx],
      ry,
      y,
      h: 0.15,
    }));
  }, [builtLayout]);

  const shellLayout = useMemo(
    () => ({ ...builtLayout, furniture: [...builtLayout.furniture.filter((f) => !f.prim), ...stockProps] }),
    [builtLayout, stockProps]
  );

  // Player derives proximity hover from `layout.stations`; feeding it the
  // anchors reuses that logic unchanged.
  const playerLayout = useMemo(
    () => ({ ...shellLayout, stations: anchors.map((a) => ({ key: a.id, pos: a.pos })) }),
    [shellLayout, anchors]
  );

  const [flags, setFlags] = useState([]);
  const [resolved, setResolved] = useState({});
  const [openAnchor, setOpenAnchor] = useState(null);
  const [hover, setHover] = useState(null);
  const [clipboard, setClipboard] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [phase, setPhase] = useState('inspect');
  const [locked, setLocked] = useState(false);

  const interactRef = useRef(null);
  const viewRef = useRef(null);
  // Touch controls replace the mouse-look + WASD path on a coarse pointer. The
  // query is live, so docking a tablet to a keyboard swaps the controls without
  // a reload — see useCoarsePointer.
  const touch = useCoarsePointer();
  const touchInput = useRef(makeTouchInput());
  // The <group> holding every anchor hitbox, so the crosshair raycast has a
  // single subtree to test instead of the whole room.
  const anchorsGroup = useRef(null);

  // The walkthrough guide: pauses the clock and input while its card is up.
  const guide = useInlineGuide(inspectionGuide, { ready: !loading });
  const paused = phase !== 'inspect' || !!openAnchor || clipboard || guide.open;

  // The tour card needs a normal mouse pointer, so release any pointer lock when
  // the guide opens (Player only re-requests it on a click while unpaused).
  useEffect(() => {
    if (guide.open && document.pointerLockElement) document.exitPointerLock?.();
  }, [guide.open]);

  // Act on whatever the crosshair is on. Click and E do the same thing, which is
  // the first-person convention — and E still works while the pointer is not
  // locked, so the shift is finishable by keyboard alone.
  //
  // The click is read at the document level rather than on a mesh because under
  // pointer lock there is no cursor for r3f to hit-test with. It is also gated on
  // `locked`: the very first click is what ENTERS look mode (see Player), and
  // that one must not also flag whatever happened to be under the crosshair.
  // The aim, mirrored into a ref. `act` has to read the CURRENT crosshair
  // target: TouchControls holds one callback for the life of a drag while the
  // crosshair moves under it the whole time, so a callback that closed over
  // `hover` would flag whatever was aimed at when the finger went down.
  //
  // A ref rather than reading it inside a `setHover` updater — an updater must
  // be pure, and this app runs under StrictMode, which calls updaters twice in
  // development. Opening the flag menu from inside one would fire it twice.
  const hoverRef = useRef(null);
  hoverRef.current = hover;

  const act = useCallback(() => {
    if (paused) return;
    const h = hoverRef.current;
    if (h && !resolved[h]) setOpenAnchor(h);
  }, [paused, resolved]);

  useEffect(() => {
    if (paused) return undefined;
    const onDown = (e) => {
      if (e.button !== 0) return;
      // Gated on the lock because the FIRST click is what enters look mode, and
      // that one must not also flag whatever sat under the crosshair. On touch
      // there is no lock and no such first click — the tap comes through
      // TouchControls instead, which is why this handler is mouse-only.
      if (document.pointerLockElement) act();
    };
    const onKey = (e) => {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === 'e' || e.key === 'E') act();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [paused, act]);

  useEffect(() => {
    if (paused) return undefined;
    const t = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [paused]);

  useEffect(() => {
    function onKey(e) {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === 'c' || e.key === 'C') setClipboard((v) => !v);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function choose(category) {
    const a = anchors.find((x) => x.id === openAnchor);
    if (!a) return;
    setFlags((list) => [...list, { anchorId: a.id, defectId: a.defectId, chosenCategory: category }]);
    setResolved((r) => ({ ...r, [a.id]: category }));
    setOpenAnchor(null);
  }

  const items = useMemo(
    () => (phase === 'done' ? scoreInspection({ caseFile, flags, elapsedSec: elapsed }) : []),
    [phase, caseFile, flags, elapsed]
  );

  useEffect(() => {
    // A preview from the scenario editor must never land in anyone's competency
    // record — the instructor is checking their own authoring, not training.
    if (phase === 'done' && items.length && recordResult) onComplete?.(items);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  if (phase === 'done') {
    return <Assessment items={items} onClose={onExit} title="Room inspection" />;
  }

  // Hold the room until we know whether an authored scenario applies. Rendering
  // the procedural case first and swapping it in when the fetch lands would move
  // the faults under a student who had already started looking.
  if (loading) {
    return (
      <div className="cg-overlay" role="dialog" aria-label="Preparing inspection">
        <div className="cg-window fr-window">
          <p style={{ padding: 24 }}>Preparing the room…</p>
        </div>
      </div>
    );
  }

  const reviewed = Object.keys(resolved).length;
  const active = anchors.find((a) => a.id === openAnchor) || null;
  const nearby = anchors.find((a) => a.id === hover) || null;

  // Structure matters here, and it is not cosmetic. The shift used to render
  // `.fr-wrap > .fr-topbar + .fr-canvas` — four class names with NO rules in
  // styles.css, because they were renamed without the stylesheet following. The
  // consequences were all silent:
  //
  //  • `.fr-wrap` was an unstyled block in normal flow instead of a full-screen
  //    overlay, so the inspection laid itself out BELOW the hotel map, off-screen.
  //  • the R3F <Canvas> sizes itself to its parent; `.fr-canvas` had no height, so
  //    the canvas resolved to 0 px and the room never drew.
  //  • `.insp-clipboard`, `.fr-crosshair`, `.fr-prompt` and `.insp-flag-backdrop`
  //    are all `position: absolute`. With no positioned ancestor they escaped to
  //    the initial containing block and floated over the map — which is the only
  //    part of the inspection anyone ever saw.
  //
  // `.cg-overlay > .cg-window.fr-window > .cg-titlebar + .fr-stage` is the house
  // pattern for every full-screen sim (the loading branch above already used it),
  // and it is what the existing `.fr-*` rules are written against: `.fr-window`
  // is the `position: relative` the absolute children anchor to, and `.fr-stage`
  // is the flex-grown box that gives the canvas a real height.
  //
  // `.cg-overlay` is also load-bearing for input: KeyboardShortcuts treats it as
  // the immersive selector, so WASD reaches the player instead of firing the
  // app's global shortcuts.
  return (
    <div className="cg-overlay" role="dialog" aria-label="Room inspection">
      <div className="cg-window fr-window">
        <div className="cg-titlebar">
          <strong>Room inspection</strong>
          <span className="muted">
            {tier} · {caseFile.confirmationNumber}
          </span>
          <span className="cg-task-label" data-tour="g-inspection-progress">
            {reviewed}/{anchors.length} items reviewed
          </span>
          <button
            className="secondary"
            data-tour="g-inspection-booking"
            onClick={() => setClipboard((v) => !v)}
          >
            Booking (C)
          </button>
          <button
            className="secondary"
            onClick={guide.start}
            title="How this inspection works"
            aria-label="How this inspection works"
          >
            <Icon name="help-circle" size={16} />
          </button>
          <button className="secondary" onClick={onExit}>
            Leave
          </button>
          {/* Disabled rather than confirmed: passesInspection() requires EVERY
              injected defect to be found (see inspectionScore.js — no partial
              credit), so finishing with anchors still unreviewed was a
              guaranteed fail on a real defect the student never even saw,
              sending a genuinely well-worked room back to Vacant Dirty. */}
          <button
            data-tour="g-inspection-finish"
            onClick={() => setPhase('done')}
            disabled={reviewed < anchors.length}
          >
            {reviewed < anchors.length
              ? `Finish inspection (${anchors.length - reviewed} left)`
              : 'Finish inspection'}
          </button>
        </div>

        <div className="fr-stage">
          <div className="cv-unzoom">
            <Canvas
              shadows
              dpr={[1, 2]}
              camera={{ fov: 58, near: 0.1, far: 120 }}
              gl={{ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.15 }}
              onCreated={({ gl }) => gl.setClearColor(stageColor())}
            >
              <RoomShell layout={shellLayout} />
              <Anchors anchors={anchors} resolved={resolved} hover={hover} groupRef={anchorsGroup} />
              <CrosshairAim groupRef={anchorsGroup} onAim={setHover} paused={paused} />
              <Player
                paused={paused}
                interactRef={interactRef}
                viewRef={viewRef}
                layout={playerLayout}
                onLockedChange={setLocked}
                touch={touch}
                touchRef={touchInput}
              />
            </Canvas>
          </div>
          <div className="fr-crosshair" data-tour="g-inspection-crosshair" />

          {nearby && !resolved[nearby.id] && !openAnchor && (
            <div className="fr-prompt">
              <strong>{nearby.label}</strong> — click or press E to inspect
            </div>
          )}

          {/* Until the pointer is locked, nothing about the mouse works, so say
              so plainly in the middle of the view rather than letting someone
              waggle a dead mouse at the room. Never shown on touch: there is no
              lock to enter, and telling a tablet user to click would be a lie
              about a control they do not have. */}
          {!touch && !locked && !openAnchor && phase === 'inspect' && !clipboard && (
            <div className="fr-prompt fr-prompt-enter">Click to look around</div>
          )}

          {touch && (
            <TouchControls
              inputRef={touchInput}
              onInteract={act}
              disabled={paused}
              actionLabel="Inspect"
              actionEnabled={!!nearby && !resolved[nearby?.id]}
            />
          )}

          <div className="fr-hint" data-tour="g-inspection-hint">
            {touch ? (
              <>touch the left side to walk · drag the right to look · aim the crosshair, then Inspect</>
            ) : (
              <>
                WASD / arrows to move · mouse to look · aim the crosshair and click or press E ·{' '}
                {locked ? 'Esc to release the pointer' : 'click the room to start'}
              </>
            )}
          </div>
        </div>

        {/* Inside `.fr-window`, not beside it: both are positioned absolutely and
            `.fr-window` is the only `position: relative` ancestor — the clipboard's
            `top: 52px` means "under the titlebar", not "under the app header". */}
        <Clipboard caseFile={caseFile} open={clipboard} onClose={() => setClipboard(false)} />
        <FlagMenu anchor={active} onChoose={choose} onCancel={() => setOpenAnchor(null)} />
        {guide.element}
      </div>
    </div>
  );
}
