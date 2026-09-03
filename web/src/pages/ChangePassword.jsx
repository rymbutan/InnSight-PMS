import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';

export default function ChangePassword() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user, setUser } = useAuth();
  const [form, setForm] = useState({ oldPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (form.newPassword !== form.confirm) {
      toast.error('New passwords do not match.');
      return;
    }
    if (form.newPassword.length < 8) {
      toast.error('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/auth/change-password', {
        oldPassword: form.oldPassword,
        newPassword: form.newPassword,
      });
      toast.success('Password changed.');
      if (user?.mustChangePwd && setUser) {
        setUser({ ...user, mustChangePwd: false });
      }
      navigate('/');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>Change password</h2>
      <div className="panel" style={{ maxWidth: 480 }}>
        {user?.mustChangePwd && (
          <p
            className="muted"
            style={{
              background: 'var(--warn-soft)',
              color: 'var(--on-warn-soft)',
              padding: 10,
              borderRadius: 4,
              marginBottom: 12,
            }}
          >
            You must change your password before using the system.
          </p>
        )}
        <form onSubmit={submit}>
          <label>Current password</label>
          <input
            type="password"
            required
            value={form.oldPassword}
            onChange={(e) => setForm({ ...form, oldPassword: e.target.value })}
          />
          <label style={{ marginTop: 12 }}>New password (min 8 chars)</label>
          <input
            type="password"
            required
            minLength={8}
            value={form.newPassword}
            onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
          />
          <label style={{ marginTop: 12 }}>Confirm new password</label>
          <input
            type="password"
            required
            value={form.confirm}
            onChange={(e) => setForm({ ...form, confirm: e.target.value })}
          />
          <button style={{ marginTop: 16 }} disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </form>
      </div>
    </div>
  );
}
