// The chrome shared by both calendar boards.
//
// Rooms x nights and facilities x days are the same object: a sticky first
// column, a day header carrying one number per column, a scroll region, and a
// legend. Only what goes in the cells differs — one draws draggable night
// blocks, the other draws time slots — so only the cells are duplicated.
//
// The row content is passed as `children` rather than rendered here because the
// grid is FLAT: every cell is a direct child of .cal2-grid, and the rows are
// `display: contents` wrappers. A shell that owned the rows would have to own
// the cells too, and then it would have to know about drag handles and lanes.

import { SkeletonList } from './Skeleton';
import Icon from './Icon';
import { localDay, addDays, startOfDay } from '../lib/date';

/**
 * @param {object} p
 * @param {Date[]} p.days               one local-midnight Date per column
 * @param {string} p.cornerLabel        heading for the sticky first column
 * @param {number} [p.railWidth]        px width of that column
 * @param {number} [p.colMin]           px minimum width of a day column
 * @param {(d: Date) => import('react').ReactNode} [p.daySub]
 *        the small third line under each date — occupancy here, booking counts there
 * @param {import('react').ReactNode} [p.toolbarExtra]  chips shown after the date range
 * @param {import('react').ReactNode} [p.hint]          right-aligned usage note
 * @param {import('react').ReactNode} [p.legend]        legend row, omitted when absent
 * @param {boolean} [p.loading]
 * @param {object} [p.gridRef]
 */
export default function CalendarShell({
  days,
  cornerLabel,
  railWidth = 140,
  colMin = 92,
  daySub,
  toolbarExtra,
  hint,
  legend,
  loading,
  gridRef,
  children,
}) {
  if (!days?.length) return null;
  const todayStr = localDay(new Date());
  const gridStyle = {
    gridTemplateColumns: `${railWidth}px repeat(${days.length}, minmax(${colMin}px, 1fr))`,
  };

  return (
    <div className="cal2">
      <div className="cal2-toolbar">
        <span className="cal2-month">
          {days[0].toLocaleDateString(undefined, { month: 'long', year: 'numeric' }).toUpperCase()}
        </span>
        <span className="muted" style={{ fontSize: 12 }}>
          {days[0].toLocaleDateString()} – {days[days.length - 1].toLocaleDateString()}
        </span>
        {loading && <span className="spinner" style={{ marginLeft: 8 }} />}
        {toolbarExtra}
        {hint && (
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>
            {hint}
          </span>
        )}
      </div>

      <div className="cal2-grid-wrap">
        <div className="cal2-grid" style={gridStyle} ref={gridRef}>
          <div className="cal2-corner" style={{ minWidth: railWidth }}>
            {cornerLabel}
          </div>
          {days.map((d) => {
            const key = localDay(d);
            return (
              <div
                key={key}
                className={`cal2-day ${key === todayStr ? 'today' : ''}`}
                style={{ minWidth: colMin }}
              >
                <div className="cal2-dow">{d.toLocaleDateString(undefined, { weekday: 'short' })}</div>
                <div className="cal2-dnum">{d.getDate()}</div>
                {daySub && <div className="cal2-occ">{daySub(d)}</div>}
              </div>
            );
          })}
          {loading ? (
            <div style={{ gridColumn: '1 / -1', padding: 14 }}>
              <SkeletonList rows={8} label="Loading calendar" />
            </div>
          ) : (
            children
          )}
        </div>
      </div>

      {legend && <div className="cal2-legend">{legend}</div>}
    </div>
  );
}

/** The date controls, shared so both boards step by the same week. */
export function CalendarNav({ startDate, setStartDate }) {
  return (
    <>
      <button className="secondary" onClick={() => setStartDate(addDays(startDate, -7))}>
        <Icon name="chevron-left" size={14} style={{ marginRight: 4 }} />
        Prev week
      </button>
      <button className="secondary" onClick={() => setStartDate(startOfDay(new Date()))}>
        Today
      </button>
      <button className="secondary" onClick={() => setStartDate(addDays(startDate, 7))}>
        Next week
        <Icon name="chevron-right" size={14} style={{ marginLeft: 4 }} />
      </button>
    </>
  );
}
