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
