import { createContext, useCallback, useContext, useRef, useState } from 'react';
import Icon from './Icon';

const ToastCtx = createContext({ push: () => {} });

export function useToast() {
  return useContext(ToastCtx);
}

// Each kind's icon and the heading shown above the message. A caller passes
// only the message today, so the heading comes from the kind; `opts.title`
// overrides it, and `opts.actions` ([{ label, onClick }]) adds link-style
// buttons under the message.
const KINDS = {
  success: { icon: 'check-circle', title: 'Success' },
  info: { icon: 'info', title: 'Notice' },
  warning: { icon: 'alert-triangle', title: 'Warning' },
  error: { icon: 'x-circle', title: 'Error' },
};

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const timers = useRef({});

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const push = useCallback(
    (msg, opts = {}) => {
      const id = Math.random().toString(36).slice(2);
      const kind = KINDS[opts.kind] ? opts.kind : 'info';
      const ttl = opts.ttl ?? 3500;
      setItems((prev) => [...prev, { id, msg, kind, title: opts.title, actions: opts.actions }]);
      timers.current[id] = setTimeout(() => dismiss(id), ttl);
    },
    [dismiss]
  );

  const api = {
    push,
    success: (m, o) => push(m, { kind: 'success', ...o }),
    error: (m, o) => push(m, { kind: 'error', ttl: 6000, ...o }),
    info: (m, o) => push(m, { kind: 'info', ...o }),
    warning: (m, o) => push(m, { kind: 'warning', ttl: 5000, ...o }),
  };

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {items.map((t) => {
          const k = KINDS[t.kind];
          return (
            <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
              <div className="toast-head">
                <span className="toast-icon">
                  <Icon name={k.icon} size={16} strokeWidth={2} />
                </span>
                <span className="toast-title">{t.title || k.title}</span>
                <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                  <Icon name="x" size={14} />
                </button>
              </div>
              <div className="toast-body">{t.msg}</div>
              {t.actions?.length > 0 && (
                <div className="toast-actions">
                  {t.actions.map((a) => (
                    <button
                      key={a.label}
                      type="button"
                      onClick={() => {
                        a.onClick?.();
                        dismiss(t.id);
                      }}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

// Helper: extract a clean message from an axios error
export function errMsg(e) {
  return e?.response?.data?.error || e?.message || 'Something went wrong.';
}
