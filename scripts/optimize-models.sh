#!/usr/bin/env bash
# Compress every .glb in web/public/models with meshopt + WebP textures.
#
# WHY
# ---
# The 41 models total ~1.0 GB, 16.9M triangles and 420 MB of textures, with
# `extensionsUsed: []` — no Draco, no meshopt, no KTX2, nothing. The Presidential
# suite alone pulls ~440 MB across 18 models. Framerate and load time are part of
# whether the room "looks decent", and a 1 GB build context also dominates every
# `docker compose build`.
#
# WHY MESHOPT AND NOT DRACO
# -------------------------
# drei's `useGLTF` enables both decoders by default, but they are not equivalent
# here: its Draco path fetches the decoder from
# `https://www.gstatic.com/draco/versioned/decoders/…` at runtime, so every model
# load would depend on a Google CDN — bad on a school network and broken offline.
# The meshopt decoder ships inside `three-stdlib`, which is already bundled. No
# network, no extra loader wiring, no code change needed.
#
# Textures go to WebP rather than KTX2 for the same reason: WebP decodes natively
# in the browser, while KTX2 needs a transcoder binary served alongside the app.
#
# SAFETY
# ------
# Writes to a STAGING directory and touches nothing in place. Verify with
# `node scripts/measure-models.mjs` after swapping. The swap step is printed at the
# end rather than run, because texture compression and mesh simplification are
# LOSSY and the originals are not in version control.
#
#   bash scripts/optimize-models.sh
#
# Requires @gltf-transform/cli (installed on demand via npx).

set -uo pipefail
cd "$(dirname "$0")/.."

SRC="web/public/models"
STAGE="${STAGE:-.attic/models-optimized}"
CLI="${GLTF_TRANSFORM:-@gltf-transform/cli@4}"

# Longest edge of a texture after resizing. The models are viewed at furniture
# scale in a first-person room, never inspected close up, so 9.9 MB 4K JPEGs on a
# potted plant are pure waste.
TEX_SIZE="${TEX_SIZE:-1024}"

# Simplification error tolerance, as a fraction of mesh radius. 0.001 is the
# gltf-transform default and is conservative; these are Meshy AI photogrammetry-
# style exports with enormously redundant tessellation (one towel is 1.9M
# triangles), so they tolerate it well.
SIMPLIFY_ERROR="${SIMPLIFY_ERROR:-0.001}"

if [ ! -d "$SRC" ]; then
  echo "ERROR: $SRC not found." >&2
  exit 1
fi

mkdir -p "$STAGE"

shopt -s nullglob
files=("$SRC"/*.glb)
if [ "${#files[@]}" -eq 0 ]; then
  echo "ERROR: no .glb files in $SRC" >&2
  exit 1
fi

echo "Optimizing ${#files[@]} models"
echo "  source : $SRC"
echo "  staging: $STAGE"
echo "  meshopt + webp textures (max ${TEX_SIZE}px) + simplify (error ${SIMPLIFY_ERROR})"
echo

failed=()
i=0
for f in "${files[@]}"; do
  i=$((i + 1))
  base="$(basename "$f")"
  out="$STAGE/$base"

  # Resume support: this takes a long time, so skip anything already staged.
  if [ -s "$out" ]; then
    printf '  [%2d/%2d] %-34s already staged\n' "$i" "${#files[@]}" "${base:0:34}"
    continue
  fi

  before=$(wc -c < "$f" | tr -d ' ')
  printf '  [%2d/%2d] %-34s %5s MB → ' "$i" "${#files[@]}" "${base:0:34}" "$((before / 1048576))"

  if log=$(npx --yes "$CLI" optimize "$f" "$out" \
      --compress meshopt \
      --texture-compress webp \
      --texture-size "$TEX_SIZE" \
      --simplify true \
      --simplify-error "$SIMPLIFY_ERROR" 2>&1); then
    after=$(wc -c < "$out" | tr -d ' ')
    pct=$(( 100 - (after * 100 / before) ))
    printf '%5s MB  (−%s%%)\n' "$((after / 1048576))" "$pct"
  else
    printf 'FAILED\n'
    echo "$log" | tail -5 | sed 's/^/          /'
    rm -f "$out"
    failed+=("$base")
  fi
done

echo
src_mb=$(du -sm "$SRC" | cut -f1)
stage_mb=$(du -sm "$STAGE" | cut -f1)
echo "  before: ${src_mb} MB"
echo "  after : ${stage_mb} MB"

if [ "${#failed[@]}" -gt 0 ]; then
  echo
  echo "✗ ${#failed[@]} model(s) failed: ${failed[*]}"
  echo "  Nothing was swapped. Re-run to retry only the failures."
  exit 1
fi

cat <<EOF

✓ All ${#files[@]} models staged in $STAGE

Nothing has been swapped yet — mesh simplification and texture compression are
LOSSY, and the originals are not in version control. To adopt them:

    mkdir -p .attic/models-uncompressed-originals
    mv $SRC/*.glb .attic/models-uncompressed-originals/
    mv $STAGE/*.glb $SRC/

Then verify, and look at the room before deleting anything:

    node scripts/measure-models.mjs
    cd web && npm run build
EOF
