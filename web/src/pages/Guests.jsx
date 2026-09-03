import { useEffect, useState } from 'react';
import api from '../api';
import Avatar from '../components/Avatar';
import EmptyState from '../components/EmptyState';

export default function Guests() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({ firstName: '', lastName: '', nationality: '', vipLevel: 'NONE' });
  const [msg, setMsg] = useState('');

  async function search(e) {
    e?.preventDefault();
    try {
      const { data } = await api.get(`/api/guests/search?q=${encodeURIComponent(q)}`);
      setResults(data);
    } catch (err) {
      setMsg(err.response?.data?.error || err.message);
    }
  }
  async function create(e) {
    e.preventDefault();
    try {
      const { data } = await api.post('/api/guests', form);
      setMsg(`Created ${data.profileNumber}`);
      setForm({ firstName: '', lastName: '', nationality: '', vipLevel: 'NONE' });
      search();
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    }
  }
  async function openGuest(id) {
    try {
      const { data } = await api.get(`/api/guests/${id}`);
      setSelected(data);
    } catch (err) {
      setMsg(err.response?.data?.error || err.message);
    }
  }
  async function saveGuest() {
    try {
      await api.patch(`/api/guests/${selected.id}`, {
        firstName: selected.firstName,
        lastName: selected.lastName,
        nationality: selected.nationality,
        vipLevel: selected.vipLevel,
      });
      setMsg('Saved.');
      search();
    } catch (err) {
      setMsg(err.response?.data?.error || err.message);
    }
  }

  useEffect(() => {
    search();
  }, []);

  return (
    <div>
      <h2>Guest Profiles</h2>
      {msg && (
        <div className="muted" style={{ marginBottom: 12 }}>
          {msg}
        </div>
      )}

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
          </div>
          <button>Create</button>
        </form>
      </div>

      <div className="panel">
        <h3>Search</h3>
        <form onSubmit={search} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input placeholder="Name or profile number" value={q} onChange={(e) => setQ(e.target.value)} />
          <button>Search</button>
        </form>
        {results.length === 0 ? (
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
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Profile #</th>
                <th>Name</th>
                <th>Nationality</th>
                <th>VIP</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {results.map((g) => (
                <tr key={g.id}>
                  <td style={{ width: 40 }}>
                    <Avatar name={g.displayName} size={32} />
                  </td>
                  <td>{g.profileNumber}</td>
                  <td>{g.displayName}</td>
                  <td>{g.nationality || '—'}</td>
                  <td>{g.vipLevel}</td>
                  <td>
                    <button className="small secondary" onClick={() => openGuest(g.id)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
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
          <button className="secondary" onClick={() => setSelected(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
