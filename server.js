'use strict';

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (ignored):', err?.message || err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (ignored):', err?.message || err, err?.stack);
});

// Load .env from /var/www/config/.env
try {
  const envPath = '/var/www/config/.env';
  if (require('fs').existsSync(envPath)) {
    require('fs').readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key) process.env[key] = val;
    });
  }
} catch {}

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { chromium, firefox, webkit } = require('playwright');
const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const { sendEmail } = require('./email');
let PNG, pixelmatch;
try {
  const pngjs = require('pngjs'); PNG = pngjs.PNG;
  const pixelmatchModule = require('pixelmatch');
  pixelmatch = typeof pixelmatchModule === 'function' ? pixelmatchModule : pixelmatchModule.default;
} catch {}
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch {}
let AXE_SOURCE;
try { AXE_SOURCE = require('fs').readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch {}

const compression = require('compression');

const app = express();
const PORT = 3000;

const DATA_DIR = '/var/www/config/data';
const PROJECTS_FILE      = path.join(DATA_DIR, 'projects.json');
const SCENARIOS_FILE     = path.join(DATA_DIR, 'scenarios.json');
const SUITES_FILE        = path.join(DATA_DIR, 'suites.json');
const RUNS_FILE          = path.join(DATA_DIR, 'runs.json');
const RUNS_SUMMARY_FILE  = path.join(DATA_DIR, 'runs-summary.json');
const USERS_FILE         = path.join(DATA_DIR, 'users.json');
const ACTIONS_FILE       = path.join(DATA_DIR, 'actions.json');
const SCHEDULES_FILE     = path.join(DATA_DIR, 'schedules.json');
const ENVIRONMENTS_FILE  = path.join(DATA_DIR, 'environments.json');
const BASELINES_DIR      = '/var/www/config/baselines';
const RUNS_DIR           = path.join(DATA_DIR, 'runs');
const SCREENSHOTS_DIR    = '/var/www/config/screenshots';

const JWT_SECRET = process.env.JWT_SECRET || 'verifai-secret-change-me';
const JWT_EXPIRY = '7d';

// ─── ENCRYPTION (AES-256-CBC) ─────────────────────────────────────────────────
// Key: ENCRYPTION_KEY env var (64 hex chars = 32 bytes), or derived from JWT_SECRET
const _rawKey = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, 'hex').slice(0, 32)
  : crypto.createHash('sha256').update(JWT_SECRET).digest();

function encrypt(plaintext) {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', _rawKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return 'enc:' + iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(value) {
  if (!value || !value.startsWith('enc:')) return value;
  try {
    const parts = value.split(':');
    const iv = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', _rawKey, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

function isEncrypted(value) { return typeof value === 'string' && value.startsWith('enc:'); }
const MASKED = '••••••••';
function maskSecret(value) { return (value && isEncrypted(value)) ? MASKED : (value ? MASKED : ''); }

const BROWSERS = { chromium, firefox, webkit };

const DEVICES = {
  'desktop-1920':  { label: 'Desktop (1920×1080)',        width: 1920, height: 1080 },
  'desktop-1440':  { label: 'Desktop (1440×900)',         width: 1440, height: 900  },
  'laptop-1280':   { label: 'Laptop (1280×720)',          width: 1280, height: 720  },
  'tablet-ipad':   { label: 'iPad (768×1024)',            width: 768,  height: 1024 },
  'tablet-android':{ label: 'Android Tablet (800×1280)',  width: 800,  height: 1280 },
  'mobile-iphone14':{ label: 'iPhone 14 (390×844)',       width: 390,  height: 844  },
  'mobile-iphonese':{ label: 'iPhone SE (375×667)',       width: 375,  height: 667  },
  'mobile-galaxy': { label: 'Galaxy S23 (360×780)',       width: 360,  height: 780  },
  'custom':        { label: 'Custom...', width: null, height: null }
};

// ─── DATA HELPERS ─────────────────────────────────────────────────────────────

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PROJECTS_FILE))     fs.writeFileSync(PROJECTS_FILE,     '[]');
  if (!fs.existsSync(SCENARIOS_FILE))    fs.writeFileSync(SCENARIOS_FILE,    '[]');
  if (!fs.existsSync(SUITES_FILE))       fs.writeFileSync(SUITES_FILE,       '[]');
  if (!fs.existsSync(RUNS_FILE))         fs.writeFileSync(RUNS_FILE,         '[]');
  if (!fs.existsSync(USERS_FILE))        fs.writeFileSync(USERS_FILE,        '[]');
  if (!fs.existsSync(ACTIONS_FILE))      fs.writeFileSync(ACTIONS_FILE,      '[]');
  if (!fs.existsSync(SCHEDULES_FILE))    fs.writeFileSync(SCHEDULES_FILE,    '[]');
  if (!fs.existsSync(ENVIRONMENTS_FILE)) fs.writeFileSync(ENVIRONMENTS_FILE, '[]');
  if (!fs.existsSync(BASELINES_DIR))     fs.mkdirSync(BASELINES_DIR, { recursive: true });
  if (!fs.existsSync(RUNS_DIR))          fs.mkdirSync(RUNS_DIR, { recursive: true });
  if (!fs.existsSync(SCREENSHOTS_DIR))   fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function saveRunFile(run) {
  try { fs.writeFileSync(path.join(RUNS_DIR, run.id + '.json'), JSON.stringify(run)); }
  catch (e) { console.error('saveRunFile error:', e.message); }
}

function readRunFile(id) {
  const f = path.join(RUNS_DIR, id + '.json');
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  }
  return null;
}

const RUN_SUMMARY_KEYS = ['id', 'jobNumber', 'type', 'scenarioId', 'suiteId', 'projectId', 'name', 'browser', 'device', 'status', 'startedAt', 'completedAt', 'duration', 'summary', 'environmentId', 'environmentName', 'environmentBaseUrl', 'triggeredBy', 'scheduleId', 'scheduleName', 'parentRunId'];

function toRunSummary(run) {
  const s = {};
  for (const k of RUN_SUMMARY_KEYS) if (k in run) s[k] = run[k];
  return s;
}

function readRunsSummary() {
  try { return JSON.parse(fs.readFileSync(RUNS_SUMMARY_FILE, 'utf8')); }
  catch { return []; }
}

function writeRunsSummary(summaries) {
  fs.writeFileSync(RUNS_SUMMARY_FILE, JSON.stringify(summaries, null, 2));
}

function migrateRunsIfNeeded() {
  if (fs.existsSync(RUNS_SUMMARY_FILE)) return;
  console.log('Migrating runs to split storage (one-time, may take a moment)...');
  const runs = readJSON(RUNS_FILE);
  const summaries = [];
  for (const run of runs) {
    try { fs.writeFileSync(path.join(RUNS_DIR, run.id + '.json'), JSON.stringify(run)); } catch {}
    summaries.push(toRunSummary(run));
  }
  writeRunsSummary(summaries);
  console.log(`Migration complete: ${runs.length} runs indexed.`);
}

function saveScreenshot(runId, index, buf, suffix, ext = 'jpg') {
  const dir = path.join(SCREENSHOTS_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  const fname = suffix ? `${index}-${suffix}.${ext}` : `${index}.${ext}`;
  fs.writeFileSync(path.join(dir, fname), buf);
  return fname;
}

// Migrate projects: ensure ownerId and sharedWith fields exist
function migrateProjects() {
  const projects = readJSON(PROJECTS_FILE);
  let changed = false;
  projects.forEach(p => {
    if (!('ownerId' in p))    { p.ownerId = null; changed = true; }
    if (!('sharedWith' in p)) { p.sharedWith = []; changed = true; }
  });
  if (changed) writeJSON(PROJECTS_FILE, projects);
}

ensureDataFiles();
migrateProjects();
migrateRunsIfNeeded();

// ─── SCHEDULE CRON MANAGER ────────────────────────────────────────────────────

const cronTasks = new Map(); // scheduleId → node-cron task

function buildCronExpression(frequency, hour, dayOfWeek, customExpr) {
  const h = parseInt(hour) || 0;
  switch (frequency) {
    case 'hourly':   return '0 * * * *';
    case 'every6h':  return '0 */6 * * *';
    case 'every12h': return '0 */12 * * *';
    case 'daily':    return `0 ${h} * * *`;
    case 'weekly':   return `0 ${h} * * ${parseInt(dayOfWeek) || 0}`;
    case 'custom':   return customExpr || '0 0 * * *';
    default:         return '0 0 * * *';
  }
}

function frequencyLabel(schedule) {
  switch (schedule.frequency) {
    case 'hourly':   return 'Every hour';
    case 'every6h':  return 'Every 6 hours';
    case 'every12h': return 'Every 12 hours';
    case 'daily': {
      const h = parseInt(schedule.hour) || 0;
      const ampm = h < 12 ? 'AM' : 'PM';
      const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `Daily at ${displayH}:00 ${ampm}`;
    }
    case 'weekly': {
      const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const h = parseInt(schedule.hour) || 0;
      const ampm = h < 12 ? 'AM' : 'PM';
      const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `Weekly on ${days[parseInt(schedule.dayOfWeek) || 0]} at ${displayH}:00 ${ampm}`;
    }
    case 'custom':   return `Custom (${schedule.cronExpression})`;
    default:         return schedule.cronExpression || '';
  }
}

function startCronJob(schedule) {
  stopCronJob(schedule.id);
  if (!cron.validate(schedule.cronExpression)) return;
  const task = cron.schedule(schedule.cronExpression, async () => {
    await runScheduledJob(schedule.id);
  }, { timezone: schedule.timezone || 'UTC' });
  cronTasks.set(schedule.id, task);
}

function stopCronJob(id) {
  const task = cronTasks.get(id);
  if (task) { task.stop(); cronTasks.delete(id); }
}

async function runScheduledJob(scheduleId) {
  const schedules = readJSON(SCHEDULES_FILE);
  const schedule = schedules.find(s => s.id === scheduleId);
  if (!schedule || !schedule.enabled) return;

  schedule.lastRunAt = new Date().toISOString();
  const idx0 = schedules.findIndex(s => s.id === scheduleId);
  if (idx0 !== -1) schedules[idx0] = schedule;
  writeJSON(SCHEDULES_FILE, schedules);

  const viewport = schedule.customViewport ||
    (DEVICES[schedule.device] ? { width: DEVICES[schedule.device].width, height: DEVICES[schedule.device].height } : { width: 1920, height: 1080 });
  const browserName = schedule.browser || 'chromium';

  const runId = randomUUID();
  const now = new Date().toISOString();
  const startTime = Date.now();

  // Silent send (no SSE)
  const silent = () => {};

  let run = null;

  try {
    if (schedule.targetType === 'scenario') {
      const scenarios = readJSON(SCENARIOS_FILE);
      const scenario = scenarios.find(s => s.id === schedule.targetId);
      if (!scenario) throw new Error('Scenario not found');

      const summaries = readRunsSummary();
      run = {
        id: runId,
        jobNumber: summaries.length + 1,
        type: 'scenario',
        scenarioId: scenario.id,
        suiteId: null,
        projectId: scenario.projectId,
        name: scenario.name,
        browser: browserName,
        device: schedule.device || 'desktop-1920',
        viewport,
        status: 'running',
        startedAt: now,
        completedAt: null,
        duration: null,
        scenarioResults: [],
        summary: { total: 1, passed: 0, failed: 0, passRate: 0 },
        triggeredBy: 'schedule',
        scheduleId: schedule.id,
        scheduleName: schedule.name
      };

      summaries.push(toRunSummary(run));
      writeRunsSummary(summaries);

      let schedScenarioBaseUrl = null;
      if (scenario.projectId) {
        const projects = readJSON(PROJECTS_FILE);
        const proj = projects.find(p => p.id === scenario.projectId);
        if (proj && proj.baseUrl) schedScenarioBaseUrl = proj.baseUrl;
      }
      const schedScenarioToRun = schedScenarioBaseUrl ? { ...scenario, _envBaseUrl: schedScenarioBaseUrl } : scenario;

      const result = await executeScenario(schedScenarioToRun, browserName, viewport, silent, 0, undefined, runId);
      run.scenarioResults.push(result);
      run.status = result.status === 'passed' ? 'passed' : 'failed';
      const passed = result.status === 'passed' ? 1 : 0;
      run.summary = { total: 1, passed, failed: 1 - passed, passRate: passed * 100 };

    } else if (schedule.targetType === 'suite') {
      const suites = readJSON(SUITES_FILE);
      const suite = suites.find(s => s.id === schedule.targetId);
      if (!suite) throw new Error('Suite not found');

      const allScenarios = readJSON(SCENARIOS_FILE);
      const scenariosToRun = (suite.scenarioIds || [])
        .map(id => allScenarios.find(s => s.id === id))
        .filter(Boolean);

      const summaries = readRunsSummary();
      run = {
        id: runId,
        jobNumber: summaries.length + 1,
        type: 'suite',
        scenarioId: null,
        suiteId: suite.id,
        projectId: suite.projectId,
        name: suite.name,
        browser: browserName,
        device: schedule.device || 'desktop-1920',
        viewport,
        status: 'running',
        startedAt: now,
        completedAt: null,
        duration: null,
        scenarioResults: [],
        summary: { total: scenariosToRun.length, passed: 0, failed: 0, passRate: 0 },
        triggeredBy: 'schedule',
        scheduleId: schedule.id,
        scheduleName: schedule.name
      };

      summaries.push(toRunSummary(run));
      writeRunsSummary(summaries);

      let schedSuiteBaseUrl = null;
      if (suite.projectId) {
        const projects = readJSON(PROJECTS_FILE);
        const proj = projects.find(p => p.id === suite.projectId);
        if (proj && proj.baseUrl) schedSuiteBaseUrl = proj.baseUrl;
      }

      let passed = 0;
      let failed = 0;
      for (let i = 0; i < scenariosToRun.length; i++) {
        const scenario = scenariosToRun[i];
        const schedSuiteScenario = schedSuiteBaseUrl ? { ...scenario, _envBaseUrl: schedSuiteBaseUrl } : scenario;
        try {
          const result = await executeScenario(schedSuiteScenario, browserName, viewport, silent, i, undefined, runId);
          run.scenarioResults.push(result);
          if (result.status === 'passed') passed++; else failed++;
        } catch (err) {
          failed++;
          run.scenarioResults.push({ scenarioId: scenario.id, scenarioName: scenario.name, status: 'error', duration: 0, steps: [] });
        }
      }
      run.status = failed === 0 ? 'passed' : 'failed';
      run.summary = {
        total: scenariosToRun.length, passed, failed,
        passRate: scenariosToRun.length > 0 ? Math.round((passed / scenariosToRun.length) * 100) : 0
      };
    }
  } catch (err) {
    if (run) {
      run.status = 'error';
      run.summary = { total: 1, passed: 0, failed: 1, passRate: 0 };
    }
    console.error(`Scheduled job error [${schedule.name}]:`, err.message);
  }

  if (run) {
    run.completedAt = new Date().toISOString();
    run.duration = Date.now() - startTime;
    saveRunFile(run);
    const allSummaries = readRunsSummary();
    const ri = allSummaries.findIndex(r => r.id === runId);
    if (ri !== -1) allSummaries[ri] = toRunSummary(run);
    writeRunsSummary(allSummaries);

    // Update schedule with last run info
    const updatedSchedules = readJSON(SCHEDULES_FILE);
    const si = updatedSchedules.findIndex(s => s.id === scheduleId);
    if (si !== -1) {
      updatedSchedules[si].lastRunStatus = run.status;
      updatedSchedules[si].lastRunId = runId;
      updatedSchedules[si].updatedAt = new Date().toISOString();
      writeJSON(SCHEDULES_FILE, updatedSchedules);
    }

    // Send notify emails if configured
    const recipients = (schedule.notifyEmails || '').split(',').map(e => e.trim()).filter(Boolean);
    if (recipients.length > 0) {
      try {
        const reportUrl = `${process.env.APP_URL || 'http://localhost:3000'}/report/${runId}`;
        await sendRunEmail(run, recipients, { reportUrl });
      } catch (emailErr) {
        console.error(`Schedule notify email failed [${schedule.name}]:`, emailErr.message);
      }
    }
  }
}

function initSchedules() {
  const schedules = readJSON(SCHEDULES_FILE);
  const enabled = schedules.filter(s => s.enabled);
  enabled.forEach(s => startCronJob(s));
  console.log(`Initialized ${enabled.length} schedule${enabled.length !== 1 ? 's' : ''}`);
}

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired, please log in again' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Keep only items whose project the user can access (items with no project stay visible)
function filterByProjectAccess(items, user) {
  const accessibleIds = new Set(readJSON(PROJECTS_FILE).filter(p => canAccessProject(p, user)).map(p => p.id));
  return items.filter(i => !i.projectId || accessibleIds.has(i.projectId));
}

// True when projectId is empty or refers to a project the user can access
function canUseProjectId(projectId, user) {
  if (!projectId) return true;
  const proj = readJSON(PROJECTS_FILE).find(p => p.id === projectId);
  return !!proj && canAccessProject(proj, user);
}

// Sends 403 and returns true when the user can't use the given project
function denyProject(res, projectId, user) {
  if (canUseProjectId(projectId, user)) return false;
  res.status(403).json({ error: 'Access denied' });
  return true;
}

// Run summaries carry projectId; use them for cheap access checks by run id
function denyRun(res, runId, user) {
  const summary = readRunsSummary().find(r => r.id === runId);
  return denyProject(res, summary ? summary.projectId : null, user);
}

function canAccessProject(project, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!project.ownerId) return true; // legacy project
  if (project.ownerId === user.id) return true;
  return (project.sharedWith || []).includes(user.id);
}

function safeUser(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}

// ─── AUTH ENDPOINTS ───────────────────────────────────────────────────────────

app.get('/api/auth/setup', (req, res) => {
  const users = readJSON(USERS_FILE);
  res.json({ data: { needsSetup: users.length === 0 } });
});

app.post('/api/auth/setup', async (req, res) => {
  const users = readJSON(USERS_FILE);
  if (users.length > 0) return res.status(403).json({ error: 'Setup already complete' });
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date().toISOString();
  const user = { id: randomUUID(), name, email: email.toLowerCase(), passwordHash, role: 'admin', createdAt: now, lastLoginAt: now };
  users.push(user);
  writeJSON(USERS_FILE, users);
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.status(201).json({ data: { token, user: safeUser(user) } });
});

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const users = readJSON(USERS_FILE);
  if (users.length === 0) return res.status(403).json({ error: 'No admin account exists yet. Complete setup first.' });
  if (users.find(u => u.email === email.toLowerCase())) return res.status(400).json({ error: 'An account with that email already exists' });
  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date().toISOString();
  const user = { id: randomUUID(), name, email: email.toLowerCase(), passwordHash, role: 'member', createdAt: now, lastLoginAt: now };
  users.push(user);
  writeJSON(USERS_FILE, users);
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.status(201).json({ data: { token, user: safeUser(user) } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.email === email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
  user.lastLoginAt = new Date().toISOString();
  writeJSON(USERS_FILE, users);
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.json({ data: { token, user: safeUser(user) } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ data: safeUser(user) });
});

// ─── USER MANAGEMENT ──────────────────────────────────────────────────────────

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const users = readJSON(USERS_FILE);
  res.json({ data: users.map(safeUser) });
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
  const users = readJSON(USERS_FILE);
  if (users.find(u => u.email === email.toLowerCase())) return res.status(400).json({ error: 'Email already in use' });
  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date().toISOString();
  const user = { id: randomUUID(), name, email: email.toLowerCase(), passwordHash, role: role === 'admin' ? 'admin' : 'member', createdAt: now, lastLoginAt: null };
  users.push(user);
  writeJSON(USERS_FILE, users);
  res.status(201).json({ data: safeUser(user) });
});

app.put('/api/users/:id', requireAuth, async (req, res) => {
  const isSelf = req.user.id === req.params.id;
  const isAdmin = req.user.role === 'admin';
  if (!isSelf && !isAdmin) return res.status(403).json({ error: 'Access denied' });

  const users = readJSON(USERS_FILE);
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });

  const user = users[idx];
  if (req.body.name)  user.name  = req.body.name;
  if (req.body.email) user.email = req.body.email.toLowerCase();
  if (isAdmin && req.body.role) user.role = req.body.role === 'admin' ? 'admin' : 'member';

  if (req.body.newPassword) {
    if (!isSelf && !isAdmin) return res.status(403).json({ error: 'Cannot change another user\'s password' });
    if (isSelf && !isAdmin) {
      if (!req.body.currentPassword) return res.status(400).json({ error: 'Current password required' });
      const valid = await bcrypt.compare(req.body.currentPassword, user.passwordHash);
      if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
    }
    user.passwordHash = await bcrypt.hash(req.body.newPassword, 12);
  }

  writeJSON(USERS_FILE, users);
  res.json({ data: safeUser(user) });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  if (req.user.id === req.params.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  const users = readJSON(USERS_FILE);
  const filtered = users.filter(u => u.id !== req.params.id);
  if (filtered.length === users.length) return res.status(404).json({ error: 'User not found' });
  writeJSON(USERS_FILE, filtered);
  res.json({ data: { success: true } });
});

// ─── PROJECTS ─────────────────────────────────────────────────────────────────

app.get('/api/projects', requireAuth, (req, res) => {
  const projects = readJSON(PROJECTS_FILE);
  res.json({ data: projects.filter(p => canAccessProject(p, req.user)) });
});

app.post('/api/projects', requireAuth, (req, res) => {
  const projects = readJSON(PROJECTS_FILE);
  const now = new Date().toISOString();
  const project = {
    id: randomUUID(),
    name: req.body.name || 'Unnamed Project',
    description: req.body.description || '',
    baseUrl: req.body.baseUrl || '',
    color: req.body.color || '#3b82f6',
    ownerId: req.user.id,
    sharedWith: [],
    createdAt: now,
    updatedAt: now
  };
  projects.push(project);
  writeJSON(PROJECTS_FILE, projects);
  res.status(201).json({ data: project });
});

app.put('/api/projects/:id', requireAuth, (req, res) => {
  const projects = readJSON(PROJECTS_FILE);
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  const project = projects[idx];
  if (!canAccessProject(project, req.user)) return res.status(403).json({ error: 'Access denied' });
  if (project.ownerId && project.ownerId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the project owner or admin can edit this project' });
  }
  // Don't let PUT overwrite ownerId/sharedWith
  const { ownerId, sharedWith, ...body } = req.body;
  projects[idx] = { ...project, ...body, id: project.id, ownerId: project.ownerId, sharedWith: project.sharedWith, updatedAt: new Date().toISOString() };
  writeJSON(PROJECTS_FILE, projects);
  res.json({ data: projects[idx] });
});

app.delete('/api/projects/:id', requireAuth, (req, res) => {
  const projects = readJSON(PROJECTS_FILE);
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.ownerId && project.ownerId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the project owner or admin can delete this project' });
  }
  const filtered = projects.filter(p => p.id !== req.params.id);
  writeJSON(PROJECTS_FILE, filtered);
  const scenarios = readJSON(SCENARIOS_FILE).filter(s => s.projectId !== req.params.id);
  writeJSON(SCENARIOS_FILE, scenarios);
  const suites = readJSON(SUITES_FILE).filter(s => s.projectId !== req.params.id);
  writeJSON(SUITES_FILE, suites);
  res.json({ data: { success: true } });
});

// ─── PROJECT SHARING ──────────────────────────────────────────────────────────

app.patch('/api/projects/:id/share', requireAuth, (req, res) => {
  const projects = readJSON(PROJECTS_FILE);
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  const project = projects[idx];
  if (project.ownerId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the project owner or admin can share this project' });
  }
  const shared = new Set(project.sharedWith || []);
  (req.body.add || []).forEach(id => { if (id !== project.ownerId) shared.add(id); });
  (req.body.remove || []).forEach(id => shared.delete(id));
  project.sharedWith = Array.from(shared);
  project.updatedAt = new Date().toISOString();
  writeJSON(PROJECTS_FILE, projects);
  res.json({ data: project });
});

// ─── SCENARIOS ────────────────────────────────────────────────────────────────

app.get('/api/scenarios', requireAuth, (req, res) => {
  let scenarios = readJSON(SCENARIOS_FILE);
  const projects = readJSON(PROJECTS_FILE);
  const accessibleIds = new Set(projects.filter(p => canAccessProject(p, req.user)).map(p => p.id));
  scenarios = scenarios.filter(s => !s.projectId || accessibleIds.has(s.projectId));
  if (req.query.projectId) scenarios = scenarios.filter(s => s.projectId === req.query.projectId);
  res.json({ data: scenarios.map(s => ({ ...s, variables: maskVariables(s.variables) })) });
});

// Encrypt secret variables before storing; mask them before returning to client
function encryptVariables(variables) {
  return (variables || []).map(v => ({
    ...v,
    defaultValue: v.type === 'secret' && v.defaultValue && !isEncrypted(v.defaultValue)
      ? encrypt(v.defaultValue)
      : v.defaultValue
  }));
}
function maskVariables(variables) {
  return (variables || []).map(v => ({
    ...v,
    defaultValue: v.type === 'secret' ? (v.defaultValue ? MASKED : '') : v.defaultValue
  }));
}

app.post('/api/scenarios', requireAuth, (req, res) => {
  if (!canUseProjectId(req.body.projectId, req.user)) return res.status(403).json({ error: 'Access denied' });
  const scenarios = readJSON(SCENARIOS_FILE);
  const now = new Date().toISOString();
  const scenario = {
    id: randomUUID(),
    projectId: req.body.projectId || null,
    name: req.body.name || 'Unnamed Scenario',
    description: req.body.description || '',
    testType: req.body.testType || 'functional',
    steps: req.body.steps || [],
    tags: req.body.tags || [],
    variables: encryptVariables(req.body.variables),
    createdAt: now,
    updatedAt: now
  };
  scenarios.push(scenario);
  writeJSON(SCENARIOS_FILE, scenarios);
  res.status(201).json({ data: { ...scenario, variables: maskVariables(scenario.variables) } });
});

app.get('/api/scenarios/:id', requireAuth, (req, res) => {
  const scenarios = readJSON(SCENARIOS_FILE);
  const scenario = scenarios.find(s => s.id === req.params.id);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
  if (denyProject(res, scenario.projectId, req.user)) return;
  res.json({ data: { ...scenario, variables: maskVariables(scenario.variables) } });
});

app.put('/api/scenarios/:id', requireAuth, (req, res) => {
  const scenarios = readJSON(SCENARIOS_FILE);
  const idx = scenarios.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Scenario not found' });
  if (denyProject(res, scenarios[idx].projectId, req.user) || denyProject(res, req.body.projectId, req.user)) return;
  const updated = { ...scenarios[idx], ...req.body, id: scenarios[idx].id, updatedAt: new Date().toISOString() };
  // For secret variables: if the client sends MASKED back, keep existing encrypted value
  if (req.body.variables) {
    const existing = scenarios[idx].variables || [];
    updated.variables = encryptVariables(req.body.variables.map(v => {
      if (v.type === 'secret' && v.defaultValue === MASKED) {
        const prev = existing.find(e => e.id === v.id || e.name === v.name);
        return { ...v, defaultValue: prev ? prev.defaultValue : '' };
      }
      return v;
    }));
  }
  scenarios[idx] = updated;
  writeJSON(SCENARIOS_FILE, scenarios);
  res.json({ data: { ...updated, variables: maskVariables(updated.variables) } });
});

app.delete('/api/scenarios/:id', requireAuth, (req, res) => {
  const scenarios = readJSON(SCENARIOS_FILE);
  const target = scenarios.find(s => s.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Scenario not found' });
  if (denyProject(res, target.projectId, req.user)) return;
  const filtered = scenarios.filter(s => s.id !== req.params.id);
  writeJSON(SCENARIOS_FILE, filtered);
  const suites = readJSON(SUITES_FILE);
  suites.forEach(suite => {
    suite.scenarioIds = (suite.scenarioIds || []).filter(id => id !== req.params.id);
  });
  writeJSON(SUITES_FILE, suites);
  res.json({ data: { success: true } });
});

app.post('/api/scenarios/:id/clone', requireAuth, (req, res) => {
  const scenarios = readJSON(SCENARIOS_FILE);
  const original = scenarios.find(s => s.id === req.params.id);
  if (!original) return res.status(404).json({ error: 'Scenario not found' });
  if (denyProject(res, original.projectId, req.user)) return;
  const now = new Date().toISOString();
  const cloned = {
    ...JSON.parse(JSON.stringify(original)),
    id: randomUUID(),
    name: original.name + ' (Copy)',
    createdAt: now,
    updatedAt: now,
    steps: original.steps.map(s => ({ ...s, id: 'step_' + Date.now() + '_' + Math.random().toString(36).slice(2) }))
  };
  scenarios.push(cloned);
  writeJSON(SCENARIOS_FILE, scenarios);
  res.json(cloned);
});

// ─── SUITES ───────────────────────────────────────────────────────────────────

app.get('/api/suites', requireAuth, (req, res) => {
  let suites = readJSON(SUITES_FILE);
  const projects = readJSON(PROJECTS_FILE);
  const accessibleIds = new Set(projects.filter(p => canAccessProject(p, req.user)).map(p => p.id));
  suites = suites.filter(s => !s.projectId || accessibleIds.has(s.projectId));
  if (req.query.projectId) suites = suites.filter(s => s.projectId === req.query.projectId);
  res.json({ data: suites });
});

app.post('/api/suites', requireAuth, (req, res) => {
  if (!canUseProjectId(req.body.projectId, req.user)) return res.status(403).json({ error: 'Access denied' });
  const suites = readJSON(SUITES_FILE);
  const now = new Date().toISOString();
  const suite = {
    id: randomUUID(),
    projectId: req.body.projectId || null,
    name: req.body.name || 'Unnamed Suite',
    description: req.body.description || '',
    scenarioIds: req.body.scenarioIds || [],
    createdAt: now,
    updatedAt: now
  };
  suites.push(suite);
  writeJSON(SUITES_FILE, suites);
  res.status(201).json({ data: suite });
});

app.get('/api/suites/:id', requireAuth, (req, res) => {
  const suites = readJSON(SUITES_FILE);
  const suite = suites.find(s => s.id === req.params.id);
  if (!suite) return res.status(404).json({ error: 'Suite not found' });
  if (denyProject(res, suite.projectId, req.user)) return;
  res.json({ data: suite });
});

app.put('/api/suites/:id', requireAuth, (req, res) => {
  const suites = readJSON(SUITES_FILE);
  const idx = suites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Suite not found' });
  if (denyProject(res, suites[idx].projectId, req.user) || denyProject(res, req.body.projectId, req.user)) return;
  suites[idx] = { ...suites[idx], ...req.body, id: suites[idx].id, updatedAt: new Date().toISOString() };
  writeJSON(SUITES_FILE, suites);
  res.json({ data: suites[idx] });
});

app.delete('/api/suites/:id', requireAuth, (req, res) => {
  const suites = readJSON(SUITES_FILE);
  const target = suites.find(s => s.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Suite not found' });
  if (denyProject(res, target.projectId, req.user)) return;
  const filtered = suites.filter(s => s.id !== req.params.id);
  writeJSON(SUITES_FILE, filtered);
  res.json({ data: { success: true } });
});

app.patch('/api/suites/:id/scenarios', requireAuth, (req, res) => {
  const suites = readJSON(SUITES_FILE);
  const idx = suites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Suite not found' });
  const suite = suites[idx];
  if (denyProject(res, suite.projectId, req.user)) return;
  const ids = new Set(suite.scenarioIds || []);
  const usable = new Set(filterByProjectAccess(readJSON(SCENARIOS_FILE), req.user).map(sc => sc.id));
  (req.body.add || []).filter(id => usable.has(id)).forEach(id => ids.add(id));
  (req.body.remove || []).forEach(id => ids.delete(id));
  suite.scenarioIds = Array.from(ids);
  suite.updatedAt = new Date().toISOString();
  writeJSON(SUITES_FILE, suites);
  res.json({ data: suite });
});

// ─── ACTIONS ──────────────────────────────────────────────────────────────────

app.get('/api/actions', requireAuth, (req, res) => {
  let actions = filterByProjectAccess(readJSON(ACTIONS_FILE), req.user);
  if (req.query.projectId) actions = actions.filter(a => a.projectId === req.query.projectId);
  res.json({ data: actions });
});

app.post('/api/actions', requireAuth, (req, res) => {
  if (!canUseProjectId(req.body.projectId, req.user)) return res.status(403).json({ error: 'Access denied' });
  const actions = readJSON(ACTIONS_FILE);
  const now = new Date().toISOString();
  const action = {
    id: randomUUID(),
    name: req.body.name || 'Unnamed Action',
    description: req.body.description || '',
    projectId: req.body.projectId || null,
    steps: req.body.steps || [],
    createdAt: now,
    updatedAt: now
  };
  actions.push(action);
  writeJSON(ACTIONS_FILE, actions);
  res.status(201).json({ data: action });
});

app.get('/api/actions/:id', requireAuth, (req, res) => {
  const actions = readJSON(ACTIONS_FILE);
  const action = actions.find(a => a.id === req.params.id);
  if (!action) return res.status(404).json({ error: 'Action not found' });
  if (denyProject(res, action.projectId, req.user)) return;
  res.json({ data: action });
});

app.put('/api/actions/:id', requireAuth, (req, res) => {
  const actions = readJSON(ACTIONS_FILE);
  const idx = actions.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Action not found' });
  if (denyProject(res, actions[idx].projectId, req.user) || denyProject(res, req.body.projectId, req.user)) return;
  actions[idx] = { ...actions[idx], ...req.body, id: actions[idx].id, updatedAt: new Date().toISOString() };
  writeJSON(ACTIONS_FILE, actions);
  res.json({ data: actions[idx] });
});

app.delete('/api/actions/:id', requireAuth, (req, res) => {
  const actions = readJSON(ACTIONS_FILE);
  const target = actions.find(a => a.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Action not found' });
  if (denyProject(res, target.projectId, req.user)) return;
  const filtered = actions.filter(a => a.id !== req.params.id);
  writeJSON(ACTIONS_FILE, filtered);
  // Check if any scenarios reference this action (for warning info)
  const scenarios = readJSON(SCENARIOS_FILE);
  const referencingScenarios = scenarios.filter(s =>
    (s.steps || []).some(step => step.type === 'useAction' && step.params && step.params.actionId === req.params.id)
  );
  res.json({ data: { success: true, referencedByScenarios: referencingScenarios.map(s => s.name) } });
});

// ─── RUNS ─────────────────────────────────────────────────────────────────────

app.get('/api/runs', requireAuth, (req, res) => {
  let runs = readRunsSummary();
  const projects = readJSON(PROJECTS_FILE);
  const accessibleIds = new Set(projects.filter(p => canAccessProject(p, req.user)).map(p => p.id));
  runs = runs.filter(r => !r.projectId || accessibleIds.has(r.projectId));
  if (req.query.projectId) runs = runs.filter(r => r.projectId === req.query.projectId);
  runs.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const limit = parseInt(req.query.limit) || 50;
  res.json({ data: runs.slice(0, limit) });
});

app.post('/api/runs/bulk-delete', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
  const runs = readRunsSummary();
  const accessibleIds = new Set(filterByProjectAccess(runs, req.user).map(r => r.id));
  const idSet = new Set(ids.filter(id => accessibleIds.has(id)));
  const filtered = runs.filter(r => !idSet.has(r.id));
  writeRunsSummary(filtered);
  for (const id of idSet) {
    try { fs.unlinkSync(path.join(RUNS_DIR, id + '.json')); } catch {}
  }
  res.json({ data: { deleted: runs.length - filtered.length } });
});

app.get('/api/runs/:id', requireAuth, (req, res) => {
  const run = readRunFile(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (denyProject(res, run.projectId, req.user)) return;
  res.json({ data: run });
});

// Re-creates the exact page state a failed step saw (by replaying the current scenario
// definition up to that step against the same browser/device/environment the run used),
// then inspects the selector live and asks Claude to explain the failure and suggest a
// fix — the same investigation a person would do by hand, available to anyone with the
// report open rather than requiring a Claude Code session.
app.post('/api/runs/:id/steps/:stepIndex/diagnose', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json({ error: 'API key not configured', needsKey: true });

  const run = readRunFile(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (denyProject(res, run.projectId, req.user)) return;
  if (run.type !== 'scenario') return res.status(400).json({ error: 'Diagnose currently only supports single-scenario runs, not suite runs.' });

  const stepIndex = parseInt(req.params.stepIndex);
  const scenarioResult = run.scenarioResults && run.scenarioResults[0];
  const failedStepResult = scenarioResult && scenarioResult.steps[stepIndex];
  if (!failedStepResult) return res.status(404).json({ error: 'Step not found in this run.' });

  const scenarios = readJSON(SCENARIOS_FILE);
  const scenario = scenarios.find(s => s.id === run.scenarioId);
  if (!scenario) return res.status(404).json({ error: 'The scenario this run belongs to no longer exists.' });
  const stepDef = scenario.steps.find(s => s.id === failedStepResult.stepId);
  if (!stepDef) return res.status(400).json({ error: 'This step no longer exists in the scenario — it may have been edited or removed since this run.' });

  let envHttpCreds = null;
  if (run.environmentId) {
    const envs = readJSON(ENVIRONMENTS_FILE);
    const env = envs.find(e => e.id === run.environmentId);
    if (env && env.httpUsername && env.httpPassword) {
      envHttpCreds = { username: env.httpUsername, password: decrypt(env.httpPassword) };
    }
  }
  const scenarioToRun = run.environmentBaseUrl ? { ...scenario, _envBaseUrl: run.environmentBaseUrl } : scenario;

  let replay;
  try {
    replay = await executeScenario(scenarioToRun, run.browser, run.viewport, () => {}, 0, envHttpCreds, null, { stopAtIndex: stepIndex, keepOpen: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to set up the page for diagnosis: ' + (err.message || 'Unknown error') });
  }

  // If replay itself can't even get this far, that IS the diagnosis — no point asking an
  // LLM to explain a failure three steps downstream of a now-broken earlier step.
  const brokenEarlier = replay.steps.find(s => s.status === 'failed');
  if (brokenEarlier) {
    await replay.browserInstance.close().catch(() => {});
    const brokenIndex = replay.steps.indexOf(brokenEarlier);
    return res.json({ data: {
      explanation: `Can't reach this step to diagnose it — step ${brokenIndex + 1} ("${brokenEarlier.description}") now fails before getting there: ${brokenEarlier.message}`,
      hasSuggestion: false
    } });
  }

  const page = replay.page;
  try {
    const vars = {};
    for (const v of (scenario.variables || [])) vars[v.name] = v.type === 'secret' ? decrypt(v.defaultValue || '') : (v.defaultValue || '');
    if (run.environmentBaseUrl) vars.baseUrl = run.environmentBaseUrl;
    const resolvedParams = resolveStepParams(stepDef.params || {}, vars);

    const selectorFacts = await diagnoseSelector(page, resolvedParams);
    const snapshot = await snapshotInteractiveElements(page).catch(() => ({ url: page.url(), title: '', elements: [] }));

    const prompt = `A regression test step failed. Diagnose why and, if you can, suggest a concrete fix.

Step type: ${stepDef.type}
Step params: ${JSON.stringify(resolvedParams)}
Original failure message: ${failedStepResult.message}

Live facts about this selector right now:
${selectorFacts ? JSON.stringify(selectorFacts) : '(this step type has no selector to check)'}

Current page: ${snapshot.url}
Title: ${snapshot.title}
Other interactive elements currently on the page (use these if suggesting a different selector):
${JSON.stringify(snapshot.elements)}`;

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 30000);
    let resp;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: 'You are a QA automation expert explaining why a test step failed, using only the live, grounded facts you are given — never speculate beyond them. If the selector is wrong, stale, or ambiguous and you can see a better one in the current interactive-elements list, suggest it concretely; otherwise say so plainly rather than guessing.',
          tools: [DIAGNOSIS_TOOL],
          tool_choice: { type: 'tool', name: 'diagnosis' },
          messages: [{ role: 'user', content: prompt }]
        })
      });
    } finally {
      clearTimeout(abortTimer);
    }

    if (!resp.ok) return res.status(500).json({ error: `AI service error (status ${resp.status})` });
    const data = await resp.json();
    const toolUse = (data.content || []).find(b => b.type === 'tool_use');
    if (!toolUse) return res.status(500).json({ error: 'Diagnosis failed — the AI did not return a structured result.' });

    res.json({ data: toolUse.input });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await replay.browserInstance.close().catch(() => {});
  }
});

// ─── RUN EVENT STORE (polling model) ─────────────────────────────────────────
// Each active run gets an array of events stored in memory.
// Clients poll GET /api/runs/:id/events?since=N for new events.
const runEventStore = new Map(); // runId → { events: [], done: bool }

function runStoreAppend(runId, event) {
  const store = runEventStore.get(runId);
  if (store) store.events.push(event);
}

function runStoreFinish(runId) {
  const store = runEventStore.get(runId);
  if (store) {
    store.done = true;
    // Clean up after 5 minutes
    setTimeout(() => runEventStore.delete(runId), 300000);
  }
}

app.get('/api/runs/:id/events', requireAuth, (req, res) => {
  if (denyRun(res, req.params.id, req.user)) return;
  const store = runEventStore.get(req.params.id);
  if (!store) {
    // Run not in memory (already done or unknown) — return empty done signal
    return res.json({ events: [], done: true });
  }
  const since = parseInt(req.query.since) || 0;
  res.json({ events: store.events.slice(since), total: store.events.length, done: store.done });
});

// ─── SCENARIO RUN ─────────────────────────────────────────────────────────────

app.post('/api/runs/scenario/:scenarioId', requireAuth, async (req, res) => {
  const scenarios = readJSON(SCENARIOS_FILE);
  const scenario = scenarios.find(s => s.id === req.params.scenarioId);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
  if (denyProject(res, scenario.projectId, req.user)) return;

  const browserName = req.body.browser || 'chromium';
  const deviceKey = req.body.device || 'desktop-1920';
  let viewport = DEVICES[deviceKey] ? { width: DEVICES[deviceKey].width, height: DEVICES[deviceKey].height } : { width: 1920, height: 1080 };
  if (deviceKey === 'custom' && req.body.customViewport) viewport = req.body.customViewport;

  let envBaseUrl = null, envName = null, envId = req.body.environmentId || null, envHttpCreds = null;
  if (envId) {
    const envs = readJSON(ENVIRONMENTS_FILE);
    const env = envs.find(e => e.id === envId && canUseProjectId(e.projectId, req.user));
    if (env) {
      envBaseUrl = env.baseUrl; envName = env.name;
      if (env.httpUsername && env.httpPassword) {
        envHttpCreds = { username: env.httpUsername, password: decrypt(env.httpPassword) };
      }
    }
  }
  if (!envBaseUrl && scenario.projectId) {
    const projects = readJSON(PROJECTS_FILE);
    const proj = projects.find(p => p.id === scenario.projectId);
    if (proj && proj.baseUrl) envBaseUrl = proj.baseUrl;
  }
  const scenarioToRun = envBaseUrl ? { ...scenario, _envBaseUrl: envBaseUrl } : scenario;

  const runId = randomUUID();
  const now = new Date().toISOString();
  const scenarioSummaries = readRunsSummary();
  const run = {
    id: runId,
    jobNumber: scenarioSummaries.length + 1,
    type: 'scenario',
    scenarioId: scenario.id,
    suiteId: null,
    projectId: scenario.projectId,
    name: scenario.name,
    browser: browserName,
    device: deviceKey,
    viewport,
    status: 'running',
    startedAt: now,
    completedAt: null,
    duration: null,
    scenarioResults: [],
    summary: { total: 1, passed: 0, failed: 0, passRate: 0 },
    environmentId: envId,
    environmentName: envName,
    environmentBaseUrl: envBaseUrl
  };

  scenarioSummaries.push(toRunSummary(run));
  writeRunsSummary(scenarioSummaries);
  saveRunFile(run);

  // Set up event store for polling, then return runId immediately
  runEventStore.set(runId, { events: [], done: false });
  const send = (data) => runStoreAppend(runId, data);
  send({ type: 'run_start', runId, name: scenario.name });

  res.json({ data: { runId } });

  // Execute in background
  const startTime = Date.now();
  (async () => {
    try {
      const result = await executeScenario(scenarioToRun, browserName, viewport, send, 0, envHttpCreds, runId);
      run.scenarioResults.push(result);
      run.status = result.status === 'passed' ? 'passed' : 'failed';
      const passed = result.status === 'passed' ? 1 : 0;
      run.summary = { total: 1, passed, failed: 1 - passed, passRate: passed * 100 };
    } catch (err) {
      run.status = 'error';
      run.summary = { total: 1, passed: 0, failed: 1, passRate: 0 };
      send({ type: 'error', message: 'Execution error: ' + (err.message || 'Unknown error') });
    }
    run.completedAt = new Date().toISOString();
    run.duration = Date.now() - startTime;
    saveRunFile(run);
    const srs = readRunsSummary();
    const idx = srs.findIndex(r => r.id === runId);
    if (idx !== -1) srs[idx] = toRunSummary(run);
    writeRunsSummary(srs);
    send({ type: 'done', runId, status: run.status });
    runStoreFinish(runId);
  })();
});

// ─── SUITE RUN (SSE) ──────────────────────────────────────────────────────────

app.post('/api/runs/suite/:suiteId', requireAuth, async (req, res) => {
  const suites = readJSON(SUITES_FILE);
  const suite = suites.find(s => s.id === req.params.suiteId);
  if (!suite) return res.status(404).json({ error: 'Suite not found' });
  if (denyProject(res, suite.projectId, req.user)) return;

  const allScenarios = readJSON(SCENARIOS_FILE);
  const filterIds = Array.isArray(req.body.scenarioIds) && req.body.scenarioIds.length > 0 ? req.body.scenarioIds : null;
  const scenariosToRun = (suite.scenarioIds || [])
    .filter(id => !filterIds || filterIds.includes(id))
    .map(id => allScenarios.find(s => s.id === id))
    .filter(Boolean);

  const browserName = req.body.browser || 'chromium';
  const deviceKey = req.body.device || 'desktop-1920';
  let viewport = DEVICES[deviceKey] ? { width: DEVICES[deviceKey].width, height: DEVICES[deviceKey].height } : { width: 1920, height: 1080 };
  if (deviceKey === 'custom' && req.body.customViewport) viewport = req.body.customViewport;

  // Resolve environment for suite runs
  let suiteEnvBaseUrl = null, suiteEnvName = null, suiteEnvId = req.body.environmentId || null, suiteEnvHttpCreds = null;
  if (suiteEnvId) {
    const envs = readJSON(ENVIRONMENTS_FILE);
    const env = envs.find(e => e.id === suiteEnvId && canUseProjectId(e.projectId, req.user));
    if (env) {
      suiteEnvBaseUrl = env.baseUrl; suiteEnvName = env.name;
      if (env.httpUsername && env.httpPassword) {
        suiteEnvHttpCreds = { username: env.httpUsername, password: decrypt(env.httpPassword) };
      }
    }
  }
  if (!suiteEnvBaseUrl && suite.projectId) {
    const projects = readJSON(PROJECTS_FILE);
    const proj = projects.find(p => p.id === suite.projectId);
    if (proj && proj.baseUrl) suiteEnvBaseUrl = proj.baseUrl;
  }

  const runId = randomUUID();
  const now = new Date().toISOString();
  const suiteSummaries = readRunsSummary();
  const parentRunId = req.body.parentRunId || null;
  const run = {
    id: runId,
    jobNumber: suiteSummaries.length + 1,
    type: 'suite',
    scenarioId: null,
    suiteId: suite.id,
    projectId: suite.projectId,
    name: filterIds ? `${suite.name} (Failed Tests)` : suite.name,
    browser: browserName,
    device: deviceKey,
    viewport,
    status: 'running',
    startedAt: now,
    completedAt: null,
    duration: null,
    scenarioResults: [],
    summary: { total: scenariosToRun.length, passed: 0, failed: 0, passRate: 0 },
    environmentId: suiteEnvId,
    environmentName: suiteEnvName,
    environmentBaseUrl: suiteEnvBaseUrl,
    parentRunId
  };

  suiteSummaries.push(toRunSummary(run));
  writeRunsSummary(suiteSummaries);
  saveRunFile(run);

  runEventStore.set(runId, { events: [], done: false });
  const send = (data) => runStoreAppend(runId, data);
  send({ type: 'run_start', runId, name: suite.name, total: scenariosToRun.length });

  res.json({ data: { runId } });

  // Execute in background
  (async () => {
    const startTime = Date.now();
    let passed = 0;
    let failed = 0;

    for (let i = 0; i < scenariosToRun.length; i++) {
      const scenario = scenariosToRun[i];
      const scenarioToRunInSuite = suiteEnvBaseUrl ? { ...scenario, _envBaseUrl: suiteEnvBaseUrl } : scenario;
      send({ type: 'scenario_start', scenarioIndex: i, scenarioId: scenario.id, scenarioName: scenario.name });
      try {
        const result = await executeScenario(scenarioToRunInSuite, browserName, viewport, send, i, suiteEnvHttpCreds, runId);
        run.scenarioResults.push(result);
        if (result.status === 'passed') passed++; else failed++;
      } catch (err) {
        failed++;
        run.scenarioResults.push({ scenarioId: scenario.id, scenarioName: scenario.name, status: 'error', duration: 0, steps: [] });
        send({ type: 'scenario_error', scenarioIndex: i, message: err.message });
      }
    }

    run.status = failed === 0 ? 'passed' : 'failed';
    run.completedAt = new Date().toISOString();
    run.duration = Date.now() - startTime;
    run.summary = {
      total: scenariosToRun.length, passed, failed,
      passRate: scenariosToRun.length > 0 ? Math.round((passed / scenariosToRun.length) * 100) : 0
    };

    saveRunFile(run);
    const suiteRunSummaries = readRunsSummary();
    const idx = suiteRunSummaries.findIndex(r => r.id === runId);
    if (idx !== -1) suiteRunSummaries[idx] = toRunSummary(run);

    if (parentRunId) {
      const parent = readRunFile(parentRunId);
      if (parent) {
        for (const result of run.scenarioResults) {
          if (result.status === 'passed') {
            const si = parent.scenarioResults.findIndex(sr => sr.scenarioId === result.scenarioId);
            if (si !== -1) parent.scenarioResults[si] = { ...result, rerunId: runId };
            else parent.scenarioResults.push({ ...result, rerunId: runId });
          }
        }
        const parentPassed = parent.scenarioResults.filter(sr => sr.status === 'passed').length;
        const parentTotal = parent.scenarioResults.length;
        const parentFailed = parentTotal - parentPassed;
        parent.status = parentFailed === 0 ? 'passed' : 'failed';
        parent.summary = { total: parentTotal, passed: parentPassed, failed: parentFailed, passRate: parentTotal > 0 ? Math.round((parentPassed / parentTotal) * 100) : 0 };
        saveRunFile(parent);
        const pi = suiteRunSummaries.findIndex(r => r.id === parentRunId);
        if (pi !== -1) suiteRunSummaries[pi] = toRunSummary(parent);
      }
    }

    writeRunsSummary(suiteRunSummaries);

    const suiteNotifyRecipients = (req.body.notifyEmails || '').split(',').map(e => e.trim()).filter(Boolean);
    if (suiteNotifyRecipients.length > 0) {
      try {
        const reportUrl = `${process.env.APP_URL || 'http://localhost:3000'}/report/${runId}`;
        await sendRunEmail(run, suiteNotifyRecipients, { reportUrl });
      } catch (emailErr) {
        console.error('Suite notify email failed:', emailErr.message);
      }
    }

    send({ type: 'done', runId, status: run.status, passed, failed });
    runStoreFinish(runId);
  })();
});

// ─── SCHEDULES ────────────────────────────────────────────────────────────────

app.get('/api/schedules', requireAuth, (req, res) => {
  let schedules = filterByProjectAccess(readJSON(SCHEDULES_FILE), req.user);
  if (req.query.projectId) schedules = schedules.filter(s => s.projectId === req.query.projectId);
  schedules.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ data: schedules });
});

app.post('/api/schedules', requireAuth, (req, res) => {
  if (!canUseProjectId(req.body.projectId, req.user)) return res.status(403).json({ error: 'Access denied' });
  const { name, projectId, targetType, targetId, browser, device, customViewport,
          frequency, hour, dayOfWeek, cronExpression, timezone, enabled, notifyEmails } = req.body;
  if (!name) return res.status(400).json({ error: 'Schedule name is required' });
  if (!targetType || !targetId) return res.status(400).json({ error: 'Target type and target ID are required' });

  // Look up target name
  let targetName = '';
  if (targetType === 'scenario') {
    const s = readJSON(SCENARIOS_FILE).find(s => s.id === targetId);
    targetName = s ? s.name : '';
  } else if (targetType === 'suite') {
    const s = readJSON(SUITES_FILE).find(s => s.id === targetId);
    targetName = s ? s.name : '';
  }

  const expr = buildCronExpression(frequency, hour, dayOfWeek, cronExpression);
  if (!cron.validate(expr)) return res.status(400).json({ error: 'Invalid cron expression' });

  const now = new Date().toISOString();
  const schedule = {
    id: randomUUID(),
    name,
    projectId: projectId || null,
    targetType,
    targetId,
    targetName,
    browser: browser || 'chromium',
    device: device || 'desktop-1920',
    customViewport: customViewport || null,
    frequency: frequency || 'daily',
    hour: hour !== undefined ? parseInt(hour) : 0,
    dayOfWeek: dayOfWeek !== undefined ? parseInt(dayOfWeek) : 0,
    cronExpression: expr,
    timezone: timezone || 'UTC',
    enabled: enabled !== false,
    notifyEmails: notifyEmails || '',
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunId: null,
    nextRunAt: null
  };

  const schedules = readJSON(SCHEDULES_FILE);
  schedules.push(schedule);
  writeJSON(SCHEDULES_FILE, schedules);

  if (schedule.enabled) startCronJob(schedule);

  res.status(201).json({ data: schedule });
});

app.get('/api/schedules/:id', requireAuth, (req, res) => {
  const schedules = readJSON(SCHEDULES_FILE);
  const schedule = schedules.find(s => s.id === req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (denyProject(res, schedule.projectId, req.user)) return;
  res.json({ data: schedule });
});

app.put('/api/schedules/:id', requireAuth, (req, res) => {
  const schedules = readJSON(SCHEDULES_FILE);
  const idx = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });
  if (denyProject(res, schedules[idx].projectId, req.user) || denyProject(res, req.body.projectId, req.user)) return;

  const { name, projectId, targetType, targetId, browser, device, customViewport,
          frequency, hour, dayOfWeek, cronExpression, timezone, enabled, notifyEmails } = req.body;

  const existing = schedules[idx];

  let targetName = existing.targetName;
  if (targetId && targetId !== existing.targetId) {
    if (targetType === 'scenario') {
      const s = readJSON(SCENARIOS_FILE).find(s => s.id === targetId);
      targetName = s ? s.name : '';
    } else if (targetType === 'suite') {
      const s = readJSON(SUITES_FILE).find(s => s.id === targetId);
      targetName = s ? s.name : '';
    }
  }

  const expr = buildCronExpression(
    frequency || existing.frequency,
    hour !== undefined ? hour : existing.hour,
    dayOfWeek !== undefined ? dayOfWeek : existing.dayOfWeek,
    cronExpression || existing.cronExpression
  );
  if (!cron.validate(expr)) return res.status(400).json({ error: 'Invalid cron expression' });

  const updated = {
    ...existing,
    name:           name           !== undefined ? name           : existing.name,
    projectId:      projectId      !== undefined ? projectId      : existing.projectId,
    targetType:     targetType     !== undefined ? targetType     : existing.targetType,
    targetId:       targetId       !== undefined ? targetId       : existing.targetId,
    targetName,
    browser:        browser        !== undefined ? browser        : existing.browser,
    device:         device         !== undefined ? device         : existing.device,
    customViewport: customViewport !== undefined ? customViewport : existing.customViewport,
    frequency:      frequency      !== undefined ? frequency      : existing.frequency,
    hour:           hour           !== undefined ? parseInt(hour) : existing.hour,
    dayOfWeek:      dayOfWeek      !== undefined ? parseInt(dayOfWeek) : existing.dayOfWeek,
    cronExpression: expr,
    timezone:       timezone       !== undefined ? timezone       : existing.timezone,
    enabled:        enabled        !== undefined ? enabled        : existing.enabled,
    notifyEmails:   notifyEmails   !== undefined ? notifyEmails   : existing.notifyEmails,
    updatedAt: new Date().toISOString()
  };

  schedules[idx] = updated;
  writeJSON(SCHEDULES_FILE, schedules);

  // Restart cron job if expression or enabled changed
  if (updated.enabled) {
    startCronJob(updated);
  } else {
    stopCronJob(updated.id);
  }

  res.json({ data: updated });
});

app.patch('/api/schedules/:id/toggle', requireAuth, (req, res) => {
  const schedules = readJSON(SCHEDULES_FILE);
  const idx = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });
  if (denyProject(res, schedules[idx].projectId, req.user)) return;

  const schedule = schedules[idx];
  schedule.enabled = !schedule.enabled;
  schedule.updatedAt = new Date().toISOString();
  writeJSON(SCHEDULES_FILE, schedules);

  if (schedule.enabled) {
    startCronJob(schedule);
  } else {
    stopCronJob(schedule.id);
  }

  res.json({ data: schedule });
});

app.delete('/api/schedules/:id', requireAuth, (req, res) => {
  const schedules = readJSON(SCHEDULES_FILE);
  const idx = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });
  if (denyProject(res, schedules[idx].projectId, req.user)) return;
  stopCronJob(req.params.id);
  schedules.splice(idx, 1);
  writeJSON(SCHEDULES_FILE, schedules);
  res.json({ data: { success: true } });
});

app.post('/api/schedules/:id/run-now', requireAuth, async (req, res) => {
  const schedules = readJSON(SCHEDULES_FILE);
  const schedule = schedules.find(s => s.id === req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (denyProject(res, schedule.projectId, req.user)) return;
  // Fire and forget — run asynchronously
  runScheduledJob(schedule.id).catch(err => console.error('run-now error:', err.message));
  res.json({ data: { message: 'Run started' } });
});

// ─── ENVIRONMENTS ─────────────────────────────────────────────────────────────

// Helper: strip encrypted password from env before sending to client
function sanitizeEnv(env) {
  return {
    ...env,
    httpPassword: env.httpPassword ? MASKED : '',
    httpPasswordSet: !!(env.httpPassword)
  };
}

app.get('/api/environments', requireAuth, (req, res) => {
  let envs = filterByProjectAccess(readJSON(ENVIRONMENTS_FILE), req.user);
  if (req.query.projectId) envs = envs.filter(e => e.projectId === req.query.projectId);
  res.json({ data: envs.map(sanitizeEnv) });
});

app.post('/api/environments', requireAuth, (req, res) => {
  if (!canUseProjectId(req.body.projectId, req.user)) return res.status(403).json({ error: 'Access denied' });
  const { projectId, name, baseUrl, isDefault, httpUsername, httpPassword } = req.body;
  if (!name) return res.status(400).json({ error: 'Environment name is required' });
  const envs = readJSON(ENVIRONMENTS_FILE);
  const now = new Date().toISOString();
  if (isDefault) envs.forEach(e => { if (e.projectId === (projectId || null)) e.isDefault = false; });
  const env = {
    id: randomUUID(), projectId: projectId || null, name,
    baseUrl: baseUrl || '', isDefault: !!isDefault,
    httpUsername: httpUsername || '',
    httpPassword: httpPassword ? encrypt(httpPassword) : '',
    createdAt: now
  };
  envs.push(env);
  writeJSON(ENVIRONMENTS_FILE, envs);
  res.status(201).json({ data: sanitizeEnv(env) });
});

app.put('/api/environments/:id', requireAuth, (req, res) => {
  const envs = readJSON(ENVIRONMENTS_FILE);
  const idx = envs.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Environment not found' });
  if (denyProject(res, envs[idx].projectId, req.user)) return;
  const { name, baseUrl, isDefault, httpUsername, httpPassword, clearHttpPassword } = req.body;
  if (isDefault) envs.forEach(e => { if (e.projectId === envs[idx].projectId) e.isDefault = false; });
  const updated = { ...envs[idx] };
  if (name !== undefined) updated.name = name;
  if (baseUrl !== undefined) updated.baseUrl = baseUrl;
  if (isDefault !== undefined) updated.isDefault = !!isDefault;
  if (httpUsername !== undefined) updated.httpUsername = httpUsername;
  if (clearHttpPassword) updated.httpPassword = '';
  else if (httpPassword && httpPassword !== MASKED) updated.httpPassword = encrypt(httpPassword);
  envs[idx] = updated;
  writeJSON(ENVIRONMENTS_FILE, envs);
  res.json({ data: sanitizeEnv(updated) });
});

app.delete('/api/environments/:id', requireAuth, (req, res) => {
  const envs = readJSON(ENVIRONMENTS_FILE);
  const target = envs.find(e => e.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Environment not found' });
  if (denyProject(res, target.projectId, req.user)) return;
  const filtered = envs.filter(e => e.id !== req.params.id);
  writeJSON(ENVIRONMENTS_FILE, filtered);
  res.json({ data: { success: true } });
});

// ─── BASELINES ────────────────────────────────────────────────────────────────

app.delete('/api/baselines', requireAuth, (req, res) => {
  const { projectId, name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (denyProject(res, projectId, req.user)) return;
  const dir = path.join(BASELINES_DIR, projectId || 'default');
  const file = path.join(dir, `${name}.png`);
  try { fs.unlinkSync(file); } catch {}
  res.json({ data: { success: true } });
});

// ─── DATA-DRIVEN RUN (CSV) ────────────────────────────────────────────────────

app.post('/api/scenarios/:id/run-csv', requireAuth, async (req, res) => {
  const scenarios = readJSON(SCENARIOS_FILE);
  const scenario = scenarios.find(s => s.id === req.params.id);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
  if (denyProject(res, scenario.projectId, req.user)) return;

  const { browser: browserName = 'chromium', device: deviceKey = 'desktop-1920', csvText, environmentId } = req.body;
  if (!csvText) return res.status(400).json({ error: 'csvText is required' });

  let viewport = DEVICES[deviceKey] ? { width: DEVICES[deviceKey].width, height: DEVICES[deviceKey].height } : { width: 1920, height: 1080 };

  // Parse CSV
  const lines = csvText.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
    return obj;
  });

  // Resolve environment
  let envBaseUrl = null;
  let envName = null;
  if (environmentId) {
    const envs = readJSON(ENVIRONMENTS_FILE);
    const env = envs.find(e => e.id === environmentId && canUseProjectId(e.projectId, req.user));
    if (env) { envBaseUrl = env.baseUrl; envName = env.name; }
  }

  setupSSE(res);
  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); if (res.flush) res.flush(); } catch {} };

  const runId = randomUUID();
  const now = new Date().toISOString();
  const csvSummaries = readRunsSummary();
  const run = {
    id: runId,
    jobNumber: csvSummaries.length + 1,
    type: 'data-driven',
    scenarioId: scenario.id,
    projectId: scenario.projectId,
    name: scenario.name,
    browser: browserName,
    device: deviceKey,
    viewport,
    status: 'running',
    startedAt: now,
    completedAt: null,
    duration: null,
    environmentId: environmentId || null,
    environmentName: envName,
    environmentBaseUrl: envBaseUrl,
    rows: [],
    summary: { total: rows.length, passed: 0, failed: 0, passRate: 0 }
  };

  csvSummaries.push(toRunSummary(run));
  writeRunsSummary(csvSummaries);
  saveRunFile(run);

  send({ type: 'run_start', runId, name: scenario.name, totalRows: rows.length });

  const startTime = Date.now();
  let passed = 0, failed = 0;

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const rowVars = rows[rowIdx];
    if (envBaseUrl) rowVars.baseUrl = envBaseUrl;
    send({ type: 'row_start', rowIndex: rowIdx, variables: rowVars });

    // Temporarily override scenario variables with CSV row values
    const scenarioWithVars = { ...scenario, variables: Object.entries(rowVars).map(([name, defaultValue]) => ({ id: 'csv_' + name, name, defaultValue })) };

    try {
      const result = await executeScenario(scenarioWithVars, browserName, viewport, (evt) => {
        send({ ...evt, rowIndex: rowIdx });
      }, rowIdx, undefined, runId);
      run.rows.push({ rowIndex: rowIdx, variables: rowVars, status: result.status, duration: result.duration, steps: result.steps });
      if (result.status === 'passed') passed++; else failed++;
      send({ type: 'row_complete', rowIndex: rowIdx, status: result.status, duration: result.duration });
    } catch (err) {
      failed++;
      run.rows.push({ rowIndex: rowIdx, variables: rowVars, status: 'error', duration: 0, steps: [] });
      send({ type: 'row_complete', rowIndex: rowIdx, status: 'error', message: err.message });
    }
  }

  run.status = failed === 0 ? 'passed' : 'failed';
  run.completedAt = new Date().toISOString();
  run.duration = Date.now() - startTime;
  run.summary = { total: rows.length, passed, failed, passRate: rows.length > 0 ? Math.round((passed / rows.length) * 100) : 0 };

  saveRunFile(run);
  const csvRunSummaries = readRunsSummary();
  const ri = csvRunSummaries.findIndex(r => r.id === runId);
  if (ri !== -1) csvRunSummaries[ri] = toRunSummary(run);
  writeRunsSummary(csvRunSummaries);

  send({ type: 'done', runId, status: run.status, passed, failed });
  res.end();
});

// ─── REPORT ───────────────────────────────────────────────────────────────────

app.delete('/api/runs/:id', requireAuth, (req, res) => {
  if (denyRun(res, req.params.id, req.user)) return;
  const runs = readRunsSummary();
  const filtered = runs.filter(r => r.id !== req.params.id);
  if (filtered.length === runs.length) return res.status(404).json({ error: 'Run not found' });
  writeRunsSummary(filtered);
  try { fs.unlinkSync(path.join(RUNS_DIR, req.params.id + '.json')); } catch {}
  res.json({ data: { success: true } });
});

app.get('/screenshots/:runId/:file', (req, res) => {
  const file = path.join(SCREENSHOTS_DIR, req.params.runId, path.basename(req.params.file));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(file);
});

app.get('/api/runs/:id/report', requireAuth, (req, res) => {
  const run = readRunFile(req.params.id);
  if (!run) return res.status(404).send('<h1>Run not found</h1>');
  if (denyProject(res, run.projectId, req.user)) return;
  res.setHeader('Content-Type', 'text/html');
  res.send(generateReportHTML(run));
});

app.get('/report/:runId', (req, res) => {
  const run = readRunFile(req.params.runId);
  if (!run) return res.status(404).send('<h1>Run not found</h1>');
  res.setHeader('Content-Type', 'text/html');
  res.send(generateReportHTML(run));
});

app.post('/api/runs/:id/merge', requireAuth, (req, res) => {
  const parent = readRunFile(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Run not found' });
  if (denyProject(res, parent.projectId, req.user)) return;

  const { jobNumber } = req.body;
  const mergeSummaries = readRunsSummary();
  const rerunSummary = mergeSummaries.find(r => r.jobNumber === jobNumber);
  if (!rerunSummary) return res.status(404).json({ error: `No run found with Job #${jobNumber}` });
  const rerun = readRunFile(rerunSummary.id);
  if (!rerun || !canUseProjectId(rerun.projectId, req.user)) return res.status(404).json({ error: `No run found with Job #${jobNumber}` });

  for (const result of (rerun.scenarioResults || [])) {
    if (result.status === 'passed') {
      const si = parent.scenarioResults.findIndex(sr => sr.scenarioId === result.scenarioId);
      if (si !== -1) parent.scenarioResults[si] = { ...result, rerunId: rerun.id };
      else parent.scenarioResults.push({ ...result, rerunId: rerun.id });
    }
  }

  const parentPassed = parent.scenarioResults.filter(sr => sr.status === 'passed').length;
  const parentTotal = parent.scenarioResults.length;
  const parentFailed = parentTotal - parentPassed;
  parent.status = parentFailed === 0 ? 'passed' : 'failed';
  parent.summary = { total: parentTotal, passed: parentPassed, failed: parentFailed, passRate: parentTotal > 0 ? Math.round((parentPassed / parentTotal) * 100) : 0 };

  saveRunFile(parent);
  const pi = mergeSummaries.findIndex(r => r.id === req.params.id);
  if (pi !== -1) mergeSummaries[pi] = toRunSummary(parent);
  writeRunsSummary(mergeSummaries);

  res.json({ ok: true, status: parent.status, summary: parent.summary });
});

async function sendRunEmail(run, recipients, { message = '', reportUrl } = {}) {
  const projects = readJSON(PROJECTS_FILE);
  const project = projects.find(p => p.id === run.projectId);
  const projectName = project?.name || null;

  const statusColor = run.status === 'passed' ? '#22c55e' : run.status === 'failed' ? '#ef4444' : '#f59e0b';
  const passRate = run.summary?.passRate ?? 0;
  const jobLabel = run.jobNumber ? `Job #${run.jobNumber} – ` : '';

  const scenarioListHTML = (run.scenarioResults || []).map(sr => {
    const color = sr.status === 'passed' ? '#22c55e' : sr.status === 'failed' ? '#ef4444' : '#f59e0b';
    const badge = `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap">${sr.status.toUpperCase()}</span>`;
    return `<tr>
      <td style="padding:10px 16px;font-size:13px;color:#1e293b;border-bottom:1px solid #f1f5f9">${escapeHtml(sr.scenarioName || 'Scenario')}</td>
      <td style="padding:10px 16px;text-align:right;border-bottom:1px solid #f1f5f9">${badge}</td>
    </tr>`;
  }).join('');

  const scenarioListText = (run.scenarioResults || []).map(sr =>
    `  ${sr.status === 'passed' ? '✓' : '✗'} ${sr.scenarioName || 'Scenario'} — ${sr.status.toUpperCase()}`
  ).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;margin:0;padding:32px">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0">
    <div style="background:#0f172a;padding:24px 32px;color:#fff">
      ${projectName ? `<div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#94a3b8;margin-bottom:6px">${escapeHtml(projectName)}</div>` : ''}
      <div style="font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:#64748b;margin-bottom:4px">QA Test Report</div>
      <h1 style="margin:0;font-size:20px">${jobLabel}${escapeHtml(run.name)}</h1>
      ${run.browser ? `<div style="font-size:12px;color:#94a3b8;margin-top:6px;text-transform:capitalize">${escapeHtml(run.browser)}</div>` : ''}
    </div>
    <div style="padding:24px 32px">
      ${message ? `<p style="margin:0 0 20px;color:#475569;font-size:14px">${escapeHtml(message)}</p>` : ''}
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:28px">
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Status</div>
          <div style="font-size:20px;font-weight:700;color:${statusColor};margin-top:4px">${(run.status || '').toUpperCase()}</div>
        </div>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Pass Rate</div>
          <div style="font-size:20px;font-weight:700;color:#1e293b;margin-top:4px">${passRate}%</div>
        </div>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Passed</div>
          <div style="font-size:20px;font-weight:700;color:#22c55e;margin-top:4px">${run.summary?.passed ?? 0}</div>
        </div>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Failed</div>
          <div style="font-size:20px;font-weight:700;color:#ef4444;margin-top:4px">${run.summary?.failed ?? 0}</div>
        </div>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Total</div>
          <div style="font-size:20px;font-weight:700;color:#1e293b;margin-top:4px">${run.summary?.total ?? 0}</div>
        </div>
      </div>
      ${scenarioListHTML ? `
      <div style="margin-bottom:28px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
        <div style="background:#f8fafc;padding:10px 16px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#64748b;border-bottom:1px solid #e2e8f0">Scenarios</div>
        <table style="width:100%;border-collapse:collapse">${scenarioListHTML}</table>
      </div>` : ''}
      <a href="${reportUrl}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;font-size:14px">View Full Report</a>
      <p style="margin:20px 0 0;font-size:12px;color:#94a3b8">Sent from Verifai &middot; no-reply@fayze2.com</p>
    </div>
  </div>
</body>
</html>`;

  const text = [
    projectName ? `Project: ${projectName}` : null,
    `${jobLabel}${run.name}`,
    `Status: ${run.status.toUpperCase()} | Pass Rate: ${passRate}% | Passed: ${run.summary?.passed ?? 0} | Failed: ${run.summary?.failed ?? 0} | Total: ${run.summary?.total ?? 0}`,
    scenarioListText ? `\nScenarios:\n${scenarioListText}` : null,
    message ? `\n${message}` : null,
    `\nView full report: ${reportUrl}`,
  ].filter(Boolean).join('\n');

  await sendEmail({
    to: recipients,
    subject: `QA Report${projectName ? ': ' + projectName : ''} – ${jobLabel}${run.name} – ${(run.status || '').toUpperCase()}`,
    text,
    html,
  });
}

app.post('/api/runs/:id/email', requireAuth, async (req, res) => {
  const run = readRunFile(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (denyProject(res, run.projectId, req.user)) return;

  const { to, message } = req.body;
  if (!to || !to.trim()) return res.status(400).json({ error: 'Recipient email is required' });

  const reportUrl = `${req.protocol}://${req.get('host')}/report/${run.id}`;
  try {
    await sendRunEmail(run, to.split(',').map(a => a.trim()).filter(Boolean), { message, reportUrl });
    res.json({ data: { success: true } });
  } catch (err) {
    console.error('SES send error:', err);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// ─── AI AGENT (LIVE BROWSER TEST BUILDER) ────────────────────────────────────
// Drives a real Playwright session from one plain-English instruction: Claude
// inspects a snapshot of the page's interactive elements and picks one action
// per turn, which is executed via the same executeStep() used for playback.
const agentSessions = new Map();     // id → { browser, context, page, steps, cancelled, userId }
const agentEventStore = new Map();   // id → { events: [], done: bool }

function agentStoreAppend(id, event) {
  const store = agentEventStore.get(id);
  if (store) store.events.push(event);
}

function agentStoreFinish(id) {
  const store = agentEventStore.get(id);
  if (store) {
    store.done = true;
    setTimeout(() => agentEventStore.delete(id), 5 * 60 * 1000);
  }
}

async function snapshotInteractiveElements(page) {
  return page.evaluate(() => {
    function selectorFor(el) {
      for (const a of ['data-testid', 'data-cy', 'data-test', 'data-qa']) {
        const v = el.getAttribute(a);
        if (v) return { selector: `[${a}="${v}"]`, selectorType: 'css' };
      }
      if (el.id && /^[a-zA-Z]/.test(el.id)) return { selector: el.id, selectorType: 'id' };
      const aria = el.getAttribute('aria-label');
      if (aria) return { selector: `[aria-label="${aria}"]`, selectorType: 'css' };
      const name = el.getAttribute('name');
      if (name) return { selector: `[name="${name}"]`, selectorType: 'css' };
      const ph = el.getAttribute('placeholder');
      if (ph) return { selector: `[placeholder="${ph}"]`, selectorType: 'css' };
      const text = el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80);
      if (text) return { selector: text, selectorType: 'text' };
      return { selector: el.tagName.toLowerCase(), selectorType: 'css' };
    }
    function isVisible(el) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    }
    const seen = new Set();
    const out = [];
    const candidates = document.querySelectorAll(
      'a, button, select, input, [role="button"], [role="menuitem"], [onclick], [aria-haspopup], [aria-expanded]'
    );
    for (const el of candidates) {
      if (out.length >= 60) break;
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const { selector, selectorType } = selectorFor(el);
      const dedupeKey = selectorType + ':' + selector;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const entry = {
        tag,
        selector,
        selectorType,
        text: el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 100) || '',
        isDropdownTrigger: el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded') || !!el.querySelector('ul, [role="menu"]')
      };
      if (tag === 'a') entry.href = el.getAttribute('href') || '';
      if (tag === 'select') entry.options = Array.from(el.options).map(o => o.text);
      out.push(entry);
    }
    return { url: location.href, title: document.title, elements: out };
  });
}

const AGENT_TOOLS = [
  { name: 'navigate', description: 'Go to an absolute URL.', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'click', description: 'Click an element from the latest "Interactive elements" snapshot.', input_schema: { type: 'object', properties: { selector: { type: 'string' }, selectorType: { type: 'string', enum: ['css', 'id', 'text'] } }, required: ['selector', 'selectorType'] } },
  { name: 'hover', description: 'Hover over an element — use this to open hover-triggered dropdown/nav menus.', input_schema: { type: 'object', properties: { selector: { type: 'string' }, selectorType: { type: 'string', enum: ['css', 'id', 'text'] } }, required: ['selector', 'selectorType'] } },
  { name: 'type', description: 'Type text into a focused input/textarea.', input_schema: { type: 'object', properties: { selector: { type: 'string' }, selectorType: { type: 'string', enum: ['css', 'id', 'text'] }, value: { type: 'string' } }, required: ['selector', 'selectorType', 'value'] } },
  { name: 'selectOption', description: 'Choose an option in a <select> dropdown by its visible text/value.', input_schema: { type: 'object', properties: { selector: { type: 'string' }, selectorType: { type: 'string', enum: ['css', 'id', 'text'] }, value: { type: 'string' } }, required: ['selector', 'selectorType', 'value'] } },
  { name: 'assertText', description: 'Assert an element contains specific text. Use selectorType "page" with any selector value to check the whole page body instead of one element.', input_schema: { type: 'object', properties: { selector: { type: 'string' }, selectorType: { type: 'string', enum: ['css', 'id', 'text', 'page'] }, text: { type: 'string' }, contains: { type: 'boolean' } }, required: ['selectorType', 'text'] } },
  { name: 'assertVisible', description: 'Assert an element is visible on the page.', input_schema: { type: 'object', properties: { selector: { type: 'string' }, selectorType: { type: 'string', enum: ['css', 'id', 'text'] } }, required: ['selector', 'selectorType'] } },
  { name: 'assertURL', description: 'Assert the current page URL matches.', input_schema: { type: 'object', properties: { url: { type: 'string' }, matchType: { type: 'string', enum: ['exact', 'contains', 'regex'] } }, required: ['url', 'matchType'] } },
  { name: 'accessibilityScan', description: 'Run a WCAG 2.2 AA accessibility scan (axe-core) on the current page, or on one element if a selector is given. Use this whenever the instruction mentions accessibility, a11y, WCAG, or screen-reader/keyboard concerns.', input_schema: { type: 'object', properties: { selector: { type: 'string' }, selectorType: { type: 'string', enum: ['css', 'id', 'text'] }, failOn: { type: 'string', enum: ['minor', 'moderate', 'serious', 'critical'] } }, required: [] } },
  { name: 'compareURLs', description: 'Pixel-diff the current page against another live URL (e.g. a dev URL vs its prod equivalent). Use this whenever the instruction asks to compare two environments/URLs visually. Optionally scope to one element via selector.', input_schema: { type: 'object', properties: { compareUrl: { type: 'string' }, selector: { type: 'string' }, selectorType: { type: 'string', enum: ['css', 'id', 'text'] } }, required: ['compareUrl'] } },
  { name: 'finish', description: 'Call this once the instruction has been fully tested and no further actions are needed.', input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } }
];

const DIAGNOSIS_TOOL = {
  name: 'diagnosis',
  description: 'Report the diagnosis of a failed test step.',
  input_schema: {
    type: 'object',
    properties: {
      explanation: { type: 'string', description: 'Plain-English explanation of why this step likely failed, grounded only in the live facts provided — never speculate beyond them.' },
      hasSuggestion: { type: 'boolean', description: 'true if you have a concrete, confident suggested fix' },
      suggestedSelector: { type: 'string', description: 'Only if hasSuggestion is true: a selector you can see in the current interactive-elements list.' },
      suggestedSelectorType: { type: 'string', enum: ['css', 'id', 'text'] },
      suggestedNth: { type: 'number', description: 'Only if the suggested selector matches more than one element and you need to disambiguate.' }
    },
    required: ['explanation', 'hasSuggestion']
  }
};

const AGENT_SYSTEM_PROMPT = `You are a QA automation agent building a regression test by actually driving a live browser, one action at a time. You will be told a plain-English testing instruction from a non-technical user and, after every action, shown the current page URL/title and a JSON list of the page's visible interactive elements (links, buttons, selects, dropdown triggers) with ready-to-use selectors.

Respond with EXACTLY ONE tool call per turn — never more than one, never plain text. Pick the single next best action.

General strategy:
- Use the element snapshot to decide what to click/assert; never invent a selector that isn't in the snapshot.
- For instructions about checking that "dropdown menus" or "nav menus" go to the right pages: find elements with isDropdownTrigger true (or plain nav links), open each one (click, or hover if it looks hover-triggered), then for every link revealed click it, call assertURL (matchType "contains") to confirm the page actually changed to something sensible for that link's text, and then use "navigate" back to the page you started the menu exploration from so you can check the remaining menus/links.
- Prefer selectorType "text" for links/buttons identified by visible text, "id" for form fields with stable ids, "css" otherwise.
- Keep the whole run efficient: aim to cover the important cases in well under 25 actions total. If a site has many menus/links, prioritize breadth (sample across all menus) over exhaustively clicking every single link.
- If an action's result shows an error, adapt — re-read the next snapshot and try a different element rather than repeating the same failing action.
- For instructions about accessibility, a11y, or WCAG compliance: navigate to the page(s) in question and call "accessibilityScan" (whole page, or scoped to one element's selector). A passing scan means no mechanical failures were found, not full conformance — report violation and "needs manual review" counts honestly in your final summary rather than calling it fully accessible.
- For instructions about comparing two environments/URLs visually (e.g. "make sure dev matches prod"): call "compareURLs" with the second URL — it screenshots and pixel-diffs it against the current page for you, no manual navigation back and forth needed.
- Call "finish" as soon as the instruction has been reasonably verified. Do not keep going just to be thorough once the core behavior is confirmed.`;

function describeAgentAction(name, input) {
  switch (name) {
    case 'navigate':      return `Navigating to ${input.url}`;
    case 'click':         return `Clicking "${input.selector}"`;
    case 'hover':         return `Hovering over "${input.selector}"`;
    case 'type':          return `Typing "${input.value}" into "${input.selector}"`;
    case 'selectOption':  return `Selecting "${input.value}" in "${input.selector}"`;
    case 'assertText':    return `Checking that ${input.selectorType === 'page' ? 'the page' : `"${input.selector}"`} contains "${input.text}"`;
    case 'assertVisible': return `Checking that "${input.selector}" is visible`;
    case 'assertURL':     return `Checking the URL ${input.matchType === 'exact' ? 'is' : 'contains'} "${input.url}"`;
    case 'accessibilityScan': return `Running an accessibility scan${input.selector ? ` on "${input.selector}"` : ' on the page'}`;
    case 'compareURLs':   return `Comparing this page visually against "${input.compareUrl}"`;
    case 'finish':        return input.summary || 'Finishing up';
    default:              return `Action: ${name}`;
  }
}

// Executes one AGENT_TOOLS call against a live page and reports what happened. Shared by
// the multi-turn agent loop and the single-shot "Suggest this step" action in Studio, so
// both go through the exact same execution/recording semantics.
// shouldRecord: true means this result is itself a regression-worthy outcome worth saving
// as a step even though it "failed" (a real accessibility violation, a real visual diff) —
// as opposed to a setup/usage problem (bad selector, missing deps) which never earns one.
async function runAgentTool(page, name, input) {
  const context = page.context();
  try {
    switch (name) {
      case 'navigate': {
        await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return { params: { url: input.url }, resultMessage: `Navigated to ${page.url()}`, isError: false, shouldRecord: true };
      }
      case 'click': {
        const params = { selector: input.selector, selectorType: input.selectorType };
        const r = await executeStep(page, { type: 'click', params }, context, page);
        return { params, resultMessage: r.message, isError: false, shouldRecord: true };
      }
      case 'hover': {
        const params = { selector: input.selector, selectorType: input.selectorType };
        const r = await executeStep(page, { type: 'hover', params }, context, page);
        return { params, resultMessage: r.message, isError: false, shouldRecord: true };
      }
      case 'type': {
        const params = { selector: input.selector, selectorType: input.selectorType, value: input.value };
        const r = await executeStep(page, { type: 'type', params }, context, page);
        return { params, resultMessage: r.message, isError: false, shouldRecord: true };
      }
      case 'selectOption': {
        const params = { selector: input.selector, selectorType: input.selectorType, value: input.value };
        const r = await executeStep(page, { type: 'selectOption', params }, context, page);
        return { params, resultMessage: r.message, isError: false, shouldRecord: true };
      }
      case 'assertText': {
        const params = { selector: input.selector, selectorType: input.selectorType, text: input.text, contains: input.contains !== false };
        const r = await executeStep(page, { type: 'assertText', params }, context, page);
        return { params, resultMessage: r.message, isError: false, shouldRecord: true };
      }
      case 'assertVisible': {
        const params = { selector: input.selector, selectorType: input.selectorType };
        const r = await executeStep(page, { type: 'assertVisible', params }, context, page);
        return { params, resultMessage: r.message, isError: false, shouldRecord: true };
      }
      case 'assertURL': {
        const params = { url: input.url, matchType: input.matchType || 'contains' };
        const r = await executeStep(page, { type: 'assertURL', params }, context, page);
        return { params, resultMessage: r.message, isError: false, shouldRecord: true };
      }
      case 'accessibilityScan': {
        const params = {
          ...(input.selector ? { selector: input.selector, selectorType: input.selectorType || 'css' } : {}),
          ...(input.failOn ? { failOn: input.failOn } : {})
        };
        try {
          const r = await executeStep(page, { type: 'accessibilityScan', params }, context, page);
          return { params, resultMessage: r.message, isError: false, shouldRecord: true };
        } catch (scanErr) {
          const msg = scanErr.message || 'Accessibility scan failed';
          const isSetupProblem = msg.startsWith('axe-core is not installed') || msg.startsWith('Could not locate element for accessibility scan');
          return { params, resultMessage: msg, isError: true, shouldRecord: !isSetupProblem };
        }
      }
      case 'compareURLs': {
        const params = {
          compareUrl: input.compareUrl,
          ...(input.selector ? { selector: input.selector, selectorType: input.selectorType || 'css' } : {})
        };
        try {
          const r = await executeStep(page, { type: 'compareURLs', params }, context, page);
          return { params, resultMessage: r.message, isError: false, shouldRecord: true };
        } catch (diffErr) {
          const msg = diffErr.message || 'Visual comparison failed';
          const isSetupProblem = msg.startsWith('pixelmatch/pngjs') || msg.startsWith('A URL to compare against') || msg.startsWith('Size mismatch');
          return { params, resultMessage: msg, isError: true, shouldRecord: !isSetupProblem };
        }
      }
      default:
        return { params: {}, resultMessage: `Unknown action: ${name}`, isError: true, shouldRecord: false };
    }
  } catch (err) {
    return { params: {}, resultMessage: err.message || 'Action failed', isError: true, shouldRecord: false };
  }
}

async function runAiAgentLoop(session, instruction, startUrl, apiKey) {
  const { page, steps } = session;
  const send = (ev) => agentStoreAppend(session.id, ev);
  const MAX_ITERATIONS = 25;
  const MAX_MS = 6 * 60 * 1000;
  const startTime = Date.now();

  function recordStep(type, params) {
    const step = { id: 'step_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), type, params };
    steps.push(step);
    send({ type: 'step', step });
    return step;
  }

  try {
    if (startUrl) {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      recordStep('navigate', { url: startUrl });
      send({ type: 'log', message: `Opened ${startUrl}` });
    }

    let snapshot = await snapshotInteractiveElements(page);
    const messages = [{
      role: 'user',
      content: `Instruction: ${instruction}\n\nCurrent page: ${snapshot.url}\nTitle: ${snapshot.title}\nInteractive elements:\n${JSON.stringify(snapshot.elements)}`
    }];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (session.cancelled) { send({ type: 'log', message: 'Stopped by user.' }); break; }
      if (Date.now() - startTime > MAX_MS) { send({ type: 'log', message: 'Stopped: time limit reached.' }); break; }

      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 30000);
      let resp;
      try {
        resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, system: AGENT_SYSTEM_PROMPT, tools: AGENT_TOOLS, messages })
        });
      } catch (err) {
        send({ type: 'error', message: 'AI service error: ' + (err.message || 'request failed') });
        break;
      } finally {
        clearTimeout(abortTimer);
      }

      if (!resp.ok) {
        send({ type: 'error', message: 'AI service error (status ' + resp.status + ')' });
        break;
      }

      const data = await resp.json();
      messages.push({ role: 'assistant', content: data.content });

      const toolUse = (data.content || []).find(b => b.type === 'tool_use');
      if (!toolUse) {
        send({ type: 'log', message: 'Agent had no further actions — stopping.' });
        break;
      }

      const { name, input, id: toolUseId } = toolUse;
      send({ type: 'log', message: describeAgentAction(name, input) });

      if (name === 'finish') break;

      const { params, resultMessage, isError, shouldRecord } = await runAgentTool(page, name, input);
      if (shouldRecord) recordStep(name, params);
      if (isError) {
        send({ type: 'log', message: `⚠️ ${resultMessage}` });
      }

      snapshot = await snapshotInteractiveElements(page).catch(() => ({ url: page.url(), title: '', elements: [] }));
      messages.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: resultMessage, is_error: isError },
          { type: 'text', text: `Current page: ${snapshot.url}\nTitle: ${snapshot.title}\nInteractive elements:\n${JSON.stringify(snapshot.elements)}` }
        ]
      });
    }
  } catch (err) {
    send({ type: 'error', message: 'Agent error: ' + (err.message || 'Unknown error') });
  } finally {
    send({ type: 'done', steps });
    agentStoreFinish(session.id);
    await session.browser.close().catch(() => {});
    agentSessions.delete(session.id);
  }
}

app.post('/api/ai-agent-sessions', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json({ error: 'API key not configured', needsKey: true });

  const { instruction, startUrl } = req.body;
  if (!instruction || !instruction.trim()) return res.status(400).json({ error: 'Instruction is required' });

  for (const s of agentSessions.values()) {
    if (s.userId === req.user.id) return res.status(409).json({ error: 'An AI Agent run is already in progress. Stop it before starting a new one.' });
  }

  let browser, context, page;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-popup-blocking'] });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    page = await context.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: err.message });
  }

  const id = randomUUID();
  const session = { id, browser, context, page, steps: [], cancelled: false, userId: req.user.id };
  agentSessions.set(id, session);
  agentEventStore.set(id, { events: [], done: false });

  res.json({ data: { id } });

  runAiAgentLoop(session, instruction.trim(), (startUrl || '').trim(), apiKey).catch(() => {});
});

app.get('/api/ai-agent-sessions/:id/events', requireAuth, (req, res) => {
  const store = agentEventStore.get(req.params.id);
  if (!store) return res.json({ events: [], done: true });
  const since = parseInt(req.query.since) || 0;
  res.json({ events: store.events.slice(since), total: store.events.length, done: store.done });
});

app.delete('/api/ai-agent-sessions/:id', requireAuth, async (req, res) => {
  const session = agentSessions.get(req.params.id);
  if (session) session.cancelled = true;
  res.json({ ok: true });
});

// ─── LIVE RECORDING SESSIONS ─────────────────────────────────────────────────
// In-memory only; sessions are ephemeral (lost on restart, which is fine)
const recordingSessions = new Map(); // id → { token, steps, clients: Set<res> }

app.post('/api/recording-sessions', requireAuth, (req, res) => {
  const id = randomUUID();
  const token = crypto.randomBytes(24).toString('hex');
  recordingSessions.set(id, { token, steps: [], clients: new Set() });
  // Auto-expire after 2 hours
  setTimeout(() => recordingSessions.delete(id), 2 * 60 * 60 * 1000);
  res.json({ id, token });
});

app.delete('/api/recording-sessions/:id', requireAuth, (req, res) => {
  const session = recordingSessions.get(req.params.id);
  if (session) {
    session.clients.forEach(c => { try { c.write('data: {"type":"stopped"}\n\n'); c.end(); } catch {} });
    recordingSessions.delete(req.params.id);
  }
  res.json({ ok: true });
});

// Called by recorder.js running on the target page (no user auth, uses session token)
app.post('/api/recording-sessions/:id/steps', (req, res) => {
  const session = recordingSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (req.body.token !== session.token) return res.status(403).json({ error: 'Invalid token' });
  const step = req.body.step;
  if (!step) return res.status(400).json({ error: 'Missing step' });
  session.steps.push(step);
  const payload = `data: ${JSON.stringify({ type: 'step', step })}\n\n`;
  session.clients.forEach(c => { try { c.write(payload); } catch {} });
  res.json({ ok: true });
});

app.get('/api/recording-sessions/:id/stream', requireAuth, (req, res) => {
  const session = recordingSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  setupSSE(res);
  // Send any steps already captured before the client connected
  session.steps.forEach(s => res.write(`data: ${JSON.stringify({ type: 'step', step: s })}\n\n`));
  session.clients.add(res);
  req.on('close', () => session.clients.delete(res));
});

// ─── EMBEDDED BROWSER SESSIONS ───────────────────────────────────────────────
const browserSessions = new Map();

app.post('/api/browser-sessions', requireAuth, async (req, res) => {
  const { url, viewportWidth = 1280, viewportHeight = 800 } = req.body;
  const id = randomUUID();
  let browser, context, page;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-popup-blocking'] });
    context = await browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    page = await context.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: err.message });
  }
  const timer = setTimeout(async () => {
    const s = browserSessions.get(id);
    if (s) { await s.browser.close().catch(() => {}); browserSessions.delete(id); }
  }, 60 * 60 * 1000);
  const pages = [page];
  context.on('page', newP => { pages.push(newP); newP.waitForLoadState('domcontentloaded').catch(() => {}); });
  browserSessions.set(id, { browser, context, page, pages, viewportWidth, viewportHeight, timer, lastUrl: page.url() });
  const shot = await page.screenshot({ type: 'jpeg', quality: 75 });
  res.json({ id, screenshot: shot.toString('base64'), url: page.url() });
});

app.get('/api/browser-sessions/:id/tabs', requireAuth, async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const tabs = await Promise.all(session.pages.map(async (p, i) => {
    let title = '';
    try { title = await p.title(); } catch {}
    return { index: i, url: p.url(), title: title || p.url(), active: p === session.page };
  }));
  res.json({ tabs });
});

app.post('/api/browser-sessions/:id/close-tab', requireAuth, async (req, res) => {
  try {
    const session = browserSessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const { index } = req.body;
    const target = session.pages[index];
    if (!target) return res.status(404).json({ error: 'Tab not found' });
    await target.close().catch(() => {});
    session.pages.splice(index, 1);
    if (session.page === target) {
      session.page = session.pages[session.pages.length - 1] || null;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser-sessions/:id/switch-tab', requireAuth, async (req, res) => {
  try {
    const session = browserSessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const { index } = req.body;
    const target = session.pages[index];
    if (!target) return res.status(404).json({ error: 'Tab not found' });
    session.page = target;
    await target.bringToFront().catch(() => {});
    const shot = await target.screenshot({ type: 'jpeg', quality: 75 }).catch(() => null);
    if (!shot) return res.status(500).json({ error: 'Tab page is no longer available' });
    res.json({ screenshot: shot.toString('base64'), url: target.url() });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser-sessions/:id/action', requireAuth, async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { type, x, y, text, url, key } = req.body;
  const page = session.page; // always use the currently active tab
  let step = null, extraStep = null;

  try {
    if (type === 'navigate') {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      step = { id: 'step_' + Date.now(), type: 'navigate', params: { url } };
    } else if (type === 'click') {
      const info = await page.evaluate(({ cx, cy }) => {
        const el = document.elementFromPoint(cx, cy);
        if (!el) return null;
        function sel(el) {
          for (const a of ['data-testid','data-cy','data-test','data-qa']) { const v = el.getAttribute(a); if (v) return { selector: `[${a}="${v}"]`, selectorType: 'css' }; }
          if (el.id && /^[a-zA-Z]/.test(el.id)) return { selector: el.id, selectorType: 'id' };
          const aria = el.getAttribute('aria-label'); if (aria) return { selector: `[aria-label="${aria}"]`, selectorType: 'css' };
          const tag = el.tagName.toLowerCase();
          if (['button','a','label','span','li','h1','h2','h3','h4','h5','h6','p','td','th'].includes(tag)) {
            const t = el.textContent?.trim().replace(/\s+/g,' ').slice(0,80); if (t) return { selector: t, selectorType: 'text' };
          }
          const ph = el.getAttribute('placeholder'); if (ph) return { selector: `[placeholder="${ph}"]`, selectorType: 'css' };
          const nm = el.getAttribute('name'); if (nm) return { selector: `[name="${nm}"]`, selectorType: 'css' };
          const t2 = el.textContent?.trim().replace(/\s+/g,' ').slice(0,80); if (t2) return { selector: t2, selectorType: 'text' };
          return { selector: tag, selectorType: 'css' };
        }
        const s = sel(el);
        const isInput = ['input','textarea','select'].includes(el.tagName.toLowerCase());
        // Walk up to find the nearest anchor to check for target=_blank
        let anchor = el;
        while (anchor && anchor.tagName !== 'A') anchor = anchor.parentElement;
        const opensNewTab = anchor ? (anchor.target === '_blank' || anchor.getAttribute('target') === '_blank') : false;
        return { ...s, isInput, tagName: el.tagName.toLowerCase(), opensNewTab };
      }, { cx: x, cy: y });

      // Listen for new tab non-blocking — covers target=_blank AND window.open()
      if (session.context) {
        const onNewPage = async p => {
          if (!session.pages.includes(p)) session.pages.push(p);
          await p.waitForLoadState('domcontentloaded').catch(() => {});
        };
        session.context.once('page', onNewPage);
        setTimeout(() => session.context.off('page', onNewPage), 4000);
      }
      const clickNth = info ? await computeRecordedNth(page, info.selector, info.selectorType, x, y) : undefined;
      await page.mouse.click(x, y);
      if (info) step = { id: 'step_' + Date.now(), type: 'click', params: { selector: info.selector, selectorType: info.selectorType, ...(clickNth !== undefined ? { nth: clickNth } : {}) }, _isInput: info.isInput };
    } else if (type === 'type') {
      await page.keyboard.type(text, { delay: 20 });
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        if (el.id && /^[a-zA-Z]/.test(el.id)) return { selector: el.id, selectorType: 'id' };
        const ph = el.getAttribute('placeholder'); if (ph) return { selector: `[placeholder="${ph}"]`, selectorType: 'css' };
        const nm = el.getAttribute('name'); if (nm) return { selector: `[name="${nm}"]`, selectorType: 'css' };
        return null;
      });
      step = { id: 'step_' + Date.now(), type: 'type', params: { selector: focused?.selector || '', selectorType: focused?.selectorType || 'css', value: text } };
    } else if (type === 'key') {
      await page.keyboard.press(key);
      step = { id: 'step_' + Date.now(), type: 'pressKey', params: { key } };
    } else if (type === 'resize') {
      const { width, height } = req.body;
      await session.page.setViewportSize({ width, height });
      session.viewportWidth = width;
      session.viewportHeight = height;
    } else if (type === 'scroll') {
      await page.mouse.wheel(0, y);
      if (!req.body.noStep) step = { id: 'step_' + Date.now(), type: 'scroll', params: { direction: y > 0 ? 'down' : 'up', pixels: Math.abs(y) } };
      if (req.body.noScreenshot) return res.json({ ok: true });
    } else if (type === 'hover') {
      const info = await page.evaluate(({ cx, cy }) => {
        const el = document.elementFromPoint(cx, cy);
        if (!el) return null;
        const t = el.textContent?.trim().replace(/\s+/g,' ').slice(0,80);
        return t ? { selector: t, selectorType: 'text' } : { selector: el.tagName.toLowerCase(), selectorType: 'css' };
      }, { cx: x, cy: y });
      const hoverNth = info ? await computeRecordedNth(page, info.selector, info.selectorType, x, y) : undefined;
      await page.mouse.move(x, y);
      if (info) step = { id: 'step_' + Date.now(), type: 'hover', params: { selector: info.selector, selectorType: info.selectorType, ...(hoverNth !== undefined ? { nth: hoverNth } : {}) } };
    } else if (type === 'assert_visible') {
      const info = await page.evaluate(({ cx, cy }) => {
        const el = document.elementFromPoint(cx, cy);
        if (!el) return null;
        const t = el.textContent?.trim().replace(/\s+/g,' ').slice(0,80);
        return t ? { selector: t, selectorType: 'text' } : null;
      }, { cx: x, cy: y });
      if (info) {
        const nth = await computeRecordedNth(page, info.selector, info.selectorType, x, y);
        step = { id: 'step_' + Date.now(), type: 'assertVisible', params: { selector: info.selector, selectorType: info.selectorType, ...(nth !== undefined ? { nth } : {}) } };
      }
    } else if (type === 'assert_not_visible') {
      const info = await page.evaluate(({ cx, cy }) => {
        const el = document.elementFromPoint(cx, cy);
        if (!el) return null;
        const t = el.textContent?.trim().replace(/\s+/g,' ').slice(0,80);
        return t ? { selector: t, selectorType: 'text' } : null;
      }, { cx: x, cy: y });
      if (info) {
        const nth = await computeRecordedNth(page, info.selector, info.selectorType, x, y);
        step = { id: 'step_' + Date.now(), type: 'assertNotVisible', params: { selector: info.selector, selectorType: info.selectorType, ...(nth !== undefined ? { nth } : {}) } };
      }
    } else if (type === 'assert_text') {
      const info = await page.evaluate(({ cx, cy }) => {
        const el = document.elementFromPoint(cx, cy);
        if (!el) return null;
        const t = el.textContent?.trim().replace(/\s+/g,' ').slice(0,80);
        return t ? { selector: t, selectorType: 'text', text: t } : null;
      }, { cx: x, cy: y });
      if (info) {
        const nth = await computeRecordedNth(page, info.selector, info.selectorType, x, y);
        step = { id: 'step_' + Date.now(), type: 'assertText', params: { selector: info.selector, selectorType: info.selectorType, text: text || info.text, contains: true, ...(nth !== undefined ? { nth } : {}) } };
      }
    } else if (type === 'assert_url') {
      const currentUrl = page.url();
      step = { id: 'step_' + Date.now(), type: 'assertURL', params: { url: text || currentUrl, matchType: 'contains' } };
    } else if (type === 'dblclick') {
      const info = await page.evaluate(({ cx, cy }) => {
        const el = document.elementFromPoint(cx, cy);
        if (!el) return null;
        function sel(el) {
          for (const a of ['data-testid','data-cy','data-test','data-qa']) { const v = el.getAttribute(a); if (v) return { selector: `[${a}="${v}"]`, selectorType: 'css' }; }
          if (el.id && /^[a-zA-Z]/.test(el.id)) return { selector: el.id, selectorType: 'id' };
          const t = el.textContent?.trim().replace(/\s+/g,' ').slice(0,80); if (t) return { selector: t, selectorType: 'text' };
          return { selector: el.tagName.toLowerCase(), selectorType: 'css' };
        }
        return sel(el);
      }, { cx: x, cy: y });
      const dblclickNth = info ? await computeRecordedNth(page, info.selector, info.selectorType, x, y) : undefined;
      await page.mouse.dblclick(x, y);
      if (info) step = { id: 'step_' + Date.now(), type: 'click', params: { selector: info.selector, selectorType: info.selectorType, clickCount: 2, ...(dblclickNth !== undefined ? { nth: dblclickNth } : {}) } };
    } else if (type === 'clear') {
      await page.mouse.click(x, y);
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        if (el.id && /^[a-zA-Z]/.test(el.id)) return { selector: el.id, selectorType: 'id' };
        const nm = el.getAttribute('name'); if (nm) return { selector: `[name="${nm}"]`, selectorType: 'css' };
        return null;
      });
      step = { id: 'step_' + Date.now(), type: 'clearField', params: { selector: focused?.selector || '', selectorType: focused?.selectorType || 'css' } };
    } else if (type === 'inspect') {
      const info = await page.evaluate(({ cx, cy }) => {
        const el = document.elementFromPoint(cx, cy);
        if (!el) return null;
        function sel(el) {
          for (const a of ['data-testid','data-cy','data-test','data-qa']) { const v = el.getAttribute(a); if (v) return { selector: `[${a}="${v}"]`, selectorType: 'css', strategy: a }; }
          if (el.id && /^[a-zA-Z]/.test(el.id)) return { selector: el.id, selectorType: 'id', strategy: 'id' };
          const aria = el.getAttribute('aria-label'); if (aria) return { selector: `[aria-label="${aria}"]`, selectorType: 'css', strategy: 'aria-label' };
          const tag = el.tagName.toLowerCase();
          if (['button','a','label','span','li','h1','h2','h3','h4','h5','h6','p','td','th'].includes(tag)) {
            const t = el.textContent?.trim().replace(/\s+/g,' ').slice(0,80); if (t) return { selector: t, selectorType: 'text', strategy: 'text' };
          }
          const ph = el.getAttribute('placeholder'); if (ph) return { selector: `[placeholder="${ph}"]`, selectorType: 'css', strategy: 'placeholder' };
          const nm = el.getAttribute('name'); if (nm) return { selector: `[name="${nm}"]`, selectorType: 'css', strategy: 'name' };
          return { selector: tag, selectorType: 'css', strategy: 'tag' };
        }
        const s = sel(el);
        const tagName = el.tagName.toLowerCase();
        const isInput = ['input','textarea','select'].includes(tagName);
        const isSelect = tagName === 'select';
        const innerText = el.textContent?.trim().replace(/\s+/g,' ').slice(0, 100);
        const options = isSelect ? Array.from(el.options).map(o => o.text) : [];
        return { ...s, tagName, isInput, isSelect, innerText, options };
      }, { cx: x, cy: y });
      const shot = await page.screenshot({ type: 'jpeg', quality: 75 });
      return res.json({ screenshot: shot.toString('base64'), url: page.url(), step: null, extraStep: null, inspect: info });
    }

    await page.waitForTimeout(type === 'scroll' ? 150 : 400).catch(() => {});
    const newUrl = page.url();
    if (type === 'click' && newUrl !== session.lastUrl) {
      // Assert the URL the click landed on rather than forcing navigation to it —
      // a navigate step here would re-drive the browser there on replay regardless
      // of whether the click itself actually worked, masking a broken link/button.
      extraStep = { id: 'step_' + (Date.now() + 1), type: 'assertURL', params: { url: newUrl, matchType: 'contains' } };
    }
    session.lastUrl = newUrl;
    const shot = await page.screenshot({ type: 'jpeg', quality: 75 }).catch(() => null);
    if (!shot) return res.status(500).json({ error: 'Page closed or unavailable' });
    res.json({ screenshot: shot.toString('base64'), url: newUrl, step, extraStep, tabCount: session.pages.length });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Single-shot version of the AI Agent: given one instruction, asks Claude for exactly one
// tool call against the Studio session's live page, executes it to PROVE it actually works
// right now, and hands back the resulting step — rather than guessing a selector blind.
app.post('/api/browser-sessions/:id/suggest-step', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json({ error: 'API key not configured', needsKey: true });

  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const instruction = (req.body.instruction || '').trim();
  if (!instruction) return res.status(400).json({ error: 'Instruction is required' });

  const page = session.page;
  try {
    const snapshot = await snapshotInteractiveElements(page);
    const userPrompt = `Instruction: ${instruction}\n\nCurrent page: ${snapshot.url}\nTitle: ${snapshot.title}\nInteractive elements:\n${JSON.stringify(snapshot.elements)}`;

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 30000);
    let resp;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: 'You are a QA automation assistant. Given one plain-English instruction and a snapshot of the page\'s interactive elements, pick the single best tool call to accomplish it. Use the element snapshot to pick real selectors — never invent one. Respond with exactly one tool call.',
          tools: AGENT_TOOLS.filter(t => t.name !== 'finish'),
          tool_choice: { type: 'any' },
          messages: [{ role: 'user', content: userPrompt }]
        })
      });
    } finally {
      clearTimeout(abortTimer);
    }

    if (!resp.ok) return res.status(500).json({ error: `AI service error (status ${resp.status})` });
    const data = await resp.json();
    const toolUse = (data.content || []).find(b => b.type === 'tool_use');
    if (!toolUse) return res.status(500).json({ error: 'The AI did not suggest an action — try rephrasing.' });

    const { params, resultMessage, isError } = await runAgentTool(page, toolUse.name, toolUse.input);
    const shot = await page.screenshot({ type: 'jpeg', quality: 75 }).catch(() => null);

    if (isError) {
      return res.json({ error: `Tried "${describeAgentAction(toolUse.name, toolUse.input)}" — ${resultMessage}`, screenshot: shot ? shot.toString('base64') : null, url: page.url() });
    }

    const step = { id: 'step_' + Date.now(), type: toolUse.name, params };
    session.lastUrl = page.url();
    res.json({ step, message: resultMessage, screenshot: shot ? shot.toString('base64') : null, url: page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser-sessions/:id/execute-step', requireAuth, async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { step, vars: clientVars } = req.body;
  if (!step) return res.status(400).json({ error: 'Step required' });

  // Resolve variables (e.g. {{baseUrl}}) before executing
  console.log('[execute-step] vars received:', JSON.stringify(clientVars), '| step url:', step.params?.url);
  const resolvedStep = { ...step, params: resolveStepParams(step.params || {}, clientVars || {}) };

  const page = session.page;
  const STEP_TIMEOUT = 50000;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Step timed out')), STEP_TIMEOUT)
  );
  try {
    let message = '', status = 'passed';
    try {
      const result = await Promise.race([
        executeStep(page, resolvedStep, session.context || page.context(), page),
        timeoutPromise
      ]);
      message = result?.message || step.type;
    } catch (err) {
      status = 'failed';
      message = err.message;
    }
    await page.waitForTimeout(300).catch(() => {});
    const shot = await page.screenshot({ type: 'jpeg', quality: 75, timeout: 8000 }).catch(() => null);
    session.lastUrl = page.url();
    res.json({ screenshot: shot ? shot.toString('base64') : null, url: page.url(), status, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnose a step that just failed live in Studio (step-through / single-step play),
// before it's ever been saved into a run. Reuses the same live page the failure happened
// on — no replay needed, unlike the run-report version of this feature.
app.post('/api/browser-sessions/:id/diagnose-step', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json({ error: 'API key not configured', needsKey: true });

  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Browser session not found or expired' });

  const { step, vars: clientVars, failureMessage } = req.body;
  if (!step) return res.status(400).json({ error: 'step is required' });

  const page = session.page;
  try {
    const resolvedParams = resolveStepParams(step.params || {}, clientVars || {});
    const selectorFacts = await diagnoseSelector(page, resolvedParams);
    const snapshot = await snapshotInteractiveElements(page).catch(() => ({ url: page.url(), title: '', elements: [] }));

    const prompt = `A step just failed while building a test live in Studio. Diagnose why and, if you can, suggest a concrete fix.

Step type: ${step.type}
Step params: ${JSON.stringify(resolvedParams)}
Original failure message: ${failureMessage || '(none provided)'}

Live facts about this selector right now:
${selectorFacts ? JSON.stringify(selectorFacts) : '(this step type has no selector to check)'}

Current page: ${snapshot.url}
Title: ${snapshot.title}
Other interactive elements currently on the page (use these if suggesting a different selector):
${JSON.stringify(snapshot.elements)}`;

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 30000);
    let resp;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: 'You are a QA automation expert explaining why a test step failed, using only the live, grounded facts you are given — never speculate beyond them. If the selector is wrong, stale, or ambiguous and you can see a better one in the current interactive-elements list, suggest it concretely; otherwise say so plainly rather than guessing.',
          tools: [DIAGNOSIS_TOOL],
          tool_choice: { type: 'tool', name: 'diagnosis' },
          messages: [{ role: 'user', content: prompt }]
        })
      });
    } finally {
      clearTimeout(abortTimer);
    }

    if (!resp.ok) return res.status(500).json({ error: `AI service error (status ${resp.status})` });
    const data = await resp.json();
    const toolUse = (data.content || []).find(b => b.type === 'tool_use');
    if (!toolUse) return res.status(500).json({ error: 'Diagnosis failed — the AI did not return a structured result.' });

    res.json({ data: toolUse.input });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/browser-sessions/:id', requireAuth, async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (session) {
    clearTimeout(session.timer);
    await session.browser.close().catch(() => {});
    browserSessions.delete(req.params.id);
  }
  res.json({ ok: true });
});

// ─── VARIABLE RESOLUTION ──────────────────────────────────────────────────────

function resolveVariables(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] !== undefined ? vars[name] : `{{${name}}}`);
}

function resolveStepParams(params, vars) {
  const resolved = {};
  for (const [k, v] of Object.entries(params)) {
    resolved[k] = resolveVariables(v, vars);
  }
  return resolved;
}

// ─── PLAYWRIGHT EXECUTION ─────────────────────────────────────────────────────

async function executeScenario(scenario, browserName, viewport, send, scenarioIndex, httpCredentials, runId, opts = {}) {
  const browserLauncher = BROWSERS[browserName] || chromium;
  const isChromium = browserLauncher === chromium;
  const browserInstance = await browserLauncher.launch({
    headless: true,
    ...(isChromium ? { args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-popup-blocking'] } : {})
  });

  const contextOptions = {
    viewport,
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  };
  if (httpCredentials && httpCredentials.username) contextOptions.httpCredentials = httpCredentials;

  const context = await browserInstance.newContext(contextOptions);
  const page = await context.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  // Build variable map — decrypt secrets at runtime
  const vars = {};
  for (const v of (scenario.variables || [])) {
    vars[v.name] = v.type === 'secret' ? decrypt(v.defaultValue || '') : (v.defaultValue || '');
  }
  // Inject env baseUrl if present
  if (scenario._envBaseUrl) vars.baseUrl = scenario._envBaseUrl;

  const stepResults = [];
  let scenarioStatus = 'passed';
  const scenarioStart = Date.now();
  let currentContext = page; // can become a FrameLocator via switchFrame
  let activePage = page;    // can switch to a new tab via newTab step

  const lastIndex = opts.stopAtIndex !== undefined ? Math.min(opts.stopAtIndex, scenario.steps.length) : scenario.steps.length;

  try {
    for (let i = 0; i < lastIndex; i++) {
      const step = scenario.steps[i];
      const stepStart = Date.now();
      let stepStatus = 'passed';
      let message = '';
      let screenshot = null;
      let autoScreenshot = false;
      let diffImage = null;

      // Resolve params with variables
      const resolvedStep = { ...step, params: resolveStepParams(step.params || {}, vars) };
      const description = describeStep(resolvedStep);

      send({ type: 'step', scenarioIndex, stepIndex: i, stepId: step.id, stepType: step.type, description, status: 'running' });

      // Handle frame switching specially (no executeStep call)
      if (step.type === 'switchFrame') {
        const frameSelector = resolveSelector(resolvedStep.params);
        currentContext = page.frameLocator(frameSelector || resolvedStep.params.selector);
        message = `Switched to iframe: "${resolvedStep.params.selector}"`;
        const duration = Date.now() - stepStart;
        stepResults.push({ stepId: step.id, type: step.type, description, status: 'passed', message, duration, screenshot: null });
        send({ type: 'step', scenarioIndex, stepIndex: i, stepId: step.id, stepType: step.type, description, status: 'passed', message, duration });
        continue;
      }

      if (step.type === 'exitFrame') {
        currentContext = page;
        message = 'Returned to main frame';
        const duration = Date.now() - stepStart;
        stepResults.push({ stepId: step.id, type: step.type, description, status: 'passed', message, duration, screenshot: null });
        send({ type: 'step', scenarioIndex, stepIndex: i, stepId: step.id, stepType: step.type, description, status: 'passed', message, duration });
        continue;
      }

      // Handle useAction steps specially
      if (step.type === 'useAction') {
        const actionName = resolvedStep.params?.actionName || 'Action';
        send({ type: 'step_action_start', scenarioIndex, stepIndex: i, actionName });

        let subSteps = [];
        try {
          const result = await executeStep(currentContext, resolvedStep, context, page);
          const stepsToExpand = result.expandSteps || [];
          let actionFailed = false;

          for (let si = 0; si < stepsToExpand.length; si++) {
            const subStep = stepsToExpand[si];
            const resolvedSubStep = { ...subStep, params: resolveStepParams(subStep.params || {}, vars) };
            const subStart = Date.now();
            let subStatus = 'passed';
            let subMessage = '';
            const subDesc = `[${actionName}] ${describeStep(resolvedSubStep)}`;

            send({ type: 'step', scenarioIndex, stepIndex: i, subStepIndex: si, stepId: subStep.id, stepType: subStep.type, description: subDesc, status: 'running' });

            try {
              const subResult = await executeStep(currentContext, resolvedSubStep, context, page);
              subMessage = subResult.message || '';
            } catch (subErr) {
              subStatus = 'failed';
              subMessage = subErr.message || 'Sub-step failed';
              actionFailed = true;
            }

            const subDuration = Date.now() - subStart;
            subSteps.push({ type: subStep.type, description: subDesc, status: subStatus, message: subMessage, duration: subDuration });
            send({ type: 'step', scenarioIndex, stepIndex: i, subStepIndex: si, stepId: subStep.id, stepType: subStep.type, description: subDesc, status: subStatus, message: subMessage, duration: subDuration });

            if (actionFailed) {
              for (let sj = si + 1; sj < stepsToExpand.length; sj++) {
                const sk = stepsToExpand[sj];
                const skDesc = `[${actionName}] ${describeStep(sk)}`;
                subSteps.push({ type: sk.type, description: skDesc, status: 'skipped', message: 'Skipped due to previous failure', duration: 0 });
                send({ type: 'step', scenarioIndex, stepIndex: i, subStepIndex: sj, stepId: sk.id, stepType: sk.type, description: skDesc, status: 'skipped', message: 'Skipped due to previous failure', duration: 0 });
              }
              break;
            }
          }

          if (actionFailed) {
            stepStatus = 'failed';
            scenarioStatus = 'failed';
            message = `Action "${actionName}" failed`;
          } else {
            message = result.message || '';
          }
        } catch (err) {
          stepStatus = 'failed';
          scenarioStatus = 'failed';
          message = err.message || 'Action failed';
        }

        const duration = Date.now() - stepStart;
        send({ type: 'step_action_end', scenarioIndex, stepIndex: i, actionName, status: stepStatus });
        stepResults.push({ stepId: step.id, type: 'useAction', description: `Use Action: ${actionName}`, status: stepStatus, message, duration, subSteps });
        send({ type: 'step', scenarioIndex, stepIndex: i, stepId: step.id, stepType: 'useAction', description: `Use Action: ${actionName}`, status: stepStatus, message, duration });
        continue;
      }

      try {
        const result = await executeStep(currentContext, resolvedStep, context, activePage);
        message = result.message || '';
        if (result.screenshot) {
          if (runId) {
            screenshot = saveScreenshot(runId, i, Buffer.from(result.screenshot, 'base64'));
          } else {
            screenshot = result.screenshot;
          }
        }
        if (result.diffImage) {
          if (runId) {
            diffImage = saveScreenshot(runId, i, Buffer.from(result.diffImage, 'base64'), 'diff', 'png');
          } else {
            diffImage = result.diffImage;
          }
        }
        if (result.newPage) {
          activePage = result.newPage;
          currentContext = result.newPage;
        }
        if (result.closedTab) {
          activePage = page;
          currentContext = page;
        }
      } catch (err) {
        stepStatus = 'failed';
        scenarioStatus = 'failed';
        message = err.message || 'Step failed';
        // A visual-diff step (visualBaseline, compareURLs) attaches its own "current" shot
        // and diff image to the thrown error — that's more useful than a generic failure
        // screenshot, so prefer it and skip the auto-capture below when present.
        if (err.diffImage) {
          diffImage = runId ? saveScreenshot(runId, i, Buffer.from(err.diffImage, 'base64'), 'diff', 'png') : err.diffImage;
        }
        if (err.screenshot) {
          screenshot = runId ? saveScreenshot(runId, i, Buffer.from(err.screenshot, 'base64'), undefined, 'png') : err.screenshot;
        } else {
          // Auto-screenshot on failure
          try {
            const buf = await activePage.screenshot({ fullPage: false });
            if (runId) {
              screenshot = saveScreenshot(runId, i, buf, 'auto');
              autoScreenshot = true;
            } else {
              screenshot = buf.toString('base64');
              autoScreenshot = true;
            }
          } catch {}
        }
      }

      const duration = Date.now() - stepStart;
      stepResults.push({ stepId: step.id, type: step.type, description, status: stepStatus, message, duration, screenshot, autoScreenshot: autoScreenshot || undefined, diffImage: diffImage || undefined });
      send({ type: 'step', scenarioIndex, stepIndex: i, stepId: step.id, stepType: step.type, description, status: stepStatus, message, duration });

    }
  } finally {
    if (!opts.keepOpen) await browserInstance.close().catch(() => {});
  }

  const duration = Date.now() - scenarioStart;
  send({ type: 'scenario_complete', scenarioIndex, scenarioId: scenario.id, status: scenarioStatus, duration });

  const result = {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    status: scenarioStatus,
    duration,
    steps: stepResults
  };
  // Hand back the live browser/page instead of closing it — used by the step Diagnose
  // flow to continue inspecting the exact page state the target step would have seen,
  // without re-deriving it some other way.
  if (opts.keepOpen) {
    result.browserInstance = browserInstance;
    result.context = context;
    result.page = activePage;
  }
  return result;
}

// executeStep: pageOrFrame is current context (page or FrameLocator), page is always the real Page
async function executeStep(pageOrFrame, step, context, page) {
  // For steps that need the real page object, fall back to pageOrFrame if page not provided
  const realPage = page || pageOrFrame;
  const p = step.params || {};

  switch (step.type) {
    case 'navigate': {
      if (!p.url) throw new Error('URL is required');
      await realPage.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return { message: `Navigated to ${p.url}` };
    }

    case 'click': {
      const el = await getLocator(pageOrFrame, p);
      await el.click({ timeout: 15000, force: !!p.force });
      return { message: `Clicked: ${p.selector}` };
    }

    case 'type': {
      const el = await getLocator(pageOrFrame, p);
      await el.fill(p.value || '', { timeout: 15000 });
      return { message: `Typed "${p.value}" into: ${p.selector}` };
    }

    case 'assertText': {
      const text = p.text || '';
      if (p.selectorType === 'page') {
        const content = await realPage.locator('body').textContent();
        if (p.contains !== false) {
          if (!(content || '').includes(text)) throw new Error(`Page does not contain text: "${text}"`);
        } else {
          if ((content || '').trim() !== text.trim()) throw new Error(`Page text does not match: "${text}"`);
        }
        return { message: `Page contains: "${text}"` };
      }
      const el = await getLocator(pageOrFrame, p);
      const actual = await el.textContent({ timeout: 10000 });
      if (p.contains !== false) {
        if (!(actual || '').includes(text)) throw new Error(`Element text "${actual}" does not contain "${text}"`);
      } else {
        if ((actual || '').trim() !== text.trim()) throw new Error(`Expected "${text}" but got "${actual}"`);
      }
      return { message: `Text assertion passed: "${text}"` };
    }

    case 'assertVisible': {
      const el = await getLocator(pageOrFrame, p);
      await el.waitFor({ state: 'visible', timeout: 10000 });
      return { message: `Element is visible: ${p.selector}` };
    }

    case 'waitForElement': {
      const el = await getLocator(pageOrFrame, p);
      await el.waitFor({ state: 'visible', timeout: p.timeout || 5000 });
      return { message: `Element appeared: ${p.selector}` };
    }

    case 'screenshot': {
      const buf = await realPage.screenshot({ fullPage: false });
      return { message: `Screenshot taken: ${p.name || 'screenshot'}`, screenshot: buf.toString('base64') };
    }

    case 'hover': {
      const el = await getLocator(pageOrFrame, p);
      await el.hover({ timeout: 10000 });
      return { message: `Hovered over: ${p.selector}` };
    }

    case 'runJS': {
      if (!p.script) throw new Error('No script provided');
      const result = await realPage.evaluate(new Function(p.script));
      return { message: `JS executed${result !== undefined ? ': ' + String(result) : ''}` };
    }

    case 'checkElement': {
      const el = await getLocator(pageOrFrame, p);
      await el.check({ timeout: 15000, force: true });
      return { message: `Checked: ${p.selector}` };
    }

    case 'selectOption': {
      const el = await getLocator(pageOrFrame, p);
      await el.selectOption(p.value || '', { timeout: 10000 });
      return { message: `Selected "${p.value}" in: ${p.selector}` };
    }

    case 'pressKey': {
      await realPage.keyboard.press(p.key || 'Enter');
      return { message: `Pressed key: ${p.key}` };
    }

    case 'scroll': {
      if (p.direction === 'to-element' && p.selector) {
        const el = await getLocator(pageOrFrame, p);
        await el.scrollIntoViewIfNeeded({ timeout: 10000 });
        return { message: `Scrolled to element: ${p.selector}` };
      }
      const pixels = p.pixels || 300;
      const dy = p.direction === 'up' ? -pixels : pixels;
      await realPage.evaluate((d) => window.scrollBy(0, d), dy);
      return { message: `Scrolled ${p.direction} ${pixels}px` };
    }

    case 'useAction': {
      const actions = readJSON(ACTIONS_FILE);
      const action = actions.find(a => a.id === p.actionId);
      if (!action) throw new Error(`Action "${p.actionName}" not found`);
      return { expandSteps: action.steps, message: `Expanded action: ${action.name}`, actionName: action.name };
    }

    // ── NEW STEP TYPES ──────────────────────────────────────────────────────

    case 'assertURL': {
      const currentUrl = realPage.url();
      if (p.matchType === 'exact' && currentUrl !== p.url) throw new Error(`URL is "${currentUrl}", expected "${p.url}"`);
      if (p.matchType === 'contains' && !currentUrl.includes(p.url)) throw new Error(`URL "${currentUrl}" does not contain "${p.url}"`);
      if (p.matchType === 'regex' && !new RegExp(p.url).test(currentUrl)) throw new Error(`URL "${currentUrl}" does not match pattern "${p.url}"`);
      return { message: `URL matches: ${currentUrl}` };
    }

    case 'assertNotVisible': {
      const loc = await getLocator(pageOrFrame, p);
      const visible = await loc.isVisible().catch(() => false);
      if (visible) throw new Error(`Element is visible but should not be: "${p.selector}"`);
      return { message: `Element not visible: "${p.selector}"` };
    }

    case 'newTab': {
      const browserContext = context || realPage.context();
      const pagesBefore = browserContext.pages();

      // Intercept window.open BEFORE clicking to capture the URL even if popup is blocked
      await realPage.evaluate(() => {
        window.__verifai_newTabUrl = null;
        const orig = window.open.bind(window);
        window.open = function(url, target, features) {
          if (url && url !== '' && url !== 'about:blank') window.__verifai_newTabUrl = url;
          try { return orig(url, target, features); } catch(e) { return null; }
        };
      }).catch(() => {});

      // Set up page event listener before clicking
      const newPagePromise = Promise.race([
        new Promise(resolve => browserContext.once('page', resolve)),
        new Promise(resolve => setTimeout(() => resolve(null), 10000))
      ]);

      await (await getLocator(pageOrFrame, p)).click();

      // Wait for event-based detection
      let newPage = await newPagePromise;

      // Fallback 1: check context.pages() for any page that appeared after the click
      if (!newPage) {
        const pagesAfter = browserContext.pages();
        newPage = pagesAfter.find(pg => !pagesBefore.includes(pg)) || null;
      }

      // Fallback 2: if window.open was called but popup was blocked, open it manually
      if (!newPage) {
        const capturedUrl = await realPage.evaluate(() => window.__verifai_newTabUrl).catch(() => null);
        if (capturedUrl) {
          newPage = await browserContext.newPage();
          await newPage.goto(capturedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        }
      }

      if (!newPage) throw new Error('No new tab detected after click — the link may not open a new tab');

      await newPage.waitForLoadState('domcontentloaded').catch(() => {});
      if (p.assertURL && newPage.url() !== p.assertURL) throw new Error(`New tab URL is "${newPage.url()}", expected "${p.assertURL}"`);
      if (p.assertURLContains && !newPage.url().includes(p.assertURLContains)) throw new Error(`New tab URL "${newPage.url()}" does not contain "${p.assertURLContains}"`);
      if (p.assertText) {
        const content = await newPage.locator('body').textContent();
        if (!content.includes(p.assertText)) throw new Error(`New tab does not contain text: "${p.assertText}"`);
      }
      if (p.assertPDFText) {
        const pdfResp = await newPage.goto(newPage.url());
        const pdfBuf = await pdfResp.body();
        const parsed = await pdfParse(pdfBuf);
        if (!parsed.text.includes(p.assertPDFText)) throw new Error(`New tab PDF does not contain: "${p.assertPDFText}"`);
      }
      const result = { message: `New tab opened: ${newPage.url()}` };
      if (p.switchToTab) result.newPage = newPage;
      return result;
    }

    case 'fileDownload': {
      const downloadTarget = await getLocator(pageOrFrame, p);
      const [download] = await Promise.all([
        realPage.waitForEvent('download'),
        downloadTarget.click()
      ]);
      const filename = download.suggestedFilename();
      if (p.expectedFilename && !filename.includes(p.expectedFilename)) throw new Error(`Downloaded "${filename}", expected "${p.expectedFilename}"`);
      await download.cancel();
      return { message: `Downloaded: ${filename}` };
    }

    case 'assertPDFContains': {
      if (!pdfParse) throw new Error('pdf-parse module not available');
      const pdfTarget = await getLocator(pageOrFrame, p);
      const [download] = await Promise.all([
        realPage.waitForEvent('download'),
        pdfTarget.click()
      ]);
      const stream = await download.createReadStream();
      const chunks = [];
      await new Promise((resolve, reject) => {
        stream.on('data', c => chunks.push(c));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      const buf = Buffer.concat(chunks);
      const parsed = await pdfParse(buf);
      const pdfText = parsed.text;
      const needle = p.expectedText || '';
      if (!pdfText.includes(needle)) {
        throw new Error(`PDF does not contain expected text: "${needle}"\nPDF text (first 500 chars): ${pdfText.slice(0, 500)}`);
      }
      return { message: `PDF contains "${needle}"` };
    }

    case 'assertInViewport': {
      const el = await getLocator(pageOrFrame, p);
      await el.waitFor({ state: 'visible', timeout: 10000 });
      const inViewport = await el.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return (
          rect.top < window.innerHeight &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.right > 0
        );
      });
      if (!inViewport) throw new Error(`Element "${p.selector}" is in the DOM but not visible in the viewport — the page may not have scrolled to it`);
      return { message: `Element "${p.selector}" is visible in the viewport` };
    }

    case 'assertNoNavigation': {
      // Inject a marker into the page; if the page reloads/navigates, the marker will be gone
      const marker = '__verifai_no_nav_' + Date.now();
      await realPage.evaluate(m => { window[m] = true; }, marker);
      // Wait the configured duration (default 1s) to let any navigation complete
      const waitMs = p.waitMs || 1000;
      await new Promise(r => setTimeout(r, waitMs));
      const stillPresent = await realPage.evaluate(m => !!window[m], marker).catch(() => false);
      if (!stillPresent) throw new Error('Page navigated or reloaded when it should not have');
      return { message: 'Confirmed: no navigation or page reload occurred' };
    }

    case 'scrollElement': {
      const pixels = p.pixels || 300;
      const dy = p.direction === 'up' ? -pixels : pixels;
      const loc = await getLocator(pageOrFrame, p);
      await loc.waitFor({ state: 'attached', timeout: 10000 });
      await loc.scrollIntoViewIfNeeded({ timeout: 10000 });
      const result = await loc.evaluate((el, d) => {
        const before = el.scrollTop;
        el.scrollBy(0, d);
        return { before, after: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      }, dy);
      if (result.scrollHeight <= result.clientHeight) {
        throw new Error(`Element "${p.selector}" is not scrollable — scrollHeight (${result.scrollHeight}px) is not greater than clientHeight (${result.clientHeight}px). Check the selector or that the element has a fixed height with overflow set.`);
      }
      return { message: `Scrolled element "${p.selector}" from ${result.before}px to ${result.after}px (scrollHeight: ${result.scrollHeight}px)` };
    }

    case 'scrollToElement': {
      await (await getLocator(pageOrFrame, p)).scrollIntoViewIfNeeded();
      return { message: `Scrolled to element: "${p.selector}"` };
    }

    case 'assertAttribute': {
      const attrValue = await (await getLocator(pageOrFrame, p)).getAttribute(p.attribute);
      if (attrValue === null) throw new Error(`Attribute "${p.attribute}" not found on element`);
      if (p.matchType === 'contains' && !attrValue.includes(p.value)) throw new Error(`Attribute "${p.attribute}" is "${attrValue}", does not contain "${p.value}"`);
      if (p.matchType !== 'contains' && attrValue !== p.value) throw new Error(`Attribute "${p.attribute}" is "${attrValue}", expected "${p.value}"`);
      return { message: `Attribute "${p.attribute}" = "${attrValue}"` };
    }

    case 'assertCSS': {
      const cssValue = await (await getLocator(pageOrFrame, p)).evaluate((el, prop) => window.getComputedStyle(el).getPropertyValue(prop), p.property);
      if (p.matchType === 'contains' && !cssValue.includes(p.value)) throw new Error(`CSS "${p.property}" is "${cssValue}", does not contain "${p.value}"`);
      if (p.matchType !== 'contains' && cssValue.trim() !== (p.value || '').trim()) throw new Error(`CSS "${p.property}" is "${cssValue}", expected "${p.value}"`);
      return { message: `CSS "${p.property}" = "${cssValue}"` };
    }

    case 'clearField': {
      await (await getLocator(pageOrFrame, p)).clear();
      return { message: `Cleared field: "${p.selector}"` };
    }

    case 'waitForNetwork': {
      await realPage.waitForLoadState('networkidle', { timeout: p.timeout || 5000 });
      return { message: 'Network is idle' };
    }

    case 'waitSeconds': {
      const ms = (p.seconds || 3) * 1000;
      await new Promise(r => setTimeout(r, ms));
      return { message: `Waited ${p.seconds || 3}s` };
    }

    case 'assertElementSize': {
      const dim = p.dimension || 'height';
      const result = await realPage.evaluate(({ selector, dim }) => {
        const el = document.querySelector(selector);
        if (!el) return { error: `Element not found: ${selector}` };
        const rect = el.getBoundingClientRect();
        const viewportSize = dim === 'height' ? window.innerHeight : window.innerWidth;
        const elSize = dim === 'height' ? rect.height : rect.width;
        const pct = (elSize / viewportSize) * 100;
        return { pct: Math.round(pct * 10) / 10, elSize: Math.round(elSize), viewportSize: Math.round(viewportSize) };
      }, { selector: p.selector, dim });

      if (result.error) throw new Error(result.error);

      const actual = result.pct;
      const expected = p.expected;
      const tolerance = p.tolerance ?? 2;

      if (expected === null || expected === undefined) {
        return { message: `Actual ${dim}: ${actual}% of viewport (${result.elSize}px / ${result.viewportSize}px) — set this as your expected value` };
      }

      const diff = Math.abs(actual - expected);
      if (diff > tolerance) {
        throw new Error(`${dim} is ${actual}% of viewport, expected ${expected}% ±${tolerance}% (off by ${diff.toFixed(1)}%)`);
      }
      return { message: `${dim} is ${actual}% of viewport ✓ (expected ${expected}% ±${tolerance}%)` };
    }

    case 'accessibilityScan': {
      if (!AXE_SOURCE) throw new Error('axe-core is not installed on this server (run `npm install axe-core`)');

      let elementHandle = null;
      if (p.selector) {
        const loc = await getLocator(pageOrFrame, p);
        elementHandle = await loc.elementHandle();
        if (!elementHandle) throw new Error(`Could not locate element for accessibility scan: "${p.selector}"`);
      }

      await realPage.evaluate(AXE_SOURCE);
      const tags = Array.isArray(p.tags) && p.tags.length
        ? p.tags
        : ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

      let results;
      try {
        results = await realPage.evaluate(
          ({ hasElement, element, tags }) => {
            const ctx = hasElement ? element : document;
            return window.axe.run(ctx, { runOnly: { type: 'tag', values: tags } });
          },
          { hasElement: !!elementHandle, element: elementHandle, tags }
        );
      } finally {
        if (elementHandle) await elementHandle.dispose().catch(() => {});
      }

      // axe is deliberately tuned for near-zero false positives: a clean run means
      // "no mechanical failures found," not "accessible." Never report violations
      // alone — incomplete[] ("axe could not decide, a human must") always matters.
      const impactOrder = ['minor', 'moderate', 'serious', 'critical'];
      const failOn = impactOrder.includes(p.failOn) ? p.failOn : 'serious';
      const failThreshold = impactOrder.indexOf(failOn);
      const violations = results.violations || [];
      const incomplete = results.incomplete || [];
      const failing = violations.filter(v => impactOrder.indexOf(v.impact) >= failThreshold);
      const lesser = violations.filter(v => impactOrder.indexOf(v.impact) < failThreshold);

      const summarize = (list) => list.map(v =>
        `${v.impact || '?'} [${v.id}] ${v.help} — ${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'} (e.g. ${v.nodes[0]?.target?.[0] || '?'})`
      ).join('; ');

      const incompleteNote = incomplete.length
        ? ` ${incomplete.length} item(s) need manual review (axe could not decide) — not counted as failures either way.`
        : '';

      if (failing.length > 0) {
        throw new Error(`${failing.length} accessibility violation(s) at or above "${failOn}": ${summarize(failing)}.${incompleteNote}`);
      }
      const lesserNote = lesser.length ? ` ${lesser.length} lower-severity violation(s) noted but not failed: ${summarize(lesser)}.` : '';
      return { message: `Accessibility scan passed — 0 violations at or above "${failOn}".${lesserNote}${incompleteNote}` };
    }

    case 'visualBaseline': {
      if (!PNG || !pixelmatch) throw new Error('pixelmatch/pngjs packages not installed');
      const projectId = step._projectId || 'default';
      const baselineDir = path.join(BASELINES_DIR, projectId);
      fs.mkdirSync(baselineDir, { recursive: true });
      const baselineFile = path.join(baselineDir, `${p.name || 'baseline'}.png`);
      const screenshotBuf = await realPage.screenshot({ fullPage: false });

      if (!fs.existsSync(baselineFile)) {
        fs.writeFileSync(baselineFile, screenshotBuf);
        return { message: `Baseline saved: "${p.name}"`, screenshot: screenshotBuf.toString('base64'), isBaseline: true };
      }

      const baseline = PNG.sync.read(fs.readFileSync(baselineFile));
      const current = PNG.sync.read(screenshotBuf);
      const { width, height } = baseline;
      if (current.width !== width || current.height !== height) {
        throw new Error(`Size mismatch: baseline ${width}x${height}, current ${current.width}x${current.height}`);
      }
      const diff = new PNG({ width, height });
      const numDiffPixels = pixelmatch(baseline.data, current.data, diff.data, width, height, { threshold: p.threshold || 0.1 });
      const diffPercent = (numDiffPixels / (width * height) * 100).toFixed(2);
      const diffBase64 = PNG.sync.write(diff).toString('base64');

      if (numDiffPixels > (width * height * (p.threshold || 0.1))) {
        const err = new Error(`Visual difference: ${diffPercent}% pixels changed (${numDiffPixels} pixels)`);
        err.diffImage = diffBase64;
        err.screenshot = screenshotBuf.toString('base64');
        throw err;
      }
      return {
        message: `Visual match: ${diffPercent}% difference (within threshold)`,
        screenshot: screenshotBuf.toString('base64'),
        diffImage: diffBase64,
        diffPercent: parseFloat(diffPercent)
      };
    }

    case 'compareURLs': {
      if (!PNG || !pixelmatch) throw new Error('pixelmatch/pngjs packages not installed');
      if (!p.compareUrl) throw new Error('A URL to compare against is required');

      const scoped = !!p.selector;
      const captureOn = async (fullPage, frameContext) => {
        if (scoped) {
          const loc = await getLocator(frameContext, p);
          await loc.waitFor({ state: 'visible', timeout: 10000 });
          return loc.screenshot();
        }
        return fullPage.screenshot({ fullPage: false });
      };

      const primaryBuf = await captureOn(realPage, pageOrFrame);

      // Open the comparison URL in a separate tab so the scenario's own page/navigation
      // state is untouched — subsequent steps keep testing the original page.
      const browserContext = context || realPage.context();
      const comparePage = await browserContext.newPage();
      let compareBuf;
      try {
        await comparePage.goto(p.compareUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        compareBuf = await captureOn(comparePage, comparePage);
      } finally {
        await comparePage.close().catch(() => {});
      }

      const primary = PNG.sync.read(primaryBuf);
      const compare = PNG.sync.read(compareBuf);
      const { width, height } = primary;
      if (compare.width !== width || compare.height !== height) {
        throw new Error(`Size mismatch comparing pages: this page is ${width}x${height}, "${p.compareUrl}" is ${compare.width}x${compare.height}. Try scoping to a specific element with a consistent size — a size difference may itself be a real layout regression.`);
      }
      const diff = new PNG({ width, height });
      const threshold = p.threshold || 0.1;
      const numDiffPixels = pixelmatch(primary.data, compare.data, diff.data, width, height, { threshold });
      const diffPercent = (numDiffPixels / (width * height) * 100).toFixed(2);
      const diffBase64 = PNG.sync.write(diff).toString('base64');

      if (numDiffPixels > (width * height * threshold)) {
        const err = new Error(`Visual difference vs "${p.compareUrl}": ${diffPercent}% pixels changed (${numDiffPixels} pixels)`);
        err.diffImage = diffBase64;
        err.screenshot = primaryBuf.toString('base64');
        throw err;
      }
      return {
        message: `Visual match vs "${p.compareUrl}": ${diffPercent}% difference (within threshold)`,
        screenshot: primaryBuf.toString('base64'),
        diffImage: diffBase64,
        diffPercent: parseFloat(diffPercent)
      };
    }

    case 'closeTab': {
      await realPage.close();
      return { message: 'Tab closed', closedTab: true };
    }

    case 'switchToNewTab': {
      const browserContext = context || realPage.context();

      // First check if a new tab already exists (opened during a previous click step)
      const existingPages = browserContext.pages();
      let newPage = existingPages.find(pg => pg !== realPage) || null;

      // If not already open, wait up to 8s for one to appear
      if (!newPage) {
        newPage = await Promise.race([
          new Promise(resolve => browserContext.once('page', resolve)),
          new Promise(resolve => setTimeout(() => resolve(null), 8000))
        ]);
      }

      if (!newPage) throw new Error('No new tab found — ensure the previous step opens a new tab');
      await newPage.waitForLoadState('domcontentloaded').catch(() => {});
      if (p.assertURLContains && !newPage.url().includes(p.assertURLContains)) {
        throw new Error(`New tab URL "${newPage.url()}" does not contain "${p.assertURLContains}"`);
      }
      return { message: `Switched to new tab: ${newPage.url()}`, newPage };
    }

    // switchFrame and exitFrame are handled in executeScenario loop, not here
    case 'switchFrame':
    case 'exitFrame':
      return { message: 'Frame context already handled' };

    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

function baseLocator(pageOrFrame, p) {
  if (!p.selector) throw new Error('Selector is required');
  if (p.selectorType === 'text') return pageOrFrame.getByText(p.selector, { exact: false });
  if (p.selectorType === 'id') return pageOrFrame.locator(`#${p.selector}`);
  return pageOrFrame.locator(p.selector);
}

// Resolves a step's selector to a single element. An explicit `nth` (set manually,
// or captured at record time when multiple visible matches existed) always wins and
// indexes the raw match list, exactly as before. Otherwise — the common case — this
// picks the first genuinely VISIBLE match rather than blindly trusting DOM order,
// because many sites render both a desktop and a mobile nav with identical text/attrs,
// only one of which is actually visible/interactable at a given viewport. Trusting
// raw `.first()` there intermittently grabs the hidden duplicate and times out.
async function getLocator(pageOrFrame, p) {
  const base = baseLocator(pageOrFrame, p);
  const nth = p.nth !== undefined && p.nth !== '' && p.nth !== null ? parseInt(p.nth) : null;
  if (nth !== null) return base.nth(nth);

  const matches = await base.all().catch(() => []);
  for (const candidate of matches) {
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return base.first();
}

// Called at RECORD time (Studio's coordinate-click capture) right after a selector is
// picked, using the real Playwright match list — the same one replay will use — rather
// than guessing. If that selector matches more than one element, finds which match sits
// under the clicked point and returns its index so the step carries an explicit `nth`.
// Without this, two visually distinct but textually-identical elements (e.g. repeated
// "Learn More" cards) are indistinguishable at replay and `getLocator` would just grab
// whichever one happens to be first. Returns undefined when the selector is already
// unique — the common case — so most recorded steps stay nth-free.
async function computeRecordedNth(page, selector, selectorType, cx, cy) {
  try {
    const loc = baseLocator(page, { selector, selectorType });
    const count = await loc.count();
    if (count <= 1) return undefined;
    for (let i = 0; i < count; i++) {
      const box = await loc.nth(i).boundingBox().catch(() => null);
      if (box && cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height) {
        return i;
      }
    }
  } catch {}
  return undefined;
}

function resolveSelector(p) {
  if (!p || !p.selector) return null;
  if (p.selectorType === 'id') return `#${p.selector}`;
  return p.selector;
}

// Live, right-now facts about a step's selector — used by the Diagnose feature to hand
// Claude grounded evidence (actual match count, actual visibility) instead of having it
// guess at why a step failed from the error message alone.
async function diagnoseSelector(page, p) {
  if (!p || !p.selector) return null;
  try {
    const base = baseLocator(page, p);
    const count = await base.count();
    const matches = [];
    for (let i = 0; i < Math.min(count, 10); i++) {
      const el = base.nth(i);
      matches.push({
        index: i,
        visible: await el.isVisible().catch(() => false),
        text: ((await el.textContent().catch(() => '')) || '').trim().replace(/\s+/g, ' ').slice(0, 100)
      });
    }
    return { selector: p.selector, selectorType: p.selectorType, nth: p.nth, matchCount: count, matches };
  } catch (err) {
    return { selector: p.selector, selectorType: p.selectorType, nth: p.nth, error: err.message };
  }
}

function describeStep(step) {
  const p = step.params || {};
  switch (step.type) {
    case 'navigate':        return `Navigate to ${p.url || '(url)'}`;
    case 'click':           return `Click "${p.selector || ''}"`;
    case 'type':            return `Type "${p.value || ''}" into "${p.selector || ''}"`;
    case 'assertText':      return `Assert text "${p.text || ''}" ${p.selectorType === 'page' ? 'on page' : `in "${p.selector || ''}"`}`;
    case 'assertVisible':   return `Assert "${p.selector || ''}" is visible`;
    case 'assertNotVisible':return `Assert "${p.selector || ''}" is NOT visible`;
    case 'waitForElement':  return `Wait for "${p.selector || ''}"`;
    case 'screenshot':      return `Take screenshot "${p.name || ''}"`;
    case 'hover':           return `Hover over "${p.selector || ''}"`;
    case 'checkElement':    return `Check checkbox "${p.selector || ''}"`;
    case 'runJS':           return `Run JS: ${(p.script || '').substring(0, 40) || '(script)'}`;
    case 'selectOption':    return `Select "${p.value || ''}" in "${p.selector || ''}"`;
    case 'pressKey':        return `Press ${p.key || 'Enter'}`;
    case 'scroll':          return `Scroll ${p.direction || 'down'} ${p.pixels ? p.pixels + 'px' : ''}`;
    case 'useAction':       return `Use Action: ${p.actionName || '(action)'}`;
    case 'assertURL':       return `Assert URL ${p.matchType || 'contains'} "${p.url || ''}"`;
    case 'newTab':          return `Open new tab via "${p.selector || ''}"`;
    case 'fileDownload':       return `Download file via "${p.selector || ''}"`;
    case 'assertPDFContains':  return `Assert PDF contains "${p.expectedText || ''}"`;
    case 'assertInViewport':   return `Assert "${p.selector || ''}" is in viewport`;
    case 'assertNoNavigation': return `Assert no navigation/reload (wait ${p.waitMs || 1000}ms)`;
    case 'scrollToElement':    return `Scroll to "${p.selector || ''}"`;
    case 'scrollElement':      return `Scroll element "${p.selector || ''}" ${p.direction || 'down'} ${p.pixels || 300}px`;
    case 'assertAttribute': return `Assert "${p.selector || ''}" attr "${p.attribute || ''}" ${p.matchType || 'exact'} "${p.value || ''}"`;
    case 'assertCSS':       return `Assert "${p.selector || ''}" CSS "${p.property || ''}" ${p.matchType || 'exact'} "${p.value || ''}"`;
    case 'clearField':      return `Clear field "${p.selector || ''}"`;
    case 'switchFrame':     return `Switch to iframe "${p.selector || ''}"`;
    case 'exitFrame':       return 'Exit iframe back to main page';
    case 'closeTab':        return 'Close current tab';
    case 'switchToNewTab':  return `Switch to new tab${p.assertURLContains ? ` (URL contains "${p.assertURLContains}")` : ''}`;
    case 'waitForNetwork':  return `Wait for network idle (${p.timeout || 5000}ms)`;
    case 'waitSeconds':       return `Wait ${p.seconds || 3}s`;
    case 'assertElementSize': return `Assert "${p.selector || ''}" ${p.dimension || 'height'} = ${p.expected ?? '?'}% ±${p.tolerance ?? 2}%`;
    case 'accessibilityScan': return `Accessibility scan (WCAG 2.2 AA)${p.selector ? ` on "${p.selector}"` : ' on full page'}${p.failOn && p.failOn !== 'serious' ? `, fail on ${p.failOn}+` : ''}`;
    case 'compareURLs': return `Visually compare this page vs "${p.compareUrl || '(url)'}"${p.selector ? ` on "${p.selector}"` : ''}`;
    case 'visualBaseline':  return `Visual baseline check "${p.name || ''}"`;
    default:                return step.type;
  }
}

function setupSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // Heartbeat to keep the tunnel alive through Coder's proxy
  const hb = setInterval(() => { try { res.write('data: {"type":"ping"}\n\n'); if (res.flush) res.flush(); } catch {} }, 10000);
  res.on('close', () => clearInterval(hb));
}

// ─── REPORT HTML GENERATOR ────────────────────────────────────────────────────

function generateReportHTML(run) {
  const statusColor = run.status === 'passed' ? '#22c55e' : run.status === 'failed' ? '#ef4444' : '#f59e0b';
  const browserIcon = run.browser === 'firefox' ? '🦊' : run.browser === 'webkit' ? '🧭' : '🌐';
  const deviceIcon = run.device?.startsWith('mobile') ? '📱' : run.device?.startsWith('tablet') ? '📲' : run.device?.startsWith('laptop') ? '💻' : '🖥️';

  const scenarioRows = (run.scenarioResults || []).map((sr, srIdx) => {
    const stepsHTML = sr.steps.map((step, idx) => {
      const icon = step.status === 'passed' ? '✅' : step.status === 'failed' ? '❌' : '⏭️';
      const screenshotSrc = step.screenshot
        ? (/\.(jpg|jpeg|png)$/i.test(step.screenshot)
            ? `/screenshots/${run.id}/${step.screenshot}`
            : `data:image/jpeg;base64,${step.screenshot}`)
        : null;
      const screenshotHTML = screenshotSrc
        ? `<div style="margin-top:8px"><img src="${screenshotSrc}" style="max-width:100%;border-radius:4px;border:1px solid #e2e8f0" /></div>`
        : '';
      return `<tr>
        <td style="padding:8px 12px;color:#64748b;font-size:13px">${idx + 1}</td>
        <td style="padding:8px 12px;font-size:13px">${icon} ${escapeHtml(step.description || step.type)}</td>
        <td style="padding:8px 12px;font-size:13px;color:#64748b">${escapeHtml(step.message || '')}</td>
        <td style="padding:8px 12px;font-size:13px;color:#64748b">${step.duration || 0}ms</td>
      </tr>${screenshotHTML ? `<tr><td colspan="4" style="padding:8px 12px">${screenshotHTML}</td></tr>` : ''}`;
    }).join('');

    const srColor = sr.status === 'passed' ? '#22c55e' : sr.status === 'failed' ? '#ef4444' : '#f59e0b';
    const bodyId = `sr-body-${srIdx}`;
    const stepCount = sr.steps.length;
    return `<div style="margin-bottom:16px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
      <button onclick="toggleAccordion('${bodyId}',this)" style="width:100%;background:#f8fafc;border:none;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;text-align:left;gap:12px">
        <div style="display:flex;align-items:center;gap:10px;min-width:0">
          <span style="font-size:15px;font-weight:600;color:#1e293b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(sr.scenarioName || 'Scenario')}</span>
          <span style="font-size:12px;color:#94a3b8;white-space:nowrap;flex-shrink:0">${stepCount} step${stepCount !== 1 ? 's' : ''}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
          <span style="background:${srColor};color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600">${sr.status.toUpperCase()}</span>
          <span class="chevron" style="font-size:12px;color:#64748b;transition:transform .2s">▼</span>
        </div>
      </button>
      <div id="${bodyId}" style="display:none">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:#f1f5f9">
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b">#</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b">Step</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b">Message</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b">Duration</th>
          </tr></thead>
          <tbody>${stepsHTML}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');

  const passRate = run.summary?.passRate ?? 0;
  const jobLabel = run.jobNumber ? `Job #${run.jobNumber}` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${jobLabel ? jobLabel + ' – ' : ''}QA Report: ${escapeHtml(run.name)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #1e293b; }
  .header { background: #0f172a; color: white; padding: 24px 32px; }
  .header h1 { font-size: 22px; margin-bottom: 4px; }
  .header .meta { color: #94a3b8; font-size: 14px; }
  .content { max-width: 1000px; margin: 32px auto; padding: 0 24px 48px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .stat { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
  .stat .label { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: .5px; }
  .stat .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
  button:hover { filter: brightness(.97); }
</style>
</head>
<body>
<div class="header">
  ${jobLabel ? `<div style="font-size:12px;color:#64748b;font-weight:600;letter-spacing:.5px;text-transform:uppercase;margin-bottom:4px">${jobLabel}</div>` : ''}
  <h1>${escapeHtml(run.name)}</h1>
  <div class="meta">${browserIcon} ${run.browser} &nbsp;|&nbsp; ${deviceIcon} ${run.device} &nbsp;|&nbsp; ${new Date(run.startedAt).toLocaleString()} &nbsp;|&nbsp; ${run.duration ? (run.duration / 1000).toFixed(1) + 's' : '—'}</div>
</div>
<div class="content">
  <div class="stats">
    <div class="stat"><div class="label">Status</div><div class="value" style="color:${statusColor}">${(run.status || '').toUpperCase()}</div></div>
    <div class="stat"><div class="label">Pass Rate</div><div class="value">${passRate}%</div></div>
    <div class="stat"><div class="label">Passed</div><div class="value" style="color:#22c55e">${run.summary?.passed ?? 0}</div></div>
    <div class="stat"><div class="label">Failed</div><div class="value" style="color:#ef4444">${run.summary?.failed ?? 0}</div></div>
    <div class="stat"><div class="label">Total</div><div class="value">${run.summary?.total ?? 0}</div></div>
  </div>
  ${scenarioRows}
</div>
<script>
function toggleAccordion(id, btn) {
  var body = document.getElementById(id);
  var chevron = btn.querySelector('.chevron');
  var open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if (chevron) chevron.style.transform = open ? '' : 'rotate(180deg)';
}
</script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── RECORDER IMPORT ROUTE ───────────────────────────────────────────────────
// Serves the SPA shell; the frontend JS reads ?steps= from the URL
app.get('/import', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`Verifai running on port ${PORT}`);
  console.log(`Data: ${DATA_DIR}`);
  initSchedules();
});
server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 30000;
