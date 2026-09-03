import api from '../api';

// ─────────────────────────────────────────────────────────────────────────────
// Authenticated file download.
//
// WHY THIS EXISTS
// ---------------
// All three print/PDF features were broken in the same way:
//
//     window.open(`${api.defaults.baseURL}/api/folios/${folioId}/print`, '_blank');
//
// `window.open` is a plain browser navigation. It sends no `Authorization` header —
// the bearer token is attached only by the axios request interceptor — and both
// endpoints sit behind `verifyToken`. So the new tab rendered
// `{"error":"Missing bearer token."}` instead of a document. Every one of them.
//
// Fetching through axios means the interceptor attaches the token, and the response
// becomes a blob we hand to the browser ourselves.
// ─────────────────────────────────────────────────────────────────────────────

// Pull `filename="…"` out of a Content-Disposition header, if the server sent one.
function filenameFrom(headers, fallback) {
  const cd = headers?.['content-disposition'] || headers?.['Content-Disposition'];
  if (!cd) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1] : fallback;
}

/**
 * GET `path` with authentication and hand the result to the browser.
 *
 * @param {string}  path              API path, e.g. `/api/folios/abc/print`
 * @param {object} [opts]
 * @param {string} [opts.filename]    fallback name if the server sends none
 * @param {boolean}[opts.openInTab]   true → open in a new tab (documents you want
 *                                    to read/print), false → save to disk
 */
export async function downloadAuthed(path, { filename = 'download', openInTab = true } = {}) {
  const res = await api.get(path, { responseType: 'blob' });

  // An error response can still arrive as a blob (our services return JSON errors),
  // so sniff it rather than cheerfully saving `{"error":…}` as a PDF.
  if (res.data?.type && /json/i.test(res.data.type)) {
    let detail = '';
    try {
      detail = JSON.parse(await res.data.text())?.error || '';
    } catch {
      /* ignore */
    }
    throw new Error(detail || 'The server returned an error instead of a document.');
  }

  const name = filenameFrom(res.headers, filename);
  const url = URL.createObjectURL(res.data);
  try {
    if (openInTab) {
      const w = window.open(url, '_blank');
      // Pop-up blocked: fall back to a normal download so the action still works.
      if (!w || w.closed) triggerSave(url, name);
    } else {
      triggerSave(url, name);
    }
  } finally {
    // Give the new tab / save dialog time to take the URL before revoking it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return name;
}

function triggerSave(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
