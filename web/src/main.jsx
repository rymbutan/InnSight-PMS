import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './auth.jsx';
import { ToastProvider } from './components/Toast.jsx';
import { ConfirmProvider } from './components/ConfirmDialog.jsx';
import { ThemeProvider } from './theme.jsx';
import { installAutoHideScrollbars } from './lib/autoHideScrollbars';
import { applyCachedAccent } from './lib/accent';
import './styles.css';

// One document-level listener for the whole app, so panes mounted later are
// covered without each one wiring up its own handler.
installAutoHideScrollbars();

// Registered from the app rather than left for Vite to inject: sw.js lives in
// public/ untouched by the build (no bundling, no content hash), so the app
// shell can update it without a full deploy. Only the shell it caches can go
// stale this way — see sw.js's own header for why /api/* never can.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Installability is a bonus, not a requirement — a browser that
      // refuses registration (private mode, an old Safari) still gets the
      // full app, just without "Add to Home Screen".
    });
  });
}

// Paint the hotel's accent on the FIRST frame from the local cache. The
// authoritative value is fetched once signed in (see Layout), but without this
// a customised system would flash the shipped green on every reload.
applyCachedAccent();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <ToastProvider>
          <ConfirmProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ConfirmProvider>
        </ToastProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);
