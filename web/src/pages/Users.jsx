import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import RoleBadge from '../components/RoleBadge';
import Modal from '../components/Modal';
import Icon from '../components/Icon';
import { useConfirm } from '../components/ConfirmDialog';
import { useAuth } from '../auth';
import { isAdminRow, sortUsers } from '../lib/userSort';
import { roleLabel } from '../lib/roles';

export default function Users() {
  const confirm = useConfirm();
  // MANAGER has the same account-management privilege as ADMIN, with one
  // carve-out: an account that already holds (or would be given) the ADMIN
  // role is off-limits — see the matching guards in
  // services/auth/src/routes/users.routes.js (blockIfAdminTarget /
  // blockIfGrantingAdmin). The controls this affects are hidden rather than
  // merely disabled for a MANAGER, since the API refuses them outright; a
  // visible-but-rejected button reads as broken, not showing it reads as
  // "not yours to do."
  const { hasRole, user: me } = useAuth();
  const canManage = hasRole('ADMIN', 'MANAGER');
  const isAdmin = hasRole('ADMIN');
  const [users, setUsers] = useState([]);
  // User Directory Display Hierarchy: Admin accounts pin permanently at the
  // top, then everyone else in strict A–Z order by name. See lib/userSort.js.
  const sortedUsers = useMemo(() => sortUsers(users), [users]);
  // Free-text filter over the directory. Client-side on purpose: GET /api/users
  // already returns the whole list in one response — this is staff, tens of rows,
  // not the guest table — so a round trip per keystroke would add latency and a
  // race between out-of-order responses without narrowing anything the browser
  // does not already hold.
  const [userQuery, setUserQuery] = useState('');
  // Filtering the SORTED list rather than sorting the filtered one keeps the
  // admin-pinned hierarchy from lib/userSort.js intact while typing: a matching
  // admin stays pinned at the top instead of dropping into A-Z with everyone else.
  const visibleUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    if (!q) return sortedUsers;
    return sortedUsers.filter((u) => {
      // Both the role CODE and its human label, so "housekeeping" finds
      // HOUSEKEEPING_MAINTENANCE and "front desk" finds FRONT_DESK. Matching the
      // raw code alone would mean the words printed on the badges are not the
      // words that work when you type them.
      const roleText = (u.roles || [])
        .map((r) => {
          const code = r.roleCode || r;
          return `${code} ${roleLabel(code)}`;
        })
        .join(' ');
      return [u.username, u.displayName, u.email, roleText]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q));
    });
  }, [sortedUsers, userQuery]);
  const [roles, setRoles] = useState([]);
  const [form, setForm] = useState({ username: '', password: '', displayName: '', email: '', roles: [] });
  const [msg, setMsg] = useState('');
  const [requests, setRequests] = useState([]);
  // The row whose roles are being edited, plus the working copy. Editing in a
  // dialog rather than in the cell is what lets the cell be badges alone: a
  // multi-select had to stay mounted to be usable, so every row carried a live
  // six-option listbox whether or not anyone was changing anything.
  const [roleEdit, setRoleEdit] = useState(null);
  const [draftRoles, setDraftRoles] = useState([]);
  const [savingRoles, setSavingRoles] = useState(false);
  const [roleErr, setRoleErr] = useState('');
  // The two dialogs that replaced window.prompt().
  const [approve, setApprove] = useState(null); // the request being approved
  const [approveName, setApproveName] = useState('');
  const [approveRoles, setApproveRoles] = useState([]);
  const [approveErr, setApproveErr] = useState('');
  const [approveBusy, setApproveBusy] = useState(false);
  const [resetUser, setResetUser] = useState(null);
  const [resetPw, setResetPw] = useState('');
  const [resetErr, setResetErr] = useState('');
  const [resetBusy, setResetBusy] = useState(false);

  async function load() {
    try {
      const [u, r, ar] = await Promise.all([
        api.get('/api/users'),
        api.get('/api/roles'),
        // Pending only: a reviewed request is history, not a to-do.
        api.get('/api/access-requests?status=PENDING').catch(() => ({ data: [] })),
      ]);
      setUsers(u.data);
      setRoles(r.data);
      setRequests(ar.data);
    } catch (e) {
      setMsg(e.response?.data?.error || e.message || 'Failed to load users and roles.');
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function create(e) {
    e.preventDefault();
    try {
      await api.post('/api/users', form);
      setForm({ username: '', password: '', displayName: '', email: '', roles: [] });
      setMsg('User created.');
      load();
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    }
  }
  // The other native prompt in this file, replaced for the same reasons. It
  // also gains something the OS dialog could not do: a password field that
  // masks what you type. `prompt()` renders in clear text, so resetting a
  // password put it on screen for anyone standing at the front desk.
  function openReset(u) {
    setResetErr('');
    setResetUser(u);
    setResetPw('');
  }

  async function submitReset() {
    if (!resetUser) return;
    if (resetPw.length < 8) return setResetErr('Password must be at least 8 characters.');
    setResetBusy(true);
    setResetErr('');
    try {
      await api.post(`/api/users/${resetUser.id}/reset-password`, { newPassword: resetPw });
      const name = resetUser.username;
      setResetUser(null);
      setResetPw('');
      setMsg(`Password reset for ${name}.`);
    } catch (e) {
      setResetErr(e.response?.data?.error || e.message);
    } finally {
      setResetBusy(false);
    }
  }
  async function removeUser(u) {
    const name = u.displayName || u.username;
    // Types-to-confirm would be theatre for a dev tool, but a plain "are you
    // sure" is too weak for something irreversible — so the dialog says exactly
    // what survives and what does not, and names the reversible alternative.
    const ok = await confirm({
      title: `Delete ${name}?`,
      message: `Permanently delete the account “${u.username}”?`,
      detail:
        'This cannot be undone. They are signed out everywhere immediately and the username becomes available again. ' +
        'Work they recorded — folios, reservations, training results — is kept, but will no longer show their name. ' +
        'To remove access without deleting the record, use Disable instead.',
      confirmLabel: 'Delete account',
    });
    if (!ok) return;
    try {
      await api.delete(`/api/users/${u.id}`);
      setMsg(`Deleted ${u.username}.`);
      load();
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    }
  }

  async function toggle(u) {
    const disabling = u.status === 'ACTIVE';
    // Only the destructive direction asks. Enabling an account restores access
    // and is undone by one more click; disabling revokes every live token that
    // person holds and signs them out wherever they are.
    if (disabling) {
      const ok = await confirm({
        title: 'Disable account',
        message: `Are you sure you want to disable ${u.displayName || u.username}?`,
        detail:
          'They will be signed out everywhere immediately and will not be able to sign in until the account is enabled again.',
        confirmLabel: 'Disable account',
      });
      if (!ok) return;
    }
    try {
      await api.post(`/api/users/${u.id}/${disabling ? 'disable' : 'enable'}`);
      load();
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    }
  }
  function openRoleEditor(u) {
    setRoleErr('');
    setRoleEdit(u);
    setDraftRoles((u.roles || []).map((r) => r.roleCode));
  }

  async function saveUserRoles() {
    if (!roleEdit) return;
    setSavingRoles(true);
    setRoleErr('');
    try {
      await api.put(`/api/users/${roleEdit.id}/roles`, { roles: draftRoles });
      const name = roleEdit.username;
      setRoleEdit(null);
      setMsg(`Roles updated for ${name}.`);
      load();
    } catch (e) {
      // Shown INSIDE the dialog. The server refuses to strip the last ADMIN,
      // and that refusal has to land where the admin is looking — the page-level
      // message sits behind the backdrop, so it would have looked like the save
      // simply did nothing.
      setRoleErr(e.response?.data?.error || e.message);
    } finally {
      setSavingRoles(false);
    }
  }

  // Approving is what creates the account — the request itself grants nothing,
  // so the roles are chosen here, at approval time.
  //
  // This used to be two chained window.prompt() calls: one for the username,
  // then one asking for roles as COMMA-SEPARATED TEXT with the valid codes
  // listed in the message. Three problems, and the dialog only looked like one
  // of them. It is an OS dialog, so it ignores the app's theme entirely.
  // Typing role codes by hand meant "FRONTDESK" or a stray space failed a
  // whole approval after both prompts were answered. And cancelling the second
  // prompt left you with nothing, having already typed a username.
  //
  // Ticking boxes cannot produce an invalid role, so the parsing, the "Unknown
  // role(s)" branch and the retry it forced are all gone.
  function openApprove(r) {
    setApproveErr('');
    setApprove(r);
    setApproveName(r.email.split('@')[0]);
    setApproveRoles([]);
  }

  async function submitApprove() {
    if (!approve) return;
    const username = approveName.trim();
    if (!username) return setApproveErr('Give them a username.');
    setApproveBusy(true);
    setApproveErr('');
    try {
      await api.post(`/api/access-requests/${approve.id}/approve`, {
        username,
        roles: approveRoles,
      });
      const email = approve.email;
      setApprove(null);
      setMsg(`Approved ${email}. They can now sign in with Google.`);
      load();
    } catch (e) {
      // Shown inside the dialog: a duplicate username is the common failure and
      // it has to land where the field is, not behind the backdrop.
      setApproveErr(e.response?.data?.error || e.message);
    } finally {
      setApproveBusy(false);
    }
  }

  async function rejectRequest(r) {
    const ok = await confirm({
      title: 'Reject access request',
      message: `Are you sure you want to reject ${r.fullName}'s request?`,
      detail: `${r.email} will not be granted an account. They would have to submit a new request.`,
      confirmLabel: 'Reject request',
    });
    if (!ok) return;
    try {
      await api.post(`/api/access-requests/${r.id}/reject`);
      setMsg(`Rejected ${r.email}.`);
      load();
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    }
  }

  function toggleRoleInForm(code) {
    setForm((f) => ({
      ...f,
      roles: f.roles.includes(code) ? f.roles.filter((r) => r !== code) : [...f.roles, code],
    }));
  }

  return (
    <div>
      <h2>Users & Roles</h2>
      {msg && (
        <div className="muted" style={{ marginBottom: 12 }}>
          {msg}
        </div>
      )}

      {requests.length > 0 && (
        <div className="panel">
          <h3>
            Access requests <span className="badge">{requests.length}</span>
          </h3>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>University email</th>
                <th>Reason</th>
                <th className="t-c">Requested</th>
                <th className="t-c">Actions</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{r.fullName}</td>
                  <td>{r.email}</td>
                  <td className="muted">{r.note || '—'}</td>
                  <td className="muted t-c">{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td className="t-actions">
                    {canManage ? (
                      <>
                        {/* Green/red, because these two are opposites and the row
                            offers no other reading of which is which. Approve was
                            the accent colour and Reject was a plain outline, so the
                            destructive choice looked like the neutral one. */}
                        <button className="small success" onClick={() => openApprove(r)}>
                          Approve
                        </button>{' '}
                        <button className="small danger" onClick={() => rejectRequest(r)}>
                          Reject
                        </button>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && (
        <div className="panel">
          <h3>Create user</h3>
          <form onSubmit={create}>
            <div className="row">
              <div>
                <label>Username</label>
                <input
                  required
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                />
              </div>
              <div>
                <label>Display name</label>
                <input
                  required
                  value={form.displayName}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                />
              </div>
              <div>
                <label>Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div>
                <label>Password (≥ 8)</label>
                <input
                  required
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </div>
              {/* Create sits at the end of the FIELD row, beside Password. The
                four inputs share what is left and shrink by about a fifth each
                — still well clear of the 160px floor `.row > *` sets, so none
                of them is squeezed to the point of being hard to read. */}
              <div className="row-action">
                <button>Create</button>
              </div>
            </div>
            <div>
              <label>Roles</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {/* A MANAGER cannot grant ADMIN (services/auth's
                  blockIfGrantingAdmin) — the checkbox is not offered rather
                  than offered and then rejected on submit. */}
                {roles
                  .filter((r) => isAdmin || r.code !== 'ADMIN')
                  .map((r) => (
                    <label key={r.code} className="ed-check">
                      <input
                        type="checkbox"
                        checked={form.roles.includes(r.code)}
                        onChange={() => toggleRoleInForm(r.code)}
                      />
                      <span>{r.code}</span>
                    </label>
                  ))}
              </div>
            </div>
          </form>
        </div>
      )}

      <div className="panel">
        <h3>Users</h3>
        {/* A plain filter, not a submitted search: the rows below ARE the
            results, so they narrow as you type and there is nothing to submit
            and nothing to float over the table. Escape clears, which is the one
            keystroke people try before reaching for the button. */}
        <div className="user-search-bar">
          <input
            className="user-search-input"
            type="search"
            value={userQuery}
            placeholder="Search by username, name, email or role"
            onChange={(e) => setUserQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setUserQuery('');
            }}
            autoComplete="off"
            aria-label="Search users by username, name, email or role"
          />
          {userQuery && (
            <button type="button" className="secondary" onClick={() => setUserQuery('')}>
              Clear
            </button>
          )}
          {/* Only while filtering. A permanent count is noise on the common
              case, but once rows are hidden the table no longer shows how many
              accounts exist, so the count has to say both numbers. */}
          {userQuery.trim() && (
            <span className="muted user-search-count">
              {visibleUsers.length} of {sortedUsers.length}
            </span>
          )}
        </div>
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Name</th>
              {/* The search box already matches on email, so it had to be
                  visible: filtering a column nobody can read makes a row appear
                  for a reason the table does not show. It is also how you tell
                  two similar accounts apart, and what the Forgot password link
                  is sent to. */}
              <th>Email</th>
              <th className="t-c">Status</th>
              <th>Roles</th>
              <th>Last login</th>
              <th className="t-c">Actions</th>
            </tr>
          </thead>
          <tbody>
            {/* An explicit empty row rather than a bare table: a filter that
                matches nothing otherwise renders a header with nothing under
                it, which reads as the list failing to load. */}
            {visibleUsers.length === 0 && (
              <tr>
                <td colSpan={7} className="t-c muted" style={{ padding: '18px 0' }}>
                  No users match “{userQuery.trim()}”.
                </td>
              </tr>
            )}
            {visibleUsers.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.displayName}</td>
                {/* An em dash, not an empty cell: email is optional on a user
                    record, and a blank reads as "failed to load" rather than
                    "none set" — which matters now that it is what a password
                    reset link would be sent to. */}
                <td>{u.email || <span className="muted">—</span>}</td>
                <td className="t-c">
                  <span className={`badge ${u.status === 'ACTIVE' ? 'confirmed' : 'cancelled'}`}>
                    {u.status}
                  </span>
                </td>
                <td>
                  {/* Capsules only. The cell used to carry a live multi-select
                      under the badges, which meant every row on the page held a
                      six-option listbox — the tallest thing in the table, and a
                      control where one stray click reassigned somebody's access
                      with no confirmation step. Reading is the common case, so
                      reading is what the cell does; editing is a button. */}
                  <div className="role-badges">
                    {(u.roles || []).length ? (
                      u.roles.map((r) => <RoleBadge key={r.roleCode} code={r.roleCode} />)
                    ) : (
                      <span className="muted" style={{ fontSize: 12 }}>
                        No roles
                      </span>
                    )}
                    {/* A MANAGER cannot edit an admin account's roles — see
                        blockIfAdminTarget. */}
                    {canManage && (isAdmin || !isAdminRow(u)) && (
                      <button
                        type="button"
                        className="role-edit-btn"
                        onClick={() => openRoleEditor(u)}
                        title={`Edit roles for ${u.username}`}
                      >
                        <Icon name="pencil" size={11} />
                        Edit
                      </button>
                    )}
                  </div>
                </td>
                <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
                <td className="t-actions">
                  {canManage && (isAdmin || !isAdminRow(u)) ? (
                    <>
                      <button className="small secondary" onClick={() => openReset(u)}>
                        Reset Password
                      </button>{' '}
                      {/* Your own row carries the SAME buttons as every other,
                          disabled rather than hidden. The server refuses both
                          actions on the signed-in account (the self-lockout
                          guard on disable, and the self-delete guard on DELETE),
                          so neither can work here — but an invisible button and
                          an omitted one made this row render three different
                          ways, and the reason was never stated anywhere the
                          reader could see it. Disabled-with-a-title says it.

                          The bootstrap 'admin' account gets the same treatment,
                          for the same reason: the server refuses both actions on
                          it unconditionally (blockIfBootstrapAdmin in
                          users.routes.js) — a break-glass account has to survive
                          no matter how many other admins exist, not just while
                          it's the last one. */}
                      <button
                        className="small danger"
                        disabled={u.id === me?.id || u.username === 'admin'}
                        title={
                          u.id === me?.id
                            ? 'You cannot disable your own account — ask another admin.'
                            : u.username === 'admin'
                              ? "The 'admin' account cannot be disabled."
                              : undefined
                        }
                        onClick={() => u.id !== me?.id && u.username !== 'admin' && toggle(u)}
                      >
                        {u.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                      </button>{' '}
                      {/* ADMIN only: deleting is the one action here a manager
                          cannot do and nothing can undo — Disable is the
                          reversible tool and stays available to both. Rendered
                          on every row an admin can see, including their own, so
                          the column does not change shape row to row. Mirrors
                          DELETE /api/users/:id. */}
                      {isAdmin && (
                        <button
                          className="small danger"
                          disabled={u.id === me?.id || u.username === 'admin'}
                          title={
                            u.id === me?.id
                              ? 'You cannot delete your own account — ask another admin.'
                              : u.username === 'admin'
                                ? "The 'admin' account cannot be deleted."
                                : undefined
                          }
                          onClick={() => u.id !== me?.id && u.username !== 'admin' && removeUser(u)}
                        >
                          Delete
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Approve — username and roles in ONE dialog, replacing two chained
          window.prompt() calls. */}
      <Modal
        open={!!approve}
        onClose={() => setApprove(null)}
        title="Approve access request"
        width={440}
        footer={
          <>
            <button className="secondary" onClick={() => setApprove(null)}>
              Cancel
            </button>
            <button className="success" onClick={submitApprove} disabled={approveBusy}>
              {approveBusy ? 'Approving…' : 'Approve & create account'}
            </button>
          </>
        }
      >
        {approve && (
          <>
            <div className="approve-who">
              <strong>{approve.fullName}</strong>
              <span className="muted">{approve.email}</span>
              {approve.note && <span className="muted approve-note">“{approve.note}”</span>}
            </div>
            {approveErr && (
              <div className="error" style={{ marginTop: 0, marginBottom: 10 }}>
                {approveErr}
              </div>
            )}
            <label>Username</label>
            <input
              value={approveName}
              onChange={(e) => setApproveName(e.target.value)}
              autoFocus
              // Enter submits, so the common case — accept the suggested
              // username, tick a role, done — never needs the mouse.
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitApprove();
              }}
            />
            <label style={{ marginTop: 12 }}>Roles</label>
            <div className="role-picker">
              {/* A MANAGER cannot grant ADMIN — not offered here either. */}
              {roles
                .filter((r) => isAdmin || r.code !== 'ADMIN')
                .map((r) => {
                  const on = approveRoles.includes(r.code);
                  return (
                    <label key={r.code} className={`role-picker-row${on ? ' is-on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setApproveRoles((d) => (on ? d.filter((x) => x !== r.code) : [...d, r.code]))
                        }
                        style={{ width: 'auto' }}
                      />
                      <RoleBadge code={r.code} />
                      <span className="muted" style={{ fontSize: 12 }}>
                        {r.name || r.code}
                      </span>
                    </label>
                  );
                })}
            </div>
            {approveRoles.length === 0 && (
              <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                With no roles they can sign in but will see nothing. You can add roles later.
              </p>
            )}
          </>
        )}
      </Modal>

      {/* Reset password. A real password field, so it is masked — `prompt()`
          showed it in clear text on a shared front-desk screen. */}
      <Modal
        open={!!resetUser}
        onClose={() => setResetUser(null)}
        title={resetUser ? `Reset password — ${resetUser.username}` : 'Reset password'}
        width={400}
        footer={
          <>
            <button className="secondary" onClick={() => setResetUser(null)}>
              Cancel
            </button>
            <button onClick={submitReset} disabled={resetBusy}>
              {resetBusy ? 'Resetting…' : 'Reset password'}
            </button>
          </>
        }
      >
        {resetErr && (
          <div className="error" style={{ marginTop: 0, marginBottom: 10 }}>
            {resetErr}
          </div>
        )}
        <label>New password</label>
        <input
          type="password"
          value={resetPw}
          onChange={(e) => setResetPw(e.target.value)}
          autoFocus
          placeholder="At least 8 characters"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitReset();
          }}
        />
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          They are signed out everywhere and must use this password next time they sign in.
        </p>
      </Modal>

      {/* Roles are edited here, away from the table, so the change is a
          deliberate open–tick–save rather than a click that lands on a listbox
          and takes effect immediately. */}
      <Modal
        open={!!roleEdit}
        onClose={() => setRoleEdit(null)}
        title={roleEdit ? `Roles — ${roleEdit.username}` : 'Roles'}
        footer={
          <>
            <button className="secondary" onClick={() => setRoleEdit(null)}>
              Cancel
            </button>
            <button onClick={saveUserRoles} disabled={savingRoles}>
              {savingRoles ? 'Saving…' : 'Save roles'}
            </button>
          </>
        }
      >
        {roleErr && (
          <div className="error" style={{ marginTop: 0, marginBottom: 10 }}>
            {roleErr}
          </div>
        )}
        <div className="role-picker">
          {/* A MANAGER cannot grant ADMIN — not offered here either, so
              ticking every other box and saving cannot be misread as "ADMIN
              was silently dropped". */}
          {roles
            .filter((r) => isAdmin || r.code !== 'ADMIN')
            .map((r) => {
              const on = draftRoles.includes(r.code);
              return (
                <label key={r.code} className={`role-picker-row${on ? ' is-on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setDraftRoles((d) => (on ? d.filter((x) => x !== r.code) : [...d, r.code]))
                    }
                    style={{ width: 'auto' }}
                  />
                  <RoleBadge code={r.code} />
                  <span className="muted" style={{ fontSize: 12 }}>
                    {r.name || r.code}
                  </span>
                </label>
              );
            })}
        </div>
        {draftRoles.length === 0 && (
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            With no roles this account can sign in but will see nothing.
          </p>
        )}
      </Modal>
    </div>
  );
}
