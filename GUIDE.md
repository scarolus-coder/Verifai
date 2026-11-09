# Verifai – User Guide

Verifai is a no-code QA testing platform. You build test scenarios by pointing and clicking on a live website, then run them automatically across browsers and devices — no programming required.

---

## Getting Started

### Creating an Account
1. Open Verifai in your browser.
2. Click **Create one** below the Sign In button.
3. Enter your name, email, and a password (8+ characters).
4. You'll be logged in automatically as a **Member**.

> The very first person to visit the site completes a one-time admin setup instead of the normal registration flow.

### Roles
| Role | Can do |
|------|--------|
| **Admin** | Everything — manage all users, all projects, all content |
| **Member** | Create and manage their own projects; access projects shared with them |

---

## Projects

Projects are the top-level containers. Everything — scenarios, suites, runs — belongs to a project.

### Create a Project
1. Go to the **Dashboard** or **Projects** page.
2. Click **+ New Project**.
3. Give it a name, optional description, a base URL (the root of the site you're testing), and a colour.
4. Click **Save**.

### Share a Project with Other Members
1. On the Projects page, find the project card.
2. Click **Share**.
3. Add members from the list. They'll immediately be able to see and use the project.

### Switch Projects
Use the **project picker** in the top bar to filter the whole app to one project, or choose **All Projects** to see everything you have access to.

---

## Scenarios

A scenario is a single test case — a sequence of steps that mimics what a user would do on a website.

### Create a Scenario
1. Go to **Scenarios** → **+ New Scenario**.
2. Enter a name, optional description, test type, and tags.
3. Click **Open Builder** to start adding steps.

### The Scenario Builder

The builder has two modes:

**Manual mode** — click **+ Add Step** to pick a step type from the list and configure it.

**Live / Studio mode** — click **Open Studio** to load your site inside an embedded browser frame. Click any element on the page and a command menu appears letting you instantly add the right step for that element (click, type, assert text, etc.). This is the fastest way to build tests.

**🤖 AI Agent mode** — the fastest way to build a test with zero clicking. Type a starting URL and one plain-English instruction — e.g. *"Go to https://example.com and ensure the dropdown menus go to the correct pages"*, *"check example.com/pricing for accessibility issues"*, or *"make sure dev.example.com matches prod on example.com"* — and click **Run Agent**. It opens the real site in a live browser, figures out what to click and check on its own (including running a real accessibility scan when asked), and streams the resulting steps straight into your scenario as it works. When it's done, review the steps in **🔧 Step Builder** like any other scenario and save. Requires an `ANTHROPIC_API_KEY` to be configured on the server.

**✨ Suggest this step** — in Studio, with the live browser open, type one sentence describing a single step (e.g. *"click the submit button"*) and hit **Suggest**. It finds the real element, executes it live to confirm it actually works, and adds the step for you — no need to know which step type or selector to use.

**🔍 Diagnose** — available in two places: on a failed step in a run report (replays up to that step, inspects the live selector, and explains why it likely failed), and live in Studio right after a step fails during **Step Through** (inspects the page exactly as it is at that moment — no replay needed). Both give a concrete suggested fix when confident enough to offer one.

> **A note on accessibility scans:** both the AI Agent and the manual **Accessibility Scan** step use axe-core, which reliably catches only a portion of WCAG 2.2 AA (roughly 30-57% of criteria) — things like keyboard operability, focus order, and alt-text *quality* can't be judged by a tool. A passing scan means "no mechanical failures found," not "this page is accessible." Treat it as a floor, not a sign-off.

#### Common Step Types
| Step | What it does |
|------|--------------|
| **Navigate** | Go to a URL |
| **Click** | Click a button, link, or any element |
| **Type** | Type text into a field |
| **Clear Field** | Erase an input |
| **Select Option** | Choose from a dropdown |
| **Press Key** | Send a keyboard key (Enter, Tab, Escape, etc.) |
| **Assert Text** | Verify that an element contains specific text |
| **Assert Visible** | Verify that an element exists on the page |
| **Assert URL** | Verify the current page URL |
| **Assert Attribute** | Verify an element's HTML attribute value |
| **Assert CSS** | Verify a computed CSS style value |
| **Wait For** | Pause until an element appears |
| **Wait Network Idle** | Wait until all network requests finish |
| **Wait (seconds)** | Pause for a fixed number of seconds |
| **Screenshot** | Capture a screenshot at this point |
| **Visual Baseline** | Compare screenshot to a saved baseline |
| **Accessibility Scan** | Run a real WCAG 2.2 AA scan (axe-core) on the page or one element; fails the step on violations at or above a chosen severity |
| **Compare URLs** | Pixel-diff this page against another live URL (e.g. a dev URL vs its prod equivalent) — screenshots both and fails on excess pixel difference |
| **Hover** | Hover the mouse over an element |
| **Scroll** | Scroll the page |
| **Scroll To Element** | Scroll an element into view |
| **Switch Frame** | Enter an iframe |
| **New Tab** | Click a link that opens a new tab |
| **Switch to New Tab** | Move focus to the new tab |
| **Close Tab** | Close the current tab |
| **File Download** | Verify a file download occurs |
| **Assert PDF Contains** | Download a PDF and check its text content |
| **Run JavaScript** | Execute custom JS on the page |
| **Use Action** | Run a saved reusable group of steps |

### Selectors
Each step that targets an element needs a selector. Verifai supports:
- **CSS selector** — e.g. `#submit-btn`, `.nav-link`
- **XPath** — e.g. `//button[text()='Submit']`
- **Text content** — matches by visible text
- **ARIA label** — matches by accessibility label

When using Studio mode, the selector is filled in automatically.

### Variables
Scenarios support `{{variableName}}` placeholders in any text field. Define variables in the **Variables** tab of the builder. Variables can be:
- **Text** — a plain string value used as-is
- **Secret** — stored encrypted; masked in the UI (use for passwords)

### Running a Scenario
From the Scenarios list, click **▶ Run**. Choose your browser, device/viewport, and optionally an environment, then click **Run Test**. A live console shows progress step by step.

---

## Suites

A suite groups multiple scenarios to run together in sequence — useful for full regression runs.

### Create a Suite
1. Go to **Suites** → **+ New Suite**.
2. Name it and assign it to a project.
3. Click **+ Add Scenarios** to pick which scenarios to include and set their order.

### Run a Suite
Click **▶ Run** on the suite. You can choose browser, device, environment, and optionally enter **Notify Emails** — comma-separated addresses that will receive a report email automatically when the run finishes.

### Re-run Failed Tests
After a suite run, if any scenarios failed you'll see a **↺ Re-run Failed** button on the report. This re-runs only the failed scenarios and merges the results back into the original run.

---

## Reports

Every run — whether triggered manually or by a schedule — generates a report.

- **Reports page** — lists all runs with status, pass rate, browser, and date.
- Click any run to open the **full report** showing per-scenario and per-step results, screenshots, and timing.
- **Share Report** — copies a direct URL to the report (no login required to view shared reports).
- **Email Report** — sends the report to one or more email addresses with a summary and a link.

---

## Schedules

Schedules run a scenario or suite automatically on a recurring basis — no browser tab needs to be open.

### Create a Schedule
1. Go to **Schedules** → **+ New Schedule**.
2. Choose a **target** (scenario or suite) and a **frequency** (hourly, every 6h, every 12h, daily, weekly, or custom cron).
3. Pick browser, device, and timezone.
4. Optionally enter **Notify Emails** — addresses that receive the report automatically after each run.
5. Toggle **Enabled** on and click **Create Schedule**.

Schedules run as long as the server is running. Results appear in Reports.

---

## Environments

Environments let you switch the base URL without editing every scenario — useful for testing staging vs. production.

### Create an Environment
1. Go to **Environments** → **+ New Environment**.
2. Enter a name and base URL (e.g. `https://staging.example.com`).
3. Optionally set HTTP Basic Auth credentials if the environment is behind a login wall.
4. Mark it as **Default** to pre-select it when running tests.

When you run a scenario or suite with an environment selected, `{{baseUrl}}` in your steps is replaced with the environment's URL.

---

## Actions (Reusable Step Groups)

Actions are reusable groups of steps — like a "Login" sequence you'd rather not rebuild in every scenario.

### Create an Action
1. Go to **Actions** → **+ New Action**.
2. Build the steps just like a scenario.
3. Save it.

### Use an Action in a Scenario
Add a **Use Action** step and select the action from the dropdown. When the scenario runs, those steps are executed inline.

---

## User Management *(Admin only)*

1. Go to **Users** (accessible from the user menu or sidebar if you're an admin).
2. **Invite User** — create an account for someone directly (they receive their credentials separately).
3. **Edit** — change a user's name, email, or promote them to admin.
4. **Delete** — remove a user.

Members can also self-register via the **Create one** link on the login page.

---

## Tips

- **Clone a scenario** using the ⧉ button on the scenario list — great for creating variants without starting from scratch.
- **Tags** on scenarios let you filter and organise large test libraries.
- **Data-driven testing** — if a scenario has variables, an **⚡ Data** button appears. Upload a CSV (one row per test run, headers = variable names) to run the scenario multiple times with different data.
- **Visual baseline testing** — use the **Visual Baseline** step to capture a reference screenshot. On future runs, Verifai compares against it and flags visual differences.
- Selector tip: prefer **ARIA labels** or stable **IDs** over fragile CSS class names — they break less often when the UI changes.
