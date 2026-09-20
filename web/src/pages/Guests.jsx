import { useEffect, useRef, useState } from 'react';
import api from '../api';
import Avatar from '../components/Avatar';
import EmptyState from '../components/EmptyState';
import StatusPill from '../components/StatusPill';
import Icon from '../components/Icon';
import { labelize } from '../lib/labels';
import { useAuth } from '../auth';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast, errMsg } from '../components/Toast';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';

// Standardized, unpriced guest preferences — "Add-on information" moved here
// from the reservation wizard, which used to let staff type a one-off item
// and a cost for it. A free preference (extra pillows, an early check-in)
// isn't a billing event, and the same guest wants the same things on every
// stay, so it belongs on the profile, set once, rather than re-entered (and
// re-priced, inconsistently) at every booking. Backed by GuestPreference
// (category 'addon'), which already existed for exactly this shape of data
// and had no UI anywhere.
const ADDON_PREFERENCE_OPTIONS = [
  { code: 'EXTRA_PILLOWS', label: 'Extra pillows' },
  { code: 'EXTRA_TOWELS', label: 'Extra towels' },
  { code: 'EXTRA_BED', label: 'Extra bed' },
  { code: 'BABY_COT', label: 'Baby cot' },
  { code: 'HYPOALLERGENIC_BEDDING', label: 'Hypoallergenic bedding' },
  { code: 'AIRPORT_TRANSFER', label: 'Airport transfer' },
  { code: 'EARLY_CHECKIN', label: 'Early check-in' },
  { code: 'LATE_CHECKOUT', label: 'Late checkout' },
];
const ADDON_PREFERENCE_CATEGORY = 'addon';

export default function Guests() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [history, setHistory] = useState({ loading: false, stays: [], reservations: [] });
  // { [code]: true } for whichever standardized add-on preferences this
  // guest has set — see ADDON_PREFERENCE_OPTIONS above.
  const [addonPrefs, setAddonPrefs] = useState({});
  const [savingPref, setSavingPref] = useState(null);
  // Saved bank-transfer details (Ms. Padilla, Lane A-07) — reusable across
  // reservations instead of retyping bank/network/sender every time.
  const [bankAccounts, setBankAccounts] = useState([]);
  const [newBankAccount, setNewBankAccount] = useState({
    bankName: '',
    accountName: '',
    accountNumberLast4: '',
    transferNetwork: '',
  });
  const [savingBankAccount, setSavingBankAccount] = useState(false);
  const [form, setForm] = useState({ firstName: '', lastName: '', nationality: '', vipLevel: 'NONE' });
  const toast = useToast();
  const confirm = useConfirm();
  const { hasRole } = useAuth();
  // Admin and manager only, and the server enforces the same pair on
  // DELETE /api/guests/:id. Front desk creates and edits profiles; destroying
  // one is not a correction, it is a decision.
  const canDelete = hasRole('ADMIN', 'MANAGER');

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
    setAddonPrefs({});
    setBankAccounts([]);
    try {
      const { data } = await api.get(`/api/guests/${id}`);
      setSelected(data);
      // Stay and reservation history come from other services, so they load
      // alongside rather than blocking the profile. Either failing leaves that
      // section empty instead of losing the whole panel.
      const [st, rv, prefs, banks] = await Promise.all([
        api.get(`/api/stays?guestId=${id}`).catch(() => ({ data: [] })),
        api.get(`/api/reservations?guestId=${id}`).catch(() => ({ data: [] })),
        api.get(`/api/guests/${id}/preferences`).catch(() => ({ data: [] })),
        api.get(`/api/guests/${id}/bank-accounts`).catch(() => ({ data: [] })),
      ]);
      setHistory({
        loading: false,
        stays: Array.isArray(st.data) ? st.data : [],
        reservations: Array.isArray(rv.data) ? rv.data : [],
      });
      setAddonPrefs(
        Object.fromEntries(
          (Array.isArray(prefs.data) ? prefs.data : [])
            .filter((p) => p.category === ADDON_PREFERENCE_CATEGORY && p.value)
            .map((p) => [p.key, true])
        )
      );
      setBankAccounts(Array.isArray(banks.data) ? banks.data : []);
    } catch (err) {
      setHistory({ loading: false, stays: [], reservations: [] });
      toast.error(errMsg(err));
    }
  }

  // Each toggle saves immediately — these are independent preference rows,
  // not fields on the guest record itself, so there is nothing for a
  // separate "Save" click to batch them with.
  async function toggleAddonPref(code, checked) {
    if (!selected) return;
    setSavingPref(code);
    // Optimistic: a toggle that fails flips back below, but the desk should
    // not wait on a round trip to see the checkbox respond.
    setAddonPrefs((m) => ({ ...m, [code]: checked || undefined }));
    try {
      await api.put(`/api/guests/${selected.id}/preferences/${code}`, {
        category: ADDON_PREFERENCE_CATEGORY,
        value: checked,
      });
    } catch (err) {
      setAddonPrefs((m) => ({ ...m, [code]: !checked || undefined }));
      toast.error(errMsg(err));
    } finally {
      setSavingPref(null);
    }
  }

  async function refreshBankAccounts() {
    if (!selected) return;
    try {
      const { data } = await api.get(`/api/guests/${selected.id}/bank-accounts`);
      setBankAccounts(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(errMsg(err));
    }
  }

  async function addBankAccount() {
    if (!selected) return;
    const { bankName, accountName, accountNumberLast4, transferNetwork } = newBankAccount;
    if (!bankName.trim() || !accountName.trim() || !/^\d{4}$/.test(accountNumberLast4)) {
      return toast.error('Bank, account name, and the last 4 digits (exactly 4) are required.');
    }
    setSavingBankAccount(true);
    try {
      await api.post(`/api/guests/${selected.id}/bank-accounts`, {
        bankName: bankName.trim(),
        accountName: accountName.trim(),
        accountNumberLast4,
        transferNetwork: transferNetwork.trim() || undefined,
        // The first saved account becomes the default automatically — nothing
        // to pre-fill from otherwise.
        isDefault: bankAccounts.length === 0,
      });
      setNewBankAccount({ bankName: '', accountName: '', accountNumberLast4: '', transferNetwork: '' });
      await refreshBankAccounts();
      toast.success('Bank account saved.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSavingBankAccount(false);
    }
  }

  async function setDefaultBankAccount(accountId) {
    if (!selected) return;
    try {
      await api.patch(`/api/guests/${selected.id}/bank-accounts/${accountId}`, { isDefault: true });
      await refreshBankAccounts();
    } catch (err) {
      toast.error(errMsg(err));
    }
  }

  async function deleteBankAccount(accountId) {
    if (!selected) return;
    const ok = await confirm({
      title: 'Remove bank account',
      message: 'Remove this saved bank account?',
      detail: 'Reservations already booked keep their own recorded deposit detail — this only removes it from future use.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/guests/${selected.id}/bank-accounts/${accountId}`);
      await refreshBankAccounts();
    } catch (err) {
      toast.error(errMsg(err));
    }
  }

  // The in-house stay, if any. IN_HOUSE is the only status that means "here
  // now", so anything else counts as history below.
  const currentStay = history.stays.find((s) => s.status === 'IN_HOUSE') || null;

  // Permanently remove a profile. The dialog names what survives and what does
  // not, and points at Anonymize, because the two are easy to confuse and only
  // one of them is reversible in any sense: a guest who asked to be forgotten
  // but whose stays must stay on the books wants Anonymize, not this.
  async function deleteGuest() {
    if (!selected) return;
    const name = selected.displayName || `${selected.firstName} ${selected.lastName}`.trim();
    const bookings = history.reservations.length + history.stays.length;
    const ok = await confirm({
      title: 'Delete guest profile',
      message: `Permanently delete ${name} (${selected.profileNumber})?`,
      detail:
        bookings > 0
          ? `This profile has ${bookings} booking record${bookings === 1 ? '' : 's'}. Those stay on the ` +
            'books and keep showing this name, but they will no longer link to a profile. If you need ' +
            'to clear personal details while keeping the history intact, use Anonymize instead. This ' +
            'cannot be undone.'
          : 'Contact details, preferences, consents and any loyalty account go with it. This cannot be undone.',
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.delete(`/api/guests/${selected.id}`);
      toast.success(`Guest ${selected.profileNumber} deleted.`);
      clearSearch();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setDeleting(false);
    }
  }

  const pastStays = history.stays.filter((s) => s.status !== 'IN_HOUSE');

  async function saveGuest() {
    try {
      await api.patch(`/api/guests/${selected.id}`, {
        firstName: selected.firstName,
        lastName: selected.lastName,
        nationality: selected.nationality,
        vipLevel: selected.vipLevel,
        companyName: selected.companyName || '',
        employeeName: selected.employeeName || '',
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

  // This page had no live refresh at all, so a profile edited anywhere else —
  // Quick Edit on a reservation, most often — left this list showing the old
  // name until it was reloaded by hand. Re-runs the current search rather than
  // resetting to browse, so a filtered view stays filtered.
  useLiveRefresh(() => search(q, 'browse'), { channels: channels('guests') });

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
                  <option key={v} value={v}>
                    {labelize(v)}
                  </option>
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
                  {results.length === 1 ? '1 match' : `${results.length} matches`} for “{q}” — choose one, or
                  press Enter.
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
              <Avatar name={`${selected.firstName} ${selected.lastName}`} size={48} userId={selected.id} />
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
              {canDelete && (
                <button
                  className="small danger"
                  onClick={deleteGuest}
                  disabled={deleting || Boolean(currentStay)}
                  title={
                    currentStay
                      ? 'This guest is checked in — check them out first.'
                      : 'Permanently delete this profile'
                  }
                >
                  <Icon name="trash" size={13} />
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              )}
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
            {selected.companyName && (
              <div className="guest-fact">
                <span className="guest-fact-label">Company</span>
                <span className="guest-fact-value">
                  {selected.companyName}
                  {selected.employeeName ? ` (${selected.employeeName})` : ''}
                </span>
              </div>
            )}
            {bankAccounts.length > 0 && (
              <div className="guest-fact">
                <span className="guest-fact-label">Bank on file</span>
                <span className="guest-fact-value">
                  {(() => {
                    const b = bankAccounts.find((a) => a.isDefault) || bankAccounts[0];
                    return `${b.bankName} •••• ${b.accountNumberLast4}`;
                  })()}
                </span>
              </div>
            )}
          </div>

          <h4 className="guest-sub">Add-on preferences</h4>
          <p className="muted" style={{ marginTop: -4 }}>
            {ADDON_PREFERENCE_OPTIONS.some((o) => addonPrefs[o.code])
              ? ADDON_PREFERENCE_OPTIONS.filter((o) => addonPrefs[o.code])
                  .map((o) => o.label)
                  .join(', ')
              : 'None set — edit this profile to add some.'}
          </p>

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
                  <option key={v} value={v}>
                    {labelize(v)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Corporate-account info (Ms. Padilla, Lane A-07) — a guest billed
              through an employer rather than travelling as an individual. */}
          <h4 className="guest-sub" style={{ marginTop: 18 }}>
            Company details
          </h4>
          <div className="row">
            <div>
              <label>Company name</label>
              <input
                value={selected.companyName || ''}
                onChange={(e) => setSelected({ ...selected, companyName: e.target.value })}
              />
            </div>
            <div>
              <label>Employee name</label>
              <input
                value={selected.employeeName || ''}
                onChange={(e) => setSelected({ ...selected, employeeName: e.target.value })}
                placeholder="If different from the guest booking the room"
              />
            </div>
          </div>

          {/* Each row saves itself immediately (add/remove/set-default) —
              same reasoning as the preference checkboxes below: these are
              their own GuestBankAccount rows, not part of the guest record
              Save writes. A saved account is offered to auto-fill the
              BANK_TRANSFER deposit step on a NEW reservation for this guest
              — see NewReservation.jsx — never used to move money on its own. */}
          <h4 className="guest-sub" style={{ marginTop: 18 }}>
            Banking details
          </h4>
          {bankAccounts.length === 0 && <p className="muted">No saved bank accounts.</p>}
          {bankAccounts.map((a) => (
            <div className="row" key={a.id} style={{ alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                {a.bankName} •••• {a.accountNumberLast4} — {a.accountName}
                {a.transferNetwork ? ` (${a.transferNetwork})` : ''}
                {a.isDefault && <span className="badge confirmed" style={{ marginLeft: 8 }}>Default</span>}
              </div>
              {!a.isDefault && (
                <button className="secondary small" onClick={() => setDefaultBankAccount(a.id)}>
                  Make default
                </button>
              )}
              <button className="secondary small" onClick={() => deleteBankAccount(a.id)}>
                Remove
              </button>
            </div>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <div>
              <label>Bank</label>
              <input
                value={newBankAccount.bankName}
                onChange={(e) => setNewBankAccount({ ...newBankAccount, bankName: e.target.value })}
              />
            </div>
            <div>
              <label>Account holder</label>
              <input
                value={newBankAccount.accountName}
                onChange={(e) => setNewBankAccount({ ...newBankAccount, accountName: e.target.value })}
              />
            </div>
            <div>
              <label>Last 4 digits</label>
              <input
                maxLength={4}
                value={newBankAccount.accountNumberLast4}
                onChange={(e) =>
                  setNewBankAccount({ ...newBankAccount, accountNumberLast4: e.target.value.replace(/\D/g, '') })
                }
              />
            </div>
            <div>
              <label>Network (optional)</label>
              <input
                placeholder="InstaPay, PESONet, ..."
                value={newBankAccount.transferNetwork}
                onChange={(e) => setNewBankAccount({ ...newBankAccount, transferNetwork: e.target.value })}
              />
            </div>
            <div className="row-action">
              <button
                type="button"
                className="secondary"
                disabled={savingBankAccount}
                onClick={addBankAccount}
              >
                Add account
              </button>
            </div>
          </div>

          {/* Each checkbox saves itself the moment it's clicked (see
              toggleAddonPref) — these are independent GuestPreference rows,
              not part of the guest record Save below writes. */}
          <h4 className="guest-sub" style={{ marginTop: 18 }}>
            Add-on preferences
          </h4>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {ADDON_PREFERENCE_OPTIONS.map((o) => (
              <label
                key={o.code}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: 'auto',
                  textTransform: 'none',
                  fontWeight: 400,
                }}
              >
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={Boolean(addonPrefs[o.code])}
                  disabled={savingPref === o.code}
                  onChange={(e) => toggleAddonPref(o.code, e.target.checked)}
                />
                {o.label}
              </label>
            ))}
          </div>

          <button style={{ marginTop: 18 }} onClick={saveGuest}>
            Save
          </button>{' '}
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
