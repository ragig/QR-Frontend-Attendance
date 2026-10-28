import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import './App.css';
import {
  attendanceApi,
  authApi,
  clearStoredAuth,
  dashboardApi,
  getErrorMessage,
  getStoredAuth,
  noticeApi,
  reportApi,
  setStoredAuth,
  setUnauthorizedHandler,
} from './api';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const isValidGmail = (email) => {
  const gmailPattern = /^(?=.{1,30}@gmail\.com$)(?=[a-z0-9.]*[a-z])[a-z0-9](?!.*\.\.)[a-z0-9.]*[a-z0-9]@gmail\.com$/;
  return gmailPattern.test(email);
};

const getUrlScanToken = () => {
  const query = new URLSearchParams(window.location.search);
  const quick = query.get('quick')?.trim();
  const attendance = query.get('attendance')?.trim();
  const token = query.get('token')?.trim();

  if (quick) return { token: quick, type: 'personal' };
  if (attendance) return { token: attendance, type: 'session' };
  if (token) return { token, type: 'session' };
  return { token: '', type: '' };
};

const getAppOrigin = () => import.meta.env.VITE_PUBLIC_APP_URL || window.location.origin;

const getPersonalQrValue = (qrToken) => {
  if (!qrToken) return '';
  return `${getAppOrigin()}/?quick=${encodeURIComponent(qrToken)}`;
};

const PersonalQrCode = ({ token, size = 180 }) => {
  const qrValue = getPersonalQrValue(token);

  return (
    <>
      <QRCodeSVG value={qrValue} size={size} />
      <p className="qr-link">Phone scan opens: {qrValue}</p>
    </>
  );
};

const getUserDisplayName = (user) => user?.display_name || user?.username || 'QR owner';

const formatDateTime = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

const formatDays = (record) => {
  if (record?.days_present != null) return record.days_present;
  return record?.status === 'absent' ? 0 : '-';
};

const formatHours = (value) => {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return `${Number(value).toFixed(2)} hr`;
};

// The backend may return the attendance record as an id or as an object.
const normalizeRecordId = (record) => {
  if (record == null || record === '') return null;
  if (typeof record === 'object') return record.id ?? null;
  return record;
};

/**
 * Turns the response of POST /attendance/mark/ into what the UI needs.
 * If your Django view uses different keys, this is the only place to change.
 * Recognised: { action: 'check-out' } or { checked_out: true } -> check-out,
 * anything else -> check-in. { record: <id | {id}> } is the open record id.
 */
const interpretMarkResponse = (data) => {
  const checkedOut = data?.action === 'check-out' || data?.action === 'checkout' || data?.checked_out === true;
  return {
    action: checkedOut ? 'check-out' : 'check-in',
    detail: data?.detail || (checkedOut ? 'Checked out successfully' : 'Attendance marked successfully'),
    recordId: normalizeRecordId(data?.record),
  };
};

// Decides how a failed "mark attendance" call should be shown.
const classifyMarkError = (error, detail) => {
  const text = String(error?.response?.data?.detail || detail || '').toLowerCase();
  if (text.includes('already checked in')) return { action: 'already-checked-in', status: 'pending' };
  if (text.includes('already recorded')) return { action: 'completed', status: 'success' };
  return { action: 'error', status: 'error' };
};

const BADGES = {
  'check-in': ['status-success', 'Checked in ✓'],
  'check-out': ['status-success', 'Checked out ✓'],
  completed: ['status-success', 'Completed ✓'],
  'already-checked-in': ['status-pending', 'Already checked in'],
  error: ['status-error', 'Error'],
};

const AttendanceBadge = ({ result }) => {
  const [className, label] = result
    ? BADGES[result.action] || BADGES.error
    : ['status-pending', 'Processing...'];
  return <span className={`status-badge ${className}`}>{label}</span>;
};

const getAttendanceTime = (record, type) => {
  if (!record || typeof record !== 'object') return null;
  return type === 'check-in'
    ? record.check_in || record.check_in_at || record.checked_in_at || record.checkIn
    : record.check_out || record.check_out_at || record.checked_out_at || record.checkOut;
};

const AttendanceTimes = ({ record }) => (
  <div className="attendance-times" aria-label="Attendance times">
    <div><span>Check-in</span><strong>{formatDateTime(getAttendanceTime(record, 'check-in'))}</strong></div>
    <div><span>Check-out</span><strong>{formatDateTime(getAttendanceTime(record, 'check-out'))}</strong></div>
  </div>
);

const emptyAdminForm = {
  username: '',
  email: '',
  password: '',
  role: 'employee',
  display_name: '',
  department: '',
  employee_id: '',
  phone: '',
};

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

function App() {
  // The QR link is read once, when the app first loads.
  const [initialScan] = useState(getUrlScanToken);
  // Scanning someone's personal QR switches the device to that person, so any
  // previously stored login is ignored (and cleared in the scan effect below).
  const [auth, setAuth] = useState(() => (initialScan.type === 'personal' ? null : getStoredAuth()));
  const [page, setPage] = useState('home');
  const [form, setForm] = useState({ employee_id: '', password: '' });
  const [dashboard, setDashboard] = useState(null);
  const [notices, setNotices] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyPeriod, setHistoryPeriod] = useState('all');
  const [historySearch, setHistorySearch] = useState('');
  const [historySortField, setHistorySortField] = useState('check_in');
  const [historySortDirection, setHistorySortDirection] = useState('desc');
  const [selectedRole, setSelectedRole] = useState('employees');
  const [attendanceRole, setAttendanceRole] = useState('employees');
  const [selectedUser, setSelectedUser] = useState(null);
  const [selectedUserHistory, setSelectedUserHistory] = useState([]);
  const [selectedUserLoading, setSelectedUserLoading] = useState(false);
  const [attendanceSuccess, setAttendanceSuccess] = useState(false);
  const [activeAttendanceId, setActiveAttendanceId] = useState(null);
  const [attendanceRecord, setAttendanceRecord] = useState(null);
  const [pendingAttendanceToken, setPendingAttendanceToken] = useState('');
  const [quickLoginLoading, setQuickLoginLoading] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [message, setMessage] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [attendanceSubmitting, setAttendanceSubmitting] = useState(false);
  const [adminForm, setAdminForm] = useState(emptyAdminForm);
  const [adminSubmitting, setAdminSubmitting] = useState(false);
  const [noticeForm, setNoticeForm] = useState({ recipient: '', message: '' });
  const [noticeSubmitting, setNoticeSubmitting] = useState(false);
  const [showRegisterSection, setShowRegisterSection] = useState(false);
  const [showNoticeSection, setShowNoticeSection] = useState(false);
  const [showNoticePanel, setShowNoticePanel] = useState(false);

  const scanHandledRef = useRef(false);
  // Blocks double clicks / double scans while a mark or check-out is in flight.
  const markingRef = useRef(false);
  const historyRequestRef = useRef(0);

  const isManager = auth?.user?.role === 'manager';
  const isAdmin = auth?.user?.role === 'admin';
  const isEmployee = auth?.user?.role === 'employee';
  const isEmployer = auth?.user?.role === 'employer';
  // Employers use the same personal attendance flow as employees and managers.
  const canMarkOwnAttendance = isEmployee || isManager || isEmployer;
  const hasAccess = Boolean(auth?.access);
  const selectedUserId = selectedUser?.user_id;

  /* ---------------- data loading ---------------- */

  // For calls that need a login: a 401 means the login expired, which the global
  // handler already reports, so don't overwrite that message with the raw server text.
  const reportError = useCallback((error, fallback) => {
    if (error?.response?.status === 401) return;
    setMessage(getErrorMessage(error, fallback));
  }, []);

  const loadDashboard = useCallback(async ({ silent = false } = {}) => {
    try {
      const { data } = await dashboardApi.get();
      setDashboard(data);
    } catch (error) {
      if (!silent) reportError(error, 'Unable to load dashboard');
    }
  }, [reportError]);

  const loadNotices = useCallback(async ({ silent = false } = {}) => {
    try {
      const { data } = await noticeApi.list();
      setNotices(Array.isArray(data) ? data : data?.results || []);
    } catch (error) {
      if (!silent) reportError(error, 'Unable to load notices');
    }
  }, [reportError]);

  const loadHistory = useCallback(async ({ silent = false } = {}) => {
    const requestId = ++historyRequestRef.current;
    try {
      const params = { period: historyPeriod };
      if (isAdmin) {
        params.role = attendanceRole === 'managers' ? 'manager' : 'employee';
        if (selectedUserId) params.employee = selectedUserId;
      }
      const { data } = await attendanceApi.history(params);
      // Ignore the answer if a newer request was started meanwhile.
      if (requestId === historyRequestRef.current) {
        setHistory(Array.isArray(data) ? data : data?.results || []);
      }
    } catch (error) {
      if (!silent) reportError(error, 'Unable to load attendance history');
    }
  }, [attendanceRole, historyPeriod, isAdmin, reportError, selectedUserId]);

  const loadUserHistory = useCallback(async (userId) => {
    if (!userId) {
      setSelectedUserHistory([]);
      return;
    }
    setSelectedUserLoading(true);
    try {
      const { data } = await attendanceApi.history({ period: 'monthly', status: 'all', employee: userId });
      setSelectedUserHistory(Array.isArray(data) ? data : data?.results || []);
    } catch (error) {
      reportError(error, 'Unable to load user attendance history');
      setSelectedUserHistory([]);
    } finally {
      setSelectedUserLoading(false);
    }
  }, [reportError]);

  const handleSelectUser = useCallback((user) => {
    setSelectedUser(user);
    setSelectedUserHistory([]);
  }, []);

  // Tell other tabs (and refresh this one) that attendance changed.
  const notifyAttendanceChanged = useCallback(() => {
    loadDashboard({ silent: true });
    loadHistory({ silent: true });
    try {
      window.localStorage.setItem('attendance-updated', `${Date.now()}`);
    } catch {
      // ignore storage failures
    }
  }, [loadDashboard, loadHistory]);

  /* ---------------- session ---------------- */

  const persistAuth = useCallback((data) => {
    setStoredAuth(data);
    setAuth(data);
  }, []);

  const resetSession = useCallback((nextMessage = '') => {
    clearStoredAuth();
    setAuth(null);
    setDashboard(null);
    setNotices([]);
    setHistory([]);
    setSelectedUser(null);
    setSelectedUserHistory([]);
    setActiveAttendanceId(null);
    setAttendanceRecord(null);
    setAttendanceSuccess(false);
    setScanResult(null);
    setPendingAttendanceToken('');
    setShowNoticePanel(false);
    setMessage(nextMessage);
  }, []);

  const logout = () => {
    resetSession('Logged out');
    setPage('home');
    if (page === 'scan' && typeof window !== 'undefined' && window.close) {
      window.close();
    }
  };

  const goHome = () => {
    setMessage('');
    setPage('home');
  };

  // An expired/invalid token on any authenticated call sends the user back to login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      resetSession('Your session expired. Please log in again.');
      setPage((current) => (current === 'home' ? current : 'auth'));
    });
    return () => setUnauthorizedHandler(null);
  }, [resetSession]);

  /* ---------------- attendance ---------------- */

  // Marks attendance. With a token it is a session/personal QR token, without
  // one the backend uses the logged-in user. `owner` is only used for display.
  const submitAttendance = useCallback(async (rawToken = '', owner = {}) => {
    if (markingRef.current) return { success: false, busy: true };
    markingRef.current = true;
    setAttendanceSubmitting(true);
    setAttendanceSuccess(false);

    try {
      const { data } = await attendanceApi.mark(rawToken?.trim());
      const { action, detail, recordId } = interpretMarkResponse(data);

      setActiveAttendanceId(action === 'check-in' ? recordId : null);
      setAttendanceRecord(typeof data?.record === 'object' ? data.record : null);
      setAttendanceSuccess(action === 'check-in');
      setScanResult({ ...owner, action, status: 'success', detail });
      setMessage(owner.ownerName ? `${owner.ownerName}: ${detail}` : detail);
      notifyAttendanceChanged();
      return { success: true, data };
    } catch (error) {
      // Expired login: the global 401 handler already returned the user to the login page.
      if (error.response?.status === 401) return { success: false, error };

      const detail = getErrorMessage(error, 'Unable to mark attendance');
      const { action, status } = classifyMarkError(error, detail);

      if (action === 'already-checked-in') {
        const openRecordData = error.response?.data?.record;
        const openRecord = normalizeRecordId(openRecordData);
        if (openRecord) setActiveAttendanceId(openRecord);
        if (typeof openRecordData === 'object') setAttendanceRecord(openRecordData);
      }
      setScanResult({ ...owner, action, status, detail });
      setMessage(detail);
      return { success: false, error };
    } finally {
      markingRef.current = false;
      setAttendanceSubmitting(false);
    }
  }, [notifyAttendanceChanged]);

  // A manual check-in belongs to the currently authenticated user.  Do not
  // send their personal-QR token here: the endpoint can reliably identify the
  // user from the JWT, while a token is only needed after scanning a QR link.
  const markAttendance = useCallback(() => (
    submitAttendance()
  ), [submitAttendance]);

  const checkOut = useCallback(async () => {
    if (markingRef.current) return;
    markingRef.current = true;
    setAttendanceSubmitting(true);

    try {
      const { data } = await attendanceApi.checkout(activeAttendanceId);
      const detail = data?.detail || 'Checked out successfully';
      setActiveAttendanceId(null);
      setAttendanceSuccess(false);
      setAttendanceRecord(typeof data?.record === 'object' ? data.record : attendanceRecord);
      setScanResult((current) => ({
        ownerName: current?.ownerName,
        employeeId: current?.employeeId,
        action: 'check-out',
        status: 'success',
        detail,
      }));
      setMessage(detail);
      notifyAttendanceChanged();
    } catch (error) {
      if (error.response?.status === 401) return;

      const detail = getErrorMessage(error, 'Unable to check out');
      setScanResult((current) => ({
        ...(current || {}),
        action: 'error',
        status: 'error',
        detail,
      }));
      setMessage(detail);
    } finally {
      markingRef.current = false;
      setAttendanceSubmitting(false);
    }
  }, [activeAttendanceId, attendanceRecord, notifyAttendanceChanged]);

  /* ---------------- QR link handling (runs once on load) ---------------- */

  useEffect(() => {
    if (scanHandledRef.current) return;
    scanHandledRef.current = true;

    const { token: scannedToken, type: scannedType } = initialScan;
    if (!scannedToken) return;
    window.history.replaceState(null, '', window.location.pathname);

    // Personal QR: log the owner in with the QR token, then check them in.
    const loginFromPersonalQr = async () => {
      clearStoredAuth();
      setQuickLoginLoading(true);
      setScanResult(null);
      setPage('scan');

      try {
        const { data } = await authApi.qrLogin(scannedToken);
        const owner = {
          ownerName: getUserDisplayName(data.user),
          employeeId: data.user?.employee_id || '',
        };
        persistAuth(data);

        if (data.active_attendance) {
          setActiveAttendanceId(normalizeRecordId(data.active_attendance));
          setAttendanceRecord(typeof data.active_attendance === 'object' ? data.active_attendance : null);
          setAttendanceSuccess(false);
          setScanResult({
            ...owner,
            action: 'already-checked-in',
            status: 'pending',
            detail: 'Attendance is already marked.',
          });
          setMessage(`${owner.ownerName} is already checked in.`);
        } else {
          await submitAttendance(scannedToken, owner);
        }
      } catch (error) {
        const detail = getErrorMessage(error, 'Invalid QR token. Ask your admin for a fresh QR code.');
        setScanResult({ ownerName: '', employeeId: '', action: 'error', status: 'error', detail });
        setMessage(detail);
      } finally {
        setQuickLoginLoading(false);
      }
    };

    // Session QR: mark the logged-in user, or ask them to log in first.
    const processSessionAttendance = async () => {
      if (getStoredAuth()?.access) {
        setPage('scan');
        setMessage('Attendance QR loaded. Verifying session token...');
        const result = await submitAttendance(scannedToken);
        // Stored login had expired: keep the scanned token and ask for a fresh login.
        if (!result.success && result.error?.response?.status === 401) {
          setPendingAttendanceToken(scannedToken);
        }
        return;
      }
      setPendingAttendanceToken(scannedToken);
      setMessage('Attendance session QR loaded. Login to mark attendance.');
      setPage('auth');
    };

    if (scannedType === 'personal') {
      loginFromPersonalQr();
    } else {
      processSessionAttendance();
    }
  }, [initialScan, persistAuth, submitAttendance]);

  /* ---------------- refresh effects ---------------- */

  useEffect(() => {
    if (!hasAccess) return;
    loadDashboard();
    loadNotices();
  }, [hasAccess, loadDashboard, loadNotices]);

  // Re-runs whenever the period / staff type / selected person changes.
  useEffect(() => {
    if (!hasAccess) return;
    loadHistory();
  }, [hasAccess, loadHistory]);

  useEffect(() => {
    if (!hasAccess || !selectedUserId) return;
    loadUserHistory(selectedUserId);
  }, [hasAccess, loadUserHistory, selectedUserId]);

  useEffect(() => {
    if (!hasAccess) return undefined;

    const refreshAll = () => {
      loadDashboard({ silent: true });
      loadNotices({ silent: true });
      loadHistory({ silent: true });
    };
    const onStorage = (event) => {
      if (event.key === 'attendance-updated') refreshAll();
    };
    const interval = window.setInterval(() => {
      if (!document.hidden) refreshAll();
    }, 15000);

    window.addEventListener('focus', refreshAll);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('focus', refreshAll);
      window.removeEventListener('storage', onStorage);
      window.clearInterval(interval);
    };
  }, [hasAccess, loadDashboard, loadHistory, loadNotices]);

  /* ---------------- forms ---------------- */

  const handleLogin = async (event) => {
    event.preventDefault();
    const employeeId = form.employee_id.trim();
    if (!employeeId || !form.password) {
      setMessage('Enter your Employee ID and password.');
      return;
    }

    setAuthSubmitting(true);
    try {
      const { data } = await authApi.login({ employee_id: employeeId, password: form.password });
      persistAuth(data);
      setForm({ employee_id: '', password: '' });
      setMessage('Welcome back!');

      // They opened a session QR before logging in: mark it now.
      if (pendingAttendanceToken) {
        const pending = pendingAttendanceToken;
        setPendingAttendanceToken('');
        setPage('scan');
        await submitAttendance(pending);
      }
    } catch (error) {
      setMessage(getErrorMessage(error, 'Unable to log in'));
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleAdminRegister = async (event) => {
    event.preventDefault();
    setMessage('');

    const payload = {
      ...adminForm,
      display_name: adminForm.display_name.trim(),
      email: adminForm.email.trim().toLowerCase(),
      username: adminForm.username.trim(),
      employee_id: adminForm.employee_id.trim(),
      department: adminForm.department.trim(),
      phone: adminForm.phone.trim(),
    };

    if (!payload.display_name) {
      setMessage('Display Name is required');
      return;
    }
    if (!payload.email) {
      setMessage('Email is required');
      return;
    }
    if (!isValidGmail(payload.email)) {
      setMessage('Email must be a valid Gmail address (lowercase letters and numbers only before @gmail.com)');
      return;
    }
    if (!payload.password) {
      setMessage('Password is required');
      return;
    }

    setAdminSubmitting(true);
    try {
      const { data } = await authApi.register(payload);
      setMessage(`✓ Created ${data.user.role} account for ${data.user.display_name || data.user.username}`);
      setAdminForm(emptyAdminForm);
      loadDashboard();
    } catch (error) {
      if (error.response?.status !== 401) {
        setMessage(`✗ Error: ${getErrorMessage(error, 'Unable to create account')}`);
      }
    } finally {
      setAdminSubmitting(false);
    }
  };

  const submitNotice = useCallback(async () => {
    const recipient = parseInt(noticeForm.recipient, 10);
    const text = noticeForm.message.trim();
    if (!recipient || !text) {
      setMessage('Select a recipient and enter a notice message.');
      return;
    }

    setNoticeSubmitting(true);
    try {
      await noticeApi.send({ recipient, message: text });
      setMessage('Notice sent successfully');
      setNoticeForm({ recipient: '', message: '' });
      loadDashboard();
      loadNotices();
    } catch (error) {
      reportError(error, 'Unable to send notice');
    } finally {
      setNoticeSubmitting(false);
    }
  }, [loadDashboard, loadNotices, noticeForm, reportError]);

  const toggleNoticePanel = async () => {
    if (!showNoticePanel) {
      await loadNotices();
    }
    setShowNoticePanel((visible) => !visible);
  };

  const exportReport = async () => {
    try {
      const { data } = await reportApi.exportCsv();
      const url = URL.createObjectURL(data);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'attendance_report.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('Report exported');
    } catch (error) {
      if (error.response?.status === 401) return;
      // With responseType "blob" an error body arrives as a Blob; read it.
      let detail = getErrorMessage(error, 'Unable to export report');
      if (error.response?.data instanceof Blob) {
        try {
          const parsed = JSON.parse(await error.response.data.text());
          detail = parsed.detail || parsed.error || detail;
        } catch {
          // keep the generic message
        }
      }
      setMessage(detail);
    }
  };

  /* ---------------- derived data ---------------- */

  const summary = dashboard?.summary || {};

  const getRoleUsers = useCallback((role) => {
    const employees = dashboard?.employees || [];
    const completeEmployees = employees.filter((employee) => (
      employee.department?.trim() || employee.phone?.trim()
    ));
    if (!isAdmin) return completeEmployees;
    return role === 'managers' ? dashboard?.managers || [] : completeEmployees;
  }, [dashboard?.employees, dashboard?.managers, isAdmin]);

  const selectedRoleUsers = useMemo(() => getRoleUsers(selectedRole), [getRoleUsers, selectedRole]);
  const attendanceRoleUsers = useMemo(() => getRoleUsers(attendanceRole), [getRoleUsers, attendanceRole]);

  const selectedUserAttendanceTotals = useMemo(() => {
    if (!selectedUserHistory?.length) {
      return { months: 0, days: 0, hours: 0 };
    }
    const days = selectedUserHistory.reduce((sum, record) => sum + Number(record.days_present || 0), 0);
    const hours = selectedUserHistory.reduce((sum, record) => sum + Number(record.hours || 0), 0);
    return { months: selectedUserHistory.length, days, hours };
  }, [selectedUserHistory]);

  const visibleHistory = useMemo(() => {
    const searchTerm = historySearch.trim().toLowerCase();
    const fallbackName = auth?.user?.display_name || auth?.user?.username || '';
    const filtered = history.filter((record) => {
      if (!searchTerm) return true;
      return (record.employee_name || fallbackName).toLowerCase().includes(searchTerm);
    });

    const getValue = (record) => {
      switch (historySortField) {
        case 'employee':
          return (record.employee_name || '').toLowerCase();
        case 'role':
          return (record.employee_role || '').toLowerCase();
        case 'session':
          return (record.session_title || '').toLowerCase();
        case 'status':
          return (record.status || '').toLowerCase();
        case 'days':
          return Number(record.days_present) || 0;
        case 'check_out':
          return record.check_out ? new Date(record.check_out).getTime() : 0;
        case 'hours':
          return Number(record.hours) || 0;
        case 'check_in':
        default:
          return record.check_in ? new Date(record.check_in).getTime() : 0;
      }
    };

    return [...filtered].sort((a, b) => {
      const aValue = getValue(a);
      const bValue = getValue(b);
      if (aValue < bValue) return historySortDirection === 'asc' ? -1 : 1;
      if (aValue > bValue) return historySortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [auth?.user?.display_name, auth?.user?.username, history, historySearch, historySortField, historySortDirection]);

  const handleHistorySort = (field) => {
    if (historySortField === field) {
      setHistorySortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setHistorySortField(field);
    setHistorySortDirection('asc');
  };

  const openAuthPage = () => {
    setMessage('');
    setPage('auth');
  };

  const isMonthlyReport = historyPeriod === 'monthly';

  /* ---------------- shared JSX ---------------- */

  const checkOutButton = (
    <button
      type="button"
      className="checkout-button"
      onClick={checkOut}
      disabled={attendanceSubmitting || quickLoginLoading}
    >
      Check Out
    </button>
  );

  const attendanceRecordsSection = (
    <section className="card">
      <h2>{isAdmin ? 'Attendance records' : isManager ? 'Monthly attendance report (days present)' : 'Attendance history'}</h2>
      {(isManager || isAdmin || isEmployee) && (
        <div className="report-controls">
          <label>
            Period
            <select value={historyPeriod} onChange={(e) => setHistoryPeriod(e.target.value)}>
              <option value="all">All</option>
              <option value="daily">Daily</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          {isAdmin && (
            <>
              <label>
                Staff type
                <select
                  value={attendanceRole}
                  onChange={(e) => {
                    setAttendanceRole(e.target.value);
                    setSelectedUser(null);
                    setSelectedUserHistory([]);
                  }}
                >
                  <option value="employees">Employees</option>
                  <option value="managers">Managers</option>
                </select>
              </label>
              <label>
                Individual
                <select
                  value={selectedUser?.user_id || ''}
                  onChange={(e) => {
                    const nextUser = attendanceRoleUsers.find((user) => `${user.user_id}` === e.target.value) || null;
                    setSelectedUser(nextUser);
                    setSelectedUserHistory([]);
                  }}
                >
                  <option value="">All {attendanceRole}</option>
                  {attendanceRoleUsers.map((user) => (
                    <option key={user.user_id} value={user.user_id}>
                      {user.display_name || user.username} {user.employee_id ? `(${user.employee_id})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
      )}
      {(isManager || isAdmin) && (
        <div className="history-controls">
          <label>
            Search attendance
            <input type="search" placeholder="Search by name" value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} />
          </label>
        </div>
      )}
      {visibleHistory.length > 0 ? (
        <div className="table-wrap">
          <table className="history-table">
            <thead>
              <tr>
                <th onClick={() => handleHistorySort('session')} className="sortable">{isMonthlyReport ? 'Month' : 'Details'}</th>
                <th onClick={() => handleHistorySort('employee')} className="sortable">Name</th>
                <th onClick={() => handleHistorySort('status')} className="sortable">Status</th>
                {isMonthlyReport && <th onClick={() => handleHistorySort('days')} className="sortable">Days</th>}
                {!isMonthlyReport && <th onClick={() => handleHistorySort('check_in')} className="sortable">Check In</th>}
                {!isMonthlyReport && <th onClick={() => handleHistorySort('check_out')} className="sortable">Check Out</th>}
                <th onClick={() => handleHistorySort('hours')} className="sortable">Hours</th>
              </tr>
            </thead>
            <tbody>
              {visibleHistory.map((record) => (
                <tr key={record.id}>
                  <td>{record.session_title || 'Personal check-in'}</td>
                  <td>{record.employee_name || auth?.user?.display_name || auth?.user?.username}</td>
                  <td>{record.status}</td>
                  {isMonthlyReport && <td>{formatDays(record)}</td>}
                  {!isMonthlyReport && <td>{formatDateTime(record.check_in)}</td>}
                  {!isMonthlyReport && <td>{formatDateTime(record.check_out)}</td>}
                  <td>{formatHours(record.hours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="hint">No attendance records yet.</p>
      )}
    </section>
  );

  /* ---------------- render ---------------- */

  return (
    <div className="app-shell">
      <div className="top-nav">
        <span className="site-brand"><span className="brand-mark" aria-hidden="true">QR</span>QR Attendance</span>
        <div className="top-nav-actions">
          {page !== 'home' && page !== 'auth' && page !== 'scan' && (
            <button type="button" className="home-link" onClick={goHome}>Home page</button>
          )}
          {auth && page !== 'home' && (
            <button type="button" className="logout-button" onClick={logout}>Logout</button>
          )}
        </div>
      </div>
      {page === 'home' ? (
        <main className="home-page">
          <section className="home-panel">
            <div className="home-visual" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
            <h1>QR Attendance System</h1>
            <p className="home-copy">Use your account to mark attendance, view history, and manage staff.</p>
            <div className="home-actions">
              <button type="button" onClick={openAuthPage}>Login</button>
            </div>
            <p className="hint">Employee and manager accounts must be created by an admin.</p>
          </section>
        </main>
      ) : page === 'scan' ? (
        <main className="scan-page">
          <section className="card scan-result-card">
            <div className="attendance-result-header">
              <div>
                <p className="attendance-result-label">Attendance scan</p>
                <h2>{scanResult?.ownerName || getUserDisplayName(auth?.user)}</h2>
              </div>
              <AttendanceBadge result={scanResult} />
            </div>
            <p className="attendance-result-detail">{scanResult?.detail || message || 'Finalizing attendance...'}</p>
            {scanResult && <AttendanceTimes record={attendanceRecord} />}
            {scanResult?.action === 'already-checked-in' && checkOutButton}
          </section>
        </main>
      ) : !auth ? (
        <section className="card auth-card">
          {quickLoginLoading && <p className="message">Opening your QR attendance page...</p>}
          <form onSubmit={handleLogin}>
            <input placeholder="Employee ID" value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} />
            <input type="password" placeholder="Password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <button type="submit" disabled={authSubmitting}>{authSubmitting ? 'Logging in...' : 'Login'}</button>
          </form>
          {pendingAttendanceToken && (
            <p className="hint">Attendance session QR loaded. Log in to mark your check-in / check-out.</p>
          )}
          <p className="hint">Accounts must be created by an admin. Contact your administrator if you do not have login credentials.</p>
          {message && <p className="message">{message}</p>}
        </section>
      ) : (
        <>
          <section className="card stats-grid">
            {(isManager || isEmployee) ? (
              <>
                <div>
                  <h3>Name</h3>
                  <p>{auth.user?.display_name || auth.user?.username}</p>
                </div>
                <div>
                  <h3>Role</h3>
                  <p>{auth.user?.role}</p>
                </div>
                <div>
                  <h3>Notices</h3>
                  <p>{summary.notices ?? 0}</p>
                </div>
                <div>
                  <h3>Present</h3>
                  <p>{`${(isEmployee ? summary.records : summary.attendanceRecords) ?? 0} days`}</p>
                </div>
              </>
            ) : (
              <>
                <div>
                  <h3>Signed in as</h3>
                  <p>{auth.user?.display_name || auth.user?.username}</p>
                </div>
                <div>
                  <h3>Role</h3>
                  <p>{auth.user?.role}</p>
                </div>
              </>
            )}
            {isAdmin && (
              <>
                <div>
                  <h3>Total employees</h3>
                  <p>{summary.employees ?? '-'}</p>
                </div>
                <div>
                  <h3>Total managers</h3>
                  <p>{summary.managers ?? '-'}</p>
                </div>
                <div>
                  <h3>Total staff</h3>
                  <p>{typeof summary.employees === 'number' && typeof summary.managers === 'number'
                    ? summary.employees + summary.managers
                    : '-'}
                  </p>
                </div>
              </>
            )}
            {isManager && (
              <>
                <div>
                  <h3>Total employees</h3>
                  <p>{summary.employees ?? '-'}</p>
                </div>
                <div>
                  <h3>Managed employees</h3>
                  <p>{summary.employees ?? '-'}</p>
                </div>
              </>
            )}
          </section>

          {isAdmin && (
            <section className="card staff-details-card">
              <div className="staff-details-header">
                <div>
                  <h2>Staff details</h2>
                  <p className="hint">View staff profiles and monthly attendance by role.</p>
                </div>
                <label className="staff-role-filter">
                  Sort by
                  <select
                    value={selectedRole}
                    onChange={(e) => {
                      setSelectedRole(e.target.value);
                      setSelectedUser(null);
                      setSelectedUserHistory([]);
                    }}
                  >
                    <option value="employees">Employees</option>
                    <option value="managers">Managers</option>
                  </select>
                </label>
              </div>
              {selectedRoleUsers.length > 0 ? (
                <div className="table-wrap staff-table-wrap">
                  <table className="employee-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Employee ID</th>
                        <th>Department</th>
                        <th>Email</th>
                        <th>Phone</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedRoleUsers.map((employee) => (
                        <tr
                          key={employee.id}
                          className={selectedUser?.user_id === employee.user_id ? 'selected-row' : ''}
                          onClick={() => handleSelectUser(employee)}
                        >
                          <td>{employee.display_name || employee.username}</td>
                          <td>{employee.employee_id || '-'}</td>
                          <td>{employee.department || '-'}</td>
                          <td>{employee.email || '-'}</td>
                          <td>
                            {employee.phone || '-'}
                            {employee.phone && (
                              <button
                                type="button"
                                className="contact-button compact"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  navigator.clipboard.writeText(employee.phone)
                                    .then(() => setMessage(`Phone number copied: ${employee.phone}`))
                                    .catch(() => setMessage('Unable to copy phone number'));
                                }}
                              >
                                Contact now
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="hint">No users available for the selected role.</p>
              )}
              {(selectedUser || selectedUserHistory.length > 0) && (
                <div className="user-attendance-panel">
                  <h3>Attendance for {selectedUser ? (selectedUser.display_name || selectedUser.username) : 'selected user'}</h3>
                  {selectedUserLoading ? (
                    <p>Loading attendance records...</p>
                  ) : selectedUserHistory.length > 0 ? (
                    <>
                      <div className="attendance-summary-row">
                        <div>
                          <h4>Months</h4>
                          <p>{selectedUserAttendanceTotals.months}</p>
                        </div>
                        <div>
                          <h4>Days present</h4>
                          <p>{selectedUserAttendanceTotals.days}</p>
                        </div>
                        <div>
                          <h4>Total hours</h4>
                          <p>{formatHours(selectedUserAttendanceTotals.hours)}</p>
                        </div>
                      </div>
                      <div className="table-wrap">
                        <table className="history-table">
                          <thead>
                            <tr>
                              <th>Month</th>
                              <th>Days</th>
                              <th>Hours</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedUserHistory.map((record) => (
                              <tr key={record.id}>
                                <td>{record.session_title || 'Monthly'}</td>
                                <td>{formatDays(record)}</td>
                                <td>{formatHours(record.hours)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <p className="hint">Select a staff member to view their monthly attendance details.</p>
                  )}
                </div>
              )}
            </section>
          )}

          {isAdmin && attendanceRecordsSection}

          <section className="card">
            <h2>Quick actions</h2>
            {message && <p className="message">{message}</p>}
            {scanResult && (
              <div className={`attendance-result-card ${scanResult.status === 'error' ? 'attendance-error' : ''}`}>
                <div className="attendance-result-header">
                  <div>
                    <p className="attendance-result-label">Attendance result for</p>
                    <h3>{scanResult.ownerName || getUserDisplayName(auth.user)}</h3>
                  </div>
                  <AttendanceBadge result={scanResult} />
                </div>
                <p className="attendance-result-detail">{scanResult.detail}</p>
                <AttendanceTimes record={attendanceRecord} />
                {scanResult.action === 'already-checked-in' && checkOutButton}
              </div>
            )}
            {canMarkOwnAttendance && (
              <>
                <div className="scanner-section">
                  <h3>Your personal QR</h3>
                  {auth.user?.qr_token ? (
                    <PersonalQrCode token={auth.user.qr_token} />
                  ) : (
                    <p>No QR token available</p>
                  )}
                </div>

                <div className="actions">
                  <button
                    type="button"
                    onClick={markAttendance}
                    disabled={attendanceSubmitting || quickLoginLoading}
                  >
                    {attendanceSubmitting ? 'Working...' : 'Mark Attendance'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={checkOut}
                    disabled={attendanceSubmitting || quickLoginLoading}
                  >
                    Check Out
                  </button>
                  <button type="button" className="secondary" onClick={logout}>Logout</button>
                </div>
                {attendanceSuccess && (
                  <div className="attendance-status">
                    <span className="success-indicator">Attendance marked</span>
                  </div>
                )}
              </>
            )}
            {(isAdmin || isManager) && <button type="button" onClick={exportReport}>Export CSV Report</button>}
          </section>

          {isAdmin && (
            <section className="card admin-action-card register-action-card">
              <details className="admin-action-details" open={showRegisterSection} onToggle={(e) => setShowRegisterSection(e.target.open)}>
                <summary>Register employee/manager</summary>
                <form onSubmit={handleAdminRegister} className="admin-register-form">
                  <input placeholder="Display Name" value={adminForm.display_name} onChange={(e) => setAdminForm({ ...adminForm, display_name: e.target.value })} required />
                  <input type="email" placeholder="Email" value={adminForm.email} onChange={(e) => setAdminForm({ ...adminForm, email: e.target.value })} required />
                  <input type="password" placeholder="Password" value={adminForm.password} onChange={(e) => setAdminForm({ ...adminForm, password: e.target.value })} required />
                  <input placeholder="Username (leave blank for auto-generated)" value={adminForm.username} onChange={(e) => setAdminForm({ ...adminForm, username: e.target.value })} />
                  <input placeholder="Employee/Manager ID (leave blank for auto-generated)" value={adminForm.employee_id} onChange={(e) => setAdminForm({ ...adminForm, employee_id: e.target.value })} />
                  <input placeholder="Department" value={adminForm.department} onChange={(e) => setAdminForm({ ...adminForm, department: e.target.value })} />
                  <input placeholder="Phone" value={adminForm.phone} onChange={(e) => setAdminForm({ ...adminForm, phone: e.target.value })} />
                  <label>
                    Role
                    <select value={adminForm.role} onChange={(e) => setAdminForm({ ...adminForm, role: e.target.value })}>
                      <option value="employee">Employee</option>
                      <option value="manager">Manager</option>
                    </select>
                  </label>
                  <button type="submit" disabled={adminSubmitting}>{adminSubmitting ? 'Creating account...' : 'Create account'}</button>
                </form>
                <p className="hint">Only admins can register employee or manager accounts.</p>
              </details>
            </section>
          )}

          {isAdmin && (
            <section className="card admin-action-card notice-action-card">
              <details className="admin-action-details" open={showNoticeSection} onToggle={(e) => setShowNoticeSection(e.target.open)}>
                <summary>Send notice</summary>
                <form onSubmit={(event) => { event.preventDefault(); submitNotice(); }} className="notice-form">
                  <label>
                    Recipient
                    <select
                      value={noticeForm.recipient}
                      onChange={(e) => setNoticeForm({ ...noticeForm, recipient: e.target.value })}
                      required
                    >
                      <option value="">Select a recipient</option>
                      {dashboard?.employees?.length > 0 && (
                        <optgroup label="Employees">
                          {dashboard.employees.map((user) => (
                            <option key={`employee-${user.user_id}`} value={user.user_id}>
                              {user.display_name || user.username} ({user.role})
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {dashboard?.managers?.length > 0 && (
                        <optgroup label="Managers">
                          {dashboard.managers.map((user) => (
                            <option key={`manager-${user.user_id}`} value={user.user_id}>
                              {user.display_name || user.username} ({user.role})
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </label>
                  <textarea
                    placeholder="Write a message for the recipient"
                    value={noticeForm.message}
                    onChange={(e) => setNoticeForm({ ...noticeForm, message: e.target.value })}
                    required
                  />
                  <button type="submit" disabled={noticeSubmitting}>{noticeSubmitting ? 'Sending notice...' : 'Send notice'}</button>
                </form>
              </details>
            </section>
          )}

          {(isAdmin || isManager || isEmployee) && (
            <section className="card">
              <div className="notice-toggle-row">
                <button type="button" className="toggle-button" onClick={toggleNoticePanel}>
                  {showNoticePanel ? 'Hide notices' : `View notices (${notices?.length || 0})`}
                </button>
                {showNoticePanel && (
                  <button type="button" className="secondary" onClick={() => loadNotices()}>
                    Refresh notices
                  </button>
                )}
              </div>
              {showNoticePanel && (
                <div className="notice-dropdown">
                  <h2>{isAdmin ? 'Sent notices' : 'Notices'}</h2>
                  {notices?.length > 0 ? (
                    <div className="notice-list">
                      {notices.map((notice) => (
                        <article className="notice-item" key={notice.id}>
                          <div className="notice-header">
                            <strong>
                              {isAdmin
                                ? `Notice sent to ${notice.recipient_name}`
                                : 'From Admin'}
                            </strong>
                            <span>{formatDateTime(notice.created_at)}</span>
                          </div>
                          <div className="notice-meta">
                            <span>{isAdmin ? `From ${notice.sender_name}` : `To ${notice.recipient_name}`}</span>
                          </div>
                          <p><strong>Notice:</strong> {notice.message}</p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="hint">No notices yet.</p>
                  )}
                </div>
              )}
            </section>
          )}

          {!isAdmin && attendanceRecordsSection}
        </>
      )}
    </div>
  );
}

export default App;
