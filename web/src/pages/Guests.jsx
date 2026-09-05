import { useEffect, useRef, useState } from 'react';
import api from '../api';
import Avatar from '../components/Avatar';
import EmptyState from '../components/EmptyState';
import StatusPill from '../components/StatusPill';
import Icon from '../components/Icon';
import { labelize } from '../lib/labels';
import { useToast, errMsg } from '../components/Toast';

export default function Guests() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState({ loading: false, stays: [], reservations: [] });
  const [form, setForm] = useState({ firstName: '', lastName: '', nationality: '', vipLevel: 'NONE' });
  const toast = useToast();

  // What the list is showing. The suggestions ARE the list — there is no
  // floating panel. A dropdown over the table meant two sets of results on
  // screen at once, in two different shapes; filtering the table in place keeps
  // one set of rows, in the shape you already know how to read.
  //
  //   browse      the resting state — the most recent profiles
  //   suggesting  live matches for what is being typed, still as table rows
  //   selected    a guest was chosen: the list is GONE, not narrowed to one.
  //               A one-row table is still a table — it keeps its header, its
  //               column widths and its "which of these do I want" framing for
  //               a question that has already been answered. The search bar
  //               stays so the next lookup starts where the last one ended.
  const [listMode, setListMode] = useState('browse');
  const [loading, setLoading] = useState(false);
  // Debounce timer and a monotonic request id. Typing fires a request per
  // pause, and without the id a slow response for "ann" can land after a fast
  // one for "annie" and repopulate the table with the wider result.
  const suggestTimer = useRef(null);
  const suggestSeq = useRef(0);

  useEffect(() => () => clearTimeout(suggestTimer.current), []);

  // `term` is passed explicitly rather than read from `q`, because the create
  // handler needs to refresh the list with a BLANK term while the search box
  // may still hold whatever was last typed. Reading state here also read it one
  // render stale, which is the other half of why a new guest never appeared.
  async function search(term = q, mode) {
    const mine = ++suggestSeq.current;
    setLoading(true);
    try {
      const { data } = await api.get(`/api/guests/search?q=${encodeURIComponent(term ?? '')}`);
      if (mine !== suggestSeq.current) return;
      setResults(Array.isArray(data) ? data : []);
      if (mode) setListMode(mode);
    } catch (err) {
      if (mine === suggestSeq.current) toast.error(errMsg(err));
    } finally {
      if (mine === suggestSeq.current) setLoading(false);
    }
  }

  // Typing narrows the table itself, 220ms after the last keystroke — long
  // enough not to fire a request per character, short enough to feel live.
  function onQueryChange(v) {
    setQ(v);
    clearTimeout(suggestTimer.current);
    // Typing again means the last answer is no longer the answer. Dropping the
    // open profile here is what stops a stale card sitting under a fresh list
    // of somebody else's matches.
    setSelected(null);
    setEditing(false);
    const term = v.trim();
    if (!term) {
      // Emptying the box is a return to browsing, not a search for "".
      setListMode('browse');
      search('', 'browse');
      return;
    }
    setListMode('suggesting');
    suggestTimer.current = setTimeout(() => search(term, 'suggesting'), 220);
  }

  // Committing the term. A single match IS the answer, so it selects straight
  // through rather than making you click the one row it just found; anything
  // else stays a list, because the question is still open.
  async function onSearchSubmit(e) {
    e?.preventDefault();
    clearTimeout(suggestTimer.current);
    const term = q.trim();
    if (!term) {
      await search('', 'browse');
      return;
    }
    const mine = ++suggestSeq.current;
    setLoading(true);
    try {
      const { data } = await api.get(`/api/guests/search?q=${encodeURIComponent(term)}`);
      // Superseded — return WITHOUT clearing the flag, because the newer
      // request set it and owns clearing it.
      if (mine !== suggestSeq.current) return;
      // Cleared here rather than in a `finally`, because pickGuest below bumps
      // the sequence itself: a `finally` guarded on `mine === suggestSeq.current`
      // would then never match, and the spinner would run forever on exactly
      // the case that works — a search matching one guest.
      setLoading(false);
      const rows = Array.isArray(data) ? data : [];
      setResults(rows);
      if (rows.length === 1) pickGuest(rows[0]);
      else setListMode('suggesting');
    } catch (err) {
      if (mine !== suggestSeq.current) return;
      setLoading(false);
      toast.error(errMsg(err));
    }
  }

  // Choosing a guest. Works from the row the list already holds rather than
  // issuing a second search for its name — a refetch could return a different
  // set, since several guests share a surname, and the whole point of choosing
  // one is that you have already decided which.
  function pickGuest(g) {
    clearTimeout(suggestTimer.current);
    // Bump the sequence so a debounced response still in flight cannot land
    // afterwards and put the list back over the selection.
    suggestSeq.current++;
    setQ(g.displayName || g.profileNumber || '');
    setResults([g]);
    setListMode('selected');
    openGuest(g.id);
  }

  // Back to the full list. Also drops the open profile, because leaving one
  // guest's record on screen under a list of everybody reads as though the list
  // is still filtered to them.
  function clearSearch() {
    clearTimeout(suggestTimer.current);
    setQ('');
    setSelected(null);
    setEditing(false);
    setListMode('browse');
    search('', 'browse');
  }
  async function create(e) {
    e.preventDefault();
    try {
      const { data } = await api.post('/api/guests', form);
      setForm({ firstName: '', lastName: '', nationality: '', vipLevel: 'NONE' });
      // Clear the search term as well as refetching. A new profile does not
      // necessarily match whatever is in the box, so leaving the term in place
      // could refresh the list into one that still does not contain the guest
      // just created — which looks exactly like the create having failed.
      setQ('');
      clearTimeout(suggestTimer.current);
      await search('', 'browse');
      toast.success(`Guest ${data.profileNumber} created.`);
    } catch (err) {
      toast.error(errMsg(err));
    }
  }
  // Opening a guest shows a READ-ONLY profile. Search used to drop straight
  // into an editable form, so looking someone up to check their room put four
  // live inputs under the cursor — a stray keystroke edited a real record.
  // Editing is now an explicit choice.
  async function openGuest(id) {
    setEditing(false);
    setHistory({ loading: true, stays: [], reservations: [] });
    try {
      const { data } = await api.get(`/api/guests/${id}`);
      setSelected(data);
      // Stay and reservation history come from other services, so they load
      // alongside rather than blocking the profile. Either failing leaves that
      // section empty instead of losing the whole panel.
      const [st, rv] = await Promise.all([
        api.get(`/api/stays?guestId=${id}`).catch(() => ({ data: [] })),
        api.get(`/api/reservations?guestId=${id}`).catch(() => ({ data: [] })),
      ]);
      setHistory({
        loading: false,
        stays: Array.isArray(st.data) ? st.data : [],
        reservations: Array.isArray(rv.data) ? rv.data : [],
      });
    } catch (err) {
      setHistory({ loading: false, stays: [], reservations: [] });
      toast.error(errMsg(err));
    }
  }
  // The in-house stay, if any. IN_HOUSE is the only status that means "here
  // now", so anything else counts as history below.
  const currentStay = history.stays.find((s) => s.status === 'IN_HOUSE') || null;
  const pastStays = history.stays.filter((s) => s.status !== 'IN_HOUSE');

  async function saveGuest() {
    try {
      await api.patch(`/api/guests/${selected.id}`, {
        firstName: selected.firstName,
        lastName: selected.lastName,
        nationality: selected.nationality,
        vipLevel: selected.vipLevel,
      });
      toast.success('Guest details saved.');
      setEditing(false);
      // Refresh what is actually on screen. With a guest selected there is no
      // list to refresh — re-running `search(q)` would have pulled the list
      // back up underneath the card and undone the selection.
      if (listMode === 'selected') {
        const { data } = await api.get(`/api/guests/${selected.id}`);
        setSelected(data);
        setResults([data]);
      } else {
        search(q, listMode);
      }
    } catch (err) {
      toast.error(errMsg(err));
    }
  }

  useEffect(() => {
    search('', 'browse');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <h2>Guest Profiles</h2>

      <div className="panel">
        <h3>Create guest</h3>
        <form onSubmit={create}>
          <div className="row">
            <div>
              <label>First name</label>
              <input
                required
                value={form.firstName}
                onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              />
            </div>
            <div>
              <label>Last name</label>
              <input
                required
                value={form.lastName}
                onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              />
            </div>
            <div>
              <label>Nationality</label>
              <input
                value={form.nationality}
                onChange={(e) => setForm({ ...form, nationality: e.target.value })}
              />
            </div>
            <div>
              <label>VIP level</label>
              <select value={form.vipLevel} onChange={(e) => setForm({ ...form, vipLevel: e.target.value })}>
                {['NONE', 'SILVER', 'GOLD', 'PLATINUM', 'BLACKLISTED'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </div>
            {/* The action is the last cell of the field row, not a block under
                it. `row-action` opts out of `.row > *`'s `flex: 1` so the button
                stays its own width instead of stretching to a quarter of the
                panel, and aligns to the bottom of the row so it sits level with
                the inputs rather than with their labels. */}
            <div className="row-action">
              <button>Create</button>
            </div>
          </div>
        </form>
      </div>

      <div className="panel">
        {/* No heading once a guest is chosen — "Recent profiles" over a lone
            search box, with the answer in a card below it, would be labelling a
            list that is no longer there. */}
        {listMode !== 'selected' && (
          <div className="panel-head" style={{ marginBottom: 12 }}>
            <h3>{listMode === 'browse' ? 'Recent profiles' : 'Matching profiles'}</h3>
            {loading && (
              <span className="muted" style={{ fontSize: 12 }}>
                <span className="spinner" /> Searching…
              </span>
            )}
          </div>
        )}
        {/* A plain input, not a combobox. The suggestions are the table rows
            below — typing narrows them in place, so there is nothing to float
            over the list. Choosing one dismisses the rows entirely and leaves
            just this bar, with the guest's card beneath it. */}
        <div className="guest-search-bar">
          <input
            className="guest-search-input"
            value={q}
            placeholder="Name or profile number"
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSearchSubmit(e);
              if (e.key === 'Escape') clearSearch();
            }}
            autoComplete="off"
            aria-label="Search guests by name or profile number"
          />
          <button type="button" onClick={onSearchSubmit}>
            Search
          </button>
          {(q || listMode !== 'browse') && (
            <button type="button" className="secondary" onClick={clearSearch}>
              Show all
            </button>
          )}
        </div>

        {/* Selected: no list at all. Not a one-row table — the whole results
            block goes, and the card below the bar is the answer. */}
        {listMode === 'selected' ? null : results.length === 0 ? (
          <EmptyState
            kind="search"
            title="No guests found"
            hint={
              q
                ? `No matches for "${q}". Try a different name or profile number.`
                : 'Create a profile above to get started.'
            }
          />
        ) : (
          <>
            {/* Says out loud that the list is narrowed. Without it a short list
                of matches is indistinguishable from a hotel with few guests. */}
            {listMode !== 'browse' && (
              <div className="guest-isolated-bar">
                <span>
                  {results.length === 1 ? '1 match' : `${results.length} matches`} for “{q}” — choose
                  one, or press Enter.
                </span>
                <button type="button" className="small secondary" onClick={clearSearch}>
                  Show all guests
                </button>
              </div>
            )}
            <table className="table-clickable">
              <thead>
                <tr>
                  <th className="t-c"></th>
                  <th>Profile #</th>
                  <th>Name</th>
                  <th>Nationality</th>
                  <th className="t-c">VIP</th>
                </tr>
              </thead>
              <tbody>
                {/* The whole row is the control. `role`/`tabIndex`/`onKeyDown`
                    are what keep it usable without a mouse — a bare `onClick`
                    on a <tr> is invisible to the keyboard and to a screen
                    reader, which is precisely what the "Open" button used to
                    provide and what removing it would otherwise have cost. */}
                {results.map((g) => (
                  <tr
                    key={g.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${g.displayName || g.profileNumber}`}
                    onClick={() => pickGuest(g)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        pickGuest(g);
                      }
                    }}
                  >
                    <td className="t-c" style={{ width: 40 }}>
                      <Avatar name={g.displayName} size={32} />
                    </td>
                    <td>{g.profileNumber}</td>
                    <td>{g.displayName}</td>
                    <td>{g.nationality || '—'}</td>
                    <td className="t-c">{labelize(g.vipLevel) || 'None'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* The chosen guest's card renders BELOW the search container. In
          'selected' mode that container is just the bar — the heading and the
          rows are gone — so what stacks here is a search box with its answer
          directly under it, not a card buried beneath a list. */}
      {selected && !editing && (
        <div className="panel">
          <div className="panel-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Avatar
                name={`${selected.firstName} ${selected.lastName}`}
                size={48}
                userId={selected.id}
              />
              <div>
                <h3 style={{ margin: 0 }}>
                  {selected.firstName} {selected.lastName}
                </h3>
                <div className="muted" style={{ fontSize: 12 }}>
                  {selected.profileNumber}
                </div>
              </div>
            </div>
            <div className="filter-bar">
              <button className="small secondary" onClick={() => setEditing(true)}>
                <Icon name="pencil" size={13} />
                Edit
              </button>
              {/* Closing the card puts the list back. `setSelected(null)` alone
                  would leave a search bar with nothing under it at all, since
                  the results are dismissed while a guest is selected. */}
              <button className="small secondary" onClick={clearSearch}>
                Close
              </button>
            </div>
          </div>

          <div className="guest-facts">
            <div className="guest-fact">
              <span className="guest-fact-label">Guest status</span>
              <span className="guest-fact-value">
                <StatusPill status={currentStay ? currentStay.status : 'NOT_IN_HOUSE'} />
              </span>
            </div>
            <div className="guest-fact">
              <span className="guest-fact-label">Checked in</span>
              <span className="guest-fact-value">
                {currentStay?.actualCheckInAt
                  ? new Date(currentStay.actualCheckInAt).toLocaleString()
                  : 'Not checked in'}
              </span>
            </div>
            <div className="guest-fact">
              <span className="guest-fact-label">Room</span>
              <span className="guest-fact-value">{currentStay?.assignedRoomId || '—'}</span>
            </div>
            <div className="guest-fact">
              <span className="guest-fact-label">Nationality</span>
              <span className="guest-fact-value">{selected.nationality || '—'}</span>
            </div>
            <div className="guest-fact">
              <span className="guest-fact-label">VIP level</span>
              <span className="guest-fact-value">{labelize(selected.vipLevel) || 'None'}</span>
            </div>
            <div className="guest-fact">
              <span className="guest-fact-label">Past stays</span>
              <span className="guest-fact-value">{pastStays.length}</span>
            </div>
          </div>

          <h4 className="guest-sub">Booked reservations</h4>
          {history.loading ? (
            <div className="loading-row">
              <span className="spinner" /> Loading…
            </div>
          ) : history.reservations.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>
              No reservations on file.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Confirmation</th>
                  <th>Check-in</th>
                  <th>Check-out</th>
                  <th>Source</th>
                  <th className="t-c">Status</th>
                </tr>
              </thead>
              <tbody>
                {history.reservations.map((r) => (
                  <tr key={r.id}>
                    <td>{r.confirmationNumber || r.id.slice(0, 8)}</td>
                    <td>{r.checkIn ? new Date(r.checkIn).toLocaleDateString() : '—'}</td>
                    <td>{r.checkOut ? new Date(r.checkOut).toLocaleDateString() : '—'}</td>
                    <td className="muted">{labelize(r.source) || 'Direct'}</td>
                    <td className="t-c">
                      <StatusPill status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4 className="guest-sub">Past stay history</h4>
          {history.loading ? null : pastStays.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>
              No completed stays yet.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Stay</th>
                  <th className="t-c">Room</th>
                  <th>Checked in</th>
                  <th>Checked out</th>
                  <th className="t-c">Status</th>
                </tr>
              </thead>
              <tbody>
                {pastStays.map((s) => (
                  <tr key={s.id}>
                    <td>{s.id.slice(0, 8)}</td>
                    <td className="t-c">{s.assignedRoomId || '—'}</td>
                    <td>{s.actualCheckInAt ? new Date(s.actualCheckInAt).toLocaleDateString() : '—'}</td>
                    <td>{s.actualCheckOutAt ? new Date(s.actualCheckOutAt).toLocaleDateString() : '—'}</td>
                    <td className="t-c">
                      <StatusPill status={s.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {selected && editing && (
        <div className="panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <Avatar name={`${selected.firstName} ${selected.lastName}`} size={48} />
            <h3 style={{ margin: 0 }}>Edit — {selected.profileNumber}</h3>
          </div>
          <div className="row">
            <div>
              <label>First name</label>
              <input
                value={selected.firstName}
                onChange={(e) => setSelected({ ...selected, firstName: e.target.value })}
              />
            </div>
            <div>
              <label>Last name</label>
              <input
                value={selected.lastName}
                onChange={(e) => setSelected({ ...selected, lastName: e.target.value })}
              />
            </div>
            <div>
              <label>Nationality</label>
              <input
                value={selected.nationality || ''}
                onChange={(e) => setSelected({ ...selected, nationality: e.target.value })}
              />
            </div>
            <div>
              <label>VIP level</label>
              <select
                value={selected.vipLevel}
                onChange={(e) => setSelected({ ...selected, vipLevel: e.target.value })}
              >
                {['NONE', 'SILVER', 'GOLD', 'PLATINUM', 'BLACKLISTED'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </div>
          </div>
          <button onClick={saveGuest}>Save</button>{' '}
          {/* Cancel returns to the profile, not to nothing — the guest you were
              looking at is still the one you want on screen. */}
          <button className="secondary" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
