import { useEffect, useRef, useState } from 'react';
import api from '../api';
import { useAuth } from '../auth';
import { useTheme } from '../theme';
import Icon from '../components/Icon';
import Avatar from '../components/Avatar';
import { useToast, errMsg } from '../components/Toast';
import { DEFAULT_ACCENT, applyAccent } from '../lib/accent';
import { primaryRole, roleLabel } from '../lib/roles';
import { useMessageSound } from '../lib/sound';

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

// One collapsible bar per settings category — closed by default, so a page
// that used to be a long scroll of every card at once now opens on four
// clean rows and lets staff expand only the section they came for.
function AccordionSection({ icon, title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`set-accordion${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="set-accordion-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="set-accordion-icon">
          <Icon name={icon} size={16} strokeWidth={1.9} />
        </span>
        <span className="set-accordion-title">{title}</span>
        <Icon name="chevron-down" size={16} className="set-accordion-caret" />
      </button>
      {open && <div className="set-accordion-body">{children}</div>}
    </div>
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
  const [taxRates, setTaxRates] = useState({
    vat: 12,
    serviceCharge: 10,
    localTax: 0,
    realPropertyTax: 0,
    country: 'PH',
  });
  // The country whose rates the form is currently showing/editing — starts as
  // the property's own (whatever the tax-rates fetch below answers with), but
  // can be pointed at a different jurisdiction to pre-configure it without
  // switching the property to it. Kept separate from `taxRates.country` so
  // typing in the box doesn't refetch on every keystroke.
  const [taxCountryInput, setTaxCountryInput] = useState('');
  // Surcharge on CARD/BANK_TRANSFER payments — see policies.js's
  // paymentProcessingFeeCents and the Folios page's Payment tab, which shows
  // this same figure as a live preview before a payment is posted.
  const [paymentFeePercent, setPaymentFeePercent] = useState(0);
  const [hotel, setHotel] = useState({
    name: '',
    address: '',
    phone: '',
    fax: '',
    email: '',
    url: '',
    checkInTime: '14:00',
    checkOutTime: '12:00',
    country: 'PH',
  });

  const canTheme = hasRole('ADMIN');
  // Editing which sections a role can reach is ADMIN-only — MANAGER is one of
  // the roles it configures, so a manager with access could restore anything an
  // admin had taken from them.
  const canLayout = hasRole('ADMIN');
  // Both Billing endpoints (PUT /api/settings/tax-rates, PUT /api/settings/hotel)
  // are admin/manager-only server-side. Gate the cards the same way the System
  // Color Changer above gates on `canTheme`, so a FRONT_DESK user is not shown
  // editable inputs that only end in a 403 toast on save.
  const canBilling = hasRole('ADMIN', 'MANAGER');
  // Message retention is ADMIN-only for the same reason Edit System Layout is,
  // only more so: shortening the window DELETES other people's conversations,
  // hotel-wide and irreversibly. MANAGER configures the desk; this configures
  // what the desk is allowed to keep.
  const canRetention = hasRole('ADMIN');

  // Per-device, like the theme toggle below it — whether a chime is welcome
  // depends on the room the terminal is in, not on who is signed in to it.
  const [soundOn, setSoundOn] = useMessageSound();
  const [retention, setRetention] = useState(null);

  useEffect(() => {
    if (!canRetention) return;
    api
      .get('/api/messages/settings/retention')
      .then(({ data }) => setRetention(data))
      .catch(() => {
        /* messaging service down — the card stays in its loading state */
      });
  }, [canRetention]);

  async function saveRetention(mode) {
    setBusy('retention');
    try {
      const { data } = await api.put('/api/messages/settings/retention', { mode });
      setRetention((r) => ({ ...r, ...data }));
      toast.success(
        data.purged > 0
          ? `Retention saved. ${data.purged} message${data.purged === 1 ? '' : 's'} past the new limit ` +
              'were cleared.'
          : 'Retention saved. It applies to everyone, on every device.'
      );
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy('');
    }
  }

  useEffect(() => {
    api
      .get('/api/settings/theme')
      .then(({ data }) => setAccent({ ...DEFAULT_ACCENT, ...data }))
      .catch(() => {
        /* keep the shipped palette */
      });
  }, []);

  useEffect(() => {
    api
      .get('/api/settings/tax-rates')
      .then((r) => {
        setTaxRates(r.data);
        setTaxCountryInput(r.data.country);
      })
      .catch(() => {});
    api
      .get('/api/settings/hotel')
      .then((r) => setHotel(r.data))
      .catch(() => {});
    api
      .get('/api/settings/payment-fee-percent')
      .then((r) => setPaymentFeePercent(r.data.feePercent))
      .catch(() => {});
  }, []);

  // Load a different jurisdiction's rates into the form WITHOUT changing which
  // country is the property's active one — for configuring a country ahead of
  // switching to it. Saving from here still only takes effect for real charges
  // once Hotel Details' Country field is set to match.
  async function loadTaxCountry(e) {
    e.preventDefault();
    const country = taxCountryInput.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) return toast.error('Country must be a 2-letter code, e.g. PH.');
    setBusy('taxCountry');
    try {
      const { data } = await api.get('/api/settings/tax-rates', { params: { country } });
      setTaxRates(data);
      setTaxCountryInput(data.country);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(null);
    }
  }

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
      const { data } = await api.put(
        '/api/settings/tax-rates',
        {
          vat: Number(taxRates.vat),
          serviceCharge: Number(taxRates.serviceCharge),
          localTax: Number(taxRates.localTax),
          realPropertyTax: Number(taxRates.realPropertyTax),
        },
        { params: { country: taxRates.country } }
      );
      setTaxRates(data);
      toast.success(
        data.country === hotel.country
          ? 'Tax rates saved. They apply to charges posted from now on.'
          : `Tax rates saved for ${data.country}. The property is currently set to ${hotel.country}, ` +
              `so these will not apply to a real charge until Hotel Details' Country is changed to match.`
      );
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(null);
    }
  }

  async function savePaymentFeePercent(e) {
    e.preventDefault();
    setBusy('paymentFee');
    try {
      const { data } = await api.put('/api/settings/payment-fee-percent', {
        feePercent: Number(paymentFeePercent),
      });
      setPaymentFeePercent(data.feePercent);
      toast.success('Payment processing fee saved. It applies to card/bank transfer payments from now on.');
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
      <AccordionSection icon="user" title="Account Information">
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
            <div className="set-note">Changing your username signs you out of every device.</div>
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
      </AccordionSection>

      {/* ── Billing ──
          Both endpoints below (PUT /api/settings/tax-rates, PUT
          /api/settings/hotel) are admin/manager-only, so both new sections —
          headers included — are gated on `canBilling`, the same predicate the
          System Color Changer below uses for `canTheme`. */}
      {canBilling ? (
        <AccordionSection icon="credit-card" title="Billing">
          <form className="set-card is-wide" onSubmit={saveTaxRates}>
            <div className="set-card-head">
              <span className="set-card-icon">
                <Icon name="dollar-sign" size={16} strokeWidth={1.9} />
              </span>
              <div className="set-card-heading">
                <div className="set-card-title">Tax Rates</div>
                <div className="set-card-sub">
                  Applied to charges as they are posted, for whichever country is the property's jurisdiction
                  (Hotel Details) — never a guest's own nationality. Existing charges keep the rates they were
                  posted with.
                </div>
              </div>
            </div>
            <div className="set-card-body">
              <div className="set-row-3" style={{ marginBottom: 12 }}>
                <Field label="Viewing jurisdiction">
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={taxCountryInput}
                      maxLength={2}
                      style={{ textTransform: 'uppercase' }}
                      placeholder="PH"
                      onChange={(e) => setTaxCountryInput(e.target.value)}
                    />
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy === 'taxCountry'}
                      onClick={loadTaxCountry}
                    >
                      {busy === 'taxCountry' ? 'Loading…' : 'Load'}
                    </button>
                  </div>
                </Field>
                <Field label="">
                  <p className="muted" style={{ fontSize: 11.5, margin: '6px 0 0' }}>
                    {taxRates.country === hotel.country
                      ? `This is the property's active jurisdiction — rates saved here bill real guests.`
                      : `The property is currently ${hotel.country}. Rates saved for ${taxRates.country} ` +
                        `here are stored but won't apply to a real charge until Hotel Details' Country is changed to match.`}
                  </p>
                </Field>
              </div>
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
                Local Tax and Real Property Tax ship at 0% — they vary by locality, so set them to this
                property&rsquo;s actual rates before billing guests.
              </p>
            </div>
            <div className="set-card-foot">
              <button type="submit" className="btn-primary" disabled={busy === 'tax'}>
                {busy === 'tax' ? 'Saving…' : 'Save Rates'}
              </button>
            </div>
          </form>

          <SettingCard
            icon="credit-card"
            title="Payment Processing Fee"
            subtitle="A surcharge posted to the Ledger whenever a guest pays by card or bank transfer — never cash or a manual e-wallet entry."
            onSubmit={savePaymentFeePercent}
            busy={busy === 'paymentFee'}
            action="Save Fee"
          >
            <Field label="Fee (%)">
              <input
                type="number"
                step="0.01"
                min="0"
                max="100"
                style={{ maxWidth: 140 }}
                value={paymentFeePercent}
                onChange={(e) => setPaymentFeePercent(e.target.value)}
              />
            </Field>
            <p className="muted" style={{ fontSize: 12 }}>
              Ships at 0% — no fee is charged until this is set. Changing it only affects payments posted from
              now on; anything already on a folio keeps the fee it was charged with.
            </p>
          </SettingCard>
        </AccordionSection>
      ) : null}

      {/* ── Hotel Details ── */}
      {canBilling ? (
        <AccordionSection icon="building-2" title="Hotel Details">
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

              {/* Not cosmetic. These two times are stamped onto every booking's
                  stored window, and the no-double-booking constraint compares
                  those windows — so they are what makes a room vacated at noon
                  and re-let at 2pm a clean handover rather than a conflict.
                  Check-out must be earlier in the day than check-in; the server
                  refuses any other pair. */}
              <div className="set-row-3" style={{ marginTop: 12 }}>
                <Field label="Check-in time">
                  <input
                    type="time"
                    value={hotel.checkInTime || '14:00'}
                    onChange={(e) => setHotel({ ...hotel, checkInTime: e.target.value })}
                  />
                </Field>
                <Field label="Check-out time">
                  <input
                    type="time"
                    value={hotel.checkOutTime || '12:00'}
                    onChange={(e) => setHotel({ ...hotel, checkOutTime: e.target.value })}
                  />
                </Field>
                <Field label="">
                  <p className="muted" style={{ fontSize: 11.5, margin: '6px 0 0' }}>
                    Applies to new and edited bookings. Existing bookings keep the window they were taken
                    with.
                  </p>
                </Field>
              </div>

              {/* Decides which country's Tax Rates (Billing) actually apply to
                  a real charge — a guest's own nationality plays no part. */}
              <div className="set-row-3" style={{ marginTop: 12 }}>
                <Field label="Country (ISO 2-letter, decides tax jurisdiction)">
                  <input
                    value={hotel.country || ''}
                    maxLength={2}
                    style={{ textTransform: 'uppercase' }}
                    placeholder="PH"
                    onChange={(e) => setHotel({ ...hotel, country: e.target.value })}
                  />
                </Field>
              </div>
            </div>
            <div className="set-card-foot">
              <button type="submit" className="btn-primary" disabled={busy === 'hotel'}>
                {busy === 'hotel' ? 'Saving…' : 'Save Details'}
              </button>
            </div>
          </form>
        </AccordionSection>
      ) : null}

      {/* ── Appearance ── */}
      <AccordionSection icon="palette" title="System Appearance">
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
                <div className="set-card-sub">Customize the accent colors used throughout the system</div>
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
                Applies to every user on every device. Buttons and highlights place white text on the primary
                and hover colours, so choose shades dark enough to read against.
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
      </AccordionSection>

      {/* ── Messaging ──
          Two settings that look similar and are not. The sound is a personal,
          per-device convenience stored in localStorage. Retention is hotel
          policy that deletes other people's messages, so it is ADMIN-only,
          server-side, and applies to every user on every device. They share a
          section because that is where people will look for both, but the
          copy on each card has to keep the difference obvious. */}
      <AccordionSection icon="message-circle" title="Messaging">
        <div className="set-card is-wide">
          <div className="set-card-head">
            <span className="set-card-icon">
              <Icon name={soundOn ? 'bell' : 'bell-off'} size={16} strokeWidth={1.9} />
            </span>
            <div className="set-card-heading">
              <div className="set-card-title">Message Sound</div>
              <div className="set-card-sub">
                A short chime when a message arrives. Currently {soundOn ? 'on' : 'muted'}. Saved on this
                device only.
              </div>
            </div>
          </div>
          <div className="set-card-foot">
            <button type="button" className="set-btn" onClick={() => setSoundOn(!soundOn)}>
              <Icon name={soundOn ? 'bell-off' : 'bell'} size={14} strokeWidth={1.9} />
              {soundOn ? 'Mute notifications' : 'Unmute notifications'}
            </button>
          </div>
        </div>

        {canRetention ? (
          <div className="set-card is-wide">
            <div className="set-card-head">
              <span className="set-card-icon">
                <Icon name="trash" size={16} strokeWidth={1.9} />
              </span>
              <div className="set-card-heading">
                <div className="set-card-title">Message Retention</div>
                <div className="set-card-sub">
                  How long a staff message survives before it is deleted. Applies to everyone — a conversation
                  has two ends, so this cannot be a personal preference.
                </div>
              </div>
            </div>
            <div className="set-card-body">
              {!retention ? (
                <p className="muted" style={{ fontSize: 12 }}>
                  Loading current setting…
                </p>
              ) : (
                <>
                  <div className="retention-options">
                    {retention.options?.map((o) => (
                      <label
                        key={o.mode}
                        className={`retention-option${retention.mode === o.mode ? ' is-active' : ''}`}
                      >
                        <input
                          type="radio"
                          name="retention"
                          value={o.mode}
                          checked={retention.mode === o.mode}
                          disabled={busy === 'retention'}
                          onChange={() => saveRetention(o.mode)}
                        />
                        <span className="retention-option-text">
                          <span className="retention-option-label">{o.label}</span>
                          {o.detail ? <span className="retention-option-detail">{o.detail}</span> : null}
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="set-note">
                    Saved the moment you choose one, and anything already past the new limit is cleared
                    straight away — this is not a change you get to review before it takes effect. Deleting is
                    permanent, and it clears the message for both people in the conversation.
                  </div>
                </>
              )}
            </div>
          </div>
        ) : null}
      </AccordionSection>

      {/* ── Edit System Layout ──
          Which sections of the product each role can reach. ADMIN only, and
          narrower than Billing on purpose: MANAGER is one of the roles this
          configures, so a manager who could edit it could hand themselves back
          anything an admin had taken away. */}
      {canLayout ? (
        <AccordionSection icon="layout-dashboard" title="Edit System Layout">
          <SidebarVisibility />
        </AccordionSection>
      ) : null}
    </div>
  );
}

// ── Sidebar Visibility ───────────────────────────────────────────────────────
// A checkbox per (role, section). Unticking one hides that section's sidebar
// entry for that role, redirects the route if the URL is typed, and closes the
// APIs the section owns once no remaining section needs them — see
// services/_shared/navScope.js for why that last one is a union and not a
// per-page map.
//
// The grid is rendered from what the server returns, not from a list held here:
// a section added to navSections.json shows up in this editor with no change to
// this file, and cannot be ticked into a state the server would reject.
function SidebarVisibility() {
  const toast = useToast();
  const { refreshSections } = useAuth();
  const [cfg, setCfg] = useState(null); // { sections, roles, hidden }
  const [hidden, setHidden] = useState({}); // working copy: { ROLE: [key…] }
  const [saving, setSaving] = useState(false);
  // Which role's grid is on screen. One role at a time rather than every role
  // at once: five roles times fourteen sections is seventy checkboxes, and a
  // wall that size is one nobody reads before clicking.
  const [role, setRole] = useState(null);

  useEffect(() => {
    api
      .get('/api/settings/nav-visibility')
      .then(({ data }) => {
        setCfg(data);
        setHidden(data.hidden || {});
        setRole(data.roles?.[0] || null);
      })
      .catch((e) => toast.error(errMsg(e)));
  }, []);

  // Stored as what is HIDDEN, shown as what is VISIBLE. The checkbox reads the
  // way the sentence does — ticked means "this role sees it" — while the stored
  // shape stays additive-free: a section added to the catalogue later is visible
  // to everyone by default rather than hidden until someone notices.
  function toggle(key) {
    setHidden((h) => {
      const list = h[role] || [];
      return { ...h, [role]: list.includes(key) ? list.filter((k) => k !== key) : [...list, key] };
    });
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const { data } = await api.put('/api/settings/nav-visibility', { hidden });
      setHidden(data.hidden || {});
      toast.success('Layout saved.');
      // Your own sidebar may have just changed, if you hold one of the roles
      // that was edited.
      refreshSections();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  if (!cfg)
    return (
      <p className="muted" style={{ padding: 16 }}>
        Loading layout…
      </p>
    );

  const hiddenForRole = hidden[role] || [];

  return (
    <form className="set-card is-wide" onSubmit={save}>
      <div className="set-card-head">
        <span className="set-card-icon">
          <Icon name="layout-dashboard" size={16} strokeWidth={1.9} />
        </span>
        <div className="set-card-heading">
          <div className="set-card-title">Sidebar Visibility</div>
          <div className="set-card-sub">
            Show or hide sections per role. Core items (Dashboard, Settings) always stay visible, and Admin is
            not configurable — it is the only role that can undo a change made here.
          </div>
        </div>
      </div>

      <div className="set-card-body">
        <div className="set-field">
          <label className="set-label">Role</label>
          <select value={role || ''} onChange={(e) => setRole(e.target.value)}>
            {cfg.roles.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </div>

        {cfg.sections.map((group) => {
          // A group whose every item is out of this role's reach anyway is not
          // shown at all — offering a checkbox that changes nothing because the
          // role could never see the page is worse than offering nothing.
          const items = group.items.filter((i) => !i.roles || i.roles.includes(role));
          if (!items.length) return null;
          return (
            <div key={group.label} style={{ marginTop: 14 }}>
              <div className="set-label" style={{ marginBottom: 6 }}>
                {group.label}
              </div>
              <div className="nav-vis-grid">
                {items.map((item) => (
                  <label
                    key={item.key}
                    className="nav-vis-item"
                    title={item.core ? 'Always visible — cannot be hidden.' : undefined}
                  >
                    <input
                      type="checkbox"
                      disabled={item.core}
                      checked={item.core || !hiddenForRole.includes(item.key)}
                      onChange={() => toggle(item.key)}
                    />
                    <span>{item.label}</span>
                    {item.core && <span className="muted nav-vis-core">always on</span>}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="set-card-foot">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save Layout'}
        </button>
      </div>
    </form>
  );
}
