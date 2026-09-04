// Uploaded fixtures, merged into the model registry at runtime.
//
// MODELS maps a fixture key to a URL. The shipped fixtures resolve to a file
// under /models/; an uploaded one resolves to its API route. Nothing downstream
// — <Model>, useGLTF, the layouts, the validator — needs to know the
// difference, which is the whole reason this merges into the same object rather
// than adding a second lookup path everywhere.
import api from '../api';
import { MODELS } from './task3d';

let loaded = false;
let inflight = null;
const listeners = new Set();

// The catalogue, key → { key, filename, sizeBytes, updatedAt }.
export const uploadedAssets = new Map();

export function onAssetsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function announce() {
  listeners.forEach((fn) => fn());
}

// `v` busts the browser AND drei's useGLTF cache when a key is re-uploaded.
// Without it, replacing a model would keep showing the old mesh until a hard
// reload, because both caches are keyed on the URL alone.
function urlFor(row) {
  const v = encodeURIComponent(new Date(row.updatedAt).getTime());
  return `/api/room-assets/${encodeURIComponent(row.key)}/file?v=${v}`;
}

function apply(rows) {
  uploadedAssets.clear();
  for (const row of rows) {
    uploadedAssets.set(row.key, row);
    MODELS[row.key] = urlFor(row);
  }
  announce();
}

export async function hydrateAssets({ force = false } = {}) {
  if (loaded && !force) return uploadedAssets;
  // One request even if three components mount at once.
  if (inflight) return inflight;
  inflight = api
    .get('/api/room-assets')
    .then(({ data }) => {
      apply(Array.isArray(data) ? data : []);
      loaded = true;
      return uploadedAssets;
    })
    .catch(() => uploadedAssets) // an editor without uploads is still usable
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// Uploads one .glb and refreshes the registry. Sends raw bytes, matching the
// route — a File is already a Blob, so it goes on the wire untouched.
export async function uploadAsset(file, { key } = {}) {
  const params = new URLSearchParams({ filename: file.name });
  if (key) params.set('key', key);
  const { data } = await api.post(`/api/room-assets?${params.toString()}`, file, {
    headers: { 'Content-Type': 'model/gltf-binary' },
    // Axios would otherwise try to transform a Blob it does not recognise.
    transformRequest: [(body) => body],
  });
  await hydrateAssets({ force: true });
  return data;
}

export async function deleteAsset(key) {
  await api.delete(`/api/room-assets/${encodeURIComponent(key)}`);
  await hydrateAssets({ force: true });
}
