import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api';
import { useToast, errMsg } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useAuth } from '../auth';
import { formatPeso, pesosToCents, centsToPesos } from '../lib/money';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { downloadAuthed } from '../lib/download';
import StatusPill from '../components/StatusPill';
import ActionsMenu from '../components/ActionsMenu';
import Modal from '../components/Modal';
import FilterPanel, { FilterField } from '../components/FilterPanel';
import Icon from '../components/Icon';
import Timeline from '../components/Timeline';
import { labelize } from '../lib/labels';
import { SOURCES, SOURCE_LABELS } from '../lib/reservationOptions';
import { paymentMethodGroups } from '../lib/paymentMethods';
import { planQuickEdit } from '../lib/quickEditPlan';
import { suggestedCancellationFeeCents } from '../lib/cancellationFee';

const TABS = ['Accommodations', 'Folio', 'Guest Details', 'Banking Details', 'Notes', 'Documents', 'Reservation Activity'];

export default function ReservationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { hasRole } = useAuth();
  // AUDITOR reaches this page for oversight (accommodation + reservation
  // detail), not to change the guest record — same reasoning Users.jsx
  // documents for its own role-gated controls: not offered at all to a role
  // that shouldn't have it, rather than shown and then rejected.
  const canEditGuest = hasRole('ADMIN', 'MANAGER', 'FRONT_DESK');
  const [res, setRes] = useState(null);
  const [activeTab, setActiveTab] = useState('Accommodations');
  const [showMore, setShowMore] = useState(false);
  const [folio, setFolio] = useState(null);
  const [folioTxns, setFolioTxns] = useState([]);
  const [notes, setNotes] = useState({ active: [], archived: [] });
  const [activity, setActivity] = useState([]);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [noShowOpen, setNoShowOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [quickEditOpen, setQuickEditOpen] = useState(false);
  const [stay, setStay] = useState(null);
  const [chargeCodes, setChargeCodes] = useState([]);

  async function load() {
    try {
      const { data } = await api.get(`/api/reservations/${id}`);
      setRes(data);
      const stayResp = await api.get(`/api/stays?reservationId=${id}`).catch(() => ({ data: [] }));
      const stayRow = Array.isArray(stayResp.data) ? stayResp.data[0] : null;
      setStay(stayRow);
      // Find folio for this reservation/stay
      const folioResp = await api.get(`/api/folios?stayId=${stayRow?.id || ''}`).catch(() => ({ data: [] }));
      const f = (folioResp.data || [])[0];
      if (f) {
        setFolio(f);
        const fr = await api.get(`/api/folios/${f.id}`).catch(() => ({ data: null }));
        setFolioTxns(fr.data?.transactions || []);
      }
      const cc = await api.get('/api/charge-codes').catch(() => ({ data: [] }));
      setChargeCodes(cc.data);
      const notesResp = await api.get(`/api/reservations/${id}/notes`).catch(() => ({ data: [] }));
      setNotes({
        active: (notesResp.data || []).filter((n) => !n.archivedAt),
        archived: (notesResp.data || []).filter((n) => n.archivedAt),
      });
      const actResp = await api.get(`/api/reservations/${id}/activity`).catch(() => ({ data: [] }));
      setActivity(actResp.data || []);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  useEffect(() => {
    load();
  }, [id]);
  // Live: reflect check-in/out, folio postings and status changes made elsewhere.
  // Live scope — one reservation: its own state, its stay's check-in/out, and its
  // folio balance.
  useLiveRefresh(load, { channels: channels('reservations', 'stays', 'folio') });

  if (!res)
    return (
      <div className="panel">
        <div className="loading-row">
          <span className="spinner" /> Loading reservation…
        </div>
      </div>
    );

  const nights =
    res.nights || Math.max(1, Math.round((new Date(res.checkOut) - new Date(res.checkIn)) / 86400000));
  const balanceCents = Number(res.totalEstimateCents || 0) - Number(res.depositCents || 0);
  const balanceDue = Math.max(0, balanceCents);

  async function doConfirm() {
    try {
      await api.post(`/api/reservations/${id}/confirm`);
      toast.success('Confirmed.');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function doSendConfirmationEmail() {
    try {
      const { data } = await api.post(`/api/reservations/${id}/send-confirmation-email`);
      toast.success(`Confirmation email sent to ${data.to}.`);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  // Admin/Manager only — server-enforced (services/reservation's
  // requireRole('ADMIN', 'MANAGER') on DELETE), and not even offered to a
  // lower-tier role here: the ActionsMenu item below is gated by the same
  // hasRole check, so it isn't visible for anyone the server would refuse.
  // Distinct from Cancel: this permanently ERASES the record (refused once a
  // real stay exists against it — see the server's own guard).
  async function doDelete() {
    const ok = await confirm({
      title: 'Delete reservation',
      message: `Permanently delete ${res.confirmationNumber || 'this reservation'}?`,
      detail: 'This cannot be undone. The booking, its notes, cards and documents are all erased.',
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/reservations/${id}`);
      toast.success('Reservation deleted.');
      navigate('/reservations');
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function doCheckIn() {
    try {
      await api.post('/api/check-in', {
        reservationId: id,
        guestId: res.guestId,
        guestName: res.guestName,
        assignedRoomId: res.assignedRoomId,
      });
      toast.success('Checked in.');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function doCheckOut() {
    if (!stay) return toast.error('No stay record yet.');
    try {
      // Settle the folio before departing: find the stay's open folio, read its
      // balance, and collect any outstanding amount, then close it.
      const { data: folios } = await api.get(`/api/folios?stayId=${stay.id}`);
      const open = (folios || []).find((f) => f.status !== 'CLOSED');
      let balanceCents = 0;
      if (open) {
        const { data: st } = await api.get(`/api/folios/${open.id}/statement`);
        balanceCents = Number(st.balanceCents || 0);
      }
      if (balanceCents > 0) {
        const method = prompt(
          `Outstanding balance: ${formatPeso(balanceCents)}.\nCollect payment to settle & check out — method? (CASH / CARD / GCASH / BANK)`,
          'CASH'
        );
        if (!method) return; // cancelled
        await api.post(`/api/folios/${open.id}/settle`, { method: method.trim().toUpperCase() });
        toast.success(`Settled ${formatPeso(balanceCents)} via ${method.trim().toUpperCase()}.`);
      } else {
        const ok = await confirm({
          title: 'Check out guest',
          message: `Check out ${res.guestName}?`,
          detail: 'No outstanding balance.',
          confirmLabel: 'Check out',
          danger: false,
        });
        if (!ok) return;
        if (open) await api.post(`/api/folios/${open.id}/settle`, {}); // close the zero-balance folio
      }
      await api.post(`/api/check-out/${stay.id}`);
      toast.success('Checked out.');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  // Was window.open, which sends no Authorization header — see lib/download.js.
  async function printReg() {
    if (!stay) return toast.error('No stay record yet.');
    try {
      await downloadAuthed(`/api/stays/${stay.id}/registration-card`, {
        filename: `registration-card-${stay.id}.pdf`,
      });
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="res-header">
        <div className="res-head-top">
          <div>
            <h1>{res.guestName || '(No name)'}</h1>
            <div className="res-conf">{res.confirmationNumber || res.id}</div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusPill status={res.status} />
            <ActionsMenu
              label="Select Guest Status"
              variant="secondary"
              items={[
                { label: 'Mark as VIP', onClick: () => toast.info('Coming soon.') },
                { label: 'Mark as Loyalty', onClick: () => toast.info('Coming soon.') },
              ]}
            />
            <ActionsMenu
              label="Actions"
              items={[
                res.status === 'PENDING' && { label: 'Confirm', onClick: doConfirm },
                ['CONFIRMED', 'PENDING'].includes(res.status) && { label: 'Check In', onClick: doCheckIn },
                ['IN_HOUSE', 'CHECKED_IN'].includes(res.status) && {
                  label: 'Check Out',
                  onClick: doCheckOut,
                },
                ['CONFIRMED', 'PENDING'].includes(res.status) &&
                  canEditGuest && {
                    label: 'Modify Dates / Quick Edit',
                    onClick: () => setQuickEditOpen(true),
                  },
                { label: 'Print Registration Card', onClick: printReg, disabled: !stay },
                // Matches the route's own guard: the template says "your reservation
                // is confirmed", which is only true once it actually has been.
                !['PENDING', 'CANCELLED', 'NO_SHOW'].includes(res.status) && {
                  label: 'Send Confirmation Email',
                  onClick: doSendConfirmationEmail,
                },
                { divider: true },
                ['CONFIRMED', 'PENDING'].includes(res.status) &&
                  hasRole('ADMIN', 'MANAGER', 'AUDITOR') && {
                    label: 'Mark No-Show',
                    onClick: () => setNoShowOpen(true),
                    danger: true,
                  },
                !['CANCELLED', 'CHECKED_OUT'].includes(res.status) && {
                  label: 'Cancel Reservation',
                  onClick: () => setCancelOpen(true),
                  danger: true,
                },
                // Not offered at all to a role the server would refuse anyway —
                // a visible-but-rejected button reads as broken, not showing it
                // reads as "not yours to do" (same reasoning Users.jsx documents
                // for its own role-gated controls).
                hasRole('ADMIN', 'MANAGER') && {
                  label: 'Delete Record',
                  onClick: doDelete,
                  danger: true,
                },
              ].filter(Boolean)}
            />
          </div>
        </div>

        <div className="res-head-fields">
          <div>
            <div className="res-field-label">Check-In</div>
            <div className="res-field-value">{new Date(res.checkIn).toLocaleDateString()}</div>
          </div>
          <div>
            <div className="res-field-label">Check-Out</div>
            <div className="res-field-value">{new Date(res.checkOut).toLocaleDateString()}</div>
          </div>
          <div>
            <div className="res-field-label">Nights</div>
            <div className="res-field-value">{nights}</div>
          </div>
          <div>
            <div className="res-field-label">Reservation Date</div>
            <div className="res-field-value">
              {res.createdAt ? new Date(res.createdAt).toLocaleDateString() : '—'}
            </div>
          </div>
          <div>
            <div className="res-field-label">Guests</div>
            <div className="res-field-value">
              {res.adults || 0} adult{(res.adults || 0) !== 1 ? 's' : ''}
              {res.children ? ` · ${res.children} child` : ''}
            </div>
          </div>
          <div>
            <div className="res-field-label">Source</div>
            <div className="res-field-value">{labelize(res.source) || 'Direct'}</div>
          </div>
          <div>
            <div className="res-field-label">Payment Type</div>
            <div className="res-field-value">{res.paymentType || '—'}</div>
          </div>
          <div>
            <div className="res-field-label">Rate Plan(s)</div>
            <div className="res-field-value">{res.ratePlan || 'Base Rate'}</div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div className="res-field-label">Balance Due</div>
            <div className={`res-balance ${balanceDue > 0 ? 'due' : 'zero'}`}>
              <Icon name={balanceDue > 0 ? 'alert-circle' : 'check-circle'} size={14} />{' '}
              {formatPeso(balanceCents)}
            </div>
          </div>
        </div>

        {showMore && (
          <div
            className="res-head-fields"
            style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}
          >
            <div>
              <div className="res-field-label">Origin</div>
              <div className="res-field-value">{res.origin || '—'}</div>
            </div>
            <div>
              <div className="res-field-label">Estimated Arrival Time</div>
              <div className="res-field-value">{res.expectedArrivalTime || 'Unknown'}</div>
            </div>
            {res.status === 'CANCELLED' && (
              <>
                <div>
                  <div className="res-field-label">Cancelation #</div>
                  <div className="res-field-value">{res.cancellationNumber || '—'}</div>
                </div>
                <div>
                  <div className="res-field-label">Cancelation Fee</div>
                  <div className="res-field-value">{formatPeso(res.cancellationFeeCents || 0)}</div>
                </div>
                <div>
                  <div className="res-field-label">Cancelation Reason</div>
                  <div className="res-field-value">{res.cancellationReason || '—'}</div>
                </div>
              </>
            )}
          </div>
        )}
        <div className="res-show-more">
          <button className="btn-ghost" onClick={() => setShowMore(!showMore)}>
            <Icon name={showMore ? 'chevron-up' : 'chevron-down'} size={12} style={{ marginRight: 4 }} />
            {showMore ? 'Show less' : 'Show more'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={activeTab === t ? 'active' : ''} onClick={() => setActiveTab(t)}>
            {t === 'Notes' ? `Notes (${notes.active.length})` : t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'Accommodations' && (
        <AccommodationsTab
          res={res}
          stay={stay}
          onQuickEdit={() => setQuickEditOpen(true)}
          navigate={navigate}
        />
      )}
      {activeTab === 'Folio' && (
        <FolioTab
          folio={folio}
          txns={folioTxns}
          onAddCharge={() => setChargeOpen(true)}
          onAddPayment={() => setPaymentOpen(true)}
          onRefund={() => setRefundOpen(true)}
        />
      )}
      {activeTab === 'Guest Details' && <GuestDetailsTab res={res} onSaved={load} canEdit={canEditGuest} />}
      {activeTab === 'Banking Details' && <CreditCardsTab reservationId={id} />}
      {activeTab === 'Notes' && <NotesTab notes={notes} reservationId={id} onChanged={load} />}
      {activeTab === 'Documents' && <DocumentsTab reservationId={id} />}
      {activeTab === 'Reservation Activity' && <ActivityTab activity={activity} />}

      {/* Modals */}
      <CancelModal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        reservationId={id}
        reservation={res}
        onDone={() => {
          setCancelOpen(false);
          load();
        }}
      />
      <NoShowModal
        open={noShowOpen}
        onClose={() => setNoShowOpen(false)}
        reservationId={id}
        onDone={() => {
          setNoShowOpen(false);
          load();
        }}
      />
      <ChargeModal
        open={chargeOpen}
        onClose={() => setChargeOpen(false)}
        folio={folio}
        chargeCodes={chargeCodes}
        onDone={() => {
          setChargeOpen(false);
          load();
        }}
      />
      <PaymentModal
        open={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        folio={folio}
        balanceCents={balanceDue}
        onDone={() => {
          setPaymentOpen(false);
          load();
        }}
      />
      <RefundModal
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        folio={folio}
        txns={folioTxns}
        onDone={() => {
          setRefundOpen(false);
          load();
        }}
      />
      <QuickEditModal
        open={quickEditOpen}
        onClose={() => setQuickEditOpen(false)}
        res={res}
        stay={stay}
        balanceCents={balanceDue}
        onDone={() => {
          setQuickEditOpen(false);
          load();
        }}
      />
    </div>
  );
}

/* ============= Tab components ============= */

function AccommodationsTab({ res, stay, onQuickEdit, navigate }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const total = formatPeso(res.totalEstimateCents);
  return (
    <div className="panel">
      <button className="btn-cta" style={{ marginBottom: 14 }} onClick={onQuickEdit}>
        <Icon name="pencil" size={14} style={{ marginRight: 6 }} />
        Edit Reservation
      </button>
      <table>
        <thead>
          <tr>
            <th>Res ID</th>
            <th>Type</th>
            <th className="t-c">Assignment</th>
            <th>Guest</th>
            <th>Arrival/Departure</th>
            <th className="t-c">Guests</th>
            <th className="t-c">Nights</th>
            <th className="t-n">Total</th>
            <th className="t-c">Occupied</th>
            <th className="t-c"></th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{res.confirmationNumber || res.id?.slice(0, 8)}</td>
            <td>{res.roomTypeCode}</td>
            <td className="t-c">{res.assignedRoomId || stay?.assignedRoomId || '—'}</td>
            <td>{res.guestName}</td>
            <td>
              {new Date(res.checkIn).toLocaleDateString()}{' '}
              <Icon name="arrow-right" size={12} style={{ verticalAlign: 'middle', margin: '0 2px' }} />{' '}
              {new Date(res.checkOut).toLocaleDateString()}
            </td>
            <td className="t-c">
              <Icon name="user" size={12} /> {res.adults || 0} · <Icon name="users" size={12} />{' '}
              {res.children || 0}
            </td>
            <td className="t-c">
              {res.nights ||
                Math.max(1, Math.round((new Date(res.checkOut) - new Date(res.checkIn)) / 86400000))}
            </td>
            <td className="t-n">{total}</td>
            <td className="t-c">
              {stay && stay.status === 'CHECKED_IN' ? (
                <Icon name="check" size={16} color="var(--green)" />
              ) : (
                <Icon name="x" size={16} color="var(--muted)" />
              )}
            </td>
            <td className="t-c" style={{ position: 'relative' }}>
              <button className="icon" onClick={() => setMenuOpen(!menuOpen)} aria-label="More actions">
                <Icon name="more-vertical" size={14} />
              </button>
              {menuOpen && (
                <div className="actions-pop right" style={{ top: 30 }}>
                  <button
                    className="actions-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onQuickEdit();
                    }}
                  >
                    Quick Edit
                  </button>
                  <button
                    className="actions-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onQuickEdit();
                    }}
                  >
                    Edit Price
                  </button>
                  <button
                    className="actions-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onQuickEdit();
                    }}
                  >
                    Edit Reservation
                  </button>
                  <button
                    className="actions-item"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate('/calendar');
                    }}
                  >
                    View on Calendar
                  </button>
                </div>
              )}
            </td>
          </tr>
        </tbody>
      </table>
      {/* Moved here from the reservation header's "Show more" section — this
          is a fact about the STAY (what the guest needs once they're in the
          room), not about the booking record itself, so it belongs on the
          stay-details tab rather than buried in the reservation summary. */}
      <div style={{ marginTop: 16 }}>
        <div className="res-field-label">Special Requests</div>
        <div className="res-field-value">{res.specialRequests || '—'}</div>
      </div>
    </div>
  );
}

function FolioTab({ folio, txns, onAddCharge, onAddPayment, onRefund }) {
  if (!folio) {
    return (
      <div className="panel">
        <div className="loading-row">No folio yet — folio is created automatically on check-in.</div>
      </div>
    );
  }
  const totalDebit = txns.reduce((s, t) => s + (t.type === 'CHARGE' ? Number(t.amountCents) : 0), 0);
  const totalCredit = txns.reduce((s, t) => s + (t.type === 'PAYMENT' ? Number(t.amountCents) : 0), 0);

  return (
    <div className="folio-layout">
      <div className="folio-list">
        <div className="folio-list-item active">
          <span>{folio.folioNumber || 'Folio 1'}</span>
          {/* Inherits the row's colour instead of forcing white. The row is
              `background: var(--accent); color: var(--on-accent)`, and --on-accent
              is dark ink under data-theme="dark" — so a hard-coded white pencil
              sat on a light-green row and all but disappeared. */}
          <button className="icon" style={{ color: 'inherit' }} aria-label="Edit folio">
            <Icon name="pencil" size={12} />
          </button>
        </div>
        <button className="folio-add">
          <Icon name="plus" size={12} style={{ marginRight: 4 }} /> ADD FOLIO
        </button>
      </div>
      <div>
        <div className="folio-actions">
          <ActionsMenu
            label="Add/Refund Payment"
            variant="cta"
            items={[
              { label: 'Add Payment', onClick: onAddPayment },
              { label: 'Refund Payment', onClick: onRefund },
            ]}
          />
          <ActionsMenu
            label="Add/Adjust Charge"
            variant="cta"
            items={[
              { label: 'Add Charge', onClick: onAddCharge },
              { label: 'Add Adjustment', onClick: onAddCharge },
            ]}
          />
        </div>
        <FilterPanel defaultOpen={false}>
          <FilterField label="From">
            <input type="date" />
          </FilterField>
          <FilterField label="To">
            <input type="date" />
          </FilterField>
          <FilterField label="Description">
            <input placeholder="Multiple" />
          </FilterField>
          <FilterField label="Transactions">
            <select>
              <option>POSTED</option>
              <option>VOIDED</option>
            </select>
          </FilterField>
        </FilterPanel>
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>Service Date</th>
                <th>Reservation ID</th>
                <th>Date/Time</th>
                <th>Name</th>
                <th className="t-c">Room</th>
                <th>Type</th>
                <th>Notes</th>
                <th className="t-c">Quantity</th>
                <th className="t-n">Debit</th>
                <th className="t-n">Credit</th>
                <th className="t-c"></th>
              </tr>
            </thead>
            <tbody>
              {txns.length === 0 ? (
                <tr>
                  <td colSpan={11} className="loading-row">
                    None available
                  </td>
                </tr>
              ) : (
                txns.map((t) => (
                  <tr key={t.id}>
                    <td>{t.postedAt ? new Date(t.postedAt).toLocaleDateString() : '—'}</td>
                    <td>{folio.stayId?.slice(0, 10)}</td>
                    <td>{t.postedAt ? new Date(t.postedAt).toLocaleString() : '—'}</td>
                    <td>{t.postedBy || '—'}</td>
                    <td className="t-c">{t.roomNumber || 'N/A'}</td>
                    <td>{t.chargeCode || (t.type === 'PAYMENT' ? 'Payment' : 'Charge')}</td>
                    <td>{t.note || '—'}</td>
                    <td className="t-c">{t.quantity || 1}</td>
                    <td className="t-n">{t.type === 'CHARGE' ? formatPeso(t.amountCents) : ''}</td>
                    <td className="t-n">{t.type === 'PAYMENT' ? formatPeso(t.amountCents) : ''}</td>
                    <td className="t-actions">
                      <button className="icon" aria-label="More">
                        <Icon name="more-vertical" size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {txns.length > 0 && (
              <tfoot>
                <tr>
                  <td className="t-n" colSpan={8} style={{ fontWeight: 600 }}>
                    TOTAL
                  </td>
                  <td className="t-n" style={{ fontWeight: 600 }}>
                    {formatPeso(totalDebit)}
                  </td>
                  <td className="t-n" style={{ fontWeight: 600 }}>
                    {formatPeso(totalCredit)}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

function GuestDetailsTab({ res, onSaved, canEdit }) {
  const toast = useToast();
  const [g, setG] = useState({
    firstName: res.guestName?.split(' ')[0] || '',
    lastName: res.guestName?.split(' ').slice(1).join(' ') || '',
    email: res.guestEmail || '',
    phone: res.guestPhone || '',
    nationality: res.nationality || '',
    streetAddress: '',
    city: '',
    country: '',
    state: '',
    postal: '',
  });
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      const tasks = [];
      // Name/nationality live on the guest profile; email/phone live on the
      // reservation. Address fields have no backing column yet, so they are not
      // persisted here.
      if (res.guestId) {
        tasks.push(
          api.patch(`/api/guests/${res.guestId}`, {
            firstName: g.firstName,
            lastName: g.lastName,
            ...(g.nationality ? { nationality: g.nationality } : {}),
          })
        );
      }
      tasks.push(
        api.patch(`/api/reservations/${res.id}`, {
          guestEmail: g.email,
          guestPhone: g.phone,
        })
      );
      await Promise.all(tasks);
      toast.success('Guest info saved.');
      onSaved && onSaved();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not save guest info.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="panel">
      <h3>Guest information</h3>
      {/* AUDITOR reaches this tab for oversight, not to change the record —
          disabled inputs rather than hiding the tab, so the information is
          still there to read. */}
      <div className="row">
        <div>
          <label>First name</label>
          <input
            value={g.firstName}
            disabled={!canEdit}
            onChange={(e) => setG({ ...g, firstName: e.target.value })}
          />
        </div>
        <div>
          <label>Last name</label>
          <input
            value={g.lastName}
            disabled={!canEdit}
            onChange={(e) => setG({ ...g, lastName: e.target.value })}
          />
        </div>
        <div>
          <label>Email</label>
          <input value={g.email} disabled={!canEdit} onChange={(e) => setG({ ...g, email: e.target.value })} />
        </div>
        <div>
          <label>Phone</label>
          <input value={g.phone} disabled={!canEdit} onChange={(e) => setG({ ...g, phone: e.target.value })} />
        </div>
      </div>
      <h3 style={{ marginTop: 18 }}>Guest address</h3>
      <div className="row">
        <div>
          <label>Street address</label>
          <input
            value={g.streetAddress}
            disabled={!canEdit}
            onChange={(e) => setG({ ...g, streetAddress: e.target.value })}
          />
        </div>
        <div>
          <label>City</label>
          <input value={g.city} disabled={!canEdit} onChange={(e) => setG({ ...g, city: e.target.value })} />
        </div>
        <div>
          <label>Country</label>
          <input
            value={g.country}
            disabled={!canEdit}
            onChange={(e) => setG({ ...g, country: e.target.value })}
          />
        </div>
        <div>
          <label>State/Region</label>
          <input value={g.state} disabled={!canEdit} onChange={(e) => setG({ ...g, state: e.target.value })} />
        </div>
        <div>
          <label>Postal/ZIP</label>
          <input
            value={g.postal}
            disabled={!canEdit}
            onChange={(e) => setG({ ...g, postal: e.target.value })}
          />
        </div>
      </div>
      {canEdit && (
        <button className="btn-cta" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
    </div>
  );
}

const CARD_BRANDS = ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER', 'JCB', 'OTHER'];
const EMPTY_CARD = { brand: 'VISA', last4: '', expMonth: '', expYear: '', cardholderName: '' };

// A card ON FILE as a booking guarantee, never a real card number — this is a
// non-PCI-compliant capstone build, so only what a receipt already shows
// (brand, last 4, expiry, cardholder name) is ever collected or stored. See
// the ReservationCard model comment in the reservation service.
function CreditCardsTab({ reservationId }) {
  const toast = useToast();
  const [cards, setCards] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_CARD);
  const [saving, setSaving] = useState(false);

  async function load() {
    const { data } = await api.get(`/api/reservations/${reservationId}/cards`).catch(() => ({ data: [] }));
    setCards(data || []);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservationId]);

  async function submit() {
    setSaving(true);
    try {
      await api.post(`/api/reservations/${reservationId}/cards`, {
        ...form,
        expMonth: Number(form.expMonth),
        expYear: Number(form.expYear),
      });
      toast.success('Card added.');
      setForm(EMPTY_CARD);
      setAdding(false);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(cardId) {
    try {
      await api.delete(`/api/reservations/${reservationId}/cards/${cardId}`);
      toast.success('Card removed.');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  return (
    <div className="folio-layout">
      <div className="folio-list">
        <div className="folio-list-item" onClick={() => setAdding((a) => !a)}>
          <Icon name="plus" size={12} style={{ marginRight: 6 }} />
          <span>ADD CARD</span>
        </div>
      </div>
      <div className="panel">
        {adding && (
          <div
            style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, alignItems: 'flex-end' }}
          >
            <div>
              <label>Brand</label>
              <select value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })}>
                {CARD_BRANDS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>Last 4 digits</label>
              <input
                maxLength={4}
                value={form.last4}
                onChange={(e) => setForm({ ...form, last4: e.target.value.replace(/\D/g, '') })}
                style={{ width: 70 }}
              />
            </div>
            <div>
              <label>Exp. month</label>
              <input
                type="number"
                min="1"
                max="12"
                value={form.expMonth}
                onChange={(e) => setForm({ ...form, expMonth: e.target.value })}
                style={{ width: 70 }}
              />
            </div>
            <div>
              <label>Exp. year</label>
              <input
                type="number"
                min={new Date().getFullYear()}
                value={form.expYear}
                onChange={(e) => setForm({ ...form, expYear: e.target.value })}
                style={{ width: 90 }}
              />
            </div>
            <div>
              <label>Cardholder name</label>
              <input
                value={form.cardholderName}
                onChange={(e) => setForm({ ...form, cardholderName: e.target.value })}
              />
            </div>
            <button className="btn-primary" onClick={submit} disabled={saving}>
              {saving ? 'Saving…' : 'Add Card'}
            </button>
          </div>
        )}

        {cards === null ? (
          <div className="loading-row">
            <span className="spinner" /> Loading…
          </div>
        ) : cards.length === 0 ? (
          <div className="muted" style={{ textAlign: 'center', padding: 36 }}>
            No banking details on file.
            <br />
            <small>Capstone build — a masked guarantee only, never a full card number.</small>
          </div>
        ) : (
          cards.map((c) => (
            <div
              key={c.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: 12,
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div>
                <strong>{c.brand}</strong> •••• {c.last4} — exp {String(c.expMonth).padStart(2, '0')}/
                {c.expYear}
                <div className="muted" style={{ fontSize: 12 }}>
                  {c.cardholderName}
                </div>
              </div>
              <button className="secondary small" onClick={() => remove(c.id)}>
                Remove
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function NotesTab({ notes, reservationId, onChanged }) {
  const [activeKind, setActiveKind] = useState('Active');
  const [text, setText] = useState('');
  const toast = useToast();
  const list = activeKind === 'Active' ? notes.active : notes.archived;
  async function submit() {
    if (!text.trim()) return;
    try {
      await api.post(`/api/reservations/${reservationId}/notes`, { body: text });
      setText('');
      toast.success('Note added.');
      onChanged();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function setArchived(noteId, archived) {
    try {
      await api.patch(`/api/reservations/${reservationId}/notes/${noteId}`, { archived });
      toast.success(archived ? 'Note archived.' : 'Note restored.');
      onChanged();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  return (
    <div className="folio-layout">
      <div className="folio-list">
        <div
          className={`folio-list-item ${activeKind === 'Active' ? 'active' : ''}`}
          onClick={() => setActiveKind('Active')}
        >
          <span>Active Notes</span>
          <span>({notes.active.length})</span>
        </div>
        <div
          className={`folio-list-item ${activeKind === 'Archived' ? 'active' : ''}`}
          onClick={() => setActiveKind('Archived')}
        >
          <span>Archived Notes</span>
          <span>({notes.archived.length})</span>
        </div>
      </div>
      <div className="panel">
        {activeKind === 'Active' && (
          <>
            <textarea
              rows={3}
              placeholder="Type your note…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              style={{ marginBottom: 10 }}
            />
            <div style={{ textAlign: 'right' }}>
              <button className="btn-primary" onClick={submit}>
                Submit Note
              </button>
            </div>
          </>
        )}
        <div style={{ marginTop: 16 }}>
          {list.length === 0 ? (
            <div className="loading-row">No notes available</div>
          ) : (
            list.map((n) => (
              <div key={n.id} style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <strong>{n.author || 'User'}</strong>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </div>
                <div>{n.body}</div>
                <div style={{ textAlign: 'right', marginTop: 6 }}>
                  <button
                    className="secondary small"
                    onClick={() => setArchived(n.id, activeKind === 'Active')}
                  >
                    {activeKind === 'Active' ? 'Archive' : 'Restore'}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      // dataURL looks like "data:application/pdf;base64,AAAA…" — only the part
      // after the comma is what the server's contentBase64 field expects.
      resolve(String(reader.result).split(',')[1] || '');
    };
    reader.readAsDataURL(file);
  });
}

function formatBytes(n) {
  const kb = n / 1024;
  return kb < 1024 ? `${kb.toFixed(0)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

function DocumentsTab({ reservationId }) {
  const toast = useToast();
  const [docs, setDocs] = useState(null);
  const [uploading, setUploading] = useState(false);

  async function load() {
    const { data } = await api
      .get(`/api/reservations/${reservationId}/documents`)
      .catch(() => ({ data: [] }));
    setDocs(data || []);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservationId]);

  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // lets the same file be picked again after removal
    if (!file) return;
    if (file.size > MAX_DOCUMENT_BYTES) {
      return toast.error(`File is too large — max ${formatBytes(MAX_DOCUMENT_BYTES)}.`);
    }
    setUploading(true);
    try {
      const contentBase64 = await readFileAsBase64(file);
      await api.post(`/api/reservations/${reservationId}/documents`, {
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        contentBase64,
      });
      toast.success('Document uploaded.');
      load();
    } catch (e2) {
      toast.error(errMsg(e2));
    } finally {
      setUploading(false);
    }
  }

  async function download(doc) {
    try {
      await downloadAuthed(`/api/reservations/${reservationId}/documents/${doc.id}/download`, {
        filename: doc.filename,
        openInTab: false,
      });
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function remove(docId) {
    try {
      await api.delete(`/api/reservations/${reservationId}/documents/${docId}`);
      toast.success('Document removed.');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  return (
    <div className="panel">
      <h3>Documents</h3>
      <div style={{ marginBottom: 16 }}>
        <label className="btn-primary" style={{ display: 'inline-block', cursor: 'pointer' }}>
          {uploading ? 'Uploading…' : 'Upload Document'}
          <input type="file" onChange={upload} disabled={uploading} style={{ display: 'none' }} />
        </label>
        <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>
          Guest IDs, signed registration cards, etc. — max {formatBytes(MAX_DOCUMENT_BYTES)}.
        </span>
      </div>

      {docs === null ? (
        <div className="loading-row">
          <span className="spinner" /> Loading…
        </div>
      ) : docs.length === 0 ? (
        <div className="muted" style={{ textAlign: 'center', padding: 24 }}>
          No documents uploaded yet.
        </div>
      ) : (
        docs.map((d) => (
          <div
            key={d.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: 12,
              borderBottom: '1px solid var(--border)',
            }}
          >
            <div>
              <strong>{d.filename}</strong>
              <div className="muted" style={{ fontSize: 12 }}>
                {formatBytes(d.sizeBytes)} · {new Date(d.uploadedAt).toLocaleString()}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="secondary small" onClick={() => download(d)}>
                Download
              </button>
              <button className="secondary small" onClick={() => remove(d.id)}>
                Remove
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function ActivityTab({ activity }) {
  // Reverse to show chronologically (oldest first) on the timeline so the
  // story reads top-to-bottom like a traditional booking lifecycle.
  const ordered = [...activity].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return (
    <div className="panel">
      <h3>Booking lifecycle</h3>
      <Timeline items={ordered} />
    </div>
  );
}

/* ============= Modals ============= */

function CancelModal({ open, onClose, reservationId, reservation, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('Guest request');
  const [feePesos, setFeePesos] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Pre-fill with a terms-based suggestion each time the modal opens, rather
  // than leaving it blank — staff can still edit it (e.g. for the Terms &
  // Conditions' own Force Majeure/PAGASA carve-out).
  useEffect(() => {
    if (!open || !reservation) return;
    const suggested = suggestedCancellationFeeCents({
      totalEstimateCents: reservation.totalEstimateCents,
      checkIn: reservation.checkIn,
      method: reservation.paymentType,
      isNonRefundable: reservation.isNonRefundable,
    });
    setFeePesos(centsToPesos(suggested));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reservation?.id]);
  async function submit() {
    setBusy(true);
    try {
      await api.post(`/api/reservations/${reservationId}/cancel`, {
        reason,
        cancellationFeeCents: pesosToCents(feePesos),
        note,
      });
      toast.success('Reservation cancelled.');
      onDone();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cancel reservation"
      footer={
        <>
          <button className="secondary" onClick={onClose}>
            Back
          </button>
          <button className="danger" onClick={submit} disabled={busy}>
            {busy ? '…' : 'Confirm Cancellation'}
          </button>
        </>
      }
    >
      <label>Cancellation reason</label>
      <select value={reason} onChange={(e) => setReason(e.target.value)} style={{ marginBottom: 12 }}>
        <option>Guest request</option>
        <option>Wrong dates</option>
        <option>Force majeure</option>
        <option>Hotel error</option>
        <option>Payment failed</option>
        <option>Other</option>
      </select>
      <label>Cancellation fee (₱)</label>
      <input
        type="number"
        min="0"
        step="0.01"
        value={feePesos}
        onChange={(e) => setFeePesos(e.target.value)}
        placeholder="0.00"
        style={{ marginBottom: 12 }}
      />
      <label>Note (visible on reservation)</label>
      <textarea
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. cancelled within policy -V"
      />
    </Modal>
  );
}

function NoShowModal({ open, onClose, reservationId, onDone }) {
  const toast = useToast();
  const [feePesos, setFeePesos] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await api.post(`/api/no-show/${reservationId}`, {
        feeCents: pesosToCents(feePesos),
      });
      toast.success('Marked as no-show.');
      onDone();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Mark as No-Show"
      footer={
        <>
          <button className="secondary" onClick={onClose}>
            Back
          </button>
          <button className="danger" onClick={submit} disabled={busy}>
            {busy ? '…' : 'Confirm No-Show'}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Posts an optional no-show fee to the folio and sets reservation status to NO_SHOW.
      </p>
      <label>No-show fee (₱)</label>
      <input
        type="number"
        min="0"
        step="0.01"
        value={feePesos}
        onChange={(e) => setFeePesos(e.target.value)}
        placeholder="0.00"
      />
    </Modal>
  );
}

function ChargeModal({ open, onClose, folio, chargeCodes, onDone }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const grouped = useMemo(() => {
    const out = {};
    for (const c of chargeCodes) {
      const k = c.category || 'Other';
      if (!out[k]) out[k] = [];
      out[k].push(c);
    }
    return out;
  }, [chargeCodes]);
  async function submit() {
    if (!folio) return toast.error('No folio.');
    setBusy(true);
    try {
      await api.post(`/api/folios/${folio.id}/charges`, {
        chargeCode: code,
        amountCents: pesosToCents(amount),
        quantity: qty,
        note,
      });
      toast.success('Charge posted.');
      onDone();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add charge"
      footer={
        <>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-cta" onClick={submit} disabled={busy || !code || !amount}>
            {busy ? '…' : 'Post Charge'}
          </button>
        </>
      }
    >
      <label>Charge code</label>
      <select value={code} onChange={(e) => setCode(e.target.value)} style={{ marginBottom: 12 }}>
        <option value="">— select —</option>
        {Object.entries(grouped).map(([cat, list]) => (
          <optgroup key={cat} label={cat}>
            {list.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <div className="row">
        <div>
          <label>Quantity</label>
          <input type="number" min="1" value={qty} onChange={(e) => setQty(Number(e.target.value))} />
        </div>
        <div>
          <label>Unit price (₱)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>
      <label>Notes</label>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
    </Modal>
  );
}

function PaymentModal({ open, onClose, folio, balanceCents, onDone }) {
  const toast = useToast();
  const [method, setMethod] = useState('CASH');
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open && balanceCents) setAmount((balanceCents / 100).toFixed(2));
  }, [open, balanceCents]);
  async function submit() {
    if (!folio) return toast.error('No folio.');
    setBusy(true);
    try {
      await api.post(`/api/folios/${folio.id}/payments`, {
        method,
        amountCents: pesosToCents(amount),
        reference: ref,
      });
      toast.success('Payment recorded.');
      onDone();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Take payment"
      footer={
        <>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-cta" onClick={submit} disabled={busy || !amount}>
            {busy ? '…' : 'Submit Payment'}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Outstanding balance: <strong>{formatPeso(balanceCents)}</strong>
      </p>
      <label>Payment method</label>
      <select value={method} onChange={(e) => setMethod(e.target.value)} style={{ marginBottom: 12 }}>
        {paymentMethodGroups().map((g) =>
          g.kind === 'group' ? (
            <optgroup key={g.label} label={g.label}>
              {g.methods.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          ) : (
            <option key={g.code} value={g.code}>
              {g.label}
            </option>
          )
        )}
      </select>
      <label>Amount (₱)</label>
      <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <label style={{ marginTop: 12 }}>Reference / receipt #</label>
      <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Optional" />
    </Modal>
  );
}

function RefundModal({ open, onClose, folio, txns, onDone }) {
  const toast = useToast();
  const payments = txns.filter((t) => t.type === 'PAYMENT' && Number(t.amountCents) > 0);
  const [pickedTxId, setPickedTxId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('Cancelled within policy');
  const [busy, setBusy] = useState(false);
  const picked = payments.find((p) => p.id === pickedTxId);
  async function submit() {
    if (!folio || !pickedTxId) return;
    setBusy(true);
    try {
      await api.post(`/api/folios/${folio.id}/refund`, {
        originalTxId: pickedTxId,
        amountCents: pesosToCents(amount),
        reason,
      });
      toast.success('Refund posted.');
      onDone();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Refund payment"
      footer={
        <>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="danger" onClick={submit} disabled={busy || !amount || !pickedTxId}>
            {busy ? '…' : 'Submit Refund'}
          </button>
        </>
      }
    >
      {payments.length === 0 ? (
        <p className="muted">No payments on this folio to refund.</p>
      ) : (
        <>
          <label>Original payment</label>
          {payments.map((p) => (
            <label
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 0',
                textTransform: 'none',
              }}
            >
              <input
                type="radio"
                name="pmt"
                checked={pickedTxId === p.id}
                onChange={() => {
                  setPickedTxId(p.id);
                  setAmount((Number(p.amountCents) / 100).toFixed(2));
                }}
                style={{ width: 'auto' }}
              />
              <span>
                {p.postedAt || p.createdAt ? new Date(p.postedAt || p.createdAt).toLocaleDateString() : '—'} ·{' '}
                {p.method || p.paymentMethod || 'Payment'} · {formatPeso(p.amountCents)}
              </span>
            </label>
          ))}
          <label style={{ marginTop: 12 }}>Refund amount (₱)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          {picked && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Max {formatPeso(picked.amountCents)}
            </div>
          )}
          <label style={{ marginTop: 12 }}>Reason</label>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option>Cancelled within policy</option>
            <option>Hotel error</option>
            <option>Wrong amount</option>
            <option>Goodwill</option>
            <option>Other</option>
          </select>
        </>
      )}
    </Modal>
  );
}

function QuickEditModal({ open, onClose, res, stay, onDone, balanceCents = 0 }) {
  const toast = useToast();

  // Every field the reservation header shows, so Quick Edit can correct the whole
  // summary strip instead of only the checkout date. All of these are columns the
  // reservation PATCH whitelist accepts.
  //
  // Deliberately NOT here:
  //   · Nights and Balance Due are derived (nights from the dates, balance from
  //     the folio) — shown read-only so the effect of a date edit is visible.
  //   · Reservation Date is `createdAt`, the audit record of when the booking was
  //     taken. Prisma owns it and the route does not accept it.
  const EMPTY_STAY = {
    checkIn: '',
    checkOut: '',
    adults: 1,
    children: 0,
    source: 'DIRECT',
    paymentType: '',
    depositPesos: '',
    ratePlan: '',
    origin: '',
    expectedArrivalTime: '',
    specialRequests: '',
  };
  const [form, setForm] = useState(EMPTY_STAY);

  // Guest details are editable here too: correcting a misspelled name meant
  // leaving the reservation for the Guests screen and finding the profile again.
  //
  // These four fields and no more, because they are exactly what the server
  // accepts — GUEST_EDITABLE in services/guest/src/routes/guest.routes.js
  // whitelists the patch and drops anything else. Email and phone are NOT on the
  // Guest model at all (contacts are a separate GuestContact table), so offering
  // them here would have been two inputs that silently saved nothing.
  const [guest, setGuest] = useState({
    firstName: '',
    lastName: '',
    nationality: '',
    vipLevel: 'NONE',
  });
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if (!res || !open) return;
    setForm({
      checkIn: res.checkIn?.slice(0, 10) || '',
      checkOut: res.checkOut?.slice(0, 10) || '',
      adults: res.adults ?? 1,
      children: res.children ?? 0,
      source: res.source || 'DIRECT',
      paymentType: res.paymentType || '',
      depositPesos: res.depositCents ? String(centsToPesos(res.depositCents)) : '',
      ratePlan: res.ratePlan || '',
      origin: res.origin || '',
      expectedArrivalTime: res.expectedArrivalTime || '',
      specialRequests: res.specialRequests || '',
    });
    // The reservation carries a single guestName; split it only to seed the
    // fields. The guest RECORD is the source of truth, so load it when there is
    // one and let it win.
    const [first = '', ...rest] = String(res.guestName || '')
      .trim()
      .split(/\s+/);
    setGuest({
      firstName: first,
      lastName: rest.join(' '),
      nationality: '',
      vipLevel: 'NONE',
    });
    if (res.guestId) {
      api
        .get(`/api/guests/${res.guestId}`)
        .then(({ data }) =>
          setGuest({
            firstName: data.firstName || '',
            lastName: data.lastName || '',
            nationality: data.nationality || '',
            vipLevel: data.vipLevel || 'NONE',
          })
        )
        .catch(() => {
          /* keep the values derived from the reservation */
        });
    }
  }, [res, open]);

  // Nights follows the dates the user is editing, not the saved reservation, so
  // the number moves as they pick. The server recomputes it the same way.
  const liveNights = useMemo(() => {
    const a = new Date(form.checkIn);
    const b = new Date(form.checkOut);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
    const n = Math.round((b - a) / 86400000);
    return n > 0 ? n : null;
  }, [form.checkIn, form.checkOut]);

  // What Save will actually do. See lib/quickEditPlan.js — the arrival branch is
  // subtle enough to be worth unit tests of its own.
  const plan = useMemo(() => planQuickEdit({ res: res || {}, stay, form }), [res, stay, form]);

  async function submit() {
    if (!res) return;
    if (plan.errors.length) {
      toast.error(plan.errors[0]);
      return;
    }

    setBusy(true);
    try {
      let guestSaved = false;

      // ── Guest details ──
      if (res.guestId) {
        const patch = {
          firstName: guest.firstName.trim(),
          lastName: guest.lastName.trim(),
          nationality: guest.nationality.trim() || null,
          vipLevel: guest.vipLevel,
        };
        if (!patch.firstName || !patch.lastName) {
          toast.error('First and last name are required.');
          return;
        }
        await api.patch(`/api/guests/${res.guestId}`, patch);
        guestSaved = true;
      }

      // ── Reservation fields ──
      // The patch carries only what moved. An unchanged date must not be echoed
      // back: the route re-holds inventory whenever it sees one, so resending
      // today's checkout would churn a hold for nothing.
      const patchedRes = Object.keys(plan.resPatch).length > 0;
      if (patchedRes) {
        await api.patch(`/api/reservations/${res.id}`, plan.resPatch);
      }

      // ── Keep the stay's expected checkout in step ──
      if (plan.extendTo && stay) {
        await api.post(`/api/stays/${stay.id}/extend`, { newCheckOut: plan.extendTo });
      }

      if (!patchedRes && !plan.extendTo && !guestSaved) {
        toast.info('No change.');
        return;
      }

      const datesMoved = Boolean(plan.resPatch.checkIn || plan.resPatch.checkOut || plan.extendTo);
      if (datesMoved) {
        toast.success(liveNights ? `Dates updated — now ${liveNights} night(s).` : 'Dates updated.');
      } else if (patchedRes) {
        toast.success('Reservation updated.');
      } else {
        toast.success('Guest details updated.');
      }
      onDone();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  if (!res) return null;

  // The strip anchors on the EARLIER of the saved and the edited check-in, so
  // pulling check-in forward keeps the whole range on screen.
  const origIn = new Date(res.checkIn);
  const editedIn = new Date(form.checkIn);
  const anchor = !Number.isNaN(editedIn.getTime()) && editedIn < origIn ? editedIn : origIn;
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(anchor);
    d.setDate(anchor.getDate() + i);
    return d;
  });
  const cur = new Date(res.checkOut);
  const selIn = Number.isNaN(editedIn.getTime()) ? origIn : editedIn;
  const sel = new Date(form.checkOut);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Quick Edit"
      // Wide enough for two-column fields plus the 14-day date strip.
      width={720}
      footer={
        <>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-cta" onClick={submit} disabled={busy}>
            {busy ? '…' : 'Save Updates'}
          </button>
        </>
      }
    >
      <div className="muted" style={{ marginTop: 0, marginBottom: 12 }}>
        {res.confirmationNumber} · {res.roomTypeCode}
      </div>

      {res.guestId ? (
        <>
          <h4 className="guest-sub" style={{ marginTop: 0 }}>
            Guest details
          </h4>
          <div className="row">
            <div>
              <label>First name</label>
              <input
                value={guest.firstName}
                onChange={(e) => setGuest({ ...guest, firstName: e.target.value })}
              />
            </div>
            <div>
              <label>Last name</label>
              <input
                value={guest.lastName}
                onChange={(e) => setGuest({ ...guest, lastName: e.target.value })}
              />
            </div>
          </div>
          <div className="row">
            <div>
              <label>Nationality</label>
              <input
                value={guest.nationality}
                onChange={(e) => setGuest({ ...guest, nationality: e.target.value })}
              />
            </div>
            <div>
              <label>VIP level</label>
              <select
                value={guest.vipLevel}
                onChange={(e) => setGuest({ ...guest, vipLevel: e.target.value })}
              >
                {['NONE', 'SILVER', 'GOLD', 'PLATINUM', 'BLACKLISTED'].map((v) => (
                  <option key={v} value={v}>
                    {labelize(v)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </>
      ) : null}

      <h4 className="guest-sub">Stay</h4>
      <div className="row">
        <div>
          <label>Check-in date</label>
          <input type="date" value={form.checkIn} onChange={set('checkIn')} disabled={plan.checkInLocked} />
          {plan.checkInLocked && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              The guest has checked in — check-in is fixed.
            </div>
          )}
        </div>
        <div>
          <label>Check-out date</label>
          <input type="date" value={form.checkOut} onChange={set('checkOut')} />
        </div>
      </div>
      <div className="row">
        <div>
          <label>Nights</label>
          <input value={liveNights ?? '—'} readOnly disabled />
        </div>
        <div>
          <label>Reservation date</label>
          <input
            value={res.createdAt ? new Date(res.createdAt).toLocaleDateString() : '—'}
            readOnly
            disabled
          />
        </div>
      </div>
      <div className="row">
        <div>
          <label>Adults</label>
          <input type="number" min="1" value={form.adults} onChange={set('adults')} />
        </div>
        <div>
          <label>Children</label>
          <input type="number" min="0" value={form.children} onChange={set('children')} />
        </div>
      </div>
      <div className="row">
        <div>
          <label>Source</label>
          <select value={form.source} onChange={set('source')}>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Origin</label>
          <input value={form.origin} onChange={set('origin')} placeholder="e.g. Booking.com" />
        </div>
      </div>
      <div className="row">
        <div>
          <label>Payment type</label>
          <select value={form.paymentType} onChange={set('paymentType')}>
            <option value="">—</option>
            {paymentMethodGroups().map((g) =>
              g.kind === 'group' ? (
                <optgroup key={g.label} label={g.label}>
                  {g.methods.map((m) => (
                    <option key={m.code} value={m.code}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              ) : (
                <option key={g.code} value={g.code}>
                  {g.label}
                </option>
              )
            )}
          </select>
        </div>
        <div>
          {/* A publicly-created booking (the guest portal's self-service
              widget) starts with no deposit at all — this is how staff record
              one, which the Mandatory Downpayment Constraint then requires
              before /confirm will move it out of PENDING. */}
          <label>Deposit amount (₱)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.depositPesos}
            onChange={set('depositPesos')}
            placeholder="Not yet recorded"
          />
        </div>
      </div>
      <div className="row">
        <div>
          <label>Rate plan</label>
          <input value={form.ratePlan} onChange={set('ratePlan')} placeholder="Base Rate" />
        </div>
      </div>
      <div className="row">
        <div>
          <label>Estimated arrival time</label>
          <input
            value={form.expectedArrivalTime}
            onChange={set('expectedArrivalTime')}
            placeholder="e.g. 14:00"
          />
        </div>
        <div>
          <label>Balance due</label>
          <input value={formatPeso(balanceCents)} readOnly disabled />
        </div>
      </div>
      <label>Special requests</label>
      <textarea
        rows={3}
        value={form.specialRequests}
        onChange={set('specialRequests')}
        placeholder="e.g. Honeymoon trip — please set the room up for a couple."
      />

      <div style={{ marginTop: 16, overflowX: 'auto' }}>
        <table style={{ minWidth: 600 }}>
          <thead>
            <tr>
              {days.map((d, i) => (
                <th key={i} style={{ textAlign: 'center', minWidth: 56, padding: 4 }}>
                  <div style={{ fontSize: 9, color: 'var(--muted)' }}>
                    {d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{d.getDate()}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {days.map((d, i) => {
                const inOriginal = d >= origIn && d < cur;
                const inSelected = d >= selIn && d < sel;
                return (
                  <td key={i} style={{ textAlign: 'center', padding: 6 }}>
                    <input type="checkbox" checked={inSelected} readOnly style={{ width: 'auto' }} />
                    {inOriginal && !inSelected && (
                      <div style={{ fontSize: 9, color: 'var(--danger)' }}>−</div>
                    )}
                    {!inOriginal && inSelected && (
                      <div style={{ fontSize: 9, color: 'var(--text-success)' }}>+</div>
                    )}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          Green (+) = added night, Red (−) = removed night.
        </div>
      </div>
    </Modal>
  );
}
