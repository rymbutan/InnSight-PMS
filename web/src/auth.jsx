import { createContext, useContext, useEffect, useState } from 'react';
import api from './api';
import { hydrateRoomLayouts } from './sim/layoutSync';
import { hydrateCategories } from './sim/inspection/categorySync';
import { chatDockStoreKey, notifsStoreKey } from './lib/messageStorageKeys';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('innsight_user') || 'null');
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(false);
  // The sections an admin has left visible to this account's roles. Fetched
  // rather than read off the token so that saving a layout takes effect on the
  // next navigation instead of at the next sign-in.
  const [sections, setSections] = useState(null);

  // The shared room layouts are fetched once per session. Every 3D consumer
  // reads them synchronously through getRoomPlan(), so they must be in place
  // before a room is opened — signing in is the earliest safe moment, and the
  // sim is several navigations away.
  useEffect(() => {
    if (!user) return;
    hydrateRoomLayouts();
    // The flag menu and grading both read the shared categories synchronously,
    // so they must be registered before an inspection opens. Both calls are
    // fail-soft: without them the app falls back to the committed layouts and
    // the six built-in categories, which is a working room, not a broken one.
    hydrateCategories();
  }, [user]);

  // Refreshed on sign-in and on every navigation (see refreshSections below), so
  // an admin saving a new layout reaches staff who are already signed in without
  // anybody having to log out. Fail-soft: a failure leaves `sections` null, which
  // hasSection reads as "show everything this role allows".
  useEffect(() => {
    if (!user) {
      setSections(null);
      return;
    }
    refreshSections();
  }, [user]);

  async function refreshSections() {
    try {
      const { data } = await api.get('/api/settings/my-sections');
      setSections(Array.isArray(data?.sections) ? data.sections : null);
    } catch {
      setSections(null);
    }
  }

  useEffect(() => {
    const token = localStorage.getItem('innsight_token');
    if (token && !user) {
      api
        .get('/api/auth/me')
        .then((r) => {
          setUser(r.data);
          localStorage.setItem('innsight_user', JSON.stringify(r.data));
        })
        .catch(() => {});
    }
  }, []);

  async function login(username, password) {
    setLoading(true);
    try {
      const { data } = await api.post('/api/auth/login', { username, password });
      localStorage.setItem('innsight_token', data.token);
      localStorage.setItem('innsight_user', JSON.stringify(data.user));
      setUser(data.user);
      return data.user;
    } finally {
      setLoading(false);
    }
  }

  // University sign-in. Google has already proved who they are; the server
  // decides whether that address maps to an account here, so the shape of the
  // response — and everything we persist — is identical to password login.
  async function loginWithGoogle(credential) {
    setLoading(true);
    try {
      const { data } = await api.post('/api/auth/google', { credential });
      localStorage.setItem('innsight_token', data.token);
      localStorage.setItem('innsight_user', JSON.stringify(data.user));
      setUser(data.user);
      return data.user;
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    // REVOKE the token server-side first. Dropping it from localStorage only
    // makes this browser forget it — the JWT itself stayed valid for the rest of
    // its 12-hour TTL, so anyone who had captured it (or any other tab that had
    // copied it) still held a working credential after "Sign out". The auth
    // service has had POST /api/auth/logout for exactly this since revocation
    // was added; nothing on the client ever called it.
    //
    // Best-effort: if the request fails the user must still be signed out
    // locally, so a network error can never trap someone in a session.
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* offline, or the token had already expired — either way, continue */
    }
    // Chat dock windows and notification history (which stores message PREVIEWS
    // — see lib/notifications.js) are keyed per user so the NEXT person to sign
    // in never inherits them, but that keying alone leaves this user's own copy
    // sitting in localStorage forever once they sign out. Purge them for the
    // user who is actually leaving, before their id is gone from state.
    if (user?.id) {
      localStorage.removeItem(chatDockStoreKey(user.id));
      localStorage.removeItem(notifsStoreKey(user.id));
    }
    localStorage.removeItem('innsight_token');
    localStorage.removeItem('innsight_user');
    setUser(null);
    // A full document load, not a client-side navigate: it discards every
    // in-memory store, cached page state and open SSE stream in one step, so no
    // fragment of the previous session can survive into the next sign-in.
    window.location.href = '/login';
  }

  function hasRole(...roles) {
    if (!user) return false;
    return roles.some((r) => user.roles?.includes(r));
  }

  // Which sections this account can reach, after an admin's Sidebar Visibility
  // settings have been applied on top of its roles. `null` means "not known
  // yet" — see hasSection.
  function hasSection(key) {
    if (!user) return false;
    // FAIL OPEN, on purpose and in only one direction. Before the list arrives
    // (or if the request failed), every section the ROLE allows stays reachable:
    // the role guards in App.jsx and on every API route are untouched and still
    // decide what this account may actually do. Failing closed would blank the
    // sidebar on a slow first paint and strand anyone whose auth service blipped
    // — a far worse outcome than a hidden link appearing for a moment.
    if (sections === null) return true;
    return sections.includes(key);
  }

  function updateUser(next) {
    setUser(next);
    if (next) localStorage.setItem('innsight_user', JSON.stringify(next));
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        loginWithGoogle,
        logout,
        hasRole,
        sections,
        hasSection,
        refreshSections,
        setUser: updateUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
