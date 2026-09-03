import { createContext, useCallback, useContext, useState } from 'react';

const ToastCtx = createContext({ push: () => {} });

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);

  const push = useCallback((msg, opts = {}) => {
    const id = Math.random().toString(36).slice(2);
    const kind = opts.kind || 'info';
    const ttl = opts.ttl ?? 3500;
    setItems((prev) => [...prev, { id, msg, kind }]);
    setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== id)), ttl);
  }, []);

  const api = {
    push,
    success: (m) => push(m, { kind: 'success' }),
    error: (m) => push(m, { kind: 'error', ttl: 6000 }),
    info: (m) => push(m, { kind: 'info' }),
  };

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toast-stack">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// Helper: extract a clean message from an axios error
export function errMsg(e) {
  return e?.response?.data?.error || e?.message || 'Something went wrong.';
}
