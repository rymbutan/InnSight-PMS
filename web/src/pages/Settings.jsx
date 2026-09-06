import { useEffect, useRef, useState } from 'react';
import api from '../api';
import { useAuth } from '../auth';
import { useTheme } from '../theme';
import Icon from '../components/Icon';
import Avatar from '../components/Avatar';
import { useToast, errMsg } from '../components/Toast';
import { DEFAULT_ACCENT, applyAccent } from '../lib/accent';
import { primaryRole } from '../lib/roles';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// One card per action: an icon chip, a title, the current value, then the fields
// and a single right-aligned submit. Reused by the username and email cards so
// the two cannot drift apart.
function SettingCard({ icon, title, subtitle, children, onSubmit, busy, action, wide }) {
  return (
    <form className={`set-card${wide ? ' is-wide' : ''}`} onSubmit={onSubmit}>
      <div className="set-card-head">
        <span className="set-card-icon">
          <Icon name={icon} size={16} strokeWidth={1.9} />
        </span>
        <div className="set-card-heading">
          <div className="set-card-title">{title}</div>
          {subtitle ? <div className="set-card-sub">{subtitle}</div> : null}
        </div>
      </div>
      <div className="set-card-body">{children}</div>
      <div className="set-card-foot">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : action}
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }) {
  return (
    <div className="set-field">
      <label className="set-label">{label}</label>
      {children}
    </div>
  );
}

export default function Settings() {
  const { user, setUser, logout, hasRole } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const toast = useToast();
  const fileRef = useRef(null);

  const [uForm, setUForm] = useState({ next: '', confirm: '', password: '' });
  const [eForm, setEForm] = useState({ next: '', confirm: '', password: '' });
  const [pForm, setPForm] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState('');
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [taxRates, setTaxRates] = useState({ vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 });
  const [hotel, setHotel] = useState({ name: '', address: '', phone: '', fax: '', email: '', url: '' });

  const canTheme = hasRole('ADMIN', 'MANAGER');
  // Both Billing endpoints (PUT /api/settings/tax-rates, PUT /api/settings/hotel)
  // are admin/manager-only server-side. Gate the cards the same way the System
  // Color Changer above gates on `canTheme`, so a FRONT_DESK user is not shown
  // editable inputs that only end in a 403 toast on save.
  const canBilling = hasRole('ADMIN', 'MANAGER');

  useEffect(() => {
    api
      .get('/api/settings/theme')
      .then(({ data }) => setAccent({ ...DEFAULT_ACCENT, ...data }))
      .catch(() => {
        /* keep the shipped palette */
      });
  }, []);

  useEffect(() => {
    api.get('/api/settings/tax-rates').then((r) => setTaxRates(r.data)).catch(() => {});
    api.get('/api/settings/hotel').then((r) => setHotel(r.data)).catch(() => {});
  }, []);

  async function submitUsername(e) {
    e.preventDefault();
    if (uForm.next !== uForm.confirm) return toast.error('Usernames do not match.');
    setBusy('username');
    try {
      await api.post('/api/auth/change-username', {
        newUsername: uForm.next,
        currentPassword: uForm.password,
      });
      // The username is a JWT claim, so the server revoked every session — this
      // token is already dead and any further request would 401. Sign out
      // deliberately rather than letting the next click fail.
      toast.success('Username updated. Please sign in again.');
      setTimeout(logout, 1200);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy('');
    }
  }

  async function submitEmail(e) {
    e.preventDefault();
    if (eForm.next !== eForm.confirm) return toast.error('Email addresses do not match.');
    setBusy('email');
    try {
      const { data } = await api.post('/api/auth/change-email', {
        newEmail: eForm.next,
        currentPassword: eForm.password,
      });
      setUser?.({ ...user, email: data.email });
      setEForm({ next: '', confirm: '', password: '' });
      toast.success('Email address updated.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy('');
    }
  }

  async function submitPassword(e) {
    e.preventDefault();
    if (pForm.next !== pForm.confirm) return toast.error('New passwords do not match.');
    if (pForm.next.length < 8) return toast.error('Password must be at least 8 characters.');
    setBusy('password');
    try {
      await api.post('/api/auth/change-password', {
        currentPassword: pForm.current,
        newPassword: pForm.next,
      });
      setPForm({ current: '', next: '', confirm: '' });
      if (user?.mustChangePwd) setUser?.({ ...user, mustChangePwd: false });
      toast.success('Password updated. Other sessions were signed out.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy('');
    }
  }

  async function onPhoto(e) {
    const file = e.target.files?.[0];
    // Reset immediately so picking the SAME file again still fires a change.
    e.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      return toast.error('Choose a PNG, JPG or WEBP image.');
    }
    if (file.size > 4 * 1024 * 1024) return toast.error('Image must be 4MB or smaller.');
    setBusy('photo');
    try {
      // Raw bytes with the image's own Content-Type — the endpoint uses
      // express.raw, not multipart.
      await api.post('/api/auth/avatar', file, { headers: { 'Content-Type': file.type } });
      // Bump the version so <Avatar> refetches past its cache.
      setUser?.({ ...user, avatarUpdatedAt: new Date().toISOString() });
      toast.success('Photo updated.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy('');
    }
  }

  async function removePhoto() {
    setBusy('photo');
    try {
      await api.delete('/api/auth/avatar');
      setUser?.({ ...user, avatarUpdatedAt: null });
      toast.success('Photo removed.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy('');
    }
  }

  async function applyColors(e) {
    e.preventDefault();
    for (const k of ['primary', 'secondary', 'hover']) {
      if (!HEX_RE.test(accent[k])) return toast.error('Pick all three colours.');
    }
    setBusy('accent');
    try {
      const { data } = await api.put('/api/settings/theme', accent);
      applyAccent(data);
      toast.success('System colours applied for everyone.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy('');
    }
  }

  async function resetColors() {
    setBusy('accent');
    try {
      const { data } = await api.put('/api/settings/theme/reset');
      setAccent(data);
      applyAccent(data);
      toast.success('System colours reset.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy('');
    }
  }

  async function saveTaxRates(e) {
    e.preventDefault();
    setBusy('tax');
    try {
      const { data } = await api.put('/api/settings/tax-rates', {
        vat: Number(taxRates.vat),
        serviceCharge: Number(taxRates.serviceCharge),
        localTax: Number(taxRates.localTax),
        realPropertyTax: Number(taxRates.realPropertyTax),
      });
      setTaxRates(data);
      toast.success('Tax rates saved. They apply to charges posted from now on.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveHotel(e) {
    e.preventDefault();
    setBusy('hotel');
    try {
      const { data } = await api.put('/api/settings/hotel', hotel);
      setHotel(data);
      toast.success('Hotel details saved.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="set-page">
      {/* ── Identity header ── */}
      <div className="set-profile">
        <div className="set-profile-id">
          <Avatar
            name={user?.displayName}
            size={44}
            userId={user?.id}
            avatarUpdatedAt={user?.avatarUpdatedAt}
          />
          <div className="set-profile-text">
            <div className="set-profile-name">{user?.displayName}</div>
            <div className="set-profile-meta">
              <span className="set-profile-handle">@{user?.username}</span>
              <span className="set-profile-dot">·</span>
              <span className="set-chip" title={user?.roles?.join(', ')}>
                {primaryRole(user?.roles)}
              </span>
            </div>
            {user?.email ? <div className="set-profile-email">{user.email}</div> : null}
          </div>
        </div>

        <div className="set-profile-actions">
          <div className="set-photo-btns">
            <button
              type="button"
              className="set-btn"
              onClick={() => fileRef.current?.click()}
              disabled={busy === 'photo'}
            >
              <Icon name="camera" size={14} strokeWidth={1.9} />
              {busy === 'photo' ? 'Working…' : 'Change Photo'}
            </button>
            {user?.avatarUpdatedAt ? (
              <button
                type="button"
                className="set-btn is-quiet"
                onClick={removePhoto}
                disabled={busy === 'photo'}
              >
                Remove
              </button>
            ) : null}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={onPhoto}
            hidden
          />
          <div className="set-hint">PNG, JPG, or WEBP · up to 4MB</div>
        </div>
      </div>

      {/* ── Account information ── */}
      <div className="set-section-label">Account Information</div>

      <div className="set-grid">
        <SettingCard
          icon="user"
          title="Change Username"
          subtitle={
            <>
              Current: <strong>@{user?.username}</strong>
            </>
          }
          onSubmit={submitUsername}
          busy={busy === 'username'}
          action="Update Username"
        >
          <Field label="New Username">
            <input
              placeholder="Enter new username"
              value={uForm.next}
              onChange={(e) => setUForm({ ...uForm, next: e.target.value })}
              required
            />
          </Field>
          <Field label="Confirm Username">
            <input
              placeholder="Re-enter username"
              value={uForm.confirm}
              onChange={(e) => setUForm({ ...uForm, confirm: e.target.value })}
              required
            />
          </Field>
          {/* The username is a login identifier, so the server re-checks the
              password before moving it. */}
          <Field label="Current Password">
            <input
              type="password"
              placeholder="Confirm with your password"
              value={uForm.password}
              onChange={(e) => setUForm({ ...uForm, password: e.target.value })}
              required
            />
          </Field>
          <div className="set-note">
            Changing your username signs you out of every device.
          </div>
        </SettingCard>

        <SettingCard
          icon="mail"
          title="Change Email"
          subtitle={
            <>
              Current: <strong>{user?.email || 'not set'}</strong>
            </>
          }
          onSubmit={submitEmail}
          busy={busy === 'email'}
          action="Update Email"
        >
          <Field label="New Email">
            <input
              type="email"
              placeholder="Enter new email"
              value={eForm.next}
              onChange={(e) => setEForm({ ...eForm, next: e.target.value })}
              required
            />
          </Field>
          <Field label="Confirm Email">
            <input
              type="email"
              placeholder="Re-enter email"
              value={eForm.confirm}
              onChange={(e) => setEForm({ ...eForm, confirm: e.target.value })}
              required
            />
          </Field>
          <Field label="Current Password">
            <input
              type="password"
              placeholder="Confirm with your password"
              value={eForm.password}
              onChange={(e) => setEForm({ ...eForm, password: e.target.value })}
              required
            />
          </Field>
        </SettingCard>
      </div>

      <SettingCard
        wide
        icon="lock"
        title="Change Password"
        subtitle="At least 8 characters with uppercase, lowercase, a number & a special character"
        onSubmit={submitPassword}
        busy={busy === 'password'}
        action="Update Password"
      >
        <Field label="Current Password">
          <input
            type="password"
            placeholder="Enter current password"
            value={pForm.current}
            onChange={(e) => setPForm({ ...pForm, current: e.target.value })}
            required
          />
        </Field>
        <div className="set-row-2">
          <Field label="New Password">
            <input
              type="password"
              placeholder="Min 8 chars, mixed case, number & symbol"
              minLength={8}
              value={pForm.next}
              onChange={(e) => setPForm({ ...pForm, next: e.target.value })}
              required
            />
          </Field>
          <Field label="Confirm New Password">
            <input
              type="password"
              placeholder="Re-enter new password"
              value={pForm.confirm}
              onChange={(e) => setPForm({ ...pForm, confirm: e.target.value })}
              required
            />
          </Field>
        </div>
        <div className="set-note">
          Must include uppercase, lowercase, a number, and a special character.
        </div>
      </SettingCard>

      {/* ── Appearance ── */}
      <div className="set-section-label">System Appearance</div>

      <div className="set-card is-wide">
        <div className="set-card-head">
          <span className="set-card-icon">
            <Icon name="sun" size={16} strokeWidth={1.9} />
          </span>
          <div className="set-card-heading">
            <div className="set-card-title">Theme</div>
            <div className="set-card-sub">
              Currently {theme === 'dark' ? 'dark' : 'light'}. Saved on this device only.
            </div>
          </div>
        </div>
        <div className="set-card-foot">
          <button type="button" className="set-btn" onClick={toggleTheme}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} strokeWidth={1.9} />
            Switch to {theme === 'dark' ? 'light' : 'dark'}
          </button>
        </div>
      </div>

      {canTheme ? (
        <form className="set-card is-wide" onSubmit={applyColors}>
          <div className="set-card-head">
            <span className="set-card-icon">
              <Icon name="palette" size={16} strokeWidth={1.9} />
            </span>
            <div className="set-card-heading">
              <div className="set-card-title">System Color Changer</div>
              <div className="set-card-sub">
                Customize the accent colors used throughout the system
              </div>
            </div>
          </div>
          <div className="set-card-body">
            <div className="set-row-3">
              <Field label="Primary Accent">
                <input
                  type="color"
                  className="set-color"
                  value={accent.primary}
                  onChange={(e) => setAccent({ ...accent, primary: e.target.value })}
                />
              </Field>
              <Field label="Secondary Accent">
                <input
                  type="color"
                  className="set-color"
                  value={accent.secondary}
                  onChange={(e) => setAccent({ ...accent, secondary: e.target.value })}
                />
              </Field>
              <Field label="Hover / Dark Accent">
                <input
                  type="color"
                  className="set-color"
                  value={accent.hover}
                  onChange={(e) => setAccent({ ...accent, hover: e.target.value })}
                />
              </Field>
            </div>
            <div className="set-note">
              Applies to every user on every device. Buttons and highlights place white
              text on the primary and hover colours, so choose shades dark enough to
              read against.
            </div>
          </div>
          <div className="set-card-foot">
            <button
              type="button"
              className="set-btn is-quiet"
              onClick={resetColors}
              disabled={busy === 'accent'}
            >
              Reset to default
            </button>
            <button type="submit" className="btn-primary" disabled={busy === 'accent'}>
              {busy === 'accent' ? 'Applying…' : 'Apply Colors'}
            </button>
          </div>
        </form>
      ) : null}

      {/* ── Billing ──
          Both endpoints below (PUT /api/settings/tax-rates, PUT
          /api/settings/hotel) are admin/manager-only, so the whole section —
          heading included — is gated on `canBilling`, the same predicate the
          System Color Changer above uses for `canTheme`. */}
      {canBilling ? (
        <>
          <div className="set-section-label">Billing</div>

          <form className="set-card is-wide" onSubmit={saveTaxRates}>
            <div className="set-card-head">
              <span className="set-card-icon">
                <Icon name="dollar-sign" size={16} strokeWidth={1.9} />
              </span>
              <div className="set-card-heading">
                <div className="set-card-title">Tax Rates</div>
                <div className="set-card-sub">
                  Applied to charges as they are posted. Existing charges keep the rates they
                  were posted with.
                </div>
              </div>
            </div>
            <div className="set-card-body">
              <div className="set-row-3">
                {[
                  ['vat', 'VAT (%)'],
                  ['serviceCharge', 'Service Charge (%)'],
                  ['localTax', 'Local Tax (%)'],
                  ['realPropertyTax', 'Real Property Tax (%)'],
                ].map(([key, label]) => (
                  <Field key={key} label={label}>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={taxRates[key]}
                      onChange={(e) => setTaxRates({ ...taxRates, [key]: e.target.value })}
                    />
                  </Field>
                ))}
              </div>
              <p className="muted" style={{ fontSize: 12 }}>
                Local Tax and Real Property Tax ship at 0% — they vary by locality, so set them
                to this property&rsquo;s actual rates before billing guests.
              </p>
            </div>
            <div className="set-card-foot">
              <button type="submit" className="btn-primary" disabled={busy === 'tax'}>
                {busy === 'tax' ? 'Saving…' : 'Save Rates'}
              </button>
            </div>
          </form>

          <form className="set-card is-wide" onSubmit={saveHotel}>
            <div className="set-card-head">
              <span className="set-card-icon">
                <Icon name="building-2" size={16} strokeWidth={1.9} />
              </span>
              <div className="set-card-heading">
                <div className="set-card-title">Hotel Details</div>
                <div className="set-card-sub">Printed at the top of every guest folio.</div>
              </div>
            </div>
            <div className="set-card-body">
              <div className="set-row-3">
                {[
                  ['name', 'Hotel name'],
                  ['address', 'Address'],
                  ['phone', 'Phone'],
                  ['fax', 'Fax'],
                  ['email', 'E-mail'],
                  ['url', 'Website'],
                ].map(([key, label]) => (
                  <Field key={key} label={label}>
                    <input
                      value={hotel[key] || ''}
                      maxLength={200}
                      onChange={(e) => setHotel({ ...hotel, [key]: e.target.value })}
                    />
                  </Field>
                ))}
              </div>
            </div>
            <div className="set-card-foot">
              <button type="submit" className="btn-primary" disabled={busy === 'hotel'}>
                {busy === 'hotel' ? 'Saving…' : 'Save Details'}
              </button>
            </div>
          </form>
        </>
      ) : null}
    </div>
  );
}
