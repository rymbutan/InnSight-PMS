import { createContext, useCallback, useContext, useRef, useState } from 'react';
import Modal from './Modal';
import Icon from './Icon';

// One confirmation dialog for the whole app, exposed as `const confirm = useConfirm()`.
//
// Destructive actions were guarded by the browser's window.confirm(), which is
// an OS dialog: it ignores the app's theme entirely, cannot say which item is
// about to go, offers no way to mark the action as destructive, and is
// suppressible per-site — so a user who ticks "don't show again" silently loses
// every safety prompt in the product.
//
// Usage — it returns a promise, so it reads like the blocking call it replaces:
//
//   if (!(await confirm({ message: 'Delete this room?' }))) return;
//
// Defaults are the delete case, since that is the common one.
const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  // Held in a ref, not in state: resolving must not depend on a re-render
  // having happened first.
  const resolver = useRef(null);

  const confirm = useCallback((opts = {}) => {
    setState({
      title: opts.title || 'Delete item',
      message: opts.message || 'Are you sure you want to delete this item?',
      detail: opts.detail || null,
      confirmLabel: opts.confirmLabel || 'Delete',
      cancelLabel: opts.cancelLabel || 'Cancel',
      // Destructive by default — every current caller is a deletion. Pass
      // danger:false for a merely-irreversible action that is not a delete.
      danger: opts.danger !== false,
    });
    return new Promise((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((answer) => {
    setState(null);
    resolver.current?.(answer);
    resolver.current = null;
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={!!state}
        // Escape and the backdrop both mean "no", never an accidental yes.
        onClose={() => settle(false)}
        title={state?.title || ''}
        width={420}
        footer={
          state ? (
            <>
              <button type="button" className="secondary" onClick={() => settle(false)}>
                {state.cancelLabel}
              </button>
              <button
                type="button"
                className={state.danger ? 'danger' : 'btn-primary'}
                onClick={() => settle(true)}
                autoFocus
              >
                {state.confirmLabel}
              </button>
            </>
          ) : null
        }
      >
        {state ? (
          <div className="confirm-body">
            <span className={`confirm-icon${state.danger ? ' is-danger' : ''}`}>
              <Icon name={state.danger ? 'trash' : 'info'} size={18} strokeWidth={1.9} />
            </span>
            <div>
              <div className="confirm-message">{state.message}</div>
              {state.detail ? <div className="confirm-detail">{state.detail}</div> : null}
            </div>
          </div>
        ) : null}
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ctx;
}
