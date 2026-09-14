import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { RoundedBox, ContactShadows, Environment, Lightformer } from '@react-three/drei';
import * as THREE from 'three';
import { Model } from './task3d';
// Collision lives in its own plain .js module so `node --test` can load it —
// this file imports three.js, so nothing inside it is testable.
import { blockersOf, wallBlockers, resolveMove } from './roomCollision';
// Sizing lives in a plain .js module so scripts/check-room-layouts.mjs can import
// it too — the validator needs rendered fixture sizes and cannot read .jsx.
import { MODEL_CFG, MODEL_TF, fitPropsFor } from './modelSizes';

// Re-exported for the layout editor, which imports MODEL_CFG from here.
export { MODEL_CFG, fitPropsFor };

// ─────────────────────────────────────────────────────────────────────────────
// Free-roam first-person housekeeping shift — now fully LAYOUT-DRIVEN.
//
// Everything (room size, walls, furniture, collision, station markers, spawn)
// comes from the `layout` prop (see roomLayouts.js), so a Suite is a bigger,
// multi-zone room with more stations than a Standard with zero special-casing.
// Walk with WASD + first-person mouse-look (click the view to lock the pointer,
// Esc to release), approach a station and press E / click it to perform that
// task (the existing task components), end at the door.
//
// One WebGL context at a time: the room unmounts while a task panel is open and
// restores the camera pose from viewRef.
// ─────────────────────────────────────────────────────────────────────────────

const EYE = 1.55;
const SPEED = 2.7;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── Materials (light-oak + grey-marble + blue-accent palette) ────────────────
const WOOD = '#c29b66'; // light oak paneling / case goods
const WOOD_D = '#9c7846'; // darker oak trim
const PORC = '#f1f5f7'; // porcelain
const MARBLE = '#9a9ba2'; // grey marble (bathroom)
const MARBLE_L = '#c4c6cc';
const FAB = '#a96a6a'; // legacy sofa fallback
const FAB_GREY = '#8d9099'; // grey armchair fabric
const FAB_BLUE = '#3f6fb0'; // blue office chair / pillow / throw accents
const LINEN = '#f4f1ea'; // bed linens
const THROW = '#6f97c4'; // blue bed throw
const METAL = '#9aa3ad';
function Box({ p, s, c, r = 0.04, rough = 0.85 }) {
  return (
    <RoundedBox args={s} radius={r} smoothness={2} position={p} castShadow receiveShadow>
      <meshStandardMaterial color={c} roughness={rough} />
    </RoundedBox>
  );
}

// Circular metal "rings" wall art — the signature piece behind the bed / on walls.
function WallArt() {
  const dots = [
    [-0.7, 0.18],
    [-0.4, 0.5],
    [-0.12, 0.05],
    [0.18, 0.42],
    [0.5, 0.12],
    [0.72, 0.4],
    [0.05, -0.3],
    [-0.5, -0.22],
    [0.42, -0.28],
  ];
  return (
    <group>
      {dots.map(([dx, dy], i) => (
        <mesh key={i} position={[dx, dy, 0.02]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.1, 0.018, 8, 18]} />
          <meshStandardMaterial color={i % 2 ? '#c9a24a' : '#d4d8dd'} metalness={0.85} roughness={0.3} />
        </mesh>
      ))}
    </group>
  );
}
// Slatted feature/TV wall detailing.
function Slats({ w = 2.6, n = 13, h = 3.0 }) {
  const step = w / n;
  return (
    <group>
      {Array.from({ length: n }).map((_, i) => (
        <mesh key={i} position={[-w / 2 + step * (i + 0.5), h / 2, 0.06]}>
          <boxGeometry args={[step * 0.5, h, 0.04]} />
          <meshStandardMaterial color={WOOD_D} roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

// Local-coordinate fixture geometry (centered at origin). The <Furniture> wrapper
// applies the world position + Y-rotation, so any fixture can face any wall.
function renderFix(t, item) {
  switch (t) {
    case 'bed':
      return (
        <group>
          <Box p={[0, 0.3, 0]} s={[2.4, 0.5, 2.0]} c={WOOD} />
          <Box p={[0, 0.82, -1.02]} s={[2.5, 1.05, 0.18]} c={WOOD_D} r={0.05} />
          <Box p={[0, 0.6, 0.05]} s={[2.34, 0.22, 1.86]} c={LINEN} r={0.05} />
          <Box p={[0, 0.62, 0.6]} s={[2.34, 0.12, 0.7]} c={THROW} r={0.04} />
          <Box p={[-0.55, 0.82, -0.6]} s={[0.82, 0.2, 0.5]} c="#fff" r={0.1} />
          <Box p={[0.55, 0.82, -0.6]} s={[0.82, 0.2, 0.5]} c="#fff" r={0.1} />
          <Box p={[0, 0.86, -0.45]} s={[0.5, 0.18, 0.4]} c={FAB_BLUE} r={0.08} />
        </group>
      );
    case 'twin':
      return (
        <group>
          <Box p={[0, 0.3, 0]} s={[1.3, 0.5, 1.9]} c={WOOD} />
          <Box p={[0, 0.6, 0.05]} s={[1.2, 0.22, 1.7]} c={LINEN} r={0.06} />
          <Box p={[0, 0.62, 0.5]} s={[1.2, 0.1, 0.6]} c={THROW} r={0.04} />
        </group>
      );
    case 'nightstand':
      return <Box p={[0, 0.28, 0]} s={[0.5, 0.56, 0.5]} c={WOOD} />;
    case 'sofa':
      return (
        <Model
          modelKey="sofa"
          fitHeight={MODEL_TF.sofa.h}
          rotation={[0, MODEL_TF.sofa.ry, 0]}
          fallback={
            <group>
              <Box p={[0, 0.32, 0]} s={[2.1, 0.5, 0.85]} c={FAB} />
              <Box p={[0, 0.62, -0.35]} s={[2.1, 0.5, 0.18]} c="#c98a8a" />
            </group>
          }
        />
      );
    case 'coffee':
      return (
        <group>
          <Box p={[0, 0.22, 0]} s={[1.1, 0.18, 0.6]} c={WOOD} />
          <group position={[0, 0.31, 0]}>
            <Model modelKey="vase" fitHeight={MODEL_TF.vase.h} fallback={null} />
          </group>
        </group>
      );
    case 'desk':
      return (
        <group>
          <Box p={[0, 0.74, 0]} s={[1.6, 0.06, 0.7]} c={WOOD} />
          {[-0.74, 0.74].map((sx) => (
            <group key={sx}>
              {Array.from({ length: 5 }).map((_, i) => (
                <mesh key={i} position={[sx, 0.37, -0.28 + i * 0.14]} castShadow>
                  <boxGeometry args={[0.04, 0.72, 0.04]} />
                  <meshStandardMaterial color={WOOD} />
                </mesh>
              ))}
            </group>
          ))}
        </group>
      );
    case 'chair':
      return (
        <Model
          modelKey="chair"
          fitHeight={MODEL_TF.chair.h}
          rotation={[0, MODEL_TF.chair.ry, 0]}
          fallback={
            <group>
              <Box p={[0, 0.25, 0]} s={[0.45, 0.08, 0.45]} c={WOOD} />
              <Box p={[0, 0.5, -0.2]} s={[0.45, 0.45, 0.06]} c={WOOD} />
            </group>
          }
        />
      );
    case 'officechair':
      return (
        <group>
          <mesh position={[0, 0.46, 0]} castShadow>
            <boxGeometry args={[0.5, 0.12, 0.5]} />
            <meshStandardMaterial color={FAB_BLUE} />
          </mesh>
          <Box p={[0, 0.8, -0.22]} s={[0.5, 0.62, 0.1]} c={FAB_BLUE} r={0.08} />
          <mesh position={[0, 0.27, 0]}>
            <cylinderGeometry args={[0.035, 0.035, 0.4, 10]} />
            <meshStandardMaterial color="#2b2b2b" metalness={0.6} />
          </mesh>
          {[0, 1, 2, 3, 4].map((i) => {
            const a = (i / 5) * Math.PI * 2;
            return (
              <mesh key={i} position={[Math.cos(a) * 0.24, 0.05, Math.sin(a) * 0.24]}>
                <cylinderGeometry args={[0.04, 0.04, 0.05, 8]} />
                <meshStandardMaterial color="#222" />
              </mesh>
            );
          })}
        </group>
      );
    case 'armchair':
      return (
        <group>
          <Box p={[0, 0.34, 0.05]} s={[0.9, 0.32, 0.85]} c={FAB_GREY} r={0.12} />
          <Box p={[0, 0.72, -0.36]} s={[0.9, 0.6, 0.18]} c={FAB_GREY} r={0.12} />
          <Box p={[-0.42, 0.56, 0.05]} s={[0.14, 0.4, 0.8]} c={FAB_GREY} r={0.08} />
          <Box p={[0.42, 0.56, 0.05]} s={[0.14, 0.4, 0.8]} c={FAB_GREY} r={0.08} />
          <Box p={[0, 0.62, 0.1]} s={[0.42, 0.16, 0.42]} c={FAB_BLUE} r={0.08} />
        </group>
      );
    case 'minibar':
      return (
        <group>
          <Box p={[0, 0.6, 0]} s={[0.7, 1.2, 0.8]} c={METAL} />
          <Box p={[0, 0.6, 0.02]} s={[0.5, 1.0, 0.6]} c="#7f93ad" r={0.02} />
        </group>
      );
    case 'wetbar':
      return (
        <group>
          <Box p={[0, 0.5, 0]} s={[1.7, 1.0, 0.6]} c={WOOD} />
          <Box p={[0, 1.02, 0]} s={[1.7, 0.06, 0.6]} c="#2b2f36" />
          <mesh position={[-0.5, 1.18, 0]} castShadow>
            <cylinderGeometry args={[0.06, 0.06, 0.3, 10]} />
            <meshStandardMaterial color="#6d92c8" />
          </mesh>
          <mesh position={[-0.2, 1.18, 0]} castShadow>
            <cylinderGeometry args={[0.06, 0.06, 0.3, 10]} />
            <meshStandardMaterial color="#c98a8a" />
          </mesh>
        </group>
      );
    case 'wardrobe':
      return <Box p={[0, 1.0, 0]} s={[1.2, 2.0, 0.6]} c={WOOD} />;
    case 'walkin':
      return (
        <group>
          <Box p={[0, 1.15, -0.28]} s={[2.6, 2.3, 0.08]} c={WOOD_D} />
          <Box p={[-0.66, 1.15, -0.12]} s={[0.06, 2.3, 0.5]} c={WOOD} />
          <Box p={[0.66, 1.15, -0.12]} s={[0.06, 2.3, 0.5]} c={WOOD} />
          {[1.5, 1.05, 0.62].map((y, i) => (
            <Box key={i} p={[0, y, -0.16]} s={[1.2, 0.04, 0.34]} c={WOOD} />
          ))}
          <mesh position={[0, 1.85, -0.1]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.02, 0.02, 1.2, 8]} />
            <meshStandardMaterial color={METAL} metalness={0.6} />
          </mesh>
          {[-0.25, 0.25].map((rx, i) => (
            <group key={i} position={[rx, 1.35, -0.06]}>
              <mesh castShadow>
                <cylinderGeometry args={[0.16, 0.22, 0.7, 12]} />
                <meshStandardMaterial color="#f3f1ec" />
              </mesh>
              <mesh position={[0, -0.45, 0]} castShadow>
                <cylinderGeometry args={[0.2, 0.16, 0.5, 12]} />
                <meshStandardMaterial color="#f3f1ec" />
              </mesh>
            </group>
          ))}
        </group>
      );
    case 'vanity':
      return (
        <group>
          <Box p={[0, 0.45, 0]} s={[1.2, 0.9, 0.5]} c={WOOD} />
          <Box p={[0, 0.92, 0]} s={[1.2, 0.05, 0.5]} c={MARBLE} />
          <mesh position={[0, 0.97, 0.02]} castShadow>
            <cylinderGeometry args={[0.24, 0.18, 0.12, 20]} />
            <meshStandardMaterial color={PORC} roughness={0.3} />
          </mesh>
          <Box p={[0, 1.6, -0.24]} s={[0.9, 0.8, 0.04]} c="#cfe6f5" r={0.02} />
        </group>
      );
    case 'twinvanity':
      return (
        <group>
          <Box p={[0, 0.45, 0]} s={[2.2, 0.9, 0.55]} c={WOOD} />
          <Box p={[0, 0.92, 0]} s={[2.2, 0.06, 0.55]} c={MARBLE} />
          {[-0.55, 0.55].map((sx) => (
            <group key={sx}>
              <mesh position={[sx, 0.99, 0.04]} castShadow>
                <cylinderGeometry args={[0.22, 0.16, 0.12, 20]} />
                <meshStandardMaterial color={PORC} roughness={0.3} />
              </mesh>
              <mesh position={[sx, 1.16, -0.16]}>
                <boxGeometry args={[0.04, 0.18, 0.04]} />
                <meshStandardMaterial color={METAL} metalness={0.7} />
              </mesh>
            </group>
          ))}
          <Box p={[0, 1.65, -0.28]} s={[2.0, 0.95, 0.03]} c="#cfe6f5" r={0.02} />
        </group>
      );
    case 'tub':
      return (
        <group>
          <RoundedBox args={[0.85, 0.62, 1.9]} radius={0.16} position={[0, 0.32, 0]} castShadow receiveShadow>
            <meshStandardMaterial color={PORC} roughness={0.35} />
          </RoundedBox>
        </group>
      );
    case 'deckTub':
      return (
        <group>
          <Box p={[0, 0.32, 0]} s={[2.5, 0.62, 1.05]} c={MARBLE} r={0.03} />
          <Box p={[0, 0.5, 0]} s={[2.0, 0.32, 0.72]} c="#cfe9f0" r={0.05} rough={0.2} />
          <mesh position={[-0.85, 0.7, 0]}>
            <cylinderGeometry args={[0.03, 0.03, 0.18, 10]} />
            <meshStandardMaterial color={METAL} metalness={0.7} />
          </mesh>
        </group>
      );
    case 'toilet':
      return (
        <group>
          <mesh position={[0, 0.25, 0]} castShadow>
            <cylinderGeometry args={[0.22, 0.18, 0.5, 18]} />
            <meshStandardMaterial color={PORC} />
          </mesh>
          <Box p={[0, 0.6, -0.22]} s={[0.5, 0.5, 0.22]} c={PORC} />
        </group>
      );
    case 'shower':
      return (
        <group>
          <Box p={[0, 0.03, 0]} s={[1.3, 0.06, 1.3]} c={MARBLE_L} />
          <mesh position={[0, 1.05, 0.64]}>
            <boxGeometry args={[1.3, 2.1, 0.03]} />
            <meshStandardMaterial color="#bcd3da" transparent opacity={0.22} roughness={0.1} />
          </mesh>
          <mesh position={[0.64, 1.05, 0]}>
            <boxGeometry args={[0.03, 2.1, 1.3]} />
            <meshStandardMaterial color="#bcd3da" transparent opacity={0.22} roughness={0.1} />
          </mesh>
          <mesh position={[-0.5, 1.7, -0.6]}>
            <cylinderGeometry args={[0.09, 0.09, 0.04, 16]} />
            <meshStandardMaterial color={METAL} metalness={0.7} />
          </mesh>
        </group>
      );
    case 'dining':
      return (
        <group>
          <Box p={[0, 0.45, 0]} s={[1.8, 0.08, 1.0]} c={WOOD} />
          <Box p={[0, 0.22, 0]} s={[1.5, 0.45, 0.7]} c={WOOD_D} />
        </group>
      );
    case 'counter':
      return (
        <group>
          <Box p={[0, 0.45, 0]} s={[2.0, 0.9, 0.6]} c="#e7e1d6" />
          <Box p={[0, 0.92, 0]} s={[2.0, 0.06, 0.6]} c="#2b2f36" />
        </group>
      );
    case 'console':
      return (
        <group>
          <Box p={[0, 0.26, 0]} s={[2.0, 0.52, 0.42]} c={WOOD} />
          <Box p={[0, 0.53, 0]} s={[2.0, 0.04, 0.42]} c={WOOD_D} />
        </group>
      );
    case 'plant':
      return (
        <Model
          modelKey="plant"
          fitHeight={MODEL_TF.plant.h}
          rotation={[0, MODEL_TF.plant.ry, 0]}
          fallback={
            <group>
              <mesh position={[0, 0.2, 0]}>
                <cylinderGeometry args={[0.16, 0.13, 0.4, 14]} />
                <meshStandardMaterial color="#9a6b3f" />
              </mesh>
              <mesh position={[0, 0.6, 0]} castShadow>
                <sphereGeometry args={[0.3, 14, 14]} />
                <meshStandardMaterial color="#4f7a45" />
              </mesh>
            </group>
          }
        />
      );
    case 'tv':
      return (
        <group>
          <Box p={[0, 0.28, 0]} s={[1.6, 0.56, 0.45]} c={WOOD} />
          <mesh position={[0, 0.64, 0]} castShadow>
            <boxGeometry args={[0.1, 0.22, 0.1]} />
            <meshStandardMaterial color="#222" />
          </mesh>
          <Box p={[0, 1.12, 0]} s={[1.3, 0.75, 0.06]} c="#15181d" r={0.02} />
        </group>
      );
    case 'tvwall':
      return (
        <group>
          <Slats w={2.6} n={13} h={3.0} />
          <Box p={[0, 1.4, 0.09]} s={[1.55, 0.9, 0.06]} c="#0d0f13" r={0.02} />
          <mesh position={[0, 1.4, 0.125]}>
            <planeGeometry args={[1.46, 0.82]} />
            <meshStandardMaterial color="#13788f" emissive="#1fa7bd" emissiveIntensity={0.55} />
          </mesh>
        </group>
      );
    case 'lamp':
      return (
        <group position={[0, 0.56, 0]}>
          <pointLight position={[0, 0.45, 0]} intensity={0.5} distance={4} color="#ffe6b0" />
          <Model
            modelKey="lamp"
            fitHeight={MODEL_TF.lamp.h}
            rotation={[0, MODEL_TF.lamp.ry, 0]}
            fallback={
              <group>
                <mesh position={[0, 0.04, 0]}>
                  <cylinderGeometry args={[0.1, 0.12, 0.08, 16]} />
                  <meshStandardMaterial color="#c9a98f" />
                </mesh>
                <mesh position={[0, 0.2, 0]}>
                  <cylinderGeometry args={[0.015, 0.015, 0.28, 8]} />
                  <meshStandardMaterial color="#888" />
                </mesh>
                <mesh position={[0, 0.36, 0]}>
                  <coneGeometry args={[0.13, 0.16, 16]} />
                  <meshStandardMaterial color="#fde8b5" emissive="#fde8b5" emissiveIntensity={0.4} />
                </mesh>
              </group>
            }
          />
        </group>
      );
    case 'pendant':
      return (
        <group>
          <mesh position={[0, 2.45, 0]}>
            <cylinderGeometry args={[0.006, 0.006, 0.7, 6]} />
            <meshStandardMaterial color="#3a3a3a" />
          </mesh>
          <mesh position={[0, 2.0, 0]}>
            <cylinderGeometry args={[0.16, 0.16, 0.34, 18, 1, true]} />
            <meshStandardMaterial color={WOOD_D} metalness={0.4} roughness={0.5} side={THREE.DoubleSide} />
          </mesh>
          <pointLight position={[0, 1.9, 0]} intensity={0.4} distance={3.2} color="#ffe6b0" />
        </group>
      );
    case 'wallart':
      return (
        <group position={[0, 1.75, 0]}>
          <WallArt />
        </group>
      );
    case 'panel': {
      const [w, h] = item.s || [3, 2.6];
      return <Box p={[0, h / 2, 0]} s={[w, h, 0.08]} c={item.c || '#7f818a'} r={0.02} rough={0.95} />;
    }
    case 'mirror':
      return <Box p={[0, 1.5, 0]} s={[1.2, 1.7, 0.04]} c="#cfe6f5" r={0.02} rough={0.1} />;
    case 'drape': {
      const [w, h] = item.s || [4, 3];
      const n = Math.max(4, Math.round(w / 0.5));
      return (
        <group>
          <mesh position={[0, h / 2, -0.06]}>
            <planeGeometry args={[w, h]} />
            <meshStandardMaterial
              color="#dfe6ec"
              emissive="#cfe0ea"
              emissiveIntensity={0.25}
              side={THREE.DoubleSide}
            />
          </mesh>
          {Array.from({ length: n }).map((_, i) => (
            <mesh key={i} position={[-w / 2 + (w / n) * (i + 0.5), h / 2, 0.02]}>
              <boxGeometry args={[0.06, h, 0.06]} />
              <meshStandardMaterial color="#cdd4db" />
            </mesh>
          ))}
        </group>
      );
    }
    case 'rug': {
      const [w, l] = item.s || [3, 2];
      return (
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.012, 0]} receiveShadow>
          <planeGeometry args={[w, l]} />
          <meshStandardMaterial color="#9fb0bf" roughness={1} />
        </mesh>
      );
    }
    case 'balcony':
      return (
        <group>
          {[-2, -1, 0, 1, 2].map((i) => (
            <mesh key={i} position={[i * 0.8, 0.5, 0]}>
              <cylinderGeometry args={[0.03, 0.03, 1.0, 8]} />
              <meshStandardMaterial color="#9aa3ad" />
            </mesh>
          ))}
          <Box p={[0, 1.0, 0]} s={[4.2, 0.06, 0.06]} c="#9aa3ad" />
        </group>
      );
    default:
      return <Box p={[0, 0.3, 0]} s={[0.6, 0.6, 0.6]} c="#b7a98e" />;
  }
}
// Y placement for an item: models honor `y` (wall-mount / on-surface); typed fixtures sit at 0.
export function itemY(item) {
  return item.y ?? 0;
}
// Just the fixture geometry at LOCAL origin (no world transform) — shared by the
// game's <Furniture> and the layout editor (which supplies its own editable group).
export function FixtureBody({ item }) {
  if (item.model) {
    return (
      <Model
        modelKey={item.model}
        {...fitPropsFor(item)}
        anchorY={item.wall ? 'center' : 'floor'}
        fallback={item.fallback ? renderFix(item.fallback, item) : null}
      />
    );
  }
  return renderFix(item.type, item);
}
function Furniture({ item }) {
  // userData names the fixture so the scene can be introspected — used to verify
  // rendered sizes against modelSizes.js, which is the only way to check them for
  // meshopt-quantized models (their file-level dimensions are meaningless).
  return (
    <group
      position={[item.pos[0], itemY(item), item.pos[1]]}
      rotation={[0, item.ry || 0, 0]}
      scale={item.scale || [1, 1, 1]}
      userData={{ fixture: item.model || item.type }}
    >
      <FixtureBody item={item} />
    </group>
  );
}

// The keys the walk handler claims. Shared by keydown/keyup so they can never
// disagree about what "held" means — the keyup handler used to write every key it
// saw into the held-keys map, including ones movement never reads.
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

export function Player({ paused, onHover, interactRef, viewRef, layout, onLockedChange }) {
  const { camera, gl } = useThree();
  const yaw = useRef(viewRef.current ? viewRef.current.yaw : 0);
  const pitch = useRef(viewRef.current ? viewRef.current.pitch : 0);
  const keys = useRef({});
  const hoverRef = useRef(null);
  // Recompute collision from the CURRENT layout, so a room edited in the layout
  // editor collides against its new furniture/walls rather than a snapshot taken
  // at first mount.
  const blockers = useMemo(
    () => [...blockersOf(layout.furniture), ...wallBlockers(layout.walls)],
    [layout.furniture, layout.walls]
  );

  useEffect(() => {
    const v = viewRef.current;
    if (v) camera.position.set(v.pos[0], v.pos[1], v.pos[2]);
    else camera.position.set(layout.spawn[0], EYE, layout.spawn[1]);
    camera.rotation.order = 'YXZ';
  }, [camera]);

  useEffect(() => {
    // Never take a key out of a text field. `preventDefault()` on a printable
    // keydown stops the character being inserted, so without this guard typing
    // "swan" into a field silently loses the w, s and a — and arrow keys lose
    // caret movement. The app shell behind this overlay is still focusable (the
    // global search is one Tab away), and any future task panel with an input
    // would hit it too.
    const isTyping = (t) => {
      const tag = (t?.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable;
    };
    const down = (e) => {
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (MOVE_KEYS.has(k)) {
        // Belt-and-braces: <Player> is only mounted while roaming
        // (`phase === 'roam' && !activeKey`), which is exactly `!paused`. Keeping
        // the check means claiming keys can never outlive the walkable phase if
        // that mount condition ever changes.
        if (paused) return;
        keys.current[k] = true;
        e.preventDefault(); // otherwise the arrows scroll the page
      } else if (k === 'e' && hoverRef.current && !paused) {
        interactRef.current?.(hoverRef.current);
      }
    };
    // Release on keyup regardless of focus or pause state: a key held while
    // walking and let go after clicking into a field must not stay stuck down.
    const up = (e) => {
      const k = e.key.toLowerCase();
      if (MOVE_KEYS.has(k)) keys.current[k] = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      // Drop anything still held, so a remount can't resume mid-stride.
      keys.current = {};
    };
  }, [paused, interactRef]);

  // ── Look vs interact ───────────────────────────────────────────────────────
  // Standard first-person mouse-look: click the view once to enter, and from
  // then on the mouse turns the camera with no button held and no cursor on
  // screen. Escape leaves (the browser owns that key), L toggles.
  //
  // THE HISTORY THIS REPLACES. Pointer lock used to fire on ANY click while the
  // station rings were separately clickable, which broke both: a ring click also
  // swung the camera, and once locked r3f kept raycasting from the last unlocked
  // cursor position, so ring clicks silently stopped working. That was solved by
  // making look a button-drag, then briefly by a free-cursor hover-look — both of
  // which kept the OS cursor as the thing you aim with.
  //
  // The cursor is gone now, so aiming moved to the crosshair instead: see
  // <CrosshairAim> in inspection/InspectionShift.jsx, which raycasts from the
  // centre of the frame every frame. That is what makes the lock safe here —
  // nothing depends on where the OS pointer happens to be any more.
  //
  // Yaw is unbounded, so the full 360° is a single continuous motion. Pitch stays
  // clamped short of vertical, or the room ends up upside down.
  useEffect(() => {
    const el = gl.domElement;
    const SENS = 0.0023; // rad per px of mouse travel
    const isLocked = () => document.pointerLockElement === el;

    const onMove = (e) => {
      if (paused || !isLocked()) return;
      yaw.current -= e.movementX * SENS;
      pitch.current = Math.max(-1.2, Math.min(1.0, pitch.current - e.movementY * SENS));
    };
    // Click to enter. While already locked this does nothing: the click is an
    // INTERACTION, and InspectionShift picks it up to flag whatever the
    // crosshair is on. Keeping those two jobs apart is what stops the click that
    // enters look mode from also flagging the item behind the cursor.
    const onDown = () => {
      if (paused || isLocked()) return;
      el.requestPointerLock?.();
    };
    // Same focus rule as the walk keys: typing an "l" into a field must not grab
    // the pointer.
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      if (paused || e.key.toLowerCase() !== 'l') return;
      if (isLocked()) document.exitPointerLock?.();
      else el.requestPointerLock?.();
    };
    const onLockChange = () => {
      onLockedChange?.(isLocked());
    };

    el.addEventListener('pointerdown', onDown);
    document.addEventListener('mousemove', onMove);
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerlockchange', onLockChange);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      document.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerlockchange', onLockChange);
    };
  }, [gl, paused, onLockedChange]);

  useFrame((_, dt) => {
    camera.rotation.set(pitch.current, yaw.current, 0);
    const hw = layout.w / 2 - 0.45;
    const hl = layout.l / 2 - 0.45;
    if (!paused) {
      const k = keys.current;
      const fwd = (k.w || k.arrowup ? 1 : 0) - (k.s || k.arrowdown ? 1 : 0);
      const str = (k.d || k.arrowright ? 1 : 0) - (k.a || k.arrowleft ? 1 : 0);
      if (fwd || str) {
        const sin = Math.sin(yaw.current);
        const cos = Math.cos(yaw.current);
        const nx = clamp(camera.position.x + (-sin * fwd + cos * str) * SPEED * dt, -hw, hw);
        const nz = clamp(camera.position.z + (-cos * fwd - sin * str) * SPEED * dt, -hl, hl);
        // resolveMove() carries the escape rule: a player somehow already inside a
        // collision box can always walk back out, instead of finding every
        // candidate position blocked too and the shift becoming unplayable.
        const [mx, mz] = resolveMove([camera.position.x, camera.position.z], [nx, nz], blockers);
        camera.position.x = mx;
        camera.position.z = mz;
      }
    }
    // Proximity prompt: the NEAREST station within range lights up — based on how
    // close you are to the area, not where you're looking (easier to navigate).
    const px = camera.position.x;
    const pz = camera.position.z;
    let best = null;
    let bestDist = 2.4;
    layout.stations.forEach((s) => {
      const dist = Math.hypot(s.pos[0] - px, s.pos[1] - pz);
      if (dist < bestDist) {
        bestDist = dist;
        best = s.key;
      }
    });
    if (best !== hoverRef.current) {
      hoverRef.current = best;
      // Optional: the inspection decides what you are looking at with a
      // crosshair raycast instead, and passes no handler at all.
      onHover?.(best);
    }
    viewRef.current = { pos: [px, camera.position.y, pz], yaw: yaw.current, pitch: pitch.current };
  });
  return null;
}

// ── Image-based lighting, generated in-engine ────────────────────────────────
//
// `meshStandardMaterial` with no environment map gets NO specular reflection at
// all, which is why every surface read as matte plastic. Worse, a metal has no
// diffuse term by definition, so the gold WallArt rings (metalness 0.85) and the
// chrome faucets and rails (0.6–0.7) rendered as near-black smudges — they had
// nothing to reflect.
//
// This is built from <Lightformer> emitters rather than drei's
// `<Environment preset="apartment">`, on purpose: the presets fetch an HDR from a
// third-party CDN (raw.githack.com) at runtime, which would make the 3D room
// depend on external network access — bad on a school network, broken offline, and
// the same reason the model compression avoided Draco's CDN decoder.
//
// `frames={1}` bakes the cubemap once instead of re-rendering it every frame.
function RoomEnvironment({ W, L, H }) {
  return (
    <Environment frames={1} resolution={128} background={false}>
      {/* Broad ceiling bounce — the dominant source in a real lit interior. */}
      <Lightformer
        intensity={0.85}
        color="#fff4e2"
        form="rect"
        position={[0, H + 1, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        scale={[W, L, 1]}
      />
      {/* Cool daylight from the window wall (−z), which is where every tier puts
          its glazing. This is what puts a highlight on chrome and glass. */}
      <Lightformer
        intensity={2.2}
        color="#dceaff"
        form="rect"
        position={[0, H * 0.55, -L / 2 - 0.5]}
        scale={[W * 0.9, H * 0.8, 1]}
      />
      {/* Warm lamp-side fill so the far side of a fixture isn't dead. */}
      <Lightformer
        intensity={0.5}
        color="#ffd9a8"
        form="rect"
        position={[W / 2 + 0.5, H * 0.5, L * 0.2]}
        rotation={[0, -Math.PI / 2, 0]}
        scale={[L * 0.5, H * 0.6, 1]}
      />
      <Lightformer
        intensity={0.35}
        color="#ffe8c8"
        form="rect"
        position={[-W / 2 - 0.5, H * 0.5, L * 0.2]}
        rotation={[0, Math.PI / 2, 0]}
        scale={[L * 0.5, H * 0.6, 1]}
      />
      {/* Floor bounce, dimmer and warmer — keeps undersides from going flat black. */}
      <Lightformer
        intensity={0.25}
        color="#c9a887"
        form="rect"
        position={[0, -0.5, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[W, L, 1]}
      />
    </Environment>
  );
}

// Exported so a standalone harness can mount the room without the auth-gated
// Housekeeping page — that is how the rendered fixture sizes were verified
// against modelSizes.js (see PHASE_3_CHANGES.md).
export function RoomShell({ layout, _done }) {
  const W = layout.w;
  const L = layout.l;
  const H = layout.h ?? 3; // H = ceiling height (editable)

  // Shadow frustum sized to THIS room. It was hardcoded to ±10 m regardless of
  // whether the room was 6.4×8 (Standard) or 12×15 (Presidential), so a Standard
  // spent most of its 1024² shadow map on empty space outside the walls while a
  // Presidential was clipped. Tightening it is the single biggest shadow-quality
  // win available, before touching resolution.
  const half = Math.max(W, L) / 2 + 1;
  // Bigger rooms get a bigger map so texel density stays roughly constant.
  const shadowRes = Math.max(W, L) > 10 ? 2048 : 1024;

  return (
    <group>
      <RoomEnvironment W={W} L={L} H={H} />

      {/* Fill was `ambient 0.66 + hemi 0.4` = 1.06 of DIRECTION-FREE light against
          1.3 of directional — i.e. ~45% of the room's light carried no shape
          information at all, which is the main reason it read flat. With real IBL
          doing the ambient work, these drop to a floor-raiser. */}
      <ambientLight intensity={0.18} />
      <hemisphereLight args={['#fff7e8', '#6b5a44', 0.15]} />

      {/* The "window sun". shadow-normalBias fixes the shadow acne / peter-panning
          that the previous config had no bias settings for at all. */}
      <directionalLight
        position={[W * 0.25, H + 4, -L * 0.35]}
        intensity={1.55}
        color="#fff1dd"
        castShadow
        shadow-mapSize={[shadowRes, shadowRes]}
        shadow-camera-near={0.5}
        shadow-camera-far={Math.max(W, L) + H + 12}
        shadow-camera-left={-half}
        shadow-camera-right={half}
        shadow-camera-top={half}
        shadow-camera-bottom={-half}
        shadow-normalBias={0.035}
        shadow-bias={-0.0004}
      />

      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[W, L]} />
        <meshStandardMaterial color={layout.floor || '#b88f5e'} roughness={0.55} metalness={0.05} />
      </mesh>
      {/* Ceiling and all four walls now RECEIVE shadows. None of them did, so no
          vertical surface ever showed a shadow — and an interior with shadows only
          on the floor always reads as fake. They deliberately do NOT cast: the
          shell is a sealed box with no window openings, so a shadow-casting ceiling
          would black out the whole room. */}
      <mesh rotation-x={Math.PI / 2} position-y={H} receiveShadow>
        <planeGeometry args={[W, L]} />
        <meshStandardMaterial color="#f3ece0" roughness={1} />
      </mesh>
      <mesh position={[0, H / 2, -L / 2]} receiveShadow>
        <planeGeometry args={[W, H]} />
        <meshStandardMaterial color="#e7ddcc" side={THREE.DoubleSide} roughness={0.9} />
      </mesh>
      <mesh position={[0, H / 2, L / 2]} rotation-y={Math.PI} receiveShadow>
        <planeGeometry args={[W, H]} />
        <meshStandardMaterial color="#e7ddcc" side={THREE.DoubleSide} roughness={0.9} />
      </mesh>
      <mesh position={[-W / 2, H / 2, 0]} rotation-y={Math.PI / 2} receiveShadow>
        <planeGeometry args={[L, H]} />
        <meshStandardMaterial color="#e3edef" side={THREE.DoubleSide} roughness={0.9} />
      </mesh>
      <mesh position={[W / 2, H / 2, 0]} rotation-y={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[L, H]} />
        <meshStandardMaterial color="#e3edef" side={THREE.DoubleSide} roughness={0.9} />
      </mesh>
      <RoundedBox
        args={[1.1, 2.1, 0.1]}
        radius={0.04}
        position={[0, 1.05, L / 2 - 0.06]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#6b441f" roughness={0.6} />
      </RoundedBox>
      {(layout.walls || []).map((w, i) => (
        <group key={`wall${i}`} position={[w.p[0], H / 2, w.p[1]]} rotation={[0, w.ry || 0, 0]}>
          <Box p={[0, 0, 0]} s={[w.w, H, w.d]} c={w.c || '#cdb391'} r={0.01} />
        </group>
      ))}
      {layout.furniture.map((item, i) => (
        <Furniture key={i} item={item} />
      ))}
      {/* Decorative interior trim — makes the shell read as a designed room rather
          than a coloured box. Purely visual, non-solid (not added to collision). */}
      <ShellDetails W={W} L={L} H={H} tier={layout.tier} />
      {/* Was scale=max(W,L)+4 (19 m on Presidential) at drei's default 512 — 3.7 cm
          per texel with blur 2.6, i.e. grey mush rather than contact shadows. Now
          sized to the room at 1024, and moved BELOW the rugs (which sit at y=0.012);
          it used to float above them at y=0.02. */}
      <ContactShadows
        position={[0, 0.006, 0]}
        opacity={0.42}
        scale={Math.max(W, L)}
        resolution={1024}
        blur={1.6}
        far={2.2}
      />
    </group>
  );
}

// ── Procedural shell textures (browser-only, generated once and cached) ───────
// Drawn to a <canvas> so there are no external image assets to fetch (the same
// offline/locked-network constraint that rules out CDN HDRs — see task3d.jsx).
let _woodTex = null;
let _skyTex = null;
function woodTexture() {
  if (_woodTex) return _woodTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const planks = ['#c49a62', '#b98d55', '#caa66d', '#b6884f'];
  const pw = 64;
  for (let i = 0; i < 4; i++) {
    const x = i * pw;
    g.fillStyle = planks[i % planks.length];
    g.fillRect(x, 0, pw, 256);
    g.strokeStyle = 'rgba(70,46,22,0.4)'; // plank seam
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 256);
    g.stroke();
    g.strokeStyle = 'rgba(95,62,30,0.14)'; // grain
    g.lineWidth = 1;
    for (let k = 0; k < 9; k++) {
      const gx = x + 4 + Math.random() * (pw - 8);
      g.beginPath();
      g.moveTo(gx, 0);
      g.bezierCurveTo(gx + 3, 85, gx - 3, 175, gx + 1, 256);
      g.stroke();
    }
    const jy = (i % 2) * 128; // staggered end joints
    g.strokeStyle = 'rgba(70,46,22,0.3)';
    g.beginPath();
    g.moveTo(x, jy);
    g.lineTo(x + pw, jy);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  _woodTex = t;
  return t;
}
function skyTexture() {
  if (_skyTex) return _skyTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, '#82bbe8');
  grad.addColorStop(0.5, '#cfe6f5');
  grad.addColorStop(0.72, '#f2ebd9');
  grad.addColorStop(1, '#e7d6bb');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const sun = g.createRadialGradient(96, 34, 2, 96, 34, 30);
  sun.addColorStop(0, 'rgba(255,250,232,0.95)');
  sun.addColorStop(1, 'rgba(255,250,232,0)');
  g.fillStyle = sun;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(96,116,138,0.5)'; // distant skyline
  let x = 0;
  while (x < 128) {
    const bw = 6 + Math.random() * 13;
    const bh = 12 + Math.random() * 42;
    g.fillRect(x, 128 - bh, bw, bh);
    x += bw + 2;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  _skyTex = t;
  return t;
}

// One wall's wainscot: a raised panel band from the skirting up to a chair rail,
// broken into bays by vertical battens. Authored in the wall's LOCAL frame (x =
// across the wall, y measured from the room centre-height), so the four callers
// just position/rotate it like the shell walls themselves.
function Wainscot({ len, H }) {
  const bot = -H / 2 + 0.12;
  const top = -H / 2 + 0.95;
  const midY = (top + bot) / 2;
  const bandH = top - bot;
  const n = Math.max(2, Math.round(len / 1.1));
  const battens = Array.from({ length: n + 1 }, (_, i) => -len / 2 + (len * i) / n);
  return (
    <group>
      <mesh position={[0, midY, 0.02]}>
        <planeGeometry args={[len, bandH]} />
        <meshStandardMaterial color="#f0e8da" roughness={0.85} />
      </mesh>
      <Box p={[0, top, 0.035]} s={[len, 0.05, 0.03]} c="#e4d9c4" r={0.005} rough={0.6} />
      {battens.map((bx, i) => (
        <Box key={i} p={[bx, midY, 0.035]} s={[0.04, bandH, 0.02]} c="#e4d9c4" r={0.004} rough={0.7} />
      ))}
    </group>
  );
}

// Procedural interior styling (feedback #5): a real wood-plank floor, wainscot
// panelling with a chair rail, crown + skirting, a flush ceiling fixture inside a
// tray, and a proper window (painted sky + skyline, drapes, valance, sill). Shell
// dressing only — decorative, non-solid, and it adds NO lights, so the tuned
// IBL/shadow balance is untouched. Presidential keeps its bespoke look (it only
// takes the tinted floor and the light ceiling/skirting touches).
function ShellDetails({ W, L, H, tier }) {
  const TRIM = '#efe8db';
  const hw = W / 2;
  const hl = L / 2;
  const isPres = String(tier).toLowerCase().includes('presidential');

  const floorTex = useMemo(() => {
    const t = woodTexture().clone();
    t.needsUpdate = true;
    t.repeat.set(Math.max(1, Math.round(W / 1.3)), Math.max(1, Math.round(L / 1.3)));
    return t;
  }, [W, L]);
  const sky = useMemo(() => skyTexture(), []);

  const perimeter = (y, h, t) => (
    <group>
      <Box p={[0, y, -hl + t / 2]} s={[W, h, t]} c={TRIM} r={0.004} rough={0.7} />
      <Box p={[0, y, hl - t / 2]} s={[W, h, t]} c={TRIM} r={0.004} rough={0.7} />
      <Box p={[-hw + t / 2, y, 0]} s={[t, h, L]} c={TRIM} r={0.004} rough={0.7} />
      <Box p={[hw - t / 2, y, 0]} s={[t, h, L]} c={TRIM} r={0.004} rough={0.7} />
    </group>
  );

  const winW = Math.min(2.4, W * 0.5);
  const winH = Math.min(1.4, H * 0.5);
  const winY = Math.min(H - winH / 2 - 0.25, 1.6);
  const trayS = Math.min(W, L) * 0.34;

  return (
    <group>
      {/* wood-plank floor, laid just over the base floor plane */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.004} receiveShadow>
        <planeGeometry args={[W, L]} />
        <meshStandardMaterial
          map={floorTex}
          color={isPres ? '#8f6d47' : '#ffffff'}
          roughness={0.6}
          metalness={0.05}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </mesh>

      {perimeter(0.06, 0.12, 0.05)}
      {perimeter(H - 0.05, 0.1, 0.06)}

      {/* ceiling tray + flush fixture */}
      <group position={[0, H - 0.06, 0]}>
        {[
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ].map(([ax, az], i) => (
          <Box
            key={i}
            p={[ax * trayS, 0, az * trayS]}
            s={ax ? [0.08, 0.06, 2 * trayS] : [2 * trayS, 0.06, 0.08]}
            c={TRIM}
            r={0.01}
            rough={0.7}
          />
        ))}
      </group>
      <mesh position={[0, H - 0.03, 0]} rotation-x={Math.PI / 2}>
        <cylinderGeometry args={[0.36, 0.36, 0.05, 28]} />
        <meshStandardMaterial color="#efe9dd" emissive="#fff2d4" emissiveIntensity={0.45} />
      </mesh>

      {!isPres && (
        <>
          {/* wainscot on all four walls */}
          <group position={[0, H / 2, -hl + 0.01]}>
            <Wainscot len={W} H={H} />
          </group>
          <group position={[0, H / 2, hl - 0.01]} rotation-y={Math.PI}>
            <Wainscot len={W} H={H} />
          </group>
          <group position={[-hw + 0.01, H / 2, 0]} rotation-y={Math.PI / 2}>
            <Wainscot len={L} H={H} />
          </group>
          <group position={[hw - 0.01, H / 2, 0]} rotation-y={-Math.PI / 2}>
            <Wainscot len={L} H={H} />
          </group>

          {/* window on the back / windows wall */}
          <group position={[0, winY, -hl + 0.06]}>
            <Box p={[0, 0, 0]} s={[winW + 0.2, winH + 0.2, 0.06]} c={TRIM} r={0.02} rough={0.6} />
            <mesh position={[0, 0, 0.02]}>
              <planeGeometry args={[winW, winH]} />
              {/* painted sky reads as a daylight view; emissive doesn't light the room */}
              <meshStandardMaterial
                map={sky}
                emissiveMap={sky}
                emissive="#ffffff"
                emissiveIntensity={0.5}
                toneMapped={false}
              />
            </mesh>
            <Box p={[0, 0, 0.04]} s={[0.04, winH, 0.02]} c={TRIM} />
            <Box p={[0, 0, 0.04]} s={[winW, 0.04, 0.02]} c={TRIM} />
            {/* sill, drapes, valance */}
            <Box p={[0, -winH / 2 - 0.08, 0.07]} s={[winW + 0.3, 0.06, 0.16]} c={TRIM} r={0.01} />
            <Box
              p={[-winW / 2 - 0.17, 0.02, 0.09]}
              s={[0.22, winH + 0.42, 0.05]}
              c="#c9b9a0"
              r={0.04}
              rough={0.95}
            />
            <Box
              p={[winW / 2 + 0.17, 0.02, 0.09]}
              s={[0.22, winH + 0.42, 0.05]}
              c="#c9b9a0"
              r={0.04}
              rough={0.95}
            />
            <Box
              p={[0, winH / 2 + 0.2, 0.11]}
              s={[winW + 0.6, 0.16, 0.06]}
              c="#bfae94"
              r={0.03}
              rough={0.95}
            />
          </group>
        </>
      )}
    </group>
  );
}

// Each station is a glowing ring ON THE FLOOR (no floating text — that clutters
// navigation). Walk onto/near a ring and the HUD shows a single "Press E" prompt
// for that task. Rings turn amber when you're near and green once done.
// The station-shift orchestrator that used to live here (its default export,
// the <Stations> markers and the par-time constants) was removed with the
// mini-games. What remains is the room-rendering library: RoomShell draws the
// shell and furniture, Player supplies walk/look and collision, and
// FixtureBody/itemY/MODEL_CFG are consumed by the layout editor. Both the
// inspection case study (sim/inspection) and RoomLayoutEditor build on these.
