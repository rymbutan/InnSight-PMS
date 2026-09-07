import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { errMsg } from '../../components/Toast';

// ─────────────────────────────────────────────────────────────────────────────
// The saved-scenario library, as one list with one shape.
//
// Everything an author can do to a scenario that is NOT authoring it lives here:
// fetching the library, activating, disabling, deleting. The editor keeps the
// canvas, the object list and the form; it no longer also owns four scattered
// api calls against the same collection.
//
// ── status vs active ────────────────────────────────────────────────────────
// The row carries `active: Boolean`. The list works in `status: 'active' |
// 'disabled'`, normalised on the way in and mapped back on the way out, because
// a boolean named `active` cannot answer "which state is this in" without the
// caller knowing that false means disabled rather than, say, draft or archived.
// The wire format is unchanged — no migration, and a row written by the old code
// reads correctly here.
// ─────────────────────────────────────────────────────────────────────────────

export const STATUS = { ACTIVE: 'active', DISABLED: 'disabled' };

/** Row → list entry. One place decides what `status` means. */
export function toEntry(row) {
  return { ...row, status: row.active ? STATUS.ACTIVE : STATUS.DISABLED };
}

/**
 * @param {object} opts
 * @param {(msg: string) => void} opts.onError   surface a failure to the user
 * @param {(msg: string) => void} [opts.onSuccess]
 * @param {(s: object) => Promise<boolean>} opts.confirm  delete guard
 */
export function useSavedScenarios({ onError, onSuccess, confirm }) {
  const [savedScenarios, setSavedScenarios] = useState([]);
  // "The library has been fetched", NOT "the library has rows". An empty
  // library or an offline server leaves length at 0 forever, and anything
  // gated on that would wait for a list that is never coming.
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const { data } = await api.get('/api/training/scenarios');
      // Sorted here rather than at each render site, so every consumer sees the
      // same order: active first, then by tier, then by name.
      const rows = (data || []).map(toEntry).sort((a, b) => {
        if (a.status !== b.status) return a.status === STATUS.ACTIVE ? -1 : 1;
        return a.roomTier.localeCompare(b.roomTier) || a.name.localeCompare(b.name);
      });
      setSavedScenarios(rows);
    } catch (e) {
      onError?.(errMsg(e));
    } finally {
      setLoaded(true);
    }
  }, [onError]);

  useEffect(() => {
    reload();
  }, [reload]);

  /** Activate or disable one scenario. */
  const setStatus = useCallback(
    async (s, status) => {
      if (s.status === status) return; // already there — no request, no toast
      try {
        await api.patch(`/api/training/scenarios/${s.id}`, { active: status === STATUS.ACTIVE });
        onSuccess?.(
          status === STATUS.ACTIVE
            ? `“${s.name}” is active — students inspecting ${s.roomTier} may get it.`
            : `“${s.name}” disabled.`
        );
        await reload();
      } catch (e) {
        onError?.(errMsg(e));
      }
    },
    [onError, onSuccess, reload]
  );

  /**
   * Delete, behind a confirmation. Returns true when the row is gone, so the
   * caller can clear an editor that was pointed at it.
   */
  const remove = useCallback(
    async (s) => {
      // An authored scenario is what students are graded against, so losing one
      // to a misclick is not recoverable from the UI.
      const ok = await confirm({
        title: 'Delete scenario',
        message: `Are you sure you want to delete “${s.name}”?`,
        detail: 'Rooms assigned to it will fall back to generating their own faults.',
        confirmLabel: 'Delete',
      });
      if (!ok) return false;
      try {
        await api.delete(`/api/training/scenarios/${s.id}`);
        onSuccess?.(`“${s.name}” deleted.`);
        await reload();
        return true;
      } catch (e) {
        onError?.(errMsg(e));
        return false;
      }
    },
    [confirm, onError, onSuccess, reload]
  );

  return { savedScenarios, loaded, reload, setStatus, remove };
}
