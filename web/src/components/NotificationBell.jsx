import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import { relativeTime } from '../lib/notifications';

// The feed arrives as a PROP rather than being subscribed here. Every call to
// useNotificationFeed opens its own SSE stream, and the on-screen pop-ups need
// the same events this does — so Layout holds the one subscription and hands
// the result to both. See components/NotificationPopups.jsx.
export default function NotificationBell({ feed }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('unread');
  const { unreadItems, readItems, unread, markAllRead, clearRead } = feed;
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  // Opening the panel deliberately does NOT mark everything read. With an
  // Unread tab it would empty the moment you looked at it, which is the one
  // thing that tab exists to prevent — marking read is now an explicit action.
  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) setTab(unread > 0 ? 'unread' : 'read');
  }

  const rows = tab === 'unread' ? unreadItems : readItems;

  return (
    <div className="notif-wrap" ref={wrapRef}>
      <button
        type="button"
        className="cb-icon-btn notif-btn"
        onClick={toggle}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        title="Notifications"
      >
        <Icon name="bell" size={18} />
        {unread > 0 && (
          <span className="notif-badge" aria-hidden="true">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="notif-pop" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <span className="notif-title">Notifications</span>
          </div>

          <div className="notif-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'unread'}
              className={`notif-tab${tab === 'unread' ? ' is-on' : ''}`}
              onClick={() => setTab('unread')}
            >
              Unread{unreadItems.length ? ` (${unreadItems.length})` : ''}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'read'}
              className={`notif-tab${tab === 'read' ? ' is-on' : ''}`}
              onClick={() => setTab('read')}
            >
              Read{readItems.length ? ` (${readItems.length})` : ''}
            </button>
          </div>

          {rows.length === 0 ? (
            <div className="notif-empty">
              <Icon name="bell" size={22} />
              <div>{tab === 'unread' ? 'Nothing unread.' : 'Nothing read yet.'}</div>
              <div className="notif-empty-sub">
                {tab === 'unread'
                  ? 'Activity across the hotel will appear here as it happens.'
                  : 'Notifications you mark as read are kept here.'}
              </div>
            </div>
          ) : (
            <div className="notif-list">
              {rows.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className={`notif-item${tab === 'unread' ? ' is-new' : ''}${n.to ? '' : ' is-static'}`}
                  onClick={() => {
                    if (!n.to) return;
                    setOpen(false);
                    navigate(n.to);
                  }}
                  disabled={!n.to}
                >
                  <span className="notif-item-icon">
                    <Icon name={n.icon} size={15} strokeWidth={1.9} />
                  </span>
                  <span className="notif-item-body">
                    <span className="notif-item-text">{n.text}</span>
                    {n.subject ? <span className="notif-item-sub">{n.subject}</span> : null}
                  </span>
                  <span className="notif-item-time">{relativeTime(n.at)}</span>
                </button>
              ))}
            </div>
          )}

          {/* ONE action, whose meaning follows the tab you are on. On Unread it
              marks everything read (nothing is destroyed); on Read it discards
              those rows. Unread items are never deleted by Clear — you cannot
              lose something you have not seen. */}
          <div className="notif-foot">
            {tab === 'unread' ? (
              <button
                type="button"
                className="notif-action"
                onClick={markAllRead}
                disabled={unreadItems.length === 0}
                title="Mark all as read"
              >
                <Icon name="check" size={14} strokeWidth={2.2} />
                Clear
              </button>
            ) : (
              <button
                type="button"
                className="notif-action is-danger"
                onClick={clearRead}
                disabled={readItems.length === 0}
                title="Delete read notifications"
              >
                <Icon name="trash" size={14} strokeWidth={1.9} />
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
