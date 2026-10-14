import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import EmptyState from '../components/EmptyState';
import { FilterField } from '../components/FilterPanel';
import Icon from '../components/Icon';
import { roleLabel } from '../lib/roles';
import { useToast, errMsg } from '../components/Toast';

// System-wide activity log — who did what, across every service.
//
// ADMIN only, and read-only by construction: the API behind this page exposes no
// write routes at all (services/audit/src/routes/activity.routes.js), so nothing
// on this screen can edit or delete the record of what somebody did. That is the
// property worth protecting — a log its reader can rewrite answers nothing.
//
// Rows are recorded by services/_shared/activityLog.js on every SUCCESSFUL write
// request. Reads are not recorded and neither are denied attempts; the empty
// state says so, because a page that silently omits half of what a reader expects
// is worse than one that admits its scope.

const PAGE_SIZE = 50;

// Filtering re-queries the server (unlike Users.jsx, which filters a list it
// already holds): this table grows without bound, so the browser cannot be
// holding all of it. Typing therefore needs a debounce or every keystroke is a
// round trip, and out-of-order responses would flicker older results back in.
const SEARCH_DEBOUNCE_MS = 300;

function initialFilters() {
  return { from: '', to: '', actorId: '', service: '', action: '', q: '' };
}

export default function ActivityLog() {
  const toast = useToast();
  // A `?q=` on the URL (the global search box's "Activity" results link here)
  // seeds both the input and the committed term, so the first load already
  // reflects it instead of waiting out the debounce below.
  const [searchParams] = useSearchParams();
  const initialQ = searchParams.get('q') || '';
  const [filters, setFilters] = useState(() => ({ ...initialFilters(), q: initialQ }));
  // The committed search term. `filters.q` updates on every keystroke so the
  // input stays responsive; this one lags it by the debounce and is what the
  // query actually uses.
  const [term, setTerm] = useState(initialQ);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], total: 0, pageCount: 1 });
  const [options, setOptions] = useState({ services: [], actions: [], actors: [] });
  const [loading, setLoading] = useState(true);

  // Guards against an older, slower response overwriting a newer one — the race
  // a debounced search makes easy to hit.
  const requestSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setTerm(filters.q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filters.q]);

  const query = useMemo(() => {
    const params = { page, pageSize: PAGE_SIZE };
    if (filters.from) params.from = filters.from;
    if (filters.to) params.to = filters.to;
    if (filters.actorId) params.actorId = filters.actorId;
    if (filters.service) params.service = filters.service;
    if (filters.action) params.action = filters.action;
    if (term) params.q = term;
    return params;
  }, [filters.from, filters.to, filters.actorId, filters.service, filters.action, term, page]);

  const load = useCallback(async () => {
    const seq = (requestSeq.current += 1);
    setLoading(true);
    try {
      const r = await api.get('/api/activity', { params: query });
      if (seq === requestSeq.current) setData(r.data);
    } catch (e) {
      if (seq === requestSeq.current) toast.error(errMsg(e));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [query, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // The dropdowns come from the whole table, not from the current page — filters
  // built out of the rows already on screen only ever offer what the reader can
  // already see.
  useEffect(() => {
    api
      .get('/api/activity/filters')
      .then((r) => setOptions(r.data))
      .catch(() => {
        /* the table still works with free-text search alone */
      });
  }, []);

  // Any filter change returns to page 1: staying on page 7 of a narrower result
  // set shows an empty table and reads as "no matches".
  function setFilter(key, value) {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }

  const activeCount = Object.entries(filters).filter(([, v]) => v).length;
  const firstRow = data.total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastRow = Math.min(page * PAGE_SIZE, data.total);

  return (
    <div>
      <div className="page-head">
        <h2 className="page-head-title">Activity Log</h2>
        <div className="muted">
          Every successful change made in the system, newest first. Read-only — entries cannot be edited or
          deleted from here.
        </div>
      </div>

      <div className="panel">
        <div className="filter-grid" style={{ marginBottom: 12 }} data-tour="g-activity-filters">
          <FilterField label="From">
            <input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
          </FilterField>
          <FilterField label="To">
            <input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
          </FilterField>
          <FilterField label="User">
            <select data-tour="g-activity-user" value={filters.actorId} onChange={(e) => setFilter('actorId', e.target.value)}>
              <option value="">Everyone</option>
              {options.actors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Area">
            <select value={filters.service} onChange={(e) => setFilter('service', e.target.value)}>
              <option value="">All areas</option>
              {options.services.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Action">
            <select value={filters.action} onChange={(e) => setFilter('action', e.target.value)}>
              <option value="">All actions</option>
              {options.actions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Search">
            <input
              data-tour="g-activity-search"
              type="search"
              placeholder="name, path or record id"
              value={filters.q}
              onChange={(e) => setFilter('q', e.target.value)}
            />
          </FilterField>
        </div>

        <div className="row" style={{ alignItems: 'center', marginBottom: 12 }} data-tour="g-activity-bar">
          <div className="muted">
            {data.total > 0 ? `${firstRow}–${lastRow} of ${data.total.toLocaleString()}` : 'No entries'}
            {activeCount > 0 && <span className="filter-count"> · {activeCount} filter(s)</span>}
          </div>
          <div className="row-action">
            {activeCount > 0 && (
              <button
                className="btn-ghost"
                onClick={() => {
                  setFilters(initialFilters());
                  setTerm('');
                  setPage(1);
                }}
              >
                Clear filters
              </button>
            )}
            <button onClick={load} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>

        {data.rows.length === 0 && !loading ? (
          <EmptyState
            kind="search"
            title={activeCount > 0 ? 'No activity matches these filters' : 'No activity recorded yet'}
            hint={
              activeCount > 0
                ? 'Try widening the date range or clearing a filter.'
                : 'Entries appear here as staff make changes. Viewing a record is not logged — only changes are.'
            }
          />
        ) : (
          <table data-tour="g-activity-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Did what</th>
                <th>Area</th>
                <th>Record</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }} title={new Date(r.at).toISOString()}>
                    {new Date(r.at).toLocaleString()}
                  </td>
                  <td>
                    <div>{r.actorName}</div>
                    {r.actorRoles?.length > 0 && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {r.actorRoles.map((role) => roleLabel(role)).join(', ')}
                      </div>
                    )}
                  </td>
                  <td>
                    <div>{r.summary}</div>
                    {/* The raw method+path is the part an admin needs when the
                        generated summary is not specific enough to act on. */}
                    <div className="muted" style={{ fontSize: '0.85em' }}>
                      {r.method} {r.path}
                    </div>
                  </td>
                  <td>
                    <span className="badge neutral">{r.service}</span>
                  </td>
                  <td className="muted" style={{ fontSize: '0.85em', wordBreak: 'break-all' }}>
                    {r.targetId || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {data.pageCount > 1 && (
          <div
            className="row"
            style={{ alignItems: 'center', marginTop: 12, justifyContent: 'flex-end' }}
            data-tour="g-activity-pager"
          >
            <button
              className="btn-ghost"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => p - 1)}
            >
              <Icon name="chevron-left" /> Previous
            </button>
            <span className="muted">
              Page {page} of {data.pageCount}
            </span>
            <button
              className="btn-ghost"
              disabled={page >= data.pageCount || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              Next <Icon name="chevron-right" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
