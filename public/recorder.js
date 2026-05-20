/* ═══════════════════════════════════════════════════════════
   Verifai – Browser Recorder Bookmarklet Script
   Served publicly at /recorder.js (no auth required)
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__QA_RECORDER_ACTIVE__) {
    alert('QA Recorder is already running on this page.');
    return;
  }
  window.__QA_RECORDER_ACTIVE__ = true;

  // ─── DETERMINE QA STUDIO ORIGIN ──────────────────────────────────────────────
  // Injected by bookmarklet via data attribute on the script tag
  const scriptTag = document.querySelector('script[data-qa-studio]');
  const QA_STUDIO_URL = (scriptTag && scriptTag.getAttribute('data-qa-studio')) ||
    window.__QA_STUDIO_URL__ ||
    'http://localhost:3000';

  // ─── LIVE SESSION ─────────────────────────────────────────────────────────────
  const SESSION_ID = (scriptTag && scriptTag.getAttribute('data-session-id')) || null;
  const SESSION_TOKEN = (scriptTag && scriptTag.getAttribute('data-session-token')) || null;

  function postStepToSession(step) {
    if (!SESSION_ID || !SESSION_TOKEN) return;
    fetch(`${QA_STUDIO_URL}/api/recording-sessions/${SESSION_ID}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: SESSION_TOKEN, step })
    }).catch(() => {});
  }

  // ─── STATE ────────────────────────────────────────────────────────────────────
  let steps = [];
  let recording = true;
  let previewOpen = false;
  let highlightEl = null;
  let highlightBox = null;
  let highlightTooltip = null;
  const STORAGE_KEY = 'qa_recording';

  // ─── RESTORE FROM SESSION STORAGE ────────────────────────────────────────────
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        steps = parsed;
      }
    }
  } catch (e) { /* ignore */ }

  // ─── SAVE TO SESSION STORAGE ──────────────────────────────────────────────────
  function persist() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(steps)); } catch (e) { /* ignore */ }
  }

  window.addEventListener('beforeunload', persist);

  // ─── SMART SELECTOR ───────────────────────────────────────────────────────────

  function generateSelector(el) {
    if (!el || el === document.body || el === document.documentElement) {
      return { selector: 'body', selectorType: 'css', strategy: 'tag', unique: true };
    }

    // 1. data-testid / data-cy / data-test / data-qa
    for (const attr of ['data-testid', 'data-cy', 'data-test', 'data-qa']) {
      const val = el.getAttribute(attr);
      if (val) {
        return { selector: '[' + attr + '="' + val + '"]', selectorType: 'css', strategy: attr, unique: true };
      }
    }

    // 2. Unique ID
    if (el.id) {
      try {
        const matches = document.querySelectorAll('#' + CSS.escape(el.id));
        if (matches.length === 1) {
          return { selector: el.id, selectorType: 'id', strategy: 'id', unique: true };
        }
      } catch (e) { /* invalid id, skip */ }
    }

    // 3. aria-label
    const aria = el.getAttribute('aria-label');
    if (aria) {
      const ariaMatches = document.querySelectorAll('[aria-label="' + aria.replace(/"/g, '\\"') + '"]');
      if (ariaMatches.length === 1) {
        return { selector: '[aria-label="' + aria + '"]', selectorType: 'css', strategy: 'aria-label', unique: true };
      }
    }

    // 4. Text content (buttons, links, labels only)
    const text = (el.textContent || '').trim().slice(0, 80);
    const isInteractive = ['BUTTON', 'A', 'LABEL', 'SUMMARY'].includes(el.tagName) || el.getAttribute('role') === 'button';
    if (text && isInteractive) {
      const byText = Array.from(document.querySelectorAll(el.tagName)).filter(function (e) {
        return e.textContent.trim() === text;
      });
      if (byText.length === 1) {
        return { selector: text, selectorType: 'text', strategy: 'text', unique: true };
      }
      // Multiple elements with same text — find unique parent context
      const parentCtx = findUniqueParent(el, text);
      if (parentCtx) {
        return {
          selector: parentCtx.selector,
          selectorType: 'css',
          strategy: 'context',
          unique: true,
          warning: null,
          description: '"' + text + '" in ' + parentCtx.label
        };
      }
      // Fallback: nth position
      const idx = byText.indexOf(el);
      return {
        selector: el.tagName.toLowerCase() + ':nth-of-type(' + (idx + 1) + ')',
        selectorType: 'css',
        strategy: 'nth',
        unique: false,
        warning: byText.length + ' elements share the text "' + text + '" — using position ' + (idx + 1) + '. Consider adding a unique ID or data-testid to this element.'
      };
    }

    // 5. Placeholder (inputs)
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) {
      const phMatches = document.querySelectorAll('[placeholder="' + placeholder.replace(/"/g, '\\"') + '"]');
      if (phMatches.length === 1) {
        return { selector: '[placeholder="' + placeholder + '"]', selectorType: 'css', strategy: 'placeholder', unique: true };
      }
    }

    // 6. Name attribute (form fields)
    const name = el.getAttribute('name');
    if (name) {
      const nameMatches = document.querySelectorAll('[name="' + name.replace(/"/g, '\\"') + '"]');
      if (nameMatches.length === 1) {
        return { selector: '[name="' + name + '"]', selectorType: 'css', strategy: 'name', unique: true };
      }
    }

    // 7. Build shortest unique CSS path
    return buildCSSPath(el);
  }

  function findUniqueParent(el, text) {
    let parent = el.parentElement;
    for (let depth = 0; depth < 4 && parent && parent !== document.body; depth++) {
      const candidates = ['id', 'data-testid', 'data-section'];
      for (const attr of candidates) {
        const val = parent.getAttribute(attr);
        if (val) {
          let sel;
          if (attr === 'id') {
            try { sel = '#' + CSS.escape(val) + ' ' + el.tagName.toLowerCase(); } catch (e) { continue; }
          } else {
            sel = '[' + attr + '="' + val.replace(/"/g, '\\"') + '"] ' + el.tagName.toLowerCase();
          }
          try {
            const matches = document.querySelectorAll(sel);
            if (matches.length === 1) return { selector: sel, label: (attr === 'id' ? '#' : '.') + val };
          } catch (e) { /* ignore */ }
        }
      }
      const cls = Array.from(parent.classList).find(function (c) {
        return c.length > 3 && !c.match(/^(d-|col-|row|flex|mt-|mb-|p-|px-|py-)/);
      });
      if (cls) {
        try {
          const sel = '.' + CSS.escape(cls) + ' ' + el.tagName.toLowerCase();
          const matches = document.querySelectorAll(sel);
          if (matches.length === 1) return { selector: sel, label: '.' + cls };
        } catch (e) { /* ignore */ }
      }
      parent = parent.parentElement;
    }
    return null;
  }

  function buildCSSPath(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.body) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        try {
          part = '#' + CSS.escape(current.id);
          parts.unshift(part);
          break;
        } catch (e) { /* fall through */ }
      }
      const siblings = Array.from(current.parentElement ? current.parentElement.children : []).filter(function (s) {
        return s.tagName === current.tagName;
      });
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      parts.unshift(part);
      const sel = parts.join(' > ');
      try {
        if (document.querySelectorAll(sel).length === 1) break;
      } catch (e) { break; }
      current = current.parentElement;
    }
    const selector = parts.join(' > ');
    let unique = false;
    try { unique = document.querySelectorAll(selector).length === 1; } catch (e) { /* ignore */ }
    return {
      selector: selector,
      selectorType: 'css',
      strategy: 'path',
      unique: unique,
      warning: 'CSS path selector — may be fragile if page structure changes. Add a data-testid to this element for more reliable testing.'
    };
  }

  // ─── STEP DESCRIPTION ────────────────────────────────────────────────────────

  function describeStep(step) {
    switch (step.type) {
      case 'navigate':     return 'Navigate to ' + (step.params.url || '');
      case 'click':        return 'Click ' + formatSelector(step);
      case 'type':         return 'Type into ' + formatSelector(step) + ' → "' + (step.params.value || '').slice(0, 40) + '"';
      case 'selectOption': return 'Select "' + (step.params.value || '') + '" in ' + formatSelector(step);
      case 'assertVisible': return 'Assert visible: ' + formatSelector(step);
      case 'assertText':   return 'Assert text "' + (step.params.expected || '').slice(0, 40) + '" on ' + formatSelector(step);
      case 'screenshot':   return 'Take screenshot';
      case 'hover':        return 'Hover over ' + formatSelector(step);
      default:             return step.type;
    }
  }

  function formatSelector(step) {
    const sel = step.params.selector || step.params.value || '';
    const type = step._selectorStrategy || '';
    if (type === 'text') return '"' + sel.slice(0, 40) + '"';
    if (type === 'id') return '#' + sel.slice(0, 40);
    return sel.slice(0, 50);
  }

  function stepIcon(type) {
    const icons = {
      navigate: '🌐', click: '🖱', type: '⌨', selectOption: '🔽',
      assertVisible: '👁', assertText: '📝', screenshot: '📷', hover: '✋'
    };
    return icons[type] || '•';
  }

  // ─── TOOLBAR HTML ────────────────────────────────────────────────────────────

  const TOOLBAR_ID = '__qa_recorder_toolbar__';
  const TOOLBAR_STYLE = `
    position: fixed;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 10px;
    padding: 8px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px;
    color: #e2e8f0;
    box-shadow: 0 4px 24px rgba(0,0,0,.5);
    white-space: nowrap;
    user-select: none;
  `;

  const BTN_STYLE = `
    background: #334155;
    border: none;
    color: #e2e8f0;
    padding: 5px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
    transition: background .15s;
  `;

  const BTN_PRIMARY_STYLE = `
    background: #3b82f6;
    border: none;
    color: #fff;
    padding: 5px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
    transition: background .15s;
  `;

  const BTN_DANGER_STYLE = `
    background: #ef4444;
    border: none;
    color: #fff;
    padding: 5px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
    transition: background .15s;
  `;

  function createToolbar() {
    const existing = document.getElementById(TOOLBAR_ID);
    if (existing) existing.remove();

    const bar = document.createElement('div');
    bar.id = TOOLBAR_ID;
    bar.setAttribute('style', TOOLBAR_STYLE);

    bar.innerHTML = buildToolbarHTML();
    document.body.appendChild(bar);
    attachToolbarEvents(bar);
  }

  function buildToolbarHTML() {
    const recLabel = recording
      ? '<span style="color:#ef4444;font-size:16px;line-height:1">●</span> Recording'
      : '<span style="color:#f59e0b;font-size:16px;line-height:1">⏸</span> Paused';
    const stepBadge = steps.length > 0
      ? '<span style="background:#3b82f6;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;margin-left:2px">' + steps.length + ' steps</span>'
      : '';
    const hint = '<span style="color:#64748b;font-size:11px;margin-left:4px">Shift+Click to assert</span>';

    return `
      <span style="font-size:13px;font-weight:600">🎬 QA Recorder</span>
      <span style="color:#475569;margin:0 2px">|</span>
      <span id="__qa_rec_status__" style="display:flex;align-items:center;gap:6px;">${recLabel}${stepBadge}</span>
      ${hint}
      <span style="color:#475569;margin:0 2px">|</span>
      <button id="__qa_btn_toggle__" style="${BTN_STYLE}">${recording ? '⏸ Pause' : '● Record'}</button>
      <button id="__qa_btn_undo__" style="${BTN_STYLE}">↩ Undo</button>
      <button id="__qa_btn_preview__" style="${BTN_STYLE}">👁 Preview</button>
      <button id="__qa_btn_send__" style="${BTN_PRIMARY_STYLE}">📋 Send to Verifai</button>
      <button id="__qa_btn_stop__" style="${BTN_DANGER_STYLE}">✕</button>
    `;
  }

  function updateToolbarStatus() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) return;
    const statusEl = document.getElementById('__qa_rec_status__');
    const toggleBtn = document.getElementById('__qa_btn_toggle__');
    if (!statusEl || !toggleBtn) return;

    const recLabel = recording
      ? '<span style="color:#ef4444;font-size:16px;line-height:1">●</span> Recording'
      : '<span style="color:#f59e0b;font-size:16px;line-height:1">⏸</span> Paused';
    const stepBadge = steps.length > 0
      ? ' <span style="background:#3b82f6;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">' + steps.length + ' steps</span>'
      : '';
    statusEl.innerHTML = recLabel + stepBadge;
    toggleBtn.textContent = recording ? '⏸ Pause' : '● Record';
  }

  function attachToolbarEvents(bar) {
    bar.addEventListener('click', function (e) {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.id === '__qa_btn_toggle__') { recording = !recording; updateToolbarStatus(); }
      else if (btn.id === '__qa_btn_undo__') { undoLastStep(); }
      else if (btn.id === '__qa_btn_preview__') { togglePreview(); }
      else if (btn.id === '__qa_btn_send__') { sendToStudio(); }
      else if (btn.id === '__qa_btn_stop__') { stopRecorder(); }
    });
  }

  // ─── HIGHLIGHT OVERLAY ────────────────────────────────────────────────────────

  function ensureHighlightElements() {
    if (!highlightBox) {
      highlightBox = document.createElement('div');
      highlightBox.setAttribute('style', `
        position: fixed;
        pointer-events: none;
        z-index: 2147483646;
        border: 2px solid #3b82f6;
        border-radius: 3px;
        background: rgba(59,130,246,.08);
        transition: all .05s;
        display: none;
      `);
      document.body.appendChild(highlightBox);
    }
    if (!highlightTooltip) {
      highlightTooltip = document.createElement('div');
      highlightTooltip.setAttribute('style', `
        position: fixed;
        pointer-events: none;
        z-index: 2147483647;
        background: #1e293b;
        color: #e2e8f0;
        font-family: monospace;
        font-size: 11px;
        padding: 4px 8px;
        border-radius: 4px;
        border: 1px solid #334155;
        max-width: 300px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: none;
      `);
      document.body.appendChild(highlightTooltip);
    }
  }

  function showHighlight(el) {
    ensureHighlightElements();
    const rect = el.getBoundingClientRect();
    highlightBox.style.display = 'block';
    highlightBox.style.left = rect.left + 'px';
    highlightBox.style.top = rect.top + 'px';
    highlightBox.style.width = rect.width + 'px';
    highlightBox.style.height = rect.height + 'px';

    const sel = generateSelector(el);
    const label = sel.strategy === 'text' ? '"' + sel.selector.slice(0, 40) + '"' : sel.selector.slice(0, 50);
    highlightTooltip.textContent = '[' + sel.strategy + '] ' + label;
    highlightTooltip.style.display = 'block';

    const tipTop = rect.top - 28;
    highlightTooltip.style.left = Math.max(4, rect.left) + 'px';
    highlightTooltip.style.top = (tipTop < 0 ? rect.bottom + 4 : tipTop) + 'px';
  }

  function hideHighlight() {
    if (highlightBox) highlightBox.style.display = 'none';
    if (highlightTooltip) highlightTooltip.style.display = 'none';
  }

  // ─── EVENT LISTENERS ──────────────────────────────────────────────────────────

  // Mouseover — highlight hovered element
  document.addEventListener('mouseover', function (e) {
    if (!recording) return;
    const target = e.target;
    if (isRecorderElement(target)) return;
    showHighlight(target);
    highlightEl = target;
  }, true);

  document.addEventListener('mouseout', function (e) {
    if (isRecorderElement(e.target)) return;
    hideHighlight();
    highlightEl = null;
  }, true);

  // Click — record click or (shift+click) assertVisible
  document.addEventListener('click', function (e) {
    if (!recording) return;
    if (isRecorderElement(e.target)) return;

    const el = e.target;
    const selectorInfo = generateSelector(el);

    if (e.shiftKey) {
      // Assert visible
      e.preventDefault();
      e.stopPropagation();
      addStep({
        id: 'rec_' + Date.now(),
        type: 'assertVisible',
        params: buildParams(el, selectorInfo),
        _recorded: true,
        _selectorStrategy: selectorInfo.strategy,
        _selectorWarning: selectorInfo.warning || null
      });
    } else {
      addStep({
        id: 'rec_' + Date.now(),
        type: 'click',
        params: buildParams(el, selectorInfo),
        _recorded: true,
        _selectorStrategy: selectorInfo.strategy,
        _selectorWarning: selectorInfo.warning || null
      });
    }
  }, true);

  // Change — record type / selectOption
  document.addEventListener('change', function (e) {
    if (!recording) return;
    const el = e.target;
    if (isRecorderElement(el)) return;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;

    const selectorInfo = generateSelector(el);
    const isSelect = el.tagName === 'SELECT';

    addStep({
      id: 'rec_' + Date.now(),
      type: isSelect ? 'selectOption' : 'type',
      params: Object.assign(buildParams(el, selectorInfo), { value: el.value }),
      _recorded: true,
      _selectorStrategy: selectorInfo.strategy,
      _selectorWarning: selectorInfo.warning || null
    });
  }, true);

  // Right-click context menu
  document.addEventListener('contextmenu', function (e) {
    if (!recording) return;
    if (isRecorderElement(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, e.target);
  }, true);

  // Navigation via pushState / replaceState
  (function () {
    function wrapHistory(method) {
      const orig = history[method];
      history[method] = function () {
        const result = orig.apply(this, arguments);
        const url = arguments[2] || '';
        if (recording && url) {
          addStep({
            id: 'rec_' + Date.now(),
            type: 'navigate',
            params: { url: String(url) },
            _recorded: true,
            _selectorStrategy: 'url',
            _selectorWarning: null
          });
        }
        return result;
      };
    }
    wrapHistory('pushState');
    wrapHistory('replaceState');
  })();

  window.addEventListener('popstate', function () {
    if (!recording) return;
    addStep({
      id: 'rec_' + Date.now(),
      type: 'navigate',
      params: { url: window.location.href },
      _recorded: true,
      _selectorStrategy: 'url',
      _selectorWarning: null
    });
  });

  window.addEventListener('hashchange', function () {
    if (!recording) return;
    addStep({
      id: 'rec_' + Date.now(),
      type: 'navigate',
      params: { url: window.location.href },
      _recorded: true,
      _selectorStrategy: 'url',
      _selectorWarning: null
    });
  });

  // Record initial page navigation if no prior steps
  if (steps.length === 0) {
    addStep({
      id: 'rec_' + Date.now(),
      type: 'navigate',
      params: { url: window.location.href },
      _recorded: true,
      _selectorStrategy: 'url',
      _selectorWarning: null
    });
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────────

  function isRecorderElement(el) {
    if (!el) return false;
    const toolbar = document.getElementById(TOOLBAR_ID);
    const preview = document.getElementById('__qa_recorder_preview__');
    const ctx = document.getElementById('__qa_context_menu__');
    return (toolbar && toolbar.contains(el)) ||
      (preview && preview.contains(el)) ||
      (ctx && ctx.contains(el)) ||
      el === highlightBox ||
      el === highlightTooltip;
  }

  function buildParams(el, selectorInfo) {
    const params = {};
    if (selectorInfo.selectorType === 'id') {
      params.selectorType = 'id';
      params.selector = selectorInfo.selector;
    } else if (selectorInfo.selectorType === 'text') {
      params.selectorType = 'text';
      params.selector = selectorInfo.selector;
    } else {
      params.selectorType = 'css';
      params.selector = selectorInfo.selector;
    }
    return params;
  }

  function addStep(step) {
    steps.push(step);
    persist();
    postStepToSession(step);
    updateToolbarStatus();
    if (previewOpen) renderPreviewPanel();
  }

  function undoLastStep() {
    if (steps.length === 0) return;
    steps.pop();
    persist();
    updateToolbarStatus();
    if (previewOpen) renderPreviewPanel();
  }

  // ─── CONTEXT MENU ────────────────────────────────────────────────────────────

  function showContextMenu(x, y, targetEl) {
    removeContextMenu();
    const menu = document.createElement('div');
    menu.id = '__qa_context_menu__';
    menu.setAttribute('style', `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      z-index: 2147483647;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,.5);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      color: #e2e8f0;
      min-width: 180px;
      overflow: hidden;
    `);

    const items = [
      { label: '📝 Assert text here', action: 'assertText' },
      { label: '👁 Assert visible', action: 'assertVisible' },
      { label: '🎨 Inspect CSS values…', action: 'inspectCSS' },
      { label: '🔍 Assert attribute…', action: 'assertAttribute' },
      { label: '📷 Screenshot here', action: 'screenshot' },
      { divider: true },
      { label: '✕ Cancel', action: 'cancel' }
    ];

    items.forEach(function (item) {
      if (item.divider) {
        const d = document.createElement('div');
        d.setAttribute('style', 'height:1px;background:#334155;margin:2px 0;');
        menu.appendChild(d);
        return;
      }
      const opt = document.createElement('div');
      opt.textContent = item.label;
      opt.setAttribute('style', `
        padding: 9px 14px;
        cursor: pointer;
        transition: background .1s;
      `);
      opt.addEventListener('mouseenter', function () { opt.style.background = '#334155'; });
      opt.addEventListener('mouseleave', function () { opt.style.background = ''; });
      opt.addEventListener('click', function () {
        removeContextMenu();
        handleContextAction(item.action, targetEl);
      });
      menu.appendChild(opt);
    });

    document.body.appendChild(menu);

    // Close on outside click
    setTimeout(function () {
      document.addEventListener('click', function onOutside(e) {
        if (!menu.contains(e.target)) {
          removeContextMenu();
          document.removeEventListener('click', onOutside);
        }
      });
    }, 50);
  }

  function removeContextMenu() {
    const el = document.getElementById('__qa_context_menu__');
    if (el) el.remove();
  }

  function handleContextAction(action, targetEl) {
    if (action === 'cancel') return;
    const selectorInfo = generateSelector(targetEl);
    const params = buildParams(targetEl, selectorInfo);

    if (action === 'screenshot') {
      addStep({
        id: 'rec_' + Date.now(),
        type: 'screenshot',
        params: {},
        _recorded: true,
        _selectorStrategy: 'n/a',
        _selectorWarning: null
      });
    } else if (action === 'assertText') {
      const text = (targetEl.textContent || '').trim().slice(0, 200);
      addStep({
        id: 'rec_' + Date.now(),
        type: 'assertText',
        params: Object.assign({}, params, { expected: text }),
        _recorded: true,
        _selectorStrategy: selectorInfo.strategy,
        _selectorWarning: selectorInfo.warning || null
      });
    } else if (action === 'assertVisible') {
      addStep({
        id: 'rec_' + Date.now(),
        type: 'assertVisible',
        params: params,
        _recorded: true,
        _selectorStrategy: selectorInfo.strategy,
        _selectorWarning: selectorInfo.warning || null
      });
    } else if (action === 'assertAttribute') {
      const attr = prompt('Attribute name to assert (e.g. href, disabled, value):');
      if (!attr) return;
      const attrVal = targetEl.getAttribute(attr) || '';
      addStep({
        id: 'rec_' + Date.now(),
        type: 'assertAttribute',
        params: Object.assign({}, params, { attribute: attr, expected: attrVal }),
        _recorded: true,
        _selectorStrategy: selectorInfo.strategy,
        _selectorWarning: selectorInfo.warning || null
      });
    } else if (action === 'inspectCSS') {
      showCSSInspector(targetEl, selectorInfo, params);
    }
  }

  // ─── CSS INSPECTOR ────────────────────────────────────────────────────────────

  function showCSSInspector(targetEl, selectorInfo, params) {
    // Remove any existing inspector
    var existing = document.getElementById('__qa_css_inspector__');
    if (existing) existing.remove();

    var computed = window.getComputedStyle(targetEl);

    // Properties grouped by category — most relevant for QA assertions
    var groups = [
      {
        label: '🚦 Validation & State',
        hint: 'Check these after submitting a form with invalid data',
        props: ['border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color', 'box-shadow']
      },
      {
        label: '🎨 Colours',
        hint: 'Background and text colour changes on hover/focus/error',
        props: ['background-color', 'color', 'caret-color', 'text-decoration-color']
      },
      {
        label: '🔲 Border & Outline',
        hint: 'Border width, style and radius',
        props: ['border-width', 'border-style', 'border-radius', 'outline-width', 'outline-style']
      },
      {
        label: '👁 Visibility',
        hint: 'Whether the element is shown or hidden',
        props: ['display', 'visibility', 'opacity', 'pointer-events']
      }
    ];

    // Collect all values upfront
    var allRows = [];
    groups.forEach(function (group) {
      group.props.forEach(function (prop) {
        var val = computed.getPropertyValue(prop);
        if (val && val !== 'none' && val !== 'normal' && val !== 'auto' && val !== '' && val !== '0px' && val !== 'rgba(0, 0, 0, 0)') {
          allRows.push({ group: group.label, prop: prop, val: val });
        }
      });
    });

    // Build panel HTML
    var panel = document.createElement('div');
    panel.id = '__qa_css_inspector__';
    panel.setAttribute('style', [
      'position:fixed', 'top:60px', 'right:20px', 'z-index:2147483647',
      'width:380px', 'max-height:80vh', 'overflow-y:auto',
      'background:#1e293b', 'border:1px solid #3b82f6',
      'border-radius:10px', 'box-shadow:0 12px 40px rgba(0,0,0,.6)',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'font-size:13px', 'color:#e2e8f0'
    ].join(';'));

    // Header
    var header = document.createElement('div');
    header.setAttribute('style', 'padding:12px 16px;border-bottom:1px solid #334155;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:#1e293b;z-index:1');
    header.innerHTML = '<span style="font-weight:700;font-size:14px">🎨 CSS Inspector</span><span style="font-size:11px;color:#94a3b8">Click any value to add an Assert CSS step</span>';
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('style', 'background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px;padding:0 0 0 12px;line-height:1');
    closeBtn.addEventListener('click', function () { panel.remove(); });
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Element tag hint
    var elHint = document.createElement('div');
    elHint.setAttribute('style', 'padding:8px 16px;background:#0f172a;font-size:11px;color:#64748b;font-family:monospace');
    elHint.textContent = '<' + targetEl.tagName.toLowerCase() + (targetEl.id ? ' id="' + targetEl.id + '"' : '') + (targetEl.className && typeof targetEl.className === 'string' ? ' class="' + targetEl.className.trim().split(/\s+/).slice(0,3).join(' ') + '"' : '') + '>';
    panel.appendChild(elHint);

    // Render each group
    groups.forEach(function (group) {
      var groupRows = group.props.map(function (prop) {
        return { prop: prop, val: computed.getPropertyValue(prop) };
      }).filter(function (r) { return r.val && r.val.trim() !== ''; });

      if (groupRows.length === 0) return;

      // Group header
      var gh = document.createElement('div');
      gh.setAttribute('style', 'padding:8px 16px 4px;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;border-top:1px solid #1e293b;background:#0f172a');
      gh.innerHTML = group.label + '<span style="font-weight:400;text-transform:none;margin-left:8px;color:#475569">' + group.hint + '</span>';
      panel.appendChild(gh);

      groupRows.forEach(function (row) {
        var isColorProp = /color|background|shadow/.test(row.prop);
        var row_el = document.createElement('div');
        row_el.setAttribute('style', 'padding:8px 16px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;border-bottom:1px solid #1a2332;gap:8px');
        row_el.addEventListener('mouseenter', function () { row_el.style.background = '#334155'; });
        row_el.addEventListener('mouseleave', function () { row_el.style.background = ''; });

        // Property name
        var propEl = document.createElement('span');
        propEl.textContent = row.prop;
        propEl.setAttribute('style', 'font-family:monospace;color:#7dd3fc;flex-shrink:0');

        // Value with colour swatch if applicable
        var valWrap = document.createElement('span');
        valWrap.setAttribute('style', 'display:flex;align-items:center;gap:6px;overflow:hidden');
        if (isColorProp && row.val !== 'rgba(0, 0, 0, 0)' && row.val !== 'transparent') {
          var swatch = document.createElement('span');
          swatch.setAttribute('style', 'width:14px;height:14px;border-radius:3px;border:1px solid #475569;flex-shrink:0;background:' + row.val);
          valWrap.appendChild(swatch);
        }
        var valEl = document.createElement('span');
        valEl.textContent = row.val;
        valEl.setAttribute('style', 'color:#e2e8f0;font-family:monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
        valWrap.appendChild(valEl);

        // Add button
        var addBtn = document.createElement('button');
        addBtn.textContent = '+ Assert';
        addBtn.setAttribute('style', 'background:#3b82f6;border:none;color:#fff;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;white-space:nowrap');
        addBtn.addEventListener('mouseenter', function () { addBtn.style.background = '#2563eb'; });
        addBtn.addEventListener('mouseleave', function () { addBtn.style.background = '#3b82f6'; });
        addBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          addStep({
            id: 'rec_' + Date.now(),
            type: 'assertCSS',
            params: Object.assign({}, params, { property: row.prop, value: row.val, matchType: 'exact' }),
            _recorded: true,
            _selectorStrategy: selectorInfo.strategy,
            _selectorWarning: selectorInfo.warning || null,
            _description: 'Assert ' + row.prop + ' = ' + row.val
          });
          addBtn.textContent = '✓ Added';
          addBtn.style.background = '#22c55e';
          setTimeout(function () {
            addBtn.textContent = '+ Assert';
            addBtn.style.background = '#3b82f6';
          }, 1500);
        });

        row_el.appendChild(propEl);
        row_el.appendChild(valWrap);
        row_el.appendChild(addBtn);
        panel.appendChild(row_el);
      });
    });

    // Footer tip
    var footer = document.createElement('div');
    footer.setAttribute('style', 'padding:10px 16px;font-size:11px;color:#64748b;border-top:1px solid #334155;line-height:1.5');
    footer.innerHTML = '💡 <strong style="color:#94a3b8">Tip:</strong> Trigger the validation error first (e.g. submit the form with bad data), <em>then</em> right-click the field and open CSS Inspector to capture the error state values.';
    panel.appendChild(footer);

    document.body.appendChild(panel);
  }

  // ─── PREVIEW PANEL ────────────────────────────────────────────────────────────

  const PREVIEW_ID = '__qa_recorder_preview__';

  function togglePreview() {
    previewOpen = !previewOpen;
    if (previewOpen) {
      renderPreviewPanel();
    } else {
      const panel = document.getElementById(PREVIEW_ID);
      if (panel) panel.remove();
    }
  }

  function renderPreviewPanel() {
    let panel = document.getElementById(PREVIEW_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PREVIEW_ID;
      panel.setAttribute('style', `
        position: fixed;
        right: 0;
        top: 0;
        bottom: 0;
        width: 320px;
        z-index: 2147483646;
        background: #0f172a;
        border-left: 1px solid #334155;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        color: #e2e8f0;
        box-shadow: -4px 0 24px rgba(0,0,0,.4);
      `);
      document.body.appendChild(panel);
    }

    const stepsHTML = steps.length === 0
      ? '<div style="padding:20px;color:#64748b;text-align:center">No steps recorded yet.</div>'
      : steps.map(function (step, idx) {
          const warning = step._selectorWarning;
          const desc = describeStep(step);
          const strategy = step._selectorStrategy || '';
          const isWeak = !step._selectorInfo?.unique && (strategy === 'nth' || strategy === 'path');
          const badgeColor = (step.type === 'navigate') ? '' :
            (isWeak || warning) ? 'background:#fef3c7;color:#92400e' : 'background:#dcfce7;color:#166534';
          return `
            <div style="padding:8px 12px;border-bottom:1px solid #1e293b;display:flex;align-items:flex-start;gap:8px;">
              <span style="color:#64748b;font-size:11px;min-width:16px;padding-top:1px">${idx + 1}.</span>
              <div style="flex:1;overflow:hidden;">
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  <span>${stepIcon(step.type)}</span>
                  <span style="font-size:11px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;max-width:180px" title="${esc(desc)}">${esc(desc)}</span>
                  ${strategy && step.type !== 'navigate' && step.type !== 'screenshot' ? `<span style="font-size:10px;padding:1px 5px;border-radius:4px;font-family:monospace;${badgeColor}">${esc(strategy)}</span>` : ''}
                </div>
                ${warning ? `<div style="font-size:11px;color:#f59e0b;margin-top:3px;line-height:1.4">⚠ ${esc(warning)}</div>` : ''}
              </div>
              <button onclick="window.__QA_RECORDER__.deleteStep(${idx})" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:14px;padding:0 2px;flex-shrink:0;">×</button>
            </div>
          `;
        }).join('');

    panel.innerHTML = `
      <div style="padding:14px 16px;border-bottom:1px solid #334155;display:flex;align-items:center;justify-content:space-between;">
        <span style="font-weight:600;font-size:14px">Recorded Steps (${steps.length})</span>
        <button onclick="window.__QA_RECORDER__.togglePreview()" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px;">✕</button>
      </div>
      <div style="flex:1;overflow-y:auto;">
        ${stepsHTML}
      </div>
      <div style="padding:12px 16px;border-top:1px solid #334155;display:flex;gap:8px;">
        <button onclick="window.__QA_RECORDER__.sendToStudio()" style="flex:1;background:#3b82f6;border:none;color:#fff;padding:8px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;">📋 Send to Verifai</button>
      </div>
    `;
  }

  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── SEND TO QA STUDIO ────────────────────────────────────────────────────────

  function sendToStudio() {
    if (steps.length === 0) {
      alert('No steps recorded yet. Interact with the page first.');
      return;
    }
    try {
      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(steps))));
      const url = QA_STUDIO_URL + '/import?steps=' + encoded;
      window.open(url, '_blank');
    } catch (e) {
      alert('Failed to encode recording: ' + e.message);
    }
  }

  // ─── STOP RECORDER ────────────────────────────────────────────────────────────

  function stopRecorder() {
    if (steps.length > 0) {
      if (!confirm('Stop recording and discard ' + steps.length + ' step(s)?')) return;
    }
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    cleanup();
  }

  function cleanup() {
    window.__QA_RECORDER_ACTIVE__ = false;
    const toolbar = document.getElementById(TOOLBAR_ID);
    const preview = document.getElementById(PREVIEW_ID);
    const ctx = document.getElementById('__qa_context_menu__');
    if (toolbar) toolbar.remove();
    if (preview) preview.remove();
    if (ctx) ctx.remove();
    if (highlightBox) highlightBox.remove();
    if (highlightTooltip) highlightTooltip.remove();
    highlightBox = null;
    highlightTooltip = null;
    delete window.__QA_RECORDER__;
  }

  // ─── EXPOSE API ───────────────────────────────────────────────────────────────

  window.__QA_RECORDER__ = {
    deleteStep: function (idx) {
      steps.splice(idx, 1);
      persist();
      updateToolbarStatus();
      if (previewOpen) renderPreviewPanel();
    },
    togglePreview: togglePreview,
    sendToStudio: sendToStudio,
    getSteps: function () { return steps; }
  };

  // ─── INIT ─────────────────────────────────────────────────────────────────────

  createToolbar();

})();
