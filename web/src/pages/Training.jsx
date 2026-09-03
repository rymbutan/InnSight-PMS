import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import api from '../api';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import EmptyState from '../components/EmptyState';
import { submitRun, ACTIVITY } from '../sim/trainingLog';

// Heavy sim code only downloads once a student actually starts something.
const InspectionShift = lazy(() => import('../sim/inspection/InspectionShift'));

const toneColor = (t) => (t === 'great' ? '#16a34a' : t === 'ok' ? '#d97706' : '#dc2626');

// ─────────────────────────────────────────────────────────────────────────────
// Training & Competency.
//
// This page used to be a read-only results table that told the student
// "Run the sim from the Housekeeping screen to add more" — a dead end on the page
// literally named Training in the nav, and the only page a learner would think to
// open. It now launches everything, and lists what each activity actually
// assesses so a student can choose what to practise rather than guessing.
//
// The rooms are practice fixtures, not live PMS rooms: launching from here trains
// and records a score but must NOT change a real room's housekeeping status. That
// side effect belongs to the Housekeeping screen, where you are working an actual
// room.
// ─────────────────────────────────────────────────────────────────────────────

const PRACTICE_ROOMS = {
  Standard: {
    id: 'practice-std',
    number: 'T-101',
    floor: 1,
    roomType: { name: 'Standard', maxOccupancy: 2, baseRate: 1500 },
  },
  Deluxe: {
    id: 'practice-dlx',
    number: 'T-109',
    floor: 1,
    roomType: { name: 'Deluxe', maxOccupancy: 3, baseRate: 4200 },
  },
  Suite: {
    id: 'practice-ste',
    number: 'T-113',
    floor: 1,
    roomType: { name: 'Suite', maxOccupancy: 4, baseRate: 7000 },
  },
  Presidential: {
    id: 'practice-pres',
    number: 'T-115',
    floor: 1,
    roomType: { name: 'Presidential', maxOccupancy: 4, baseRate: 14000 },
  },
};

// Each tier is inspected against a generated booking. The faults are injected
// per run and vary, so a tier cannot be beaten by memorising one room.
const TIERS = [
  { name: 'Standard', blurb: 'A twin-or-king room — the tier where bedding mismatches show up most.' },
  { name: 'Deluxe', blurb: 'Adds a living area, so blocked walkways and stray equipment matter more.' },
  { name: 'Suite', blurb: 'Adds a powder bath and wet bar — more stock and amenity counts to verify.' },
  {
    name: 'Presidential',
    blurb: 'Full corner suite: the widest set-up to check against the booking.',
  },
];

export default function Training() {
  const { hasRole } = useAuth();
  const isMgmt = hasRole('ADMIN', 'MANAGER');
  const toast = useToast();
  const [competency, setCompetency] = useState([]);
  const [results, setResults] = useState([]);
  const [launch, setLaunch] = useState(null); // { kind: 'INSPECTION', room, tier }

  async function load() {
    try {
      const reqs = [api.get('/api/training/results')];
      if (isMgmt) reqs.push(api.get('/api/training/competency'));
      const [res, comp] = await Promise.all(reqs);
      setResults(res.data || []);
      if (comp) setCompetency(comp.data || []);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  useEffect(() => {
    load(); /* eslint-disable-next-line */
  }, []);

  // No mid-run checkpointing here: an inspection is a single walk-through of one
  // room, not a 13-station shift, so there is nothing worth resuming. The
  // checkpoint helpers in trainingLog.js remain for the Housekeeping path.

  const close = () => setLaunch(null);

  async function finish(activity, label, items, okMsg) {
    const r = await submitRun({ activity, label, items });
    if (r.ok) toast.success(okMsg);
    else toast.error(`Run finished, but the result could not be saved (${r.reason}).`);
    setLaunch(null);
    load(); // refresh the tables so the new run appears immediately
  }

  const myBest = useMemo(() => {
    const by = {};
    for (const r of results) {
      // TURNOVER and INSPECTION are both room-tier activities, so their best
      // score is keyed by tier — matching how the server aggregates competency
      // (services/auth/src/routes/training.routes.js). Everything else keys by
      // activity name.
      const tierBased = !r.activity || r.activity === 'TURNOVER' || r.activity === 'INSPECTION';
      const k = tierBased ? r.roomTier : r.activity;
      if (!by[k] || r.scorePct > by[k]) by[k] = r.scorePct;
    }
    return by;
  }, [results]);

  return (
    <div>
      <h2>Training &amp; Competency</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {isMgmt
          ? 'Housekeeping training-sim results per staff member — who is trained and where the knowledge gaps are. You can also run any activity yourself below.'
          : 'Practise any activity below, then review your scores. Every run is recorded against your competency record.'}
      </p>

      {/* ── Launcher: room inspection case study, by tier ── */}
      <div className="panel">
        <h3>Inspect a room against its booking</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
          You are handed a booking and a room another attendant has already turned over. Walk it, compare it
          against the reservation on your clipboard, and flag what is wrong — naming the kind of fault, not
          just pointing at it. Some faults are only faults <em>for this booking</em>: two twin beds are fine
          until the guests arriving are a couple. Flagging something that is actually correct counts against
          you, so inspect, don’t sweep. Practice runs never change a real room’s status.
        </p>
        <div className="tr-launch-grid">
          {TIERS.map((t) => (
            <div key={t.name} className="tr-launch-card">
              <div className="tr-launch-head">
                <strong>{t.name}</strong>
                {myBest[t.name] != null && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    Best {myBest[t.name]}%
                  </span>
                )}
              </div>
              <p className="tr-launch-blurb">{t.blurb}</p>
              <p className="tr-launch-assesses">
                <strong>Assesses:</strong> Booking comprehension · amenity calculation · safety &amp; egress ·
                brand set-up standards · inspection precision
              </p>
              <div className="tr-launch-foot">
                <button
                  className="btn-primary"
                  style={{ marginLeft: 'auto' }}
                  onClick={() =>
                    setLaunch({ kind: 'INSPECTION', room: PRACTICE_ROOMS[t.name], tier: t.name })
                  }
                >
                  Start inspection
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {isMgmt && (
        <div className="panel">
          <h3>Staff competency</h3>
          {competency.length === 0 ? (
            <EmptyState
              kind="inbox"
              title="No training runs yet"
              hint="Staff results appear here once they complete a cleaning sim."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Staff</th>
                  <th>Runs</th>
                  <th>Avg best score</th>
                  <th>Room tiers practised</th>
                  <th>Other activities</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {competency.map((u) => (
                  <tr key={u.userId}>
                    <td>{u.userName || u.userId.slice(0, 8)}</td>
                    <td>{u.runs}</td>
                    <td>
                      <strong>{u.avgBest}%</strong>
                    </td>
                    <td>
                      {Object.entries(u.tiers)
                        .map(([t, s]) => `${t} ${s}%`)
                        .join(' · ') || '—'}
                    </td>
                    {/* Guest Services / Lost & Found used to be impossible to show here:
                      neither game persisted anything at all. */}
                    <td>
                      {Object.entries(u.activities || {})
                        .map(([a, s]) => `${a.replace('_', ' ').toLowerCase()} ${s}%`)
                        .join(' · ') || '—'}
                    </td>
                    <td>
                      <span className="badge" style={{ background: u.competent ? '#16a34a' : '#64748b' }}>
                        {u.competent ? 'Competent' : 'In training'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="panel">
        <h3>{isMgmt ? 'All training runs' : 'My training runs'}</h3>
        {results.length === 0 ? (
          <EmptyState
            kind="inbox"
            title="No runs recorded"
            hint="Start an activity above to log your first result."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                {isMgmt && <th>Staff</th>}
                <th>Activity</th>
                <th>Score</th>
                <th>Tasks</th>
                <th>Knowledge gaps</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  {isMgmt && <td>{r.userName || r.userId.slice(0, 8)}</td>}
                  <td>
                    {r.roomTier}
                    {r.activity && r.activity !== 'TURNOVER' && (
                      <span className="muted" style={{ fontSize: 11 }}>
                        {' '}
                        · activity
                      </span>
                    )}
                  </td>
                  <td>
                    <strong style={{ color: toneColor(r.tone) }}>{r.scorePct}%</strong>
                  </td>
                  <td>
                    {r.tasksAttempted}/{r.tasksTotal}
                  </td>
                  <td>
                    {r.knowledgeGaps > 0 ? <span style={{ color: '#dc2626' }}>{r.knowledgeGaps}</span> : '0'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {launch && (
        <Suspense
          fallback={
            <div className="cg-overlay">
              <div className="cg-window">
                <p style={{ padding: 24 }}>Loading…</p>
              </div>
            </div>
          }
        >
          {launch.kind === 'INSPECTION' && (
            <InspectionShift
              key={launch.tier}
              room={launch.room}
              // Practice rooms have no reservation, and the case must be
              // controlled anyway — the booking is generated.
              reservation={null}
              onExit={close}
              onComplete={(items) =>
                finish(ACTIVITY.INSPECTION, launch.tier, items, `${launch.tier} inspection recorded.`)
              }
            />
          )}
        </Suspense>
      )}
    </div>
  );
}
