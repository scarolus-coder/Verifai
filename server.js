'use strict';

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
      if (key && !process.env[key]) process.env[key] = val;
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
let PNG, pixelmatch;
try { const pngjs = require('pngjs'); PNG = pngjs.PNG; pixelmatch = require('pixelmatch'); } catch {}
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch {}

const app = express();
const PORT = 3000;

const DATA_DIR = '/var/www/config/data';
const PROJECTS_FILE      = path.join(DATA_DIR, 'projects.json');
const SCENARIOS_FILE     = path.join(DATA_DIR, 'scenarios.json');
const SUITES_FILE        = path.join(DATA_DIR, 'suites.json');
const RUNS_FILE          = path.join(DATA_DIR, 'runs.json');
const USERS_FILE         = path.join(DATA_DIR, 'users.json');
const ACTIONS_FILE       = path.join(DATA_DIR, 'actions.json');
const SCHEDULES_FILE     = path.join(DATA_DIR, 'schedules.json');
const ENVIRONMENTS_FILE  = path.join(DATA_DIR, 'environments.json');
const BASELINES_DIR      = '/var/www/config/baselines';

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
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
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

      const runs = readJSON(RUNS_FILE);
      run = {
        id: runId,
        jobNumber: runs.length + 1,
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

      runs.push(run);
      writeJSON(RUNS_FILE, runs);

      const result = await executeScenario(scenario, browserName, viewport, silent, 0);
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

      const runs = readJSON(RUNS_FILE);
      run = {
        id: runId,
        jobNumber: runs.length + 1,
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

      runs.push(run);
      writeJSON(RUNS_FILE, runs);

      let passed = 0;
      let failed = 0;
      for (let i = 0; i < scenariosToRun.length; i++) {
        const scenario = scenariosToRun[i];
        try {
          const result = await executeScenario(scenario, browserName, viewport, silent, i);
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
    const allRuns = readJSON(RUNS_FILE);
    const ri = allRuns.findIndex(r => r.id === runId);
    if (ri !== -1) allRuns[ri] = run;
    writeJSON(RUNS_FILE, allRuns);

    // Update schedule with last run info
    const updatedSchedules = readJSON(SCHEDULES_FILE);
    const si = updatedSchedules.findIndex(s => s.id === scheduleId);
    if (si !== -1) {
      updatedSchedules[si].lastRunStatus = run.status;
      updatedSchedules[si].lastRunId = runId;
      updatedSchedules[si].updatedAt = new Date().toISOString();
      writeJSON(SCHEDULES_FILE, updatedSchedules);
    }
  }
}

function initSchedules() {
  const schedules = readJSON(SCHEDULES_FILE);
  const enabled = schedules.filter(s => s.enabled);
  enabled.forEach(s => startCronJob(s));
  console.log(`Initialized ${enabled.length} schedule${enabled.length !== 1 ? 's' : ''}`);
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
  res.json({ data: { ...scenario, variables: maskVariables(scenario.variables) } });
});

app.put('/api/scenarios/:id', requireAuth, (req, res) => {
  const scenarios = readJSON(SCENARIOS_FILE);
  const idx = scenarios.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Scenario not found' });
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
  const filtered = scenarios.filter(s => s.id !== req.params.id);
  if (filtered.length === scenarios.length) return res.status(404).json({ error: 'Scenario not found' });
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
  if (req.query.projectId) suites = suites.filter(s => s.projectId === req.query.projectId);
  res.json({ data: suites });
});

app.post('/api/suites', requireAuth, (req, res) => {
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
  res.json({ data: suite });
});

app.put('/api/suites/:id', requireAuth, (req, res) => {
  const suites = readJSON(SUITES_FILE);
  const idx = suites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Suite not found' });
  suites[idx] = { ...suites[idx], ...req.body, id: suites[idx].id, updatedAt: new Date().toISOString() };
  writeJSON(SUITES_FILE, suites);
  res.json({ data: suites[idx] });
});

app.delete('/api/suites/:id', requireAuth, (req, res) => {
  const suites = readJSON(SUITES_FILE);
  const filtered = suites.filter(s => s.id !== req.params.id);
  if (filtered.length === suites.length) return res.status(404).json({ error: 'Suite not found' });
  writeJSON(SUITES_FILE, filtered);
  res.json({ data: { success: true } });
});

app.patch('/api/suites/:id/scenarios', requireAuth, (req, res) => {
  const suites = readJSON(SUITES_FILE);
  const idx = suites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Suite not found' });
  const suite = suites[idx];
  const ids = new Set(suite.scenarioIds || []);
  (req.body.add || []).forEach(id => ids.add(id));
  (req.body.remove || []).forEach(id => ids.delete(id));
  suite.scenarioIds = Array.from(ids);
  suite.updatedAt = new Date().toISOString();
  writeJSON(SUITES_FILE, suites);
  res.json({ data: suite });
});

// ─── ACTIONS ──────────────────────────────────────────────────────────────────

app.get('/api/actions', requireAuth, (req, res) => {
  let actions = readJSON(ACTIONS_FILE);
  if (req.query.projectId) actions = actions.filter(a => a.projectId === req.query.projectId);
  res.json({ data: actions });
});

app.post('/api/actions', requireAuth, (req, res) => {
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
  res.json({ data: action });
});

app.put('/api/actions/:id', requireAuth, (req, res) => {
  const actions = readJSON(ACTIONS_FILE);
  const idx = actions.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Action not found' });
  actions[idx] = { ...actions[idx], ...req.body, id: actions[idx].id, updatedAt: new Date().toISOString() };
  writeJSON(ACTIONS_FILE, actions);
  res.json({ data: actions[idx] });
});

app.delete('/api/actions/:id', requireAuth, (req, res) => {
  const actions = readJSON(ACTIONS_FILE);
  const filtered = actions.filter(a => a.id !== req.params.id);
  if (filtered.length === actions.length) return res.status(404).json({ error: 'Action not found' });
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
  let runs = readJSON(RUNS_FILE);
  if (req.query.projectId) runs = runs.filter(r => r.projectId === req.query.projectId);
  runs.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const limit = parseInt(req.query.limit) || 50;
  res.json({ data: runs.slice(0, limit) });
});

app.get('/api/runs/:id', requireAuth, (req, res) => {
  const runs = readJSON(RUNS_FILE);
  const run = runs.find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({ data: run });
});

// ─── SCENARIO RUN (SSE) ───────────────────────────────────────────────────────

app.post('/api/runs/scenario/:scenarioId', requireAuth, async (req, res) => {
  const scenarios = readJSON(SCENARIOS_FILE);
  const scenario = scenarios.find(s => s.id === req.params.scenarioId);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });

  const browserName = req.body.browser || 'chromium';
  const deviceKey = req.body.device || 'desktop-1920';
  let viewport = DEVICES[deviceKey] ? { width: DEVICES[deviceKey].width, height: DEVICES[deviceKey].height } : { width: 1920, height: 1080 };
  if (deviceKey === 'custom' && req.body.customViewport) viewport = req.body.customViewport;

  // Resolve environment
  let envBaseUrl = null, envName = null, envId = req.body.environmentId || null, envHttpCreds = null;
  if (envId) {
    const envs = readJSON(ENVIRONMENTS_FILE);
    const env = envs.find(e => e.id === envId);
    if (env) {
      envBaseUrl = env.baseUrl; envName = env.name;
      if (env.httpUsername && env.httpPassword) {
        envHttpCreds = { username: env.httpUsername, password: decrypt(env.httpPassword) };
      }
    }
  }

  // Inject baseUrl into scenario variables if env provided
  const scenarioToRun = envBaseUrl
    ? { ...scenario, _envBaseUrl: envBaseUrl }
    : scenario;

  setupSSE(res);
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const runId = randomUUID();
  const now = new Date().toISOString();
  const runs = readJSON(RUNS_FILE);
  const run = {
    id: runId,
    jobNumber: runs.length + 1,
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

  runs.push(run);
  writeJSON(RUNS_FILE, runs);

  send({ type: 'run_start', runId, name: scenario.name });

  const startTime = Date.now();

  try {
    const result = await executeScenario(scenarioToRun, browserName, viewport, send, 0, envHttpCreds);
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

  const allRuns = readJSON(RUNS_FILE);
  const idx = allRuns.findIndex(r => r.id === runId);
  if (idx !== -1) allRuns[idx] = run;
  writeJSON(RUNS_FILE, allRuns);

  send({ type: 'done', runId, status: run.status });
  res.end();
});

// ─── SUITE RUN (SSE) ──────────────────────────────────────────────────────────

app.post('/api/runs/suite/:suiteId', requireAuth, async (req, res) => {
  const suites = readJSON(SUITES_FILE);
  const suite = suites.find(s => s.id === req.params.suiteId);
  if (!suite) return res.status(404).json({ error: 'Suite not found' });

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
    const env = envs.find(e => e.id === suiteEnvId);
    if (env) {
      suiteEnvBaseUrl = env.baseUrl; suiteEnvName = env.name;
      if (env.httpUsername && env.httpPassword) {
        suiteEnvHttpCreds = { username: env.httpUsername, password: decrypt(env.httpPassword) };
      }
    }
  }

  setupSSE(res);
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const runId = randomUUID();
  const now = new Date().toISOString();
  const runs = readJSON(RUNS_FILE);
  const run = {
    id: runId,
    jobNumber: runs.length + 1,
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
    environmentBaseUrl: suiteEnvBaseUrl
  };

  runs.push(run);
  writeJSON(RUNS_FILE, runs);

  send({ type: 'run_start', runId, name: suite.name, total: scenariosToRun.length });

  const startTime = Date.now();
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < scenariosToRun.length; i++) {
    const scenario = scenariosToRun[i];
    const scenarioToRunInSuite = suiteEnvBaseUrl ? { ...scenario, _envBaseUrl: suiteEnvBaseUrl } : scenario;
    send({ type: 'scenario_start', scenarioIndex: i, scenarioId: scenario.id, scenarioName: scenario.name });
    try {
      const result = await executeScenario(scenarioToRunInSuite, browserName, viewport, send, i, suiteEnvHttpCreds);
      run.scenarioResults.push(result);
      if (result.status === 'passed') passed++; else failed++;
    } catch (err) {
      failed++;
      run.scenarioResults.push({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        status: 'error',
        duration: 0,
        steps: []
      });
      send({ type: 'scenario_error', scenarioIndex: i, message: err.message });
    }
  }

  run.status = failed === 0 ? 'passed' : 'failed';
  run.completedAt = new Date().toISOString();
  run.duration = Date.now() - startTime;
  run.summary = {
    total: scenariosToRun.length,
    passed,
    failed,
    passRate: scenariosToRun.length > 0 ? Math.round((passed / scenariosToRun.length) * 100) : 0
  };

  const allRuns = readJSON(RUNS_FILE);
  const idx = allRuns.findIndex(r => r.id === runId);
  if (idx !== -1) allRuns[idx] = run;
  writeJSON(RUNS_FILE, allRuns);

  send({ type: 'done', runId, status: run.status, passed, failed });
  res.end();
});

// ─── SCHEDULES ────────────────────────────────────────────────────────────────

app.get('/api/schedules', requireAuth, (req, res) => {
  let schedules = readJSON(SCHEDULES_FILE);
  if (req.query.projectId) schedules = schedules.filter(s => s.projectId === req.query.projectId);
  schedules.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ data: schedules });
});

app.post('/api/schedules', requireAuth, (req, res) => {
  const { name, projectId, targetType, targetId, browser, device, customViewport,
          frequency, hour, dayOfWeek, cronExpression, timezone, enabled } = req.body;
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
  res.json({ data: schedule });
});

app.put('/api/schedules/:id', requireAuth, (req, res) => {
  const schedules = readJSON(SCHEDULES_FILE);
  const idx = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });

  const { name, projectId, targetType, targetId, browser, device, customViewport,
          frequency, hour, dayOfWeek, cronExpression, timezone, enabled } = req.body;

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
  stopCronJob(req.params.id);
  schedules.splice(idx, 1);
  writeJSON(SCHEDULES_FILE, schedules);
  res.json({ data: { success: true } });
});

app.post('/api/schedules/:id/run-now', requireAuth, async (req, res) => {
  const schedules = readJSON(SCHEDULES_FILE);
  const schedule = schedules.find(s => s.id === req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
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
  let envs = readJSON(ENVIRONMENTS_FILE);
  if (req.query.projectId) envs = envs.filter(e => e.projectId === req.query.projectId);
  res.json({ data: envs.map(sanitizeEnv) });
});

app.post('/api/environments', requireAuth, (req, res) => {
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
  const filtered = envs.filter(e => e.id !== req.params.id);
  if (filtered.length === envs.length) return res.status(404).json({ error: 'Environment not found' });
  writeJSON(ENVIRONMENTS_FILE, filtered);
  res.json({ data: { success: true } });
});

// ─── BASELINES ────────────────────────────────────────────────────────────────

app.delete('/api/baselines', requireAuth, (req, res) => {
  const { projectId, name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
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
    const env = envs.find(e => e.id === environmentId);
    if (env) { envBaseUrl = env.baseUrl; envName = env.name; }
  }

  setupSSE(res);
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const runId = randomUUID();
  const now = new Date().toISOString();
  const allRuns = readJSON(RUNS_FILE);
  const run = {
    id: runId,
    jobNumber: allRuns.length + 1,
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

  allRuns.push(run);
  writeJSON(RUNS_FILE, allRuns);

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
      }, rowIdx);
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

  const allRunsUpdated = readJSON(RUNS_FILE);
  const ri = allRunsUpdated.findIndex(r => r.id === runId);
  if (ri !== -1) allRunsUpdated[ri] = run;
  writeJSON(RUNS_FILE, allRunsUpdated);

  send({ type: 'done', runId, status: run.status, passed, failed });
  res.end();
});

// ─── REPORT ───────────────────────────────────────────────────────────────────

app.delete('/api/runs/:id', requireAuth, (req, res) => {
  const runs = readJSON(RUNS_FILE);
  const filtered = runs.filter(r => r.id !== req.params.id);
  if (filtered.length === runs.length) return res.status(404).json({ error: 'Run not found' });
  writeJSON(RUNS_FILE, filtered);
  res.json({ data: { success: true } });
});

app.get('/api/runs/:id/report', requireAuth, (req, res) => {
  const runs = readJSON(RUNS_FILE);
  const run = runs.find(r => r.id === req.params.id);
  if (!run) return res.status(404).send('<h1>Run not found</h1>');
  res.setHeader('Content-Type', 'text/html');
  res.send(generateReportHTML(run));
});

app.get('/report/:runId', (req, res) => {
  const runs = readJSON(RUNS_FILE);
  const run = runs.find(r => r.id === req.params.runId);
  if (!run) return res.status(404).send('<h1>Run not found</h1>');
  res.setHeader('Content-Type', 'text/html');
  res.send(generateReportHTML(run));
});

// ─── AI STEP GENERATION ───────────────────────────────────────────────────────

app.post('/api/ai/generate-steps', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json({ error: 'API key not configured', needsKey: true });

  const { description, testType, baseUrl } = req.body;
  if (!description) return res.status(400).json({ error: 'Description is required' });

  const systemPrompt = `You are a QA automation expert. Convert the user's plain English test description into a structured array of test steps.

Return ONLY valid JSON — an array of step objects. Each step has:
- id: a short unique string (e.g. "step_1")
- type: one of: navigate, click, type, assertText, assertVisible, waitForElement, screenshot, hover, selectOption, pressKey, scroll
- params: object with parameters for that step type

Step param reference:
- navigate: { url }
- click: { selector, selectorType } where selectorType is "css", "text", or "id"
- type: { selector, selectorType, value }
- assertText: { selector, selectorType, text, contains }
- assertVisible: { selector, selectorType }
- waitForElement: { selector, selectorType, timeout }
- screenshot: { name }
- hover: { selector, selectorType }
- selectOption: { selector, selectorType, value }
- pressKey: { key }
- scroll: { direction, pixels }

Prefer selectorType "text" for buttons/links (using visible text), "id" for form fields with known IDs, and "css" for more complex selectors. Be practical and use selectors that are likely to work on a real page.`;

  const userPrompt = `Test type: ${testType || 'functional'}
Base URL: ${baseUrl || 'not specified'}
Description: ${description}

Generate a JSON array of test steps for this scenario.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      return res.status(500).json({ error: 'AI service error. Please try again.' });
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '';

    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return res.status(500).json({ error: 'Could not parse AI response. Please try again.' });

    const steps = JSON.parse(match[0]);
    res.json({ data: steps });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate steps. Please try again.' });
  }
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
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportHeight }, ignoreHTTPSErrors: true });
    page = await context.newPage();
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: err.message });
  }
  const timer = setTimeout(async () => {
    const s = browserSessions.get(id);
    if (s) { await s.browser.close().catch(() => {}); browserSessions.delete(id); }
  }, 60 * 60 * 1000);
  browserSessions.set(id, { browser, page, viewportWidth, viewportHeight, timer, lastUrl: page.url() });
  const shot = await page.screenshot({ type: 'jpeg', quality: 75 });
  res.json({ id, screenshot: shot.toString('base64'), url: page.url() });
});

app.post('/api/browser-sessions/:id/action', requireAuth, async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { type, x, y, text, url, key } = req.body;
  const { page } = session;
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
        return { ...s, isInput, tagName: el.tagName.toLowerCase() };
      }, { cx: x, cy: y });
      await page.mouse.click(x, y);
      if (info) step = { id: 'step_' + Date.now(), type: 'click', params: { selector: info.selector, selectorType: info.selectorType }, _isInput: info.isInput };
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
      await page.mouse.move(x, y);
      if (info) step = { id: 'step_' + Date.now(), type: 'hover', params: { selector: info.selector, selectorType: info.selectorType } };
    } else if (type === 'assert_visible') {
      const info = await page.evaluate(({ cx, cy }) => {
        const el = document.elementFromPoint(cx, cy);
        if (!el) return null;
        const t = el.textContent?.trim().replace(/\s+/g,' ').slice(0,80);
        return t ? { selector: t, selectorType: 'text' } : null;
      }, { cx: x, cy: y });
      if (info) step = { id: 'step_' + Date.now(), type: 'assertVisible', params: { selector: info.selector, selectorType: info.selectorType } };
    } else if (type === 'assert_not_visible') {
      const info = await page.evaluate(({ cx, cy }) => {
        const el = document.elementFromPoint(cx, cy);
        if (!el) return null;
        const t = el.textContent?.trim().replace(/\s+/g,' ').slice(0,80);
        return t ? { selector: t, selectorType: 'text' } : null;
      }, { cx: x, cy: y });
      if (info) step = { id: 'step_' + Date.now(), type: 'assertNotVisible', params: { selector: info.selector, selectorType: info.selectorType } };
    } else if (type === 'assert_text') {
      const info = await page.evaluate(({ cx, cy }) => {
        const el = document.elementFromPoint(cx, cy);
        if (!el) return null;
        const t = el.textContent?.trim().replace(/\s+/g,' ').slice(0,80);
        return t ? { selector: t, selectorType: 'text', text: t } : null;
      }, { cx: x, cy: y });
      if (info) step = { id: 'step_' + Date.now(), type: 'assertText', params: { selector: info.selector, selectorType: info.selectorType, text: text || info.text, contains: true } };
    } else if (type === 'assert_url') {
      const currentUrl = page.url();
      step = { id: 'step_' + Date.now(), type: 'assertURL', params: { url: text || currentUrl, contains: true } };
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
      await page.mouse.dblclick(x, y);
      if (info) step = { id: 'step_' + Date.now(), type: 'click', params: { selector: info.selector, selectorType: info.selectorType, clickCount: 2 } };
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
      extraStep = { id: 'step_' + (Date.now() + 1), type: 'navigate', params: { url: newUrl } };
    }
    session.lastUrl = newUrl;
    const shot = await page.screenshot({ type: 'jpeg', quality: 75 });
    res.json({ screenshot: shot.toString('base64'), url: newUrl, step, extraStep });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser-sessions/:id/execute-step', requireAuth, async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { step } = req.body;
  if (!step) return res.status(400).json({ error: 'Step required' });

  const { page } = session;
  try {
    let message = '', status = 'passed';
    try {
      const result = await executeStep(page, step, {}, page);
      message = result?.message || step.type;
    } catch (err) {
      status = 'failed';
      message = err.message;
    }
    await page.waitForTimeout(300).catch(() => {});
    const shot = await page.screenshot({ type: 'jpeg', quality: 75 });
    session.lastUrl = page.url();
    res.json({ screenshot: shot.toString('base64'), url: page.url(), status, message });
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

async function executeScenario(scenario, browserName, viewport, send, scenarioIndex, httpCredentials) {
  const browserLauncher = BROWSERS[browserName] || chromium;
  const isChromium = browserLauncher === chromium;
  const browserInstance = await browserLauncher.launch({
    headless: true,
    ...(isChromium ? { args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] } : {})
  });

  const contextOptions = { viewport, ignoreHTTPSErrors: true };
  if (httpCredentials && httpCredentials.username) contextOptions.httpCredentials = httpCredentials;

  const context = await browserInstance.newContext(contextOptions);
  const page = await context.newPage();

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

  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const stepStart = Date.now();
      let stepStatus = 'passed';
      let message = '';
      let screenshot = null;
      let autoScreenshot = false;

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
        const result = await executeStep(currentContext, resolvedStep, context, page);
        message = result.message || '';
        screenshot = result.screenshot || null;
      } catch (err) {
        stepStatus = 'failed';
        scenarioStatus = 'failed';
        message = err.message || 'Step failed';
        // Auto-screenshot on failure
        try {
          const buf = await page.screenshot({ fullPage: false });
          screenshot = buf.toString('base64');
          autoScreenshot = true;
        } catch {}
      }

      const duration = Date.now() - stepStart;
      stepResults.push({ stepId: step.id, type: step.type, description, status: stepStatus, message, duration, screenshot, autoScreenshot: autoScreenshot || undefined });
      send({ type: 'step', scenarioIndex, stepIndex: i, stepId: step.id, stepType: step.type, description, status: stepStatus, message, duration });

    }
  } finally {
    await browserInstance.close().catch(() => {});
  }

  const duration = Date.now() - scenarioStart;
  send({ type: 'scenario_complete', scenarioIndex, scenarioId: scenario.id, status: scenarioStatus, duration });

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    status: scenarioStatus,
    duration,
    steps: stepResults
  };
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
      const el = getLocator(pageOrFrame, p);
      await el.click({ timeout: 15000 });
      return { message: `Clicked: ${p.selector}` };
    }

    case 'type': {
      const el = getLocator(pageOrFrame, p);
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
      const el = getLocator(pageOrFrame, p);
      const actual = await el.textContent({ timeout: 10000 });
      if (p.contains !== false) {
        if (!(actual || '').includes(text)) throw new Error(`Element text "${actual}" does not contain "${text}"`);
      } else {
        if ((actual || '').trim() !== text.trim()) throw new Error(`Expected "${text}" but got "${actual}"`);
      }
      return { message: `Text assertion passed: "${text}"` };
    }

    case 'assertVisible': {
      const el = getLocator(pageOrFrame, p);
      await el.waitFor({ state: 'visible', timeout: 10000 });
      return { message: `Element is visible: ${p.selector}` };
    }

    case 'waitForElement': {
      const el = getLocator(pageOrFrame, p);
      await el.waitFor({ state: 'visible', timeout: p.timeout || 5000 });
      return { message: `Element appeared: ${p.selector}` };
    }

    case 'screenshot': {
      const buf = await realPage.screenshot({ fullPage: false });
      return { message: `Screenshot taken: ${p.name || 'screenshot'}`, screenshot: buf.toString('base64') };
    }

    case 'hover': {
      const el = getLocator(pageOrFrame, p);
      await el.hover({ timeout: 10000 });
      return { message: `Hovered over: ${p.selector}` };
    }

    case 'selectOption': {
      const el = getLocator(pageOrFrame, p);
      await el.selectOption(p.value || '', { timeout: 10000 });
      return { message: `Selected "${p.value}" in: ${p.selector}` };
    }

    case 'pressKey': {
      await realPage.keyboard.press(p.key || 'Enter');
      return { message: `Pressed key: ${p.key}` };
    }

    case 'scroll': {
      if (p.direction === 'to-element' && p.selector) {
        const el = getLocator(pageOrFrame, p);
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
      const loc = getLocator(pageOrFrame, p);
      const visible = await loc.isVisible().catch(() => false);
      if (visible) throw new Error(`Element is visible but should not be: "${p.selector}"`);
      return { message: `Element not visible: "${p.selector}"` };
    }

    case 'newTab': {
      const [newPage] = await Promise.all([
        (context || realPage.context()).waitForEvent('page'),
        getLocator(pageOrFrame, p).click()
      ]);
      await newPage.waitForLoadState('domcontentloaded');
      if (p.assertURL && newPage.url() !== p.assertURL) throw new Error(`New tab URL is "${newPage.url()}", expected "${p.assertURL}"`);
      if (p.assertURLContains && !newPage.url().includes(p.assertURLContains)) throw new Error(`New tab URL "${newPage.url()}" does not contain "${p.assertURLContains}"`);
      if (p.assertText) {
        const content = await newPage.locator('body').textContent();
        if (!content.includes(p.assertText)) throw new Error(`New tab does not contain text: "${p.assertText}"`);
      }
      return { message: `New tab opened: ${newPage.url()}` };
    }

    case 'fileDownload': {
      const [download] = await Promise.all([
        realPage.waitForEvent('download'),
        getLocator(pageOrFrame, p).click()
      ]);
      const filename = download.suggestedFilename();
      if (p.expectedFilename && !filename.includes(p.expectedFilename)) throw new Error(`Downloaded "${filename}", expected "${p.expectedFilename}"`);
      await download.cancel();
      return { message: `Downloaded: ${filename}` };
    }

    case 'assertPDFContains': {
      if (!pdfParse) throw new Error('pdf-parse module not available');
      const [download] = await Promise.all([
        realPage.waitForEvent('download'),
        getLocator(pageOrFrame, p).click()
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
      const el = getLocator(pageOrFrame, p);
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

    case 'scrollToElement': {
      await getLocator(pageOrFrame, p).scrollIntoViewIfNeeded();
      return { message: `Scrolled to element: "${p.selector}"` };
    }

    case 'assertAttribute': {
      const attrValue = await getLocator(pageOrFrame, p).getAttribute(p.attribute);
      if (attrValue === null) throw new Error(`Attribute "${p.attribute}" not found on element`);
      if (p.matchType === 'contains' && !attrValue.includes(p.value)) throw new Error(`Attribute "${p.attribute}" is "${attrValue}", does not contain "${p.value}"`);
      if (p.matchType !== 'contains' && attrValue !== p.value) throw new Error(`Attribute "${p.attribute}" is "${attrValue}", expected "${p.value}"`);
      return { message: `Attribute "${p.attribute}" = "${attrValue}"` };
    }

    case 'assertCSS': {
      const cssValue = await getLocator(pageOrFrame, p).evaluate((el, prop) => window.getComputedStyle(el).getPropertyValue(prop), p.property);
      if (p.matchType === 'contains' && !cssValue.includes(p.value)) throw new Error(`CSS "${p.property}" is "${cssValue}", does not contain "${p.value}"`);
      if (p.matchType !== 'contains' && cssValue.trim() !== (p.value || '').trim()) throw new Error(`CSS "${p.property}" is "${cssValue}", expected "${p.value}"`);
      return { message: `CSS "${p.property}" = "${cssValue}"` };
    }

    case 'clearField': {
      await getLocator(pageOrFrame, p).clear();
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
        throw new Error(`Visual difference: ${diffPercent}% pixels changed (${numDiffPixels} pixels)`);
      }
      return {
        message: `Visual match: ${diffPercent}% difference (within threshold)`,
        screenshot: screenshotBuf.toString('base64'),
        diffImage: diffBase64,
        diffPercent: parseFloat(diffPercent)
      };
    }

    // switchFrame and exitFrame are handled in executeScenario loop, not here
    case 'switchFrame':
    case 'exitFrame':
      return { message: 'Frame context already handled' };

    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

function getLocator(pageOrFrame, p) {
  if (!p.selector) throw new Error('Selector is required');
  if (p.selectorType === 'text') return pageOrFrame.getByText(p.selector, { exact: false }).first();
  if (p.selectorType === 'id') return pageOrFrame.locator(`#${p.selector}`).first();
  return pageOrFrame.locator(p.selector).first();
}

function resolveSelector(p) {
  if (!p || !p.selector) return null;
  if (p.selectorType === 'id') return `#${p.selector}`;
  return p.selector;
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
    case 'assertAttribute': return `Assert "${p.selector || ''}" attr "${p.attribute || ''}" ${p.matchType || 'exact'} "${p.value || ''}"`;
    case 'assertCSS':       return `Assert "${p.selector || ''}" CSS "${p.property || ''}" ${p.matchType || 'exact'} "${p.value || ''}"`;
    case 'clearField':      return `Clear field "${p.selector || ''}"`;
    case 'switchFrame':     return `Switch to iframe "${p.selector || ''}"`;
    case 'exitFrame':       return 'Exit iframe back to main page';
    case 'waitForNetwork':  return `Wait for network idle (${p.timeout || 5000}ms)`;
    case 'waitSeconds':       return `Wait ${p.seconds || 3}s`;
    case 'assertElementSize': return `Assert "${p.selector || ''}" ${p.dimension || 'height'} = ${p.expected ?? '?'}% ±${p.tolerance ?? 2}%`;
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
}

// ─── REPORT HTML GENERATOR ────────────────────────────────────────────────────

function generateReportHTML(run) {
  const statusColor = run.status === 'passed' ? '#22c55e' : run.status === 'failed' ? '#ef4444' : '#f59e0b';
  const browserIcon = run.browser === 'firefox' ? '🦊' : run.browser === 'webkit' ? '🧭' : '🌐';
  const deviceIcon = run.device?.startsWith('mobile') ? '📱' : run.device?.startsWith('tablet') ? '📲' : run.device?.startsWith('laptop') ? '💻' : '🖥️';

  const scenarioRows = (run.scenarioResults || []).map(sr => {
    const stepsHTML = sr.steps.map((step, idx) => {
      const icon = step.status === 'passed' ? '✅' : step.status === 'failed' ? '❌' : '⏭️';
      const screenshotHTML = step.screenshot
        ? `<div style="margin-top:8px"><img src="data:image/png;base64,${step.screenshot}" style="max-width:100%;border-radius:4px;border:1px solid #e2e8f0" /></div>`
        : '';
      return `<tr>
        <td style="padding:8px 12px;color:#64748b;font-size:13px">${idx + 1}</td>
        <td style="padding:8px 12px;font-size:13px">${icon} ${escapeHtml(step.description || step.type)}</td>
        <td style="padding:8px 12px;font-size:13px;color:#64748b">${escapeHtml(step.message || '')}</td>
        <td style="padding:8px 12px;font-size:13px;color:#64748b">${step.duration || 0}ms</td>
      </tr>${screenshotHTML ? `<tr><td colspan="4" style="padding:8px 12px">${screenshotHTML}</td></tr>` : ''}`;
    }).join('');

    const srColor = sr.status === 'passed' ? '#22c55e' : sr.status === 'failed' ? '#ef4444' : '#f59e0b';
    return `<div style="margin-bottom:24px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
      <div style="background:#f8fafc;padding:12px 16px;display:flex;justify-content:space-between;align-items:center">
        <strong style="font-size:15px">${escapeHtml(sr.scenarioName || 'Scenario')}</strong>
        <span style="background:${srColor};color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600">${sr.status.toUpperCase()}</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:#f1f5f9">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b">#</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b">Step</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b">Message</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b">Duration</th>
        </tr></thead>
        <tbody>${stepsHTML}</tbody>
      </table>
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
  .content { max-width: 1000px; margin: 32px auto; padding: 0 24px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .stat { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
  .stat .label { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: .5px; }
  .stat .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
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

app.listen(PORT, () => {
  console.log(`Verifai running on port ${PORT}`);
  console.log(`Data: ${DATA_DIR}`);
  initSchedules();
});
