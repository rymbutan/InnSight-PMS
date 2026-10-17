import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api';
import { SkeletonTableBlock } from '../components/Skeleton';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { pesosToCents, centsToPesos, formatPeso } from '../lib/money';
import EmptyState from '../components/EmptyState';
import { localDay } from '../lib/date';
import { labelize } from '../lib/labels';
import { useConfirm } from '../components/ConfirmDialog';
import Icon from '../components/Icon';

const CATEGORIES = [
  'EVENT_HALL',
  'MEETING_ROOM',
  'GYM',
  'POOL',
  'RESTAURANT',
  'SPA',
  'PARKING',
  'LAUNDRY',
  'OTHER',
];
const MODELS = ['PER_USE', 'PER_HOUR', 'PER_PERSON', 'PER_DAY'];
const METHODS = ['CASH', 'CARD', 'GCASH', 'BANK'];

// Mirrors the server-side pricing (display only; server is authoritative).
function total(f, { units = 1, persons = 1, startAt, endAt } = {}) {
  const p = f.priceCents;
  if (f.pricingModel === 'PER_HOUR') {
    const h =
      startAt && endAt
        ? Math.max(1, Math.ceil((new Date(endAt) - new Date(startAt)) / 3600000))
        : Math.max(1, units);
    return p * h;
  }
  if (f.pricingModel === 'PER_DAY') {
    const d =
      startAt && endAt
        ? Math.max(1, Math.ceil((new Date(endAt) - new Date(startAt)) / 86400000))
        : Math.max(1, units);
    return p * d;
  }
  if (f.pricingModel === 'PER_PERSON') return p * Math.max(1, persons || units);
  return p * Math.max(1, units);
}
// A date plus two clock times → the two ISO instants the API wants. Built from
// the LOCAL date string rather than parsed out of a UTC stamp: `2026-09-06` +
// `09:00` has to mean nine in the morning at the hotel, whatever offset the
// browser is on.
function bookWindow({ date, start, end }) {
  if (!date || !start || !end) return { startAt: null, endAt: null };
  return {
    startAt: new Date(`${date}T${start}`).toISOString(),
    endAt: new Date(`${date}T${end}`).toISOString(),
  };
}

const blank = {
  code: '',
  name: '',
  category: 'OTHER',
  pricingModel: 'PER_USE',
  priceCents: '',
  unit: '',
  capacity: '',
  reservable: false,
  description: '',
};

export default function Amenities() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN');
  const canSell = hasRole('ADMIN', 'MANAGER', 'FRONT_DESK');
  // A promotion is a commercial decision, not property configuration — the
  // manager running a shoulder-season rate should not need an administrator
  // to type it in. Mirrors the MGMT guard on POST/PATCH /api/promo-codes;
  // gating it any tighter here would hide a form the API would accept anyway.
  const canManagePromos = hasRole('ADMIN', 'MANAGER');
  const toast = useToast();
  const confirm = useConfirm();
  const [facilities, setFacilities] = useState([]);
  const [catFilter, setCatFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [form, setForm] = useState(blank);
  const [edit, setEdit] = useState({}); // { [code]: pesos }
  // Which reading of the catalogue is on screen, and whether the add form has
  // replaced it. A string, not two booleans — 'open but no tab' is not a state
  // that should be expressible.
  const [amTab, setAmTab] = useState('catalog');
  const [addOpen, setAddOpen] = useState(false);
  // The catalogue and laundry are reference, not the day's work, so the panel
  // starts closed and the row is the booking desk until you ask for it.
  const [catalogOpen, setCatalogOpen] = useState(false);
  // Booking desk state. `bookMode` decides which fields show AND how the charge
  // settles, so it is one value rather than a pair of flags.
  const [bookMode, setBookMode] = useState('hotel');
  const [bookBusy, setBookBusy] = useState(false);
  const [inHouse, setInHouse] = useState([]);
  const [bookForm, setBookForm] = useState(() => {
    // The facility calendar links here with the cell the user clicked already
    // chosen. Read once, at mount, into the initial state — setting it from an
    // effect afterwards would flash the empty form and then overwrite anything
    // typed in that first frame.
    const q = new URLSearchParams(window.location.search);
    const date = q.get('date');
    return {
      facilityCode: q.get('facility') || '',
      stayId: '',
      guestName: '',
      guestPhone: '',
      // Only a real YYYY-MM-DD is honoured; a junk param must not put the desk
      // on an invalid date that the server then rejects.
      date: /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : localDay(new Date()),
      start: '09:00',
      end: '11:00',
      persons: 1,
      method: 'CASH',
    };
  });
  // Follows the booking form's date, which is localDay(new Date()) unless the
  // facility calendar linked here with one — arriving to book Saturday and
  // being shown Wednesday's schedule reads as the link having failed.
  //
  // localDay throughout, NOT toISOString().slice(0,10): at UTC+8 that returns
  // yesterday for the whole morning, so the schedule opened on the wrong day
  // until 08:00.
  const [schedDate, setSchedDate] = useState(() => bookForm.date);

  // A bar on the facility calendar links to the booking it draws, not just to
  // this page. Read once at mount: the highlight is a landing cue, so it must
  // not come back every time the schedule reloads.
  const [focusBookingId] = useState(() => new URLSearchParams(window.location.search).get('booking') || '');
  const focusRowRef = useRef(null);
  const didFocusRef = useRef(false);
  const [bookings, setBookings] = useState([]);

  // Laundry ticket — several garment lines charged as one folio line.
  const [laundryQty, setLaundryQty] = useState({}); // { [facilityCode]: qty }
  const [laundryGuest, setLaundryGuest] = useState('');
  const [laundryMethod, setLaundryMethod] = useState('CASH');

  // Reservation add-ons (extra pillows, airport transfer…) — a priced catalog
  // like Facility, managed from this same page instead of a separate settings
  // screen, so admins set every sellable extra's price in one place. `code`
  // is what guest-service's GuestPreference rows (a guest's standing
  // checklist) key against, so it's fixed at creation, not editable after.
  const [addOnCatalog, setAddOnCatalog] = useState([]);
  const [addOnEdit, setAddOnEdit] = useState({}); // { [code]: pesos }
  const [addOnForm, setAddOnForm] = useState({ code: '', label: '', priceCents: '' });

  const [addOnsLoaded, setAddOnsLoaded] = useState(false);
  async function loadAddOnCatalog() {
    try {
      const { data } = await api.get('/api/addon-catalog');
      setAddOnCatalog(data);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setAddOnsLoaded(true);
    }
  }
  async function createAddOnCatalogItem(e) {
    e.preventDefault();
    try {
      await api.post('/api/addon-catalog', {
        ...addOnForm,
        priceCents: pesosToCents(addOnForm.priceCents || 0),
      });
      toast.success(`Add-on ${addOnForm.code} created.`);
      setAddOnForm({ code: '', label: '', priceCents: '' });
      loadAddOnCatalog();
    } catch (err) {
      toast.error(errMsg(err));
    }
  }
  async function saveAddOnField(code, patch, label) {
    try {
      await api.patch(`/api/addon-catalog/${code}`, patch);
      toast.success(`${code} ${label}.`);
      loadAddOnCatalog();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function saveAddOnPrice(code) {
    const pesos = addOnEdit[code];
    if (pesos === undefined || pesos === '') return;
    await saveAddOnField(code, { priceCents: pesosToCents(pesos) }, 'price updated');
    setAddOnEdit((p) => {
      const n = { ...p };
      delete n[code];
      return n;
    });
  }
  async function toggleAddOnCatalogItem(item) {
    if (item.active) {
      const ok = await confirm({
        title: 'Deactivate add-on',
        message: `Are you sure you want to deactivate ${item.label}?`,
        detail:
          'It disappears from the guest checklist and reservation wizard. Guests who already have it checked keep it, and you can reactivate it later.',
        confirmLabel: 'Deactivate',
      });
      if (!ok) return;
    }
    saveAddOnField(item.code, { active: !item.active }, item.active ? 'deactivated' : 'activated');
  }

  // Promo codes — moved here from the room information editor: a promotion is
  // a commercial decision, not room configuration, and this is where every
  // other priced, guest-facing extra (facilities, add-ons) is already
  // managed. Auto-applies at booking time: NewReservation.jsx sends whatever
  // code the desk types, and reservation.routes.js's POST /reservations looks
  // it up here (GET /api/public/promo/:code) and discounts the total by
  // percentOff — nothing further to wire up, this is just the admin side.
  const [promos, setPromos] = useState([]);
  const [newPromo, setNewPromo] = useState({ code: '', percentOff: '', description: '' });

  const [promosLoaded, setPromosLoaded] = useState(false);
  async function loadPromos() {
    try {
      const { data } = await api.get('/api/promo-codes');
      setPromos(data);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setPromosLoaded(true);
    }
  }
  async function createPromo(e) {
    e.preventDefault();
    try {
      await api.post('/api/promo-codes', {
        code: newPromo.code,
        percentOff: Number(newPromo.percentOff),
        description: newPromo.description || undefined,
      });
      toast.success(`Promo ${newPromo.code.toUpperCase()} created.`);
      setNewPromo({ code: '', percentOff: '', description: '' });
      loadPromos();
    } catch (err) {
      toast.error(errMsg(err));
    }
  }
  async function togglePromo(code, active) {
    // Only deactivation asks. Turning a promo back on is harmless; turning it
    // off stops it working for every guest mid-booking.
    if (!active) {
      const ok = await confirm({
        title: 'Deactivate promo code',
        message: `Are you sure you want to deactivate ${code}?`,
        detail: 'Guests will no longer be able to apply this code. You can reactivate it later.',
        confirmLabel: 'Deactivate',
      });
      if (!ok) return;
    }
    try {
      await api.patch(`/api/promo-codes/${code}`, { active });
      loadPromos();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  const [facilitiesLoaded, setFacilitiesLoaded] = useState(false);
  const [bookingsLoaded, setBookingsLoaded] = useState(false);
  async function load() {
    try {
      const { data } = await api.get('/api/facilities');
      setFacilities(data);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setFacilitiesLoaded(true);
    }
  }
  async function loadBookings(d = schedDate) {
    try {
      const { data } = await api.get(`/api/facility-bookings?from=${d}T00:00:00&to=${d}T23:59:59`);
      setBookings(data);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBookingsLoaded(true);
    }
  }

  useEffect(() => {
    load();
    loadAddOnCatalog();
    if (canManagePromos) loadPromos();
    // Who is checked in, for the hotel-guest branch of the booking form. Fails
    // quietly: a desk clerk taking a walk-in booking should not be blocked by
    // the stay service being down.
    api
      .get('/api/in-house')
      .then(({ data }) => setInHouse(data || []))
      .catch(() => setInHouse([]));
    // Arriving from the top bar's "Book a facility", or from the global search
    // bar with a specific facility already chosen (bookForm.facilityCode,
    // above): put the desk in view. The panel is already the first thing in
    // row 1, so this only matters on a short window where the overview strip
    // fills the fold.
    const q0 = new URLSearchParams(window.location.search);
    if (q0.get('book') === '1' || q0.get('facility')) {
      requestAnimationFrame(() =>
        document.querySelector('.bf-head')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      );
    }
  }, []);
  useEffect(() => {
    loadBookings();
  }, [schedDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once the row for the linked booking is on the page, put it in view. Depends
  // on `bookings` because the row does not exist until that fetch resolves.
  //
  // ...and `didFocusRef` is why it only happens the once. `bookings` is also
  // replaced by every live refresh on the facilities channels, so without the
  // latch anyone else's booking would re-run this and yank the reader's
  // viewport back to a row they had already scrolled away from.
  useEffect(() => {
    if (didFocusRef.current || !focusBookingId || !focusRowRef.current) return;
    didFocusRef.current = true;
    focusRowRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusBookingId, bookings]);
  useLiveRefresh(
    () => {
      load();
      loadBookings();
    },
    { channels: channels('facilities') }
  );

  async function cancelBooking(id) {
    const ok = await confirm({
      title: 'Cancel booking',
      message: 'Are you sure you want to cancel this booking?',
      detail: 'The slot is released for others. A cancelled booking cannot be un-cancelled.',
      confirmLabel: 'Cancel booking',
      cancelLabel: 'Keep booking',
    });
    if (!ok) return;
    try {
      await api.patch(`/api/facility-bookings/${id}`, { status: 'CANCELLED' });
      toast.success('Booking cancelled.');
      loadBookings();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  // ── Booking a facility ────────────────────────────────────────────────────
  // Only reservable, active spaces can be booked by time slot — the server
  // rejects anything else with "walk-in only", so offering it here would be
  // offering a guaranteed error.
  const bookable = useMemo(() => facilities.filter((f) => f.reservable && f.active), [facilities]);
  const bookFacility = useMemo(
    () => bookable.find((f) => f.code === bookForm.facilityCode) || null,
    [bookable, bookForm.facilityCode]
  );
  // Advisory only. `total()` mirrors the server's pricing so the desk can quote
  // before committing, but the booking endpoint prices the slot itself and is
  // the authority — this number is never sent.
  const bookPreview = useMemo(() => {
    if (!bookFacility) return 0;
    const { startAt, endAt } = bookWindow(bookForm);
    return total(bookFacility, { persons: Number(bookForm.persons) || 1, startAt, endAt });
  }, [bookFacility, bookForm]);

  async function submitBooking(e) {
    e.preventDefault();
    if (!bookFacility) return toast.error('Pick a facility.');
    const { startAt, endAt } = bookWindow(bookForm);
    if (!startAt || !endAt) return toast.error('Pick a date and a time range.');
    if (new Date(endAt) <= new Date(startAt)) return toast.error('The end time must be after the start.');

    const stay = bookMode === 'hotel' ? inHouse.find((s) => s.id === bookForm.stayId) : null;
    if (bookMode === 'hotel' && !stay) return toast.error('Pick the in-house guest.');

    setBookBusy(true);
    // `booking` and `settled` exist so a failure in step 2 can tell whether the
    // slot is being held with nothing charged against it (release it) or money
    // has already been posted (leave it, and say so).
    let booking = null;
    let settled = false;
    try {
      // Step 1 — the slot. Same call for both guest types: a booking is a
      // booking, and it is what holds the room against a double-sale.
      const { data: created } = await api.post('/api/facility-bookings', {
        facilityCode: bookFacility.code,
        guestName: bookMode === 'hotel' ? stay.guestName : bookForm.guestName || 'Walk-in',
        guestPhone: bookMode === 'walkin' ? bookForm.guestPhone || undefined : undefined,
        startAt,
        endAt,
        persons: Number(bookForm.persons) || 1,
      });
      booking = created;

      if (bookMode === 'hotel') {
        // Step 2a — post to the stay's OPEN folio. No money moves now; it
        // settles at check-out with everything else on the room.
        const { data: folios } = await api.get(`/api/folios?stayId=${stay.id}`);
        const open = (folios || []).find((f) => f.status !== 'CLOSED');
        if (!open) {
          // The slot is held but nothing can be charged, and a silent unpaid
          // booking is worse than a loud one — say exactly what is missing.
          toast.error(`Booked, but ${stay.guestName} has no open folio to charge. Post it manually.`);
        } else {
          await api.post(`/api/folios/${open.id}/charges`, {
            description: `${bookFacility.name} — facility booking`,
            amountCents: booking.priceCents,
            quantity: 1,
            reference: booking.id,
            sourceSystem: 'AMENITIES',
          });
          settled = true;
          await api.patch(`/api/facility-bookings/${booking.id}`, { folioId: open.id });
          toast.success(`${bookFacility.name} booked for ${stay.guestName} — posted to their folio.`);
        }
      } else {
        // Step 2b — charge and collect now, on its own visitor folio. The sale
        // endpoint re-prices from inventory, so the amount cannot be forged.
        const { data } = await api.post('/api/folios/amenity-sale', {
          facilityCode: bookFacility.code,
          guestName: bookForm.guestName || 'Walk-in',
          persons: Number(bookForm.persons) || 1,
          startAt,
          endAt,
          method: bookForm.method,
          facilityBookingId: booking.id,
        });
        settled = true;
        toast.success(
          `${bookFacility.name} booked — ${formatPeso(Number(data.amountCents))} · folio ${data.folioNumber}`
        );
      }

      setBookForm((b) => ({ ...b, guestName: '', guestPhone: '', stayId: '', persons: 1 }));
      // The day and the month both changed; the calendar count is what tells
      // the next person the slot has gone.
      setSchedDate(bookForm.date);
      loadBookings(bookForm.date);
    } catch (err) {
      // The slot was taken in step 1 but the charge/payment in step 2 failed.
      // Left alone it stays booked with nothing paid, and the retry then fails
      // with "already booked" against the agent's own half-made booking.
      let released = false;
      if (booking && !settled) {
        released = await api
          .patch(`/api/facility-bookings/${booking.id}`, { status: 'CANCELLED' })
          .then(() => true)
          .catch(() => false);
        loadBookings(bookForm.date);
      }
      toast.error(
        booking && !settled
          ? `${errMsg(err)} ${released ? 'The slot was released, so you can try again.' : 'The slot is still held; cancel it from the bookings list.'}`
          : errMsg(err)
      );
    } finally {
      setBookBusy(false);
    }
  }

  // Divisible spaces list under their parent, so the hall's sections read as
  // part of it rather than as three unrelated rooms.
  const orderedFacilities = useMemo(() => {
    const parents = facilities.filter((f) => !f.parentCode);
    const byParent = new Map();
    for (const f of facilities.filter((x) => x.parentCode)) {
      if (!byParent.has(f.parentCode)) byParent.set(f.parentCode, []);
      byParent.get(f.parentCode).push(f);
    }
    const ordered = parents.flatMap((p) => [p, ...(byParent.get(p.code) || [])]);
    // A child whose parent is filtered out (e.g. inactive) must still appear.
    const seen = new Set(ordered.map((f) => f.code));
    return [...ordered, ...facilities.filter((f) => !seen.has(f.code))];
  }, [facilities]);

  // Derived from the data, not a hardcoded list, so a category added on the
  // server appears here without a frontend change.
  const catalogCategories = useMemo(
    () => [...new Set(facilities.map((f) => f.category).filter(Boolean))].sort(),
    [facilities]
  );

  // One chip per category the property actually has, with how many amenities
  // sit in it and how many of those can be booked. Derived from the data, like
  // catalogCategories above — a category added on the server appears here with
  // no frontend change.
  //
  // The colour is a stable hash of the category name rather than a lookup
  // table: a table would need editing every time someone invents a category,
  // and the chip would silently fall back to grey until they did.
  const categoryChips = useMemo(
    () =>
      catalogCategories.map((key) => {
        const inCat = facilities.filter((f) => f.category === key);
        let h = 0;
        for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 360;
        return {
          key,
          label: labelize(key),
          count: inCat.length,
          reservable: inCat.filter((f) => f.reservable && f.active).length,
          color: `hsl(${h} 55% 45%)`,
        };
      }),
    [catalogCategories, facilities]
  );

  const visibleFacilities = useMemo(
    () =>
      orderedFacilities.filter((f) => {
        if (catFilter && f.category !== catFilter) return false;
        if (activeFilter === 'active' && !f.active) return false;
        if (activeFilter === 'inactive' && f.active) return false;
        return true;
      }),
    [orderedFacilities, catFilter, activeFilter]
  );

  const laundryItems = useMemo(
    () => facilities.filter((f) => f.category === 'LAUNDRY' && f.active),
    [facilities]
  );
  const laundryLines = useMemo(
    () =>
      laundryItems
        .map((f) => ({ f, qty: Number(laundryQty[f.code] || 0) }))
        .filter((l) => Number.isInteger(l.qty) && l.qty > 0),
    [laundryItems, laundryQty]
  );
  const laundryTotalCents = useMemo(
    () => laundryLines.reduce((s, l) => s + l.f.priceCents * l.qty, 0),
    [laundryLines]
  );

  async function postLaundryTicket() {
    if (laundryLines.length === 0) return;
    try {
      const { data } = await api.post('/api/folios/laundry-sale', {
        items: laundryLines.map((l) => ({ facilityCode: l.f.code, qty: l.qty })),
        guestName: laundryGuest || undefined,
        method: laundryMethod,
      });
      toast.success(`Laundry ticket posted — ${formatPeso(data.totalCents)}.`);
      setLaundryQty({});
      setLaundryGuest('');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function createFacility(e) {
    e.preventDefault();
    try {
      await api.post('/api/facilities', {
        ...form,
        priceCents: pesosToCents(form.priceCents),
        capacity: form.capacity === '' ? null : Number(form.capacity),
      });
      toast.success(`Amenity ${form.code} created.`);
      setForm(blank);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function saveField(code, patch, label) {
    try {
      await api.patch(`/api/facilities/${code}`, patch);
      toast.success(`${code} ${label}.`);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  // Deactivating asks; activating does not. Turning an amenity off pulls it out
  // of the booking screens for everyone, which is the half worth pausing on.
  async function toggleFacility(f) {
    if (f.active) {
      const ok = await confirm({
        title: 'Deactivate amenity',
        message: `Are you sure you want to deactivate ${f.name || f.code}?`,
        detail:
          'It disappears from the sales and booking screens. Existing bookings are unaffected, and you can reactivate it later.',
        confirmLabel: 'Deactivate',
      });
      if (!ok) return;
    }
    saveField(f.code, { active: !f.active }, f.active ? 'deactivated' : 'activated');
  }
  async function savePrice(code) {
    const pesos = edit[code];
    if (pesos === undefined || pesos === '') return;
    await saveField(code, { priceCents: pesosToCents(pesos) }, 'price updated');
    setEdit((p) => {
      const n = { ...p };
      delete n[code];
      return n;
    });
  }

  return (
    <div>
      <div className="page-head">
        <div className="page-head-title">
          <h1>Amenities &amp; Facilities</h1>
        </div>
      </div>

      {/* OVERVIEW — what the property has, and the catalogue filter, in one
          full-width strip above everything that uses it. */}
      <div className="panel">
        <div className="panel-head">
          <h3>Overview</h3>
        </div>
        <div
          className="filter-board"
          data-tour="g-amenities-overview"
          role="group"
          aria-label="Filter the catalogue by category"
        >
          {categoryChips.map((c) => {
            const on = catFilter === c.key;
            return (
              <button
                key={c.key}
                type="button"
                className={`filter-chip${on ? ' is-on' : ''}`}
                aria-pressed={on}
                onClick={() => setCatFilter(on ? '' : c.key)}
                title={`${c.count} ${c.label.toLowerCase()}`}
              >
                <span className="filter-chip-dot" style={{ background: c.color }} />
                <span className="filter-chip-num">{c.count}</span>
                <span className="filter-chip-label">{c.label}</span>
                {c.reservable > 0 && <span className="filter-chip-code">{c.reservable} bookable</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Row 1 — the day's bookings beside the booking desk.
          The month calendar that used to sit here is gone: it cost the whole
          right column, which is where the booking form belongs. `am-row-stretch`
          makes the two columns equal height, so the bookings table grows to
          meet the form instead of ending halfway up it. */}
      <div className="am-row am-row-stretch">
        <div className="am-col-main">
          {canSell && (
            <div className="panel" data-tour="g-amenities-bookings">
              <div className="panel-head">
                <h3>Facility bookings</h3>
                <input
                  data-tour="g-amenities-date"
                  type="date"
                  value={schedDate}
                  onChange={(e) => setSchedDate(e.target.value)}
                  style={{ marginLeft: 'auto' }}
                />
              </div>
              {!bookingsLoaded ? (
                <SkeletonTableBlock rows={4} cols={7} label="Loading bookings" />
              ) : bookings.length === 0 ? (
                <EmptyState
                  kind="inbox"
                  title="No bookings for this date"
                  hint="Reservable amenities (halls, meeting rooms) booked for this day appear here."
                />
              ) : (
                <table style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>Facility</th>
                      <th>Time</th>
                      <th>Guest</th>
                      <th className="t-c">Persons</th>
                      <th className="t-n">Charge</th>
                      <th className="t-c">Status</th>
                      <th className="t-c">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bookings.map((b) => (
                      <tr
                        key={b.id}
                        ref={b.id === focusBookingId ? focusRowRef : null}
                        className={b.id === focusBookingId ? 'is-linked' : undefined}
                        style={{ opacity: b.status === 'CANCELLED' ? 0.5 : 1 }}
                      >
                        <td>{b.facility?.name || b.facilityId}</td>
                        <td>
                          {new Date(b.startAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                          –
                          {new Date(b.endAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </td>
                        <td>{b.guestName}</td>
                        <td className="t-c">{b.persons}</td>
                        <td className="t-n">
                          {formatPeso(b.priceCents)}
                          {b.folioId ? ' · paid' : ''}
                        </td>
                        <td className="t-c">
                          <span className={`badge ${b.status === 'CANCELLED' ? 'out' : 'clean'}`}>
                            {b.status}
                          </span>
                        </td>
                        <td className="t-actions">
                          {b.status === 'CONFIRMED' && (
                            <button className="small secondary" onClick={() => cancelBooking(b.id)}>
                              Cancel
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
        <div className="am-col-side">
          {/* Book a facility. This replaced "Visitor sale", which could only
              ever charge a walk-in: it opened a WALKIN folio and collected in
              full, so a guest already staying here had to be rung up as a
              stranger and pay twice at the desk. The booking is the same either
              way; only where the money lands differs. */}
          {canSell && (
            <div className="panel bf-panel" data-tour="g-amenities-book">
              <div className="bf-head">
                <h3>Book a facility</h3>
                <span className="muted bf-sub">
                  {bookable.length} bookable space{bookable.length === 1 ? '' : 's'}
                </span>
              </div>

              {bookable.length === 0 ? (
                <p className="muted se-note">
                  No reservable spaces yet. Mark an amenity <strong>Reservable</strong> in the catalogue to
                  book it by time slot.
                </p>
              ) : (
                <form className="bf-form" onSubmit={submitBooking}>
                  {/* Who it is for. The two branches take different fields and
                      settle differently, so the choice comes first rather than
                      being inferred from whichever box got filled in. */}
                  <div
                    className="seg"
                    role="tablist"
                    aria-label="Guest type"
                    data-tour="g-amenities-guesttype"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={bookMode === 'hotel'}
                      className={bookMode === 'hotel' ? 'is-on' : ''}
                      onClick={() => setBookMode('hotel')}
                    >
                      Hotel guest
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={bookMode === 'walkin'}
                      className={bookMode === 'walkin' ? 'is-on' : ''}
                      onClick={() => setBookMode('walkin')}
                    >
                      Non-hotel
                    </button>
                  </div>

                  <label>Facility</label>
                  <select
                    required
                    value={bookForm.facilityCode}
                    onChange={(e) => setBookForm((b) => ({ ...b, facilityCode: e.target.value }))}
                  >
                    <option value="">—</option>
                    {bookable.map((f) => (
                      <option key={f.code} value={f.code}>
                        {f.name} · {formatPeso(f.priceCents)} {labelize(f.pricingModel).toLowerCase()}
                      </option>
                    ))}
                  </select>

                  {bookMode === 'hotel' ? (
                    <>
                      <label>In-house guest</label>
                      <select
                        required
                        value={bookForm.stayId}
                        onChange={(e) => setBookForm((b) => ({ ...b, stayId: e.target.value }))}
                      >
                        <option value="">—</option>
                        {inHouse.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.guestName}
                            {s.roomNumber ? ' · room ' + s.roomNumber : ''}
                          </option>
                        ))}
                      </select>
                      {inHouse.length === 0 && (
                        <p className="muted se-note">Nobody is checked in right now.</p>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="row row-split">
                        <div>
                          <label>Guest name</label>
                          <input
                            required
                            value={bookForm.guestName}
                            onChange={(e) => setBookForm((b) => ({ ...b, guestName: e.target.value }))}
                          />
                        </div>
                        <div>
                          <label>Phone</label>
                          <input
                            value={bookForm.guestPhone}
                            onChange={(e) => setBookForm((b) => ({ ...b, guestPhone: e.target.value }))}
                          />
                        </div>
                      </div>
                      <label>Payment</label>
                      <select
                        value={bookForm.method}
                        onChange={(e) => setBookForm((b) => ({ ...b, method: e.target.value }))}
                      >
                        {METHODS.map((m) => (
                          <option key={m} value={m}>
                            {labelize(m)}
                          </option>
                        ))}
                      </select>
                    </>
                  )}

                  <label>Date</label>
                  <input
                    required
                    type="date"
                    value={bookForm.date}
                    onChange={(e) => setBookForm((b) => ({ ...b, date: e.target.value }))}
                  />
                  <div className="row row-split">
                    <div>
                      <label>From</label>
                      <input
                        required
                        type="time"
                        value={bookForm.start}
                        onChange={(e) => setBookForm((b) => ({ ...b, start: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label>To</label>
                      <input
                        required
                        type="time"
                        value={bookForm.end}
                        onChange={(e) => setBookForm((b) => ({ ...b, end: e.target.value }))}
                      />
                    </div>
                  </div>

                  <label>Persons{bookFacility?.capacity ? ' (max ' + bookFacility.capacity + ')' : ''}</label>
                  <input
                    type="number"
                    min="1"
                    max={bookFacility?.capacity || undefined}
                    value={bookForm.persons}
                    onChange={(e) => setBookForm((b) => ({ ...b, persons: e.target.value }))}
                  />

                  {/* The price the server will compute, shown before you commit
                      to it. Advisory only — the booking endpoint prices the slot
                      itself and is the authority. */}
                  {bookFacility && (
                    <div className="bf-total">
                      <span>Total</span>
                      <strong>{formatPeso(bookPreview)}</strong>
                    </div>
                  )}
                  <p className="muted se-note">
                    {bookMode === 'hotel'
                      ? 'Posted to the guest’s open folio — settled at check-out.'
                      : 'Charged and collected now on its own visitor folio.'}
                  </p>

                  <button className="btn-cta" disabled={bookBusy}>
                    {bookBusy ? 'Booking…' : bookMode === 'hotel' ? 'Book & post to folio' : 'Book & charge'}
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
      </div>

      {/* The catalogue, full width UNDER both — it is reference you open when
          setting a price, not something the desk needs beside it. */}
      {!catalogOpen ? (
        <button
          type="button"
          className="am-catalog-toggle"
          data-tour="g-amenities-catalog-toggle"
          onClick={() => setCatalogOpen(true)}
        >
          <Icon name="box" size={15} strokeWidth={2} />
          View Amenities Catalog, Add-ons &amp; Promo Codes
          <span className="muted">{facilities.length} amenities</span>
          <Icon name="chevron-down" size={15} strokeWidth={2} />
        </button>
      ) : (
        <div className="panel">
          <div className="panel-head">
            {/* Catalogue and laundry are two readings of the same list — the
                  laundry ticket prices straight off the LAUNDRY rows — so they
                  are tabs of one panel rather than two panels repeating it. */}
            <button
              type="button"
              className="rt-add am-catalog-close"
              onClick={() => setCatalogOpen(false)}
              aria-label="Hide the catalogue"
              title="Hide"
            >
              <Icon name="chevron-up" size={15} strokeWidth={2.6} />
            </button>
            <div className="seg" role="tablist" aria-label="Catalogue view" data-tour="g-amenities-tabs">
              <button
                type="button"
                role="tab"
                aria-selected={amTab === 'catalog'}
                className={amTab === 'catalog' ? 'is-on' : ''}
                onClick={() => {
                  setAmTab('catalog');
                  setAddOpen(false);
                }}
              >
                Catalog
              </button>
              {canSell && laundryItems.length > 0 && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={amTab === 'laundry'}
                  className={amTab === 'laundry' ? 'is-on' : ''}
                  onClick={() => {
                    setAmTab('laundry');
                    setAddOpen(false);
                  }}
                >
                  Laundry
                </button>
              )}
              {canSell && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={amTab === 'addons'}
                  className={amTab === 'addons' ? 'is-on' : ''}
                  onClick={() => {
                    setAmTab('addons');
                    setAddOpen(false);
                  }}
                >
                  Add-ons
                </button>
              )}
              {canManagePromos && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={amTab === 'promos'}
                  className={amTab === 'promos' ? 'is-on' : ''}
                  onClick={() => {
                    setAmTab('promos');
                    setAddOpen(false);
                  }}
                >
                  Promo Codes
                </button>
              )}
            </div>
            {!addOpen && amTab === 'catalog' && (
              <div className="filter-bar" data-tour="g-amenities-filters">
                <label className="filter-inline">
                  <span>Category</span>
                  <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
                    <option value="">All categories</option>
                    {catalogCategories.map((c) => (
                      <option key={c} value={c}>
                        {labelize(c)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="filter-inline">
                  <span>Show</span>
                  <select value={activeFilter} onChange={(e) => setActiveFilter(e.target.value)}>
                    <option value="">All</option>
                    <option value="active">Active only</option>
                    <option value="inactive">Inactive only</option>
                  </select>
                </label>
                <span className="filter-count">
                  {visibleFacilities.length} of {orderedFacilities.length}
                </span>
              </div>
            )}
            {((amTab === 'promos' && canManagePromos) ||
              (amTab !== 'laundry' && amTab !== 'promos' && isAdmin)) && (
              <button
                type="button"
                className="rt-add"
                style={{ marginLeft: 'auto' }}
                onClick={() => setAddOpen((v) => !v)}
                aria-expanded={addOpen}
                aria-label={
                  addOpen
                    ? `Close the add-${amTab === 'addons' ? 'add-on' : amTab === 'promos' ? 'promo' : 'amenity'} form`
                    : `Add ${amTab === 'addons' ? 'an add-on' : amTab === 'promos' ? 'a promo code' : 'an amenity'}`
                }
                title={
                  addOpen
                    ? 'Close'
                    : amTab === 'addons'
                      ? 'Add add-on'
                      : amTab === 'promos'
                        ? 'Add promo code'
                        : 'Add amenity'
                }
              >
                <Icon name={addOpen ? 'x' : 'plus'} size={15} strokeWidth={2.6} />
              </button>
            )}
          </div>

          {addOpen && amTab === 'promos' ? (
            <form onSubmit={createPromo}>
              <div className="row row-split">
                <div>
                  <label>Code</label>
                  <input
                    required
                    value={newPromo.code}
                    onChange={(e) => setNewPromo({ ...newPromo, code: e.target.value.toUpperCase() })}
                  />
                </div>
                <div>
                  <label>% off</label>
                  <input
                    required
                    type="number"
                    min="1"
                    max="100"
                    value={newPromo.percentOff}
                    onChange={(e) => setNewPromo({ ...newPromo, percentOff: e.target.value })}
                  />
                </div>
              </div>
              <div className="row">
                <div>
                  <label>Description</label>
                  <input
                    value={newPromo.description}
                    onChange={(e) => setNewPromo({ ...newPromo, description: e.target.value })}
                  />
                </div>
                <div className="row-action">
                  <button>Add promo</button>
                </div>
              </div>
            </form>
          ) : addOpen && amTab === 'addons' ? (
            <form onSubmit={createAddOnCatalogItem}>
              <div className="row">
                <div>
                  <label>Code</label>
                  <input
                    required
                    value={addOnForm.code}
                    onChange={(e) =>
                      setAddOnForm({ ...addOnForm, code: e.target.value.toUpperCase().replace(/\s+/g, '_') })
                    }
                  />
                </div>
                <div>
                  <label>Label</label>
                  <input
                    required
                    value={addOnForm.label}
                    onChange={(e) => setAddOnForm({ ...addOnForm, label: e.target.value })}
                  />
                </div>
                <div>
                  <label>Price (₱)</label>
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0"
                    value={addOnForm.priceCents}
                    onChange={(e) => setAddOnForm({ ...addOnForm, priceCents: e.target.value })}
                  />
                </div>
                <div className="row-action">
                  <button>Create add-on</button>
                </div>
              </div>
            </form>
          ) : addOpen ? (
            <form onSubmit={createFacility}>
              <div className="row">
                <div>
                  <label>Code</label>
                  <input
                    required
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                  />
                </div>
                <div>
                  <label>Name</label>
                  <input
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div>
                  <label>Category</label>
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {labelize(c)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Pricing model</label>
                  <select
                    value={form.pricingModel}
                    onChange={(e) => setForm({ ...form, pricingModel: e.target.value })}
                  >
                    {MODELS.map((m) => (
                      <option key={m} value={m}>
                        {labelize(m)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Price (₱)</label>
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.priceCents}
                    onChange={(e) => setForm({ ...form, priceCents: e.target.value })}
                  />
                </div>
                <div>
                  <label>Unit label</label>
                  <input
                    value={form.unit}
                    placeholder="e.g. day pass"
                    onChange={(e) => setForm({ ...form, unit: e.target.value })}
                  />
                </div>
                <div>
                  <label>Capacity</label>
                  <input
                    type="number"
                    min="0"
                    value={form.capacity}
                    onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                  />
                </div>
                {/* `ed-check` gives this the same small box and inline label as
                  the editor's toggles, instead of a 36px square from the global
                  input rule with its caption wrapping beside it. */}
                <div className="row-action">
                  <label className="ed-check">
                    <input
                      type="checkbox"
                      checked={form.reservable}
                      onChange={(e) => setForm({ ...form, reservable: e.target.checked })}
                    />
                    <span>Reservable (time-slot)</span>
                  </label>
                </div>
                {/* The action is the last cell of the field row, level with the
                  inputs rather than a block underneath them. */}
                <div className="row-action">
                  <button>Create amenity</button>
                </div>
              </div>
            </form>
          ) : amTab === 'promos' ? (
            !promosLoaded ? (
              <SkeletonTableBlock rows={4} cols={4} label="Loading promo codes" />
            ) : promos.length === 0 ? (
              <EmptyState
                kind="search"
                title="No promo codes yet"
                hint="Use the + button above to add one."
              />
            ) : (
              <div className="rt-list">
                {promos.map((p) => (
                  <div key={p.code} className="rt-item" style={{ opacity: p.active ? 1 : 0.55 }}>
                    <div className="rt-head">
                      <span className="rt-name">{p.code}</span>
                      <span className="rt-rate">{p.percentOff}% off</span>
                    </div>
                    <div className="rt-meta">{p.description || 'No description'}</div>
                    <div className="rt-edit">
                      <button
                        className={`small secondary${p.active ? '' : ' outline-success'}`}
                        onClick={() => togglePromo(p.code, !p.active)}
                      >
                        {p.active ? 'Deactivate' : 'Activate'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : amTab === 'addons' ? (
            !addOnsLoaded ? (
              <SkeletonTableBlock rows={4} cols={4} label="Loading add-ons" />
            ) : addOnCatalog.length === 0 ? (
              <EmptyState
                kind="search"
                title="No add-ons in the catalog yet"
                hint={isAdmin ? 'Use the + button above to add one.' : 'Ask an admin to add one.'}
              />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Label</th>
                    <th className="t-n">Price</th>
                    <th className="t-c">Active</th>
                    {isAdmin && <th className="t-c">Admin</th>}
                  </tr>
                </thead>
                <tbody>
                  {addOnCatalog.map((o) => (
                    <tr key={o.code} style={{ opacity: o.active ? 1 : 0.5 }}>
                      <td>{o.code}</td>
                      <td>{o.label}</td>
                      <td className="t-n">{formatPeso(o.priceCents)}</td>
                      <td className="t-c">{o.active ? '✓' : '✗'}</td>
                      {isAdmin && (
                        <td className="t-c">
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              style={{ width: 100 }}
                              placeholder={centsToPesos(o.priceCents).toFixed(2)}
                              value={addOnEdit[o.code] ?? ''}
                              onChange={(e) => setAddOnEdit((p) => ({ ...p, [o.code]: e.target.value }))}
                            />
                            <button
                              className="small secondary outline-success"
                              disabled={addOnEdit[o.code] === undefined || addOnEdit[o.code] === ''}
                              onClick={() => saveAddOnPrice(o.code)}
                            >
                              Save Price
                            </button>
                            <button
                              className={`small ${o.active ? 'danger' : 'secondary'}`}
                              onClick={() => toggleAddOnCatalogItem(o)}
                            >
                              {o.active ? 'Deactivate' : 'Activate'}
                            </button>
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : amTab === 'laundry' ? (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Priced per piece. Enter how many of each garment; the whole ticket posts as one charge.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Garment</th>
                    <th className="t-n">Price / piece</th>
                    <th className="t-c">Pieces</th>
                    <th className="t-n">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {laundryItems.map((f) => {
                    const qty = Number(laundryQty[f.code] || 0);
                    return (
                      <tr key={f.code}>
                        <td>{f.name.replace(/^Laundry\s*—\s*/, '')}</td>
                        <td className="t-n">{formatPeso(f.priceCents)}</td>
                        <td className="t-c">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            style={{ width: 80 }}
                            value={laundryQty[f.code] ?? ''}
                            onChange={(e) => setLaundryQty((p) => ({ ...p, [f.code]: e.target.value }))}
                          />
                        </td>
                        <td className="t-n">
                          {qty > 0 ? formatPeso(f.priceCents * qty) : <span className="muted">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
                <div>
                  <label>Visitor name (optional)</label>
                  <input value={laundryGuest} onChange={(e) => setLaundryGuest(e.target.value)} />
                </div>
                <div>
                  <label>Payment method</label>
                  <select value={laundryMethod} onChange={(e) => setLaundryMethod(e.target.value)}>
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {labelize(m)}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1, textAlign: 'right', fontWeight: 600 }}>
                  Ticket total: {formatPeso(laundryTotalCents)}
                </div>
                <div>
                  <button onClick={postLaundryTicket} disabled={laundryLines.length === 0}>
                    Post laundry ticket
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              {!facilitiesLoaded ? (
                <SkeletonTableBlock rows={8} cols={6} label="Loading amenities" />
              ) : facilities.length === 0 ? (
                <EmptyState kind="inbox" title="No amenities yet" />
              ) : visibleFacilities.length === 0 ? (
                <EmptyState
                  kind="search"
                  title="No amenities match those filters"
                  hint="Clear the category or status filter to see more."
                />
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Name</th>
                      <th>Category</th>
                      <th>Pricing</th>
                      <th className="t-n">Price</th>
                      <th className="t-c">Bookable</th>
                      <th className="t-c">Active</th>
                      {isAdmin && <th className="t-c">Admin</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleFacilities.map((f) => (
                      <tr key={f.code} style={{ opacity: f.active ? 1 : 0.5 }}>
                        <td>{f.code}</td>
                        <td style={{ paddingLeft: f.parentCode ? 28 : undefined }}>
                          {f.parentCode && <span className="muted">└ </span>}
                          {f.name}
                        </td>
                        <td>{f.category.replace('_', ' ')}</td>
                        <td>{f.pricingModel.replace('PER_', 'per ').toLowerCase()}</td>
                        <td className="t-n">
                          {formatPeso(f.priceCents)} {f.unit || ''}
                        </td>
                        <td className="t-c">{f.reservable ? '✓' : '—'}</td>
                        <td className="t-c">{f.active ? '✓' : '✗'}</td>
                        {isAdmin && (
                          // The group is an inline-flex span INSIDE the cell, not a
                          // flex `td`: `display:flex` on a table cell drops it out of
                          // the table's own layout, so that column no longer shared
                          // the row height or the column width with anything else.
                          <td className="t-c">
                            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                style={{ width: 100 }}
                                placeholder={centsToPesos(f.priceCents).toFixed(2)}
                                value={edit[f.code] ?? ''}
                                onChange={(e) => setEdit((p) => ({ ...p, [f.code]: e.target.value }))}
                              />
                              {/* `small secondary`, matching every other in-table action
                            in the app (Users, Rooms). Full-size buttons stood a
                            third taller than the rows they sat in. */}
                              <button
                                className="small secondary outline-success"
                                disabled={edit[f.code] === undefined || edit[f.code] === ''}
                                onClick={() => savePrice(f.code)}
                              >
                                Save Price
                              </button>
                              <button
                                className={`small ${f.active ? 'danger' : 'secondary'}`}
                                onClick={() => toggleFacility(f)}
                              >
                                {f.active ? 'Deactivate' : 'Activate'}
                              </button>
                            </span>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
