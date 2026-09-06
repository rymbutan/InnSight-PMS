import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import EmptyState from '../components/EmptyState';
import { DonutChart } from '../components/Chart';

// Score tone. Tokens, not literals: the old #16a34a/#d97706/#dc2626 were
// mid-weight light-theme values measuring ~3.4:1 against the dark panel, so on
// dark the one number this table exists to show was the least readable thing on
// the page.
//
// The --text-* tier specifically, NOT --green/--warn/--danger. Those are fill
// colours: --warn is #f59e0b, which as text on a white panel is 2.15:1. A token
// being "the warning colour" does not make it a legible warning *word*.
const toneColor = (t) =>
  t === 'great' ? 'var(--text-success)' : t === 'ok' ? 'var(--text-warn)' : 'var(--text-danger)';

// ─────────────────────────────────────────────────────────────────────────────
// Training & Competency.
//
// A REPORTING page: staff competency and the run log. It does not launch
// anything.
//
// It used to carry a launcher that started an inspection against four practice
// fixture rooms (T-101/109/113/115). That was removed deliberately. Inspections
// are still launched from the Housekeeping screen, against a REAL room — which
// is the entry point that was always the more honest one, since the practice
// fixtures scored a student against a room that does not exist on the property.
// Nothing about scoring, submission or the competency aggregation changed; this
// page simply no longer starts runs, it reports them.
// ─────────────────────────────────────────────────────────────────────────────

export default function Training() {
  const { hasRole } = useAuth();
  const isMgmt = hasRole('ADMIN', 'MANAGER');
  const toast = useToast();
  const [competency, setCompetency] = useState([]);
  const [results, setResults] = useState([]);

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

  // Rank: highest average-best score first, then more runs as the tie-break —
  // two people on 100% are not equal if one has done eight inspections and the
  // other one. Sorted from a COPY; `competency` is render state and sorting it
  // in place would mutate what the table above is drawing from.
  const ranked = useMemo(
    () => [...competency].sort((a, b) => b.avgBest - a.avgBest || b.runs - a.runs),
    [competency]
  );

  // The chart answers a different question for each audience. A manager wants
  // the split of the workforce; a trainee has no workforce, so theirs is the
  // spread of their own scores.
  const donut = useMemo(() => {
    if (isMgmt) {
      const competent = competency.filter((u) => u.competent).length;
      const training = competency.length - competent;
      return {
        total: competency.length,
        segments: [
          { label: 'Competent', value: competent, color: 'var(--green)' },
          { label: 'In training', value: training, color: 'var(--warn)' },
        ].filter((s) => s.value > 0),
      };
    }
    const band = { great: 0, ok: 0, poor: 0 };
    // Banded off the same `tone` the score column is coloured by, so the slice
    // a run falls into always matches the colour of its row.
    for (const r of results) band[r.tone === 'great' || r.tone === 'ok' ? r.tone : 'poor'] += 1;
    return {
      total: results.length,
      segments: [
        { label: 'Strong', value: band.great, color: 'var(--green)' },
        { label: 'Passing', value: band.ok, color: 'var(--warn)' },
        { label: 'Needs work', value: band.poor, color: 'var(--danger)' },
      ].filter((s) => s.value > 0),
    };
  }, [isMgmt, competency, results]);

  return (
    <div>
      <h2>Training &amp; Competency</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {isMgmt
          ? 'Housekeeping training-sim results per staff member — who is trained and where the knowledge gaps are. Runs are recorded from the Hotel Map, where an inspection is started against a real room.'
          : 'Your recorded training results. Start an inspection from the Hotel Map; every run is scored against your competency record and appears here.'}
      </p>

      {/* Two columns: the tables are the record, the right rail is the summary
          read off it. Nothing here is fetched separately — rank and the chart
          are derived from the same two arrays the tables render, so a figure in
          the rail can never disagree with the row it came from. */}
      <div className="tr-grid">
        <div className="tr-main">
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
                      <th className="t-c">Runs</th>
                      <th className="t-c">Avg best score</th>
                      <th>Room tiers practised</th>
                      <th>Other activities</th>
                      <th className="t-c">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {competency.map((u) => (
                      <tr key={u.userId}>
                        <td>{u.userName || u.userId.slice(0, 8)}</td>
                        <td className="t-c">{u.runs}</td>
                        <td className="t-c">
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
                        <td className="t-c">
                          {/* Tokens, not literals: the flat #16a34a/#64748b pair kept
                          white text at 3.1:1 on dark. --green / --neutral-soft each
                          carry a dark-theme value, and the paired --on-* token is
                          what makes the label readable on top of whichever it is. */}
                          <span
                            className="badge"
                            style={{
                              background: u.competent ? 'var(--green)' : 'var(--neutral-soft)',
                              color: u.competent ? 'var(--on-green)' : 'var(--on-neutral-soft)',
                            }}
                          >
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
                hint="Open the Hotel Map and inspect a room to log your first result."
              />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    {isMgmt && <th>Staff</th>}
                    <th>Activity</th>
                    <th className="t-c">Score</th>
                    <th className="t-c">Tasks</th>
                    <th className="t-c">Knowledge gaps</th>
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
                      <td className="t-c">
                        <strong style={{ color: toneColor(r.tone) }}>{r.scorePct}%</strong>
                      </td>
                      <td className="t-c">
                        {r.tasksAttempted}/{r.tasksTotal}
                      </td>
                      <td className="t-c">
                        {r.knowledgeGaps > 0 ? (
                          <span style={{ color: 'var(--text-danger)' }}>{r.knowledgeGaps}</span>
                        ) : (
                          '0'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <aside className="tr-rail">
          {/* Rank — best score first. Only for management: a trainee seeing
              themselves placed against named colleagues is a leaderboard, and
              this is a competency record. */}
          {isMgmt && (
            <div className="panel">
              <h3>Rank</h3>
              {ranked.length === 0 ? (
                <p className="muted se-note">No runs to rank yet.</p>
              ) : (
                <ol className="rank-list">
                  {ranked.map((u, i) => (
                    <li key={u.userId} className="rank-row">
                      <span className={`rank-pos${i < 3 ? ` is-top${i + 1}` : ''}`}>{i + 1}</span>
                      <span className="rank-name" title={u.userName || u.userId}>
                        {u.userName || u.userId.slice(0, 8)}
                      </span>
                      <span className="rank-score">{u.avgBest}%</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          <div className="panel">
            <h3>{isMgmt ? 'Competency' : 'My scores'}</h3>
            {donut.total === 0 ? (
              <p className="muted se-note">Nothing scored yet.</p>
            ) : (
              <DonutChart segments={donut.segments} size={128} thickness={20} />
            )}
            <p className="muted se-note" style={{ marginTop: 10 }}>
              {isMgmt
                ? `${donut.total} staff with recorded runs.`
                : `${donut.total} run${donut.total === 1 ? '' : 's'} recorded.`}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
