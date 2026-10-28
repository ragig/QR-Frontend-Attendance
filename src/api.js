import axios from 'axios';

/**
 * Single place that talks to Django.
 *
 * - Base URL comes from VITE_API_URL (default "/api", which the Vite dev proxy
 *   forwards to Django, see vite.config.js).
 * - The JWT access token is attached automatically to every request, so no
 *   component needs to build an Authorization header.
 * - A 401 on an authenticated request logs the user out (expired token).
 */

export const API_URL = import.meta.env.VITE_API_URL || '/api';

const AUTH_KEY = 'auth';

export const getStoredAuth = () => {
  try {
    const stored = localStorage.getItem(AUTH_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    try {
      localStorage.removeItem(AUTH_KEY);
    } catch {
      // ignore storage failures
    }
    return null;
  }
};

export const setStoredAuth = (data) => {
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify(data));
  } catch {
    // ignore storage failures
  }
};

export const clearStoredAuth = () => {
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    // ignore storage failures
  }
};

const api = axios.create({
  baseURL: API_URL,
  timeout: 20000,
});

// Attach the token on every request. Login endpoints pass { skipAuth: true } so a
// stale/expired token is never sent to them (DRF would reject it with 401 even
// on public endpoints).
api.interceptors.request.use((config) => {
  if (!config.skipAuth) {
    const access = getStoredAuth()?.access;
    if (access) {
      config.headers.Authorization = `Bearer ${access}`;
      config.sentToken = access; // remembered so a late 401 can be matched to it
    }
  }
  return config;
});

let unauthorizedHandler = null;
export const setUnauthorizedHandler = (handler) => {
  unauthorizedHandler = handler;
};

api.interceptors.response.use(
  (response) => response,
  (error) => {
    // Only react if the rejected token is still the one in use. A slow 401 for an
    // old token must not log out a user who has just signed in again.
    const sentToken = error.config?.sentToken;
    if (error.response?.status === 401 && sentToken && sentToken === getStoredAuth()?.access) {
      unauthorizedHandler?.();
    }
    return Promise.reject(error);
  },
);

export const getErrorMessage = (error, fallback = 'Unable to complete request') => {
  if (error?.response?.data) {
    const data = error.response.data;
    if (typeof data === 'string') {
      const text = data.trim();
      return text.startsWith('<!DOCTYPE') || text.startsWith('<html') ? fallback : text;
    }
    if (data instanceof Blob) {
      return fallback;
    }
    if (data.detail) return String(data.detail);
    if (data.error) return String(data.error);
    const flat = Object.values(data)
      .flat()
      .filter((value) => typeof value === 'string');
    return flat.length ? flat.join(' ') : fallback;
  }
  if (error?.code === 'ECONNABORTED') {
    return 'The server took too long to respond. Please try again.';
  }
  if (error?.code === 'ERR_NETWORK' || error?.message === 'Network Error') {
    return 'Cannot reach the backend API. Start Django on port 8000, then try again.';
  }
  return error?.message ? `Network error: ${error.message}` : fallback;
};

/* ---------- Endpoint helpers (paths match the existing Django API) ---------- */

export const authApi = {
  // Django's login endpoint requires the identifier under `employee_id`.
  login: ({ employee_id, password }) => api.post('/auth/login/', { employee_id, password }, { skipAuth: true }),
  qrLogin: (qrToken) => api.post('/auth/qr-login/', { qr_token: qrToken }, { skipAuth: true }),
  register: (body) => api.post('/auth/register/', body),
};

export const attendanceApi = {
  // token omitted -> backend marks attendance for the logged-in user
  mark: (token) => api.post('/attendance/mark/', token ? { token } : {}),
  // record omitted -> backend checks out the user's open attendance
  checkout: (record) => api.post('/attendance/checkout/', record ? { record } : {}),
  history: (params) => api.get('/attendance/history/', { params }),
};

export const dashboardApi = {
  get: () => api.get('/dashboard/'),
};

export const noticeApi = {
  list: () => api.get('/notices/'),
  send: (body) => api.post('/notices/', body),
};

export const reportApi = {
  exportCsv: () => api.get('/reports/export/', { responseType: 'blob' }),
};

export default api;
