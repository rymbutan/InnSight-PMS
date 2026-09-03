import { createContext, useContext, useEffect, useState } from 'react';
import api from './api';
import { hydrateRoomLayouts } from './sim/layoutSync';
import { hydrateCategories } from './sim/inspection/categorySync';

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

  function logout() {
    localStorage.removeItem('innsight_token');
    localStorage.removeItem('innsight_user');
    setUser(null);
    window.location.href = '/login';
  }

  function hasRole(...roles) {
    if (!user) return false;
    return roles.some((r) => user.roles?.includes(r));
  }

  function updateUser(next) {
    setUser(next);
    if (next) localStorage.setItem('innsight_user', JSON.stringify(next));
  }

  return (
    <AuthContext.Provider
      value={{ user, loading, login, loginWithGoogle, logout, hasRole, setUser: updateUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
