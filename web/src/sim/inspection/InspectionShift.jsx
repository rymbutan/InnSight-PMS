import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';

import { RoomShell, Player } from '../RoomFreeRoam';
import { getRoomPlan } from '../roomLayouts';
import Assessment from '../Assessment';
import api from '../../api';
import { makeCaseFile } from './caseFile';
import { applyDefects } from './defects';
import { fromScenario, pickScenario } from './scenario';
import { scoreInspection } from './inspectionScore';
import Clipboard from './Clipboard';
import FlagMenu from './FlagMenu';

// ─────────────────────────────────────────────────────────────────────────────
// The inspection case study (Changes-to-be-made doc, item 3).
//
// The student is handed a booking and a room that someone else already turned
// over, and must judge the room AGAINST the booking. The 3D room, its furniture
// data and the walk/look controls are the existing ones — the reviewer's note on
// the screenshot was "retain layout", and this is what that means: only the task
// layer on top changed.
// ─────────────────────────────────────────────────────────────────────────────

// Props with no .glb in the library are drawn as primitives, the same approach
// the previous Inspection3D used for its lamp/trash/pillow markers.
const PRIM_STYLE = {
  vacuum: { color: '#334155', label: 'vacuum cleaner' },
  bucket: { color: '#eab308', label: 'mop bucket' },
  chemicals: { color: '#16a34a', label: 'cleaning chemicals' },
  rumpled: { color: '#e2e8f0', label: 'unmade bedding' },
  luggagerack: { color: '#78350f', label: 'luggage rack' },
  bottle: { color: '#0ea5e9', label: 'minibar stock' },
  pricecard: { color: '#f8fafc', label: 'price list' },
};

function Prim({ item }) {
  const style = PRIM_STYLE[item.prim] || { color: '#94a3b8' };
  const [w, h, d] = item.size || [0.3, 0.3, 0.3];
  // Scale is applied to the GROUP so a resized prop keeps its authored footprint
  // maths, and the group rides half a scaled height up so it stays on the floor.
  const sy = item.scale?.[1] ?? 1;
  return (
    <group
      position={[item.pos[0], (item.y ?? 0) + (h * sy) / 2, item.pos[1]]}
      rotation={[0, item.ry || 0, 0]}
      scale={item.scale || [1, 1, 1]}
    >
      <RoundedBox args={[w, h, d]} radius={0.03} smoothness={2}>
        <meshStandardMaterial color={style.color} roughness={0.75} />
      </RoundedBox>
    </group>
  );
}

// Invisible hitboxes over the inspectable objects. They must not look like
// targets until hovered, or the room would advertise its own answers.
function Anchors({ anchors, resolved, hover, onPick, dragRef }) {
  return (
    <>
      {anchors.map((a) => {
        const done = resolved[a.id];
        const active = hover === a.id;
        const [w, h, d] = a.size || [1, 1, 1];
        return (
          <group key={a.id} position={[a.pos[0], (a.y ?? 0) + h / 2, a.pos[1]]}>
            <mesh
              onClick={(e) => {
                e.stopPropagation();
                // r3f v8 fires onClick on any press-release pair, so panning the
                // camera across an object counts as clicking it unless the drag
                // is filtered out here. This exact bug once turned "look around
                // the room" into three false clicks (MINIGAMES_REBUILD.md).
                if (dragRef?.current?.moved) return;
                if (done) return;
                onPick(a.id);
              }}
              onPointerOver={() => {
                if (!done) document.body.style.cursor = 'pointer';
              }}
              onPointerOut={() => {
                document.body.style.cursor = 'auto';
              }}
            >
              <boxGeometry args={[w, h, d]} />
              <meshBasicMaterial
                color={done ? '#22c55e' : '#38bdf8'}
                transparent
                opacity={done ? 0.16 : active ? 0.22 : 0.0}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
          </group>
        );
      })}
    </>
  );
}

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

  // Primitive props are rendered here, not by RoomShell: FixtureBody falls
  // through to renderFix(item.type) for anything without a `model`, and these
  // have neither.
  const prims = useMemo(() => builtLayout.furniture.filter((f) => f.prim), [builtLayout]);

  // A stocked minibar shows bottles and a price card; an emptied one shows
  // neither. Without the stocked version to compare against, "empty" would be
  // invisible — absence is only legible next to presence.
  const stockProps = useMemo(() => {
    const bar = builtLayout.furniture.find((f) => f.model === 'minibar' || f.model === 'wetbar');
    if (!bar || bar.emptied) return [];
    const [x, z] = bar.pos;
    return [
      { prim: 'bottle', pos: [x - 0.18, z], size: [0.09, 0.24, 0.09], y: 0.95 },
      { prim: 'bottle', pos: [x - 0.02, z], size: [0.09, 0.24, 0.09], y: 0.95 },
      { prim: 'bottle', pos: [x + 0.14, z], size: [0.09, 0.24, 0.09], y: 0.95 },
      { prim: 'pricecard', pos: [x + 0.32, z], size: [0.16, 0.2, 0.02], y: 0.95 },
    ];
  }, [builtLayout]);

  const shellLayout = useMemo(
    () => ({ ...builtLayout, furniture: builtLayout.furniture.filter((f) => !f.prim) }),
    [builtLayout]
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

  const dragRef = useRef({ moved: false });
  const interactRef = useRef(null);
  const viewRef = useRef(null);

  const paused = phase !== 'inspect' || !!openAnchor || clipboard;

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

  return (
    <div className="fr-wrap">
      <div className="fr-topbar">
        <div>
          <strong>Room inspection</strong> · {tier} · {caseFile.confirmationNumber}
        </div>
        <div className="muted">
          {reviewed}/{anchors.length} items reviewed
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="secondary" onClick={() => setClipboard((v) => !v)}>
            Booking (C)
          </button>
          <button className="secondary" onClick={onExit}>
            Leave
          </button>
          <button onClick={() => setPhase('done')}>Finish inspection</button>
        </div>
      </div>

      <div className="fr-canvas">
        <Canvas
          shadows
          dpr={[1, 2]}
          camera={{ fov: 58, near: 0.1, far: 120 }}
          gl={{ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.15 }}
          onCreated={({ gl }) => gl.setClearColor('#d8cdb8')}
        >
          <RoomShell layout={shellLayout} />
          {[...prims, ...stockProps].map((p, i) => (
            <Prim key={`p${i}`} item={p} />
          ))}
          <Anchors
            anchors={anchors}
            resolved={resolved}
            hover={hover}
            onPick={setOpenAnchor}
            dragRef={dragRef}
          />
          <Player
            paused={paused}
            onHover={setHover}
            interactRef={interactRef}
            viewRef={viewRef}
            layout={playerLayout}
            dragRef={dragRef}
            onLockedChange={setLocked}
          />
        </Canvas>
        <div className="fr-crosshair" />

        {nearby && !resolved[nearby.id] && !openAnchor && (
          <div className="fr-prompt">
            <strong>{nearby.label}</strong> — click to inspect
          </div>
        )}

        <div className="fr-help">
          WASD / arrows to move · drag to look · click an item to inspect it ·{' '}
          {locked ? 'Esc to release' : 'L for mouse-look'}
        </div>
      </div>

      <Clipboard caseFile={caseFile} open={clipboard} onClose={() => setClipboard(false)} />
      <FlagMenu anchor={active} onChoose={choose} onCancel={() => setOpenAnchor(null)} />
    </div>
  );
}
