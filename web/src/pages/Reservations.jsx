import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { useToast, errMsg } from '../components/Toast';
import { formatPeso } from '../lib/money';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import StatusPill from '../components/StatusPill';
import FilterPanel, { FilterField } from '../components/FilterPanel';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';

const STATUS_OPTIONS = ['CONFIRMED', 'PENDING', 'CANCELLED', 'IN_HOUSE', 'CHECKED_OUT', 'NO_SHOW'];

export default function Reservations() {
  const navigate = useNavigate();
  const toast = useToast();
  const [list, setList] = useState([]);
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({
    dateBookedFrom: '',
    dateBookedTo: '',
    checkInFrom: '',
    checkInTo: '',
    checkOutFrom: '',
    checkOutTo: '',
    statuses: STATUS_OPTIONS.filter((s) => s !== 'CANCELLED'),
    typeCodes: [],
    source: '',
  });
  const [statusOpen, setStatusOpen] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const [sortBy, setSortBy] = useState({ key: 'dateBooked', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // `live` marks an SSE-triggered reload. Refresh in place rather than showing
  // the skeleton, so the list does not blank on every event from any module.
  async function load({ live = false } = {}) {
    if (!live) setLoading(true);
    try {
      const [r, rt] = await Promise.all([api.get('/api/reservations'), api.get('/api/room-types')]);
      setList(r.data);
      setTypes(rt.data);
      // Only seed the type filter on first load — never overwrite a filter the
      // user has since narrowed (load() also runs on every live refresh).
      setFilters((f) => (f.typeCodes.length ? f : { ...f, typeCodes: rt.data.map((t) => t.code) }));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  // Live: refresh the list when reservations change or a guest checks in/out.
  // Live scope — a list of reservations, nothing else.
  useLiveRefresh(load, { channels: channels('reservations') });

  const filtered = useMemo(() => {
    let rows = list.slice();
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (r) =>
          (r.guestName || '').toLowerCase().includes(q) ||
          (r.confirmationNumber || '').toLowerCase().includes(q) ||
          (r.id || '').toLowerCase().includes(q)
      );
    }
    if (filters.statuses.length && filters.statuses.length < STATUS_OPTIONS.length) {
      const set = new Set(filters.statuses.map((s) => s.toUpperCase()));
      rows = rows.filter((r) => set.has((r.status || '').toUpperCase().replace(/[\s-]/g, '_')));
    }
    if (filters.typeCodes.length && filters.typeCodes.length < types.length) {
      const set = new Set(filters.typeCodes);
      rows = rows.filter((r) => set.has(r.roomTypeCode));
    }
    if (filters.checkInFrom) rows = rows.filter((r) => r.checkIn >= filters.checkInFrom);
    if (filters.checkInTo) rows = rows.filter((r) => r.checkIn <= filters.checkInTo);
    if (filters.checkOutFrom) rows = rows.filter((r) => r.checkOut >= filters.checkOutFrom);
    if (filters.checkOutTo) rows = rows.filter((r) => r.checkOut <= filters.checkOutTo);
    if (filters.source)
      rows = rows.filter((r) => (r.source || '').toLowerCase() === filters.source.toLowerCase());
    rows.sort((a, b) => {
      const k = sortBy.key;
      const av = a[k] ?? '';
      const bv = b[k] ?? '';
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sortBy.dir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [list, types, search, filters, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  // Clamp the current page when filters/live refresh shrink the result set,
  // otherwise the table renders empty while matches still exist.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [totalPages, page]);
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  function toggleSort(key) {
    setSortBy((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }

  function applyFilters() {
    setPage(1);
  }
  function clearFilters() {
    setFilters({
      dateBookedFrom: '',
      dateBookedTo: '',
      checkInFrom: '',
      checkInTo: '',
      checkOutFrom: '',
      checkOutTo: '',
      statuses: STATUS_OPTIONS.slice(),
      typeCodes: types.map((t) => t.code),
      source: '',
    });
    setSearch('');
    setPage(1);
  }

  return (
    <div>
      <div className="page-head">
        <h1>Reservations</h1>
        <button className="btn-cta" onClick={() => navigate('/reservations/new')}>
          <Icon name="plus" size={14} style={{ marginRight: 6 }} />
          Create new reservation
        </button>
      </div>

      <FilterPanel onApply={applyFilters} onClear={clearFilters}>
        <FilterField label="Check-in From">
          <input
            type="date"
            value={filters.checkInFrom}
            onChange={(e) => setFilters({ ...filters, checkInFrom: e.target.value })}
          />
        </FilterField>
        <FilterField label="Check-in To">
          <input
            type="date"
            value={filters.checkInTo}
            onChange={(e) => setFilters({ ...filters, checkInTo: e.target.value })}
          />
        </FilterField>
        <FilterField label="Check-out From">
          <input
            type="date"
            value={filters.checkOutFrom}
            onChange={(e) => setFilters({ ...filters, checkOutFrom: e.target.value })}
          />
        </FilterField>
        <FilterField label="Check-out To">
          <input
            type="date"
            value={filters.checkOutTo}
            onChange={(e) => setFilters({ ...filters, checkOutTo: e.target.value })}
          />
        </FilterField>
        <FilterField label="Status">
          <MultiSelect
            label={`${filters.statuses.length} of ${STATUS_OPTIONS.length} selected`}
            options={STATUS_OPTIONS.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
            selected={filters.statuses}
            onChange={(v) => setFilters({ ...filters, statuses: v })}
            open={statusOpen}
            setOpen={setStatusOpen}
          />
        </FilterField>
        <FilterField label="Room Types">
          <MultiSelect
            label={`${filters.typeCodes.length} of ${types.length} selected`}
            options={types.map((t) => ({ value: t.code, label: t.name }))}
            selected={filters.typeCodes}
            onChange={(v) => setFilters({ ...filters, typeCodes: v })}
            open={typesOpen}
            setOpen={setTypesOpen}
          />
        </FilterField>
        <FilterField label="Reservation Source">
          <select value={filters.source} onChange={(e) => setFilters({ ...filters, source: e.target.value })}>
            <option value="">Select All Channels</option>
            <option value="DIRECT">Direct</option>
            <option value="WALK_IN">Walk-in</option>
            <option value="BOOKING_COM">Booking.com</option>
            <option value="AIRBNB">Airbnb</option>
            <option value="EXPEDIA">Expedia</option>
            <option value="AGODA">Agoda</option>
            <option value="OTA">Other OTA</option>
          </select>
        </FilterField>
      </FilterPanel>

      <div className="panel" style={{ borderTop: '3px solid var(--accent)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <h3 style={{ margin: 0 }}>Reservations</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="icon" title="Columns">
              <Icon name="clipboard-list" size={14} />
            </button>
            <button className="icon" title="Export">
              <Icon name="download" size={14} />
            </button>
            <button className="icon" title="Print">
              <Icon name="printer" size={14} />
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <input
            placeholder="Search by name or confirmation #"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            style={{ maxWidth: 320 }}
          />
          <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
            Showing {paged.length === 0 ? 0 : (page - 1) * pageSize + 1} to{' '}
            {(page - 1) * pageSize + paged.length} of {filtered.length} | View
          </span>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
            style={{ width: 80 }}
          >
            {[20, 50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="muted" style={{ fontSize: 12 }}>
            at a time | Page
          </span>
          <button className="icon" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            <Icon name="chevron-left" size={14} />
          </button>
          <span style={{ fontSize: 12 }}>{page}</span>
          <button className="icon" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
            <Icon name="chevron-right" size={14} />
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            of {totalPages}
          </span>
        </div>

        {loading ? (
          <div className="loading-row">
            <span className="spinner" /> Loading…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            kind="search"
            title="No reservations match your filters"
            hint="Try adjusting filters or clearing the search."
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table-clickable">
              <thead>
                <tr>
                  <th style={{ width: 30 }}>
                    <input type="checkbox" />
                  </th>
                  <SortableTh
                    field="confirmationNumber"
                    label="Reservation"
                    sortBy={sortBy}
                    onClick={toggleSort}
                  />
                  <SortableTh field="guestName" label="Guest" sortBy={sortBy} onClick={toggleSort} />
                  <SortableTh field="createdAt" label="Date Booked" sortBy={sortBy} onClick={toggleSort} />
                  <th>Room(s)</th>
                  <SortableTh field="checkIn" label="Check-In" sortBy={sortBy} onClick={toggleSort} />
                  <SortableTh field="checkOut" label="Check-Out" sortBy={sortBy} onClick={toggleSort} />
                  <SortableTh field="nights" label="Nights" sortBy={sortBy} onClick={toggleSort} />
                  <SortableTh
                    field="totalEstimateCents"
                    label="Total Price"
                    sortBy={sortBy}
                    onClick={toggleSort}
                  />
                  <SortableTh field="status" label="Status" sortBy={sortBy} onClick={toggleSort} />
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((r) => (
                  <tr key={r.id} onClick={() => navigate(`/reservations/${r.id}`)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" />
                    </td>
                    <td className="table-link">{r.confirmationNumber || r.id?.slice(0, 8)}</td>
                    <td>{r.guestName || '—'}</td>
                    <td>{r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '—'}</td>
                    <td>{r.assignedRoomId || r.roomTypeCode || 'N/A'}</td>
                    <td>{new Date(r.checkIn).toLocaleDateString()}</td>
                    <td>{new Date(r.checkOut).toLocaleDateString()}</td>
                    <td>
                      {r.nights ||
                        Math.max(1, Math.round((new Date(r.checkOut) - new Date(r.checkIn)) / 86400000))}
                    </td>
                    <td>{formatPeso(r.totalEstimateCents)}</td>
                    <td>
                      <StatusPill status={r.status} size="sm" />
                    </td>
                    <td className="muted">{r.source || 'Direct'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SortableTh({ field, label, sortBy, onClick }) {
  const active = sortBy.key === field;
  return (
    <th className={`sortable ${active ? 'active' : ''}`} onClick={() => onClick(field)}>
      {label}{' '}
      <span className="sort-arrow">
        <Icon
          name={active ? (sortBy.dir === 'asc' ? 'chevron-up' : 'chevron-down') : 'chevrons-right'}
          size={11}
        />
      </span>
    </th>
  );
}

function MultiSelect({ label, options, selected, onChange, open, setOpen }) {
  const all = options.length === selected.length;
  function toggle(v) {
    if (selected.includes(v)) onChange(selected.filter((x) => x !== v));
    else onChange([...selected, v]);
  }
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="secondary"
        style={{ width: '100%', textAlign: 'left', display: 'flex', justifyContent: 'space-between' }}
        onClick={() => setOpen(!open)}
      >
        <span>{label}</span>
        <Icon name="chevron-down" size={14} color="var(--muted)" />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            background: 'var(--overlay)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 8px 20px rgba(15,23,42,0.12)',
            padding: '6px 0',
            zIndex: 30,
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 14px',
              textTransform: 'none',
              margin: 0,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={all}
              onChange={() => onChange(all ? [] : options.map((o) => o.value))}
              style={{ width: 'auto' }}
            />
            <span style={{ fontWeight: 600 }}>SELECT ALL</span>
          </label>
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          {options.map((o) => (
            <label
              key={o.value}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 14px',
                textTransform: 'none',
                margin: 0,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={() => toggle(o.value)}
                style={{ width: 'auto' }}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
