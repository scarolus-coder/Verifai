'use strict';

/* ═══════════════════════════════════════════════════════════
   Verifai – Frontend Application
   ═══════════════════════════════════════════════════════════ */

// ─── STATE ────────────────────────────────────────────────────────────────────

const state = {
  projects: [],
  scenarios: [],
  suites: [],
  runs: [],
  actions: [],
  schedules: [],
  environments: [],
  currentProjectId: null,   // null = "All Projects"
  currentPage: 'dashboard',
  runningRun: null,          // { eventSource, runId }
  currentUser: null,         // logged-in user object
  allUsers: []               // cached for sharing/user mgmt
};

const DEVICES = {
  'desktop-1920':   { label: 'Desktop (1920×1080)',        width: 1920, height: 1080 },
  'desktop-1440':   { label: 'Desktop (1440×900)',         width: 1440, height: 900  },
  'laptop-1280':    { label: 'Laptop (1280×720)',          width: 1280, height: 720  },
  'tablet-ipad':    { label: 'iPad (768×1024)',            width: 768,  height: 1024 },
  'tablet-android': { label: 'Android Tablet (800×1280)',  width: 800,  height: 1280 },
  'mobile-iphone14':{ label: 'iPhone 14 (390×844)',        width: 390,  height: 844  },
  'mobile-iphonese':{ label: 'iPhone SE (375×667)',        width: 375,  height: 667  },
  'mobile-galaxy':  { label: 'Galaxy S23 (360×780)',       width: 360,  height: 780  },
  'custom':         { label: 'Custom...', width: null, height: null }
};

const STEP_TYPES = [
  { type: 'navigate',        label: 'Navigate',           desc: 'Go to a URL' },
  { type: 'click',           label: 'Click',              desc: 'Click an element' },
  { type: 'type',            label: 'Type',               desc: 'Fill in text' },
  { type: 'clearField',      label: 'Clear Field',        desc: 'Clear an input' },
  { type: 'assertText',      label: 'Assert Text',        desc: 'Check text content' },
  { type: 'assertVisible',   label: 'Assert Visible',     desc: 'Check element exists' },
  { type: 'assertNotVisible',label: 'Assert Not Visible', desc: 'Check element is hidden' },
  { type: 'assertURL',       label: 'Assert URL',         desc: 'Check current URL' },
  { type: 'assertAttribute', label: 'Assert Attribute',   desc: 'Check element attribute' },
  { type: 'assertCSS',       label: 'Assert CSS',         desc: 'Check computed style' },
  { type: 'waitForElement',  label: 'Wait For',           desc: 'Wait for element' },
  { type: 'waitForNetwork',  label: 'Wait Network Idle',  desc: 'Wait for all requests' },
  { type: 'waitSeconds',     label: 'Wait (seconds)',      desc: 'Pause for a fixed time' },
  { type: 'screenshot',      label: 'Screenshot',         desc: 'Capture screen' },
  { type: 'visualBaseline',  label: 'Visual Baseline',    desc: 'Compare screenshot' },
  { type: 'hover',           label: 'Hover',              desc: 'Hover over element' },
  { type: 'checkElement',    label: 'Check Checkbox',     desc: 'Check a checkbox or radio' },
  { type: 'runJS',           label: 'Run JavaScript',     desc: 'Execute JS on the page' },
  { type: 'selectOption',    label: 'Select Option',      desc: 'Choose from dropdown' },
  { type: 'pressKey',        label: 'Press Key',          desc: 'Keyboard key' },
  { type: 'scroll',          label: 'Scroll',             desc: 'Scroll page' },
  { type: 'scrollToElement', label: 'Scroll To Element',  desc: 'Scroll element into view' },
  { type: 'scrollElement',   label: 'Scroll Element',     desc: 'Scroll within a container element' },
  { type: 'newTab',          label: 'New Tab',            desc: 'Click opens a new tab' },
  { type: 'fileDownload',      label: 'File Download',        desc: 'Verify download' },
  { type: 'assertPDFContains', label: 'Assert PDF Contains',  desc: 'Download PDF and check its text' },
  { type: 'assertInViewport',    label: 'Assert In Viewport',    desc: 'Verify element is scrolled into view' },
  { type: 'assertNoNavigation',  label: 'Assert No Navigation',  desc: 'Verify page did not reload or navigate' },
  { type: 'assertElementSize',   label: 'Assert Element Size',   desc: 'Check element height/width as % of viewport' },
  { type: 'accessibilityScan',   label: 'Accessibility Scan',    desc: 'WCAG 2.2 AA check (axe-core) on the page or an element' },
  { type: 'compareURLs',         label: 'Compare URLs',          desc: 'Pixel-diff this page against another live URL (e.g. dev vs prod)' },
  { type: 'switchFrame',         label: 'Switch Frame',          desc: 'Enter an iframe' },
  { type: 'exitFrame',       label: 'Exit Frame',         desc: 'Leave iframe' },
  { type: 'closeTab',        label: 'Close Tab',          desc: 'Close current tab and return to previous' },
  { type: 'switchToNewTab',  label: 'Switch to New Tab',  desc: 'Wait for and switch to a newly opened tab' },
  { type: 'useAction',       label: 'Use Action',         desc: 'Run a saved group of steps' }
];

const TEST_TYPES = ['functional', 'regression', 'smoke', 'e2e', 'accessibility'];
const PROJECT_COLORS = ['#3b82f6','#8b5cf6','#22c55e','#f59e0b','#ef4444','#06b6d4','#ec4899','#f97316','#14b8a6','#6366f1'];

// ─── API HELPERS ──────────────────────────────────────────────────────────────

function getToken() { return localStorage.getItem('qa_token'); }
function setToken(t) { localStorage.setItem('qa_token', t); }
function clearToken() { localStorage.removeItem('qa_token'); }

async function api(method, path, body) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (r.status === 401) {
    clearToken();
    showAuthScreen();
    throw new Error('Session expired');
  }
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(r.ok ? 'Invalid server response' : `Server error (${r.status})`); }
  if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
  return json.data !== undefined ? json.data : json;
}

const GET    = (p)      => api('GET',    p);
const POST   = (p, b)   => api('POST',   p, b);
const PUT    = (p, b)   => api('PUT',    p, b);
const DEL    = (p)      => api('DELETE', p);
const PATCH  = (p, b)   => api('PATCH',  p, b);

// ─── AUTH FLOW ────────────────────────────────────────────────────────────────

function showAuthScreen() {
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('app').style.display = 'none';
}

function hideAuthScreen() {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('app').style.display = '';
}

async function initAuth() {
  // Check if setup needed
  try {
    const r = await fetch('/api/auth/setup');
    const json = await r.json();
    if (json.data?.needsSetup) {
      document.getElementById('authScreen').classList.remove('hidden');
      document.getElementById('setupCard').classList.remove('hidden');
      return false;
    }
  } catch {}

  // Try existing token
  const token = getToken();
  if (token) {
    try {
      const me = await (async () => {
        const r = await fetch('/api/auth/me', { headers: { 'Authorization': `Bearer ${token}` } });
        if (!r.ok) return null;
        const j = await r.json();
        return j.data;
      })();
      if (me) {
        state.currentUser = me;
        return true;
      }
    } catch {}
  }

  // Show login
  clearToken();
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('loginCard').classList.remove('hidden');
  return false;
}

async function submitSetup() {
  const name     = document.getElementById('setupName').value.trim();
  const email    = document.getElementById('setupEmail').value.trim();
  const password = document.getElementById('setupPassword').value;
  const confirm  = document.getElementById('setupConfirm').value;
  const errEl    = document.getElementById('setupError');
  errEl.classList.add('hidden');

  if (!name || !email || !password) { errEl.textContent = 'All fields are required.'; errEl.classList.remove('hidden'); return; }
  if (password !== confirm) { errEl.textContent = 'Passwords do not match.'; errEl.classList.remove('hidden'); return; }

  const btn = document.getElementById('setupBtn');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const data = await (async () => {
      const r = await fetch('/api/auth/setup', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name, email, password}) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Setup failed');
      return j.data;
    })();
    setToken(data.token);
    state.currentUser = data.user;
    hideAuthScreen();
    startApp();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
    btn.disabled = false; btn.textContent = 'Create Admin Account';
  }
}

async function submitLogin() {
  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl    = document.getElementById('loginError');
  errEl.classList.add('hidden');

  if (!email || !password) { errEl.textContent = 'Email and password are required.'; errEl.classList.remove('hidden'); return; }

  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const data = await (async () => {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email, password}) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Login failed');
      return j.data;
    })();
    setToken(data.token);
    state.currentUser = data.user;
    hideAuthScreen();
    startApp();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

function showLoginCard() {
  document.getElementById('loginCard').classList.remove('hidden');
  document.getElementById('registerCard').classList.add('hidden');
  document.getElementById('loginEmail').focus();
}

function showRegisterCard() {
  document.getElementById('registerCard').classList.remove('hidden');
  document.getElementById('loginCard').classList.add('hidden');
  document.getElementById('registerName').focus();
}

async function submitRegister() {
  const name     = document.getElementById('registerName').value.trim();
  const email    = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPassword').value;
  const confirm  = document.getElementById('registerConfirm').value;
  const errEl    = document.getElementById('registerError');
  errEl.classList.add('hidden');

  if (!name || !email || !password) { errEl.textContent = 'All fields are required.'; errEl.classList.remove('hidden'); return; }
  if (password !== confirm) { errEl.textContent = 'Passwords do not match.'; errEl.classList.remove('hidden'); return; }
  if (password.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; errEl.classList.remove('hidden'); return; }

  const btn = document.getElementById('registerBtn');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const r = await fetch('/api/auth/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name, email, password}) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Registration failed');
    setToken(j.data.token);
    state.currentUser = j.data.user;
    hideAuthScreen();
    startApp();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
    btn.disabled = false; btn.textContent = 'Create Account';
  }
}

// Allow Enter key on login/setup/register forms
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (!document.getElementById('authScreen').classList.contains('hidden')) {
    if (!document.getElementById('setupCard').classList.contains('hidden')) submitSetup();
    else if (!document.getElementById('registerCard').classList.contains('hidden')) submitRegister();
    else if (!document.getElementById('loginCard').classList.contains('hidden')) submitLogin();
  }
});

function signOut() {
  clearToken();
  state.currentUser = null;
  state.projects = [];
  state.scenarios = [];
  state.suites = [];
  state.runs = [];
  state.actions = [];
  state.schedules = [];
  state.environments = [];
  state.currentProjectId = null;
  state.allUsers = [];
  // Reset login card
  document.getElementById('loginEmail').value = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').classList.add('hidden');
  document.getElementById('loginBtn').disabled = false;
  document.getElementById('loginBtn').textContent = 'Sign In';
  document.getElementById('loginCard').classList.remove('hidden');
  document.getElementById('setupCard').classList.add('hidden');
  showAuthScreen();
}

// ─── TOPBAR USER MENU ─────────────────────────────────────────────────────────

function renderTopbarUser() {
  const user = state.currentUser;
  if (!user) return;
  const avatarEl = document.getElementById('topbarAvatar');
  const nameEl   = document.getElementById('topbarUserName');
  avatarEl.innerHTML = userInitials(user.name);
  avatarEl.style.background = user.role === 'admin' ? '#3b82f6' : '#64748b';
  nameEl.textContent = user.name;

  // Show Users nav for admins
  const usersLi = document.getElementById('nav-users-li');
  if (usersLi) usersLi.classList.toggle('hidden', user.role !== 'admin');
}

function userInitials(name) {
  const parts = (name || '').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
  return (name || '?').slice(0, 2).toUpperCase();
}

function toggleUserMenu() {
  document.getElementById('userDropdown').classList.toggle('hidden');
}

function closeUserMenu() {
  document.getElementById('userDropdown').classList.add('hidden');
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const authed = await initAuth();
  if (authed) startApp();

  document.addEventListener('click', (e) => {
    if (!document.getElementById('projectPickerWrap').contains(e.target)) {
      document.getElementById('projectDropdown')?.classList.add('hidden');
    }
    if (!document.getElementById('userMenuWrap').contains(e.target)) {
      document.getElementById('userDropdown')?.classList.add('hidden');
    }
  });
});

async function startApp() {
  hideAuthScreen();
  renderTopbarUser();
  if (state.currentUser?.role === 'admin') {
    try { state.allUsers = await GET('/api/users'); } catch { state.allUsers = []; }
  }
  await loadProjects();
  renderProjectDropdown();
  updateEnvNavVisibility();
  const hash = location.hash.replace(/^#/, '');
  if (hash) {
    const [page, params] = hash.split(':');
    navigate(page, params);
  } else {
    navigate('dashboard');
  }
}

async function loadProjects() {
  try { state.projects = await GET('/api/projects'); }
  catch { state.projects = []; }
}

async function loadScenarios() {
  try {
    const qs = state.currentProjectId ? `?projectId=${state.currentProjectId}` : '';
    state.scenarios = await GET(`/api/scenarios${qs}`);
  } catch { state.scenarios = []; }
}

async function loadSuites() {
  try {
    const qs = state.currentProjectId ? `?projectId=${state.currentProjectId}` : '';
    state.suites = await GET(`/api/suites${qs}`);
  } catch { state.suites = []; }
}

async function loadRuns() {
  try {
    const qs = state.currentProjectId ? `?projectId=${state.currentProjectId}` : '';
    state.runs = await GET(`/api/runs${qs}`);
  } catch { state.runs = []; }
}

async function loadActions() {
  try {
    const qs = state.currentProjectId ? `?projectId=${state.currentProjectId}` : '';
    state.actions = await GET(`/api/actions${qs}`);
  } catch { state.actions = []; }
}

async function loadSchedules() {
  try {
    const qs = state.currentProjectId ? `?projectId=${state.currentProjectId}` : '';
    state.schedules = await GET(`/api/schedules${qs}`);
  } catch { state.schedules = []; }
}

async function loadEnvironments() {
  try {
    const qs = state.currentProjectId ? `?projectId=${state.currentProjectId}` : '';
    state.environments = await GET(`/api/environments${qs}`);
  } catch { state.environments = []; }
}

// ─── NAVIGATION ───────────────────────────────────────────────────────────────

async function navigate(page, params) {
  state.currentPage = page;
  location.hash = params ? `${page}:${params}` : page;
  document.querySelectorAll('.sidebar-nav button').forEach(b => b.classList.remove('active'));
  const navBtn = document.getElementById(`nav-${page.split('-')[0]}`);
  if (navBtn) navBtn.classList.add('active');

  const main = document.getElementById('mainContent');
  main.innerHTML = '<div style="padding:40px;text-align:center;color:#64748b">Loading…</div>';

  switch (page) {
    case 'dashboard':     await renderDashboard(); break;
    case 'scenarios':     await renderScenarios(); break;
    case 'actions':       await renderActionsPage(); break;
    case 'suites':        await renderSuites(); break;
    case 'suite-detail':  await renderSuiteDetail(params); break;
    case 'reports':       await renderReports(); break;
    case 'run-detail':    await renderRunDetail(params); break;
    case 'schedules':     await renderSchedulesPage(); break;
    case 'environments':  await renderEnvironmentsPage(); break;
    case 'users':         await renderUsersPage(); break;
    case 'account':       await renderAccountPage(); break;
    default: await renderDashboard();
  }
}

function handleTopNew() {
  switch (state.currentPage) {
    case 'dashboard':  openScenarioBuilder(null); break;
    case 'scenarios':  openScenarioBuilder(null); break;
    case 'actions':    openActionBuilder(null); break;
    case 'suites':     openSuiteModal(null); break;
    case 'reports':    navigate('scenarios'); break;
    case 'schedules':  openScheduleModal(null); break;
    default:           openScenarioBuilder(null); break;
  }
}

// ─── PROJECT PICKER ───────────────────────────────────────────────────────────

function renderProjectDropdown() {
  const dd = document.getElementById('projectDropdown');
  const current = state.projects.find(p => p.id === state.currentProjectId);
  const btn = document.getElementById('projectPickerBtn');
  const dot = document.getElementById('projectDot');
  const name = document.getElementById('projectPickerName');

  if (current) {
    dot.style.background = current.color || '#3b82f6';
    name.textContent = current.name;
  } else {
    dot.style.background = '#64748b';
    name.textContent = 'All Projects';
  }

  let html = `<div class="pd-item ${!state.currentProjectId ? 'active' : ''}" onclick="selectProject(null)">
    <span style="width:8px;height:8px;border-radius:50%;background:#64748b;display:inline-block"></span>
    All Projects
  </div>
  <div class="pd-divider"></div>`;

  html += state.projects.map(p => `
    <div class="pd-item ${p.id === state.currentProjectId ? 'active' : ''}" onclick="selectProject('${p.id}')">
      <span style="width:8px;height:8px;border-radius:50%;background:${p.color || '#3b82f6'};display:inline-block;flex-shrink:0"></span>
      ${esc(p.name)}
    </div>
  `).join('');

  html += `<div class="pd-divider"></div>
  <div class="pd-item new-project" onclick="openProjectModal(null);closeProjectDropdown()">
    + New Project
  </div>`;

  dd.innerHTML = html;
}

function toggleProjectDropdown() {
  document.getElementById('projectDropdown').classList.toggle('hidden');
}

function closeProjectDropdown() {
  document.getElementById('projectDropdown').classList.add('hidden');
}

async function selectProject(id) {
  state.currentProjectId = id;
  closeProjectDropdown();
  renderProjectDropdown();
  updateEnvNavVisibility();
  await navigate(state.currentPage);
}

function updateEnvNavVisibility() {
  const li = document.getElementById('nav-environments-li');
  if (li) li.classList.toggle('hidden', !state.currentProjectId);
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

async function renderDashboard() {
  await Promise.all([loadScenarios(), loadSuites(), loadRuns()]);

  const project = state.projects.find(p => p.id === state.currentProjectId);
  const passedRuns = state.runs.filter(r => r.status === 'passed').length;
  const totalRuns = state.runs.length;
  const passRate = totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 100) : 0;
  const lastRun = state.runs[0];

  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${project ? esc(project.name) : 'Dashboard'}</h1>
        <div class="subtitle">${project ? (esc(project.description) || esc(project.baseUrl) || '') : 'Overview of all projects'}</div>
      </div>
      <div style="display:flex;gap:8px">
        ${project ? `<button class="btn btn-secondary" onclick="openProjectModal('${project.id}')">Edit Project</button>` : ''}
        ${project && (state.currentUser?.role === 'admin' || project.ownerId === state.currentUser?.id) ? `<button class="btn btn-danger" onclick="deleteProject('${project.id}')">Delete Project</button>` : ''}
        <button class="btn btn-primary" onclick="openScenarioBuilder(null)">+ New Scenario</button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Scenarios</div>
        <div class="stat-value">${state.scenarios.length}</div>
        <div class="stat-sub">test scenarios</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Suites</div>
        <div class="stat-value">${state.suites.length}</div>
        <div class="stat-sub">test suites</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Runs</div>
        <div class="stat-value">${totalRuns}</div>
        <div class="stat-sub">${lastRun ? 'last: ' + timeAgo(lastRun.startedAt) : 'no runs yet'}</div>
      </div>
    </div>

    ${!state.currentProjectId && state.projects.length > 0 ? `
    <div style="margin-bottom:28px">
      <div class="card-header" style="background:#fff;border:1px solid var(--border);border-radius:8px 8px 0 0;padding:14px 20px">
        <h2>Projects</h2>
        <button class="btn btn-sm btn-primary" onclick="openProjectModal(null)">+ New Project</button>
      </div>
      <div class="project-grid" style="background:#f8fafc;border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;padding:16px">
        ${state.projects.map(p => projectCardHTML(p)).join('')}
        <div class="project-card" style="border:2px dashed var(--border);box-shadow:none;display:flex;align-items:center;justify-content:center;cursor:pointer;min-height:140px" onclick="openProjectModal(null)">
          <div style="text-align:center;color:var(--muted)">
            <div style="font-size:28px;margin-bottom:6px">+</div>
            <div style="font-size:13px;font-weight:500">New Project</div>
          </div>
        </div>
      </div>
    </div>` : ''}

    ${!state.currentProjectId && state.projects.length === 0 ? `
    <div class="empty-state">
      <div class="es-icon">🗂️</div>
      <h3>No projects yet</h3>
      <p>Create your first project to get started organizing your test scenarios.</p>
      <button class="btn btn-primary" onclick="openProjectModal(null)">Create First Project</button>
    </div>` : ''}

    ${state.runs.length > 0 ? `
    <div class="card">
      <div class="card-header">
        <h2>Recent Runs</h2>
        <button class="btn btn-sm btn-ghost" onclick="navigate('reports')">View all →</button>
      </div>
      <div class="table-wrapper" style="border:none;border-radius:0">
        <table>
          <thead><tr>
            <th>Name</th>
            <th>Type</th>
            <th>Browser</th>
            <th>Status</th>
            <th>Pass Rate</th>
            <th>Date</th>
            <th>Duration</th>
          </tr></thead>
          <tbody>
            ${state.runs.slice(0, 10).map(r => `
            <tr class="clickable" onclick="navigate('run-detail','${r.id}')">
              <td><strong>${esc(r.name)}</strong></td>
              <td>${r.type}</td>
              <td>${browserIcon(r.browser)} ${r.browser}</td>
              <td><span class="badge badge-${r.status}">${r.status}</span></td>
              <td>${r.summary ? r.summary.passRate + '%' : '—'}</td>
              <td>${formatDate(r.startedAt)}</td>
              <td>${r.duration ? (r.duration/1000).toFixed(1)+'s' : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    ${state.scenarios.length === 0 && state.currentProjectId ? `
    <div class="empty-state">
      <div class="es-icon">🧩</div>
      <h3>No scenarios yet</h3>
      <p>Create your first test scenario for this project.</p>
      <button class="btn btn-primary" onclick="openScenarioBuilder(null)">Create Scenario</button>
    </div>` : ''}
  `;
}

function projectCardHTML(p) {
  const scenCount = state.scenarios.filter(s => s.projectId === p.id).length;
  const suiteCount = state.suites.filter(s => s.projectId === p.id).length;
  const lastRun = state.runs.find(r => r.projectId === p.id);
  const canShare = state.currentUser && (state.currentUser.role === 'admin' || p.ownerId === state.currentUser.id);
  const canEdit  = state.currentUser && (state.currentUser.role === 'admin' || p.ownerId === state.currentUser.id || !p.ownerId);
  return `<div class="project-card" onclick="selectProject('${p.id}')">
    <div class="pc-color-bar" style="background:${p.color || '#3b82f6'}"></div>
    <div class="pc-title">${esc(p.name)}</div>
    <div class="pc-desc">${esc(p.description || '')}</div>
    ${p.baseUrl ? `<div class="pc-url">🔗 ${esc(p.baseUrl)}</div>` : ''}
    <div class="pc-stats">
      <span>🧩 ${scenCount} scenarios</span>
      <span>📦 ${suiteCount} suites</span>
      ${lastRun ? `<span>🕐 ${timeAgo(lastRun.startedAt)}</span>` : ''}
    </div>
    <div class="pc-actions">
      ${canShare ? `<button class="btn btn-xs btn-secondary" onclick="event.stopPropagation();openShareProjectModal('${p.id}')">Share</button>` : ''}
      ${canEdit  ? `<button class="btn btn-xs btn-secondary" onclick="event.stopPropagation();openProjectModal('${p.id}')">Edit</button>` : ''}
      ${canEdit  ? `<button class="btn btn-xs btn-danger" onclick="event.stopPropagation();deleteProject('${p.id}')">Delete</button>` : ''}
    </div>
  </div>`;
}

// ─── SCENARIOS PAGE ───────────────────────────────────────────────────────────

async function renderScenarios() {
  await loadScenarios();
  const main = document.getElementById('mainContent');

  if (state.scenarios.length === 0) {
    main.innerHTML = `
      <div class="page-header">
        <h1>Scenarios</h1>
        <button class="btn btn-primary" onclick="openScenarioBuilder(null)">+ New Scenario</button>
      </div>
      <div class="empty-state">
        <div class="es-icon">🧩</div>
        <h3>No scenarios yet</h3>
        <p>Scenarios are individual test cases — like "login with valid credentials" or "submit the contact form".</p>
        <button class="btn btn-primary" onclick="openScenarioBuilder(null)">Create First Scenario</button>
      </div>`;
    return;
  }

  main.innerHTML = `
    <div class="page-header">
      <div><h1>Scenarios</h1><div class="subtitle">${state.scenarios.length} scenario${state.scenarios.length !== 1 ? 's' : ''}</div></div>
      <button class="btn btn-primary" onclick="openScenarioBuilder(null)">+ New Scenario</button>
    </div>
    <div class="filter-bar">
      <input class="form-control search-input" type="text" placeholder="Search scenarios…" id="scenarioSearch" oninput="filterScenarios()" />
      <select class="form-control" id="scenarioTypeFilter" onchange="filterScenarios()">
        <option value="">All types</option>
        ${TEST_TYPES.map(t => `<option value="${t}">${capitalize(t)}</option>`).join('')}
      </select>
    </div>
    <div class="scenario-list" id="scenarioList">
      ${renderScenarioCards(state.scenarios)}
    </div>`;
}

function renderScenarioCards(scenarios) {
  if (scenarios.length === 0) return `<div class="empty-state" style="padding:40px"><div class="es-icon">🔍</div><h3>No results</h3><p>Try adjusting your search or filters.</p></div>`;
  return scenarios.map(s => {
    const lastRun = state.runs.find(r => r.scenarioId === s.id);
    return `<div class="scenario-card">
      <span class="badge badge-${s.testType || 'functional'}">${capitalize(s.testType || 'functional')}</span>
      <div class="sc-info">
        <div class="sc-name">${esc(s.name)}</div>
        <div class="sc-meta">
          <span>${s.steps.length} step${s.steps.length !== 1 ? 's' : ''}</span>
          ${(s.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
          ${lastRun ? `<span class="badge badge-${lastRun.status}" style="font-size:10px">${lastRun.status}</span>` : ''}
          <span class="text-muted text-sm">${timeAgo(s.updatedAt)}</span>
        </div>
      </div>
      <div class="sc-actions">
        <button class="btn btn-sm btn-ghost" onclick="openRunModal('scenario','${s.id}')" data-tooltip="Run">▶ Run</button>
        ${(s.variables && s.variables.length > 0) ? `<button class="btn btn-sm btn-ghost" onclick="openDataDrivenModal('${s.id}')" data-tooltip="Run with CSV data" style="color:#7c3aed">⚡ Data</button>` : ''}
        <button class="btn btn-sm btn-ghost" onclick="openScenarioBuilder('${s.id}')" data-tooltip="Edit">✏️</button>
        <button class="btn btn-sm btn-ghost" onclick="cloneScenario('${s.id}')" data-tooltip="Clone">⧉</button>
        <button class="btn btn-sm btn-ghost" onclick="deleteScenario('${s.id}')" data-tooltip="Delete" style="color:var(--error)">🗑️</button>
      </div>
    </div>`;
  }).join('');
}

function filterScenarios() {
  const q = document.getElementById('scenarioSearch').value.toLowerCase();
  const type = document.getElementById('scenarioTypeFilter').value;
  let filtered = state.scenarios;
  if (q) filtered = filtered.filter(s => s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q));
  if (type) filtered = filtered.filter(s => s.testType === type);
  document.getElementById('scenarioList').innerHTML = renderScenarioCards(filtered);
}

// ─── SUITES PAGE ──────────────────────────────────────────────────────────────

async function renderSuites() {
  await loadSuites();
  const main = document.getElementById('mainContent');

  if (state.suites.length === 0) {
    main.innerHTML = `
      <div class="page-header">
        <h1>Suites</h1>
        <button class="btn btn-primary" onclick="openSuiteModal(null)">+ New Suite</button>
      </div>
      <div class="empty-state">
        <div class="es-icon">📦</div>
        <h3>No suites yet</h3>
        <p>Suites group multiple scenarios together so you can run them all at once — like a "Regression Suite" or "Smoke Tests".</p>
        <button class="btn btn-primary" onclick="openSuiteModal(null)">Create First Suite</button>
      </div>`;
    return;
  }

  main.innerHTML = `
    <div class="page-header">
      <div><h1>Suites</h1><div class="subtitle">${state.suites.length} suite${state.suites.length !== 1 ? 's' : ''}</div></div>
      <button class="btn btn-primary" onclick="openSuiteModal(null)">+ New Suite</button>
    </div>
    <div class="suite-grid">
      ${state.suites.map(suite => suiteCardHTML(suite)).join('')}
    </div>`;
}

function suiteCardHTML(suite) {
  const count = (suite.scenarioIds || []).length;
  const lastRun = state.runs.find(r => r.suiteId === suite.id);
  return `<div class="suite-card" onclick="navigate('suite-detail','${suite.id}')">
    <div style="display:flex;justify-content:space-between;align-items:start">
      <div class="suite-name">${esc(suite.name)}</div>
      <div style="display:flex;gap:4px">
        <button class="btn btn-xs btn-secondary" onclick="event.stopPropagation();openSuiteModal('${suite.id}')">Edit</button>
        <button class="btn btn-xs btn-danger" onclick="event.stopPropagation();deleteSuite('${suite.id}')">Delete</button>
      </div>
    </div>
    <div class="suite-desc">${esc(suite.description || 'No description')}</div>
    <div class="suite-meta">
      <span>🧩 ${count} scenario${count !== 1 ? 's' : ''}</span>
      <div style="display:flex;gap:8px;align-items:center">
        ${lastRun ? `<span class="badge badge-${lastRun.status}">${lastRun.status}</span>` : '<span class="text-muted text-sm">never run</span>'}
        <button class="btn btn-xs btn-primary" onclick="event.stopPropagation();openRunModal('suite','${suite.id}')">▶ Run</button>
      </div>
    </div>
  </div>`;
}

// ─── SUITE DETAIL ─────────────────────────────────────────────────────────────

async function renderSuiteDetail(suiteId) {
  await loadScenarios();
  await loadSuites();
  const suite = state.suites.find(s => s.id === suiteId);
  if (!suite) return navigate('suites');

  const suiteScenarios = (suite.scenarioIds || [])
    .map(id => state.scenarios.find(s => s.id === id))
    .filter(Boolean);

  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="page-header">
      <div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:4px"><button class="btn btn-ghost btn-sm" onclick="navigate('suites')" style="padding:0;font-size:13px">← Suites</button></div>
        <h1>${esc(suite.name)}</h1>
        <div class="subtitle">${esc(suite.description || '')}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" onclick="openAddScenarioToSuiteModal('${suite.id}')">+ Add Scenarios</button>
        <button class="btn btn-primary" onclick="openRunModal('suite','${suite.id}')">▶ Run Suite</button>
      </div>
    </div>

    ${suiteScenarios.length === 0 ? `
    <div class="empty-state">
      <div class="es-icon">🧩</div>
      <h3>No scenarios in this suite</h3>
      <p>Add existing scenarios to this suite to run them together.</p>
      <button class="btn btn-primary" onclick="openAddScenarioToSuiteModal('${suite.id}')">Add Scenarios</button>
    </div>` : `
    <div class="card">
      <div class="card-header">
        <h2>${suiteScenarios.length} Scenario${suiteScenarios.length !== 1 ? 's' : ''}</h2>
      </div>
      <div class="scenario-list" style="padding:12px 16px">
        ${suiteScenarios.map(s => `
        <div class="scenario-card">
          <span class="badge badge-${s.testType || 'functional'}">${capitalize(s.testType || 'functional')}</span>
          <div class="sc-info">
            <div class="sc-name">${esc(s.name)}</div>
            <div class="sc-meta"><span>${s.steps.length} steps</span></div>
          </div>
          <div class="sc-actions">
            <button class="btn btn-sm btn-ghost" onclick="openScenarioBuilder('${s.id}')">✏️ Edit</button>
            <button class="btn btn-sm btn-ghost" style="color:var(--error)" onclick="removeFromSuite('${suite.id}','${s.id}')">✕ Remove</button>
          </div>
        </div>`).join('')}
      </div>
    </div>`}
  `;
}

async function removeFromSuite(suiteId, scenarioId) {
  try {
    await PATCH(`/api/suites/${suiteId}/scenarios`, { remove: [scenarioId] });
    toast('Scenario removed from suite', 'success');
    navigate('suite-detail', suiteId);
  } catch (e) {
    toast('Failed to remove scenario: ' + e.message, 'error');
  }
}

// ─── REPORTS PAGE ─────────────────────────────────────────────────────────────

async function renderReports() {
  await loadRuns();
  const main = document.getElementById('mainContent');

  if (state.runs.length === 0) {
    main.innerHTML = `
      <div class="page-header"><h1>Reports</h1></div>
      <div class="empty-state">
        <div class="es-icon">📋</div>
        <h3>No runs yet</h3>
        <p>Run a scenario or suite to see results here.</p>
        <button class="btn btn-primary" onclick="navigate('scenarios')">Go to Scenarios</button>
      </div>`;
    return;
  }

  main.innerHTML = `
    <div class="page-header">
      <div><h1>Reports</h1><div class="subtitle">${state.runs.length} run${state.runs.length !== 1 ? 's' : ''}</div></div>
    </div>
    <div class="filter-bar" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div style="display:flex;gap:8px">
        <select class="form-control" id="reportStatusFilter" onchange="filterReports()">
          <option value="">All statuses</option>
          <option value="passed">Passed</option>
          <option value="failed">Failed</option>
          <option value="error">Error</option>
        </select>
        <select class="form-control" id="reportBrowserFilter" onchange="filterReports()">
          <option value="">All browsers</option>
          <option value="chromium">Chrome</option>
          <option value="firefox">Firefox</option>
          <option value="webkit">Safari</option>
        </select>
      </div>
      <div id="bulkActionsBar" style="display:none;align-items:center;gap:8px">
        <span id="bulkSelectedCount" style="font-size:13px;color:var(--muted)"></span>
        <button class="btn btn-sm btn-secondary" onclick="bulkEmailRuns()">Email Selected</button>
        <button class="btn btn-sm btn-danger" onclick="bulkDeleteRuns()">Delete Selected</button>
      </div>
    </div>
    <div class="table-wrapper" id="runsTable">
      ${renderRunsTable(state.runs)}
    </div>`;
}

function renderRunsTable(runs) {
  if (runs.length === 0) return `<div style="padding:40px;text-align:center;color:var(--muted)">No results</div>`;
  return `<table>
    <thead><tr>
      <th style="width:36px;padding:8px 4px 8px 12px"><input type="checkbox" id="selectAllRuns" onchange="toggleSelectAllRuns(this)" title="Select all"></th>
      <th style="width:60px">#</th>
      <th>Name</th>
      <th>Type</th>
      <th>Browser</th>
      <th>Device</th>
      <th>Status</th>
      <th>Pass Rate</th>
      <th>Date</th>
      <th>Duration</th>
      <th></th>
    </tr></thead>
    <tbody>
      ${runs.map(r => `
      <tr class="clickable" onclick="navigate('run-detail','${r.id}')">
        <td style="padding:8px 4px 8px 12px" onclick="event.stopPropagation()"><input type="checkbox" class="run-checkbox" value="${r.id}" onchange="updateBulkBar()"></td>
        <td style="color:var(--muted);font-size:12px;font-weight:600">${r.jobNumber ? '#' + r.jobNumber : '—'}</td>
        <td>
          <strong>${esc(r.name)}</strong>
          ${r.triggeredBy === 'schedule' ? `<span class="badge badge-scheduled" style="margin-left:6px;font-size:10px">⏰ Scheduled</span>` : ''}
          ${r.environmentName ? `<span class="env-badge-default" style="margin-left:6px">${esc(r.environmentName)}</span>` : ''}
          ${r.type === 'data-driven' ? `<span class="badge" style="background:#f5f3ff;color:#7c3aed;margin-left:6px;font-size:10px">⚡ Data</span>` : ''}
        </td>
        <td>${r.type}</td>
        <td>${browserIcon(r.browser)} ${r.browser}</td>
        <td>${deviceIcon(r.device)} <span style="font-size:11px">${DEVICES[r.device]?.label || r.device || ''}</span></td>
        <td><span class="badge badge-${r.status}">${r.status}</span></td>
        <td>
          ${r.summary ? `<div style="display:flex;align-items:center;gap:8px">
            <div class="progress-bar" style="width:60px"><div class="fill ${r.status}" style="width:${r.summary.passRate}%"></div></div>
            <span style="font-size:12px">${r.summary.passRate}%</span>
          </div>` : '—'}
        </td>
        <td>${formatDate(r.startedAt)}</td>
        <td>${r.duration ? (r.duration/1000).toFixed(1)+'s' : '—'}</td>
        <td style="display:flex;gap:4px">
          <button class="btn btn-xs btn-secondary" onclick="event.stopPropagation();shareReport('${r.id}')">Share</button>
          <button class="btn btn-xs btn-secondary" onclick="event.stopPropagation();emailReport('${r.id}')">Email</button>
          <button class="btn btn-xs btn-danger" onclick="event.stopPropagation();deleteRun('${r.id}')">Delete</button>
        </td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function filterReports() {
  const status = document.getElementById('reportStatusFilter').value;
  const browser = document.getElementById('reportBrowserFilter').value;
  let filtered = state.runs;
  if (status) filtered = filtered.filter(r => r.status === status);
  if (browser) filtered = filtered.filter(r => r.browser === browser);
  document.getElementById('runsTable').innerHTML = renderRunsTable(filtered);
  updateBulkBar();
}

function toggleSelectAllRuns(cb) {
  document.querySelectorAll('.run-checkbox').forEach(c => c.checked = cb.checked);
  updateBulkBar();
}

function updateBulkBar() {
  const all = document.querySelectorAll('.run-checkbox');
  const selected = document.querySelectorAll('.run-checkbox:checked');
  const bar = document.getElementById('bulkActionsBar');
  const countEl = document.getElementById('bulkSelectedCount');
  const selectAll = document.getElementById('selectAllRuns');
  if (bar) bar.style.display = selected.length > 0 ? 'flex' : 'none';
  if (countEl) countEl.textContent = `${selected.length} selected`;
  if (selectAll) {
    selectAll.checked = all.length > 0 && selected.length === all.length;
    selectAll.indeterminate = selected.length > 0 && selected.length < all.length;
  }
}

function getSelectedRunIds() {
  return [...document.querySelectorAll('.run-checkbox:checked')].map(c => c.value);
}

async function bulkDeleteRuns() {
  const ids = getSelectedRunIds();
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} run${ids.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;
  try {
    await POST('/api/runs/bulk-delete', { ids });
    state.runs = state.runs.filter(r => !ids.includes(r.id));
    toast(`Deleted ${ids.length} run${ids.length !== 1 ? 's' : ''}`, 'success');
    await renderReports();
  } catch (e) {
    toast('Failed to delete: ' + e.message, 'error');
  }
}

function bulkEmailRuns() {
  const ids = getSelectedRunIds();
  if (!ids.length) return;
  const bodyHTML = `
    <div class="form-group">
      <label class="form-label">Recipient Email</label>
      <input type="text" id="emailReportTo" class="form-control" placeholder="client@example.com, colleague@example.com" autofocus>
      <div class="form-hint">Separate multiple addresses with a comma</div>
    </div>
    <div class="form-group" style="margin-top:12px">
      <label class="form-label">Message <span style="color:var(--muted);font-weight:400">(optional)</span></label>
      <textarea id="emailReportMessage" class="form-control" rows="3" placeholder="Add a note to include in the email…" style="resize:vertical"></textarea>
    </div>
    <p style="font-size:13px;color:var(--muted);margin-top:8px">${ids.length} report${ids.length !== 1 ? 's' : ''} will be sent.</p>`;
  openModal(`Email ${ids.length} Report${ids.length !== 1 ? 's' : ''}`, bodyHTML, 'modal-sm', async () => {
    const to = document.getElementById('emailReportTo').value.trim();
    const message = document.getElementById('emailReportMessage').value.trim();
    if (!to) { toast('Please enter a recipient email', 'error'); return false; }
    let sent = 0, failed = 0;
    for (const id of ids) {
      try { await POST(`/api/runs/${id}/email`, { to, message }); sent++; }
      catch { failed++; }
    }
    if (failed === 0) toast(`Sent ${sent} report${sent !== 1 ? 's' : ''} to ${to}`, 'success');
    else toast(`Sent ${sent}, failed to send ${failed}`, 'warning');
  }, 'Send Reports');
}

function shareReport(runId) {
  const url = window.location.origin + '/report/' + runId;
  navigator.clipboard.writeText(url).then(() => toast('Report URL copied to clipboard', 'success'));
}

function emailReport(runId) {
  const bodyHTML = `
    <div class="form-group">
      <label class="form-label">Recipient Email</label>
      <input type="text" id="emailReportTo" class="form-control" placeholder="client@example.com, colleague@example.com" autofocus>
      <div class="form-hint">Separate multiple addresses with a comma</div>
    </div>
    <div class="form-group" style="margin-top:12px">
      <label class="form-label">Message <span style="color:var(--muted);font-weight:400">(optional)</span></label>
      <textarea id="emailReportMessage" class="form-control" rows="3" placeholder="Add a note to include in the email…" style="resize:vertical"></textarea>
    </div>`;

  openModal('Email Report', bodyHTML, 'modal-sm', async () => {
    const to = document.getElementById('emailReportTo').value.trim();
    const message = document.getElementById('emailReportMessage').value.trim();
    if (!to) { toast('Please enter a recipient email', 'error'); return false; }
    try {
      await POST(`/api/runs/${runId}/email`, { to, message });
    } catch (e) {
      toast(e.message || 'Failed to send email', 'error');
      return false;
    }
    toast('Report sent to ' + to, 'success');
  }, 'Send Email');
}

async function deleteRun(id) {
  if (!confirm('Delete this run? This cannot be undone.')) return;
  try {
    await DEL(`/api/runs/${id}`);
    state.runs = state.runs.filter(r => r.id !== id);
    toast('Run deleted', 'success');
    await renderReports();
  } catch (e) {
    toast('Failed to delete run: ' + e.message, 'error');
  }
}

// ─── RUN DETAIL ───────────────────────────────────────────────────────────────

async function renderRunDetail(runId) {
  let run;
  try { run = await GET(`/api/runs/${runId}`); }
  catch { return navigate('reports'); }

  const main = document.getElementById('mainContent');

  // Data-driven run view
  if (run.type === 'data-driven') {
    const rows = run.rows || [];
    const passed = rows.filter(r => r.status === 'passed').length;
    const rowsHTML = rows.map((row, i) => {
      const rowColor = row.status === 'passed' ? 'var(--success)' : 'var(--error)';
      const accId = `dd-row-${i}`;
      const varChips = Object.entries(row.variables || {}).map(([k, v]) =>
        `<span class="variable-name-preview">${esc(k)}=${esc(v)}</span>`).join(' ');
      const stepRows = (row.steps || []).map(step => {
        const cls = step.status === 'passed' ? 'passed' : step.status === 'failed' ? 'failed' : 'skipped';
        const ic = step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '–';
        return `<div class="step-result-row">
          <div class="step-result-num ${cls}">${ic}</div>
          <div class="step-result-info">
            <div class="step-result-desc">${esc(step.description || step.type)}</div>
            ${step.message ? `<div class="step-result-msg">${esc(step.message)}</div>` : ''}
            ${step.autoScreenshot && step.screenshot ? `<div class="step-screenshot" style="border:2px solid #ef4444;border-radius:6px;padding:4px;display:inline-block"><div style="font-size:11px;color:#ef4444;font-weight:600;margin-bottom:4px">Auto-captured on failure</div><img src="${screenshotSrc(run.id, step.screenshot)}" onclick="openImageLightbox(this)" style="border-radius:4px" /></div>` : ''}
          </div>
          <div class="step-result-time">${step.duration || 0}ms</div>
        </div>`;
      }).join('');
      return `<div class="accordion-item" id="${accId}">
        <div class="accordion-header" onclick="toggleAccordion('${accId}')">
          <span class="ah-chevron">▶</span>
          <strong style="flex:0 0 auto">Row ${i + 1}</strong>
          <span style="flex:1;margin-left:10px;display:flex;gap:4px;flex-wrap:wrap">${varChips}</span>
          <span style="color:${rowColor};font-weight:600;font-size:13px">${row.status}</span>
          <span style="color:var(--muted);font-size:12px;margin-left:12px">${row.duration ? (row.duration/1000).toFixed(1)+'s' : ''}</span>
        </div>
        <div class="accordion-body">${stepRows || '<div class="text-muted text-sm">No steps</div>'}</div>
      </div>`;
    }).join('');

    main.innerHTML = `
      <div style="margin-bottom:16px">
        <button class="btn btn-ghost btn-sm" onclick="navigate('reports')" style="padding:0;font-size:13px">← Reports</button>
      </div>
      <div class="run-detail-header">
        <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px">
          <div>
            ${run.jobNumber ? `<div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);margin-bottom:4px">Job #${run.jobNumber}</div>` : ''}
            <h1>${esc(run.name)}</h1>
          </div>
          <span class="badge" style="background:#f5f3ff;color:#7c3aed">⚡ Data-Driven</span>
        </div>
        <div class="run-detail-meta">
          <span>${browserIcon(run.browser)} ${run.browser}</span>
          <span>🕐 ${formatDate(run.startedAt)}</span>
          <span>${passed}/${rows.length} rows passed</span>
        </div>
      </div>
      ${rowsHTML || '<div class="empty-state"><div class="es-icon">📋</div><h3>No rows recorded</h3></div>'}
    `;
    return;
  }

  const passRate = run.summary?.passRate ?? 0;
  const passColor = passRate >= 80 ? 'var(--success)' : passRate >= 50 ? 'var(--warning)' : 'var(--error)';

  let scenariosHTML = '';
  for (const sr of (run.scenarioResults || [])) {
    const stepsHTML = (sr.steps || []).map((step, i) => {
      // useAction steps render as accordion with sub-steps
      if (step.type === 'useAction') {
        const subSteps = step.subSteps || [];
        const actionStatus = step.status;
        const numClass = actionStatus === 'passed' ? 'passed' : actionStatus === 'failed' ? 'failed' : 'skipped';
        const icon = actionStatus === 'passed' ? '✓' : actionStatus === 'failed' ? '✗' : '–';
        const subStepsHTML = subSteps.map((ss, si) => {
          const ssClass = ss.status === 'passed' ? 'passed' : ss.status === 'failed' ? 'failed' : 'skipped';
          const ssIcon = ss.status === 'passed' ? '✓' : ss.status === 'failed' ? '✗' : '–';
          return `<div class="action-sub-step-result">
            <div class="step-result-num ${ssClass}" style="width:18px;height:18px;font-size:9px">${ssIcon}</div>
            <div class="step-result-info">
              <div class="step-result-desc" style="font-size:12px">${esc(ss.description || ss.type)}</div>
              ${ss.message ? `<div class="step-result-msg">${esc(ss.message)}</div>` : ''}
            </div>
            <div class="step-result-time">${ss.duration || 0}ms</div>
          </div>`;
        }).join('');
        const accId = `ua-acc-${sr.scenarioId}-${i}`;
        return `<div class="accordion-item action-result-accordion" id="${accId}" style="margin:4px 0;border-radius:6px">
          <div class="accordion-header" onclick="toggleAccordion('${accId}')" style="padding:8px 12px">
            <span class="ah-chevron" style="font-size:10px">▶</span>
            <span class="step-type-badge" style="background:#ede9fe;color:#6d28d9;font-size:10px;flex-shrink:0">♻️ Use Action</span>
            <span style="flex:1;font-weight:500;font-size:13px">${esc(step.description || 'Use Action')}</span>
            <span style="font-size:12px;color:${actionStatus === 'passed' ? 'var(--success)' : 'var(--error)'};font-weight:600;flex-shrink:0">${actionStatus}</span>
            <span style="font-size:12px;color:var(--muted);margin-left:8px;flex-shrink:0">${step.duration || 0}ms</span>
          </div>
          <div class="accordion-body" style="padding:4px 12px 8px">
            ${subStepsHTML || '<div style="font-size:12px;color:var(--muted)">No sub-steps recorded</div>'}
          </div>
        </div>`;
      }

      const numClass = step.status === 'passed' ? 'passed' : step.status === 'failed' ? 'failed' : 'skipped';
      const icon = step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '–';

      // Regular screenshot
      let screenshotHTML = '';
      if (step.screenshot && !step.autoScreenshot) {
        screenshotHTML = `<div class="step-screenshot"><img src="${screenshotSrc(run.id, step.screenshot)}" onclick="openImageLightbox(this)" title="Click to expand" /></div>`;
      }
      // Auto-captured screenshot on failure
      if (step.autoScreenshot && step.screenshot) {
        screenshotHTML = `<div class="step-screenshot" style="border:2px solid #ef4444;border-radius:6px;padding:4px;display:inline-block">
          <div style="font-size:11px;color:#ef4444;font-weight:600;margin-bottom:4px">Auto-captured on failure</div>
          <img src="${screenshotSrc(run.id, step.screenshot)}" onclick="openImageLightbox(this)" title="Click to expand" style="border-radius:4px" />
        </div>`;
      }
      // Visual baseline / cross-URL comparison
      let baselineHTML = '';
      if ((step.type === 'visualBaseline' || step.type === 'compareURLs') && step.screenshot) {
        const hasBaseline = !!step.baselineExists;
        const hasDiff = !!step.diffImage;
        if (hasDiff) {
          baselineHTML = `<div class="baseline-compare">
            <div>
              <div class="baseline-img-label">${step.type === 'compareURLs' ? 'This page' : 'Current'}</div>
              <img src="${screenshotSrc(run.id, step.screenshot)}" onclick="openImageLightbox(this)" title="Current screenshot" style="width:100%;border-radius:4px;cursor:zoom-in" />
            </div>
            <div>
              <div class="baseline-img-label">Diff</div>
              <img src="${screenshotSrc(run.id, step.diffImage)}" onclick="openImageLightbox(this)" title="Diff image" style="width:100%;border-radius:4px;cursor:zoom-in" />
            </div>
          </div>
          ${step.type === 'visualBaseline' ? `<div style="margin-top:6px">
            <button class="baseline-reset-btn" onclick="resetBaseline('${run.id}', '${esc(step.params?.name || '')}')">Reset Baseline</button>
          </div>` : ''}`;
        } else if (step.type === 'visualBaseline' && !hasBaseline) {
          baselineHTML = `<div style="font-size:12px;color:#22c55e;margin-top:4px">Baseline captured for future comparisons.</div>
            <div><img src="${screenshotSrc(run.id, step.screenshot)}" onclick="openImageLightbox(this)" title="Baseline" style="max-width:300px;border-radius:4px;cursor:zoom-in;margin-top:4px" /></div>`;
        } else {
          baselineHTML = `<div style="font-size:12px;color:var(--muted);margin-top:4px">
            <img src="${screenshotSrc(run.id, step.screenshot)}" onclick="openImageLightbox(this)" title="Screenshot" style="max-width:300px;border-radius:4px;cursor:zoom-in" />
          </div>`;
        }
      }

      const diagnoseHTML = step.status === 'failed' && run.type === 'scenario' ? `
        <div style="margin-top:6px">
          <button class="btn btn-xs btn-secondary" id="diagnose-btn-${run.id}-${i}" onclick="diagnoseStep('${run.id}',${i})">🔍 Diagnose</button>
          <div id="diagnose-${run.id}-${i}" class="hidden" style="margin-top:8px;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--surface2);font-size:12px"></div>
        </div>` : '';

      return `<div class="step-result-row">
        <div class="step-result-num ${numClass}">${icon}</div>
        <div class="step-result-info">
          <div class="step-result-desc">${esc(step.description || step.type)}</div>
          ${step.message ? `<div class="step-result-msg">${esc(step.message)}</div>` : ''}
          ${screenshotHTML}
          ${baselineHTML}
          ${diagnoseHTML}
        </div>
        <div class="step-result-time">${step.duration || 0}ms</div>
      </div>`;
    }).join('');

    const srColor = sr.status === 'passed' ? 'var(--success)' : 'var(--error)';

    if (run.type === 'suite') {
      scenariosHTML += `<div class="accordion-item" id="acc-${sr.scenarioId}">
        <div class="accordion-header" onclick="toggleAccordion('acc-${sr.scenarioId}')">
          <span class="ah-chevron">▶</span>
          <strong style="flex:1">${esc(sr.scenarioName)}</strong>
          <span style="color:${srColor};font-weight:600;font-size:13px">${sr.status}</span>
          <span style="color:var(--muted);font-size:12px;margin-left:12px">${sr.duration ? (sr.duration/1000).toFixed(1)+'s' : ''}</span>
        </div>
        <div class="accordion-body">${stepsHTML || '<div class="text-muted text-sm">No steps</div>'}</div>
      </div>`;
    } else {
      scenariosHTML += `<div class="card"><div class="card-body">${stepsHTML || '<div class="text-muted">No steps recorded</div>'}</div></div>`;
    }
  }

  main.innerHTML = `
    <div style="margin-bottom:16px">
      <button class="btn btn-ghost btn-sm" onclick="navigate('reports')" style="padding:0;font-size:13px">← Reports</button>
    </div>
    <div class="run-detail-header">
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px">
        <div>
          ${run.jobNumber ? `<div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);margin-bottom:4px">Job #${run.jobNumber}</div>` : ''}
          <h1>${esc(run.name)}</h1>
        </div>
        <div style="display:flex;gap:8px">
          ${run.type === 'suite' && run.suiteId && (run.summary?.failed ?? 0) > 0 ? `<button class="btn btn-primary btn-sm" onclick="rerunFailed('${run.id}')">↺ Re-run Failed (${run.summary.failed})</button><button class="btn btn-secondary btn-sm" onclick="mergeRerun('${run.id}')">⤵ Merge Rerun</button>` : ''}
          <button class="btn btn-secondary btn-sm" onclick="shareReport('${run.id}')">🔗 Share Report</button>
          <button class="btn btn-secondary btn-sm" onclick="emailReport('${run.id}')">✉️ Email Report</button>
          <a class="btn btn-secondary btn-sm" href="/report/${run.id}" target="_blank">📄 Open Report</a>
        </div>
      </div>
      <div class="run-detail-meta">
        <span><span class="badge badge-${run.status}">${run.status}</span></span>
        <span>${browserIcon(run.browser)} ${run.browser}</span>
        <span>${deviceIcon(run.device)} ${DEVICES[run.device]?.label || run.device || ''}</span>
        <span>🕐 ${formatDate(run.startedAt)}</span>
        <span>⏱ ${run.duration ? (run.duration/1000).toFixed(1)+'s' : '—'}</span>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <div class="progress-bar" style="flex:1;height:10px">
          <div class="fill ${passRate >= 80 ? 'success' : 'error'}" style="width:${passRate}%"></div>
        </div>
        <span style="font-size:15px;font-weight:700;color:${passColor}">${passRate}%</span>
        <span style="font-size:13px;color:var(--muted)">${run.summary?.passed ?? 0} passed / ${run.summary?.failed ?? 0} failed</span>
      </div>
    </div>

    ${scenariosHTML || `<div class="empty-state"><div class="es-icon">📋</div><h3>No results recorded</h3></div>`}
  `;
}

function toggleAccordion(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

async function resetBaseline(runId, baselineName) {
  if (!baselineName) { toast('No baseline name', 'error'); return; }
  if (!confirm(`Reset baseline "${baselineName}"? The next run will capture a fresh baseline.`)) return;
  try {
    await DEL(`/api/baselines?name=${encodeURIComponent(baselineName)}`);
    toast('Baseline reset — next run will create a fresh one');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function diagnoseStep(runId, stepIndex) {
  const btn = document.getElementById(`diagnose-btn-${runId}-${stepIndex}`);
  const box = document.getElementById(`diagnose-${runId}-${stepIndex}`);
  if (!box) return;

  if (btn) { btn.disabled = true; btn.textContent = '🔍 Diagnosing…'; }
  box.classList.remove('hidden');
  box.innerHTML = '<span style="color:var(--muted)">Replaying up to this step and inspecting the live page…</span>';

  try {
    const result = await POST(`/api/runs/${runId}/steps/${stepIndex}/diagnose`);
    if (result.needsKey) {
      box.innerHTML = `<div class="alert alert-warning" style="margin:0"><strong>AI features require an API key.</strong><br>Set <code>ANTHROPIC_API_KEY</code> on the server.</div>`;
      return;
    }
    let html = `<div>${esc(result.explanation)}</div>`;
    if (result.hasSuggestion && result.suggestedSelector) {
      html += `<div style="margin-top:8px;padding:8px;background:var(--surface);border-radius:4px">
        <div style="font-weight:600;margin-bottom:4px">Suggested fix</div>
        <code style="font-size:11px">selector: "${esc(result.suggestedSelector)}" · type: ${esc(result.suggestedSelectorType || 'css')}${result.suggestedNth !== undefined ? ` · nth: ${result.suggestedNth}` : ''}</code>
        <div class="form-hint" style="margin-top:4px">Update this step's selector in the Scenario Builder to apply it.</div>
      </div>`;
    }
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = `<span style="color:var(--error)">Diagnosis failed: ${esc(e.message)}</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔍 Diagnose'; }
  }
}

function openImageLightbox(img) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:9999;cursor:zoom-out;padding:20px';
  overlay.onclick = () => overlay.remove();
  const image = document.createElement('img');
  image.src = img.src;
  image.style.cssText = 'max-width:95vw;max-height:90vh;border-radius:4px;box-shadow:0 20px 60px rgba(0,0,0,.5)';
  overlay.appendChild(image);
  document.body.appendChild(overlay);
}

// ─── PROJECT MODAL ────────────────────────────────────────────────────────────

function openProjectModal(projectId) {
  const project = projectId ? state.projects.find(p => p.id === projectId) : null;
  const title = project ? 'Edit Project' : 'New Project';
  let selectedColor = project?.color || PROJECT_COLORS[0];

  const html = `
    <div class="form-group">
      <label>Project Name *</label>
      <input class="form-control" id="pmName" type="text" placeholder="e.g. My Web App" value="${esc(project?.name || '')}" />
    </div>
    <div class="form-group">
      <label>Description</label>
      <textarea class="form-control" id="pmDesc" placeholder="Brief description of this project">${esc(project?.description || '')}</textarea>
    </div>
    <div class="form-group">
      <label>Base URL</label>
      <input class="form-control" id="pmUrl" type="url" placeholder="https://myapp.com" value="${esc(project?.baseUrl || '')}" />
      <div class="form-hint">The default URL to start tests from</div>
    </div>
    <div class="form-group">
      <label>Project Color</label>
      <div class="color-swatches" id="colorSwatches">
        ${PROJECT_COLORS.map(c => `<div class="color-swatch ${c === selectedColor ? 'selected' : ''}" style="background:${c}" data-color="${c}" onclick="selectProjectColor('${c}')"></div>`).join('')}
      </div>
      <input type="hidden" id="pmColor" value="${selectedColor}" />
    </div>
  `;

  openModal(title, html, 'modal-md', async () => {
    const name = document.getElementById('pmName').value.trim();
    if (!name) { toast('Project name is required', 'error'); return false; }
    const data = {
      name,
      description: document.getElementById('pmDesc').value.trim(),
      baseUrl: document.getElementById('pmUrl').value.trim(),
      color: document.getElementById('pmColor').value
    };
    try {
      if (project) {
        const updated = await PUT(`/api/projects/${project.id}`, data);
        state.projects = state.projects.map(p => p.id === project.id ? updated : p);
        toast('Project updated', 'success');
      } else {
        const created = await POST('/api/projects', data);
        state.projects.push(created);
        state.currentProjectId = created.id;
        toast('Project created', 'success');
      }
      renderProjectDropdown();
      navigate(state.currentPage);
    } catch (e) { toast('Error: ' + e.message, 'error'); return false; }
  }, project ? 'Save Changes' : 'Create Project');
}

function selectProjectColor(color) {
  document.getElementById('pmColor').value = color;
  document.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === color));
}

async function deleteProject(id) {
  if (!confirm('Delete this project and all its scenarios and suites? This cannot be undone.')) return;
  try {
    await DEL(`/api/projects/${id}`);
    state.projects = state.projects.filter(p => p.id !== id);
    if (state.currentProjectId === id) state.currentProjectId = null;
    renderProjectDropdown();
    toast('Project deleted', 'success');
    navigate('dashboard');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── SUITE MODAL ──────────────────────────────────────────────────────────────

function openSuiteModal(suiteId) {
  const suite = suiteId ? state.suites.find(s => s.id === suiteId) : null;
  const title = suite ? 'Edit Suite' : 'New Suite';
  const projectOpts = state.projects.map(p => `<option value="${p.id}" ${(suite?.projectId || state.currentProjectId) === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  const html = `
    <div class="form-group">
      <label>Suite Name *</label>
      <input class="form-control" id="smName" type="text" placeholder="e.g. Regression Suite" value="${esc(suite?.name || '')}" />
    </div>
    <div class="form-group">
      <label>Description</label>
      <textarea class="form-control" id="smDesc" placeholder="What does this suite test?">${esc(suite?.description || '')}</textarea>
    </div>
    ${state.projects.length > 0 && !state.currentProjectId ? `
    <div class="form-group">
      <label>Project</label>
      <select class="form-control" id="smProject"><option value="">— No project —</option>${projectOpts}</select>
    </div>` : ''}
  `;

  openModal(title, html, 'modal-md', async () => {
    const name = document.getElementById('smName').value.trim();
    if (!name) { toast('Suite name is required', 'error'); return false; }
    const data = {
      name,
      description: document.getElementById('smDesc').value.trim(),
      projectId: document.getElementById('smProject')?.value || state.currentProjectId || null
    };
    try {
      if (suite) {
        const updated = await PUT(`/api/suites/${suite.id}`, data);
        state.suites = state.suites.map(s => s.id === suite.id ? updated : s);
        toast('Suite updated', 'success');
      } else {
        const created = await POST('/api/suites', data);
        state.suites.push(created);
        toast('Suite created', 'success');
      }
      navigate(state.currentPage);
    } catch (e) { toast('Error: ' + e.message, 'error'); return false; }
  }, suite ? 'Save Changes' : 'Create Suite');
}

async function deleteSuite(id) {
  if (!confirm('Delete this suite? Scenarios inside will not be deleted.')) return;
  try {
    await DEL(`/api/suites/${id}`);
    state.suites = state.suites.filter(s => s.id !== id);
    toast('Suite deleted', 'success');
    navigate('suites');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── ADD SCENARIO TO SUITE MODAL ──────────────────────────────────────────────

async function openAddToSuiteModal(scenarioId) {
  await loadSuites();
  if (state.suites.length === 0) {
    toast('No suites yet. Create a suite first.', 'info');
    return;
  }
  const html = `
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px">Select a suite to add this scenario to:</p>
    ${state.suites.map(s => `
    <div style="padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-weight:500">${esc(s.name)}</div>
        <div style="font-size:12px;color:var(--muted)">${(s.scenarioIds || []).length} scenarios</div>
      </div>
      <button class="btn btn-sm btn-primary" onclick="addToSuiteAndClose('${s.id}','${scenarioId}')">Add</button>
    </div>`).join('')}
  `;
  openModal('Add to Suite', html, 'modal-md', null, null);
}

async function addToSuiteAndClose(suiteId, scenarioId) {
  try {
    await PATCH(`/api/suites/${suiteId}/scenarios`, { add: [scenarioId] });
    toast('Added to suite', 'success');
    closeModal();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function openAddScenarioToSuiteModal(suiteId) {
  activeSuiteTagFilters = new Set();
  await loadScenarios();
  const suite = state.suites.find(s => s.id === suiteId);
  const existing = new Set(suite?.scenarioIds || []);
  const available = state.scenarios.filter(s => !existing.has(s.id) && (!state.currentProjectId || s.projectId === state.currentProjectId));

  if (available.length === 0) {
    toast('All scenarios are already in this suite.', 'info');
    return;
  }

  // collect all unique tags from available scenarios
  const allTags = [...new Set(available.flatMap(s => s.tags || []))].sort();

  const tagFilterHtml = allTags.length ? `
    <div style="margin-bottom:10px">
      <div style="font-size:12px;color:var(--muted);margin-bottom:6px;font-weight:500">Filter by tag:</div>
      <div class="tag-filter-bar" id="suiteTagFilterBar">
        ${allTags.map(t => `<span class="tag-filter-chip" data-tag="${esc(t)}" onclick="toggleSuiteTagFilter('${esc(t)}')">${esc(t)}</span>`).join('')}
      </div>
      <button class="btn btn-sm btn-primary" id="addAllByTagBtn" style="display:none;margin-top:6px" onclick="addAllFilteredToSuite('${suiteId}')">Add all matching scenarios</button>
    </div>` : '';

  const html = `
    <input class="form-control" id="suiteScenSearch" type="text" placeholder="Search scenarios…" style="margin-bottom:12px" oninput="filterSuiteScenSearch()" />
    ${tagFilterHtml}
    <div id="suiteScenList">
      ${available.map(s => `
      <div class="suite-scen-row" style="padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center"
        data-name="${esc(s.name.toLowerCase())}"
        data-tags="${esc((s.tags||[]).join(',').toLowerCase())}"
        data-id="${s.id}">
        <div>
          <div style="font-weight:500">${esc(s.name)}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
            <span class="badge badge-${s.testType || 'functional'}">${capitalize(s.testType || 'functional')}</span>
            <span style="font-size:12px;color:var(--muted)">${s.steps.length} steps</span>
            ${(s.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}
          </div>
        </div>
        <button class="btn btn-sm btn-primary" onclick="addScenToSuiteAndRefresh('${suiteId}','${s.id}',this)">Add</button>
      </div>`).join('')}
    </div>
  `;
  openModal('Add Scenarios', html, 'modal-md', null, null);
}

let activeSuiteTagFilters = new Set();

function toggleSuiteTagFilter(tag) {
  if (activeSuiteTagFilters.has(tag)) {
    activeSuiteTagFilters.delete(tag);
  } else {
    activeSuiteTagFilters.add(tag);
  }
  // update chip styles
  document.querySelectorAll('#suiteTagFilterBar .tag-filter-chip').forEach(chip => {
    chip.classList.toggle('active', activeSuiteTagFilters.has(chip.dataset.tag));
  });
  // show/hide bulk button
  const btn = document.getElementById('addAllByTagBtn');
  if (btn) btn.style.display = activeSuiteTagFilters.size > 0 ? '' : 'none';
  filterSuiteScenSearch();
}

async function addAllFilteredToSuite(suiteId) {
  const visible = Array.from(document.querySelectorAll('.suite-scen-row'))
    .filter(row => row.style.display !== 'none')
    .map(row => row.dataset.id)
    .filter(Boolean);
  if (!visible.length) { toast('No matching scenarios visible', 'info'); return; }
  try {
    await PATCH(`/api/suites/${suiteId}/scenarios`, { add: visible });
    await loadSuites();
    // mark all as added
    document.querySelectorAll('.suite-scen-row').forEach(row => {
      if (visible.includes(row.dataset.id)) {
        const btn = row.querySelector('button');
        if (btn) { btn.textContent = '✓ Added'; btn.disabled = true; btn.classList.replace('btn-primary','btn-secondary'); }
      }
    });
    toast(`Added ${visible.length} scenario${visible.length > 1 ? 's' : ''}`, 'success');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

function filterSuiteScenSearch() {
  const q = document.getElementById('suiteScenSearch')?.value.toLowerCase() || '';
  document.querySelectorAll('.suite-scen-row').forEach(row => {
    const matchesSearch = row.dataset.name.includes(q);
    const matchesTags = activeSuiteTagFilters.size === 0 ||
      [...activeSuiteTagFilters].every(t => (row.dataset.tags || '').split(',').includes(t.toLowerCase()));
    row.style.display = (matchesSearch && matchesTags) ? '' : 'none';
  });
}

async function addScenToSuiteAndRefresh(suiteId, scenarioId, btn) {
  try {
    await PATCH(`/api/suites/${suiteId}/scenarios`, { add: [scenarioId] });
    btn.textContent = '✓ Added';
    btn.disabled = true;
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-secondary');
    await loadSuites();
    toast('Scenario added', 'success');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── TAG INPUT ────────────────────────────────────────────────────────────────

function getProjectTags() {
  const projectId = state.currentProjectId;
  const all = state.scenarios
    .filter(s => !projectId || s.projectId === projectId)
    .flatMap(s => s.tags || []);
  return [...new Set(all)].sort();
}

function onBuilderTagInput() {
  const input = document.getElementById('sbTagInput');
  const box = document.getElementById('sbTagSuggestions');
  const q = input.value.trim().toLowerCase();
  const existing = new Set(
    Array.from(document.querySelectorAll('#sbTagsWrapper .tag-chip')).map(el => el.dataset.tag)
  );
  const matches = getProjectTags().filter(t => !existing.has(t) && t.toLowerCase().includes(q) && q.length > 0);
  if (matches.length === 0) { box.classList.add('hidden'); return; }
  box.innerHTML = matches.map(t =>
    `<div class="tag-suggestion-item" onmousedown="addBuilderTag('${esc(t)}')">🏷️ ${esc(t)}</div>`
  ).join('');
  box.classList.remove('hidden');
}

function onBuilderTagKey(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = document.getElementById('sbTagInput').value.trim().replace(/,$/, '');
    if (val) addBuilderTag(val);
  } else if (e.key === 'Backspace' && document.getElementById('sbTagInput').value === '') {
    const chips = document.querySelectorAll('#sbTagsWrapper .tag-chip');
    if (chips.length) chips[chips.length - 1].remove();
    updateTagPlaceholder();
  }
}

function addBuilderTag(tag) {
  tag = tag.trim();
  if (!tag) return;
  const existing = new Set(
    Array.from(document.querySelectorAll('#sbTagsWrapper .tag-chip')).map(el => el.dataset.tag)
  );
  if (existing.has(tag)) { clearTagInput(); return; }
  const chip = document.createElement('span');
  chip.className = 'tag-chip';
  chip.dataset.tag = tag;
  chip.innerHTML = `${esc(tag)}<button type="button" class="tag-chip-remove" onclick="removeBuilderTag('${esc(tag)}',event)">×</button>`;
  const input = document.getElementById('sbTagInput');
  document.getElementById('sbTagsWrapper').insertBefore(chip, input);
  clearTagInput();
  updateTagPlaceholder();
}

function removeBuilderTag(tag, e) {
  if (e) e.stopPropagation();
  const chip = document.querySelector(`#sbTagsWrapper .tag-chip[data-tag="${tag}"]`);
  if (chip) chip.remove();
  updateTagPlaceholder();
}

function clearTagInput() {
  const input = document.getElementById('sbTagInput');
  if (input) { input.value = ''; hideTagSuggestions(); }
}

function hideTagSuggestions() {
  setTimeout(() => document.getElementById('sbTagSuggestions')?.classList.add('hidden'), 150);
}

function updateTagPlaceholder() {
  const input = document.getElementById('sbTagInput');
  if (!input) return;
  const hasChips = document.querySelectorAll('#sbTagsWrapper .tag-chip').length > 0;
  input.placeholder = hasChips ? '' : 'Type a tag and press Enter…';
}

// ─── SCENARIO BUILDER ─────────────────────────────────────────────────────────

let builderSteps = [];
let builderScenarioId = null;
let builderProjectId = null;
let _dragSrcIndex = null;
let _dragContext = null; // 'builder' | 'action'
let activeBuilderTab = 'manual';
let builderVariables = []; // [{ id, name, defaultValue, description }]

function _draftKey(id) { return `scenario_draft_${id || 'new'}`; }
function saveDraft() {
  const draft = {
    steps: builderSteps,
    variables: builderVariables,
    name: document.getElementById('sbName')?.value ?? null,
    description: document.getElementById('sbDesc')?.value ?? null,
    testType: document.getElementById('sbType')?.value ?? null,
    savedAt: Date.now()
  };
  localStorage.setItem(_draftKey(builderScenarioId), JSON.stringify(draft));
}
let _draftSaveTimer = null;
function saveDraftDebounced() { clearTimeout(_draftSaveTimer); _draftSaveTimer = setTimeout(saveDraft, 400); }
function clearDraft(id) { localStorage.removeItem(_draftKey(id)); }
let embeddedBrowser = null; // { id, url, width, height }
let stepThroughSession = null; // { browserId, currentIndex, results[] }
let stepThroughRunning = false;
let embeddedBrowserLoading = false;
let embeddedBrowserTypeMode = false;
let embeddedScrollTimer = null;
let embeddedScrollStopTimer = null;
let embeddedScrollAccum = 0;
let embeddedScrollSending = false;

async function openScenarioBuilder(scenarioId) {
  builderScenarioId = scenarioId;
  let scenario = null;

  if (scenarioId) {
    try { scenario = await GET(`/api/scenarios/${scenarioId}`); }
    catch { toast('Could not load scenario', 'error'); return; }
  }

  builderSteps = scenario ? JSON.parse(JSON.stringify(scenario.steps || [])) : [];
  builderVariables = scenario ? JSON.parse(JSON.stringify(scenario.variables || [])) : [];
  builderProjectId = scenario?.projectId || state.currentProjectId || null;
  activeBuilderTab = 'manual';

  // Restore any unsaved draft
  try {
    const raw = localStorage.getItem(_draftKey(scenarioId));
    if (raw) {
      const draft = JSON.parse(raw);
      if (draft.steps && draft.steps.length > 0) {
        builderSteps = draft.steps;
        builderVariables = draft.variables || builderVariables;
        setTimeout(() => toast('Draft restored — your unsaved changes have been recovered.', 'info'), 300);
      }
    }
  } catch { /* ignore corrupt draft */ }
  if (stepThroughSession) { DEL(`/api/browser-sessions/${stepThroughSession.browserId}`).catch(() => {}); stepThroughSession = null; }
  stepThroughRunning = false;

  // Load actions for useAction step display and picker
  await loadActions();

  const projectOpts = state.projects.map(p => `<option value="${p.id}" ${(scenario?.projectId || state.currentProjectId) === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  const html = `
    <div class="form-row">
      <div class="form-group">
        <label>Scenario Name *</label>
        <input class="form-control" id="sbName" type="text" placeholder="e.g. Submit contact form without email" value="${esc(scenario?.name || '')}" />
      </div>
      <div class="form-group">
        <label>Test Type</label>
        <select class="form-control" id="sbType">
          ${TEST_TYPES.map(t => `<option value="${t}" ${(scenario?.testType || 'functional') === t ? 'selected' : ''}>${capitalize(t)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>Description</label>
      <input class="form-control" id="sbDesc" type="text" placeholder="Plain English description of what this test does" value="${esc(scenario?.description || '')}" />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Tags</label>
        <div class="tag-input-wrapper" id="sbTagsWrapper" onclick="document.getElementById('sbTagInput').focus()">
          ${(scenario?.tags || []).map(t => `<span class="tag-chip" data-tag="${esc(t)}">${esc(t)}<button type="button" class="tag-chip-remove" onclick="removeBuilderTag('${esc(t)}',event)">×</button></span>`).join('')}
          <input class="tag-input-field" id="sbTagInput" type="text" placeholder="${(scenario?.tags||[]).length ? '' : 'Type a tag and press Enter…'}" autocomplete="off"
            oninput="onBuilderTagInput()" onkeydown="onBuilderTagKey(event)" onblur="hideTagSuggestions()" />
          <div class="tag-suggestions hidden" id="sbTagSuggestions"></div>
        </div>
      </div>
      ${state.projects.length > 0 && !state.currentProjectId ? `
      <div class="form-group">
        <label>Project</label>
        <select class="form-control" id="sbProject"><option value="">— No project —</option>${projectOpts}</select>
      </div>` : ''}
    </div>

    <div class="variables-section">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-size:13px;font-weight:600;color:var(--text)">Variables</div>
        <button class="btn btn-xs btn-secondary" onclick="addBuilderVariable()">+ Add Variable</button>
      </div>
      <div id="builderVariableList"></div>
      <div class="form-hint" style="margin-top:4px">Use <code>{{variableName}}</code> in step params to substitute values at runtime.</div>
    </div>

    <div class="divider"></div>

    <div class="tabs">
      <button class="tab-btn active" id="tabManual" onclick="switchBuilderTab('manual')">🔧 Step Builder</button>
      <button class="tab-btn" id="tabRecord" onclick="switchBuilderTab('record')">🎬 Studio</button>
      <button class="tab-btn" id="tabAgent" onclick="switchBuilderTab('agent')">🤖 AI Agent</button>
    </div>

    <div id="builderTabRecord" class="hidden">
      <div id="builderRecordingPanel"></div>
    </div>

    <div id="builderTabAgent" class="hidden">
      <div class="ai-panel">
        <h3>🤖 AI Agent</h3>
        <p>Tell it what to check in plain English and a starting URL. It will actually open the site, click around, and build the steps for you — review and save when it's done.</p>
      </div>
      <div class="form-group">
        <label>Starting URL</label>
        <input class="form-control" id="agentStartUrl" type="url" placeholder="https://example.com" value="${esc(state.projects.find(p => p.id === state.currentProjectId)?.baseUrl || '')}" />
      </div>
      <div class="form-group">
        <label>What should it check?</label>
        <textarea class="form-control" id="agentInstruction" placeholder="e.g. Go to https://tryngolza.com/ and ensure the dropdown menus go to the correct pages" style="min-height:90px"></textarea>
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
        <button class="btn btn-primary" id="agentRunBtn" onclick="startAiAgent()">▶ Run Agent</button>
        <button class="btn btn-secondary hidden" id="agentStopBtn" onclick="stopAiAgent()">✕ Stop</button>
      </div>
      <div id="agentStatus" class="hidden"></div>
      <div id="agentLog" style="display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;font-size:12px;background:var(--surface2)"></div>
    </div>

    <div id="builderTabManual">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-size:13px;font-weight:600;color:var(--muted)">Steps</div>
        <button class="btn btn-xs btn-secondary" onclick="openSaveStepsAsActionModal()" data-tooltip="Save selected steps as a reusable action">♻️ Save steps as Action</button>
      </div>
      <div class="step-list" id="builderStepList"></div>
      <button class="btn btn-secondary" onclick="openAddStepPicker()">+ Add Step</button>
    </div>

  `;

  openModal(
    scenario ? 'Edit Scenario' : 'New Scenario',
    html,
    'modal-xl',
    async () => {
      const name = document.getElementById('sbName').value.trim();
      if (!name) { toast('Scenario name is required', 'error'); return false; }
      if (builderSteps.length === 0) { toast('Add at least one step', 'error'); return false; }
      const tags = Array.from(document.querySelectorAll('#sbTagsWrapper .tag-chip')).map(el => el.dataset.tag);
      const data = {
        name,
        description: document.getElementById('sbDesc').value.trim(),
        testType: document.getElementById('sbType').value,
        tags,
        steps: builderSteps,
        variables: builderVariables,
        projectId: document.getElementById('sbProject')?.value || state.currentProjectId || null
      };
      try {
        if (scenario) {
          const updated = await PUT(`/api/scenarios/${scenario.id}`, data);
          state.scenarios = state.scenarios.map(s => s.id === scenario.id ? updated : s);
          clearDraft(scenario.id);
          toast('Scenario saved', 'success');
        } else {
          const created = await POST('/api/scenarios', data);
          state.scenarios.push(created);
          clearDraft(null);
          toast('Scenario created', 'success');
        }
        navigate(state.currentPage);
      } catch (e) { toast('Error: ' + e.message, 'error'); return false; }
    },
    scenario ? 'Save Changes' : 'Create Scenario'
  );

  renderBuilderSteps();
  renderBuilderVariables();
}

function renderBuilderVariables() {
  const list = document.getElementById('builderVariableList');
  if (!list) return;
  if (builderVariables.length === 0) {
    list.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:4px 0">No variables yet.</div>';
    return;
  }
  list.innerHTML = builderVariables.map((v, idx) => {
    const isSecret = v.type === 'secret';
    const inputType = isSecret ? 'password' : 'text';
    const placeholder = isSecret ? 'Secret value (encrypted at rest)' : 'Default value';
    return `
    <div class="variable-row">
      <span class="variable-name-preview">{{${v.name || '…'}}}</span>
      <input class="form-control" type="text" placeholder="Name (no spaces)" value="${esc(v.name || '')}"
        style="flex:1;min-width:80px" onchange="updateBuilderVar(${idx},'name',this.value)" />
      <input class="form-control" type="${inputType}" placeholder="${placeholder}" value="${esc(v.defaultValue || '')}"
        style="flex:2;min-width:120px" onchange="updateBuilderVar(${idx},'defaultValue',this.value)" />
      <button class="btn btn-xs ${isSecret ? 'btn-primary' : 'btn-ghost'}" data-tooltip="${isSecret ? 'Secret (encrypted)' : 'Plain text — click to make secret'}"
        style="flex-shrink:0;font-size:14px" onclick="toggleBuilderVarSecret(${idx})">${isSecret ? '🔒' : '🔓'}</button>
      <button class="btn btn-xs btn-ghost" style="color:var(--error);flex-shrink:0" onclick="deleteBuilderVar(${idx})">🗑</button>
    </div>`;
  }).join('');
}

function addBuilderVariable() {
  builderVariables.push({ id: 'var_' + Date.now(), name: '', defaultValue: '', type: 'text', description: '' });
  renderBuilderVariables();
}

function updateBuilderVar(idx, key, value) {
  if (builderVariables[idx]) {
    builderVariables[idx][key] = key === 'name' ? value.replace(/\s+/g, '_') : value;
    if (key !== 'name') renderBuilderVariables();
  }
}

function toggleBuilderVarSecret(idx) {
  if (!builderVariables[idx]) return;
  const isSecret = builderVariables[idx].type === 'secret';
  builderVariables[idx].type = isSecret ? 'text' : 'secret';
  // clear value when switching to secret so user re-enters it
  if (!isSecret) builderVariables[idx].defaultValue = '';
  renderBuilderVariables();
}

function deleteBuilderVar(idx) {
  builderVariables.splice(idx, 1);
  renderBuilderVariables();
}

function switchBuilderTab(tab) {
  activeBuilderTab = tab;
  document.getElementById('tabManual').classList.toggle('active', tab === 'manual');
  document.getElementById('tabRecord').classList.toggle('active', tab === 'record');
  document.getElementById('tabAgent').classList.toggle('active', tab === 'agent');
  document.getElementById('builderTabManual').classList.toggle('hidden', tab !== 'manual');
  document.getElementById('builderTabRecord').classList.toggle('hidden', tab !== 'record');
  document.getElementById('builderTabAgent').classList.toggle('hidden', tab !== 'agent');
  if (tab === 'record') renderBuilderRecordingPanel();
}

function renderBuilderRecordingPanel() {
  const panel = document.getElementById('builderRecordingPanel');
  if (!panel) return;

  const prevScroll = document.getElementById('studioStepList')?.scrollTop ?? 0;
  const stepListHTML = renderStudioStepList();
  const hasBrowser = !!embeddedBrowser;
  const projectBaseUrl = state.projects.find(p => p.id === state.currentProjectId)?.baseUrl || '';

  // Step-through controls
  const stActive = !!stepThroughSession;
  const stIdx = stepThroughSession?.currentIndex ?? -1;
  const stTotal = builderSteps.length;
  const stepThroughHTML = `<div id="studioStepThroughControls">${renderStudioControls()}</div>`;

  const browserHTML = hasBrowser ? `
    <div style="display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;height:100%">
      <div id="embeddedTabBar" style="display:flex;gap:2px;padding:4px 8px 0;background:var(--surface-2,#f1f5f9);border-bottom:1px solid var(--border);flex-shrink:0;min-height:28px;align-items:flex-end">
        <div id="embeddedTabList" style="display:flex;gap:2px;flex:1;overflow-x:auto"></div>
        <button class="btn btn-xs btn-ghost" onclick="refreshEmbeddedTabs()" data-tooltip="Refresh tab list" style="font-size:11px;padding:2px 6px;margin-bottom:2px">⟳ Tabs</button>
      </div>
      <div style="display:flex;gap:6px;align-items:center;padding:6px 8px;background:var(--surface-2,#f1f5f9);border-bottom:1px solid var(--border);flex-shrink:0">
        <button class="btn btn-xs btn-ghost" data-tooltip="Click to record" onclick="setEmbeddedMode('click')" id="modeBtnClick" style="font-size:15px;padding:2px 5px">👆</button>
        <button class="btn btn-xs btn-ghost" data-tooltip="Type text" onclick="setEmbeddedMode('type')" id="modeBtnType" style="font-size:15px;padding:2px 5px">⌨️</button>
        <button class="btn btn-xs btn-ghost" data-tooltip="Assert visible" onclick="setEmbeddedMode('assert')" id="modeBtnAssert" style="font-size:15px;padding:2px 5px">✅</button>
        <div style="width:1px;height:20px;background:var(--border);margin:0 2px"></div>
        <input class="form-control" id="embeddedUrlBar" type="url" value="${esc(embeddedBrowser.url)}"
          style="flex:1;height:28px;font-size:12px;padding:2px 8px"
          onkeydown="if(event.key==='Enter')embeddedNavigate()" />
        <button class="btn btn-xs btn-ghost" onclick="embeddedNavigate()" style="padding:2px 6px">↵</button>
        <select id="embeddedDevicePicker" class="form-control"
          style="height:28px;font-size:11px;padding:0 4px;width:auto;flex-shrink:0"
          onchange="resizeEmbeddedBrowser(this.value)">
          <option value="1280x800" ${embeddedBrowser.width===1280&&embeddedBrowser.height===800?'selected':''}>🖥 1280×800</option>
          <option value="1440x900" ${embeddedBrowser.width===1440?'selected':''}>🖥 1440×900</option>
          <option value="1366x768" ${embeddedBrowser.width===1366?'selected':''}>💻 1366×768</option>
          <option value="768x1024" ${embeddedBrowser.width===768?'selected':''}>📱 768×1024</option>
          <option value="390x844" ${embeddedBrowser.width===390?'selected':''}>📱 390×844</option>
          <option value="360x800" ${embeddedBrowser.width===360?'selected':''}>📱 360×800</option>
          <option value="custom">✏️ Custom…</option>
        </select>
        <button class="btn btn-xs btn-secondary" onclick="stopEmbeddedBrowser()" style="padding:2px 8px">✕</button>
      </div>
      <div id="embeddedViewport" style="position:relative;line-height:0;background:#000;cursor:crosshair;flex:1;overflow:hidden" onwheel="handleEmbeddedScroll(event)">
        <img id="embeddedShot" src="data:image/jpeg;base64,${embeddedBrowser.screenshot}"
          style="width:100%;display:block;user-select:none;-webkit-user-drag:none"
          onclick="handleEmbeddedClick(event)"
          oncontextmenu="handleEmbeddedRightClick(event)" />
        <div id="embeddedOverlay" style="display:none;position:absolute;inset:0;background:rgba(0,0,0,.35);align-items:center;justify-content:center">
          <div style="color:#fff;font-size:13px;font-weight:600">Loading…</div>
        </div>
        <div id="embeddedTypeBox" style="display:none;position:absolute;bottom:0;left:0;right:0;background:rgba(15,23,42,.92);padding:10px 12px">
          <div style="font-size:11px;color:#94a3b8;margin-bottom:6px">Type text to send to the focused field — press Enter to confirm</div>
          <div style="display:flex;gap:8px">
            <input id="embeddedTypeInput" class="form-control" type="text" placeholder="Text to type…"
              style="flex:1;height:32px;font-size:13px"
              onkeydown="handleEmbeddedTypeKey(event)" />
            <button class="btn btn-primary btn-sm" onclick="submitEmbeddedType()">Send ↵</button>
            <button class="btn btn-secondary btn-sm" onclick="cancelEmbeddedType()">Cancel</button>
          </div>
        </div>
      </div>
      <div style="padding:4px 10px;background:var(--surface-2,#f1f5f9);border-top:1px solid var(--border);font-size:11px;color:var(--muted);flex-shrink:0">
        👆 Click · ⌨️ Type · ✅ Assert · Right-click for more options
      </div>
    </div>` : `
    <div style="height:100%;min-height:300px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface2)">
      <div style="text-align:center">
        <div style="font-size:32px;margin-bottom:10px">🌐</div>
        <div style="font-size:14px;font-weight:600;margin-bottom:6px">Open a browser to record or step through</div>
        <div style="display:flex;gap:8px;justify-content:center;max-width:400px">
          <input class="form-control" id="browserStartUrl" type="url" placeholder="https://example.com"
            value="${esc(projectBaseUrl)}" style="flex:1" onkeydown="if(event.key==='Enter')startEmbeddedBrowser()" />
          <button class="btn btn-primary" onclick="startEmbeddedBrowser()">Open</button>
        </div>
      </div>
    </div>`;

  const suggestStepHTML = hasBrowser ? `
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <input class="form-control" id="suggestStepInput" type="text" placeholder="✨ Describe a step… e.g. click the submit button"
        style="flex:1;font-size:12px" onkeydown="if(event.key==='Enter')suggestStep()" />
      <button class="btn btn-xs btn-primary" id="suggestStepBtn" onclick="suggestStep()">Suggest</button>
    </div>` : '';

  panel.innerHTML = `
    <div style="display:grid;grid-template-columns:290px 1fr;gap:12px;align-items:start">
      <!-- Left: step list -->
      <div style="display:flex;flex-direction:column;gap:0;min-height:400px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="font-size:13px;font-weight:600">Steps <span style="color:var(--muted);font-weight:400">(${builderSteps.length})</span></div>
          <button class="btn btn-xs btn-secondary" onclick="openAddStepPicker()">+ Add Step</button>
        </div>
        ${suggestStepHTML}
        <div id="studioStepList" style="flex:1;overflow-y:auto;max-height:400px;margin-bottom:8px">${stepListHTML}</div>
        ${stepThroughHTML}
      </div>
      <!-- Right: browser -->
      <div style="min-height:400px">${browserHTML}</div>
    </div>`;

  if (hasBrowser) setEmbeddedMode(embeddedBrowserTypeMode ? 'type' : 'click');
  const studioList = document.getElementById('studioStepList');
  if (studioList && prevScroll) studioList.scrollTop = prevScroll;
}

function renderStudioStepList() {
  if (builderSteps.length === 0) {
    return `<div style="text-align:center;color:var(--muted);padding:24px 8px;font-size:13px">No steps yet.<br>Add a step or open the browser to record.</div>`;
  }
  return builderSteps.map((step, i) => {
    const stResult = stepThroughSession?.results?.[i];
    const isCurrent = stepThroughSession?.currentIndex === i;
    let statusIcon = `<span style="color:var(--muted);font-size:11px;width:14px;display:inline-block;text-align:center">${i+1}</span>`;
    if (stResult?.status === 'passed') statusIcon = `<span style="color:var(--success);width:14px;display:inline-block;text-align:center">✓</span>`;
    else if (stResult?.status === 'failed') statusIcon = `<span style="color:var(--error);width:14px;display:inline-block;text-align:center">✗</span>`;
    else if (isCurrent) statusIcon = `<span style="color:var(--primary);width:14px;display:inline-block;text-align:center">▶</span>`;
    return `
      <div id="studio-step-${i}" draggable="true"
        ondragstart="stepDragStart(event,${i},'studio')"
        ondragover="stepDragOver(event,${i},'studio')"
        ondrop="stepDrop(event,${i},'studio')"
        ondragend="stepDragEnd(event,'studio')"
        style="border:1px solid ${isCurrent ? 'var(--primary)' : 'var(--border)'};border-radius:6px;margin-bottom:4px;background:${isCurrent ? 'var(--primary-light,#eff6ff)' : 'var(--surface)'};cursor:grab">
        <div style="display:flex;align-items:center;gap:5px;padding:5px 6px">
          <span style="color:var(--muted);font-size:12px;cursor:grab;flex-shrink:0" data-tooltip="Drag to reorder">⠿</span>
          ${statusIcon}
          <span class="step-type-badge step-type-${step.type}" style="font-size:10px;flex-shrink:0">${step.type}</span>
          <span style="font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)" data-tooltip="${esc(stepDescription(step))}">${esc(stepDescription(step))}</span>
          <div style="display:flex;gap:1px;flex-shrink:0">
            <button class="btn btn-xs btn-ghost" onclick="studioStartFromStep(${i})" data-tooltip="Start playback from this step" style="padding:1px 4px;color:var(--primary)">▶</button>
            <button class="btn btn-xs btn-ghost" onclick="studioToggleEdit(${i})" data-tooltip="Edit" style="padding:1px 4px">✏️</button>
            <button class="btn btn-xs btn-ghost" onclick="studioDuplicateStep(${i})" data-tooltip="Duplicate step" style="padding:1px 4px">⧉</button>
            <button class="btn btn-xs btn-ghost" onclick="studioDeleteStep(${i})" data-tooltip="Delete" style="padding:1px 4px;color:var(--error)">×</button>
          </div>
        </div>
        <div id="studio-edit-${i}" class="hidden" style="padding:8px;border-top:1px solid var(--border)">
          ${stepParamsForm(step, i)}
        </div>
        ${stResult?.status === 'failed' ? `<div style="padding:4px 8px;border-top:1px solid var(--border)" ondragstart="event.stopPropagation()">
          <div style="display:flex;align-items:flex-start;gap:6px">
            <div style="flex:1;font-size:11px;color:var(--error);user-select:text;cursor:text">${esc(stResult.message)}</div>
            <button class="btn btn-xs btn-secondary" id="studio-diagnose-btn-${i}" onclick="studioDiagnoseStep(${i})" style="flex-shrink:0">🔍 Diagnose</button>
          </div>
          <div id="studio-diagnose-${i}" class="hidden" style="margin-top:6px;font-size:11px;padding:6px 8px;background:var(--surface2);border-radius:4px"></div>
        </div>` : ''}
      </div>`;
  }).join('');
}

function studioToggleEdit(i) {
  const el = document.getElementById(`studio-edit-${i}`);
  if (el) el.classList.toggle('hidden');
}

function studioDuplicateStep(i) {
  const copy = JSON.parse(JSON.stringify(builderSteps[i]));
  copy.id = 'step_' + Date.now();
  builderSteps.splice(i + 1, 0, copy);
  refreshStudio();
}

function studioMoveStep(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= builderSteps.length) return;
  [builderSteps[i], builderSteps[j]] = [builderSteps[j], builderSteps[i]];
  refreshStudio();
}

function studioDeleteStep(i) {
  builderSteps.splice(i, 1);
  refreshStudio();
}

function renderStudioControls() {
  const stActive = !!stepThroughSession;
  const stIdx = stepThroughSession?.currentIndex ?? -1;
  const stTotal = builderSteps.length;
  return `
    <div style="border-top:1px solid var(--border);padding:8px 0 0">
      <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">Step Through</div>
      ${stActive ? `
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn btn-xs btn-secondary" onclick="studioStepPrev()" ${stIdx <= 0 || stepThroughRunning ? 'disabled' : ''}>← Prev</button>
          <button class="btn btn-xs btn-primary" onclick="studioStepNext()" ${stIdx >= stTotal - 1 || stepThroughRunning ? 'disabled' : ''}>
            ${stepThroughRunning ? 'Running…' : stIdx === -1 ? '▶ Start' : 'Next →'}
          </button>
          <button class="btn btn-xs btn-ghost" onclick="studioStopStepThrough()" style="color:var(--error)">✕ End</button>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px">${stIdx >= 0 ? `Step ${stIdx + 1} of ${stTotal}` : `${stTotal} steps ready`}</div>
      ` : `
        <button class="btn btn-xs btn-secondary" onclick="studioStartStepThrough()" ${stTotal === 0 ? 'disabled' : ''}>▶ Start Step Through</button>
      `}
    </div>`;
}

function refreshStudio() {
  const list = document.getElementById('studioStepList');
  if (list) {
    const top = list.scrollTop;
    list.innerHTML = renderStudioStepList();
    list.scrollTop = top;
  }
  const controls = document.getElementById('studioStepThroughControls');
  if (controls) controls.innerHTML = renderStudioControls();
  renderBuilderSteps();
}

function setEmbeddedMode(mode) {
  embeddedBrowserTypeMode = mode === 'type';
  ['click','type','assert'].forEach(m => {
    const btn = document.getElementById(`modeBtn${m.charAt(0).toUpperCase()+m.slice(1)}`);
    if (btn) btn.style.background = mode === m ? 'var(--primary-light,#dbeafe)' : '';
  });
  const vp = document.getElementById('embeddedViewport');
  if (vp) vp.style.cursor = mode === 'assert' ? 'cell' : mode === 'type' ? 'text' : 'crosshair';
  if (mode === 'type') {
    const tb = document.getElementById('embeddedTypeBox');
    if (tb) { tb.style.display = 'block'; setTimeout(() => document.getElementById('embeddedTypeInput')?.focus(), 50); }
  } else {
    const tb = document.getElementById('embeddedTypeBox');
    if (tb) tb.style.display = 'none';
  }
}

// ─── STUDIO STEP-THROUGH ──────────────────────────────────────────────────────

async function studioStartStepThrough() {
  if (builderSteps.length === 0) return;
  // Reuse the existing embedded browser session if open, otherwise start a new one
  if (embeddedBrowser) {
    stepThroughSession = { browserId: embeddedBrowser.id, currentIndex: -1, results: [] };
  } else {
    try {
      const data = await POST('/api/browser-sessions', { url: '', viewportWidth: 1280, viewportHeight: 800 });
      embeddedBrowser = { id: data.id, url: data.url, screenshot: data.screenshot, width: 1280, height: 800 };
      stepThroughSession = { browserId: data.id, currentIndex: -1, results: [] };
    } catch (e) {
      toast('Failed to start browser: ' + e.message, 'error');
      return;
    }
  }
  renderBuilderRecordingPanel();
}

async function studioStartFromStep(index) {
  if (embeddedBrowser) {
    stepThroughSession = { browserId: embeddedBrowser.id, currentIndex: index - 1, results: [] };
  } else {
    try {
      const data = await POST('/api/browser-sessions', { url: '', viewportWidth: 1280, viewportHeight: 800 });
      embeddedBrowser = { id: data.id, url: data.url, screenshot: data.screenshot, width: 1280, height: 800 };
      stepThroughSession = { browserId: data.id, currentIndex: index - 1, results: [] };
    } catch (e) {
      toast('Failed to start browser: ' + e.message, 'error');
      return;
    }
  }
  renderBuilderRecordingPanel();
  await studioStepNext();
}

async function studioStepNext() {
  if (!stepThroughSession || stepThroughRunning) return;
  const nextIndex = stepThroughSession.currentIndex + 1;
  if (nextIndex >= builderSteps.length) return;
  stepThroughRunning = true;
  stepThroughSession.currentIndex = nextIndex;
  refreshStudio();
  try {
    const step = builderSteps[nextIndex];
    // Build vars: project baseUrl + scenario variables
    const vars = {};
    const projId = builderProjectId || document.getElementById('sbProject')?.value || state.currentProjectId;
    const proj = state.projects.find(p => p.id === projId);
    if (proj?.baseUrl) vars.baseUrl = proj.baseUrl;
    for (const v of (builderVariables || [])) {
      if (v.name && v.defaultValue) {
        const cleanName = v.name.replace(/^\{\{|\}\}$/g, '');
        vars[cleanName] = v.defaultValue;
      }
    }
    const data = await POST(`/api/browser-sessions/${stepThroughSession.browserId}/execute-step`, { step, vars });
    stepThroughSession.results[nextIndex] = { status: data.status, message: data.message };
    if (data.screenshot && embeddedBrowser) {
      embeddedBrowser.screenshot = data.screenshot;
      embeddedBrowser.url = data.url;
      const shot = document.getElementById('embeddedShot');
      if (shot) shot.src = 'data:image/jpeg;base64,' + data.screenshot;
      const bar = document.getElementById('embeddedUrlBar');
      if (bar) bar.value = data.url;
    }
  } catch (e) {
    stepThroughSession.results[nextIndex] = { status: 'failed', message: e.message };
  }
  stepThroughRunning = false;
  refreshStudio();
}

async function studioDiagnoseStep(index) {
  if (!stepThroughSession) return;
  const btn = document.getElementById(`studio-diagnose-btn-${index}`);
  const box = document.getElementById(`studio-diagnose-${index}`);
  if (!box) return;

  if (btn) { btn.disabled = true; btn.textContent = '🔍 Diagnosing…'; }
  box.classList.remove('hidden');
  box.innerHTML = '<span style="color:var(--muted)">Inspecting the live page…</span>';

  try {
    const step = builderSteps[index];
    const vars = {};
    const projId = builderProjectId || document.getElementById('sbProject')?.value || state.currentProjectId;
    const proj = state.projects.find(p => p.id === projId);
    if (proj?.baseUrl) vars.baseUrl = proj.baseUrl;
    for (const v of (builderVariables || [])) {
      if (v.name && v.defaultValue) {
        const cleanName = v.name.replace(/^\{\{|\}\}$/g, '');
        vars[cleanName] = v.defaultValue;
      }
    }
    const failureMessage = stepThroughSession.results?.[index]?.message || '';
    const result = await POST(`/api/browser-sessions/${stepThroughSession.browserId}/diagnose-step`, { step, vars, failureMessage });
    if (result.needsKey) {
      box.innerHTML = `<div class="alert alert-warning" style="margin:0"><strong>AI features require an API key.</strong><br>Set <code>ANTHROPIC_API_KEY</code> on the server.</div>`;
      return;
    }
    let html = `<div>${esc(result.explanation)}</div>`;
    if (result.hasSuggestion && result.suggestedSelector) {
      html += `<div style="margin-top:8px;padding:8px;background:var(--surface);border-radius:4px">
        <div style="font-weight:600;margin-bottom:4px">Suggested fix</div>
        <code style="font-size:11px">selector: "${esc(result.suggestedSelector)}" · type: ${esc(result.suggestedSelectorType || 'css')}${result.suggestedNth !== undefined ? ` · nth: ${result.suggestedNth}` : ''}</code>
        <div class="form-hint" style="margin-top:4px">Update this step's selector above to apply it.</div>
      </div>`;
    }
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = `<span style="color:var(--error)">Diagnosis failed: ${esc(e.message)}</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔍 Diagnose'; }
  }
}

function studioStepPrev() {
  if (!stepThroughSession || stepThroughRunning || stepThroughSession.currentIndex <= 0) return;
  stepThroughSession.currentIndex--;
  refreshStudio();
}

function studioStopStepThrough() {
  stepThroughSession = null;
  stepThroughRunning = false;
  refreshStudio();
}

// ─── EMBEDDED BROWSER ─────────────────────────────────────────────────────────

async function startEmbeddedBrowser() {
  const urlInput = document.getElementById('browserStartUrl');
  const url = urlInput?.value.trim();
  if (!url) { toast('Enter a URL to open', 'error'); return; }
  const btn = urlInput?.nextElementSibling;
  if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
  try {
    const data = await POST('/api/browser-sessions', { url, viewportWidth: 1280, viewportHeight: 800 });
    embeddedBrowser = { id: data.id, url: data.url, screenshot: data.screenshot, width: 1280, height: 800 };
    renderBuilderRecordingPanel();
    setTimeout(refreshEmbeddedTabs, 500);
  } catch (e) {
    toast('Could not open browser: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Open'; }
  }
}

function stopEmbeddedBrowser() {
  if (!embeddedBrowser) return;
  DEL(`/api/browser-sessions/${embeddedBrowser.id}`).catch(() => {});
  embeddedBrowser = null;
  embeddedBrowserTypeMode = false;
  renderBuilderRecordingPanel();
}

async function refreshEmbeddedTabs() {
  if (!embeddedBrowser) return;
  try {
    const data = await GET(`/api/browser-sessions/${embeddedBrowser.id}/tabs`);
    const tabList = document.getElementById('embeddedTabList');
    if (!tabList) return;
    tabList.innerHTML = data.tabs.map(t => `
      <div style="display:flex;align-items:center;border:1px solid var(--border);border-bottom:none;border-radius:4px 4px 0 0;
                  background:${t.active ? '#fff' : 'var(--surface-2,#f1f5f9)'};overflow:hidden">
        <button onclick="switchEmbeddedTab(${t.index})" data-tooltip="${esc(t.url)}"
          style="padding:2px 8px;font-size:11px;font-weight:${t.active ? '600' : 'normal'};border:none;background:transparent;cursor:pointer;white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis">
          ${esc((t.title || t.url).substring(0, 28))}
        </button>
        <button onclick="closeEmbeddedTab(${t.index},event)" data-tooltip="Close tab"
          style="padding:0 5px;font-size:13px;line-height:1;border:none;background:transparent;cursor:pointer;color:#94a3b8;flex-shrink:0" >×</button>
      </div>`).join('');
  } catch {}
}

async function closeEmbeddedTab(index, e) {
  e.stopPropagation();
  if (!embeddedBrowser) return;
  await POST(`/api/browser-sessions/${embeddedBrowser.id}/close-tab`, { index }).catch(() => {});
  refreshEmbeddedTabs();
  // Refresh screenshot in case we closed the active tab
  const data = await GET(`/api/browser-sessions/${embeddedBrowser.id}/tabs`).catch(() => null);
  if (data) {
    const active = data.tabs.find(t => t.active);
    if (active) {
      const shot = await POST(`/api/browser-sessions/${embeddedBrowser.id}/switch-tab`, { index: active.index }).catch(() => null);
      if (shot?.screenshot) {
        embeddedBrowser.screenshot = shot.screenshot;
        embeddedBrowser.url = shot.url;
        const img = document.getElementById('embeddedShot');
        if (img) img.src = 'data:image/jpeg;base64,' + shot.screenshot;
        const bar = document.getElementById('embeddedUrlBar');
        if (bar) bar.value = shot.url;
      }
    }
  }
  refreshEmbeddedTabs();
}

async function switchEmbeddedTab(index) {
  if (!embeddedBrowser) return;
  const data = await POST(`/api/browser-sessions/${embeddedBrowser.id}/switch-tab`, { index });
  if (data.error) { toast(data.error, 'error'); return; }
  embeddedBrowser.screenshot = data.screenshot;
  embeddedBrowser.url = data.url;
  const img = document.getElementById('embeddedShot');
  if (img) img.src = 'data:image/jpeg;base64,' + data.screenshot;
  const bar = document.getElementById('embeddedUrlBar');
  if (bar) bar.value = data.url;
  refreshEmbeddedTabs();

  // Add a switchToNewTab step — separate from the click step
  builderSteps.push({
    id: 'step_' + Date.now(),
    type: 'switchToNewTab',
    params: { assertURLContains: data.url }
  });
  renderBuilderSteps();
}

async function embeddedNavigate() {
  const bar = document.getElementById('embeddedUrlBar');
  const url = bar?.value.trim();
  if (!url || !embeddedBrowser) return;
  await sendEmbeddedAction({ type: 'navigate', url });
}

async function handleEmbeddedClick(e) {
  if (embeddedBrowserLoading || !embeddedBrowser) return;
  const img = document.getElementById('embeddedShot');
  if (!img) return;
  const rect = img.getBoundingClientRect();
  const scaleX = embeddedBrowser.width / rect.width;
  const scaleY = embeddedBrowser.height / rect.height;
  const x = Math.round((e.clientX - rect.left) * scaleX);
  const y = Math.round((e.clientY - rect.top) * scaleY);
  const activeMode = ['click','type','assert'].find(m => {
    const b = document.getElementById(`modeBtn${m.charAt(0).toUpperCase()+m.slice(1)}`);
    return b && b.style.background && b.style.background !== '';
  }) || 'click';

  if (activeMode === 'assert') {
    await sendEmbeddedAction({ type: 'assert_visible', x, y });
  } else {
    const result = await sendEmbeddedAction({ type: 'click', x, y });
    if (result?.step?._isInput) {
      setEmbeddedMode('type');
    }
  }
}

async function handleEmbeddedRightClick(e) {
  e.preventDefault();
  if (!embeddedBrowser || embeddedBrowserLoading) return;
  const img = document.getElementById('embeddedShot');
  if (!img) return;
  const rect = img.getBoundingClientRect();
  const scaleX = embeddedBrowser.width / rect.width;
  const scaleY = embeddedBrowser.height / rect.height;
  const x = Math.round((e.clientX - rect.left) * scaleX);
  const y = Math.round((e.clientY - rect.top) * scaleY);
  const clientX = e.clientX, clientY = e.clientY;

  // Inspect element first, then show palette
  let elInfo = null;
  try {
    const data = await POST(`/api/browser-sessions/${embeddedBrowser.id}/action`, { type: 'inspect', x, y });
    elInfo = data.inspect;
    if (data.screenshot) {
      embeddedBrowser.screenshot = data.screenshot;
      const shot = document.getElementById('embeddedShot');
      if (shot) shot.src = 'data:image/jpeg;base64,' + data.screenshot;
    }
  } catch {}

  showEmbeddedCommandPalette(x, y, clientX, clientY, elInfo);
}

function showEmbeddedCommandPalette(x, y, clientX, clientY, elInfo) {
  document.getElementById('embeddedCtxMenu')?.remove();

  const ALL_COMMANDS = [
    { group: 'Interactions', icon: '👆', label: 'Click',               action: () => sendEmbeddedAction({ type: 'click', x, y }) },
    { group: 'Interactions', icon: '👆👆', label: 'Double Click',      action: () => sendEmbeddedAction({ type: 'dblclick', x, y }) },
    { group: 'Interactions', icon: '🖱', label: 'Hover',               action: () => sendEmbeddedAction({ type: 'hover', x, y }) },
    { group: 'Interactions', icon: '⌨️', label: 'Type Text…',         action: () => embeddedPromptThenAction('Type text to enter', '', v => sendEmbeddedAction({ type: 'type', text: v, x, y })) },
    { group: 'Interactions', icon: '🗑', label: 'Clear Field',         action: () => sendEmbeddedAction({ type: 'clear', x, y }) },
    { group: 'Interactions', icon: '↩', label: 'Press Enter',          action: () => sendEmbeddedAction({ type: 'key', key: 'Enter' }) },
    { group: 'Interactions', icon: '☑️', label: 'Check Checkbox',     action: () => { if (elInfo) { builderSteps.push({ id: 'step_'+Date.now(), type: 'checkElement', params: { selector: elInfo.selector, selectorType: elInfo.selectorType || 'css' } }); renderBuilderSteps(); } } },
    { group: 'Interactions', icon: '📜', label: 'Scroll Down',         action: () => sendEmbeddedAction({ type: 'scroll', y: 300 }) },
    { group: 'Interactions', icon: '📜', label: 'Scroll Up',           action: () => sendEmbeddedAction({ type: 'scroll', y: -300 }) },
    { group: 'Interactions', icon: '📜', label: 'Scroll To Element',   action: () => { if (elInfo) { builderSteps.push({ id: 'step_'+Date.now(), type: 'scrollToElement', params: { selector: elInfo.selector, selectorType: elInfo.selectorType || 'css' } }); renderBuilderSteps(); } } },
    { group: 'Tabs',         icon: '🗂', label: 'New Tab (click link)', action: () => { if (elInfo) { builderSteps.push({ id: 'step_'+Date.now(), type: 'newTab', params: { selector: elInfo.selector, selectorType: elInfo.selectorType || 'css' } }); renderBuilderSteps(); } } },
    { group: 'Tabs',         icon: '↪️', label: 'Switch to New Tab',   action: () => { builderSteps.push({ id: 'step_'+Date.now(), type: 'switchToNewTab', params: { assertURLContains: '' } }); renderBuilderSteps(); } },
    { group: 'Tabs',         icon: '✖️', label: 'Close Tab',           action: () => { builderSteps.push({ id: 'step_'+Date.now(), type: 'closeTab', params: {} }); renderBuilderSteps(); } },
    { group: 'Assertions',   icon: '✅', label: 'Assert Visible',      action: () => sendEmbeddedAction({ type: 'assert_visible', x, y }) },
    { group: 'Assertions',   icon: '🚫', label: 'Assert Not Visible',  action: () => sendEmbeddedAction({ type: 'assert_not_visible', x, y }) },
    { group: 'Assertions',   icon: '📝', label: 'Assert Text…',        action: () => embeddedPromptThenAction('Assert element contains text', elInfo?.innerText || '', v => sendEmbeddedAction({ type: 'assert_text', text: v, x, y })) },
    { group: 'Assertions',   icon: '🔗', label: 'Assert URL…',         action: () => embeddedPromptThenAction('Assert page URL contains', embeddedBrowser?.url || '', v => sendEmbeddedAction({ type: 'assert_url', text: v })) },
    { group: 'Assertions',   icon: '🎨', label: 'Assert CSS…',         action: () => embeddedPromptThenAction('CSS property (e.g. border-color)', 'border-color', prop => embeddedPromptThenAction('Expected value', '', val => { if (elInfo) { builderSteps.push({ id: 'step_'+Date.now(), type: 'assertCSS', params: { selector: elInfo.selector, selectorType: elInfo.selectorType || 'css', property: prop, value: val, matchType: 'exact' } }); renderBuilderSteps(); } })) },
    { group: 'Other',        icon: '📸', label: 'Take Screenshot',     action: () => sendEmbeddedAction({ type: 'action_screenshot' }) },
    { group: 'Other',        icon: '⏱', label: 'Wait 2 seconds',       action: () => { builderSteps.push({ id: 'step_'+Date.now(), type: 'waitSeconds', params: { seconds: 2 } }); renderBuilderSteps(); } },
    { group: 'Other',        icon: '🔧', label: 'Run JavaScript…',      action: () => embeddedPromptThenAction('JavaScript to run', '', v => { builderSteps.push({ id: 'step_'+Date.now(), type: 'runJS', params: { script: v } }); renderBuilderSteps(); }) },
  ];

  const elTag = elInfo ? `<${elInfo.tagName}>` : '';
  const elText = elInfo?.innerText ? ` "${elInfo.innerText.slice(0, 40)}${elInfo.innerText.length > 40 ? '…' : ''}"` : '';
  const elSelector = elInfo ? ` · ${elInfo.strategy || elInfo.selectorType}` : '';

  // Position palette so it doesn't go off-screen
  const paletteW = 280, paletteH = 420;
  const left = Math.min(clientX, window.innerWidth - paletteW - 8);
  const top  = Math.min(clientY, window.innerHeight - paletteH - 8);

  const menu = document.createElement('div');
  menu.id = 'embeddedCtxMenu';
  menu.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${paletteW}px;background:#ffffff;border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.35);z-index:9999;font-size:13px;overflow:hidden;display:flex;flex-direction:column`;

  let lastGroup = '';
  const rows = ALL_COMMANDS.map((cmd, idx) => {
    const groupHeader = cmd.group !== lastGroup
      ? `<div style="padding:6px 12px 2px;font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--muted);text-transform:uppercase">${cmd.group}</div>`
      : '';
    lastGroup = cmd.group;
    return `${groupHeader}<div class="ec-row" data-idx="${idx}" style="display:flex;align-items:center;gap:10px;padding:7px 14px;cursor:pointer;border-radius:0" onmouseenter="this.style.background='var(--primary-light,#dbeafe)'" onmouseleave="this.style.background=''" onmousedown="event.preventDefault()" onclick="embeddedCtxRun(${idx})"><span style="font-size:15px;width:20px;text-align:center;flex-shrink:0">${cmd.icon}</span><span>${cmd.label}</span></div>`;
  }).join('');

  menu.innerHTML = `
    <div style="padding:8px 12px 6px;border-bottom:1px solid var(--border)">
      ${elInfo ? `<div style="font-size:11px;font-weight:700;color:var(--text);font-family:monospace">${esc(elTag)}${esc(elText)}</div><div style="font-size:10px;color:var(--muted);margin-top:1px">${esc(elInfo.selector)}${esc(elSelector)}</div>` : '<div style="font-size:12px;color:var(--muted)">No element detected</div>'}
    </div>
    <div style="padding:4px 4px 2px;border-bottom:1px solid var(--border)">
      <input id="ecSearch" class="form-control" type="text" placeholder="Search commands…"
        style="height:28px;font-size:12px;padding:2px 8px;border-radius:6px"
        oninput="filterEmbeddedCommands(this.value)"
        onkeydown="handleEcSearchKey(event)" />
    </div>
    <div id="ecCommandList" style="overflow-y:auto;max-height:300px;padding:4px 0">${rows}</div>`;

  document.body.appendChild(menu);
  window.__embeddedCommands = ALL_COMMANDS;
  setTimeout(() => document.getElementById('ecSearch')?.focus(), 30);

  const dismiss = (ev) => {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss), 10);
}

function embeddedCtxRun(idx) {
  document.getElementById('embeddedCtxMenu')?.remove();
  window.__embeddedCommands?.[idx]?.action();
}

function filterEmbeddedCommands(q) {
  const list = document.getElementById('ecCommandList');
  if (!list) return;
  const term = q.toLowerCase();
  list.querySelectorAll('.ec-row').forEach(row => {
    const label = row.querySelector('span:last-child')?.textContent.toLowerCase() || '';
    row.style.display = !term || label.includes(term) ? '' : 'none';
  });
}

function handleEcSearchKey(e) {
  if (e.key === 'Escape') { document.getElementById('embeddedCtxMenu')?.remove(); return; }
  if (e.key === 'Enter') {
    const first = document.querySelector('#ecCommandList .ec-row:not([style*="none"])');
    if (first) { const idx = parseInt(first.dataset.idx); document.getElementById('embeddedCtxMenu')?.remove(); window.__embeddedCommands?.[idx]?.action(); }
  }
}

function embeddedPromptThenAction(label, defaultVal, onConfirm) {
  document.getElementById('embeddedCtxMenu')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'embeddedPromptOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10000;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:12px;padding:20px 24px;min-width:320px;box-shadow:0 8px 24px rgba(0,0,0,.25)">
      <div style="font-size:13px;font-weight:600;margin-bottom:10px">${esc(label)}</div>
      <input id="embeddedPromptInput" class="form-control" type="text" value="${esc(defaultVal)}" style="margin-bottom:12px" />
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('embeddedPromptOverlay').remove()">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="embeddedPromptConfirm()">Add Step</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  const input = document.getElementById('embeddedPromptInput');
  input.focus(); input.select();
  input.addEventListener('keydown', e => { if (e.key === 'Enter') embeddedPromptConfirm(); if (e.key === 'Escape') overlay.remove(); });
  window.__embeddedPromptCallback = onConfirm;
}

function embeddedPromptConfirm() {
  const val = document.getElementById('embeddedPromptInput')?.value;
  document.getElementById('embeddedPromptOverlay')?.remove();
  if (val !== undefined && window.__embeddedPromptCallback) window.__embeddedPromptCallback(val);
}

function handleEmbeddedTypeKey(e) {
  if (e.key === 'Enter') submitEmbeddedType();
  if (e.key === 'Escape') cancelEmbeddedType();
}

async function submitEmbeddedType() {
  const input = document.getElementById('embeddedTypeInput');
  const text = input?.value;
  if (!text) return;
  input.value = '';
  await sendEmbeddedAction({ type: 'type', text });
  setEmbeddedMode('click');
}

function cancelEmbeddedType() {
  setEmbeddedMode('click');
}

function handleEmbeddedScroll(e) {
  e.preventDefault();
  if (!embeddedBrowser) return;
  embeddedScrollAccum += e.deltaY;

  // After scrolling stops, take one screenshot to refresh the view
  clearTimeout(embeddedScrollStopTimer);
  embeddedScrollStopTimer = setTimeout(async () => {
    try {
      const data = await POST(`/api/browser-sessions/${embeddedBrowser.id}/action`, { type: 'scroll', y: 0, noStep: true });
      if (data.screenshot) {
        embeddedBrowser.screenshot = data.screenshot;
        embeddedBrowser.url = data.url;
        const shot = document.getElementById('embeddedShot');
        if (shot) shot.src = 'data:image/jpeg;base64,' + data.screenshot;
        const bar = document.getElementById('embeddedUrlBar');
        if (bar) bar.value = data.url;
      }
    } catch {}
  }, 150);

  // Drain the accumulator as fast as the server can handle it, no screenshot
  if (embeddedScrollSending) return;
  embeddedScrollSending = true;
  (async () => {
    while (embeddedScrollAccum !== 0) {
      const delta = embeddedScrollAccum;
      embeddedScrollAccum = 0;
      try {
        await POST(`/api/browser-sessions/${embeddedBrowser.id}/action`, { type: 'scroll', y: delta, noStep: true, noScreenshot: true });
      } catch {}
    }
    embeddedScrollSending = false;
  })();
}

async function resizeEmbeddedBrowser(value) {
  if (!embeddedBrowser) return;
  if (value === 'custom') {
    const input = prompt('Enter viewport size (e.g. 428x926):', `${embeddedBrowser.width}x${embeddedBrowser.height}`);
    if (!input) { document.getElementById('embeddedDevicePicker').value = `${embeddedBrowser.width}x${embeddedBrowser.height}`; return; }
    value = input.trim();
  }
  const [w, h] = value.split('x').map(Number);
  if (!w || !h) return;
  try {
    const data = await POST(`/api/browser-sessions/${embeddedBrowser.id}/action`, { type: 'resize', width: w, height: h, noStep: true });
    if (data.screenshot) {
      embeddedBrowser.width = w;
      embeddedBrowser.height = h;
      embeddedBrowser.screenshot = data.screenshot;
      embeddedBrowser.url = data.url;
      const shot = document.getElementById('embeddedShot');
      if (shot) shot.src = 'data:image/jpeg;base64,' + data.screenshot;
    }
  } catch (e) { toast('Could not resize viewport', 'error'); }
}

async function sendEmbeddedAction(action) {
  if (!embeddedBrowser || embeddedBrowserLoading) return;
  embeddedBrowserLoading = true;
  const overlay = document.getElementById('embeddedOverlay');
  if (overlay) overlay.style.display = 'flex';

  try {
    const data = await POST(`/api/browser-sessions/${embeddedBrowser.id}/action`, action);
    embeddedBrowser.screenshot = data.screenshot;
    embeddedBrowser.url = data.url;

    const shot = document.getElementById('embeddedShot');
    if (shot) shot.src = 'data:image/jpeg;base64,' + data.screenshot;
    const bar = document.getElementById('embeddedUrlBar');
    if (bar) bar.value = data.url;

    // Add steps to builder
    const stepsToAdd = [data.step, data.extraStep].filter(Boolean).map(s => {
      const { _isInput, ...clean } = s; return clean;
    });
    if (stepsToAdd.length) {
      builderSteps.push(...stepsToAdd);
      renderBuilderSteps();
    }
    // Always refresh tab bar shortly after a click — new tabs open async
    refreshEmbeddedTabs();
    setTimeout(refreshEmbeddedTabs, 2000);
    return data;
  } catch (e) {
    toast('Browser action failed: ' + e.message, 'error');
  } finally {
    embeddedBrowserLoading = false;
    const overlay = document.getElementById('embeddedOverlay');
    if (overlay) overlay.style.display = 'none';
  }
}

async function suggestStep() {
  const input = document.getElementById('suggestStepInput');
  const instruction = input?.value.trim();
  if (!instruction || !embeddedBrowser) return;

  const btn = document.getElementById('suggestStepBtn');
  if (btn) btn.disabled = true;
  const overlay = document.getElementById('embeddedOverlay');
  if (overlay) overlay.style.display = 'flex';

  try {
    const data = await POST(`/api/browser-sessions/${embeddedBrowser.id}/suggest-step`, { instruction });
    if (data.needsKey) {
      toast('AI not configured. Add ANTHROPIC_API_KEY to your environment.', 'error');
      return;
    }
    if (data.screenshot) {
      embeddedBrowser.screenshot = data.screenshot;
      embeddedBrowser.url = data.url;
      const shot = document.getElementById('embeddedShot');
      if (shot) shot.src = 'data:image/jpeg;base64,' + data.screenshot;
      const bar = document.getElementById('embeddedUrlBar');
      if (bar) bar.value = data.url;
    }
    if (data.error) {
      toast(data.error, 'error');
      return;
    }
    builderSteps.push(data.step);
    refreshStudio();
    if (input) input.value = '';
    toast('Step added: ' + stepDescription(data.step), 'success');
  } catch (e) {
    toast('Suggest step failed: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (overlay) overlay.style.display = 'none';
  }
}

function renderBuilderSteps() {
  const list = document.getElementById('builderStepList');
  if (list) {
    const top = list.scrollTop;
    if (builderSteps.length === 0) {
      list.innerHTML = `<div style="padding:20px;text-align:center;color:var(--muted);border:2px dashed var(--border);border-radius:var(--radius)">No steps yet. Add a step below or use AI to generate them.</div>`;
    } else {
      list.innerHTML = builderSteps.map((step, i) => stepItemHTML(step, i)).join('');
    }
    list.scrollTop = top;
  }
  // Keep studio list in sync if open
  const studioList = document.getElementById('studioStepList');
  if (studioList) {
    const top = studioList.scrollTop;
    studioList.innerHTML = renderStudioStepList();
    studioList.scrollTop = top;
  }
  saveDraft();
}

function stepItemHTML(step, i) {
  const params = step.params || {};
  const desc = stepDescription(step);

  // useAction steps get a special card
  if (step.type === 'useAction') {
    const action = state.actions.find(a => a.id === params.actionId);
    const stepCount = action ? action.steps.length : 0;
    const subStepsHTML = action && action.steps.length > 0
      ? action.steps.map((s, si) => `<div class="action-sub-step"><span class="step-type-badge step-type-${s.type}" style="font-size:10px">${s.type}</span> ${esc(stepDescription(s))}</div>`).join('')
      : '<div style="font-size:12px;color:var(--muted);padding:4px 0">No steps in this action</div>';

    return `<div class="step-item action-step-card" id="step-item-${i}">
      <div class="step-header" onclick="toggleStepExpand(${i})">
        <span class="step-num" style="background:linear-gradient(135deg,#3b82f6,#8b5cf6)">${i + 1}</span>
        <span class="step-type-badge" style="background:#ede9fe;color:#6d28d9;flex-shrink:0">♻️ Use Action</span>
        <span class="step-desc"><strong>${esc(params.actionName || '(choose action)')}</strong></span>
        ${action ? `<span style="font-size:11px;color:var(--muted);flex-shrink:0">${stepCount} step${stepCount !== 1 ? 's' : ''}</span>` : ''}
        <div class="step-actions" onclick="event.stopPropagation()">
          ${i > 0 ? `<button class="btn btn-xs btn-ghost" onclick="moveStep(${i},-1)" data-tooltip="Move up">↑</button>` : ''}
          ${i < builderSteps.length - 1 ? `<button class="btn btn-xs btn-ghost" onclick="moveStep(${i},1)" data-tooltip="Move down">↓</button>` : ''}
          <button class="btn btn-xs btn-ghost" style="color:var(--error)" onclick="deleteStep(${i})" data-tooltip="Delete">✕</button>
        </div>
      </div>
      <div class="step-body hidden" id="step-body-${i}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="font-size:12px;color:var(--muted)">Steps from <strong>${esc(params.actionName || '')}</strong>:</div>
          ${action ? `<button class="btn btn-xs btn-secondary" onclick="openActionBuilder('${params.actionId}')">Edit action →</button>` : ''}
        </div>
        <div class="action-sub-steps">${subStepsHTML}</div>
      </div>
    </div>`;
  }

  return `<div class="step-item" id="step-item-${i}" draggable="true"
    ondragstart="stepDragStart(event,${i},'builder')"
    ondragover="stepDragOver(event,${i},'builder')"
    ondrop="stepDrop(event,${i},'builder')"
    ondragend="stepDragEnd(event,'builder')"
    style="cursor:grab">
    <div class="step-header" onclick="toggleStepExpand(${i})">
      <span style="color:var(--muted);font-size:14px;padding:0 4px;cursor:grab;flex-shrink:0" data-tooltip="Drag to reorder">⠿</span>
      <span class="step-num">${i + 1}</span>
      <span class="step-type-badge step-type-${step.type}">${step.type}</span>
      <span class="step-desc">${esc(desc)}</span>
      <div class="step-actions" onclick="event.stopPropagation()">
        <button class="btn btn-xs btn-ghost" onclick="openAddStepPicker(${i + 1})" data-tooltip="Add step below">+</button>
        <button class="btn btn-xs btn-ghost" onclick="duplicateStep(${i})" data-tooltip="Duplicate step">⧉</button>
        <button class="btn btn-xs btn-ghost" style="color:var(--error)" onclick="deleteStep(${i})" data-tooltip="Delete">✕</button>
      </div>
    </div>
    <div class="step-body hidden" id="step-body-${i}">
      ${stepParamsForm(step, i)}
    </div>
  </div>`;
}

function toggleStepExpand(i) {
  const body = document.getElementById(`step-body-${i}`);
  if (body) body.classList.toggle('hidden');
}


function stepDragStart(e, i, ctx) {
  _dragSrcIndex = i;
  _dragContext = ctx;
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.style.opacity = '0.4';
}

function stepDragOver(e, i, ctx) {
  if (ctx !== _dragContext || i === _dragSrcIndex) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const prefix = ctx === 'action' ? 'ab-' : ctx === 'studio' ? 'studio-' : '';
  const idBase = ctx === 'studio' ? 'step' : 'step-item';
  document.querySelectorAll(`[id^="${prefix}${idBase}-"]`).forEach(el => el.style.borderTop = '');
  const target = document.getElementById(`${prefix}${idBase}-${i}`);
  if (target) target.style.borderTop = '2px solid var(--primary)';
}

function stepDrop(e, i, ctx) {
  e.preventDefault();
  if (ctx !== _dragContext || i === _dragSrcIndex || _dragSrcIndex === null) return;
  if (ctx === 'builder') {
    const [moved] = builderSteps.splice(_dragSrcIndex, 1);
    builderSteps.splice(i, 0, moved);
    renderBuilderSteps();
  } else if (ctx === 'studio') {
    const [moved] = builderSteps.splice(_dragSrcIndex, 1);
    builderSteps.splice(i, 0, moved);
    refreshStudio();
  } else {
    const [moved] = actionBuilderSteps.splice(_dragSrcIndex, 1);
    actionBuilderSteps.splice(i, 0, moved);
    renderActionBuilderSteps();
  }
  _dragSrcIndex = null;
}

function stepDragEnd(_e, ctx) {
  _dragSrcIndex = null;
  const prefix = ctx === 'action' ? 'ab-' : ctx === 'studio' ? 'studio-' : '';
  const idBase = ctx === 'studio' ? 'step' : 'step-item';
  document.querySelectorAll(`[id^="${prefix}${idBase}-"]`).forEach(el => {
    el.style.opacity = '';
    el.style.borderTop = '';
  });
}

function stepParamsForm(step, i) {
  const p = step.params || {};
  const selectorField = (label = 'Selector') => `
    <div class="form-row">
      <div class="form-group">
        <label>${label}</label>
        <input class="form-control" type="text" value="${esc(p.selector || '')}" onchange="updateStepParam(${i},'selector',this.value)" placeholder="Enter selector" />
      </div>
      <div class="form-group">
        <label>Selector Type</label>
        <select class="form-control" onchange="updateStepParam(${i},'selectorType',this.value)">
          <option value="css" ${(p.selectorType || 'css') === 'css' ? 'selected' : ''}>CSS Selector</option>
          <option value="text" ${p.selectorType === 'text' ? 'selected' : ''}>Visible Text</option>
          <option value="id" ${p.selectorType === 'id' ? 'selected' : ''}>Element ID</option>
          ${step.type === 'assertText' ? `<option value="page" ${p.selectorType === 'page' ? 'selected' : ''}>Whole Page</option>` : ''}
        </select>
      </div>
    </div>`;

  switch (step.type) {
    case 'navigate':
      return `<div class="form-group"><label>URL</label><input class="form-control" type="url" value="${esc(p.url || '')}" onchange="updateStepParam(${i},'url',this.value)" placeholder="https://example.com" /></div>`;

    case 'click':
      return selectorField() + `<div class="form-group"><label style="display:flex;align-items:center;gap:8px;font-weight:normal;cursor:pointer"><input type="checkbox" ${p.force ? 'checked' : ''} onchange="updateStepParam(${i},'force',this.checked)" /> Force click (bypasses visibility check — use for hidden/styled checkboxes)</label></div><div class="form-group"><label class="form-label">Match index <span style="color:var(--muted);font-weight:400">(if multiple elements match, 0 = first)</span></label><input class="form-control" type="number" min="0" placeholder="0" value="${p.nth !== undefined && p.nth !== '' ? p.nth : ''}" onchange="updateStepParam(${i},'nth',this.value===''?undefined:parseInt(this.value))" style="width:80px" /></div>`;
    case 'assertVisible':
    case 'hover':
    case 'checkElement':
      return selectorField() + (step.type === 'assertVisible' ? `<div class="form-group"><label class="form-label">Match index <span style="color:var(--muted);font-weight:400">(if multiple elements match, 0 = first)</span></label><input class="form-control" type="number" min="0" placeholder="0" value="${p.nth !== undefined && p.nth !== '' ? p.nth : ''}" onchange="updateStepParam(${i},'nth',this.value===''?undefined:parseInt(this.value))" style="width:80px" /></div>` : '');

    case 'type':
      return selectorField() + `<div class="form-group"><label>Text to Type</label><input class="form-control" type="text" value="${esc(p.value || '')}" onchange="updateStepParam(${i},'value',this.value)" placeholder="Text to enter" /></div>`;

    case 'assertText':
      return selectorField() + `
        <div class="form-group"><label>Expected Text</label><input class="form-control" type="text" value="${esc(p.text || '')}" onchange="updateStepParam(${i},'text',this.value)" placeholder="Expected text" /></div>
        <div class="form-group">
          <label>Match Type</label>
          <select class="form-control" onchange="updateStepParam(${i},'contains',this.value==='true')">
            <option value="true" ${p.contains !== false ? 'selected' : ''}>Contains (partial match)</option>
            <option value="false" ${p.contains === false ? 'selected' : ''}>Exact match</option>
          </select>
        </div>
        ${p.selectorType !== 'page' ? `<div class="form-group"><label class="form-label">Match index <span style="color:var(--muted);font-weight:400">(if multiple elements match, 0 = first)</span></label><input class="form-control" type="number" min="0" placeholder="0" value="${p.nth !== undefined && p.nth !== '' ? p.nth : ''}" onchange="updateStepParam(${i},'nth',this.value===''?undefined:parseInt(this.value))" style="width:80px" /></div>` : ''}`;

    case 'waitForElement':
      return selectorField() + `<div class="form-group"><label>Timeout (ms)</label><input class="form-control" type="number" value="${p.timeout || 5000}" onchange="updateStepParam(${i},'timeout',parseInt(this.value))" /></div>`;

    case 'screenshot':
      return `<div class="form-group"><label>Screenshot Label</label><input class="form-control" type="text" value="${esc(p.name || '')}" onchange="updateStepParam(${i},'name',this.value)" placeholder="e.g. after-login" /></div>`;

    case 'selectOption':
      return selectorField() + `<div class="form-group"><label>Option Value</label><input class="form-control" type="text" value="${esc(p.value || '')}" onchange="updateStepParam(${i},'value',this.value)" placeholder="Option value or text" /></div>`;

    case 'pressKey':
      return `<div class="form-group"><label>Key</label>
        <select class="form-control" onchange="updateStepParam(${i},'key',this.value)">
          ${['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Home','End'].map(k => `<option value="${k}" ${p.key === k ? 'selected' : ''}>${k}</option>`).join('')}
        </select></div>`;

    case 'scroll':
      return `
        <div class="form-group"><label>Direction</label>
          <select class="form-control" onchange="updateStepParam(${i},'direction',this.value)">
            <option value="down" ${(p.direction || 'down') === 'down' ? 'selected' : ''}>Down</option>
            <option value="up" ${p.direction === 'up' ? 'selected' : ''}>Up</option>
            <option value="to-element" ${p.direction === 'to-element' ? 'selected' : ''}>To Element</option>
          </select></div>
        <div class="form-group"><label>Pixels (for up/down)</label><input class="form-control" type="number" value="${p.pixels || 300}" onchange="updateStepParam(${i},'pixels',parseInt(this.value))" /></div>`;

    case 'scrollElement':
      return selectorField('Container Selector') + `
        <div class="form-group"><label>Direction</label>
          <select class="form-control" onchange="updateStepParam(${i},'direction',this.value)">
            <option value="down" ${(p.direction || 'down') === 'down' ? 'selected' : ''}>Down</option>
            <option value="up" ${p.direction === 'up' ? 'selected' : ''}>Up</option>
          </select></div>
        <div class="form-group"><label>Pixels</label><input class="form-control" type="number" value="${p.pixels || 300}" onchange="updateStepParam(${i},'pixels',parseInt(this.value))" /><div class="form-hint">Scrolls inside the element, not the whole page. Use this for sticky banners, modals, or any element with its own scroll.</div></div>`;

    case 'assertURL':
      return `
        <div class="form-group"><label>URL</label><input class="form-control" type="text" value="${esc(p.url || '')}" onchange="updateStepParam(${i},'url',this.value)" placeholder="https://example.com/page" /><div class="form-hint">Use {{variableName}} to insert a variable</div></div>
        <div class="form-group"><label>Match Type</label>
          <select class="form-control" onchange="updateStepParam(${i},'matchType',this.value)">
            <option value="exact" ${(p.matchType || 'exact') === 'exact' ? 'selected' : ''}>Exact</option>
            <option value="contains" ${p.matchType === 'contains' ? 'selected' : ''}>Contains</option>
            <option value="regex" ${p.matchType === 'regex' ? 'selected' : ''}>Regex</option>
          </select></div>`;

    case 'assertNotVisible':
    case 'clearField':
    case 'scrollToElement':
    case 'switchFrame':
      return selectorField();

    case 'assertAttribute':
      return selectorField() + `
        <div class="form-row">
          <div class="form-group"><label>Attribute</label><input class="form-control" type="text" value="${esc(p.attribute || 'href')}" onchange="updateStepParam(${i},'attribute',this.value)" placeholder="href, src, data-id…" /></div>
          <div class="form-group"><label>Match Type</label>
            <select class="form-control" onchange="updateStepParam(${i},'matchType',this.value)">
              <option value="exact" ${(p.matchType || 'exact') === 'exact' ? 'selected' : ''}>Exact</option>
              <option value="contains" ${p.matchType === 'contains' ? 'selected' : ''}>Contains</option>
            </select></div>
        </div>
        <div class="form-group"><label>Expected Value</label><input class="form-control" type="text" value="${esc(p.value || '')}" onchange="updateStepParam(${i},'value',this.value)" placeholder="Expected attribute value" /><div class="form-hint">Use {{variableName}} to insert a variable</div></div>`;

    case 'assertCSS':
      return selectorField() + `
        <div class="form-row">
          <div class="form-group"><label>CSS Property</label><input class="form-control" type="text" value="${esc(p.property || 'color')}" onchange="updateStepParam(${i},'property',this.value)" placeholder="color, background-color…" /></div>
          <div class="form-group"><label>Match Type</label>
            <select class="form-control" onchange="updateStepParam(${i},'matchType',this.value)">
              <option value="exact" ${(p.matchType || 'exact') === 'exact' ? 'selected' : ''}>Exact</option>
              <option value="contains" ${p.matchType === 'contains' ? 'selected' : ''}>Contains</option>
            </select></div>
        </div>
        <div class="form-group"><label>Expected Value</label><input class="form-control" type="text" value="${esc(p.value || '')}" onchange="updateStepParam(${i},'value',this.value)" placeholder="e.g. rgb(255, 255, 255)" /></div>`;

    case 'waitForNetwork':
      return `<div class="form-group"><label>Timeout (ms)</label><input class="form-control" type="number" value="${p.timeout || 5000}" onchange="updateStepParam(${i},'timeout',parseInt(this.value))" /></div>`;

    case 'waitSeconds':
      return `<div class="form-group"><label>Seconds</label><input class="form-control" type="number" min="1" max="60" step="1" value="${p.seconds || 3}" onchange="updateStepParam(${i},'seconds',parseInt(this.value)||1)" /></div>`;

    case 'runJS':
      return `<div class="form-group"><label>JavaScript</label><textarea class="form-control" rows="4" style="font-family:monospace;font-size:13px" onchange="updateStepParam(${i},'script',this.value)" placeholder="document.querySelector('#edit-age-18').click();">${esc(p.script || '')}</textarea><div class="form-hint">Runs in the browser. Use document.querySelector() to target elements.</div></div>`;

    case 'visualBaseline':
      return `
        <div class="form-group"><label>Baseline Name</label><input class="form-control" type="text" value="${esc(p.name || '')}" onchange="updateStepParam(${i},'name',this.value)" placeholder="e.g. homepage-hero" /></div>
        <div class="form-group"><label>Threshold (0–1, e.g. 0.1 = 10% allowed diff)</label><input class="form-control" type="number" step="0.01" min="0" max="1" value="${p.threshold !== undefined ? p.threshold : 0.1}" onchange="updateStepParam(${i},'threshold',parseFloat(this.value))" /></div>`;

    case 'newTab':
      return selectorField('Click Target Selector') + `
        <div class="form-group"><label>Assert New Tab URL (optional, exact)</label><input class="form-control" type="text" value="${esc(p.assertURL || '')}" onchange="updateStepParam(${i},'assertURL',this.value)" placeholder="https://..." /></div>
        <div class="form-group"><label>Assert New Tab URL Contains (optional)</label><input class="form-control" type="text" value="${esc(p.assertURLContains || '')}" onchange="updateStepParam(${i},'assertURLContains',this.value)" placeholder="checkout" /></div>
        <div class="form-group"><label>Assert New Tab Contains Text (optional)</label><input class="form-control" type="text" value="${esc(p.assertText || '')}" onchange="updateStepParam(${i},'assertText',this.value)" placeholder="Page title or body text" /></div>
        <div class="form-group"><label>Assert New Tab PDF Contains (optional)</label><input class="form-control" type="text" value="${esc(p.assertPDFText || '')}" onchange="updateStepParam(${i},'assertPDFText',this.value)" placeholder="Text that should appear in the PDF" /></div>
        <div class="form-group"><label style="display:flex;align-items:center;gap:8px;font-weight:normal;cursor:pointer"><input type="checkbox" ${p.switchToTab ? 'checked' : ''} onchange="updateStepParam(${i},'switchToTab',this.checked)" /> Switch to new tab (subsequent steps run in the new tab)</label></div>`;

    case 'fileDownload':
      return selectorField('Download Link Selector') + `
        <div class="form-group"><label>Expected Filename (optional, partial match)</label><input class="form-control" type="text" value="${esc(p.expectedFilename || '')}" onchange="updateStepParam(${i},'expectedFilename',this.value)" placeholder="report.pdf" /></div>`;

    case 'assertPDFContains':
      return selectorField('Download Button/Link Selector') + `
        <div class="form-group">
          <label>Expected Text in PDF *</label>
          <input class="form-control" type="text" value="${esc(p.expectedText || '')}" onchange="updateStepParam(${i},'expectedText',this.value)" placeholder="e.g. Total Score: 42" />
          <div class="form-hint">Clicks the selector to trigger the PDF download, then checks that the PDF's text contains this value.</div>
        </div>`;

    case 'assertInViewport':
      return selectorField() + `
        <div class="form-group">
          <div class="form-hint">Checks that the element is currently visible within the browser window — i.e. the page has scrolled to it. Use this after clicking a jump link to confirm the target section is in view.</div>
        </div>`;

    case 'assertNoNavigation':
      return `
        <div class="form-group">
          <label>Wait Duration (ms)</label>
          <input class="form-control" type="number" value="${p.waitMs || 1000}" onchange="updateStepParam(${i},'waitMs',parseInt(this.value)||1000)" min="200" max="10000" />
          <div class="form-hint">After the previous step, waits this long and then confirms the page did not reload or navigate away. Use after clicking a tab, anchor link, or similar element.</div>
        </div>`;

    case 'assertElementSize':
      return `
        <div class="form-group"><label>Element Selector (CSS)</label><input class="form-control" type="text" value="${esc(p.selector || '')}" onchange="updateStepParam(${i},'selector',this.value)" placeholder="e.g. aside.fixed" /></div>
        <div class="form-group"><label>Dimension</label>
          <select class="form-control" onchange="updateStepParam(${i},'dimension',this.value)">
            <option value="height" ${(p.dimension||'height')==='height'?'selected':''}>Height</option>
            <option value="width" ${p.dimension==='width'?'selected':''}>Width</option>
          </select>
        </div>
        <div class="form-group"><label>Expected (% of viewport)</label>
          <input class="form-control" type="number" min="0" max="100" step="0.1" value="${p.expected ?? ''}" onchange="updateStepParam(${i},'expected',parseFloat(this.value))" placeholder="e.g. 15.5" />
          <div class="form-hint">Run the test once to see the actual value in the step result, then set this to the correct number.</div>
        </div>
        <div class="form-group"><label>Tolerance (±%)</label>
          <input class="form-control" type="number" min="0" max="20" step="0.5" value="${p.tolerance ?? 2}" onchange="updateStepParam(${i},'tolerance',parseFloat(this.value))" />
        </div>`;

    case 'exitFrame':
      return `<div class="text-muted text-sm">No parameters needed — exits the current iframe context.</div>`;

    case 'closeTab':
      return `<div class="text-muted text-sm">Closes the current tab and returns subsequent steps to the previous tab.</div>`;

    case 'switchToNewTab':
      return `<div class="form-group"><label>Assert URL Contains (optional)</label><input class="form-control" type="text" value="${esc(p.assertURLContains || '')}" onchange="updateStepParam(${i},'assertURLContains',this.value)" placeholder="e.g. tryngolza.com" /></div>
              <div class="form-hint">Waits up to 8s for a new tab to open, then switches to it. Place this immediately after the click that opens the tab.</div>`;

    case 'useAction':
      return `<div class="text-muted text-sm">Action reference — use the expand view above to inspect steps.</div>`;

    case 'accessibilityScan':
      return `
        <div class="form-group"><label style="display:flex;align-items:center;gap:8px;font-weight:normal;cursor:pointer"><input type="checkbox" ${p.selector !== undefined ? 'checked' : ''} onchange="toggleStepElementScope(${i},this.checked)" /> Scope to one element (leave unchecked to scan the whole page)</label></div>
        ${p.selector !== undefined ? selectorField('Element to scope the scan to') : ''}
        <div class="form-group"><label>Fail on</label>
          <select class="form-control" onchange="updateStepParam(${i},'failOn',this.value)">
            <option value="serious" ${(p.failOn || 'serious') === 'serious' ? 'selected' : ''}>Serious or Critical (recommended)</option>
            <option value="critical" ${p.failOn === 'critical' ? 'selected' : ''}>Critical only</option>
            <option value="moderate" ${p.failOn === 'moderate' ? 'selected' : ''}>Moderate or above</option>
            <option value="minor" ${p.failOn === 'minor' ? 'selected' : ''}>Any violation (incl. Minor)</option>
          </select>
        </div>
        <div class="form-hint">Runs a real axe-core scan (WCAG 2.2 AA) in the browser. A pass means no mechanical failures were found at this severity — not full conformance. Lower-severity violations and "needs manual review" items are still reported, just not failed.</div>`;

    case 'compareURLs':
      return `
        <div class="form-group"><label>Compare Against URL</label><input class="form-control" type="url" value="${esc(p.compareUrl || '')}" onchange="updateStepParam(${i},'compareUrl',this.value)" placeholder="https://prod.example.com/same/path" /><div class="form-hint">Use {{variableName}} to insert a variable — e.g. an environment's base URL</div></div>
        <div class="form-group"><label style="display:flex;align-items:center;gap:8px;font-weight:normal;cursor:pointer"><input type="checkbox" ${p.selector !== undefined ? 'checked' : ''} onchange="toggleStepElementScope(${i},this.checked)" /> Scope to one element (leave unchecked to compare the full page)</label></div>
        ${p.selector !== undefined ? selectorField('Element to compare') : ''}
        <div class="form-group"><label>Sensitivity Threshold</label><input class="form-control" type="number" min="0" max="1" step="0.01" value="${p.threshold ?? 0.1}" onchange="updateStepParam(${i},'threshold',parseFloat(this.value))" /><div class="form-hint">Lower = stricter. Fails when more than this fraction of pixels differ (default 0.1 = 10%).</div></div>
        <div class="form-hint">Screenshots this page and the URL above, then pixel-diffs them. Runs in a separate tab, so it won't disturb this scenario's own navigation.</div>`;

    default:
      return `<div class="text-muted text-sm">No parameters for this step type.</div>`;
  }
}

function updateStepParam(index, key, value) {
  if (!builderSteps[index]) return;
  builderSteps[index].params = builderSteps[index].params || {};
  builderSteps[index].params[key] = value;
  // Update desc in step builder
  const descEl = document.querySelector(`#step-item-${index} .step-desc`);
  if (descEl) descEl.textContent = stepDescription(builderSteps[index]);
  // Update desc in studio if open
  const studioItem = document.getElementById(`studio-step-${index}`);
  if (studioItem) {
    const span = studioItem.querySelector('span[title]');
    if (span) { span.textContent = stepDescription(builderSteps[index]); span.title = stepDescription(builderSteps[index]); }
  }
  saveDraftDebounced();
}

function toggleStepElementScope(index, scoped) {
  const step = builderSteps[index];
  if (!step) return;
  step.params = step.params || {};
  if (scoped) {
    step.params.selector = '';
    step.params.selectorType = 'css';
  } else {
    delete step.params.selector;
    delete step.params.selectorType;
  }
  renderBuilderSteps();
}

function moveStep(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= builderSteps.length) return;
  [builderSteps[i], builderSteps[j]] = [builderSteps[j], builderSteps[i]];
  renderBuilderSteps();
}

function deleteStep(i) {
  builderSteps.splice(i, 1);
  renderBuilderSteps();
}

function duplicateStep(i) {
  const copy = JSON.parse(JSON.stringify(builderSteps[i]));
  copy.id = 'step_' + Date.now();
  builderSteps.splice(i + 1, 0, copy);
  renderBuilderSteps();
}

function openAddStepPicker(insertAt) {
  const idx = insertAt != null ? insertAt : null;
  const html = `
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px">Choose the type of step to add:</p>
    <div class="step-type-picker">
      ${STEP_TYPES.map(st => `
      <div class="step-type-option" onclick="addStep('${st.type}',${idx != null ? idx : 'null'})">
        <div class="sto-label">${st.label}</div>
        <div class="sto-desc">${st.desc}</div>
      </div>`).join('')}
    </div>`;

  // use a sub-modal approach: just a simple overlay on top of the existing modal
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'stepPickerOverlay';
  overlay.style.zIndex = '1100';
  overlay.innerHTML = `<div class="modal modal-md">
    <div class="modal-header">
      <h2>Add Step</h2>
      <button class="modal-close" onclick="document.getElementById('stepPickerOverlay').remove()">✕</button>
    </div>
    <div class="modal-body">${html}</div>
  </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function addStep(type, insertAt) {
  const overlay = document.getElementById('stepPickerOverlay');
  if (overlay) overlay.remove();

  if (type === 'useAction') {
    openActionPickerForStep(insertAt);
    return;
  }

  const defaults = {
    navigate:         { url: '' },
    click:            { selector: '', selectorType: 'text' },
    type:             { selector: '', selectorType: 'id', value: '' },
    clearField:       { selector: '', selectorType: 'css' },
    assertText:       { selector: '', selectorType: 'page', text: '', contains: true },
    assertVisible:    { selector: '', selectorType: 'css' },
    assertNotVisible: { selector: '', selectorType: 'css' },
    assertURL:        { url: '', matchType: 'contains' },
    assertAttribute:  { selector: '', selectorType: 'css', attribute: 'href', value: '', matchType: 'exact' },
    assertCSS:        { selector: '', selectorType: 'css', property: 'color', value: '', matchType: 'exact' },
    waitForElement:   { selector: '', selectorType: 'css', timeout: 5000 },
    waitForNetwork:   { timeout: 5000 },
    screenshot:       { name: '' },
    visualBaseline:   { name: '', threshold: 0.1 },
    hover:            { selector: '', selectorType: 'css' },
    checkElement:     { selector: '', selectorType: 'css' },
    runJS:            { script: '' },
    closeTab:         {},
    switchToNewTab:   { assertURLContains: '' },
    selectOption:     { selector: '', selectorType: 'css', value: '' },
    pressKey:         { key: 'Enter' },
    scroll:           { direction: 'down', pixels: 300 },
    scrollToElement:  { selector: '', selectorType: 'css' },
    scrollElement:    { selector: '', selectorType: 'css', direction: 'down', pixels: 300 },
    newTab:           { selector: '', selectorType: 'text', assertURL: '', assertURLContains: '', assertText: '' },
    fileDownload:     { selector: '', selectorType: 'text', expectedFilename: '' },
    switchFrame:        { selector: '', selectorType: 'css' },
    exitFrame:          {},
    waitSeconds:        { seconds: 3 },
    assertElementSize:  { selector: '', dimension: 'height', expected: null, tolerance: 2 }
  };

  const newStep = { id: 'step_' + Date.now(), type, params: defaults[type] || {} };
  if (insertAt != null && insertAt >= 0 && insertAt <= builderSteps.length) {
    builderSteps.splice(insertAt, 0, newStep);
  } else {
    builderSteps.push(newStep);
  }

  renderBuilderSteps();

  // Auto-expand the new step
  setTimeout(() => {
    const idx = insertAt != null ? insertAt : builderSteps.length - 1;
    const body = document.getElementById(`step-body-${idx}`);
    if (body) body.classList.remove('hidden');
    const item = document.getElementById(`step-item-${idx}`);
    if (item) item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 50);
}

async function openActionPickerForStep() {
  await loadActions();
  const projectId = document.getElementById('sbProject')?.value || state.currentProjectId;
  const available = projectId
    ? state.actions.filter(a => a.projectId === projectId || !a.projectId)
    : state.actions;

  if (available.length === 0) {
    toast('No actions yet. Create an action first.', 'info');
    return;
  }

  const html = `
    <p style="font-size:13px;color:var(--muted);margin-bottom:12px">Choose an action to insert as a step:</p>
    <input class="form-control" type="text" id="actionPickerSearch" placeholder="Search actions…" style="margin-bottom:12px" oninput="filterActionPicker()" />
    <div id="actionPickerList">
      ${available.map(a => `
      <div class="action-picker-item" data-name="${esc(a.name.toLowerCase())}" onclick="insertActionStep('${a.id}','${esc(a.name)}')">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:14px">${esc(a.name)}</strong>
          <span style="font-size:11px;background:#ede9fe;color:#6d28d9;padding:2px 8px;border-radius:10px;font-weight:600">${a.steps.length} step${a.steps.length !== 1 ? 's' : ''}</span>
        </div>
        ${a.description ? `<div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(a.description)}</div>` : ''}
      </div>`).join('')}
    </div>`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'actionPickerOverlay';
  overlay.style.zIndex = '1100';
  overlay.innerHTML = `<div class="modal modal-md">
    <div class="modal-header">
      <h2>Choose an Action</h2>
      <button class="modal-close" onclick="document.getElementById('actionPickerOverlay').remove()">✕</button>
    </div>
    <div class="modal-body">${html}</div>
  </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function filterActionPicker() {
  const q = document.getElementById('actionPickerSearch').value.toLowerCase();
  document.querySelectorAll('.action-picker-item').forEach(item => {
    item.style.display = item.dataset.name.includes(q) ? '' : 'none';
  });
}

function insertActionStep(actionId, actionName) {
  const overlay = document.getElementById('actionPickerOverlay');
  if (overlay) overlay.remove();

  builderSteps.push({
    id: 'step_' + Date.now(),
    type: 'useAction',
    params: { actionId, actionName }
  });

  renderBuilderSteps();
  toast(`Action "${actionName}" added as step`, 'success');
}

function stepDescription(step) {
  const p = step.params || {};
  switch (step.type) {
    case 'navigate':         return `Navigate to ${p.url || '(url)'}`;
    case 'click':            return `Click "${p.selector || '(selector)'}"`;
    case 'type':             return `Type "${p.value || ''}" into "${p.selector || '(selector)'}"`;
    case 'clearField':       return `Clear field "${p.selector || '(selector)'}"`;
    case 'assertText':       return p.selectorType === 'page' ? `Page contains "${p.text || ''}"` : `"${p.selector || ''}"${p.nth !== undefined && p.nth !== '' ? ` [${p.nth}]` : ''} contains "${p.text || ''}"`;
    case 'assertVisible':    return `"${p.selector || '(selector)'}"${p.nth !== undefined && p.nth !== '' ? ` [${p.nth}]` : ''} is visible`;
    case 'assertNotVisible': return `"${p.selector || '(selector)'}" is NOT visible`;
    case 'assertURL':        return `URL ${p.matchType || 'contains'} "${p.url || ''}"`;
    case 'assertAttribute':  return `"${p.selector || ''}" attr "${p.attribute || ''}" ${p.matchType || 'exact'} "${p.value || ''}"`;
    case 'assertCSS':        return `"${p.selector || ''}" CSS "${p.property || ''}" ${p.matchType || 'exact'} "${p.value || ''}"`;
    case 'waitForElement':   return `Wait for "${p.selector || '(selector)'}"`;
    case 'waitForNetwork':   return `Wait for network idle (${p.timeout || 5000}ms)`;
    case 'waitSeconds':      return `Wait ${p.seconds || 3}s`;
    case 'screenshot':       return `Take screenshot "${p.name || ''}"`;
    case 'visualBaseline':   return `Visual baseline "${p.name || ''}"`;
    case 'hover':            return `Hover over "${p.selector || '(selector)'}"`;
    case 'checkElement':     return `Check checkbox "${p.selector || '(selector)'}"`;
    case 'runJS':            return `Run JS: ${(p.script || '').substring(0, 40) || '(script)'}`;
    case 'selectOption':     return `Select "${p.value || ''}" from "${p.selector || '(selector)'}"`;
    case 'pressKey':         return `Press ${p.key || 'Enter'}`;
    case 'scroll':           return `Scroll ${p.direction || 'down'} ${p.pixels ? p.pixels + 'px' : ''}`;
    case 'scrollToElement':  return `Scroll to "${p.selector || '(selector)'}"`;
    case 'scrollElement':    return `Scroll "${p.selector || '(selector)'}" ${p.direction || 'down'} ${p.pixels ? p.pixels + 'px' : ''}`;
    case 'newTab':           return `Open new tab via "${p.selector || '(selector)'}"`;
    case 'fileDownload':        return `Download file via "${p.selector || '(selector)'}"`;
    case 'assertPDFContains':   return `Assert PDF contains "${p.expectedText || '(text)'}"`;
    case 'assertInViewport':     return `Assert "${p.selector || '(selector)'}" is in viewport`;
    case 'assertNoNavigation':   return `Assert no navigation/reload (${p.waitMs || 1000}ms)`;
    case 'assertElementSize':    return `Assert "${p.selector || '(selector)'}" ${p.dimension || 'height'} = ${p.expected ?? '?'}% ±${p.tolerance ?? 2}%`;
    case 'accessibilityScan':    return `Accessibility scan (WCAG 2.2 AA)${p.selector ? ` on "${p.selector}"` : ' on full page'}${p.failOn && p.failOn !== 'serious' ? `, fail on ${p.failOn}+` : ''}`;
    case 'compareURLs':          return `Compare this page vs "${p.compareUrl || '(url)'}"${p.selector ? ` on "${p.selector}"` : ''}`;
    case 'switchFrame':         return `Switch to iframe "${p.selector || '(selector)'}"`;
    case 'exitFrame':        return 'Exit iframe (return to main page)';
    case 'closeTab':         return 'Close current tab';
    case 'switchToNewTab':   return `Switch to new tab${p.assertURLContains ? ` (URL contains "${p.assertURLContains}")` : ''}`;
    case 'useAction':        return `Use Action: ${p.actionName || '(choose action)'}`;
    default:                 return step.type;
  }
}

// ─── AI AGENT (LIVE BROWSER) ──────────────────────────────────────────────────

let activeAgentSession = null; // { id, cancelled }

function agentLogLine(text, cls) {
  const log = document.getElementById('agentLog');
  if (!log) return;
  const row = document.createElement('div');
  if (cls) row.style.color = `var(--${cls})`;
  row.textContent = text;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function setAgentStatus(html) {
  const el = document.getElementById('agentStatus');
  if (!el) return;
  if (!html) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = html;
}

async function startAiAgent() {
  const instruction = document.getElementById('agentInstruction').value.trim();
  if (!instruction) { toast('Describe what the agent should check first', 'error'); return; }
  const startUrl = document.getElementById('agentStartUrl').value.trim();

  document.getElementById('agentRunBtn').disabled = true;
  document.getElementById('agentStopBtn').classList.remove('hidden');
  document.getElementById('agentLog').innerHTML = '';
  setAgentStatus('<div class="alert alert-info">🤖 Starting the agent…</div>');

  let sessionId;
  try {
    const result = await POST('/api/ai-agent-sessions', { instruction, startUrl });
    if (result.needsKey) {
      toast('AI not configured. Add ANTHROPIC_API_KEY to your environment.', 'error');
      setAgentStatus(`<div class="alert alert-warning"><strong>AI features require an API key.</strong><br>Set the <code>ANTHROPIC_API_KEY</code> environment variable before starting the server.</div>`);
      resetAgentButtons();
      return;
    }
    sessionId = result.id;
  } catch (e) {
    toast('Failed to start agent: ' + e.message, 'error');
    setAgentStatus('');
    resetAgentButtons();
    return;
  }

  activeAgentSession = { id: sessionId, cancelled: false };
  setAgentStatus('<div class="alert alert-info">🤖 Agent is exploring the site…</div>');

  let since = 0;
  while (activeAgentSession && activeAgentSession.id === sessionId && !activeAgentSession.cancelled) {
    await new Promise(r => setTimeout(r, 1200));
    if (!activeAgentSession || activeAgentSession.cancelled) break;
    let data;
    try {
      data = await GET(`/api/ai-agent-sessions/${sessionId}/events?since=${since}`);
    } catch (e) {
      agentLogLine('Connection error while polling the agent.', 'error');
      break;
    }
    for (const event of data.events) handleAgentEvent(event);
    since += data.events.length;
    if (data.done) break;
  }

  activeAgentSession = null;
  resetAgentButtons();
}

function handleAgentEvent(event) {
  if (event.type === 'log') {
    agentLogLine(event.message);
  } else if (event.type === 'step') {
    builderSteps.push(event.step);
    renderBuilderSteps();
    if (activeBuilderTab === 'record') refreshStudio();
  } else if (event.type === 'error') {
    agentLogLine('⚠️ ' + event.message, 'error');
  } else if (event.type === 'done') {
    setAgentStatus(`<div class="alert alert-info">✅ Done — ${builderSteps.length} step${builderSteps.length === 1 ? '' : 's'} added. Review them in <strong>🔧 Step Builder</strong>, then save.</div>`);
    toast('AI Agent finished building the test', 'success');
  }
}

function resetAgentButtons() {
  const runBtn = document.getElementById('agentRunBtn');
  const stopBtn = document.getElementById('agentStopBtn');
  if (runBtn) runBtn.disabled = false;
  if (stopBtn) stopBtn.classList.add('hidden');
}

function stopAiAgent() {
  if (!activeAgentSession) return;
  activeAgentSession.cancelled = true;
  DEL(`/api/ai-agent-sessions/${activeAgentSession.id}`).catch(() => {});
  agentLogLine('Stopping…');
  resetAgentButtons();
}

// ─── SAVE STEPS AS ACTION MODAL ───────────────────────────────────────────────

function openSaveStepsAsActionModal() {
  if (builderSteps.length === 0) {
    toast('Add at least one step first', 'error');
    return;
  }

  const projectId = document.getElementById('sbProject')?.value || state.currentProjectId;

  const stepsListHTML = builderSteps.map((step, i) => {
    if (step.type === 'useAction') return ''; // skip nested action refs
    return `<label style="display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:6px;cursor:pointer">
      <input type="checkbox" class="save-action-step-cb" value="${i}" checked />
      <span class="step-type-badge step-type-${step.type}" style="font-size:10px">${step.type}</span>
      <span style="font-size:13px">${esc(stepDescription(step))}</span>
    </label>`;
  }).join('');

  const html = `
    <div class="form-group">
      <label>Action Name *</label>
      <input class="form-control" id="saName" type="text" placeholder="e.g. Login as Admin" />
    </div>
    <div class="form-group">
      <label>Description</label>
      <input class="form-control" id="saDesc" type="text" placeholder="What does this action do?" />
    </div>
    <div class="form-group">
      <label>Select Steps to Include</label>
      <div style="max-height:300px;overflow-y:auto">
        ${stepsListHTML || '<div style="color:var(--muted);font-size:13px">No eligible steps (useAction steps cannot be nested)</div>'}
      </div>
    </div>`;

  openModal('Save Steps as Action', html, 'modal-md', async () => {
    const name = document.getElementById('saName').value.trim();
    if (!name) { toast('Action name is required', 'error'); return false; }
    const selectedIndices = Array.from(document.querySelectorAll('.save-action-step-cb:checked')).map(cb => parseInt(cb.value));
    if (selectedIndices.length === 0) { toast('Select at least one step', 'error'); return false; }
    const selectedSteps = selectedIndices.map(i => JSON.parse(JSON.stringify(builderSteps[i])));
    const desc = document.getElementById('saDesc').value.trim();
    try {
      const action = await POST('/api/actions', {
        name,
        description: desc,
        projectId: projectId || null,
        steps: selectedSteps
      });
      state.actions.push(action);
      toast(`Action "${name}" saved!`, 'success');
      // Ask whether to replace steps with the action reference
      setTimeout(() => askReplaceWithAction(action, selectedIndices), 300);
    } catch (e) { toast('Error: ' + e.message, 'error'); return false; }
  }, 'Save Action');
}

function askReplaceWithAction(action, selectedIndices) {
  if (!confirm(`Replace the ${selectedIndices.length} selected step${selectedIndices.length !== 1 ? 's' : ''} with a reference to "${action.name}"?`)) return;
  // Replace first occurrence of the range with the useAction step, remove the rest
  const minIdx = Math.min(...selectedIndices);
  const useActionStep = {
    id: 'step_' + Date.now(),
    type: 'useAction',
    params: { actionId: action.id, actionName: action.name }
  };
  // Build new steps array: replace selected indices with single useAction step
  const sortedIndices = [...selectedIndices].sort((a, b) => a - b);
  const newSteps = [];
  let inserted = false;
  for (let i = 0; i < builderSteps.length; i++) {
    if (sortedIndices.includes(i)) {
      if (!inserted) { newSteps.push(useActionStep); inserted = true; }
    } else {
      newSteps.push(builderSteps[i]);
    }
  }
  builderSteps = newSteps;
  renderBuilderSteps();
  toast(`Steps replaced with "${action.name}" action reference`, 'success');
}

// ─── ACTIONS PAGE ─────────────────────────────────────────────────────────────

async function renderActionsPage() {
  await loadActions();
  const main = document.getElementById('mainContent');

  if (state.actions.length === 0) {
    main.innerHTML = `
      <div class="page-header">
        <h1>Actions</h1>
        <button class="btn btn-primary" onclick="openActionBuilder(null)">+ New Action</button>
      </div>
      <div class="empty-state">
        <div class="es-icon">♻️</div>
        <h3>No actions yet</h3>
        <p>Save a group of steps once and reuse them across scenarios. When you update an action, every scenario using it automatically gets the update.</p>
        <button class="btn btn-primary" onclick="openActionBuilder(null)">Create First Action</button>
      </div>`;
    return;
  }

  main.innerHTML = `
    <div class="page-header">
      <div><h1>Actions</h1><div class="subtitle">${state.actions.length} action${state.actions.length !== 1 ? 's' : ''}</div></div>
      <button class="btn btn-primary" onclick="openActionBuilder(null)">+ New Action</button>
    </div>
    <div class="filter-bar">
      <input class="form-control search-input" type="text" placeholder="Search actions…" id="actionSearch" oninput="filterActions()" />
    </div>
    <div class="scenario-list" id="actionList">
      ${renderActionCards(state.actions)}
    </div>`;
}

function renderActionCards(actions) {
  if (actions.length === 0) return `<div class="empty-state" style="padding:40px"><div class="es-icon">🔍</div><h3>No results</h3><p>Try adjusting your search.</p></div>`;
  return actions.map(a => {
    const project = state.projects.find(p => p.id === a.projectId);
    const usedIn = state.scenarios.filter(s => (s.steps || []).some(st => st.type === 'useAction' && st.params?.actionId === a.id));
    return `<div class="scenario-card action-card-item">
      <span class="step-type-badge" style="background:#ede9fe;color:#6d28d9;flex-shrink:0">♻️</span>
      <div class="sc-info">
        <div class="sc-name">${esc(a.name)}</div>
        <div class="sc-meta">
          <span>${a.steps.length} step${a.steps.length !== 1 ? 's' : ''}</span>
          ${project ? `<span style="font-size:11px;background:${project.color || '#3b82f6'}22;color:${project.color || '#3b82f6'};padding:1px 8px;border-radius:10px;font-weight:600">${esc(project.name)}</span>` : ''}
          ${usedIn.length > 0 ? `<span style="color:var(--muted)">used in ${usedIn.length} scenario${usedIn.length !== 1 ? 's' : ''}</span>` : ''}
          ${a.description ? `<span class="text-muted text-sm">${esc(a.description)}</span>` : ''}
        </div>
      </div>
      <div class="sc-actions">
        <button class="btn btn-sm btn-ghost" onclick="openActionBuilder('${a.id}')" data-tooltip="Edit">✏️ Edit</button>
        <button class="btn btn-sm btn-ghost" onclick="deleteAction('${a.id}')" data-tooltip="Delete" style="color:var(--error)">🗑️</button>
      </div>
    </div>`;
  }).join('');
}

function filterActions() {
  const q = document.getElementById('actionSearch').value.toLowerCase();
  let filtered = state.actions;
  if (q) filtered = filtered.filter(a => a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q));
  document.getElementById('actionList').innerHTML = renderActionCards(filtered);
}

async function deleteAction(id) {
  const action = state.actions.find(a => a.id === id);
  if (!confirm(`Delete action "${action?.name || ''}"? Scenarios using it will need to be updated.`)) return;
  try {
    const result = await DEL(`/api/actions/${id}`);
    state.actions = state.actions.filter(a => a.id !== id);
    if (result.referencedByScenarios && result.referencedByScenarios.length > 0) {
      toast(`Action deleted. Referenced by: ${result.referencedByScenarios.join(', ')}`, 'info');
    } else {
      toast('Action deleted', 'success');
    }
    navigate('actions');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── ACTION BUILDER MODAL ─────────────────────────────────────────────────────

let actionBuilderSteps = [];
let actionBuilderId = null;

async function openActionBuilder(actionId) {
  actionBuilderId = actionId;
  let action = null;

  if (actionId) {
    try { action = await GET(`/api/actions/${actionId}`); }
    catch { toast('Could not load action', 'error'); return; }
  }

  actionBuilderSteps = action ? JSON.parse(JSON.stringify(action.steps || [])) : [];

  await loadActions(); // ensure state.actions is fresh

  const projectOpts = state.projects.map(p =>
    `<option value="${p.id}" ${(action?.projectId || state.currentProjectId) === p.id ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');

  const html = `
    <div class="form-row">
      <div class="form-group">
        <label>Action Name *</label>
        <input class="form-control" id="abName" type="text" placeholder="e.g. Login as Admin" value="${esc(action?.name || '')}" />
      </div>
      ${state.projects.length > 0 && !state.currentProjectId ? `
      <div class="form-group">
        <label>Project</label>
        <select class="form-control" id="abProject"><option value="">— No project —</option>${projectOpts}</select>
      </div>` : ''}
    </div>
    <div class="form-group">
      <label>Description</label>
      <input class="form-control" id="abDesc" type="text" placeholder="What does this action do?" value="${esc(action?.description || '')}" />
    </div>
    <div class="divider"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-size:13px;font-weight:600;color:var(--muted)">Steps</div>
    </div>
    <div class="step-list" id="actionBuilderStepList"></div>
    <button class="btn btn-secondary" onclick="openAddActionStepPicker()">+ Add Step</button>
  `;

  openModal(
    action ? 'Edit Action' : 'New Action',
    html,
    'modal-xl',
    async () => {
      const name = document.getElementById('abName').value.trim();
      if (!name) { toast('Action name is required', 'error'); return false; }
      if (actionBuilderSteps.length === 0) { toast('Add at least one step', 'error'); return false; }
      const data = {
        name,
        description: document.getElementById('abDesc').value.trim(),
        projectId: document.getElementById('abProject')?.value || state.currentProjectId || null,
        steps: actionBuilderSteps
      };
      try {
        if (action) {
          const updated = await PUT(`/api/actions/${action.id}`, data);
          state.actions = state.actions.map(a => a.id === action.id ? updated : a);
          toast('Action saved', 'success');
        } else {
          const created = await POST('/api/actions', data);
          state.actions.push(created);
          toast('Action created', 'success');
        }
        if (state.currentPage === 'actions') navigate('actions');
      } catch (e) { toast('Error: ' + e.message, 'error'); return false; }
    },
    action ? 'Save Changes' : 'Create Action'
  );

  renderActionBuilderSteps();
}

function renderActionBuilderSteps() {
  const list = document.getElementById('actionBuilderStepList');
  if (!list) return;
  if (actionBuilderSteps.length === 0) {
    list.innerHTML = `<div style="padding:20px;text-align:center;color:var(--muted);border:2px dashed var(--border);border-radius:var(--radius)">No steps yet. Add a step below.</div>`;
    return;
  }
  list.innerHTML = actionBuilderSteps.map((step, i) => actionStepItemHTML(step, i)).join('');
}

function actionStepItemHTML(step, i) {
  const desc = stepDescription(step);
  return `<div class="step-item" id="ab-step-item-${i}" draggable="true"
    ondragstart="stepDragStart(event,${i},'action')"
    ondragover="stepDragOver(event,${i},'action')"
    ondrop="stepDrop(event,${i},'action')"
    ondragend="stepDragEnd(event,'action')"
    style="cursor:grab">
    <div class="step-header" onclick="toggleActionStepExpand(${i})">
      <span style="color:var(--muted);font-size:14px;padding:0 4px;cursor:grab;flex-shrink:0" data-tooltip="Drag to reorder">⠿</span>
      <span class="step-num">${i + 1}</span>
      <span class="step-type-badge step-type-${step.type}">${step.type}</span>
      <span class="step-desc">${esc(desc)}</span>
      <div class="step-actions" onclick="event.stopPropagation()">
        <button class="btn btn-xs btn-ghost" onclick="openAddActionStepPicker(${i + 1})" data-tooltip="Add step below">+</button>
        <button class="btn btn-xs btn-ghost" onclick="duplicateActionStep(${i})" data-tooltip="Duplicate step">⧉</button>
        <button class="btn btn-xs btn-ghost" style="color:var(--error)" onclick="deleteActionStep(${i})" data-tooltip="Delete">✕</button>
      </div>
    </div>
    <div class="step-body hidden" id="ab-step-body-${i}">
      ${actionStepParamsForm(step, i)}
    </div>
  </div>`;
}

function toggleActionStepExpand(i) {
  const body = document.getElementById(`ab-step-body-${i}`);
  if (body) body.classList.toggle('hidden');
}

function moveActionStep(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= actionBuilderSteps.length) return;
  [actionBuilderSteps[i], actionBuilderSteps[j]] = [actionBuilderSteps[j], actionBuilderSteps[i]];
  renderActionBuilderSteps();
}

function deleteActionStep(i) {
  actionBuilderSteps.splice(i, 1);
  renderActionBuilderSteps();
}

function duplicateActionStep(i) {
  const copy = JSON.parse(JSON.stringify(actionBuilderSteps[i]));
  copy.id = 'step_' + Date.now();
  actionBuilderSteps.splice(i + 1, 0, copy);
  renderActionBuilderSteps();
}

function updateActionStepParam(index, key, value) {
  if (!actionBuilderSteps[index]) return;
  actionBuilderSteps[index].params = actionBuilderSteps[index].params || {};
  actionBuilderSteps[index].params[key] = value;
  const descEl = document.querySelector(`#ab-step-item-${index} .step-desc`);
  if (descEl) descEl.textContent = stepDescription(actionBuilderSteps[index]);
}

function actionStepParamsForm(step, i) {
  const p = step.params || {};
  const selectorField = (label = 'Selector') => `
    <div class="form-row">
      <div class="form-group">
        <label>${label}</label>
        <input class="form-control" type="text" value="${esc(p.selector || '')}" onchange="updateActionStepParam(${i},'selector',this.value)" placeholder="Enter selector" />
      </div>
      <div class="form-group">
        <label>Selector Type</label>
        <select class="form-control" onchange="updateActionStepParam(${i},'selectorType',this.value)">
          <option value="css" ${(p.selectorType || 'css') === 'css' ? 'selected' : ''}>CSS Selector</option>
          <option value="text" ${p.selectorType === 'text' ? 'selected' : ''}>Visible Text</option>
          <option value="id" ${p.selectorType === 'id' ? 'selected' : ''}>Element ID</option>
          ${step.type === 'assertText' ? `<option value="page" ${p.selectorType === 'page' ? 'selected' : ''}>Whole Page</option>` : ''}
        </select>
      </div>
    </div>`;

  switch (step.type) {
    case 'navigate':
      return `<div class="form-group"><label>URL</label><input class="form-control" type="url" value="${esc(p.url || '')}" onchange="updateActionStepParam(${i},'url',this.value)" placeholder="https://example.com" /></div>`;
    case 'click':
      return selectorField() + `<div class="form-group"><label style="display:flex;align-items:center;gap:8px;font-weight:normal;cursor:pointer"><input type="checkbox" ${p.force ? 'checked' : ''} onchange="updateActionStepParam(${i},'force',this.checked)" /> Force click (bypasses visibility check — use for hidden/styled checkboxes)</label></div>`;
    case 'assertVisible':
    case 'hover':
    case 'checkElement':
      return selectorField() + (step.type === 'assertVisible' ? `<div class="form-group"><label class="form-label">Match index <span style="color:var(--muted);font-weight:400">(if multiple elements match, 0 = first)</span></label><input class="form-control" type="number" min="0" placeholder="0" value="${p.nth !== undefined && p.nth !== '' ? p.nth : ''}" onchange="updateActionStepParam(${i},'nth',this.value===''?undefined:parseInt(this.value))" style="width:80px" /></div>` : '');
    case 'type':
      return selectorField() + `<div class="form-group"><label>Text to Type</label><input class="form-control" type="text" value="${esc(p.value || '')}" onchange="updateActionStepParam(${i},'value',this.value)" placeholder="Text to enter" /></div>`;
    case 'assertText':
      return selectorField() + `
        <div class="form-group"><label>Expected Text</label><input class="form-control" type="text" value="${esc(p.text || '')}" onchange="updateActionStepParam(${i},'text',this.value)" placeholder="Expected text" /></div>
        <div class="form-group">
          <label>Match Type</label>
          <select class="form-control" onchange="updateActionStepParam(${i},'contains',this.value==='true')">
            <option value="true" ${p.contains !== false ? 'selected' : ''}>Contains</option>
            <option value="false" ${p.contains === false ? 'selected' : ''}>Exact match</option>
          </select>
        </div>
        ${p.selectorType !== 'page' ? `<div class="form-group"><label class="form-label">Match index <span style="color:var(--muted);font-weight:400">(if multiple elements match, 0 = first)</span></label><input class="form-control" type="number" min="0" placeholder="0" value="${p.nth !== undefined && p.nth !== '' ? p.nth : ''}" onchange="updateActionStepParam(${i},'nth',this.value===''?undefined:parseInt(this.value))" style="width:80px" /></div>` : ''}`;
    case 'waitForElement':
      return selectorField() + `<div class="form-group"><label>Timeout (ms)</label><input class="form-control" type="number" value="${p.timeout || 5000}" onchange="updateActionStepParam(${i},'timeout',parseInt(this.value))" /></div>`;
    case 'screenshot':
      return `<div class="form-group"><label>Screenshot Label</label><input class="form-control" type="text" value="${esc(p.name || '')}" onchange="updateActionStepParam(${i},'name',this.value)" placeholder="e.g. after-login" /></div>`;
    case 'selectOption':
      return selectorField() + `<div class="form-group"><label>Option Value</label><input class="form-control" type="text" value="${esc(p.value || '')}" onchange="updateActionStepParam(${i},'value',this.value)" /></div>`;
    case 'pressKey':
      return `<div class="form-group"><label>Key</label>
        <select class="form-control" onchange="updateActionStepParam(${i},'key',this.value)">
          ${['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Home','End'].map(k => `<option value="${k}" ${p.key === k ? 'selected' : ''}>${k}</option>`).join('')}
        </select></div>`;
    case 'scroll':
      return `
        <div class="form-group"><label>Direction</label>
          <select class="form-control" onchange="updateActionStepParam(${i},'direction',this.value)">
            <option value="down" ${(p.direction || 'down') === 'down' ? 'selected' : ''}>Down</option>
            <option value="up" ${p.direction === 'up' ? 'selected' : ''}>Up</option>
            <option value="to-element" ${p.direction === 'to-element' ? 'selected' : ''}>To Element</option>
          </select></div>
        <div class="form-group"><label>Pixels</label><input class="form-control" type="number" value="${p.pixels || 300}" onchange="updateActionStepParam(${i},'pixels',parseInt(this.value))" /></div>`;
    case 'scrollElement':
      return selectorField('Container Selector') + `
        <div class="form-group"><label>Direction</label>
          <select class="form-control" onchange="updateActionStepParam(${i},'direction',this.value)">
            <option value="down" ${(p.direction || 'down') === 'down' ? 'selected' : ''}>Down</option>
            <option value="up" ${p.direction === 'up' ? 'selected' : ''}>Up</option>
          </select></div>
        <div class="form-group"><label>Pixels</label><input class="form-control" type="number" value="${p.pixels || 300}" onchange="updateActionStepParam(${i},'pixels',parseInt(this.value))" /><div class="form-hint">Scrolls inside the element, not the whole page.</div></div>`;
    case 'assertURL':
      return `
        <div class="form-group"><label>URL</label><input class="form-control" type="text" value="${esc(p.url || '')}" onchange="updateActionStepParam(${i},'url',this.value)" placeholder="https://example.com/page" /></div>
        <div class="form-group"><label>Match Type</label>
          <select class="form-control" onchange="updateActionStepParam(${i},'matchType',this.value)">
            <option value="exact" ${(p.matchType||'exact')==='exact'?'selected':''}>Exact</option>
            <option value="contains" ${p.matchType==='contains'?'selected':''}>Contains</option>
            <option value="regex" ${p.matchType==='regex'?'selected':''}>Regex</option>
          </select></div>`;
    case 'assertNotVisible':
    case 'clearField':
    case 'scrollToElement':
    case 'switchFrame':
      return selectorField();
    case 'assertAttribute':
      return selectorField() + `
        <div class="form-row">
          <div class="form-group"><label>Attribute</label><input class="form-control" type="text" value="${esc(p.attribute||'href')}" onchange="updateActionStepParam(${i},'attribute',this.value)" /></div>
          <div class="form-group"><label>Match Type</label>
            <select class="form-control" onchange="updateActionStepParam(${i},'matchType',this.value)">
              <option value="exact" ${(p.matchType||'exact')==='exact'?'selected':''}>Exact</option>
              <option value="contains" ${p.matchType==='contains'?'selected':''}>Contains</option>
            </select></div>
        </div>
        <div class="form-group"><label>Expected Value</label><input class="form-control" type="text" value="${esc(p.value||'')}" onchange="updateActionStepParam(${i},'value',this.value)" /></div>`;
    case 'assertCSS':
      return selectorField() + `
        <div class="form-row">
          <div class="form-group"><label>CSS Property</label><input class="form-control" type="text" value="${esc(p.property||'color')}" onchange="updateActionStepParam(${i},'property',this.value)" /></div>
          <div class="form-group"><label>Match Type</label>
            <select class="form-control" onchange="updateActionStepParam(${i},'matchType',this.value)">
              <option value="exact" ${(p.matchType||'exact')==='exact'?'selected':''}>Exact</option>
              <option value="contains" ${p.matchType==='contains'?'selected':''}>Contains</option>
            </select></div>
        </div>
        <div class="form-group"><label>Expected Value</label><input class="form-control" type="text" value="${esc(p.value||'')}" onchange="updateActionStepParam(${i},'value',this.value)" /></div>`;
    case 'waitForNetwork':
      return `<div class="form-group"><label>Timeout (ms)</label><input class="form-control" type="number" value="${p.timeout||5000}" onchange="updateActionStepParam(${i},'timeout',parseInt(this.value))" /></div>`;
    case 'waitSeconds':
      return `<div class="form-group"><label>Seconds</label><input class="form-control" type="number" min="1" max="60" step="1" value="${p.seconds||3}" onchange="updateActionStepParam(${i},'seconds',parseInt(this.value)||1)" /></div>`;
    case 'runJS':
      return `<div class="form-group"><label>JavaScript</label><textarea class="form-control" rows="4" style="font-family:monospace;font-size:13px" onchange="updateActionStepParam(${i},'script',this.value)" placeholder="document.querySelector('#edit-age-18').click();">${esc(p.script || '')}</textarea><div class="form-hint">Runs in the browser. Use document.querySelector() to target elements.</div></div>`;
    case 'visualBaseline':
      return `
        <div class="form-group"><label>Baseline Name</label><input class="form-control" type="text" value="${esc(p.name||'')}" onchange="updateActionStepParam(${i},'name',this.value)" /></div>
        <div class="form-group"><label>Threshold</label><input class="form-control" type="number" step="0.01" min="0" max="1" value="${p.threshold!==undefined?p.threshold:0.1}" onchange="updateActionStepParam(${i},'threshold',parseFloat(this.value))" /></div>`;
    case 'newTab':
      return selectorField('Click Target Selector') + `
        <div class="form-group"><label>Assert New Tab URL (exact, optional)</label><input class="form-control" type="text" value="${esc(p.assertURL||'')}" onchange="updateActionStepParam(${i},'assertURL',this.value)" /></div>
        <div class="form-group"><label>Assert New Tab URL Contains (optional)</label><input class="form-control" type="text" value="${esc(p.assertURLContains||'')}" onchange="updateActionStepParam(${i},'assertURLContains',this.value)" /></div>
        <div class="form-group"><label>Assert New Tab Contains Text (optional)</label><input class="form-control" type="text" value="${esc(p.assertText||'')}" onchange="updateActionStepParam(${i},'assertText',this.value)" /></div>
        <div class="form-group"><label>Assert New Tab PDF Contains (optional)</label><input class="form-control" type="text" value="${esc(p.assertPDFText||'')}" onchange="updateActionStepParam(${i},'assertPDFText',this.value)" /></div>
        <div class="form-group"><label style="display:flex;align-items:center;gap:8px;font-weight:normal;cursor:pointer"><input type="checkbox" ${p.switchToTab ? 'checked' : ''} onchange="updateActionStepParam(${i},'switchToTab',this.checked)" /> Switch to new tab (subsequent steps run in the new tab)</label></div>`;
    case 'fileDownload':
      return selectorField('Download Link Selector') + `
        <div class="form-group"><label>Expected Filename (optional)</label><input class="form-control" type="text" value="${esc(p.expectedFilename||'')}" onchange="updateActionStepParam(${i},'expectedFilename',this.value)" /></div>`;
    case 'assertPDFContains':
      return selectorField('Download Button/Link Selector') + `
        <div class="form-group">
          <label>Expected Text in PDF *</label>
          <input class="form-control" type="text" value="${esc(p.expectedText||'')}" onchange="updateActionStepParam(${i},'expectedText',this.value)" placeholder="e.g. Total Score: 42" />
          <div class="form-hint">Clicks the selector to trigger the PDF download, then checks that the PDF's text contains this value.</div>
        </div>`;
    case 'assertInViewport':
      return selectorField() + `
        <div class="form-group">
          <div class="form-hint">Checks that the element is currently visible within the browser window — i.e. the page has scrolled to it. Use this after clicking a jump link to confirm the target section is in view.</div>
        </div>`;

    case 'assertNoNavigation':
      return `
        <div class="form-group">
          <label>Wait Duration (ms)</label>
          <input class="form-control" type="number" value="${p.waitMs||1000}" onchange="updateActionStepParam(${i},'waitMs',parseInt(this.value)||1000)" min="200" max="10000" />
          <div class="form-hint">After the previous step, waits this long and confirms the page did not reload or navigate. Use after clicking a tab or anchor link.</div>
        </div>`;
    case 'assertElementSize':
      return `
        <div class="form-group"><label>Element Selector (CSS)</label><input class="form-control" type="text" value="${esc(p.selector||'')}" onchange="updateActionStepParam(${i},'selector',this.value)" placeholder="e.g. aside.fixed" /></div>
        <div class="form-group"><label>Dimension</label>
          <select class="form-control" onchange="updateActionStepParam(${i},'dimension',this.value)">
            <option value="height" ${(p.dimension||'height')==='height'?'selected':''}>Height</option>
            <option value="width" ${p.dimension==='width'?'selected':''}>Width</option>
          </select>
        </div>
        <div class="form-group"><label>Expected (% of viewport)</label>
          <input class="form-control" type="number" min="0" max="100" step="0.1" value="${p.expected??''}" onchange="updateActionStepParam(${i},'expected',parseFloat(this.value))" placeholder="e.g. 15.5" />
          <div class="form-hint">Run the test once to see the actual value in the step result, then set this to the correct number.</div>
        </div>
        <div class="form-group"><label>Tolerance (±%)</label>
          <input class="form-control" type="number" min="0" max="20" step="0.5" value="${p.tolerance??2}" onchange="updateActionStepParam(${i},'tolerance',parseFloat(this.value))" />
        </div>`;
    case 'exitFrame':
      return `<div class="text-muted text-sm">No parameters needed — exits the current iframe context.</div>`;
    case 'closeTab':
      return `<div class="text-muted text-sm">Closes the current tab and returns subsequent steps to the previous tab.</div>`;
    case 'switchToNewTab':
      return `<div class="form-group"><label>Assert URL Contains (optional)</label><input class="form-control" type="text" value="${esc(p.assertURLContains || '')}" onchange="updateActionStepParam(${i},'assertURLContains',this.value)" placeholder="e.g. tryngolza.com" /></div>`;
    default:
      return `<div class="text-muted text-sm">No parameters for this step type.</div>`;
  }
}

function openAddActionStepPicker(insertAt) {
  const idx = insertAt != null ? insertAt : null;
  // Same step types as scenario builder but without useAction (no nesting)
  const pickableTypes = STEP_TYPES.filter(st => st.type !== 'useAction');
  const html = `
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px">Choose the type of step to add:</p>
    <div class="step-type-picker">
      ${pickableTypes.map(st => `
      <div class="step-type-option" onclick="addActionStep('${st.type}',${idx != null ? idx : 'null'})">
        <div class="sto-label">${st.label}</div>
        <div class="sto-desc">${st.desc}</div>
      </div>`).join('')}
    </div>`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'actionStepPickerOverlay';
  overlay.style.zIndex = '1100';
  overlay.innerHTML = `<div class="modal modal-md">
    <div class="modal-header">
      <h2>Add Step</h2>
      <button class="modal-close" onclick="document.getElementById('actionStepPickerOverlay').remove()">✕</button>
    </div>
    <div class="modal-body">${html}</div>
  </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function addActionStep(type, insertAt) {
  const overlay = document.getElementById('actionStepPickerOverlay');
  if (overlay) overlay.remove();

  const defaults = {
    navigate:         { url: '' },
    click:            { selector: '', selectorType: 'text' },
    type:             { selector: '', selectorType: 'id', value: '' },
    clearField:       { selector: '', selectorType: 'css' },
    assertText:       { selector: '', selectorType: 'page', text: '', contains: true },
    assertVisible:    { selector: '', selectorType: 'css' },
    assertNotVisible: { selector: '', selectorType: 'css' },
    assertURL:        { url: '', matchType: 'contains' },
    assertAttribute:  { selector: '', selectorType: 'css', attribute: 'href', value: '', matchType: 'exact' },
    assertCSS:        { selector: '', selectorType: 'css', property: 'color', value: '', matchType: 'exact' },
    waitForElement:   { selector: '', selectorType: 'css', timeout: 5000 },
    waitForNetwork:   { timeout: 5000 },
    screenshot:       { name: '' },
    visualBaseline:   { name: '', threshold: 0.1 },
    hover:            { selector: '', selectorType: 'css' },
    selectOption:     { selector: '', selectorType: 'css', value: '' },
    checkElement:     { selector: '', selectorType: 'css' },
    pressKey:         { key: 'Enter' },
    runJS:            { script: '' },
    closeTab:         {},
    switchToNewTab:   { assertURLContains: '' },
    scroll:           { direction: 'down', pixels: 300 },
    scrollToElement:  { selector: '', selectorType: 'css' },
    scrollElement:    { selector: '', selectorType: 'css', direction: 'down', pixels: 300 },
    newTab:           { selector: '', selectorType: 'text', assertURL: '', assertURLContains: '', assertText: '' },
    fileDownload:     { selector: '', selectorType: 'text', expectedFilename: '' },
    switchFrame:        { selector: '', selectorType: 'css' },
    exitFrame:          {},
    waitSeconds:        { seconds: 3 },
    assertElementSize:  { selector: '', dimension: 'height', expected: null, tolerance: 2 }
  };

  const newStep = { id: 'step_' + Date.now(), type, params: defaults[type] || {} };
  if (insertAt != null && insertAt >= 0 && insertAt <= actionBuilderSteps.length) {
    actionBuilderSteps.splice(insertAt, 0, newStep);
  } else {
    actionBuilderSteps.push(newStep);
  }

  renderActionBuilderSteps();

  setTimeout(() => {
    const idx = insertAt != null ? insertAt : actionBuilderSteps.length - 1;
    const body = document.getElementById(`ab-step-body-${idx}`);
    if (body) body.classList.remove('hidden');
    const item = document.getElementById(`ab-step-item-${idx}`);
    if (item) item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 50);
}

// ─── SCHEDULES PAGE ───────────────────────────────────────────────────────────

async function renderSchedulesPage() {
  await loadSchedules();
  await loadScenarios();
  await loadSuites();
  const main = document.getElementById('mainContent');

  if (state.schedules.length === 0) {
    main.innerHTML = `
      <div class="page-header">
        <h1>Schedules</h1>
        <button class="btn btn-primary" onclick="openScheduleModal(null)">+ New Schedule</button>
      </div>
      <div class="empty-state">
        <div class="es-icon">⏰</div>
        <h3>No schedules yet</h3>
        <p>Set up automatic runs to keep your test results fresh.</p>
        <button class="btn btn-primary" onclick="openScheduleModal(null)">Create First Schedule</button>
      </div>`;
    return;
  }

  main.innerHTML = `
    <div class="page-header">
      <div><h1>Schedules</h1><div class="subtitle">${state.schedules.length} schedule${state.schedules.length !== 1 ? 's' : ''}</div></div>
      <button class="btn btn-primary" onclick="openScheduleModal(null)">+ New Schedule</button>
    </div>
    <div class="schedule-grid">
      ${state.schedules.map(s => scheduleCardHTML(s)).join('')}
    </div>`;
}

function scheduleCardHTML(s) {
  const enabledClass = s.enabled ? 'enabled' : 'disabled';
  const enabledLabel = s.enabled ? '● Enabled' : '○ Disabled';

  const typeLabel = s.targetType === 'suite' ? 'Suite' : 'Scenario';
  const browserLabel = s.browser === 'firefox' ? '🦊 Firefox' : s.browser === 'webkit' ? '🧭 Safari' : '🌐 Chrome';
  const devLabel = DEVICES[s.device]?.label || s.device || 'Desktop';

  let lastRunHTML = '<span>No runs yet</span>';
  if (s.lastRunAt) {
    const statusIcon = s.lastRunStatus === 'passed' ? '✅' : s.lastRunStatus === 'failed' ? '❌' : '⚠️';
    lastRunHTML = `<span>${statusIcon} ${capitalize(s.lastRunStatus || 'unknown')} · ${timeAgo(s.lastRunAt)}</span>`;
  }

  const freqLabel = scheduleFreqLabel(s);

  return `<div class="schedule-card">
    <div class="schedule-card-header">
      <div class="schedule-name">⏰ ${esc(s.name)}</div>
      <button class="toggle-badge ${enabledClass}" onclick="toggleSchedule('${s.id}')" data-tooltip="Click to toggle">${enabledLabel}</button>
    </div>
    <div style="font-size:13px;color:var(--muted);margin-bottom:8px">${typeLabel}: <strong style="color:var(--text)">${esc(s.targetName || s.targetId)}</strong></div>
    <div class="schedule-meta">
      <span>${browserLabel}</span>
      <span>|</span>
      <span>🖥️ ${esc(devLabel)}</span>
      <span>|</span>
      <span>🕐 ${esc(freqLabel)}</span>
    </div>
    <div class="schedule-last-run">Last run: ${lastRunHTML}</div>
    <div class="schedule-card-footer">
      <button class="btn btn-sm btn-secondary" onclick="scheduleRunNow('${s.id}')">▶ Run Now</button>
      <button class="btn btn-sm btn-secondary" onclick="openScheduleModal('${s.id}')">✏ Edit</button>
      <button class="btn btn-sm btn-danger" onclick="deleteSchedule('${s.id}')">Delete</button>
    </div>
  </div>`;
}

function scheduleFreqLabel(s) {
  const h = parseInt(s.hour) || 0;
  const ampm = h < 12 ? 'AM' : 'PM';
  const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  switch (s.frequency) {
    case 'hourly':   return 'Every hour';
    case 'every6h':  return 'Every 6 hours';
    case 'every12h': return 'Every 12 hours';
    case 'daily':    return `Daily at ${displayH}:00 ${ampm}`;
    case 'weekly':   return `Weekly on ${days[parseInt(s.dayOfWeek) || 0]} at ${displayH}:00 ${ampm}`;
    case 'custom':   return `Custom: ${s.cronExpression}`;
    default:         return s.cronExpression || '';
  }
}

async function toggleSchedule(id) {
  try {
    const updated = await PATCH(`/api/schedules/${id}/toggle`, {});
    state.schedules = state.schedules.map(s => s.id === id ? updated : s);
    toast(updated.enabled ? 'Schedule enabled' : 'Schedule disabled', 'success');
    navigate('schedules');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function scheduleRunNow(id) {
  try {
    await POST(`/api/schedules/${id}/run-now`, {});
    toast('Run started — check Reports for results', 'success');
    // Refresh card after 2 seconds to show updated lastRunAt
    setTimeout(async () => {
      await loadSchedules();
      const main = document.getElementById('mainContent');
      if (state.currentPage === 'schedules' && main) {
        const grid = main.querySelector('.schedule-grid');
        if (grid) {
          grid.innerHTML = state.schedules.map(s => scheduleCardHTML(s)).join('');
        }
      }
    }, 2000);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function deleteSchedule(id) {
  if (!confirm('Delete this schedule? This cannot be undone.')) return;
  try {
    await DEL(`/api/schedules/${id}`);
    state.schedules = state.schedules.filter(s => s.id !== id);
    toast('Schedule deleted', 'success');
    navigate('schedules');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── SCHEDULE MODAL ───────────────────────────────────────────────────────────

async function openScheduleModal(scheduleId) {
  let schedule = null;
  if (scheduleId) {
    try { schedule = await GET(`/api/schedules/${scheduleId}`); }
    catch { toast('Could not load schedule', 'error'); return; }
  }
  await loadScenarios();
  await loadSuites();

  const title = schedule ? 'Edit Schedule' : 'New Schedule';

  // Pre-populate values
  const selFreq      = schedule?.frequency || 'daily';
  const selHour      = schedule?.hour !== undefined ? schedule.hour : 2;
  const selDow       = schedule?.dayOfWeek !== undefined ? schedule.dayOfWeek : 1;
  const selTargetType= schedule?.targetType || 'scenario';
  const selBrowser   = schedule?.browser || 'chromium';
  const selDevice    = schedule?.device || 'desktop-1920';
  const selEnabled   = schedule ? schedule.enabled : true;
  const selCronExpr  = schedule?.cronExpression || '';
  const selTargetId  = schedule?.targetId || '';

  const projectOpts = state.projects.map(p =>
    `<option value="${p.id}" ${(schedule?.projectId || state.currentProjectId) === p.id ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');

  const hourOpts = Array.from({length: 24}, (_, h) => {
    const ampm = h < 12 ? 'AM' : 'PM';
    const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `<option value="${h}" ${h === selHour ? 'selected' : ''}>${displayH}:00 ${ampm}</option>`;
  }).join('');

  const dowOpts = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d, i) =>
    `<option value="${i}" ${i === selDow ? 'selected' : ''}>${d}</option>`
  ).join('');

  const FREQS = [
    { id: 'hourly',   label: 'Hourly' },
    { id: 'every6h',  label: 'Every 6 Hours' },
    { id: 'every12h', label: 'Every 12 Hours' },
    { id: 'daily',    label: 'Daily' },
    { id: 'weekly',   label: 'Weekly' },
    { id: 'custom',   label: 'Custom' }
  ];

  const html = `
    <div class="form-group">
      <label>Schedule Name *</label>
      <input class="form-control" id="scName" type="text" placeholder="e.g. Nightly Regression" value="${esc(schedule?.name || '')}" />
    </div>

    ${state.projects.length > 0 && !state.currentProjectId ? `
    <div class="form-group">
      <label>Project</label>
      <select class="form-control" id="scProject" onchange="refreshScheduleTargets()">
        <option value="">— No project —</option>${projectOpts}
      </select>
    </div>` : ''}

    <div class="form-group">
      <label>Run Target</label>
      <div class="radio-group" style="flex-direction:row;gap:16px;margin-bottom:10px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:400">
          <input type="radio" name="scTargetType" value="scenario" ${selTargetType === 'scenario' ? 'checked' : ''} onchange="refreshScheduleTargets()" /> Scenario
        </label>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:400">
          <input type="radio" name="scTargetType" value="suite" ${selTargetType === 'suite' ? 'checked' : ''} onchange="refreshScheduleTargets()" /> Suite
        </label>
      </div>
      <select class="form-control" id="scTargetId">
        ${buildScheduleTargetOptions(selTargetType, selTargetId)}
      </select>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label>Browser</label>
        <div class="radio-group">
          <div class="radio-option">
            <input type="radio" name="scBrowser" id="scb-chromium" value="chromium" ${selBrowser === 'chromium' ? 'checked' : ''} />
            <label for="scb-chromium"><span class="ri-icon">🌐</span> Chrome</label>
          </div>
          <div class="radio-option">
            <input type="radio" name="scBrowser" id="scb-firefox" value="firefox" ${selBrowser === 'firefox' ? 'checked' : ''} />
            <label for="scb-firefox"><span class="ri-icon">🦊</span> Firefox</label>
          </div>
          <div class="radio-option">
            <input type="radio" name="scBrowser" id="scb-webkit" value="webkit" ${selBrowser === 'webkit' ? 'checked' : ''} />
            <label for="scb-webkit"><span class="ri-icon">🧭</span> Safari</label>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>Device / Viewport</label>
        <select class="form-control" id="scDevice">
          ${Object.entries(DEVICES).filter(([k]) => k !== 'custom').map(([k, v]) =>
            `<option value="${k}" ${k === selDevice ? 'selected' : ''}>${v.label}</option>`
          ).join('')}
        </select>
      </div>
    </div>

    <div class="form-group">
      <label>Frequency</label>
      <div class="freq-options" id="freqOptions">
        ${FREQS.map(f => `<div class="freq-card ${f.id === selFreq ? 'selected' : ''}" onclick="selectFreq('${f.id}')">${f.label}</div>`).join('')}
      </div>
      <input type="hidden" id="scFrequency" value="${selFreq}" />

      <div class="freq-sub-options" id="freqSubDaily" style="display:${selFreq === 'daily' ? '' : 'none'}">
        <label style="font-size:13px;color:var(--muted)">Run at:</label>
        <select class="form-control" id="scHour" style="max-width:160px;margin-top:4px">${hourOpts}</select>
      </div>
      <div class="freq-sub-options" id="freqSubWeekly" style="display:${selFreq === 'weekly' ? '' : 'none'}">
        <div class="form-row" style="gap:12px">
          <div class="form-group">
            <label>Day</label>
            <select class="form-control" id="scDow">${dowOpts}</select>
          </div>
          <div class="form-group">
            <label>At</label>
            <select class="form-control" id="scHourWeekly">${Array.from({length: 24}, (_, h) => {
              const ampm = h < 12 ? 'AM' : 'PM';
              const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
              return `<option value="${h}" ${h === selHour ? 'selected' : ''}>${displayH}:00 ${ampm}</option>`;
            }).join('')}</select>
          </div>
        </div>
      </div>
      <div class="freq-sub-options" id="freqSubCustom" style="display:${selFreq === 'custom' ? '' : 'none'}">
        <label style="font-size:13px;color:var(--muted)">Cron expression (e.g. <code>0 2 * * *</code> = daily at 2 AM):</label>
        <input class="form-control" id="scCronExpr" type="text" style="margin-top:4px;font-family:monospace"
          placeholder="0 2 * * *" value="${esc(selFreq === 'custom' ? selCronExpr : '')}" />
      </div>
    </div>

    <div class="form-group">
      <label>Timezone</label>
      <select class="form-control" id="scTimezone" style="max-width:260px">
        ${['UTC','America/New_York','America/Chicago','America/Denver','America/Los_Angeles',
           'Europe/London','Europe/Paris','Europe/Berlin','Asia/Tokyo','Asia/Shanghai',
           'Australia/Sydney'].map(tz =>
          `<option value="${tz}" ${(schedule?.timezone || 'UTC') === tz ? 'selected' : ''}>${tz}</option>`
        ).join('')}
      </select>
    </div>

    <div class="form-group">
      <label>Notify Emails on Completion <span style="color:var(--muted);font-weight:400">(optional)</span></label>
      <input class="form-control" id="scNotifyEmails" type="text" placeholder="alice@example.com, bob@example.com"
        value="${esc(schedule?.notifyEmails || '')}" />
      <div class="form-hint">Comma-separated. A report email is sent automatically after each scheduled run.</div>
    </div>

    <div class="form-group">
      <label style="display:flex;align-items:center;gap:10px">
        <label class="toggle-switch">
          <input type="checkbox" id="scEnabled" ${selEnabled ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
        <span>Enabled</span>
      </label>
    </div>
  `;

  openModal(title, html, 'modal-lg', async () => {
    const name = document.getElementById('scName').value.trim();
    if (!name) { toast('Schedule name is required', 'error'); return false; }

    const targetType = document.querySelector('input[name=scTargetType]:checked')?.value || 'scenario';
    const targetId   = document.getElementById('scTargetId').value;
    if (!targetId) { toast('Please select a target scenario or suite', 'error'); return false; }

    const frequency = document.getElementById('scFrequency').value;
    let hour = 0, dayOfWeek = 0, cronExpression = '';

    if (frequency === 'daily') {
      hour = parseInt(document.getElementById('scHour').value) || 0;
    } else if (frequency === 'weekly') {
      hour = parseInt(document.getElementById('scHourWeekly').value) || 0;
      dayOfWeek = parseInt(document.getElementById('scDow').value) || 0;
    } else if (frequency === 'custom') {
      cronExpression = document.getElementById('scCronExpr').value.trim();
      if (!cronExpression) { toast('Please enter a cron expression', 'error'); return false; }
    }

    const browser      = document.querySelector('input[name=scBrowser]:checked')?.value || 'chromium';
    const device       = document.getElementById('scDevice').value;
    const timezone     = document.getElementById('scTimezone').value;
    const enabled      = document.getElementById('scEnabled').checked;
    const projectId    = document.getElementById('scProject')?.value || state.currentProjectId || null;
    const notifyEmails = document.getElementById('scNotifyEmails').value.trim();

    const body = { name, projectId, targetType, targetId, browser, device, frequency,
                   hour, dayOfWeek, cronExpression, timezone, enabled, notifyEmails };

    try {
      if (schedule) {
        const updated = await PUT(`/api/schedules/${schedule.id}`, body);
        state.schedules = state.schedules.map(s => s.id === schedule.id ? updated : s);
        toast('Schedule updated', 'success');
      } else {
        const created = await POST('/api/schedules', body);
        state.schedules.push(created);
        toast('Schedule created', 'success');
      }
      navigate('schedules');
    } catch (e) { toast('Error: ' + e.message, 'error'); return false; }
  }, schedule ? 'Save Changes' : 'Create Schedule');
}

function buildScheduleTargetOptions(targetType, selectedId) {
  const projectId = document.getElementById('scProject')?.value || state.currentProjectId;
  let items = [];
  if (targetType === 'suite') {
    items = state.suites.filter(s => !projectId || s.projectId === projectId);
  } else {
    items = state.scenarios.filter(s => !projectId || s.projectId === projectId);
  }
  if (items.length === 0) return `<option value="">— No ${targetType}s found —</option>`;
  return `<option value="">— Select a ${targetType} —</option>` +
    items.map(i => `<option value="${i.id}" ${i.id === selectedId ? 'selected' : ''}>${esc(i.name)}</option>`).join('');
}

function refreshScheduleTargets() {
  const targetType = document.querySelector('input[name=scTargetType]:checked')?.value || 'scenario';
  const sel = document.getElementById('scTargetId');
  if (sel) sel.innerHTML = buildScheduleTargetOptions(targetType, '');
}

function selectFreq(freq) {
  document.querySelectorAll('.freq-card').forEach(el => {
    el.classList.toggle('selected', el.textContent.trim().toLowerCase().replace(/\s+/g, '') === freq.replace(/\s+/g, '').toLowerCase() ||
      el.onclick?.toString().includes(`'${freq}'`));
  });
  // simpler: use data attribute approach via re-render
  document.getElementById('scFrequency').value = freq;
  // Show/hide sub-options
  document.getElementById('freqSubDaily').style.display  = freq === 'daily'  ? '' : 'none';
  document.getElementById('freqSubWeekly').style.display = freq === 'weekly' ? '' : 'none';
  document.getElementById('freqSubCustom').style.display = freq === 'custom' ? '' : 'none';
  // Update selected class
  document.querySelectorAll('.freq-card').forEach(el => {
    const elFreq = el.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
    el.classList.toggle('selected', elFreq === freq);
  });
}

// ─── RUN MODAL ────────────────────────────────────────────────────────────────

async function openRunModal(type, id) {
  const label = type === 'suite'
    ? (state.suites.find(s => s.id === id)?.name || 'Suite')
    : (state.scenarios.find(s => s.id === id)?.name || 'Scenario');

  await loadEnvironments();
  const projectId = type === 'suite'
    ? (state.suites.find(s => s.id === id)?.projectId || state.currentProjectId)
    : (state.scenarios.find(s => s.id === id)?.projectId || state.currentProjectId);
  const envs = state.environments.filter(e => e.projectId === projectId);

  const envOptions = envs.length > 0
    ? `<option value="">— None —</option>` + envs.map(e =>
        `<option value="${e.id}"${e.isDefault ? ' selected' : ''}>${esc(e.name)} (${esc(e.baseUrl)})</option>`
      ).join('')
    : `<option value="">— No environments configured —</option>`;

  const html = `
    <p style="font-size:14px;color:var(--muted);margin-bottom:18px">Configure how to run: <strong>${esc(label)}</strong></p>

    ${envs.length > 0 ? `
    <div class="form-group">
      <label>Environment</label>
      <select class="form-control" id="runEnvironment">${envOptions}</select>
      <div class="form-hint">Sets the {{baseUrl}} variable and configures the base URL.</div>
    </div>` : ''}

    <div class="form-group">
      <label>Browser</label>
      <div class="radio-group">
        <div class="radio-option">
          <input type="radio" name="runBrowser" id="rb-chromium" value="chromium" checked />
          <label for="rb-chromium"><span class="ri-icon">🌐</span> Chrome</label>
        </div>
        <div class="radio-option">
          <input type="radio" name="runBrowser" id="rb-firefox" value="firefox" />
          <label for="rb-firefox"><span class="ri-icon">🦊</span> Firefox</label>
        </div>
        <div class="radio-option">
          <input type="radio" name="runBrowser" id="rb-webkit" value="webkit" />
          <label for="rb-webkit"><span class="ri-icon">🧭</span> Safari</label>
        </div>
      </div>
    </div>

    <div class="form-group">
      <label>Device / Viewport</label>
      <select class="form-control" id="runDevice" onchange="handleDeviceChange()">
        ${Object.entries(DEVICES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
      </select>
    </div>

    <div class="form-row hidden" id="customViewportRow">
      <div class="form-group">
        <label>Width (px)</label>
        <input class="form-control" id="customW" type="number" value="1280" min="320" max="3840" />
      </div>
      <div class="form-group">
        <label>Height (px)</label>
        <input class="form-control" id="customH" type="number" value="720" min="320" max="2160" />
      </div>
    </div>

    ${type === 'suite' ? `
    <div class="form-group">
      <label>Notify Emails on Completion <span style="color:var(--muted);font-weight:400">(optional)</span></label>
      <input class="form-control" id="runNotifyEmails" type="text" placeholder="alice@example.com, bob@example.com" />
      <div class="form-hint">Comma-separated. A report email is sent automatically when the run finishes.</div>
    </div>` : ''}
  `;

  openModal('Configure Test Run', html, 'modal-sm', async () => {
    const browser = document.querySelector('input[name=runBrowser]:checked')?.value || 'chromium';
    const device = document.getElementById('runDevice').value;
    const environmentId = document.getElementById('runEnvironment')?.value || null;
    const body = { browser, device };
    if (environmentId) body.environmentId = environmentId;
    if (device === 'custom') {
      body.customViewport = {
        width: parseInt(document.getElementById('customW').value) || 1280,
        height: parseInt(document.getElementById('customH').value) || 720
      };
    }
    if (type === 'suite') {
      body.notifyEmails = document.getElementById('runNotifyEmails')?.value.trim() || '';
    }
    startRun(type, id, body);
  }, '▶ Run Test');
}

function handleDeviceChange() {
  const val = document.getElementById('runDevice').value;
  document.getElementById('customViewportRow').classList.toggle('hidden', val !== 'custom');
}

async function openDataDrivenModal(scenarioId) {
  const scenario = state.scenarios.find(s => s.id === scenarioId);
  if (!scenario) return;
  const vars = scenario.variables || [];

  const varChips = vars.map(v =>
    `<span class="variable-name-preview">{{${esc(v.name)}}}</span>`
  ).join(' ');

  const html = `
    <p style="font-size:14px;color:var(--muted);margin-bottom:12px">
      Run <strong>${esc(scenario.name)}</strong> once per CSV row, substituting variables.
    </p>
    <div style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:600;margin-bottom:6px">Variables in this scenario:</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${varChips || '<span style="color:#94a3b8;font-size:12px">None defined</span>'}</div>
    </div>
    <div class="form-group">
      <label>CSV Data</label>
      <div class="form-hint" style="margin-bottom:6px">First row = header (variable names). One row per test run.</div>
      <textarea class="form-control" id="csvTextarea" rows="8" placeholder="${vars.map(v => v.name).join(',') || 'varName1,varName2'}&#10;value1,value2&#10;value3,value4" style="font-family:monospace;font-size:12px"></textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Browser</label>
        <select class="form-control" id="ddBrowser">
          <option value="chromium">Chrome</option>
          <option value="firefox">Firefox</option>
          <option value="webkit">Safari</option>
        </select>
      </div>
      <div class="form-group">
        <label>Device</label>
        <select class="form-control" id="ddDevice">
          ${Object.entries(DEVICES).filter(([k]) => k !== 'custom').map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
        </select>
      </div>
    </div>
  `;

  openModal('Run with Data (CSV)', html, 'modal-md', async () => {
    const csvText = document.getElementById('csvTextarea').value.trim();
    if (!csvText) { toast('Paste CSV data first', 'error'); return false; }
    const browser = document.getElementById('ddBrowser').value;
    const device = document.getElementById('ddDevice').value;
    await startDataDrivenRun(scenarioId, csvText, browser, device);
  }, '⚡ Run All Rows');
}

async function startDataDrivenRun(scenarioId, csvText, browser, device) {
  closeModal();
  openRunConsole();
  // Update console title
  const titleEl = document.querySelector('#runConsoleModal .modal-header h2');
  if (titleEl) titleEl.textContent = '⚡ Data-Driven Run…';

  const controller = new AbortController();
  state.runningRun = { controller };

  try {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(`/api/scenarios/${scenarioId}/run-csv`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ csvText, browser, device }),
      signal: controller.signal
    });

    if (!response.ok) {
      let errMsg = `Server error (${response.status})`;
      try { const err = await response.json(); errMsg = err.error || errMsg; } catch {}
      toast('Data run failed: ' + errMsg, 'error');
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6));
            handleDataDrivenEvent(event);
          } catch {}
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      toast('Connection error during data-driven run', 'error');
    }
  } finally {
    state.runningRun = null;
    await loadRuns();
  }
}

function handleDataDrivenEvent(event) {
  const consoleEl = document.getElementById('runConsole');
  if (!consoleEl) return;
  const time = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function addLine(text, cls, icon) {
    const line = document.createElement('div');
    line.className = `run-log-line ${cls}`;
    line.innerHTML = `<span class="rl-time">${time}</span><span class="rl-icon">${icon}</span><span class="rl-text">${esc(text)}</span>`;
    consoleEl.appendChild(line);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  switch (event.type) {
    case 'ping': break;
    case 'csv_start':
      addLine(`Data-driven run: ${event.totalRows} rows`, 'info', '⚡');
      break;
    case 'row_start':
      addLine(`Row ${event.rowIndex + 1}: ${JSON.stringify(event.variables)}`, 'info', '▶');
      break;
    case 'step':
      if (event.status === 'passed') {
        addLine(`  ✓ ${event.description} (${event.duration}ms)`, 'passed', '');
      } else if (event.status === 'failed') {
        addLine(`  ✗ ${event.description}: ${event.message || 'failed'}`, 'failed', '');
      } else if (event.status === 'running') {
        addLine(`  … ${event.description}`, 'running', '');
      }
      break;
    case 'row_complete':
      addLine(`Row ${event.rowIndex + 1} ${event.status} (${(event.duration / 1000).toFixed(1)}s)`, event.status === 'passed' ? 'passed' : 'failed', event.status === 'passed' ? '✓' : '✗');
      break;
    case 'csv_done': {
      runConsoleRunId = event.runId;
      const passed = event.rows.filter(r => r.status === 'passed').length;
      const total = event.rows.length;
      const statusBadge = document.getElementById('runConsoleStatus');
      const allPassed = passed === total;
      if (statusBadge) { statusBadge.className = `badge badge-${allPassed ? 'passed' : 'failed'}`; statusBadge.textContent = allPassed ? 'passed' : 'failed'; }
      const titleEl2 = document.querySelector('#runConsoleModal .modal-header h2');
      if (titleEl2) titleEl2.textContent = allPassed ? '✅ All Rows Passed' : '❌ Some Rows Failed';
      addLine(`Complete: ${passed}/${total} rows passed`, allPassed ? 'passed' : 'failed', allPassed ? '🎉' : '💥');
      const footer = document.getElementById('runConsoleFooter');
      if (footer) {
        footer.innerHTML = `
          <button class="btn btn-secondary" onclick="document.getElementById('runConsoleModal')?.remove()">Close</button>
          ${runConsoleRunId ? `<button class="btn btn-primary" onclick="document.getElementById('runConsoleModal')?.remove();navigate('run-detail','${runConsoleRunId}')">View Full Report →</button>` : ''}
        `;
      }
      break;
    }
    case 'error':
      addLine(`Error: ${event.message}`, 'failed', '⚠');
      break;
  }
}

async function rerunFailed(runId) {
  let run;
  try { run = await GET(`/api/runs/${runId}`); } catch { toast('Could not load run', 'error'); return; }

  const failedIds = (run.scenarioResults || [])
    .filter(sr => sr.status !== 'passed')
    .map(sr => sr.scenarioId);

  if (failedIds.length === 0) { toast('No failed tests to re-run', 'info'); return; }

  await loadEnvironments();
  const projectId = run.projectId || state.currentProjectId;
  const envs = state.environments.filter(e => e.projectId === projectId);

  const envOptions = envs.length > 0
    ? `<option value="">— None —</option>` + envs.map(e =>
        `<option value="${e.id}"${e.id === run.environmentId ? ' selected' : ''}>${esc(e.name)} (${esc(e.baseUrl)})</option>`
      ).join('')
    : `<option value="">— No environments configured —</option>`;

  const html = `
    <p style="font-size:14px;color:var(--muted);margin-bottom:18px">Re-running <strong>${failedIds.length}</strong> failed test${failedIds.length !== 1 ? 's' : ''} from <strong>${esc(run.name)}</strong></p>

    ${envs.length > 0 ? `
    <div class="form-group">
      <label>Environment</label>
      <select class="form-control" id="runEnvironment">${envOptions}</select>
    </div>` : ''}

    <div class="form-group">
      <label>Browser</label>
      <div class="radio-group">
        <div class="radio-option">
          <input type="radio" name="runBrowser" id="rb-chromium" value="chromium" ${run.browser === 'chromium' ? 'checked' : ''} />
          <label for="rb-chromium"><span class="ri-icon">🌐</span> Chrome</label>
        </div>
        <div class="radio-option">
          <input type="radio" name="runBrowser" id="rb-firefox" value="firefox" ${run.browser === 'firefox' ? 'checked' : ''} />
          <label for="rb-firefox"><span class="ri-icon">🦊</span> Firefox</label>
        </div>
        <div class="radio-option">
          <input type="radio" name="runBrowser" id="rb-webkit" value="webkit" ${run.browser === 'webkit' ? 'checked' : ''} />
          <label for="rb-webkit"><span class="ri-icon">🧭</span> Safari</label>
        </div>
      </div>
    </div>

    <div class="form-group">
      <label>Device / Viewport</label>
      <select class="form-control" id="runDevice" onchange="handleDeviceChange()">
        ${Object.entries(DEVICES).map(([k, v]) => `<option value="${k}" ${k === run.device ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select>
    </div>

    <div class="form-row hidden" id="customViewportRow">
      <div class="form-group">
        <label>Width (px)</label>
        <input class="form-control" id="customW" type="number" value="${run.viewport?.width || 1280}" min="320" max="3840" />
      </div>
      <div class="form-group">
        <label>Height (px)</label>
        <input class="form-control" id="customH" type="number" value="${run.viewport?.height || 720}" min="320" max="2160" />
      </div>
    </div>
  `;

  openModal('Re-run Failed Tests', html, 'modal-sm', async () => {
    const browser = document.querySelector('input[name=runBrowser]:checked')?.value || run.browser || 'chromium';
    const device = document.getElementById('runDevice').value;
    const environmentId = document.getElementById('runEnvironment')?.value || null;
    const body = { browser, device, scenarioIds: failedIds, parentRunId: runId };
    if (environmentId) body.environmentId = environmentId;
    if (device === 'custom') {
      body.customViewport = {
        width: parseInt(document.getElementById('customW').value) || 1280,
        height: parseInt(document.getElementById('customH').value) || 720
      };
    }
    startRun('suite', run.suiteId, body);
  }, '↺ Re-run Failed');
}

async function mergeRerun(runId) {
  const bodyHTML = `
    <p style="font-size:14px;color:var(--muted);margin-bottom:16px">Enter the Job # of the rerun whose passed results should be merged into this report.</p>
    <div class="form-group">
      <label>Rerun Job #</label>
      <input type="number" id="mergeJobNumber" class="form-control" placeholder="e.g. 132" autofocus>
    </div>`;
  openModal('Merge Rerun Results', bodyHTML, 'modal-sm', async () => {
    const jobNumber = parseInt(document.getElementById('mergeJobNumber').value);
    if (!jobNumber) { toast('Please enter a job number', 'error'); return false; }
    try {
      await POST(`/api/runs/${runId}/merge`, { jobNumber });
    } catch (e) {
      toast(e.message || 'Merge failed', 'error');
      return false;
    }
    toast('Rerun results merged', 'success');
    closeModal();
    await renderRunDetail(runId);
    return false;
  }, 'Merge');
}

async function startRun(type, id, body) {
  closeModal();
  const url = type === 'suite' ? `/api/runs/suite/${id}` : `/api/runs/scenario/${id}`;

  openRunConsole();

  let cancelled = false;
  state.runningRun = { controller: { abort: () => { cancelled = true; } } };

  try {
    const token = getToken();
    const runHeaders = { 'Content-Type': 'application/json' };
    if (token) runHeaders['Authorization'] = `Bearer ${token}`;

    const startResp = await fetch(url, { method: 'POST', headers: runHeaders, body: JSON.stringify(body) });
    if (!startResp.ok) {
      let errMsg = `Server error (${startResp.status})`;
      try { const err = await startResp.json(); errMsg = err.error || errMsg; } catch {}
      toast('Run failed: ' + errMsg, 'error');
      return;
    }
    const { data } = await startResp.json();
    const runId = data.runId;

    // Poll for events
    let since = 0;
    while (!cancelled) {
      await new Promise(r => setTimeout(r, 1000));
      if (cancelled) break;
      try {
        const pollResp = await fetch(`/api/runs/${runId}/events?since=${since}`, { headers: runHeaders });
        if (!pollResp.ok) break;
        const { events, done } = await pollResp.json();
        for (const event of events) {
          handleRunEvent(event);
        }
        since += events.length;
        if (done) break;
      } catch (e) {
        if (!cancelled) toast('Connection error during run', 'error');
        break;
      }
    }
  } catch (e) {
    if (!cancelled) toast('Run failed: ' + e.message, 'error');
  } finally {
    state.runningRun = null;
    await loadRuns();
  }
}

let runConsoleRunId = null;

function openRunConsole() {
  runConsoleRunId = null;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'runConsoleModal';
  modal.style.zIndex = '1050';
  modal.innerHTML = `<div class="modal modal-lg" style="max-height:80vh">
    <div class="modal-header">
      <h2>🔄 Running Tests…</h2>
      <div style="display:flex;gap:8px">
        <span id="runConsoleStatus" class="badge badge-running">running</span>
        <button class="modal-close" onclick="cancelRun()">✕</button>
      </div>
    </div>
    <div class="modal-body" style="padding:12px">
      <div class="run-console" id="runConsole"></div>
    </div>
    <div class="modal-footer" id="runConsoleFooter">
      <button class="btn btn-secondary" onclick="cancelRun()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}

function handleRunEvent(event) {
  const console = document.getElementById('runConsole');
  if (!console) return;

  const time = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function addLine(text, cls, icon) {
    const line = document.createElement('div');
    line.className = `run-log-line ${cls}`;
    line.innerHTML = `<span class="rl-time">${time}</span><span class="rl-icon">${icon}</span><span class="rl-text">${esc(text)}</span>`;
    console.appendChild(line);
    console.scrollTop = console.scrollHeight;
  }

  switch (event.type) {
    case 'ping': break;
    case 'run_start':
      runConsoleRunId = event.runId;
      addLine(`Starting: ${event.name}`, 'info', '▶');
      break;
    case 'scenario_start':
      addLine(`Scenario ${event.scenarioIndex + 1}: ${event.scenarioName}`, 'info', '📋');
      break;
    case 'step_action_start':
      addLine(`  ♻️ Action: ${event.actionName}`, 'info', '');
      break;
    case 'step_action_end':
      addLine(`  ♻️ Action "${event.actionName}" ${event.status}`, event.status === 'passed' ? 'passed' : 'failed', event.status === 'passed' ? '✓' : '✗');
      break;
    case 'step':
      if (event.status === 'running') {
        addLine(`  ${event.subStepIndex !== undefined ? '    ' : ''}Step ${event.stepIndex + 1}: ${event.description}`, 'running', '…');
      } else if (event.status === 'passed') {
        addLine(`  ${event.subStepIndex !== undefined ? '    ' : ''}✓ ${event.description} (${event.duration}ms)`, 'passed', '');
      } else if (event.status === 'failed') {
        addLine(`  ${event.subStepIndex !== undefined ? '    ' : ''}✗ ${event.description}: ${event.message || 'failed'}`, 'failed', '');
      } else {
        addLine(`  ${event.subStepIndex !== undefined ? '    ' : ''}− ${event.description} (skipped)`, 'skipped', '');
      }
      break;
    case 'scenario_complete':
      addLine(`Scenario ${event.status}: ${(event.duration / 1000).toFixed(1)}s`, event.status === 'passed' ? 'passed' : 'failed', event.status === 'passed' ? '✓' : '✗');
      break;
    case 'error':
      addLine(`Error: ${event.message}`, 'failed', '⚠');
      break;
    case 'done': {
      runConsoleRunId = event.runId;
      const statusBadge = document.getElementById('runConsoleStatus');
      if (statusBadge) { statusBadge.className = `badge badge-${event.status}`; statusBadge.textContent = event.status; }
      const title = document.querySelector('#runConsoleModal .modal-header h2');
      if (title) title.textContent = event.status === 'passed' ? '✅ Tests Passed' : '❌ Tests Failed';
      addLine(`Run complete — ${event.status.toUpperCase()}`, event.status === 'passed' ? 'passed' : 'failed', event.status === 'passed' ? '🎉' : '💥');

      const footer = document.getElementById('runConsoleFooter');
      if (footer) {
        footer.innerHTML = `
          <button class="btn btn-secondary" onclick="document.getElementById('runConsoleModal')?.remove()">Close</button>
          ${runConsoleRunId ? `<button class="btn btn-primary" onclick="document.getElementById('runConsoleModal')?.remove();navigate('run-detail','${runConsoleRunId}')">View Full Report →</button>` : ''}
        `;
      }
      break;
    }
  }
}

function cancelRun() {
  if (state.runningRun) {
    state.runningRun.controller.abort();
    state.runningRun = null;
  }
  document.getElementById('runConsoleModal')?.remove();
}

// ─── MODAL ENGINE ─────────────────────────────────────────────────────────────

let currentModalCallback = null;

function openModal(title, bodyHTML, sizeClass, onConfirm, confirmLabel) {
  closeModal();
  currentModalCallback = onConfirm;

  const container = document.getElementById('modalContainer');
  const footerHTML = onConfirm
    ? `<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
       <button class="btn btn-primary" id="modalConfirmBtn" onclick="confirmModal()">${confirmLabel || 'Save'}</button>`
    : `<button class="btn btn-secondary" onclick="closeModal()">Close</button>`;

  container.innerHTML = `<div class="modal-overlay" id="activeModalOverlay">
    <div class="modal ${sizeClass || 'modal-md'}">
      <div class="modal-header">
        <h2>${esc(title)}</h2>
        <button class="modal-close" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body" id="activeModalBody">${bodyHTML}</div>
      <div class="modal-footer">${footerHTML}</div>
    </div>
  </div>`;

  document.getElementById('activeModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'activeModalOverlay') closeModal();
  });
}

async function confirmModal() {
  if (!currentModalCallback) { closeModal(); return; }
  const btn = document.getElementById('modalConfirmBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  const result = await currentModalCallback();
  if (result !== false) closeModal();
  else if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Save'; }
}

function closeModal() {
  stopEmbeddedBrowser();
  document.getElementById('modalContainer').innerHTML = '';
  currentModalCallback = null;
}

async function cloneScenario(id) {
  try {
    const cloned = await POST(`/api/scenarios/${id}/clone`, {});
    state.scenarios.push(cloned);
    navigate(state.currentPage);
    toast(`Cloned as "${cloned.name}"`, 'success');
  } catch (e) { toast('Could not clone scenario', 'error'); }
}

async function deleteScenario(id) {
  if (!confirm('Delete this scenario? This cannot be undone.')) return;
  try {
    await DEL(`/api/scenarios/${id}`);
    state.scenarios = state.scenarios.filter(s => s.id !== id);
    toast('Scenario deleted', 'success');
    navigate(state.currentPage);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── TOAST ────────────────────────────────────────────────────────────────────

function toast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ';
  el.innerHTML = `<span>${icon}</span><span>${esc(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(100%)'; el.style.transition = 'all .3s'; setTimeout(() => el.remove(), 300); }, 3500);
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function screenshotSrc(runId, shot) {
  if (!shot) return '';
  return /\.(jpg|jpeg|png)$/i.test(shot) ? `/screenshots/${runId}/${shot}` : `data:image/jpeg;base64,${shot}`;
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function browserIcon(b) {
  if (b === 'firefox') return '🦊';
  if (b === 'webkit') return '🧭';
  return '🌐';
}

function deviceIcon(d) {
  if (!d) return '🖥️';
  if (d.startsWith('mobile')) return '📱';
  if (d.startsWith('tablet')) return '📲';
  if (d.startsWith('laptop')) return '💻';
  return '🖥️';
}

// ─── ENVIRONMENTS PAGE ────────────────────────────────────────────────────────

async function renderEnvironmentsPage() {
  if (!state.currentProjectId) {
    document.getElementById('mainContent').innerHTML = `
      <div style="padding:40px;text-align:center;color:#64748b">
        <p>Select a project to manage its environments.</p>
      </div>`;
    return;
  }
  await loadEnvironments();
  const project = state.projects.find(p => p.id === state.currentProjectId);
  const envs = state.environments;

  const rows = envs.length ? envs.map(e => `
    <tr>
      <td>${esc(e.name)} ${e.isDefault ? '<span class="env-badge-default">Default</span>' : ''}</td>
      <td style="font-family:monospace;font-size:12px;color:#475569">${esc(e.baseUrl || '')}</td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="openEnvironmentModal('${e.id}')">Edit</button>
        <button class="btn btn-ghost btn-sm" style="color:#ef4444" onclick="deleteEnvironment('${e.id}')">Delete</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="3" style="text-align:center;color:#94a3b8;padding:32px">No environments yet</td></tr>`;

  document.getElementById('mainContent').innerHTML = `
    <div class="page-header">
      <div>
        <h2>Environments</h2>
        <p class="subtitle">Manage test environments for <strong>${esc(project?.name || '')}</strong></p>
      </div>
      <button class="btn btn-primary" onclick="openEnvironmentModal(null)">+ New Environment</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <table class="env-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Base URL</th>
            <th style="width:140px">Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function openEnvironmentModal(id) {
  const env = id ? state.environments.find(e => e.id === id) : null;
  const title = env ? 'Edit Environment' : 'New Environment';
  const hasPassword = env?.httpPasswordSet;

  const bodyHTML = `
    <div class="form-group">
      <label>Name</label>
      <input class="form-control" id="envName" type="text" placeholder="e.g. Staging, Production" value="${esc(env?.name || '')}" />
    </div>
    <div class="form-group">
      <label>Base URL</label>
      <input class="form-control" id="envBaseUrl" type="url" placeholder="https://staging.example.com" value="${esc(env?.baseUrl || '')}" />
      <div class="form-hint">Available as <code>{{baseUrl}}</code> in step parameters</div>
    </div>
    <div class="form-group" style="display:flex;align-items:center;gap:10px">
      <label class="toggle-switch" style="margin:0">
        <input type="checkbox" id="envIsDefault" ${env?.isDefault ? 'checked' : ''} />
        <span class="toggle-slider"></span>
      </label>
      <span style="font-size:13px">Set as default environment</span>
    </div>

    <div class="divider" style="margin:16px 0 12px"></div>
    <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">🔒 HTTP Basic Authentication</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:12px">
      If your dev/staging site is protected by a basic auth popup, enter the credentials here.
      Playwright will automatically handle the login challenge — no extra steps needed in your scenarios.
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Username</label>
        <input class="form-control" id="envHttpUser" type="text" placeholder="dev-user" value="${esc(env?.httpUsername || '')}" autocomplete="off" />
      </div>
      <div class="form-group">
        <label>Password ${hasPassword ? '<span style="color:var(--success);font-size:11px">● saved</span>' : ''}</label>
        <input class="form-control" id="envHttpPass" type="password"
          placeholder="${hasPassword ? 'Leave blank to keep existing' : 'Enter password'}"
          autocomplete="new-password" />
        ${hasPassword ? `<div class="form-hint" style="cursor:pointer;color:var(--error)" onclick="document.getElementById('envClearPass').checked=true;this.textContent='Will be cleared on save'">Clear saved password</div>
          <input type="checkbox" id="envClearPass" style="display:none">` : '<input type="checkbox" id="envClearPass" style="display:none">'}
      </div>
    </div>`;

  openModal(title, bodyHTML, 'modal-sm', async () => {
    await saveEnvironment(id || null);
  }, env ? 'Save Changes' : 'Create');
}

async function saveEnvironment(id) {
  const name = document.getElementById('envName').value.trim();
  const baseUrl = document.getElementById('envBaseUrl').value.trim();
  const isDefault = document.getElementById('envIsDefault').checked;
  const httpUsername = document.getElementById('envHttpUser').value.trim();
  const httpPassword = document.getElementById('envHttpPass').value;
  const clearHttpPassword = document.getElementById('envClearPass')?.checked || false;

  if (!name) { toast('Name is required', 'error'); return; }

  const payload = { name, baseUrl, isDefault, httpUsername };
  if (clearHttpPassword) payload.clearHttpPassword = true;
  else if (httpPassword) payload.httpPassword = httpPassword;

  try {
    if (id) {
      await PUT(`/api/environments/${id}`, payload);
      toast('Environment updated');
    } else {
      await POST('/api/environments', { ...payload, projectId: state.currentProjectId });
      toast('Environment created');
    }
    await renderEnvironmentsPage();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteEnvironment(id) {
  if (!confirm('Delete this environment?')) return;
  try {
    await DEL(`/api/environments/${id}`);
    toast('Environment deleted');
    await renderEnvironmentsPage();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── USERS PAGE ───────────────────────────────────────────────────────────────

async function renderUsersPage() {
  if (state.currentUser?.role !== 'admin') { navigate('dashboard'); return; }
  try { state.allUsers = await GET('/api/users'); } catch { state.allUsers = []; }

  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="page-header">
      <div><h1>Users</h1><div class="subtitle">${state.allUsers.length} user${state.allUsers.length !== 1 ? 's' : ''}</div></div>
      <button class="btn btn-primary" onclick="openInviteUserModal()">+ Invite User</button>
    </div>
    <div class="table-wrapper">
      <table>
        <thead><tr>
          <th>Name</th>
          <th>Email</th>
          <th>Role</th>
          <th>Created</th>
          <th>Last Login</th>
          <th>Actions</th>
        </tr></thead>
        <tbody>
          ${state.allUsers.map(u => `
          <tr>
            <td>
              <div style="display:flex;align-items:center;gap:10px">
                <div class="user-avatar" style="background:${u.role === 'admin' ? '#3b82f6' : '#64748b'};width:32px;height:32px;font-size:11px;flex-shrink:0">${userInitials(u.name)}</div>
                <strong>${esc(u.name)}</strong>
                ${u.id === state.currentUser.id ? '<span style="font-size:11px;color:var(--muted)">(you)</span>' : ''}
              </div>
            </td>
            <td>${esc(u.email)}</td>
            <td><span class="role-badge role-${u.role}">${capitalize(u.role)}</span></td>
            <td>${formatDate(u.createdAt)}</td>
            <td>${u.lastLoginAt ? formatDate(u.lastLoginAt) : '<span style="color:var(--muted)">Never</span>'}</td>
            <td>
              <div style="display:flex;gap:6px">
                <button class="btn btn-xs btn-secondary" onclick="openEditUserModal('${u.id}')">Edit</button>
                ${u.id !== state.currentUser.id ? `<button class="btn btn-xs btn-danger" onclick="openDeleteUserModal('${u.id}')">Delete</button>` : ''}
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function openInviteUserModal() {
  const html = `
    <div class="form-row">
      <div class="form-group">
        <label>Full Name *</label>
        <input class="form-control" id="iuName" type="text" placeholder="Jane Smith" />
      </div>
      <div class="form-group">
        <label>Email *</label>
        <input class="form-control" id="iuEmail" type="email" placeholder="jane@example.com" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Password *</label>
        <input class="form-control" id="iuPassword" type="password" placeholder="Choose a password" />
      </div>
      <div class="form-group">
        <label>Confirm Password *</label>
        <input class="form-control" id="iuConfirm" type="password" placeholder="Repeat password" />
      </div>
    </div>
    <div class="form-group">
      <label>Role</label>
      <div class="radio-group" style="flex-direction:row;gap:16px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:400">
          <input type="radio" name="iuRole" value="member" checked /> Member
        </label>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:400">
          <input type="radio" name="iuRole" value="admin" /> Admin
        </label>
      </div>
    </div>`;

  openModal('Invite User', html, 'modal-md', async () => {
    const name     = document.getElementById('iuName').value.trim();
    const email    = document.getElementById('iuEmail').value.trim();
    const password = document.getElementById('iuPassword').value;
    const confirm  = document.getElementById('iuConfirm').value;
    const role     = document.querySelector('input[name=iuRole]:checked')?.value || 'member';

    if (!name || !email || !password) { toast('Name, email and password are required', 'error'); return false; }
    if (password !== confirm) { toast('Passwords do not match', 'error'); return false; }

    try {
      const user = await POST('/api/users', { name, email, password, role });
      state.allUsers.push(user);
      toast(`User ${name} created`, 'success');
      navigate('users');
    } catch (e) { toast('Error: ' + e.message, 'error'); return false; }
  }, 'Create User');
}

function openEditUserModal(userId) {
  const user = state.allUsers.find(u => u.id === userId);
  if (!user) return;
  const isSelf = user.id === state.currentUser.id;
  const isAdmin = state.currentUser.role === 'admin';

  const html = `
    <div class="form-row">
      <div class="form-group">
        <label>Full Name</label>
        <input class="form-control" id="euName" type="text" value="${esc(user.name)}" />
      </div>
      <div class="form-group">
        <label>Email</label>
        <input class="form-control" id="euEmail" type="email" value="${esc(user.email)}" />
      </div>
    </div>
    ${isAdmin ? `<div class="form-group">
      <label>Role</label>
      <div style="display:flex;gap:16px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:400">
          <input type="radio" name="euRole" value="member" ${user.role === 'member' ? 'checked' : ''} ${isSelf ? 'disabled' : ''}/> Member
        </label>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:400">
          <input type="radio" name="euRole" value="admin" ${user.role === 'admin' ? 'checked' : ''} ${isSelf ? 'disabled' : ''}/> Admin
        </label>
      </div>
      ${isSelf ? '<div class="form-hint">You cannot change your own role.</div>' : ''}
    </div>` : ''}
    <div class="divider"></div>
    <div style="margin-bottom:8px;font-weight:600;font-size:13px">Change Password</div>
    ${isSelf ? `<div class="form-group">
      <label>Current Password</label>
      <input class="form-control" id="euCurrentPw" type="password" placeholder="Your current password" />
    </div>` : ''}
    <div class="form-row">
      <div class="form-group">
        <label>New Password</label>
        <input class="form-control" id="euNewPw" type="password" placeholder="Leave blank to keep unchanged" />
      </div>
      <div class="form-group">
        <label>Confirm New Password</label>
        <input class="form-control" id="euConfirmPw" type="password" placeholder="Repeat new password" />
      </div>
    </div>`;

  openModal('Edit User', html, 'modal-md', async () => {
    const name     = document.getElementById('euName').value.trim();
    const email    = document.getElementById('euEmail').value.trim();
    const role     = document.querySelector('input[name=euRole]:checked')?.value;
    const newPw    = document.getElementById('euNewPw').value;
    const confirmPw= document.getElementById('euConfirmPw').value;
    const currentPw= document.getElementById('euCurrentPw')?.value;

    if (!name || !email) { toast('Name and email are required', 'error'); return false; }
    if (newPw && newPw !== confirmPw) { toast('New passwords do not match', 'error'); return false; }

    const body = { name, email };
    if (isAdmin && role && !isSelf) body.role = role;
    if (newPw) { body.newPassword = newPw; if (currentPw) body.currentPassword = currentPw; }

    try {
      const updated = await PUT(`/api/users/${userId}`, body);
      state.allUsers = state.allUsers.map(u => u.id === userId ? updated : u);
      if (isSelf) { state.currentUser = updated; renderTopbarUser(); }
      toast('User updated', 'success');
      if (state.currentPage === 'users') navigate('users');
    } catch (e) { toast('Error: ' + e.message, 'error'); return false; }
  }, 'Save Changes');
}

function openDeleteUserModal(userId) {
  const user = state.allUsers.find(u => u.id === userId);
  if (!user) return;

  const html = `
    <p style="margin-bottom:16px">Are you sure you want to delete <strong>${esc(user.name)}</strong>? This cannot be undone.</p>
    <div class="form-group">
      <label>Type the user's email to confirm: <strong>${esc(user.email)}</strong></label>
      <input class="form-control" id="deleteUserConfirm" type="email" placeholder="${esc(user.email)}" />
    </div>`;

  openModal('Delete User', html, 'modal-sm', async () => {
    const val = document.getElementById('deleteUserConfirm').value.trim();
    if (val.toLowerCase() !== user.email.toLowerCase()) { toast('Email does not match', 'error'); return false; }
    try {
      await DEL(`/api/users/${userId}`);
      state.allUsers = state.allUsers.filter(u => u.id !== userId);
      toast(`User ${user.name} deleted`, 'success');
      navigate('users');
    } catch (e) { toast('Error: ' + e.message, 'error'); return false; }
  }, 'Delete User');
}

// ─── MY ACCOUNT PAGE ──────────────────────────────────────────────────────────

async function renderAccountPage() {
  const user = state.currentUser;
  if (!user) return navigate('dashboard');

  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="page-header">
      <div>
        <h1>My Account</h1>
        <div class="subtitle">Manage your profile and password</div>
      </div>
    </div>
    <div class="card" style="max-width:560px;margin-bottom:24px">
      <div class="card-header"><h2>Profile</h2></div>
      <div class="card-body">
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
          <div class="user-avatar" style="background:${user.role === 'admin' ? '#3b82f6' : '#64748b'};width:56px;height:56px;font-size:18px">${userInitials(user.name)}</div>
          <div>
            <div style="font-weight:600;font-size:16px">${esc(user.name)}</div>
            <div style="color:var(--muted);font-size:13px">${esc(user.email)}</div>
            <span class="role-badge role-${user.role}" style="margin-top:4px;display:inline-flex">${capitalize(user.role)}</span>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Full Name</label>
            <input class="form-control" id="acName" type="text" value="${esc(user.name)}" />
          </div>
          <div class="form-group">
            <label>Email</label>
            <input class="form-control" id="acEmail" type="email" value="${esc(user.email)}" />
          </div>
        </div>
        <button class="btn btn-primary" onclick="saveAccountProfile()">Save Profile</button>
      </div>
    </div>
    <div class="card" style="max-width:560px">
      <div class="card-header"><h2>Change Password</h2></div>
      <div class="card-body">
        <div class="form-group">
          <label>Current Password</label>
          <input class="form-control" id="acCurrentPw" type="password" placeholder="Your current password" />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>New Password</label>
            <input class="form-control" id="acNewPw" type="password" placeholder="New password" />
          </div>
          <div class="form-group">
            <label>Confirm New Password</label>
            <input class="form-control" id="acConfirmPw" type="password" placeholder="Repeat new password" />
          </div>
        </div>
        <button class="btn btn-primary" onclick="saveAccountPassword()">Change Password</button>
      </div>
    </div>`;
}

async function saveAccountProfile() {
  const name  = document.getElementById('acName').value.trim();
  const email = document.getElementById('acEmail').value.trim();
  if (!name || !email) { toast('Name and email are required', 'error'); return; }
  try {
    const updated = await PUT(`/api/users/${state.currentUser.id}`, { name, email });
    state.currentUser = updated;
    if (state.currentUser.role === 'admin') {
      state.allUsers = state.allUsers.map(u => u.id === updated.id ? updated : u);
    }
    renderTopbarUser();
    toast('Profile updated', 'success');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function saveAccountPassword() {
  const currentPw = document.getElementById('acCurrentPw').value;
  const newPw     = document.getElementById('acNewPw').value;
  const confirmPw = document.getElementById('acConfirmPw').value;
  if (!currentPw || !newPw) { toast('All password fields are required', 'error'); return; }
  if (newPw !== confirmPw) { toast('New passwords do not match', 'error'); return; }
  try {
    await PUT(`/api/users/${state.currentUser.id}`, { currentPassword: currentPw, newPassword: newPw });
    document.getElementById('acCurrentPw').value = '';
    document.getElementById('acNewPw').value = '';
    document.getElementById('acConfirmPw').value = '';
    toast('Password changed', 'success');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── PROJECT SHARING MODAL ────────────────────────────────────────────────────

async function openShareProjectModal(projectId) {
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return;

  // Ensure users list is loaded
  if (state.allUsers.length === 0 && state.currentUser?.role === 'admin') {
    try { state.allUsers = await GET('/api/users'); } catch {}
  }

  const renderShareModal = () => {
    const proj = state.projects.find(p => p.id === projectId);
    const owner = state.allUsers.find(u => u.id === proj?.ownerId);
    const sharedUsers = (proj?.sharedWith || []).map(id => state.allUsers.find(u => u.id === id)).filter(Boolean);
    const unsharedUsers = state.allUsers.filter(u =>
      u.id !== proj?.ownerId &&
      !(proj?.sharedWith || []).includes(u.id)
    );

    const html = `
      <div style="margin-bottom:16px">
        <div style="font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Current Access</div>
        ${owner ? `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
          <div class="user-avatar" style="background:${owner.role === 'admin' ? '#3b82f6' : '#64748b'};flex-shrink:0">${userInitials(owner.name)}</div>
          <div style="flex:1">
            <div style="font-weight:500">${esc(owner.name)}</div>
            <div style="font-size:12px;color:var(--muted)">${esc(owner.email)}</div>
          </div>
          <span style="font-size:18px" data-tooltip="Owner">👑</span>
        </div>` : '<div style="color:var(--muted);font-size:13px">Legacy project (no owner)</div>'}
        ${sharedUsers.map(u => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
          <div class="user-avatar" style="background:${u.role === 'admin' ? '#3b82f6' : '#64748b'};flex-shrink:0">${userInitials(u.name)}</div>
          <div style="flex:1">
            <div style="font-weight:500">${esc(u.name)}</div>
            <div style="font-size:12px;color:var(--muted)">${esc(u.email)}</div>
          </div>
          <button class="btn btn-xs btn-secondary" onclick="removeProjectShare('${projectId}','${u.id}')">Remove</button>
        </div>`).join('')}
        ${!owner && sharedUsers.length === 0 ? '' : ''}
      </div>
      ${unsharedUsers.length > 0 ? `
      <div>
        <div style="font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Add People</div>
        ${unsharedUsers.map(u => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
          <div class="user-avatar" style="background:${u.role === 'admin' ? '#3b82f6' : '#64748b'};flex-shrink:0">${userInitials(u.name)}</div>
          <div style="flex:1">
            <div style="font-weight:500">${esc(u.name)}</div>
            <div style="font-size:12px;color:var(--muted)">${esc(u.email)}</div>
          </div>
          <button class="btn btn-xs btn-primary" onclick="addProjectShare('${projectId}','${u.id}')">Add</button>
        </div>`).join('')}
      </div>` : '<div style="color:var(--muted);font-size:13px">All users already have access.</div>'}
    `;

    const body = document.getElementById('activeModalBody');
    if (body) body.innerHTML = html;
  };

  openModal(`Share "${project.name}"`, '', 'modal-md', null, null);
  renderShareModal();
  // Store for refresh
  window._shareProjectId = projectId;
  window._shareProjectRender = renderShareModal;
}

async function addProjectShare(projectId, userId) {
  try {
    const updated = await PATCH(`/api/projects/${projectId}/share`, { add: [userId] });
    state.projects = state.projects.map(p => p.id === projectId ? updated : p);
    if (window._shareProjectRender) window._shareProjectRender();
    toast('User added', 'success');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function removeProjectShare(projectId, userId) {
  try {
    const updated = await PATCH(`/api/projects/${projectId}/share`, { remove: [userId] });
    state.projects = state.projects.map(p => p.id === projectId ? updated : p);
    if (window._shareProjectRender) window._shareProjectRender();
    toast('User removed', 'success');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── RECORDER IMPORT ──────────────────────────────────────────────────────────



