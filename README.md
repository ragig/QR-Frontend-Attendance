# QR Attendance – React frontend

React (Vite) frontend for the QR Attendance system. It lives in its own folder and
talks to the Django backend (separate folder) through axios.

## Run

```bash
cd qr-attendance-frontend
npm install
npm run dev          # http://localhost:5173
```

Start Django separately (default `http://127.0.0.1:8000`).

## How it connects to Django

All requests go through `src/api.js` (one axios instance).

| Setting | File | Purpose |
|---|---|---|
| `VITE_API_URL` | `.env` | axios base URL. `/api` = use the Vite dev proxy (no CORS needed in dev). |
| `VITE_PROXY_TARGET` | `.env` | Where the dev proxy forwards `/api` (default `http://127.0.0.1:8000`). |
| `VITE_PUBLIC_APP_URL` | `.env` | Address a phone can open (your LAN IP, e.g. `http://192.168.1.10:5173`). It is written into each personal QR code, so `localhost` will NOT work for phone scans. |

Production / no proxy: set `VITE_API_URL=https://your-django-host/api` and enable CORS in Django:

```bash
pip install django-cors-headers
```
```python
# settings.py
INSTALLED_APPS += ["corsheaders"]
MIDDLEWARE = ["corsheaders.middleware.CorsMiddleware", *MIDDLEWARE]   # put it first
CORS_ALLOWED_ORIGINS = ["http://localhost:5173", "http://192.168.1.10:5173"]
```

## Endpoints the frontend calls (relative to `VITE_API_URL`)

| Method | Path | Body / params |
|---|---|---|
| POST | `/auth/login/` | `{employee_id, password}` → `{access, user}` |
| POST | `/auth/qr-login/` | `{qr_token}` → `{access, user, active_attendance}` |
| POST | `/auth/register/` | admin only |
| POST | `/attendance/mark/` | `{token?}` → `{detail, record}` ; 400 `{detail: "Already checked in…", record?}` |
| POST | `/attendance/checkout/` | `{record?}` → `{detail}` |
| GET | `/attendance/history/` | `period, role, employee, status` |
| GET | `/dashboard/`, `/notices/` | |
| POST | `/notices/` | `{recipient, message}` |
| GET | `/reports/export/` | CSV blob |

The JWT is sent as `Authorization: Bearer <access>`.

If your `mark` view reports check-in vs check-out with different keys, adjust
`interpretMarkResponse` and `classifyMarkError` at the top of `src/App.jsx`.

## Files

- `src/api.js` – axios instance, token interceptor, 401 handling, endpoint helpers
- `src/App.jsx` – the app (same markup/classNames as before)
- `src/App.css`, `src/index.css`, `index.html`, `src/main.jsx` – unchanged
