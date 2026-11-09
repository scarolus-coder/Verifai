# Verifai — Onboarding Guide

## What it is and why it exists

Verifai is an in-house, no-code QA test automation tool. It was built to replace our AccelQ license, which we chose not to renew. Its job is to house test cases for **Pharma** and run automated regression tests whenever they push a production deploy — using Playwright under the hood to drive real browsers.

It's not a ticket-tracking tool and not a design/frontend-heavy tool. It's purpose-built to protect core workflows and processes: making sure common functionality didn't break after a deploy. Pharma currently has **5 sites** running on it.

For how to *use* the app (projects, scenarios, suites, schedules, reports, etc.), see [GUIDE.md](GUIDE.md). This doc is about how it's *built*.

---

## Architecture at a glance

Verifai is a single Express app that both serves a static SPA and exposes a JSON REST API — there's no separate frontend framework, no route-file split, and no ORM. Almost everything lives in one file:

- `server.js` (~2,900 lines) — the entire backend: auth, all API routes, scenario execution engine, cron scheduler, visual diffing, embedded browser control, SSE streaming.
- `public/app.js` (~5,300 lines) — the frontend SPA (vanilla JS, no framework).
- `public/recorder.js` — the bookmarklet-style script used for one of the two "Studio" recording flows (see below).
- `public/index.html`, `public/style.css` — markup/styles.
- `email.js` — thin wrapper around AWS SES for report/notification emails.

Request flow: `express.json()` + `compression()` middleware → per-route `requireAuth` / `requireAdmin` middleware (JWT-based) → handler reads/writes JSON files directly → response.

## Data storage

There is **no database**. All data is flat JSON files under `/var/www/config/data`: `projects.json`, `scenarios.json`, `suites.json`, `runs.json`, `runs-summary.json`, `users.json`, `actions.json`, `schedules.json`, `environments.json`, plus a `runs/` subdirectory with one JSON file per run. Reads/writes are synchronous (`fs.readFileSync`/`writeFileSync`) with no locking — every request that touches data reads and rewrites the whole file. Visual regression baselines are PNGs on disk, keyed by project.

This is fine at current scale (5 sites) but won't hold up well under heavy concurrent writes.

## Authentication

Local auth via `bcryptjs` + `jsonwebtoken` — no session store; the JWT is the only session state.

- First user to register (when `users.json` is empty) becomes **admin** via a one-time setup flow.
- Everyone after that registers as a **member**.
- Passwords are hashed with bcrypt; JWTs carry `{id, email, name, role}`.
- ⚠️ The JWT secret has an insecure hardcoded fallback in code — confirm `JWT_SECRET` is actually set via environment in production.

## How a test scenario actually runs

Scenarios are stored as JSON: a `steps` array of `{type, params, ...}` objects. There's no code-generation step — Playwright is driven **programmatically, step by step, at run time**. A run:

1. Launches a real Playwright browser (Chromium/Firefox/WebKit).
2. Resolves templated variables (decrypting any `secret`-type variables).
3. Loops through steps, dispatching each to a big `switch` covering ~35 step kinds (navigate, click, type, assertions, visual baseline, iframe/tab handling, etc.).
4. Runs asynchronously in the background; the client gets a `runId` immediately and polls/streams progress over Server-Sent Events.
5. Results are persisted both as a full per-run JSON file and a lightweight summary row for list views.

## The "Studio" recording flow

There are actually **two distinct, unrelated mechanisms** behind what looks like one feature in the UI — worth knowing before debugging Studio issues:

1. **Bookmarklet recorder** (`public/recorder.js`) — injected directly into the *target site's own page*, watches real DOM events, and POSTs captured steps back to the server over SSE.
2. **Embedded automation browser** — a server-side headless Playwright session that screenshots the page as a JPEG, sends it to the frontend, and receives back click/type coordinates which get translated into real Playwright actions. This is a screenshot + coordinate remote-control loop, not a live iframe/proxy.

Both types of sessions live only in memory and auto-expire (1–2 hours), and don't survive a server restart.

## Scheduling

Uses `node-cron` directly — no queue or worker process. UI frequency options get converted into cron expressions and registered as in-memory cron tasks. Since these are just process-memory timers, schedules need to be re-registered from `schedules.json` on server boot; a restart drops any currently-running in-memory state.

## Visual regression

The "Visual Baseline" step uses `pngjs` to decode screenshots and `pixelmatch` to diff them pixel-by-pixel against a saved baseline, failing the step if the difference exceeds a configurable threshold. First run for a given baseline just saves it — nothing to compare against yet.

## Email

`email.js` wraps AWS SES to send report emails and schedule notifications to whatever addresses a user configures.

## Build & deploy

There's no bundler/framework. Source files are plain JS/CSS, but `index.html` references the **minified** `public/dist/` versions — so source edits require a rebuild to take effect:

- `npm run build` — minifies `app.js`/`recorder.js` with terser and `style.css` with clean-css into `public/dist/`.
- `npm start` — runs the build, installs Playwright browser binaries (Chromium + WebKit), then starts `server.js`.

## Things to know before touching this code

- **It's a true monolith.** All backend logic lives in one file with no service/model layer — navigate by section-comment banners, not by file structure.
- **No transactional storage.** JSON file read-modify-write isn't atomic; concurrent writes can race.
- **Frontend build is mandatory**, not a dev convenience — editing `app.js` directly does nothing until you rebuild.
- **In-memory state doesn't survive restarts** — active recording sessions, embedded browser sessions, and cron task registrations are all plain in-process maps.
- Some dependencies (`pixelmatch`, `pngjs`, `pdf-parse`) are optionally required — a missing package fails at step-execution time, not at startup, so verify these are actually installed in whatever environment you're testing in.
