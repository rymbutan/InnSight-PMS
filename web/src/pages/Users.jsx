import { useEffect, useState } from 'react';
import api from '../api';

export default function Users() {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [form, setForm] = useState({ username: '', password: '', displayName: '', email: '', roles: [] });
  const [msg, setMsg] = useState('');
  const [requests, setRequests] = useState([]);

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
  async function resetPwd(id) {
    const newPassword = prompt('New password (min 8 chars):');
    if (!newPassword) return;
    try {
      await api.post(`/api/users/${id}/reset-password`, { newPassword });
      setMsg('Password reset.');
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    }
  }
  async function toggle(u) {
    const op = u.status === 'ACTIVE' ? 'disable' : 'enable';
    try {
      await api.post(`/api/users/${u.id}/${op}`);
      load();
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    }
  }
  async function setUserRoles(id, newRoles) {
    try {
      await api.put(`/api/users/${id}/roles`, { roles: newRoles });
      load();
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    }
  }

  // Approving is what creates the account — the request itself grants nothing,
  // so the roles are chosen here, at approval time.
  async function approveRequest(r) {
    const username = prompt(`Username for ${r.fullName}:`, r.email.split('@')[0]);
    if (!username) return;
    const wanted = prompt(
      `Roles for ${r.fullName}, comma-separated.\nAvailable: ${roles.map((x) => x.code).join(', ')}`,
      ''
    );
    if (wanted === null) return;
    const chosen = wanted
      .split(',')
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);
    const unknown = chosen.filter((c) => !roles.some((x) => x.code === c));
    if (unknown.length) {
      setMsg(`Unknown role(s): ${unknown.join(', ')}`);
      return;
    }
    try {
      await api.post(`/api/access-requests/${r.id}/approve`, { username, roles: chosen });
      setMsg(`Approved ${r.email}. They can now sign in with Google.`);
      load();
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    }
  }

  async function rejectRequest(r) {
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
          <p className="muted" style={{ marginTop: 0 }}>
            People who asked for an account from the sign-in screen. Approving one creates the user and grants
            the roles you choose — the request itself grants nothing.
          </p>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>University email</th>
                <th>Reason</th>
                <th>Requested</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{r.fullName}</td>
                  <td>{r.email}</td>
                  <td className="muted">{r.note || '—'}</td>
                  <td className="muted">{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button onClick={() => approveRequest(r)}>Approve</button>{' '}
                    <button className="secondary" onClick={() => rejectRequest(r)}>
                      Reject
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
          </div>
          <div>
            <label>Roles</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {roles.map((r) => (
                <label
                  key={r.code}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, textTransform: 'none' }}
                >
                  <input
                    type="checkbox"
                    checked={form.roles.includes(r.code)}
                    onChange={() => toggleRoleInForm(r.code)}
                    style={{ width: 'auto' }}
                  />
                  {r.code}
                </label>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <button>Create</button>
          </div>
        </form>
      </div>

      <div className="panel">
        <h3>Users</h3>
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Name</th>
              <th>Status</th>
              <th>Roles</th>
              <th>Last login</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.displayName}</td>
                <td>
                  <span className={`badge ${u.status === 'ACTIVE' ? 'confirmed' : 'cancelled'}`}>
                    {u.status}
                  </span>
                </td>
                <td>
                  <select
                    multiple
                    value={u.roles?.map((r) => r.roleCode) || []}
                    onChange={(e) =>
                      setUserRoles(
                        u.id,
                        Array.from(e.target.selectedOptions, (o) => o.value)
                      )
                    }
                    style={{ minWidth: 160, height: 60 }}
                  >
                    {roles.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.code}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
                <td>
                  <button className="small secondary" onClick={() => resetPwd(u.id)}>
                    Reset pwd
                  </button>{' '}
                  <button className="small danger" onClick={() => toggle(u)}>
                    {u.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
