// --- Tab switching ---
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    // Reset every top-level view: sections + detail views + filter view.
    // Then explicitly unhide only the target panel. This makes the tab
    // switcher the single source of truth for section visibility.
    document.querySelectorAll('section').forEach((sec) => { sec.hidden = true; });
    const sd = document.getElementById('studentDetailView');
    if (sd) sd.hidden = true;
    const sed = document.getElementById('studentExerciseDetailView');
    if (sed) sed.hidden = true;
    const fv = document.getElementById('filteredStudentsView');
    if (fv) fv.hidden = true;

    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const panel = document.getElementById('tab-' + tab.dataset.tab);
    if (panel) {
      panel.classList.add('active');
      panel.hidden = false;
    }
    if (tab.dataset.tab === 'weak-spots') loadWeakSpots();
    if (tab.dataset.tab === 'class' && typeof loadAnalytics === 'function') loadAnalytics();
    if (tab.dataset.tab === 'my-sessions' && typeof loadMySessions === 'function') loadMySessions();
  });
});

// --- Element refs ---
const $ = id => document.getElementById(id);

// ═══════════════════════════════════════════════════════════
// Session event capture (replay infrastructure)
// ═══════════════════════════════════════════════════════════

const CAPTURE_TYPES = new Set([
  'code-snapshot',
  'hint-request',
  'hint-served',
  'hypothesis-written',
  'post-mortem-saved',
  'session-completed',
]);

let __captureSessionId = null;
let __captureExerciseId = null;
let __lastCodeSnapshotAt = 0;

/**
 * POST a capture event. Fire-and-forget — errors are swallowed so
 * capture never disrupts the student's flow.
 */
function captureEvent(type, payload) {
  if (!CAPTURE_TYPES.has(type)) return;
  if (!__captureSessionId) return;
  try {
    fetch('/api/debug-tutor/session-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        sessionId: __captureSessionId,
        exerciseId: __captureExerciseId,
        type,
        payload: payload || {},
      }),
    }).catch(() => {});
  } catch {
    // never throw from capture
  }
}

/**
 * Capture a snapshot of the code editor + error output. Throttled to
 * once every 5 seconds except when forceCapture is true (used on
 * hint-request boundaries which we always want to record).
 */
function captureCodeSnapshot(reason, forceCapture) {
  if (!__captureSessionId) return;
  const now = Date.now();
  if (!forceCapture && now - __lastCodeSnapshotAt < 5000) return;
  __lastCodeSnapshotAt = now;
  const codeEl = document.getElementById('code');
  const errEl = document.getElementById('errorOutput');
  captureEvent('code-snapshot', {
    codeSnapshot: codeEl ? codeEl.value : '',
    errorOutput: errEl ? errEl.value : '',
    reason: reason || 'blur',
  });
}

/**
 * Attach blur listeners to the code + error editors. Called once on
 * boot; safe to call multiple times.
 */
let __captureListenersWired = false;
function wireCaptureListeners() {
  if (__captureListenersWired) return;
  __captureListenersWired = true;
  const codeEl = document.getElementById('code');
  const errEl = document.getElementById('errorOutput');
  if (codeEl) codeEl.addEventListener('blur', () => captureCodeSnapshot('blur'));
  if (errEl) errEl.addEventListener('blur', () => captureCodeSnapshot('blur'));
}

/**
 * Called by handleHintResponse when the sessionId is known. Sets the
 * active capture context and captures an initial code-snapshot so the
 * replay has the state at the moment the first hint was requested.
 */
function armCapture(sessionId, exerciseId) {
  const isNew = __captureSessionId !== sessionId;
  __captureSessionId = sessionId;
  __captureExerciseId = exerciseId;
  if (isNew) {
    // Fresh session context — reset throttle so the first snapshot fires
    __lastCodeSnapshotAt = 0;
    captureCodeSnapshot('session-start', true);
  }
  wireCaptureListeners();
}

// Capture listeners should be re-wired after the student's DOM is
// available. The boot sequence calls this via hydrateSession/applyRole.
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(wireCaptureListeners, 500);
});
const messagesEl = $('messages');
const hintLevelText = $('hintLevelText');
const hintDots = document.querySelectorAll('.dot');

const LEVEL_LABELS = ['Vague nudge', 'More specific', 'Near-answer', 'Final scaffold'];

let currentLevel = 1;

function setLevel(level) {
  currentLevel = level;
  hintDots.forEach(d => {
    d.classList.toggle('active', Number(d.dataset.level) <= level);
  });
  hintLevelText.textContent = LEVEL_LABELS[level - 1] || LEVEL_LABELS[0];
}

function appendMessage({ kind, text, pattern, level, reason, label }) {
  if (messagesEl.querySelector('.empty-state')) messagesEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'msg ' + kind + (kind === 'tutor' && reason ? ' fallback' : '');
  let header = '';
  if (kind === 'tutor') {
    header = '<div class="msg-header">';
    if (reason) header += '<span>Tutor offline — general nudge</span>';
    else header += '<span>Hint level ' + level + '</span>';
    if (pattern) header += ' <span class="msg-pattern">' + pattern + '</span>';
    header += '</div>';
  } else if (kind === 'system') {
    header = '<div class="msg-header">Tutor</div>';
  } else if (kind === 'student') {
    header = '<div class="msg-header">' + escapeHtml(label || 'Your hypothesis') + '</div>';
    if (label === undefined || label === 'Your hypothesis') {
      div.classList.add('hypothesis-bubble');
    }
  }
  div.innerHTML = header + '<div>' + escapeHtml(text) + '</div>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// --- Ask for a hint (with hypothesis gate) ---

async function callHintApi(hypothesis) {
  const payload = {
    studentId: currentUser?.id || 'unknown',
    exerciseId: $('exerciseId').value.trim() || 'ex-1',
    code: $('code').value,
    language: $('language').value,
    errorOutput: $('errorOutput').value,
    exerciseContext: {
      title: 'Sum an array',
      description: 'Iterate over an array and sum its elements.',
      learningObjectives: ['loops', 'array indexing'],
      expectedConcepts: ['for loop', 'array.length'],
    },
    passed: false,
  };
  if (hypothesis) payload.hypothesis = hypothesis;

  const res = await fetch('/api/debug-tutor/hint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function renderHypothesisPrompt(prompt, level) {
  if (messagesEl.querySelector('.empty-state')) messagesEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'msg hypothesis-gate';
  div.innerHTML = `
    <div class="msg-header">Write your hypothesis first</div>
    <div class="hypothesis-prompt">${escapeHtml(prompt)}</div>
    <textarea class="hypothesis-input" placeholder="I think the bug is because..." rows="3"></textarea>
    <button class="hypothesis-submit primary small">Submit hypothesis</button>
  `;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const input = div.querySelector('.hypothesis-input');
  const btn = div.querySelector('.hypothesis-submit');
  input.focus();

  btn.addEventListener('click', async () => {
    const text = input.value.trim();
    if (text.length < 10) {
      input.classList.add('shake');
      setTimeout(() => input.classList.remove('shake'), 400);
      return;
    }
    // Replace the form with the student's submission (so it shows in history)
    div.outerHTML = '';
    appendMessage({ kind: 'student', text });

    // Replay: record the hypothesis text
    captureEvent('hypothesis-written', { text });

    btn.disabled = true;
    try {
      const data = await callHintApi(text);
      handleHintResponse(data);
    } catch (err) {
      appendMessage({ kind: 'system', text: 'Request failed: ' + err.message });
    }
  });
}

/**
 * Toggle the 'Ask for a Hint' and 'I fixed it' buttons based on whether
 * the current exercise's session is complete. Called both from the
 * picker state fetch and from handleHintResponse when a completion
 * response arrives.
 */
function setSessionCompleteButtons(exerciseId, isComplete) {
  const askBtn = $('askBtn');
  const fixedBtn = $('fixedBtn');
  const current = ($('exerciseId') && $('exerciseId').value.trim()) || null;
  // Only act on the currently-displayed exercise
  if (current && exerciseId && current !== exerciseId) return;
  if (askBtn) {
    askBtn.disabled = !!isComplete;
    askBtn.textContent = isComplete ? 'Session complete' : 'Ask the Tutor for a Hint';
  }
  if (fixedBtn) {
    fixedBtn.disabled = !!isComplete;
  }
}

function handleHintResponse(data) {
  // Replay: learn the session ID from every response that carries one,
  // so future events know where to attach.
  const __exerciseId = ($('exerciseId') && $('exerciseId').value.trim()) || 'ex-1';
  if (data && data.sessionId) {
    armCapture(data.sessionId, __exerciseId);
  }
  // Replay: record the hint text that was just shown
  if (data && typeof data.message === 'string' && !data.requiresStruggle && !data.requiresHypothesis && !data.requiresPostMortem) {
    captureEvent('hint-served', {
      hintText: data.message,
      hintLevel: data.hintLevel || null,
      fallbackUsed: !!data.isFallback,
      detectedPattern: data.detectedPattern || null,
    });
  }
  // Replay: session completed?
  if (data && (data.sessionComplete || data.postMortemComplete)) {
    captureEvent('session-completed', {
      reason: data.sessionComplete ? 'session-complete' : 'post-mortem-complete',
    });
    // Session is over — mark this exercise complete and disable the
    // ask/fixed buttons so the student can't keep clicking.
    const exId = ($('exerciseId') && $('exerciseId').value.trim()) || null;
    if (exId) {
      __sessionCompletedFor.add(exId);
      setSessionCompleteButtons(exId, true);
    }
  }

  if (data.resolved) {
    appendMessage({ kind: 'system', text: data.message });
    return;
  }
  if (data.requiresPostMortem) {
    renderPostMortemPrompt(data.prompt);
    return;
  }
  if (data.postMortemComplete) {
    renderPostMortemResult(data);
    return;
  }
  if (data.sessionComplete) {
    appendMessage({ kind: 'system', text: data.message });
    return;
  }
  if (data.requiresStruggle) {
    renderStruggleCard(data.prompt, data.remainingSeconds, data.attemptCount);
    return;
  }
  if (data.requiresHypothesis) {
    setLevel(data.hintLevel);
    renderHypothesisPrompt(data.prompt, data.hintLevel);
    return;
  }
  if (data.hypothesisScore) {
    renderHypothesisScore(data.hypothesisScore);
  }
  setLevel(data.hintLevel);
  appendMessage({
    kind: 'tutor',
    text: data.message,
    pattern: data.detectedPattern,
    level: data.hintLevel,
    reason: data.isFallback ? data.reason : null,
  });
}

$('askBtn').addEventListener('click', async () => {
  const btn = $('askBtn');
  btn.disabled = true;
  btn.textContent = 'Thinking...';
  // Replay: capture the code the student is asking about right now,
  // then log the request event.
  captureCodeSnapshot('hint-request', true);
  captureEvent('hint-request', {
    hintLevel: document.querySelector('.hint-level-text') ? document.querySelector('.hint-level-text').textContent : null,
  });
  try {
    const data = await callHintApi();
    handleHintResponse(data);
  } catch (err) {
    appendMessage({ kind: 'system', text: 'Request failed: ' + err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ask the Tutor for a Hint';
  }
});

$('fixedBtn').addEventListener('click', async () => {
  const btn = $('fixedBtn');
  btn.disabled = true;
  btn.textContent = 'Nice!';
  // Replay: capture the code the student considers fixed
  captureCodeSnapshot('fixed-it', true);
  try {
    const res = await fetch('/api/debug-tutor/hint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: currentUser?.id || 'unknown',
        exerciseId: $('exerciseId').value.trim() || 'ex-1',
        code: $('code').value,
        language: $('language').value,
        errorOutput: $('errorOutput').value,
        exerciseContext: {
          title: 'Sum an array',
          description: 'Iterate over an array and sum its elements.',
          learningObjectives: ['loops', 'array indexing'],
          expectedConcepts: ['for loop', 'array.length'],
        },
        passed: true,
      }),
    });
    const data = await res.json();
    handleHintResponse(data);
  } catch (err) {
    appendMessage({ kind: 'system', text: 'Request failed: ' + err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = 'I fixed it';
  }
});

$('resetBtn').addEventListener('click', async () => {
  const sid = currentUser?.id || 'unknown';
  const eid = $('exerciseId').value.trim() || 'ex-1';
  await fetch('/api/debug-tutor/hint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      studentId: sid, exerciseId: eid,
      code: '', language: 'javascript', errorOutput: '',
      exerciseContext: { title: '', description: '', learningObjectives: [], expectedConcepts: [] },
      passed: true,
    }),
  });
  setLevel(1);
  messagesEl.innerHTML = '<p class="empty-state">Ladder reset. Ask for a fresh hint.</p>';
});

// --- Weak spots ---
function renderPostMortemStats(pm) {
  if (!pm) return '';
  const parts = [];
  if (pm.correct > 0) parts.push(`<span class="pm-correct">${pm.correct} correct</span>`);
  if (pm.partial > 0) parts.push(`<span class="pm-partial">${pm.partial} partial</span>`);
  if (pm.incorrect > 0) parts.push(`<span class="pm-incorrect">${pm.incorrect} incorrect</span>`);
  if (pm.unscored > 0) parts.push(`<span class="pm-unscored">${pm.unscored} saved</span>`);
  if (parts.length === 0) return '';
  return `<div class="card-pm">Post-mortem accuracy: <strong>${pm.total}</strong> scored · ${parts.join(' · ')}</div>`;
}

async function loadWeakSpots() {
  const sid = currentUser?.id || 'unknown';
  const list = $('weakSpotsList');
  list.innerHTML = '<p class="empty-state">Loading...</p>';
  try {
    const res = await fetch('/api/debug-tutor/weak-spots/' + encodeURIComponent(sid));
    const data = await res.json();
    const spots = data.patterns || [];
    const reasoning = data.reasoning;

    const dependencyHtml = renderHintDependencyCard(data.hintDependency);
    const reasoningHtml = renderReasoningCard(reasoning);
    const patternsHtml = spots.length
      ? spots.map(s => `
          <div class="card">
            <div class="card-header">
              <div class="card-title">${escapeHtml(s.label)}</div>
              <div class="card-count">
                ${s.count} occurrence${s.count === 1 ? '' : 's'} ·
                <span class="trend ${s.recentTrend}">${s.recentTrend}</span>
              </div>
            </div>
            <div class="card-bar"><div class="card-bar-fill" style="width:${s.percentage}%"></div></div>
            <div class="card-tip">${escapeHtml(s.tip)}</div>
            ${renderPostMortemStats(s.postMortems)}
          </div>
        `).join('')
      : `<p class="empty-state">No patterns logged yet. Ask the tutor for hints and we'll start building your map.</p>`;

    list.innerHTML = dependencyHtml + reasoningHtml + patternsHtml;
  } catch (err) {
    list.innerHTML = '<p class="empty-state">Failed to load: ' + escapeHtml(err.message) + '</p>';
  }
}

function renderReasoningCard(reasoning) {
  if (!reasoning || reasoning.total === 0) return '';
  const trendClass = reasoning.recentTrend === 'improving' ? 'improving'
    : reasoning.recentTrend === 'worsening' ? 'worsening'
    : 'stable';
  const parts = [];
  if (reasoning.vague > 0) parts.push(`<span class="pm-vague">${reasoning.vague} vague</span>`);
  if (reasoning.plausible > 0) parts.push(`<span class="pm-partial">${reasoning.plausible} plausible</span>`);
  if (reasoning.precise > 0) parts.push(`<span class="pm-correct">${reasoning.precise} precise</span>`);
  if (reasoning.unscored > 0) parts.push(`<span class="pm-unscored">${reasoning.unscored} unscored</span>`);

  return `
    <div class="card reasoning-card">
      <div class="card-header">
        <div class="card-title">Reasoning quality</div>
        <div class="card-count">
          ${reasoning.total} hypothesis${reasoning.total === 1 ? '' : 'es'} scored ·
          <span class="trend ${trendClass}">${reasoning.recentTrend}</span>
        </div>
      </div>
      <div class="card-tip">${parts.join(' · ')}</div>
    </div>
  `;
}

// --- Health ---
// --- Health tab ---
async function loadHealth() {
  // Hide the invite-codes panel for non-admins. Admins see it.
  const invitePanel = document.getElementById('inviteCodesPanel');
  if (invitePanel) {
    invitePanel.hidden = !(currentUser && currentUser.isAdmin === true);
  }

  const body = $('healthBody');
  if (!body) return;
  body.innerHTML = '<p class="empty-state">Loading...</p>';
  try {
    const res = await fetch('/api/admin/health/debug-tutor?hours=24');
    if (!res.ok) {
      body.innerHTML = '<p class="empty-state">Request failed: HTTP ' + res.status + '</p>';
      return;
    }
    const h = await res.json();
    const pct = (h.hints.fallbackRate * 100).toFixed(1);
    const fbClass = h.hints.fallbackRate > 0.1 ? 'warn' : 'good';
    body.innerHTML = `
      ${h.anomalies.length ? `
        <div class="anomalies">
          <h3>Anomalies</h3>
          <ul>${h.anomalies.map(a => '<li>' + escapeHtml(a) + '</li>').join('')}</ul>
        </div>
      ` : ''}
      <div class="stat-grid">
        <div class="stat"><div class="stat-label">Total hints</div><div class="stat-value">${h.hints.total}</div></div>
        <div class="stat"><div class="stat-label">Fallback rate</div><div class="stat-value ${fbClass}">${pct}%</div><div class="stat-sub">${h.hints.fromFallback} of ${h.hints.total}</div></div>
        <div class="stat"><div class="stat-label">Avg latency</div><div class="stat-value">${h.hints.avgLatencyMs ?? '—'}${h.hints.avgLatencyMs ? 'ms' : ''}</div></div>
        <div class="stat"><div class="stat-label">Circuit breaker</div><div class="stat-value ${h.circuitBreaker.state === 'open' ? 'bad' : 'good'}">${h.circuitBreaker.state}</div></div>
      </div>
      <div class="section-card">
        <h2>Fallback reasons</h2>
        ${Object.keys(h.fallbackBreakdown).length
          ? Object.entries(h.fallbackBreakdown).map(([k, v]) =>
              '<div class="pattern-row"><span class="name">' + escapeHtml(k) + '</span><span class="count">' + v + '</span></div>'
            ).join('')
          : '<p class="empty-state">No fallbacks in this window.</p>'}
      </div>
      <div class="section-card">
        <h2>Top mistake patterns</h2>
        ${h.patterns.top.length
          ? h.patterns.top.map(p =>
              '<div class="pattern-row"><span class="name">' + escapeHtml(p.pattern) + '</span><span class="count">' +
              p.count + ' · ' + (p.pct * 100).toFixed(0) + '%</span></div>'
            ).join('')
          : '<p class="empty-state">No patterns logged in this window.</p>'}
      </div>
    `;
  } catch (err) {
    body.innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
  }
}

// --- Init ---
setLevel(1);
// --- Welcome modal (first-visit only) ---
(function initWelcome() {
  const modal = $('welcomeModal');
  const accept = $('welcomeAccept');
  if (!modal || !accept) return;

  const KEY = 'codeteach.welcomed.v1';
  let seen = false;
  try {
    seen = localStorage.getItem(KEY) === '1';
  } catch (e) {
    // localStorage may be blocked — treat as not-seen so the modal shows
  }

  if (!seen) {
    modal.hidden = false;
  }

  accept.addEventListener('click', () => {
    try { localStorage.setItem(KEY, '1'); } catch (e) {}
    modal.hidden = true;
  });
})();

// --- Post-mortem ---
function renderPostMortemPrompt(prompt) {
  if (messagesEl.querySelector('.empty-state')) messagesEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'msg post-mortem-gate';
  div.innerHTML = `
    <div class="msg-header">Post-mortem</div>
    <div class="post-mortem-prompt">${escapeHtml(prompt)}</div>
    <textarea class="post-mortem-input" placeholder="In my own words, the bug happened because..." rows="3"></textarea>
    <button class="post-mortem-submit primary small">Submit explanation</button>
  `;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const input = div.querySelector('.post-mortem-input');
  const btn = div.querySelector('.post-mortem-submit');
  input.focus();

  btn.addEventListener('click', async () => {
    const text = input.value.trim();
    if (text.length < 10) {
      input.classList.add('shake');
      setTimeout(() => input.classList.remove('shake'), 400);
      return;
    }
    div.outerHTML = '';
    appendMessage({ kind: 'student', text, label: 'Your explanation' });

    // Replay: record the post-mortem text
    captureEvent('post-mortem-saved', { text });

    btn.disabled = true;
    try {
      const res = await fetch('/api/debug-tutor/hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId: currentUser?.id || 'unknown',
          exerciseId: $('exerciseId').value.trim() || 'ex-1',
          code: $('code').value,
          language: $('language').value,
          errorOutput: $('errorOutput').value,
          exerciseContext: {
            title: 'Sum an array',
            description: 'Iterate over an array and sum its elements.',
            learningObjectives: ['loops', 'array indexing'],
            expectedConcepts: ['for loop', 'array.length'],
          },
          postMortem: text,
        }),
      });
      const data = await res.json();
      handleHintResponse(data);
    } catch (err) {
      appendMessage({ kind: 'system', text: 'Request failed: ' + err.message });
    }
  });
}

function renderPostMortemResult(data) {
  if (messagesEl.querySelector('.empty-state')) messagesEl.innerHTML = '';
  const div = document.createElement('div');
  const scoreClass = 'score-' + (data.score || 'unscored');
  const scoreLabel = {
    correct: 'Correct',
    partial: 'Partial',
    incorrect: 'Off the mark',
    unscored: 'Saved',
  }[data.score] || 'Saved';

  div.className = 'msg post-mortem-result ' + scoreClass;
  div.innerHTML = `
    <div class="msg-header">
      Post-mortem scored <span class="score-badge ${scoreClass}">${scoreLabel}</span>
    </div>
    <div>${escapeHtml(data.feedback)}</div>
  `;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// --- Session state hydration on page load ---
async function hydrateSession() {
  const studentId = currentUser?.id || 'unknown';
  const exerciseId = $('exerciseId').value.trim() || 'ex-1';
  try {
    const res = await fetch(
      '/api/debug-tutor/session/' +
      encodeURIComponent(studentId) + '/' +
      encodeURIComponent(exerciseId)
    );
    const data = await res.json();
    if (data.state === 'resolved') {
      renderPostMortemPrompt(
        "You fixed this one earlier. Before we move on: in your own words, why did the bug happen?"
      );
      setSessionCompleteButtons(exerciseId, false);
    } else if (data.state === 'complete') {
      // Only append the message the first time we learn the session
      // is complete for this exercise.
      if (!__sessionCompletedFor.has(exerciseId)) {
        __sessionCompletedFor.add(exerciseId);
        appendMessage({
          kind: 'system',
          text: 'This session is complete. Start a new exercise to keep debugging.',
        });
      }
      setSessionCompleteButtons(exerciseId, true);
    } else {
      setLevel(data.currentLevel || 1);
      setSessionCompleteButtons(exerciseId, false);
    }
  } catch (err) {
    // silent — fall through to placeholder
  }
}


// (persistIds removed — identity comes from session)

// --- Class fingerprint tab (legacy — the tab UI was replaced by
// Analytics, but the endpoint and renderClassFingerprint are kept so
// the loader can be revived without a rewrite. Guarded so the missing
// DOM elements don't throw at boot.) ---
const __refreshClassBtn = $('refreshClass');
if (__refreshClassBtn) {
  __refreshClassBtn.addEventListener('click', async () => {
    const key = $('adminKeyClass') ? $('adminKeyClass').value.trim() : '';
    const body = $('classBody');
    if (!body) return;
    body.innerHTML = '<p class="empty-state">Loading...</p>';

    try {
      const res = await fetch('/api/admin/class-fingerprint?hours=168', {
        headers: { 'x-admin-key': key },
      });
      if (!res.ok) {
        body.innerHTML = '<p class="empty-state">Request failed: HTTP ' + res.status + '</p>';
        return;
      }
      const fp = await res.json();
      body.innerHTML = renderClassFingerprint(fp);
    } catch (err) {
      body.innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
    }
  });
}

function renderClassFingerprint(fp) {
  const anomaliesHtml = fp.anomalies && fp.anomalies.length
    ? `<div class="anomalies">
         <h3>Teaching signals</h3>
         <ul>${fp.anomalies.map(a => '<li>' + escapeHtml(a) + '</li>').join('')}</ul>
       </div>`
    : '';

  const patternRows = fp.patterns.map(p => {
    const pm = p.postMortems;
    const pmTotal = pm.total;
    const pmSummary = pmTotal === 0
      ? '<span class="muted">no post-mortems</span>'
      : `${pm.correct} correct · ${pm.partial} partial · ${pm.incorrect} incorrect${pm.unscored ? ' · ' + pm.unscored + ' saved' : ''}`;
    return `
      <tr>
        <td><span class="pattern-name">${escapeHtml(p.pattern)}</span></td>
        <td class="num">${p.occurrences}</td>
        <td class="num">${p.students} <span class="muted">(${p.pctOfStudents}%)</span></td>
        <td class="pm-cell">${pmSummary}</td>
      </tr>
    `;
  }).join('');

  const exerciseRows = fp.exercisesList.map(e => {
    const ratePct = Math.round(e.completionRate * 100);
    const rateClass = ratePct < 30 ? 'bad' : ratePct < 60 ? 'warn' : 'good';
    return `
      <tr>
        <td><span class="pattern-name">${escapeHtml(e.exerciseId)}</span></td>
        <td class="num">${e.students}</td>
        <td class="num">${e.sessions}</td>
        <td class="num"><span class="rate ${rateClass}">${ratePct}%</span></td>
        <td>${e.topPattern ? '<span class="pattern-name">' + escapeHtml(e.topPattern) + '</span>' : '<span class="muted">—</span>'}</td>
      </tr>
    `;
  }).join('');

  const reasoningHtml = fp.reasoning
    ? `<div class="section-card">
         <h2>Hypothesis quality</h2>
         <div class="pattern-row">
           <span class="name">${fp.reasoning.total} scored</span>
           <span class="count">
             ${fp.reasoning.vague} vague ·
             ${fp.reasoning.plausible} plausible ·
             ${fp.reasoning.precise} precise
           </span>
         </div>
       </div>`
    : '';

  const dependencyHtml = fp.hintDependency
    ? `<div class="section-card">
         <h2>Hint dependency</h2>
         <div class="pattern-row">
           <span class="name">${fp.hintDependency.sessions} completed sessions across ${fp.hintDependency.students} students</span>
           <span class="count">
             <strong>${(Math.round(fp.hintDependency.avgHintsPerSession * 10) / 10).toFixed(1)}</strong> hints per session average
           </span>
         </div>
       </div>`
    : '';

  const strugglesHtml = fp.struggles && fp.struggles.length
    ? `<div class="section-card">
         <h2>Concentrated struggles</h2>
         <table class="class-table">
           <thead><tr><th>Exercise</th><th>Pattern</th><th>Students</th><th>Occurrences</th></tr></thead>
           <tbody>
             ${fp.struggles.map(s => `
               <tr>
                 <td><span class="pattern-name">${escapeHtml(s.exerciseId)}</span></td>
                 <td><span class="pattern-name">${escapeHtml(s.pattern)}</span></td>
                 <td class="num">${s.students}</td>
                 <td class="num">${s.occurrences}</td>
               </tr>
             `).join('')}
           </tbody>
         </table>
       </div>`
    : '';

  return `
    ${anomaliesHtml}

    <div class="stat-grid">
      <div class="stat">
        <div class="stat-label">Students</div>
        <div class="stat-value">${fp.students}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Exercises</div>
        <div class="stat-value">${fp.exercises}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Total hints</div>
        <div class="stat-value">${fp.totalHints}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Window</div>
        <div class="stat-value" style="font-size:16px;">${fp.window.hours}h</div>
      </div>
    </div>

    <div class="section-card">
      <h2>Patterns across the class</h2>
      <table class="class-table">
        <thead><tr><th>Pattern</th><th>Occurrences</th><th>Students</th><th>Post-mortems</th></tr></thead>
        <tbody>${patternRows}</tbody>
      </table>
    </div>

    <div class="section-card">
      <h2>Exercises</h2>
      <table class="class-table">
        <thead><tr><th>Exercise</th><th>Students</th><th>Sessions</th><th>Completion</th><th>Top pattern</th></tr></thead>
        <tbody>${exerciseRows}</tbody>
      </table>
    </div>

    ${reasoningHtml}
    ${dependencyHtml}
    ${strugglesHtml}
  `;
}


function renderStruggleCard(prompt, remainingSeconds, attemptCount) {
  if (messagesEl.querySelector('.empty-state')) messagesEl.innerHTML = '';

  const existing = messagesEl.querySelector('.msg.struggle-card');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.className = 'msg struggle-card';
  div.innerHTML = `
    <div class="msg-header">Productive struggle</div>
    <div class="struggle-prompt">${escapeHtml(prompt)}</div>
    <div class="struggle-timer">
      <span class="struggle-countdown" id="struggleCountdown">--:--</span>
      <span class="struggle-label">of focused time</span>
    </div>
    <div class="struggle-hint">
      You've made ${attemptCount || 0} attempt${attemptCount === 1 ? '' : 's'} so far. Keep going —
      a hint will be available when the timer runs out.
    </div>
  `;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  let secondsLeft = Math.max(0, remainingSeconds | 0);
  const countdownEl = div.querySelector('#struggleCountdown');

  function render() {
    const m = Math.floor(secondsLeft / 60);
    const s = secondsLeft % 60;
    countdownEl.textContent = m + ':' + String(s).padStart(2, '0');
  }
  render();

  if (window.__struggleInterval) {
    clearInterval(window.__struggleInterval);
  }

  window.__struggleInterval = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      clearInterval(window.__struggleInterval);
      window.__struggleInterval = null;
      div.innerHTML = `
        <div class="msg-header">Productive struggle</div>
        <div class="struggle-prompt">Nice work putting in the time. Ask for a hint whenever you're ready.</div>
      `;
      return;
    }
    render();
  }, 1000);
}

// ═══════════════════════════════════════════════════════════
// Auth bootstrap
// ═══════════════════════════════════════════════════════════

let currentUser = null;
let loginMode = 'login';
let __sessionCompletedFor = new Set();  // exerciseIds whose session is known-complete

async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null;
    const data = await res.json();
    // Server now returns { user: null } when not authenticated
    // (instead of a 401) to avoid noise in the browser console.
    return data.user || null;
  } catch {
    return null;
  }
}

function showLoginView() {
  $('loginView').hidden = false;
  const topbar = document.querySelector('header.topbar');
  if (topbar) topbar.style.display = 'none';
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
}

function showAppView() {
  $('loginView').hidden = true;
  const topbar = document.querySelector('header.topbar');
  if (topbar) topbar.style.display = '';

  setTimeout(() => {
    // Everyone
    if (typeof loadExercisePicker === 'function') loadExercisePicker();

    // Instructor-only (health stats)
    if (currentUser && currentUser.role === 'instructor') {
      if (typeof loadHealth === 'function') loadHealth();
    }
    // Admin-only (invite codes)
    if (currentUser && currentUser.isAdmin === true) {
      if (typeof loadInviteCodes === 'function') loadInviteCodes();
    }

    // Restore the tab from the URL hash
    if (typeof activateTabFromHash === 'function') activateTabFromHash();
  }, 100);
}

function applyRoleVisibility() {
  const adminTabs = ['health', 'class', 'students', 'exercises'];
  const studentOnlyTabs = ['weak-spots', 'my-sessions'];
  const isInstructor = currentUser.role === 'instructor' || currentUser.role === 'admin';
  document.querySelectorAll('.tab').forEach(tab => {
    const t = tab.dataset.tab;
    if (adminTabs.includes(t) && !isInstructor) {
      tab.remove();
    } else if (studentOnlyTabs.includes(t) && isInstructor) {
      tab.remove();
    } else {
      tab.style.display = '';
    }
  });
  const nameEl = $('currentUserName');
  if (nameEl) nameEl.textContent = currentUser.displayName;

  // If the previously-active tab was just removed (e.g. instructor lands
  // on #weak-spots), fall back to the Tutor tab.
  const activeTab = document.querySelector('.tab.active');
  if (!activeTab) {
    const tutorTab = document.querySelector('.tab[data-tab="tutor"]');
    if (tutorTab) tutorTab.classList.add('active');
    const panels = document.querySelectorAll('.tab-panel');
    panels.forEach(p => p.classList.toggle('active', p.id === 'tab-tutor'));
  }

  // The user-menu label adapts to role: instructors manage classes,
  // students join/leave them.
  const menuBtn = $('openSettingsBtn');
  if (menuBtn) {
    menuBtn.textContent = currentUser.role === 'instructor' ? 'My classes' : 'Classes';
  }
}

function setLoginMode(mode) {
  loginMode = mode;
  if (mode === 'login') {
    $('loginTitle').textContent = 'Welcome back';
    $('loginSubtitle').textContent = 'Log in to keep debugging.';
    $('loginSubmit').textContent = 'Log in';
    $('loginToggleText').textContent = 'New here?';
    $('loginToggle').textContent = 'Create an account';
    $('registerFields').hidden = true;
  } else {
    $('loginTitle').textContent = 'Create your account';
    $('loginSubtitle').textContent = 'Students sign up in seconds.';
    $('loginSubmit').textContent = 'Create account';
    $('loginToggleText').textContent = 'Already have an account?';
    $('loginToggle').textContent = 'Log in';
    $('registerFields').hidden = false;
  }
  $('loginError').hidden = true;
  const inviteEl = $('loginInviteCode');
  if (inviteEl) inviteEl.value = '';
}

function showLoginError(msg) {
  const el = $('loginError');
  el.textContent = msg;
  el.hidden = false;
}

async function submitLogin() {
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  const displayNameEl = $('loginDisplayName');
  const displayName = displayNameEl ? displayNameEl.value.trim() : '';

  if (!email || !password) {
    return showLoginError('Email and password are required.');
  }
  if (loginMode === 'register' && !displayName) {
    return showLoginError('Please enter your name.');
  }
  if (loginMode === 'register' && password.length < 8) {
    return showLoginError('Password must be at least 8 characters.');
  }

  const url = loginMode === 'login' ? '/api/auth/login' : '/api/auth/register';
  const inviteCode = $('loginInviteCode')?.value?.trim() ?? '';
  const roleEl = document.querySelector('input[name="signupRole"]:checked');
  const requestedRole = roleEl && roleEl.value === 'instructor' ? 'instructor' : 'student';
  const body = loginMode === 'login'
    ? { email, password }
    : {
        email,
        password,
        displayName,
        role: requestedRole,
        ...(inviteCode ? { inviteCode } : {}),
      };

  $('loginSubmit').disabled = true;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      return showLoginError(data.error || 'Something went wrong.');
    }
    currentUser = data.user;
    showAppView();
    applyRoleVisibility();
    if (typeof hydrateSession === 'function') hydrateSession();
    // Real-time messaging: connect WS + initial unread fetch
    connectWebSocket();
    refreshMyUnreadCount();
  } catch (err) {
    showLoginError('Network error: ' + err.message);
  } finally {
    $('loginSubmit').disabled = false;
  }
}

async function submitLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {}
  disconnectWebSocket();
  currentUser = null;
  location.reload();
}

async function authBootstrap() {
  const user = await loadCurrentUser();
  if (!user) {
    setLoginMode('login');
    showLoginView();
    return;
  }
  currentUser = user;
  // Real-time messaging: connect WS + initial unread fetch
  connectWebSocket();
  refreshMyUnreadCount();
  showAppView();
  applyRoleVisibility();
  if (typeof hydrateSession === 'function') hydrateSession();
}

function onReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn);
  } else {
    fn();
  }
}

onReady(() => {
  // Wire login form listeners
  const loginSubmit = $('loginSubmit');
  if (loginSubmit) loginSubmit.addEventListener('click', submitLogin);

  const loginToggle = $('loginToggle');
  if (loginToggle) {
    loginToggle.addEventListener('click', (e) => {
      e.preventDefault();
      setLoginMode(loginMode === 'login' ? 'register' : 'login');
    });
  }

  const logoutBtn = $('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', submitLogout);

  const loginPassword = $('loginPassword');
  if (loginPassword) {
    loginPassword.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitLogin();
    });
  }

  authBootstrap();
});


function renderHypothesisScore(score) {
  const bubbles = messagesEl.querySelectorAll('.hypothesis-bubble');
  if (bubbles.length === 0) return;
  const bubble = bubbles[bubbles.length - 1];

  bubble.querySelectorAll('.hypothesis-score').forEach(el => el.remove());

  const qualityClass = 'quality-' + (score.quality || 'unscored');
  const label = {
    vague: 'Vague',
    plausible: 'Plausible',
    precise: 'Precise',
    unscored: 'Unscored',
  }[score.quality] || 'Unscored';

  const scoreEl = document.createElement('div');
  scoreEl.className = 'hypothesis-score ' + qualityClass;
  scoreEl.innerHTML = `
    <span class="score-badge ${qualityClass}">${label}</span>
    <span class="score-feedback">${escapeHtml(score.feedback)}</span>
  `;
  bubble.appendChild(scoreEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}


function renderHintDependencyCard(dep) {
  if (!dep || dep.sessions === 0) return '';

  const trendClass = dep.trend === 'improving' ? 'improving'
    : dep.trend === 'worsening' ? 'worsening'
    : 'stable';

  const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1);

  const showComparison = dep.recentAvg > 0 && dep.priorAvg > 0;
  const comparison = showComparison
    ? `<div class="card-tip" style="margin-top:6px;">
         Last 14 days: <strong>${fmt(dep.recentAvg)}</strong> ·
         Prior 14 days: <strong>${fmt(dep.priorAvg)}</strong>
       </div>`
    : '';

  return `
    <div class="card reasoning-card">
      <div class="card-header">
        <div class="card-title">Hint dependency</div>
        <div class="card-count">
          ${dep.sessions} completed session${dep.sessions === 1 ? '' : 's'} ·
          <span class="trend ${trendClass}">${dep.trend}</span>
        </div>
      </div>
      <div class="card-tip">
        <strong>${fmt(dep.avgHintsPerSession)}</strong> hints per session on average
        <span class="muted">(${dep.totalHints} total)</span>
      </div>
      ${comparison}
    </div>
  `;
}

// --- Invite codes (Health tab) ---

async function loadInviteCodes() {
  const list = $('inviteCodeList');
  if (!list) return;
  list.innerHTML = '<p class="empty-state">Loading…</p>';

  try {
    const res = await fetch('/api/admin/invite-codes');
    if (!res.ok) {
      list.innerHTML =
        '<p class="empty-state">Could not load codes (HTTP ' + res.status + ').</p>';
      return;
    }
    const codes = await res.json();
    if (!codes.length) {
      list.innerHTML =
        '<p class="empty-state">No codes yet. Generate one above.</p>';
      return;
    }
    list.innerHTML = codes.map(renderInviteCodeRow).join('');
  } catch (err) {
    list.innerHTML =
      '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
  }
}

function renderInviteCodeRow(c) {
  const now = Date.now();
  const expiresAt = c.expiresAt ? new Date(c.expiresAt).getTime() : null;
  const expired = expiresAt !== null && expiresAt < now;

  let status;
  if (c.usedBy) {
    status = '<span class="invite-status used">Used</span>';
  } else if (expired) {
    status = '<span class="invite-status expired">Expired</span>';
  } else {
    status = '<span class="invite-status active">Active</span>';
  }

  const expiresText = c.expiresAt
    ? 'expires ' + new Date(c.expiresAt).toLocaleDateString()
    : 'no expiry';

  const revokeBtn =
    !c.usedBy && !expired
      ? `<button class="invite-revoke" data-code="${escapeHtml(c.code)}">Revoke</button>`
      : '';

  return `
    <div class="invite-row">
      <code class="invite-code-value">${escapeHtml(c.code)}</code>
      <span class="invite-meta">${escapeHtml(c.role)} · ${escapeHtml(expiresText)}</span>
      ${status}
      ${revokeBtn}
    </div>
  `;
}

async function generateInviteCode() {
  const btn = $('generateInviteBtn');
  const days = Number($('inviteExpires').value) || 30;
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const res = await fetch('/api/admin/invite-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'instructor', expiresInDays: days }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Could not generate code.');
      return;
    }
    await loadInviteCodes();
  } catch (err) {
    alert('Failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate instructor code';
  }
}

async function revokeInviteCode(code) {
  if (!confirm('Revoke invite code ' + code + '?')) return;
  try {
    const res = await fetch('/api/admin/invite-codes/' + encodeURIComponent(code), {
      method: 'DELETE',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Could not revoke code.');
      return;
    }
    await loadInviteCodes();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

document.addEventListener('click', (e) => {
  const target = e.target;
  if (!target || !target.classList) return;

  if (target.id === 'generateInviteBtn') {
    generateInviteCode();
    return;
  }
  if (target.classList.contains('invite-revoke')) {
    const code = target.dataset.code;
    if (code) revokeInviteCode(code);
  }
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (tab.dataset.tab === 'health') {
      setTimeout(() => {
        loadInviteCodes();
        loadHealth();
      }, 50);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// Exercises tab
// ═══════════════════════════════════════════════════════════

const exercisesState = {
  list: [],
  currentSlug: null,
  conceptsTagify: null,
  objectivesTagify: null,
};

function showExercisesList() {
  $('exercisesListView').hidden = false;
  $('exerciseEditorView').hidden = true;
}

function showExercisesEditor() {
  $('exercisesListView').hidden = true;
  $('exerciseEditorView').hidden = false;
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (tab.dataset.tab === 'exercises') {
      showExercisesList();
      loadClassPicker().then(() => {
        loadExercises();
        loadCohortCard();
      });
    }
  });
});

async function loadExercises() {
  const list = $('exercisesList');
  if (!list) return;
  list.innerHTML = '<p class="empty-state">Loading...</p>';

  try {
    const url = selectedCohortId
      ? '/api/admin/exercises?cohortId=' + encodeURIComponent(selectedCohortId)
      : '/api/admin/exercises';
    const res = await fetch(url);
    if (!res.ok) {
      list.innerHTML = '<p class="empty-state">Failed to load: HTTP ' + res.status + '</p>';
      return;
    }
    const data = await res.json();
    exercisesState.list = data;

    if (!data.length) {
      list.innerHTML = '<p class="empty-state">No exercises yet. Create your first one.</p>';
      return;
    }

    list.innerHTML = renderExercisesTable(data);
    wireExercisesTable();
  } catch (err) {
    list.innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
  }
}

function renderExercisesTable(exercises) {
  return `
    <table class="exercises-table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Language</th>
          <th>Struggle</th>
          <th>Updated</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${exercises.map((e) => `
          <tr data-slug="${escapeHtml(e.slug)}">
            <td>
              <span class="exercise-title-cell">${escapeHtml(e.title)}</span>
              <span class="exercise-slug-cell">${escapeHtml(e.slug)}</span>
            </td>
            <td>${escapeHtml(e.language)}</td>
            <td>${e.struggleMinutes === 0 ? '<span class="muted">none</span>' : e.struggleMinutes + ' min'}</td>
            <td>${new Date(e.updatedAt).toLocaleDateString()}</td>
            <td class="exercise-actions-cell">
              <button data-action="edit">Edit</button>
              <button data-action="duplicate">Duplicate</button>
              <button data-action="delete" class="danger">Delete</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function wireExercisesTable() {
  document.querySelectorAll('.exercises-table tbody tr').forEach((row) => {
    const slug = row.dataset.slug;
    row.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'edit') openExerciseEditor(slug);
        else if (action === 'duplicate') duplicateExercise(slug);
        else if (action === 'delete') deleteExercise(slug);
      });
    });
  });
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.id) return;

  if (t.id === 'newExerciseBtn') openExerciseEditor(null);
  else if (t.id === 'cancelExerciseBtn') { showExercisesList(); loadExercises(); }
  else if (t.id === 'saveExerciseBtn') saveExercise();
  else if (t.id === 'deleteExerciseBtn') deleteExercise(exercisesState.currentSlug);
});

async function openExerciseEditor(slug) {
  exercisesState.currentSlug = slug;

  // Reset form
  $('exTitle').value = '';
  $('exDescription').value = '';
  $('exLanguage').value = 'javascript';
  $('exStarterCode').value = '';
  $('exStruggle').value = '0';
  $('exSlugHint').textContent = '';
  $('deleteExerciseBtn').hidden = true;
  $('editorTitle').textContent = slug ? 'Edit exercise' : 'New exercise';
  $('editorSubtitle').textContent = slug
    ? 'Changes save on the server when you click Save.'
    : 'Students will see this exercise when they enter its ID.';

  // Init Tagify if not already done
  initTagifyFields();

  // Load existing exercise data if editing
  if (slug) {
    const ex = exercisesState.list.find((e) => e.slug === slug);
    if (ex) {
      $('exTitle').value = ex.title;
      $('exDescription').value = ex.description;
      $('exLanguage').value = ex.language;
      $('exStarterCode').value = ex.starterCode;
      $('exStruggle').value = String(ex.struggleMinutes);
      $('exSlugHint').textContent = 'Slug: ' + ex.slug;
      $('deleteExerciseBtn').hidden = false;
      if (exercisesState.conceptsTagify) {
        exercisesState.conceptsTagify.removeAllTags();
        exercisesState.conceptsTagify.addTags(ex.expectedConcepts);
      }
      if (exercisesState.objectivesTagify) {
        exercisesState.objectivesTagify.removeAllTags();
        exercisesState.objectivesTagify.addTags(ex.learningObjectives);
      }
    }
  } else {
    if (exercisesState.conceptsTagify) exercisesState.conceptsTagify.removeAllTags();
    if (exercisesState.objectivesTagify) exercisesState.objectivesTagify.removeAllTags();
  }

  showExercisesEditor();
  refreshCodeHighlight();
  refreshPreview();
}

function initTagifyFields() {
  if (typeof Tagify === 'undefined') return;
  if (exercisesState.conceptsTagify) return; // already initialized

  const conceptsEl = $('exConcepts');
  const objectivesEl = $('exObjectives');
  if (!conceptsEl || !objectivesEl) return;

  exercisesState.conceptsTagify = new Tagify(conceptsEl, {
    delimiters: ',|\\n',
    maxTags: 20,
    trim: true,
    placeholder: 'Type a concept and press Enter',
    dropdown: { enabled: 0 },
    originalInputValueFormat: (valuesArr) => valuesArr.map((i) => i.value),
  });

  exercisesState.objectivesTagify = new Tagify(objectivesEl, {
    delimiters: ',|\\n',
    maxTags: 20,
    trim: true,
    placeholder: 'Type an objective and press Enter',
    dropdown: { enabled: 0 },
    originalInputValueFormat: (valuesArr) => valuesArr.map((i) => i.value),
  });

  exercisesState.conceptsTagify.on('add', refreshPreview);
  exercisesState.conceptsTagify.on('remove', refreshPreview);
  exercisesState.objectivesTagify.on('add', refreshPreview);
  exercisesState.objectivesTagify.on('remove', refreshPreview);
}

function getTagValues(tagifyInstance) {
  if (!tagifyInstance) return [];
  return tagifyInstance.value.map((t) => t.value).filter(Boolean);
}

function refreshCodeHighlight() {
  const input = $('exStarterCode');
  const preview = $('exStarterPreview');
  if (!input || !preview) return;
  const code = input.value || ' ';
  const lang = $('exLanguage').value;
  const prismLang = lang === 'typescript' ? 'typescript' : lang === 'python' ? 'python' : 'javascript';
  preview.className = 'code-editor-highlight language-' + prismLang;
  preview.innerHTML = '<code class="language-' + prismLang + '">' + escapeHtml(code) + '</code>';
  if (typeof Prism !== 'undefined') {
    Prism.highlightElement(preview.querySelector('code'));
  }
}

function refreshPreview() {
  const title = $('exTitle').value || 'Untitled exercise';
  const desc = $('exDescription').value || 'No description yet.';
  const code = $('exStarterCode').value || '// no starter code';
  const struggle = parseInt($('exStruggle').value, 10) || 0;
  const lang = $('exLanguage').value;
  const prismLang = lang === 'typescript' ? 'typescript' : lang === 'python' ? 'python' : 'javascript';

  $('previewTitle').textContent = title;
  $('previewDescription').textContent = desc;

  const previewCode = $('previewCode');
  previewCode.className = 'preview-code language-' + prismLang;
  previewCode.innerHTML = '<code class="language-' + prismLang + '">' + escapeHtml(code) + '</code>';
  if (typeof Prism !== 'undefined') {
    Prism.highlightElement(previewCode.querySelector('code'));
  }

  const concepts = getTagValues(exercisesState.conceptsTagify);
  const objectives = getTagValues(exercisesState.objectivesTagify);

  if (concepts.length) {
    $('previewConceptsWrap').hidden = false;
    $('previewConcepts').innerHTML = concepts
      .map((c) => '<span class="preview-tag">' + escapeHtml(c) + '</span>')
      .join('');
  } else {
    $('previewConceptsWrap').hidden = true;
  }

  if (objectives.length) {
    $('previewObjectivesWrap').hidden = false;
    $('previewObjectives').innerHTML = objectives
      .map((o) => '<span class="preview-tag">' + escapeHtml(o) + '</span>')
      .join('');
  } else {
    $('previewObjectivesWrap').hidden = true;
  }

  if (struggle > 0) {
    $('previewStruggleWrap').hidden = false;
    $('previewStruggle').textContent = struggle;
  } else {
    $('previewStruggleWrap').hidden = true;
  }
}

// Live preview wiring — attached once, on load.
document.addEventListener('DOMContentLoaded', () => {
  const ids = ['exTitle', 'exDescription', 'exStarterCode', 'exStruggle', 'exLanguage'];
  ids.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      refreshCodeHighlight();
      refreshPreview();
    });
    el.addEventListener('change', () => {
      refreshCodeHighlight();
      refreshPreview();
    });
  });

  // Sync scroll between the code input and the Prism highlight overlay
  const input = $('exStarterCode');
  const overlay = $('exStarterPreview');
  if (input && overlay) {
    input.addEventListener('scroll', () => {
      overlay.scrollTop = input.scrollTop;
      overlay.scrollLeft = input.scrollLeft;
    });
  }
});

async function saveExercise() {
  const btn = $('saveExerciseBtn');
  const title = $('exTitle').value.trim();
  if (title.length < 2) {
    alert('Title must be at least 2 characters.');
    return;
  }

  const body = {
    title,
    description: $('exDescription').value,
    language: $('exLanguage').value,
    starterCode: $('exStarterCode').value,
    expectedConcepts: getTagValues(exercisesState.conceptsTagify),
    learningObjectives: getTagValues(exercisesState.objectivesTagify),
    struggleMinutes: Math.max(0, Math.min(60, parseInt($('exStruggle').value, 10) || 0)),
    ...(selectedCohortId && !exercisesState.currentSlug ? { cohortId: selectedCohortId } : {}),
  };

  const isEdit = exercisesState.currentSlug !== null;
  const url = isEdit
    ? '/api/admin/exercises/' + encodeURIComponent(exercisesState.currentSlug)
    : '/api/admin/exercises';
  const method = isEdit ? 'PUT' : 'POST';

  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Save failed.');
      return;
    }
    exercisesState.currentSlug = data.slug;
    showExercisesList();
    await loadExercises();
  } catch (err) {
    alert('Save failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function deleteExercise(slug) {
  if (!slug) return;
  if (!confirm('Delete "' + slug + '"? This cannot be undone.')) return;

  try {
    const res = await fetch('/api/admin/exercises/' + encodeURIComponent(slug), {
      method: 'DELETE',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Delete failed.');
      return;
    }
    exercisesState.currentSlug = null;
    showExercisesList();
    await loadExercises();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

function duplicateExercise(slug) {
  const source = exercisesState.list.find((e) => e.slug === slug);
  if (!source) {
    alert('Exercise not found in cache. Refresh and try again.');
    return;
  }

  // Open the editor in "new" mode, prefilled from the source
  exercisesState.currentSlug = null;
  $('editorTitle').textContent = 'Duplicate exercise';
  $('editorSubtitle').textContent = 'Adjust the copy and save it as a new exercise.';
  $('exTitle').value = source.title + ' (copy)';
  $('exDescription').value = source.description;
  $('exLanguage').value = source.language;
  $('exStarterCode').value = source.starterCode;
  $('exStruggle').value = String(source.struggleMinutes);
  $('exSlugHint').textContent = 'A new slug will be generated on save.';
  $('deleteExerciseBtn').hidden = true;

  initTagifyFields();
  if (exercisesState.conceptsTagify) {
    exercisesState.conceptsTagify.removeAllTags();
    exercisesState.conceptsTagify.addTags(source.expectedConcepts);
  }
  if (exercisesState.objectivesTagify) {
    exercisesState.objectivesTagify.removeAllTags();
    exercisesState.objectivesTagify.addTags(source.learningObjectives);
  }

  showExercisesEditor();
  refreshCodeHighlight();
  refreshPreview();
}

// ═══════════════════════════════════════════════════════════
// User menu + settings
// ═══════════════════════════════════════════════════════════

function toggleUserMenu(open) {
  const menu = $('userMenuDropdown');
  const toggle = $('userMenuToggle');
  if (!menu || !toggle) return;
  const shouldOpen = open !== undefined ? open : menu.hidden;
  menu.hidden = !shouldOpen;
  toggle.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t) return;

  if (t.id === 'userMenuToggle' || t.closest('#userMenuToggle')) {
    e.preventDefault();
    toggleUserMenu();
    return;
  }

  const chip = $('userChip');
  if (chip && !chip.contains(t)) {
    toggleUserMenu(false);
  }
});

async function openSettings() {
  toggleUserMenu(false);
  $('settingsModal').hidden = false;

  const isInstructor = currentUser && currentUser.role === 'instructor';

  if (currentUser) {
    const line = $('settingsAccountLine');
    if (line) {
      const role = isInstructor ? 'Instructor' : 'Student';
      line.textContent = 'Signed in as ' + (currentUser.email || 'unknown') + ' (' + role + ')';
    }
  }

  // Modal badge + heading adapt to role
  const badge = document.querySelector('#settingsModal .modal-badge');
  if (badge) badge.textContent = isInstructor ? 'Classes' : 'Join Class';
  const title = document.querySelector('#settingsModal .modal-title');
  if (title) title.textContent = 'Classes';

  // Section heading — "Classes you teach" for instructors, "Your classes" for students
  const classHeading = document.querySelector('#settingsClassList')
    ?.closest('.settings-section')
    ?.querySelector('.settings-heading');
  if (classHeading) {
    classHeading.textContent = isInstructor ? 'Classes you teach' : 'Your classes';
  }

  // Hide "Join a class" for instructors — they never join their own cohorts.
  const joinBtn = $('settingsJoinBtn');
  const joinSection = joinBtn ? joinBtn.closest('.settings-section') : null;
  if (joinSection) joinSection.hidden = isInstructor;

  $('settingsJoinCode').value = '';
  $('settingsJoinMessage').hidden = true;
  $('settingsJoinMessage').className = 'settings-join-message';

  await loadSettingsClasses();
}

async function loadSettingsClasses() {
  const list = $('settingsClassList');
  list.innerHTML = '<p class="empty-state">Loading...</p>';

  try {
    const res = await fetch('/api/cohorts/mine');
    if (!res.ok) {
      list.innerHTML = '<p class="empty-state">Could not load classes.</p>';
      return;
    }
    const cohorts = await res.json();

    if (!cohorts.length) {
      list.innerHTML = '<p class="empty-state">You are not in any classes yet. Ask your instructor for a code.</p>';
      return;
    }

    const isInstructor = currentUser && currentUser.role === 'instructor';

    list.innerHTML = cohorts.map((c) => {
      const actionButton = isInstructor
        ? `<button class="settings-delete-cohort-btn" data-cohort-id="${escapeHtml(c.id)}" data-cohort-name="${escapeHtml(c.name)}">Delete cohort</button>`
        : `<button class="settings-leave-btn" data-cohort-id="${escapeHtml(c.id)}" data-cohort-name="${escapeHtml(c.name)}">Leave</button>`;
      const metaLine = isInstructor || !c.joinedAt
        ? ''
        : `<span class="settings-class-meta">joined ${new Date(c.joinedAt).toLocaleDateString()}</span>`;
      return `
        <div class="settings-class-row">
          <div>
            <div class="settings-class-name">${escapeHtml(c.name)}</div>
            ${metaLine}
          </div>
          ${actionButton}
        </div>
      `;
    }).join('');

    list.querySelectorAll('.settings-leave-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        leaveClass(btn.dataset.cohortId, btn.dataset.cohortName);
      });
    });

    list.querySelectorAll('.settings-delete-cohort-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        deleteCohortData(btn.dataset.cohortId, btn.dataset.cohortName);
      });
    });
  } catch (err) {
    list.innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
  }
}

/**
 * Instructor-only: permanently delete a cohort and all of its data.
 * Uses the confirm-by-typing modal — the instructor must type the
 * cohort name exactly.
 */
function deleteCohortData(cohortId, cohortName) {
  showConfirmModal({
    title: 'Delete "' + cohortName + '"?',
    message:
      '<p>This will permanently erase:</p>' +
      '<ul style="margin:6px 0 10px 20px;padding:0;">' +
      '<li>Every student\'s sessions, hypotheses, post-mortems, ' +
      'mistake patterns, and telemetry for exercises in this cohort</li>' +
      '<li>The cohort\'s exercises</li>' +
      '<li>All cohort membership and tutor notes</li>' +
      '<li>The cohort itself</li>' +
      '</ul>' +
      '<p class="confirm-modal-warn">Students\' accounts are <b>not</b> deleted — they remain registered but unenrolled.</p>' +
      '<p>This action cannot be undone.</p>',
    requiredText: cohortName,
    confirmLabel: 'Delete cohort',
    onConfirm: async () => {
      try {
        const res = await fetch('/api/cohorts/' + encodeURIComponent(cohortId) + '/data', {
          method: 'DELETE',
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || 'Deletion failed.');
          return false;
        }
        const r = data.removed || {};
        const parts = [];
        for (const k of Object.keys(r)) {
          if (r[k]) parts.push(r[k] + ' ' + k.replace(/_/g,' '));
        }
        alert('Deleted: ' + (parts.join(', ') || 'no rows') + '.');
        await loadSettingsClasses();
        return true;
      } catch (err) {
        alert('Failed: ' + err.message);
        return false;
      }
    },
  });
}

/**
 * Self-service account deletion. Instructors with cohorts get a
 * 409 with the list of blockers, which we show inline.
 */
function deleteMyAccount() {
  const user = currentUser;
  const requiredText = 'DELETE';
  showConfirmModal({
    title: 'Delete your account?',
    message:
      '<p>This will permanently erase your account and everything associated with it:</p>' +
      '<ul style="margin:6px 0 10px 20px;padding:0;">' +
      '<li>Your profile (name, email)</li>' +
      '<li>All of your work</li>' +
      '<li>Any tutor notes or feedback you have authored</li>' +
      '</ul>' +
      '<p class="confirm-modal-warn">If you are an instructor, you must delete or transfer your cohorts first.</p>' +
      '<p>This action cannot be undone.</p>',
    requiredText,
    confirmLabel: 'Delete my account',
    onConfirm: async () => {
      try {
        const res = await fetch('/api/auth/me/account', { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409) {
          const names = (data.cohorts || []).map((c) => c.name).join(', ');
          alert('You still own these cohorts: ' + names + '.\n\nDelete them first, then try again.');
          return false;
        }
        if (!res.ok) {
          alert(data.error || 'Account deletion failed.');
          return false;
        }
        alert('Your account has been deleted. You will be signed out.');
        // Logout and reload
        window.location.href = '/';
        return true;
      } catch (err) {
        alert('Failed: ' + err.message);
        return false;
      }
    },
  });
}

async function leaveClass(cohortId, cohortName) {
  if (!confirm('Leave "' + cohortName + '"?')) return;
  try {
    const res = await fetch('/api/cohorts/' + encodeURIComponent(cohortId) + '/leave', {
      method: 'DELETE',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Could not leave class.');
      return;
    }
    await loadSettingsClasses();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

async function joinClass() {
  const code = $('settingsJoinCode').value.trim();
  const msg = $('settingsJoinMessage');
  if (!code) {
    msg.textContent = 'Enter a code first.';
    msg.className = 'settings-join-message error';
    msg.hidden = false;
    return;
  }

  const btn = $('settingsJoinBtn');
  btn.disabled = true;
  btn.textContent = 'Joining...';
  msg.hidden = true;

  try {
    const res = await fetch('/api/cohorts/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();

    if (!res.ok) {
      msg.textContent = data.error || 'Could not join.';
      msg.className = 'settings-join-message error';
      msg.hidden = false;
      return;
    }

    msg.textContent = 'Joined "' + data.cohort.name + '".';
    msg.className = 'settings-join-message success';
    msg.hidden = false;
    $('settingsJoinCode').value = '';
    await loadSettingsClasses();
    if (typeof loadExercisePicker === 'function') await loadExercisePicker();
    if (typeof loadExercisePicker === 'function') await loadExercisePicker();
  } catch (err) {
    msg.textContent = 'Failed: ' + err.message;
    msg.className = 'settings-join-message error';
    msg.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Join';
  }
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.id) return;

  if (t.id === 'openSettingsBtn') openSettings();
  else if (t.id === 'closeSettingsBtn') $('settingsModal').hidden = true;
  else if (t.id === 'settingsJoinBtn') joinClass();
});

document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'settingsModal') {
    $('settingsModal').hidden = true;
  }
});

document.addEventListener('DOMContentLoaded', () => {
  const codeInput = $('settingsJoinCode');
  if (codeInput) {
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinClass();
    });
  }
});

async function loadCohortCard() {
  const card = $('cohortCard');
  if (!card) return;

  try {
    const url = selectedCohortId
      ? '/api/cohorts/me?cohortId=' + encodeURIComponent(selectedCohortId)
      : '/api/cohorts/me';
    const res = await fetch(url);
    if (!res.ok) {
      // Not an instructor or endpoint failed — hide the card silently
      card.hidden = true;
      return;
    }
    const data = await res.json();
    if (!data.enrollmentCode) {
      card.hidden = true;
      return;
    }

    $('cohortCode').textContent = data.enrollmentCode;
    $('cohortMemberCount').textContent = String(data.memberCount || 0);
    $('cohortMemberPlural').textContent = (data.memberCount === 1) ? '' : 's';
    card.hidden = false;
  } catch {
    card.hidden = true;
  }
}

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (!t || t.id !== 'copyCohortCodeBtn') return;

  const code = $('cohortCode').textContent;
  if (!code || code === '—') return;

  try {
    await navigator.clipboard.writeText(code);
    const btn = t;
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1200);
  } catch {
    // Fallback for browsers without clipboard API
    alert('Enrollment code: ' + code);
  }
});

// ═══════════════════════════════════════════════════════════
// Class picker (Exercises tab)
// ═══════════════════════════════════════════════════════════

let selectedCohortId = null;
let instructorCohorts = [];

async function loadClassPicker() {
  const row = $('classPickerRow');
  const picker = $('classPicker');
  if (!row || !picker) return;

  try {
    const res = await fetch('/api/admin/cohorts');
    if (!res.ok) {
      row.hidden = true;
      return;
    }
    instructorCohorts = await res.json();
    if (!instructorCohorts.length) {
      row.hidden = true;
      return;
    }
    row.hidden = false;

    // Preserve current selection if still valid
    const stillValid = instructorCohorts.some((c) => c.id === selectedCohortId);
    if (!stillValid) selectedCohortId = instructorCohorts[0].id;

    picker.innerHTML = instructorCohorts
      .map((c) => `<option value="${escapeHtml(c.id)}"${c.id === selectedCohortId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`)
      .join('');
  } catch {
    row.hidden = true;
  }
}

document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'analyticsCohort') {
    loadAnalyticsFor(e.target.value);
    return;
  }
  if (e.target && e.target.id === 'classPicker') {
    selectedCohortId = e.target.value;
    loadExercises();
    loadCohortCard();
  }
});

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (!t || !t.id) return;

  if (t.id === 'newClassBtn') {
    const name = prompt('Class name:');
    if (!name || name.trim().length < 2) return;
    try {
      const res = await fetch('/api/admin/cohorts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Could not create class.');
        return;
      }
      selectedCohortId = data.id;
      await loadClassPicker();
      loadExercises();
      loadCohortCard();
    } catch (err) {
      alert('Failed: ' + err.message);
    }
    return;
  }

  if (t.id === 'renameClassBtn') {
    if (!selectedCohortId) return;
    const current = instructorCohorts.find((c) => c.id === selectedCohortId);
    const name = prompt('New name:', current ? current.name : '');
    if (!name || name.trim().length < 2) return;
    try {
      const res = await fetch('/api/admin/cohorts/' + encodeURIComponent(selectedCohortId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Could not rename class.');
        return;
      }
      await loadClassPicker();
    } catch (err) {
      alert('Failed: ' + err.message);
    }
  }
});

// ═══════════════════════════════════════════════════════════
// Students tab (roster view)
// ═══════════════════════════════════════════════════════════

async function loadStudentsRoster() {
  const container = $('studentsRoster');
  if (!container) return;
  container.innerHTML = '<p class="empty-state">Loading...</p>';

  const rangeDays = Number($('studentsRange')?.value ?? 0);
  const url = '/api/admin/students' + (rangeDays > 0 ? '?days=' + rangeDays : '');

  try {
    const res = await fetch(url);
    if (!res.ok) {
      container.innerHTML = '<p class="empty-state">Could not load students (HTTP ' + res.status + ').</p>';
      return;
    }
    const students = await res.json();

    if (!students.length) {
      container.innerHTML = '<p class="empty-state">No students yet. Share your enrollment code from the Exercises tab.</p>';
      return;
    }

    container.innerHTML = `
      <table class="students-table">
        <thead>
          <tr>
            <th>Student</th>
            <th>Classes</th>
            <th>Activity (30d)</th>
            <th>Completed</th>
            <th>Last active</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${students.map((s) => `
            <tr data-student-id="${escapeHtml(s.studentId)}">
              <td>
                <span class="student-name-cell">${escapeHtml(s.displayName)}</span>
                <span class="student-email-cell">${escapeHtml(s.email)}</span>
              </td>
              <td>${s.cohortNames.map((n) => escapeHtml(n)).join(', ')}</td>
              <td>${renderRosterActivity(s.activity30d)}</td>
              <td>${renderCompactProgress(s.exercisesCompleted, s.assigned)}</td>
              <td>${s.lastActiveAt ? relativeTime(s.lastActiveAt) : '—'}</td>
              <td>${renderStatusBadge(s.status, s.statusReasons)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    // Cache for the detail view
    window.__studentsRoster = students;

    container.querySelectorAll('tr[data-student-id]').forEach((row) => {
      row.addEventListener('click', () => {
        openStudentDetail(row.dataset.studentId);
      });
    });
  } catch (err) {
    container.innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
  }
}

/**
 * Threshold-based color class for a progress value (0–1).
 * green >= 0.8, amber >= 0.4, red < 0.4
 */
function progressClass(percent) {
  if (percent >= 0.8) return 'progress-good';
  if (percent >= 0.4) return 'progress-warn';
  return 'progress-low';
}

/**
 * Compact progress bar for the roster's Completed cell.
 * @param completed  number of completed exercises
 * @param assigned   number of assigned exercises
 */
function renderCompactProgress(completed, assigned) {
  if (!assigned || assigned <= 0) {
    return '<span class="progress-empty">—</span>';
  }
  const pct = Math.min(1, completed / assigned);
  const cls = progressClass(pct);
  return (
    '<div class="progress-cell">' +
      '<span class="progress-cell-count">' + completed + ' / ' + assigned + '</span>' +
      '<div class="progress-bar-sm">' +
        '<div class="progress-bar-sm-fill ' + cls + '" style="width:' + Math.round(pct * 100) + '%"></div>' +
      '</div>' +
    '</div>'
  );
}

/**
 * Full-width progress bar for the detail page Progress card.
 */
function renderFullProgress(completed, assigned, percent) {
  if (!assigned || assigned <= 0) {
    return '';
  }
  const cls = progressClass(percent);
  return (
    '<div class="sd-progress-bar-lg">' +
      '<div class="sd-progress-bar-lg-fill ' + cls + '" style="width:' + Math.round(percent * 100) + '%"></div>' +
    '</div>'
  );
}

/**
 * Render the activity heatmap panel on the student detail page.
 * `activity` = { windowDays, events, totalEvents, currentStreak,
 *                longestStreak, mostActiveDay }
 */
function renderActivity(activity) {
  const el = $('sdActivity');
  if (!el) return;

  if (!activity || activity.totalEvents === 0) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  const grid = renderActivityGrid(activity, { days: 90, cellSize: 12, showLabels: true });

  const streakLabel = activity.currentStreak > 0
    ? activity.currentStreak + '-day streak'
    : 'No current streak';
  const longestLabel = 'Longest: ' + activity.longestStreak + ' day' +
    (activity.longestStreak === 1 ? '' : 's');
  const totalLabel = activity.totalEvents + ' event' +
    (activity.totalEvents === 1 ? '' : 's') + ' in ' + activity.windowDays + ' days';

  el.style.display = 'block';
  el.innerHTML =
    '<h3 class="sd-section-heading">Activity</h3>' +
    '<div class="sd-activity-grid-wrap">' + grid + '</div>' +
    '<div class="sd-activity-summary">' +
      '<span class="sd-activity-pill">' + escapeHtml(streakLabel) + '</span>' +
      '<span class="sd-activity-pill sd-activity-pill-muted">' + escapeHtml(longestLabel) + '</span>' +
      '<span class="sd-activity-pill sd-activity-pill-muted">' + escapeHtml(totalLabel) + '</span>' +
    '</div>';
}

/**
 * Reusable heatmap grid renderer. Used by the detail page (larger)
 * and by the roster cell (compact).
 *
 * opts = { days, cellSize, showLabels, orientation }
 *   days        — number of trailing days to render (90 or 30)
 *   cellSize    — px size of a cell (12 for detail, 8 for roster)
 *   showLabels  — month labels above + weekday labels left
 *   orientation — 'grid' (detail: 7 rows × N cols) or 'strip'
 *                 (roster: 1 row × N cols, no weekday labels)
 */
function renderActivityGrid(activity, opts) {
  opts = opts || {};
  const days = opts.days || 90;
  const cellSize = opts.cellSize || 12;
  const showLabels = opts.showLabels !== false;
  const orientation = opts.orientation || 'grid';

  // Build a date → count map from the events
  const byDate = new Map();
  for (const e of activity.events) byDate.set(e.date, e.count);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  // Date array of length `days`, oldest first
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  if (orientation === 'strip') {
    return renderActivityStrip(dates, byDate, cellSize);
  }
  return renderActivityWeeks(dates, byDate, cellSize, showLabels);
}

function activityLevel(count) {
  if (!count || count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  return 3;
}

function renderActivityStrip(dates, byDate, cellSize) {
  let html = '<div class="activity-strip">';
  for (const d of dates) {
    const count = byDate.get(d) || 0;
    const lvl = activityLevel(count);
    html += '<span class="activity-cell lvl-' + lvl + '" style="width:' +
      cellSize + 'px;height:' + cellSize + 'px;" title="' +
      escapeHtml(d + ' · ' + count + ' event' + (count === 1 ? '' : 's')) +
      '"></span>';
  }
  html += '</div>';
  return html;
}

function renderActivityWeeks(dates, byDate, cellSize, showLabels) {
  // Pad the start so the first column begins on a Monday
  const firstDate = new Date(dates[0] + 'T00:00:00Z');
  const firstDow = firstDate.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const padBefore = (firstDow + 6) % 7;   // days since Monday

  const cells = [];
  for (let i = 0; i < padBefore; i++) cells.push(null);
  for (const d of dates) cells.push(d);
  // Pad to a full week
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  const rowLabels = showLabels ? ['Mon', '', 'Wed', '', 'Fri', '', ''] : null;
  const cellTitle = (d) => {
    if (!d) return '';
    const count = byDate.get(d) || 0;
    return d + ' · ' + count + ' event' + (count === 1 ? '' : 's');
  };

  // Month labels above: find the first cell of each month across weeks
  let monthHeader = '';
  if (showLabels) {
    monthHeader = '<div class="activity-months" style="margin-left:26px;">';
    let lastMonth = '';
    for (const week of weeks) {
      const firstWithDate = week.find((c) => c);
      if (!firstWithDate) {
        monthHeader += '<span class="activity-month"></span>';
        continue;
      }
      const m = firstWithDate.slice(0, 7);
      if (m !== lastMonth) {
        const label = new Date(firstWithDate + 'T00:00:00Z')
          .toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
        monthHeader += '<span class="activity-month">' + label + '</span>';
        lastMonth = m;
      } else {
        monthHeader += '<span class="activity-month"></span>';
      }
    }
    monthHeader += '</div>';
  }

  // Grid body — explicit column count so each weekday is exactly one row.
  // CSS grid flows row-by-row, so 7 rows × (1 label + N week cells) lays
  // out cleanly without needing break elements.
  const cols = weeks.length;
  let grid = '<div class="activity-grid" style="grid-template-columns:26px repeat(' +
    cols + ', ' + cellSize + 'px);">';
  for (let row = 0; row < 7; row++) {
    if (rowLabels) {
      grid += '<div class="activity-row-label">' + (rowLabels[row] || '') + '</div>';
    }
    for (const week of weeks) {
      const d = week[row];
      if (!d) {
        grid += '<span class="activity-cell lvl-empty" style="width:' +
          cellSize + 'px;height:' + cellSize + 'px;"></span>';
      } else {
        const count = byDate.get(d) || 0;
        const lvl = activityLevel(count);
        grid += '<span class="activity-cell lvl-' + lvl + '" style="width:' +
          cellSize + 'px;height:' + cellSize + 'px;" title="' +
          escapeHtml(cellTitle(d)) + '"></span>';
      }
    }
  }
  grid += '</div>';

  return monthHeader + grid;
}

/**
 * Roster cell: compact 30-day activity strip + streak label.
 */
function renderRosterActivity(activity) {
  if (!activity || activity.totalEvents === 0) {
    return '<span class="progress-empty">—</span>';
  }
  const strip = renderActivityGrid(activity, {
    days: 30,
    cellSize: 8,
    showLabels: false,
    orientation: 'strip',
  });
  const streak = activity.currentStreak > 0
    ? activity.currentStreak + 'd'
    : '';
  return (
    '<div class="roster-activity">' +
      strip +
      (streak ? '<span class="roster-activity-streak">' + escapeHtml(streak) + '</span>' : '') +
    '</div>'
  );
}

function renderStatusBadge(status, reasons) {
  const labels = {
    'on-track': 'On track',
    'slipping': 'Slipping',
    'at-risk': 'At-risk',
    'new': 'New',
  };
  const label = labels[status] || status || '';
  const titleAttr = (reasons && reasons.length)
    ? ' title="' + escapeHtml(reasons.join(' · ')) + '"'
    : '';
  return '<span class="status-badge ' + (status || '') + '"' + titleAttr + '>' + escapeHtml(label) + '</span>';
}

/**
 * Render the "Recommended next action" banner. Only visible when
 * `nextAction` is present. Clickable (opens exercise detail) only
 * when nextAction.clickable === true.
 */
/**
 * Wire the message icon next to the student name. Idempotent — safe
 * to call on every render.
 */
function wireStudentNudgeIcon() {
  const btn = $('sdNudgeIcon');
  if (!btn) return;

  // Clone-replace to strip stale listeners
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);

  fresh.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!currentStudentId) return;
    // If the student has an existing thread, open it directly.
    // Otherwise open the compose view.
    openNudgeModal('auto');
  });

  // Refresh badge count for the current student
  refreshStudentNudgeBadge();
}

/**
 * Fetch the unread count for the current student (from the
 * instructor's perspective — messages the student sent that we
 * haven't read).
 */
async function refreshStudentNudgeBadge() {
  const badge = $('sdNudgeBadge');
  if (!badge) return;
  if (!currentStudentId) {
    badge.hidden = true;
    return;
  }
  try {
    const res = await fetch(
      '/api/admin/students/' + encodeURIComponent(currentStudentId) + '/nudges',
      { credentials: 'same-origin' }
    );
    if (!res.ok) { badge.hidden = true; return; }
    const data = await res.json();
    const messages = data.messages || [];
    // Count messages authored by the student that have no readAt
    const unread = messages.filter(
      (m) => m.authorRole === 'student' && !m.readAt
    ).length;
    if (unread > 0) {
      badge.textContent = String(unread);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch {
    badge.hidden = true;
  }
}

/**
 * Open the nudge modal.
 * mode = 'compose' | 'thread' | 'auto'
 *   'auto' -> if a thread exists, show it; else show compose.
 */
async function openNudgeModal(mode) {
  const modal = $('nudgeModal');
  if (!modal || !currentStudentId) return;
  modal.hidden = false;

  const bodyEl = $('nudgeModalBody');
  const titleEl = $('nudgeModalTitle');

  // Fetch current thread state
  bodyEl.innerHTML = '<p class="empty-state">Loading…</p>';
  titleEl.textContent = 'Message';

  let data = { thread: null, messages: [] };
  try {
    const res = await fetch(
      '/api/admin/students/' + encodeURIComponent(currentStudentId) + '/nudges',
      { credentials: 'same-origin' }
    );
    if (res.ok) data = await res.json();
  } catch {}

  // Resolve mode
  if (mode === 'auto') {
    mode = data.thread ? 'thread' : 'compose';
  }

  // Mark thread read on open (any unread student messages)
  if (mode === 'thread' && data.thread) {
    try {
      await fetch(
        '/api/me/nudges/' + encodeURIComponent(data.thread.id) + '/read',
        { method: 'POST', credentials: 'same-origin' }
      );
      // Refresh badge after marking read
      refreshStudentNudgeBadge();
    } catch {}
  }

  // Render
  const student = window.__studentsRoster
    ? window.__studentsRoster.find((s) => s.studentId === currentStudentId)
    : null;
  const studentName = student ? student.displayName : 'this student';
  titleEl.textContent = 'Message ' + studentName;

  if (mode === 'compose') {
    renderNudgeCompose(bodyEl, studentName, data.thread);
  } else {
    renderNudgeThread(bodyEl, data);
  }
}

/**
 * Render the compose form. Templates + textarea + send.
 */
function renderNudgeCompose(container, studentName, existingThread) {
  // Discover context for template placeholders
  const roster = window.__studentsRoster || [];
  const student = roster.find((s) => s.studentId === currentStudentId);
  const recentExercise = student && student.lastActiveAt ? '(your most recent exercise)' : 'your recent exercise';
  const nextExercise = 'the next exercise';

  // Templates
  const templates = [
    'Just checking in — how\'s it going?',
    'Try the next exercise when you get a chance.',
    'Nice work on your recent exercise!',
    'Anything I can help with?',
  ];

  const templatesHtml = templates.map((t) => `
    <button type="button" class="nudge-template-chip" data-template="${escapeHtml(t)}">
      ${escapeHtml(t)}
    </button>
  `).join('');

  container.innerHTML = `
    <div class="nudge-compose">
      <div class="nudge-compose-label">Quick messages</div>
      <div class="nudge-template-row">${templatesHtml}</div>
      <div class="nudge-compose-label" style="margin-top:14px;">
        ${existingThread ? 'Add to the conversation' : 'Your message'}
      </div>
      <textarea id="nudgeComposeText" class="nudge-compose-textarea" rows="5"
        placeholder="Write a message…" maxlength="2000"></textarea>
      <div class="nudge-compose-actions">
        <span id="nudgeComposeStatus" class="nudge-compose-status"></span>
        <span id="nudgeComposeCounter" class="nudge-char-counter">0 / 2000</span>
        <button type="button" id="nudgeComposeSend" class="primary small">Send message</button>
      </div>
    </div>
  `;

  const textarea = $('nudgeComposeText');
  const sendBtn = $('nudgeComposeSend');
  const status = $('nudgeComposeStatus');
  attachCharCounter(textarea, $('nudgeComposeCounter'), 2000);

  // Template chip click fills the textarea
  container.querySelectorAll('.nudge-template-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      textarea.value = chip.dataset.template;
      textarea.focus();
    });
  });

  sendBtn.addEventListener('click', async () => {
    const body = textarea.value.trim();
    if (!body) {
      status.textContent = 'Write a message first.';
      status.className = 'nudge-compose-status error';
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    status.textContent = '';
    try {
      const res = await fetch(
        '/api/admin/students/' + encodeURIComponent(currentStudentId) + '/nudges',
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        status.textContent = data.error || 'Could not send.';
        status.className = 'nudge-compose-status error';
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send message';
        return;
      }
      // Reload as a thread view
      openNudgeModal('thread');
    } catch (err) {
      status.textContent = 'Failed: ' + err.message;
      status.className = 'nudge-compose-status error';
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send message';
    }
  });

  setTimeout(() => textarea.focus(), 30);
}

/**
 * Render the thread view: all messages + reply box.
 */
function renderNudgeThread(container, data) {
  const messages = data.messages || [];
  const thread = data.thread;

  const messagesHtml = messages.length === 0
    ? '<p class="empty-state">No messages yet.</p>'
    : messages.map((m) => {
        const mine = m.authorRole === 'instructor';
        const when = m.createdAt ? new Date(m.createdAt.replace(' ', 'T') + 'Z').toLocaleString() : '';
        return `
          <div class="nudge-bubble-row ${mine ? 'mine' : 'theirs'}">
            <div class="nudge-bubble">
              <div class="nudge-bubble-body">${escapeHtml(m.body).replace(/\n/g, '<br>')}</div>
              <div class="nudge-bubble-time">${escapeHtml(when)}</div>
            </div>
          </div>
        `;
      }).join('');

  container.innerHTML = `
    <div class="nudge-thread">
      <div class="nudge-thread-messages">${messagesHtml}</div>
      <div class="nudge-thread-reply">
        <textarea id="nudgeReplyText" class="nudge-compose-textarea" rows="3"
          placeholder="Write a reply…" maxlength="2000"></textarea>
        <div class="nudge-compose-actions">
          <span id="nudgeReplyStatus" class="nudge-compose-status"></span>
          <span id="nudgeReplyCounter" class="nudge-char-counter">0 / 2000</span>
          <button type="button" id="nudgeReplySend" class="primary small">Send</button>
        </div>
      </div>
    </div>
  `;

  const textarea = $('nudgeReplyText');
  const sendBtn = $('nudgeReplySend');
  const status = $('nudgeReplyStatus');
  attachCharCounter(textarea, $('nudgeReplyCounter'), 2000);

  sendBtn.addEventListener('click', async () => {
    const body = textarea.value.trim();
    if (!body) {
      status.textContent = 'Write a message first.';
      status.className = 'nudge-compose-status error';
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    try {
      const res = await fetch(
        '/api/me/nudges/' + encodeURIComponent(thread.id) + '/reply',
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        }
      );
      const data2 = await res.json();
      if (!res.ok) {
        status.textContent = data2.error || 'Could not send.';
        status.className = 'nudge-compose-status error';
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        return;
      }
      openNudgeModal('thread');
    } catch (err) {
      status.textContent = 'Failed: ' + err.message;
      status.className = 'nudge-compose-status error';
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    }
  });

  setTimeout(() => textarea.focus(), 30);
}

function closeNudgeModal() {
  const modal = $('nudgeModal');
  if (modal) modal.hidden = true;
}

// ═══════════════════════════════════════════════════════════
// WebSocket client — real-time nudges + unread counts
// ═══════════════════════════════════════════════════════════

let __ws = null;
let __wsReconnectAttempts = 0;
let __wsReconnectTimer = null;

function connectWebSocket() {
  if (!currentUser) return;
  if (__ws && (__ws.readyState === WebSocket.OPEN || __ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = proto + '//' + location.host + '/ws';
  try {
    __ws = new WebSocket(url);
  } catch (err) {
    console.warn('[ws] connect failed:', err.message);
    scheduleWsReconnect();
    return;
  }

  __ws.addEventListener('open', () => {
    __wsReconnectAttempts = 0;
    console.log('[ws] connected');
  });

  __ws.addEventListener('message', (evt) => {
    let msg = null;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (!msg || !msg.type) return;
    handleWsMessage(msg);
  });

  __ws.addEventListener('close', (evt) => {
    console.log('[ws] closed', evt.code, evt.reason);
    __ws = null;
    scheduleWsReconnect();
  });

  __ws.addEventListener('error', () => {
    // Silent — the close handler runs after error and will reconnect
  });
}

function scheduleWsReconnect() {
  if (!currentUser) return;
  if (__wsReconnectTimer) return;
  // Exponential backoff capped at 30s
  const delay = Math.min(30000, 1000 * Math.pow(2, __wsReconnectAttempts));
  __wsReconnectAttempts++;
  __wsReconnectTimer = setTimeout(() => {
    __wsReconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function disconnectWebSocket() {
  if (__wsReconnectTimer) {
    clearTimeout(__wsReconnectTimer);
    __wsReconnectTimer = null;
  }
  if (__ws) {
    try { __ws.close(); } catch {}
    __ws = null;
  }
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'unread-count':
      updateUnreadBadges(msg.count);
      break;
    case 'nudge:new':
    case 'nudge:reply':
      // Refresh badge count from the server (safer than incrementing)
      refreshMyUnreadCount();
      // Refresh any open messaging UI, guarded against disrupting a
      // user who is mid-compose.
      {
        const messagesModal = $('messagesModal');
        if (messagesModal && !messagesModal.hidden) {
          if (currentMessagesThreadId === msg.threadId) {
            // Same thread is open — refresh unless the reply box has
            // unsent text (don't wipe the user's draft).
            const ta = document.getElementById('messagesReplyText');
            if (!ta || ta.value.trim().length === 0) {
              openThreadView(msg.threadId);
            }
          } else if (!currentMessagesThreadId) {
            // Threads list is showing — refresh it so the new message
            // preview and unread badge appear.
            renderThreadsList();
          }
        }

        // Instructor-side nudge modal for the currently-open student
        const nudgeModal = $('nudgeModal');
        if (nudgeModal && !nudgeModal.hidden && currentStudentId) {
          const replyTa = document.getElementById('nudgeReplyText');
          // Only refresh if the instructor isn't mid-reply
          if (!replyTa || replyTa.value.trim().length === 0) {
            void refreshNudgeThreadView();
          }
        }
      }
      // Small visual ping — briefly animate the badge
      pulseUnreadBadge();
      break;
    default:
      break;
  }
}

async function refreshMyUnreadCount() {
  try {
    const res = await fetch('/api/me/nudges/unread-count', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    updateUnreadBadges(data.count);
  } catch {}
}

function updateUnreadBadges(count) {
  const chipBadge = $('userUnreadBadge');
  const menuBadge = $('messagesMenuBadge');
  const n = Number(count) || 0;
  if (chipBadge) {
    if (n > 0) {
      chipBadge.textContent = String(n);
      chipBadge.hidden = false;
    } else {
      chipBadge.hidden = true;
    }
  }
  if (menuBadge) {
    if (n > 0) {
      menuBadge.textContent = String(n);
      menuBadge.hidden = false;
    } else {
      menuBadge.hidden = true;
    }
  }
}

function pulseUnreadBadge() {
  const b = $('userUnreadBadge');
  if (!b) return;
  b.classList.remove('pulse');
  void b.offsetWidth; // force reflow
  b.classList.add('pulse');
}

// ═══════════════════════════════════════════════════════════
// Messages inbox modal (student-side, but works for anyone)
// ═══════════════════════════════════════════════════════════

let currentMessagesThreadId = null;

async function openMessagesModal() {
  const modal = $('messagesModal');
  if (!modal) return;
  modal.hidden = false;
  currentMessagesThreadId = null;
  updateMessagesModalChrome('threads');
  await renderThreadsList();
}

function closeMessagesModal() {
  const modal = $('messagesModal');
  if (modal) modal.hidden = true;
  currentMessagesThreadId = null;
}

function updateMessagesModalChrome(mode) {
  const back = $('messagesModalBack');
  const title = $('messagesModalTitle');
  if (!back || !title) return;
  if (mode === 'thread') {
    back.hidden = false;
    title.textContent = 'Conversation';
  } else {
    back.hidden = true;
    title.textContent = 'Messages';
  }
}

async function renderThreadsList() {
  const body = $('messagesModalBody');
  if (!body) return;
  body.innerHTML = '<p class="empty-state">Loading…</p>';

  try {
    const res = await fetch('/api/me/nudges', { credentials: 'same-origin' });
    const data = await res.json();
    const threads = (data && data.threads) || [];

    if (threads.length === 0) {
      body.innerHTML = '<p class="empty-state">No messages yet. Your tutor may reach out when they see something worth discussing.</p>';
      return;
    }

    body.innerHTML = threads.map((t) => {
      const when = t.lastMessageAtDisplay
        ? new Date(t.lastMessageAtDisplay.replace(' ', 'T') + 'Z').toLocaleString()
        : '';
      const preview = (t.lastMessageBody || '').slice(0, 100);
      const unread = t.unreadCount > 0
        ? '<span class="thread-row-badge">' + t.unreadCount + '</span>'
        : '';
      return (
        '<button type="button" class="thread-row ' + (t.unreadCount > 0 ? 'has-unread' : '') + '" data-thread-id="' + escapeHtml(t.id) + '">' +
          '<div class="thread-row-header">' +
            '<span class="thread-row-name">' + escapeHtml(t.otherPartyName) + '</span>' +
            unread +
            '<span class="thread-row-time">' + escapeHtml(when) + '</span>' +
          '</div>' +
          '<div class="thread-row-preview">' + escapeHtml(preview) + '</div>' +
        '</button>'
      );
    }).join('');

    // Wire each row
    body.querySelectorAll('.thread-row').forEach((row) => {
      row.addEventListener('click', () => {
        openThreadView(row.dataset.threadId);
      });
    });
  } catch (err) {
    body.innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
  }
}

async function openThreadView(threadId) {
  const body = $('messagesModalBody');
  if (!body) return;

  // Preserve any in-progress reply draft across re-renders so a WS
  // event arriving mid-compose doesn't wipe what the user was typing.
  const existingReply = document.getElementById('messagesReplyText');
  const draft = existingReply ? existingReply.value : '';
  const draftStart = existingReply ? existingReply.selectionStart : 0;
  const draftEnd = existingReply ? existingReply.selectionEnd : 0;

  currentMessagesThreadId = threadId;
  updateMessagesModalChrome('thread');
  body.innerHTML = '<p class="empty-state">Loading…</p>';

  try {
    const res = await fetch('/api/me/nudges/' + encodeURIComponent(threadId), { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = '<p class="empty-state">Could not load conversation.</p>';
      return;
    }
    const data = await res.json();
    const messages = data.messages || [];
    const thread = data.thread;

    const messagesHtml = messages.length === 0
      ? '<p class="empty-state">No messages yet.</p>'
      : messages.map((m) => {
          const mine = m.authorId === (currentUser && currentUser.id);
          const when = m.createdAt
            ? new Date(m.createdAt.replace(' ', 'T') + 'Z').toLocaleString()
            : '';
          return (
            '<div class="nudge-bubble-row ' + (mine ? 'mine' : 'theirs') + '">' +
              '<div class="nudge-bubble">' +
                '<div class="nudge-bubble-body">' + escapeHtml(m.body).replace(/\n/g, '<br>') + '</div>' +
                '<div class="nudge-bubble-time">' + escapeHtml(when) + '</div>' +
              '</div>' +
            '</div>'
          );
        }).join('');

    body.innerHTML =
      '<div class="nudge-thread">' +
        '<div class="nudge-thread-messages">' + messagesHtml + '</div>' +
        '<div class="nudge-thread-reply">' +
          '<textarea id="messagesReplyText" class="nudge-compose-textarea" rows="3" placeholder="Write a reply…" maxlength="2000"></textarea>' +
          '<div class="nudge-compose-actions">' +
            '<span id="messagesReplyStatus" class="nudge-compose-status"></span>' +
            '<span id="messagesReplyCounter" class="nudge-char-counter">0 / 2000</span>' +
            '<button type="button" id="messagesReplySend" class="primary small">Send</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    const ta = $('messagesReplyText');
    const sendBtn = $('messagesReplySend');
    const status = $('messagesReplyStatus');
    attachCharCounter(ta, $('messagesReplyCounter'), 2000);

    sendBtn.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text) {
        status.textContent = 'Write a message first.';
        status.className = 'nudge-compose-status error';
        return;
      }
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      try {
        const r2 = await fetch('/api/me/nudges/' + encodeURIComponent(threadId) + '/reply', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: text }),
        });
        const d2 = await r2.json();
        if (!r2.ok) {
          status.textContent = d2.error || 'Could not send.';
          status.className = 'nudge-compose-status error';
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send';
          return;
        }
        openThreadView(threadId);
      } catch (err) {
        status.textContent = 'Failed: ' + err.message;
        status.className = 'nudge-compose-status error';
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
      }
    });

    // Restore any draft the user was typing before the re-render
    if (draft) {
      ta.value = draft;
      try {
        ta.selectionStart = draftStart;
        ta.selectionEnd = draftEnd;
      } catch {}
      // Trigger the counter update
      ta.dispatchEvent(new Event('input'));
    }

    // Mark read
    try {
      await fetch('/api/me/nudges/' + encodeURIComponent(threadId) + '/read', {
        method: 'POST',
        credentials: 'same-origin',
      });
      refreshMyUnreadCount();
    } catch {}

    setTimeout(() => ta && ta.focus(), 30);
  } catch (err) {
    body.innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
  }
}



/**
 * Attach a live character counter to a textarea.
 * @param textarea  the <textarea> element
 * @param counterEl the element to write "123 / 2000" into
 * @param max       the maximum length (matches the textarea's maxlength)
 */
function attachCharCounter(textarea, counterEl, max) {
  if (!textarea || !counterEl) return;
  function update() {
    var n = textarea.value.length;
    counterEl.textContent = n + ' / ' + max;
    counterEl.classList.remove('warn', 'full');
    if (n >= max) counterEl.classList.add('full');
    else if (n >= max * 0.9) counterEl.classList.add('warn');
  }
  textarea.addEventListener('input', update);
  update();
}

/**
 * Refresh the instructor-side nudge modal's thread view WITHOUT
 * re-marking messages read and without disrupting a user who is
 * currently typing.
 */
async function refreshNudgeThreadView() {
  if (!currentStudentId) return;
  const bodyEl = $('nudgeModalBody');
  if (!bodyEl) return;

  // Preserve draft across re-render (instructor side)
  const existingReply = document.getElementById('nudgeReplyText');
  const draft = existingReply ? existingReply.value : '';
  const draftStart = existingReply ? existingReply.selectionStart : 0;
  const draftEnd = existingReply ? existingReply.selectionEnd : 0;

  try {
    const res = await fetch(
      '/api/admin/students/' + encodeURIComponent(currentStudentId) + '/nudges',
      { credentials: 'same-origin' }
    );
    if (!res.ok) return;
    const data = await res.json();
    if (data.thread) {
      renderNudgeThread(bodyEl, data);
      // Restore draft
      if (draft) {
        const ta = document.getElementById('nudgeReplyText');
        if (ta) {
          ta.value = draft;
          try {
            ta.selectionStart = draftStart;
            ta.selectionEnd = draftEnd;
          } catch {}
          ta.dispatchEvent(new Event('input'));
        }
      }
    }
  } catch {
    // silent
  }
}

// ═══════════════════════════════════════════════════════════
// Analytics tab (cohort-level dashboard)
// ═══════════════════════════════════════════════════════════

let analyticsCohortsLoaded = false;

async function loadAnalytics() {
  const picker = $('analyticsCohort');
  const body = $('analyticsBody');
  if (!picker || !body) return;

  // Populate the picker once per session (or when the instructor's
  // cohort list may have changed — simplest: repopulate every tab open).
  try {
    const res = await fetch('/api/admin/cohorts', { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = '<p class="empty-state">Could not load your cohorts.</p>';
      return;
    }
    const cohorts = await res.json();

    if (!cohorts.length) {
      picker.innerHTML = '<option value="">No cohorts yet</option>';
      body.innerHTML = '<p class="empty-state">Create a cohort from the Exercises tab first.</p>';
      return;
    }

    // Preserve current selection if still valid
    const previousValue = picker.value;
    picker.innerHTML = cohorts.map((c) =>
      '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + '</option>'
    ).join('');
    if (previousValue && cohorts.some((c) => c.id === previousValue)) {
      picker.value = previousValue;
    }

    analyticsCohortsLoaded = true;
  } catch (err) {
    body.innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
    return;
  }

  await loadAnalyticsFor(picker.value);
}

async function loadAnalyticsFor(cohortId) {
  const body = $('analyticsBody');
  if (!body) return;
  if (!cohortId) {
    body.innerHTML = '<p class="empty-state">Select a cohort above.</p>';
    return;
  }

  body.innerHTML = '<p class="empty-state">Loading…</p>';

  try {
    const res = await fetch(
      '/api/admin/analytics/' + encodeURIComponent(cohortId),
      { credentials: 'same-origin' }
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      body.innerHTML = '<p class="empty-state">' + escapeHtml(data.error || 'Could not load analytics.') + '</p>';
      return;
    }
    const data = await res.json();
    renderAnalytics(body, data);
  } catch (err) {
    body.innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
  }
}

/**
 * Render the "Teaching opportunities" panel from the analytics payload.
 * Returns HTML string. Empty array → friendly empty state.
 */
function renderOpportunities(opportunities) {
  if (!opportunities || opportunities.length === 0) {
    return (
      '<div class="analytics-section">' +
        '<h3 class="analytics-section-title">Teaching opportunities</h3>' +
        '<p class="analytics-opportunities-empty">' +
          '✅ No notable signals this week. Keep going.' +
        '</p>' +
      '</div>'
    );
  }

  const sevIcon = {
    high:   '🔴',
    medium: '🟡',
    info:   'ℹ️',
  };

  const rows = opportunities.map((o) => {
    const icon = sevIcon[o.severity] || '•';
    const dataAttrs = [
      o.exerciseId ? 'data-exercise-id="' + escapeHtml(o.exerciseId) + '"' : '',
      o.pattern ? 'data-pattern="' + escapeHtml(o.pattern) + '"' : '',
    ].filter(Boolean).join(' ');

    const clickable = !!o.filter;
    const clickAttrs = clickable
      ? ' role="button" tabindex="0" style="cursor:pointer;" data-filter-by="' + escapeHtml(o.filter.by) + '" data-filter-value="' + escapeHtml(o.filter.value) + '"'
      : '';

    return (
      '<div class="analytics-opportunity ' + o.severity + (clickable ? ' analytics-opportunity-clickable' : '') + '" ' + dataAttrs + clickAttrs + '>' +
        '<div class="analytics-opportunity-icon">' + icon + '</div>' +
        '<div class="analytics-opportunity-body">' +
          '<div class="analytics-opportunity-title">' + escapeHtml(o.title) + '</div>' +
          '<div class="analytics-opportunity-detail">' + escapeHtml(o.detail) + '</div>' +
        '</div>' +
        (clickable ? '<div class="analytics-opportunity-arrow">→</div>' : '') +
      '</div>'
    );
  }).join('');

  return (
    '<div class="analytics-section">' +
      '<h3 class="analytics-section-title">Teaching opportunities</h3>' +
      '<div class="analytics-opportunities">' + rows + '</div>' +
    '</div>'
  );
}

/**
 * Render the "Highlights" panel from the analytics payload.
 * Returns HTML string, or '' if there are no highlights (panel hidden).
 */
function renderHighlights(highlights) {
  if (!highlights || highlights.length === 0) return '';

  const rows = highlights.map((h) => (
    '<div class="analytics-highlight ' + escapeHtml(h.kind) + '">' +
      '<div class="analytics-highlight-icon">🎉</div>' +
      '<div class="analytics-highlight-body">' +
        '<div class="analytics-highlight-title">' + escapeHtml(h.title) + '</div>' +
        '<div class="analytics-highlight-detail">' + escapeHtml(h.detail) + '</div>' +
      '</div>' +
    '</div>'
  )).join('');

  return (
    '<div class="analytics-section">' +
      '<h3 class="analytics-section-title">Highlights</h3>' +
      '<div class="analytics-highlights">' + rows + '</div>' +
    '</div>'
  );
}

function renderAnalytics(container, data) {
  const s = data.summary;
  const bd = data.statusBreakdown;
  const total = data.studentCount || 0;
  const pct = (n) => total > 0 ? Math.round((n / total) * 100) : 0;

  // Summary metric cards
  const summaryCards = [
    { label: 'Enrolled', value: total },
    { label: 'Avg reasoning', value: s.avgReasoningPct === null ? '—' : s.avgReasoningPct + '%' },
    { label: 'Median progress', value: s.medianProgressPct === null ? '—' : Math.round(s.medianProgressPct) + '%' },
    { label: 'Avg hints / session', value: s.avgHintsPerSession === null ? '—' : s.avgHintsPerSession.toFixed(1) },
  ];

  const statusRows = [
    { key: 'onTrack',  label: 'On track',  count: bd.onTrack,  cls: 'status-row-ontrack' },
    { key: 'slipping', label: 'Slipping',  count: bd.slipping, cls: 'status-row-slipping' },
    { key: 'atRisk',   label: 'At-risk',   count: bd.atRisk,   cls: 'status-row-atrisk' },
    { key: 'new',      label: 'New',       count: bd.new,      cls: 'status-row-new' },
  ];

  // Weekly sparklines via the shared renderActivityGrid approach?
  // Simpler: build a small inline sparkline using the same technique
  // used in the metric cards.
  const reasoningSpark = renderAnalyticsSparkline(data.weeklyTrends.reasoningQuality, {
    classification: 'stable',
    scale: 1,
  });
  const sessionsSpark = renderAnalyticsSparkline(data.weeklyTrends.sessions, {
    classification: 'stable',
    scale: null, // auto
  });

  container.innerHTML = `
    <div class="analytics-summary-row">
      ${summaryCards.map((c) => `
        <div class="analytics-card">
          <div class="analytics-card-label">${escapeHtml(c.label)}</div>
          <div class="analytics-card-value">${escapeHtml(String(c.value))}</div>
        </div>
      `).join('')}
    </div>

    ${renderOpportunities(data.opportunities)}

    ${renderHighlights(data.highlights)}

    <div class="analytics-section">
      <h3 class="analytics-section-title">Status breakdown</h3>
      <div class="analytics-status-rows">
        ${statusRows.map((r) => `
          <div class="analytics-status-row">
            <span class="analytics-status-label">${escapeHtml(r.label)}</span>
            <div class="analytics-status-bar">
              <div class="analytics-status-fill ${r.cls}" style="width:${pct(r.count)}%"></div>
            </div>
            <span class="analytics-status-count">${r.count} <span class="muted">(${pct(r.count)}%)</span></span>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="analytics-section">
      <h3 class="analytics-section-title">Reasoning quality (last 12 weeks)</h3>
      <div class="analytics-spark-wrap">${reasoningSpark}</div>
    </div>

    <div class="analytics-section">
      <h3 class="analytics-section-title">Completed sessions (last 12 weeks)</h3>
      <div class="analytics-spark-wrap">${sessionsSpark}</div>
    </div>
  `;

  if (typeof wireAnalyticsClicks === 'function') wireAnalyticsClicks();
}

/**
 * A simple bar-chart sparkline for the analytics tab. Each bar = one
 * week. Null values render as an empty bar.
 *
 * opts.scale = fixed numeric max; null for auto-scale to the max value.
 */
function renderAnalyticsSparkline(points, opts) {
  if (!points || points.length === 0) {
    return '<p class="empty-state">No data.</p>';
  }
  const valid = points.map((p) => p.value).filter((v) => v !== null);
  const maxRaw = valid.length ? Math.max.apply(null, valid) : 0;
  const max = opts.scale !== null && opts.scale !== undefined
    ? opts.scale
    : (maxRaw > 0 ? maxRaw : 1);

  const bars = points.map((p) => {
    const v = p.value;
    const h = v === null ? 0 : Math.max(2, Math.round((v / max) * 40));
    const cls = v === null ? 'empty' : '';
    const label = p.weekStart + ': ' + (v === null ? 'no data' : v);
    return '<div class="analytics-bar ' + cls + '" style="height:' + h + 'px" title="' + escapeHtml(label) + '"></div>';
  }).join('');

  return '<div class="analytics-bars">' + bars + '</div>';
}

// ═══════════════════════════════════════════════════════════
// My sessions tab (student transparency)
// ═══════════════════════════════════════════════════════════

let __mySessionsExpanded = null; // currently-expanded session id, or null

async function loadMySessions() {
  const body = $('mySessionsBody');
  if (!body) return;
  body.innerHTML = '<p class="empty-state">Loading…</p>';

  try {
    const res = await fetch('/api/me/sessions', { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = '<p class="empty-state">Could not load your sessions.</p>';
      return;
    }
    const data = await res.json();
    const sessions = data.sessions || [];

    if (sessions.length === 0) {
      body.innerHTML =
        '<p class="empty-state">You haven\'t started any debug sessions yet. ' +
        'Once you do, everything the tutor captures about your work will appear here.</p>';
      return;
    }

    const intro = `
      <div class="my-sessions-intro">
        <p>
          These are the debug sessions your tutor can replay. For each session we
          capture: <strong>code editor snapshots</strong> (at hint boundaries, on
          "I fixed it", and when you leave the editor), your <strong>hints</strong>,
          your <strong>hypotheses</strong>, and your <strong>post-mortems</strong>.
          We do not record individual keystrokes.
        </p>
      </div>
    `;

    const sessionRows = sessions.map((s) => {
      const absoluteWhen = s.updatedAt
        ? new Date(s.updatedAt.replace(' ', 'T') + 'Z').toLocaleString()
        : '';
      const when = s.updatedAt ? relativeTime(s.updatedAt) : '';
      const stateLabel = s.state === 'complete' ? 'Complete'
        : s.state === 'resolved' ? 'Awaiting post-mortem'
        : 'In progress';
      const stateCls = s.state === 'complete' ? 'ms-state-complete'
        : s.state === 'resolved' ? 'ms-state-resolved'
        : 'ms-state-open';

      const typeLabels = {
        'code-snapshot': 'code snapshots',
        'hint-request': 'hint requests',
        'hint-served': 'hints received',
        'hypothesis-written': 'hypotheses written',
        'post-mortem-saved': 'post-mortems',
        'session-completed': 'session completion events',
      };
      const eventSummary = (s.eventTypes || []).length
        ? (s.eventTypes || []).map((t) =>
            '<span class="ms-type-chip">' + escapeHtml(String(t.count)) + ' ' +
            escapeHtml(typeLabels[t.type] || t.type) + '</span>'
          ).join('')
        : '<span class="muted">No events captured yet.</span>';

      const expanded = __mySessionsExpanded === s.sessionId;
      const detailHtml = expanded ? '<div class="ms-detail" data-session-detail="' + escapeHtml(s.sessionId) + '"><p class="empty-state">Loading events…</p></div>' : '';

      return `
        <div class="ms-session-card" data-session-id="${escapeHtml(s.sessionId)}">
          <div class="ms-session-header">
            <div>
              <div class="ms-session-title">${escapeHtml(s.exerciseTitle)}</div>
              <div class="ms-session-meta" title="${escapeHtml(absoluteWhen)}">${escapeHtml(when)} · <span class="${stateCls}">${escapeHtml(stateLabel)}</span></div>
            </div>
            <button class="ms-toggle-btn" data-session-toggle="${escapeHtml(s.sessionId)}">
              ${expanded ? 'Hide events' : 'Show events'}
            </button>
          </div>
          <div class="ms-session-events-summary">
            <span class="ms-session-total">${s.eventCount} event${s.eventCount === 1 ? '' : 's'} captured</span>
            <div class="ms-type-chips">${eventSummary}</div>
          </div>
          ${detailHtml}
        </div>
      `;
    }).join('');

    body.innerHTML = intro + sessionRows;

    // Wire toggles
    body.querySelectorAll('[data-session-toggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const sid = btn.dataset.sessionToggle;
        __mySessionsExpanded = (__mySessionsExpanded === sid) ? null : sid;
        await loadMySessions();
        // If we just expanded, fetch the events
        if (__mySessionsExpanded) {
          loadMySessionEvents(sid);
        }
      });
    });

    // If a session was already expanded, fetch its events
    if (__mySessionsExpanded) {
      loadMySessionEvents(__mySessionsExpanded);
    }
  } catch (err) {
    body.innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
  }
}

async function loadMySessionEvents(sessionId) {
  const container = document.querySelector('[data-session-detail="' + CSS.escape(sessionId) + '"]');
  if (!container) return;
  try {
    const res = await fetch(
      '/api/me/sessions/' + encodeURIComponent(sessionId) + '/events',
      { credentials: 'same-origin' }
    );
    if (!res.ok) {
      container.innerHTML = '<p class="empty-state">Could not load events.</p>';
      return;
    }
    const data = await res.json();
    const events = data.events || [];
    if (events.length === 0) {
      container.innerHTML = '<p class="empty-state">No events recorded for this session yet.</p>';
      return;
    }

    const labels = {
      'code-snapshot': 'Code snapshot',
      'hint-request': 'Hint requested',
      'hint-served': 'Hint served',
      'hypothesis-written': 'Hypothesis written',
      'post-mortem-saved': 'Post-mortem saved',
      'session-completed': 'Session completed',
    };

    container.innerHTML = '<ul class="ms-event-list">' + events.map((e) => {
      const when = e.recordedAt
        ? new Date(e.recordedAt.replace(' ', 'T') + 'Z').toLocaleTimeString()
        : '';
      const label = labels[e.type] || e.type;
      return '<li class="ms-event-row"><span class="ms-event-time">' + escapeHtml(when) + '</span><span class="ms-event-label">' + escapeHtml(label) + '</span></li>';
    }).join('') + '</ul>';
  } catch (err) {
    container.innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
  }
}

// ═══════════════════════════════════════════════════════════
// Filtered students view (Analytics → opportunity → filter)
// ═══════════════════════════════════════════════════════════

function showFilteredStudents() {
  // Hide top-level sections that share the layout
  document.querySelectorAll('section').forEach((sec) => {
    sec.hidden = true;
  });
  const sd = document.getElementById('studentDetailView');
  if (sd) sd.hidden = true;
  const sed = document.getElementById('studentExerciseDetailView');
  if (sed) sed.hidden = true;

  const view = document.getElementById('filteredStudentsView');
  if (view) view.hidden = false;

  window.scrollTo(0, 0);
}

async function loadFilteredStudents(by, value) {
  const titleEl = $('filteredStudentsTitle');
  const subEl = $('filteredStudentsSubtitle');
  const tableEl = $('filteredStudentsTable');
  if (!titleEl || !tableEl) return;

  titleEl.textContent = 'Loading…';
  subEl.textContent = '';
  tableEl.innerHTML = '<p class="empty-state">Loading…</p>';

  try {
    const url = '/api/admin/students/filter?by=' + encodeURIComponent(by) +
                '&value=' + encodeURIComponent(value);
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      tableEl.innerHTML = '<p class="empty-state">' + escapeHtml(data.error || 'Could not load.') + '</p>';
      return;
    }
    const data = await res.json();
    const students = data.students || [];
    const label = (data.filter && data.filter.label) || 'Filtered students';

    titleEl.textContent = label;
    subEl.textContent = students.length + ' student' + (students.length === 1 ? '' : 's');

    if (students.length === 0) {
      tableEl.innerHTML = '<p class="empty-state">No students match this filter right now.</p>';
      return;
    }

    // Reuse the roster table markup by duplicating the essential parts.
    // We could refactor into a shared helper later.
    const rows = students.map((s) => {
      const activityHtml = typeof renderRosterActivity === 'function'
        ? renderRosterActivity(s.activity30d)
        : '—';
      const progressHtml = typeof renderCompactProgress === 'function'
        ? renderCompactProgress(s.exercisesCompleted, s.assigned)
        : (s.exercisesCompleted + ' / ' + s.assigned);
      return `
        <tr data-student-id="${escapeHtml(s.studentId)}" style="cursor:pointer;">
          <td>
            <span class="student-name-cell">${escapeHtml(s.displayName)}</span>
            <span class="student-email-cell">${escapeHtml(s.email)}</span>
          </td>
          <td>${(s.cohortNames || []).map((n) => escapeHtml(n)).join(', ')}</td>
          <td>${activityHtml}</td>
          <td>${progressHtml}</td>
          <td>${s.lastActiveAt ? relativeTime(s.lastActiveAt) : '—'}</td>
          <td>${renderStatusBadge(s.status, s.statusReasons)}</td>
        </tr>
      `;
    }).join('');

    tableEl.innerHTML = `
      <table class="students-table">
        <thead>
          <tr>
            <th>Student</th>
            <th>Classes</th>
            <th>Activity (30d)</th>
            <th>Completed</th>
            <th>Last active</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    tableEl.querySelectorAll('tr[data-student-id]').forEach((row) => {
      row.addEventListener('click', () => {
        openStudentDetail(row.dataset.studentId);
      });
    });
  } catch (err) {
    tableEl.innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
  }
}

/**
 * Navigate to the filtered students view.
 */
function openFilteredStudents(by, value) {
  if (!by || !value) return;
  window.location.hash = 'filter?by=' + encodeURIComponent(by) + '&value=' + encodeURIComponent(value);
  showFilteredStudents();
  loadFilteredStudents(by, value);
}

/**
 * Delegate click handlers on the analytics body — opportunity cards
 * navigate to the filter view when they carry data-filter-*.
 */
function wireAnalyticsClicks() {
  const body = document.getElementById('analyticsBody');
  if (!body || body.__wiredFilters) return;
  body.__wiredFilters = true;
  body.addEventListener('click', (e) => {
    const card = e.target.closest && e.target.closest('[data-filter-by]');
    if (!card) return;
    const by = card.dataset.filterBy;
    const value = card.dataset.filterValue;
    if (by && value) openFilteredStudents(by, value);
  });
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest && e.target.closest('[data-filter-by]');
    if (!card) return;
    e.preventDefault();
    const by = card.dataset.filterBy;
    const value = card.dataset.filterValue;
    if (by && value) openFilteredStudents(by, value);
  });
}

function renderNextAction(nextAction) {
  const el = $('sdNextAction');
  if (!el) return;

  if (!nextAction || nextAction.kind === 'none') {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  el.className = 'sd-next-action sd-next-action-' + nextAction.kind;
  el.style.display = 'block';

  // Split content into a left text block and a right action area
  // (with an optional "Nudge" button).
  const titleHtml = '<div class="sd-next-action-title">' + escapeHtml(nextAction.title) + '</div>';
  const detailHtml = '<div class="sd-next-action-detail">' + escapeHtml(nextAction.detail) + '</div>';
  const nudgeBtnHtml = currentStudentId
    ? '<button type="button" class="sd-next-action-nudge" data-nudge-open="1">✉ Nudge</button>'
    : '';

  el.innerHTML =
    '<div class="sd-next-action-content">' +
      '<div class="sd-next-action-text">' + titleHtml + detailHtml + '</div>' +
      '<div class="sd-next-action-actions">' + nudgeBtnHtml + '</div>' +
    '</div>';

  // Wire the nudge button if present
  const nudgeBtn = el.querySelector('[data-nudge-open]');
  if (nudgeBtn && currentStudentId) {
    nudgeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openNudgeModal('compose');
    });
  }

  // Click-through behavior on the banner itself (existing behavior)
  if (nextAction.clickable && nextAction.exerciseId) {
    el.style.cursor = 'pointer';
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    const go = () => openExerciseDetail(
      currentStudentId,
      nextAction.exerciseId,
      nextAction.exerciseTitle || nextAction.exerciseId
    );
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  } else {
    el.style.cursor = 'default';
    el.removeAttribute('role');
    el.removeAttribute('tabindex');
  }
}

/**
 * Render the "Compared with <cohort>" panel. Hidden when the student
 * has no same-cohort peers (peerCount === 0) or when there is no data.
 */
function renderCohortComparison(cc) {
  const el = $('sdCohortComparison');
  if (!el) return;

  // No cohort at all → hide the panel entirely.
  if (!cc || !cc.cohortNames || cc.cohortNames.length === 0) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  const cohortLabel = (cc.cohortNames || []).join(', ') || 'your cohort';

  // In a cohort, but no peers yet — show a friendly note instead of
  // silently hiding the panel, so the instructor knows comparison
  // will be possible once more students join.
  if (cc.peerCount === 0) {
    el.style.display = 'block';
    el.innerHTML =
      '<h3 class="sd-section-heading">Compared with ' + escapeHtml(cohortLabel) + '</h3>' +
      '<div class="sd-cc-empty-note">' +
        'Not enough peers yet — this is the only student in the cohort.' +
      '</div>';
    return;
  }

  // Row renderer for one metric
  function row(label, metric, formatValue, formatPct) {
    // formatPct(v) → 0..100 for bar width; formatValue(v) → display string
    const sPct = metric.student === null ? null : formatPct(metric.student);
    const mPct = metric.median === null ? null : formatPct(metric.median);
    const sCls = sPct === null ? 'progress-empty' : progressClass(sPct / 100);
    const mCls = mPct === null ? 'progress-empty' : progressClass(mPct / 100);
    const sVal = metric.student === null ? '—' : formatValue(metric.student);
    const mVal = metric.median === null ? '—' : formatValue(metric.median);

    // For "lower is better" metrics, invert the bar so a smaller
    // value still renders as a smaller bar (semantically correct).
    const sWidth = sPct === null ? 0 : Math.min(100, Math.max(0, sPct));
    const mWidth = mPct === null ? 0 : Math.min(100, Math.max(0, mPct));

    return (
      '<div class="sd-cc-row">' +
        '<div class="sd-cc-label">' + escapeHtml(label) +
          (metric.higherIsBetter ? '' : ' <span class="sd-cc-hint">(lower is better)</span>') +
        '</div>' +
        '<div class="sd-cc-bars">' +
          '<div class="sd-cc-bar-line">' +
            '<span class="sd-cc-bar-name">This student</span>' +
            '<div class="sd-cc-bar"><div class="sd-cc-bar-fill ' + sCls + '" style="width:' + sWidth + '%"></div></div>' +
            '<span class="sd-cc-bar-value">' + escapeHtml(sVal) + '</span>' +
          '</div>' +
          '<div class="sd-cc-bar-line">' +
            '<span class="sd-cc-bar-name">Class median</span>' +
            '<div class="sd-cc-bar"><div class="sd-cc-bar-fill ' + mCls + '" style="width:' + mWidth + '%"></div></div>' +
            '<span class="sd-cc-bar-value">' + escapeHtml(mVal) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  el.style.display = 'block';
  el.innerHTML =
    '<h3 class="sd-section-heading">Compared with ' + escapeHtml(cohortLabel) + '</h3>' +
    row(
      'Reasoning quality',
      cc.metrics.reasoningQuality,
      (v) => Math.round(v * 100) + '%',
      (v) => v * 100
    ) +
    row(
      'Hint dependency',
      cc.metrics.hintDependency,
      (v) => v.toFixed(1),
      // Normalize hints-per-session to 0..100 for the bar. Use 5 as a
      // soft ceiling — above that the bar caps out.
      (v) => Math.min(100, (v / 5) * 100)
    ) +
    row(
      'Progress',
      cc.metrics.progress,
      (v) => Math.round(v * 100) + '%',
      (v) => v * 100
    ) +
    '<div class="sd-cc-footer">Based on ' + cc.peerCount + ' other student' +
      (cc.peerCount === 1 ? '' : 's') + ' in this cohort.</div>';
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '—';
  const diff = Date.now() - then;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  const hr = Math.round(min / 60);
  if (hr < 24) return hr + 'h ago';
  const days = Math.round(hr / 24);
  if (days < 30) return days + 'd ago';
  return new Date(iso).toLocaleDateString();
}

// Tab wiring
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (tab.dataset.tab === 'students') {
      showStudentsRoster();
      loadStudentsRoster();
    }
  });
});

// Range filter
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'studentsRange') {
    loadStudentsRoster();
  }
});

// ═══════════════════════════════════════════════════════════
// Student detail view
// ═══════════════════════════════════════════════════════════

let currentStudentId = null;

function showStudentsRoster() {
  $('studentsRoster').hidden = false;
  var hdr = document.getElementById('studentsPanelHeader');
  if (hdr) hdr.hidden = false;
  $('studentDetailView').hidden = true;
  const exView = $('studentExerciseDetailView');
  if (exView) exView.hidden = true;
  currentStudentId = null;
}

function showStudentDetail() {
  $('studentsRoster').hidden = true;
  var hdr = document.getElementById('studentsPanelHeader');
  if (hdr) hdr.hidden = true;
  $('studentDetailView').hidden = false;
  const exView = $('studentExerciseDetailView');
  if (exView) exView.hidden = true;
}

async function openStudentDetail(studentId) {
  currentStudentId = studentId;
  showStudentDetail();
  clearStudentDetail();

  // Restore the desktop collapse state from localStorage
  if (typeof setNotesPanelCollapsed === 'function' && !isMobileNotes()) {
    setNotesPanelCollapsed(notesPanelCollapsed());
  }

  try {
    const res = await fetch('/api/admin/students/' + encodeURIComponent(studentId));
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Could not load student.');
      showStudentsRoster();
      return;
    }
    const data = await res.json();
    renderStudentDetail(data);
    if (typeof renderTrends === 'function') renderTrends(data);

    // Load tutor notes for this student. The roster cache carries
    // cohortIds so we can scope notes to a specific cohort.
    const rosterEntry = (window.__studentsRoster || []).find(
      (s) => s.studentId === studentId
    );
    const cohortId =
      rosterEntry && rosterEntry.cohortIds && rosterEntry.cohortIds[0];
    await loadTutorNotes(studentId, cohortId || null);
  } catch (err) {
    alert('Failed: ' + err.message);
    showStudentsRoster();
  }
}

function clearStudentDetail() {
  $('sdName').textContent = '—';
  $('sdEmail').textContent = '—';
  $('sdClasses').textContent = '—';
  $('sdJoined').textContent = '—';
  $('sdStatusBadge').innerHTML = '';
  $('sdReasoningValue').textContent = '—';
  $('sdReasoningSub').textContent = 'Loading...';
  var rqm = $('sdReasoningMeta'); if (rqm) rqm.innerHTML = '';
  $('sdHintDepValue').textContent = '—';
  $('sdHintDepSub').textContent = 'Loading...';
  var hdm = $('sdHintDepMeta'); if (hdm) hdm.innerHTML = '';
  $('sdProgressValue').textContent = '—';
  $('sdProgressSub').textContent = 'Loading...';
  var pgm = $('sdProgressMeta'); if (pgm) pgm.innerHTML = '';
  // Clear sparkline containers so switching students doesn't show stale trends
  var rt = $('sdReasoningTrend'); if (rt) rt.innerHTML = '';
  var ht = $('sdHintDepTrend'); if (ht) ht.innerHTML = '';
  var pt = $('sdProgressTrend'); if (pt) pt.innerHTML = '';
  $('sdWeakSpots').innerHTML = '<p class="empty-state">Loading...</p>';
  $('sdSessionHistory').innerHTML = '<p class="empty-state">Loading...</p>';
  var st = $('sdStrengths'); if (st) st.innerHTML = '<p class="empty-state">Loading...</p>';
  var na = $('sdNextAction'); if (na) { na.style.display = 'none'; na.innerHTML = ''; }
  var cc = $('sdCohortComparison'); if (cc) { cc.style.display = 'none'; cc.innerHTML = ''; }
  var ac = $('sdActivity'); if (ac) { ac.style.display = 'none'; ac.innerHTML = ''; }
  $('sdTimeValue').textContent = '—';
  $('sdTimeSub').textContent = 'Loading...';
}

function renderStudentDetail(data) {
  // The roster row data isn't passed through, so we fetch what we can from
  // the detail response and rely on the roster list for names.
  // Identity — prefer the detail payload (which now carries name/email/
  // joinedAt/classes), fall back to the roster cache for older servers.
  const roster = window.__studentsRoster || [];
  const rosterEntry = roster.find((s) => s.studentId === data.studentId);

  const displayName = data.name || rosterEntry?.displayName || '—';
  const email = data.email || rosterEntry?.email || '—';
  const classes = (Array.isArray(data.classes) && data.classes.length)
    ? data.classes.join(', ')
    : ((rosterEntry?.cohortNames || []).join(', ') || '—');
  const joinedAt = data.joinedAt || rosterEntry?.joinedAt || null;

  $('sdName').textContent = displayName;
  $('sdEmail').textContent = email;

  // Message icon next to the name — opens the nudge thread
  wireStudentNudgeIcon();
  $('sdClasses').textContent = classes;
  $('sdJoined').textContent = joinedAt
    ? new Date(joinedAt).toLocaleDateString()
    : '—';

  const status = data.status || rosterEntry?.status;
  const statusReasons = data.statusReasons || rosterEntry?.statusReasons || [];
  $('sdStatusBadge').innerHTML = status ? renderStatusBadge(status, statusReasons) : '';

  // Recommended next action banner
  renderNextAction(data.nextAction);

  // Danger zone (delete student data)
  wireStudentDangerZone({
    displayName: displayName,
  });

  // Cohort comparison panel
  renderCohortComparison(data.cohortComparison);

  // Activity heatmap
  renderActivity(data.activity);

  // Reasoning quality card
  // NOTE: sdReasoningSub is owned by renderTrends (writes the trend label).
  // We write the metric breakdown + outcomes summary into sdReasoningMeta,
  // which renderTrends never touches.
  const rq = data.metrics.reasoningQuality;
  const rqMeta = $('sdReasoningMeta');
  if (rq.total === 0) {
    $('sdReasoningValue').textContent = '—';
    if (rqMeta) rqMeta.textContent = 'No hypotheses yet';
  } else {
    const precisePct = Math.round((rq.precise / rq.total) * 100);
    $('sdReasoningValue').textContent = precisePct + '%';
    let meta = rq.precise + ' precise · ' + rq.plausible + ' plausible · ' + rq.vague + ' vague' +
      (rq.unscored ? ' · ' + rq.unscored + ' unscored' : '');
    const ho = data.hypothesisOutcomes;
    if (ho && (ho.confirmed + ho.refuted + ho.unclear + ho.untested) > 0) {
      const parts = [];
      if (ho.confirmed) parts.push(ho.confirmed + ' ✓');
      if (ho.refuted) parts.push(ho.refuted + ' ✗');
      if (ho.unclear) parts.push(ho.unclear + ' ?');
      if (ho.untested) parts.push(ho.untested + ' untested');
      meta += '<br><span class="sd-outcomes-line">Outcomes: ' + parts.join(' · ') + '</span>';
    }
    if (rqMeta) rqMeta.innerHTML = meta;
  }

  // Hint dependency card
  // sdHintDepSub is owned by renderTrends. Metric description goes to meta.
  const hd = data.metrics.hintDependency;
  const hdMeta = $('sdHintDepMeta');
  if (hd.sessions === 0) {
    $('sdHintDepValue').textContent = '—';
    if (hdMeta) hdMeta.textContent = 'No completed sessions';
  } else {
    $('sdHintDepValue').textContent = hd.avgHintsPerSession.toFixed(1);
    if (hdMeta) {
      hdMeta.textContent = 'hints per session · ' + hd.sessions + ' completed session' + (hd.sessions === 1 ? '' : 's');
    }
  }

  // Progress card — sub is owned by renderTrends. Bar + caption go to meta.
  const prog = data.progress || null;
  const progMeta = $('sdProgressMeta');
  if (prog && prog.assigned > 0) {
    $('sdProgressValue').textContent = prog.completed + ' / ' + prog.assigned;
    if (progMeta) {
      progMeta.innerHTML =
        renderFullProgress(prog.completed, prog.assigned, prog.percent) +
        '<div class="sd-progress-caption">' +
          Math.round(prog.percent * 100) + '% of assigned exercises complete' +
        '</div>';
    }
  } else {
    const attempted = (data.sessionHistory || []).length;
    const completed = (data.sessionHistory || []).filter((s) => s.state === 'complete').length;
    if (attempted === 0) {
      $('sdProgressValue').textContent = '—';
      if (progMeta) progMeta.textContent = 'No exercises attempted';
    } else {
      $('sdProgressValue').textContent = completed + ' / ' + attempted;
      if (progMeta) {
        progMeta.textContent = Math.round((completed / attempted) * 100) + '% complete';
      }
    }
  }

  // Time on task card
  const tm = data.timeMetrics;
  if (!tm || tm.sessionsWithTime === 0) {
    $('sdTimeValue').textContent = '—';
    $('sdTimeSub').textContent = 'No timed sessions yet';
  } else {
    $('sdTimeValue').textContent = tm.totalStruggleMinutes + ' min';
    const parts = [
      tm.sessionsWithTime + ' session' + (tm.sessionsWithTime === 1 ? '' : 's'),
      tm.avgStruggleMinutes + 'm avg',
    ];
    if (tm.longestStruggle) {
      parts.push('longest ' + tm.longestStruggle.minutes + 'm');
    }
    $('sdTimeSub').textContent = parts.join(' · ');
  }

  // Weak spots
  if (!data.weakSpots.length) {
    $('sdWeakSpots').innerHTML = '<p class="empty-state">No patterns logged yet.</p>';
  } else {
    $('sdWeakSpots').innerHTML = data.weakSpots.map((w) => `
      <div class="sd-pattern-row">
        <span class="sd-pattern-name">${escapeHtml(w.pattern)}</span>
        <span class="sd-pattern-count">${w.count}</span>
      </div>
    `).join('');
  }

  // Strengths
  const strengths = data.strengths || [];
  if (!strengths.length) {
    $('sdStrengths').innerHTML = '<p class="empty-state">No strengths identified yet.</p>';
  } else {
    $('sdStrengths').innerHTML = strengths.map((st) => `
      <div class="sd-strength-row" data-key="${escapeHtml(st.key)}">
        <div class="sd-strength-label">${escapeHtml(st.label)}</div>
        <div class="sd-strength-detail">${escapeHtml(st.detail)}</div>
      </div>
    `).join('');
  }

  // Session history
  if (!data.sessionHistory.length) {
    $('sdSessionHistory').innerHTML = '<p class="empty-state">No sessions in this range.</p>';
  } else {
    $('sdSessionHistory').innerHTML = `
      <table class="sd-sessions-table">
        <thead>
          <tr>
            <th>Exercise</th>
            <th>State</th>
            <th>Hint level</th>
            <th>Attempts</th>
            <th>Time</th>
            <th>Last activity</th>
          </tr>
        </thead>
        <tbody>
          ${data.sessionHistory.map((s) => `
            <tr class="sd-session-row" data-exercise-id="${escapeHtml(s.exerciseId)}" data-exercise-title="${escapeHtml(s.exerciseTitle)}" style="cursor:pointer;">
              <td>
                <span class="sd-exercise-cell">${escapeHtml(s.exerciseTitle)}</span>
                <span class="sd-exercise-slug">${escapeHtml(s.exerciseId)}</span>
              </td>
              <td>${renderStateBadge(s.state)}</td>
              <td>${s.currentLevel}</td>
              <td>${s.totalAttempts}</td>
              <td>${renderTimeCell(s)}</td>
              <td>${s.updatedAt ? relativeTime(s.updatedAt) : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    // Wire session history rows
    $('sdSessionHistory').querySelectorAll('.sd-session-row').forEach((row) => {
      row.addEventListener('click', () => {
        openExerciseDetail(
          currentStudentId,
          row.dataset.exerciseId,
          row.dataset.exerciseTitle
        );
      });
    });
  }
}

/**
 * Render the Time cell in the session history table.
 * Shows struggle minutes (primary) + session duration (secondary).
 */
function renderTimeCell(session) {
  const struggle = session.struggleMinutes;
  const duration = session.durationMinutes;
  if ((!struggle || struggle <= 0) && (!duration || duration <= 0)) {
    return '<span class="sd-time-empty">—</span>';
  }
  let html = '';
  if (struggle && struggle > 0) {
    html += '<span class="sd-time-struggle">' + struggle + ' min</span>';
  }
  if (duration && duration > 0 && duration < 24 * 60) {
    // Only show duration if it's plausibly a real session (< 24h)
    html += '<span class="sd-time-duration"> · ' + duration + 'm</span>';
  }
  return html || '<span class="sd-time-empty">—</span>';
}

function renderStateBadge(state) {
  const labels = {
    open: 'In progress',
    resolved: 'Awaiting post-mortem',
    complete: 'Completed',
  };
  return '<span class="state-badge ' + state + '">' + (labels[state] || state) + '</span>';
}

// Wire the back button
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'backToRosterBtn') {
    showStudentsRoster();
    loadStudentsRoster();
  }
});

// ═══════════════════════════════════════════════════════════
// Exercise picker (Tutor tab)
// ═══════════════════════════════════════════════════════════

async function loadExercisePicker() {
  const select = $('exerciseId');
  const hint = $('exerciseHint');
  if (!select) return;

  try {
    const res = await fetch('/api/cohorts/my-exercises');
    if (!res.ok) {
      select.innerHTML = '<option value="ex-1">ex-1 (not enrolled)</option>';
      if (hint) {
        hint.textContent = 'You are not enrolled in any class yet. Ask your instructor for an enrollment code.';
        hint.hidden = false;
      }
      return;
    }

    const exercises = await res.json();

    if (!exercises.length) {
      select.innerHTML = '<option value="ex-1">ex-1 (not enrolled)</option>';
      if (hint) {
        hint.textContent = 'You are not enrolled in any class yet. Open Classes from the top-right menu to enter a code.';
        hint.hidden = false;
      }
      return;
    }

    // Group by cohort for readability
    const byCohort = {};
    for (const ex of exercises) {
      if (!byCohort[ex.cohortName]) byCohort[ex.cohortName] = [];
      byCohort[ex.cohortName].push(ex);
    }

    let html = '';
    for (const cohortName of Object.keys(byCohort)) {
      html += '<optgroup label="' + escapeHtml(cohortName) + '">';
      for (const ex of byCohort[cohortName]) {
        html += '<option value="' + escapeHtml(ex.slug) + '">' + escapeHtml(ex.title) + '</option>';
      }
      html += '</optgroup>';
    }

    select.innerHTML = html;

    if (hint) hint.hidden = true;

    // Preserve current value if it's still valid; otherwise reset to first option
    const current = localStorage.getItem('codeteach.exerciseId');
    const stillValid = exercises.some((e) => e.slug === current);
    if (stillValid) {
      select.value = current;
    }

    // Save the choice when changed
    select.addEventListener('change', () => {
      try { localStorage.setItem('codeteach.exerciseId', select.value); } catch (e) {}
    });
  } catch (err) {
    select.innerHTML = '<option value="ex-1">ex-1</option>';
    if (hint) {
      hint.textContent = 'Could not load exercises: ' + err.message;
      hint.hidden = false;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Exercise detail view (within a student)
// ═══════════════════════════════════════════════════════════

let currentExerciseId = null;

function showStudentDetailFromExercise() {
  if (typeof teardownReplay === 'function') teardownReplay();
  $('studentDetailView').hidden = false;
  $('studentExerciseDetailView').hidden = true;
  currentExerciseId = null;
}

async function openExerciseDetail(studentId, exerciseId, exerciseTitle) {
  currentExerciseId = exerciseId;

  $('studentDetailView').hidden = true;
  $('studentExerciseDetailView').hidden = false;

  // Reset view
  $('sedExerciseTitle').textContent = exerciseTitle || exerciseId;
  $('sedExerciseSlug').textContent = exerciseId;
  $('sedState').textContent = '—';
  $('sedLevel').textContent = '—';
  $('sedAttempts').textContent = '—';
  $('sedHypotheses').innerHTML = '<p class="empty-state">Loading...</p>';
  $('sedPostMortems').innerHTML = '<p class="empty-state">Loading...</p>';

  // Get student name from roster cache
  const roster = window.__studentsRoster || [];
  const student = roster.find((s) => s.studentId === studentId);
  $('sedStudentName').textContent = student ? student.displayName : studentId;

  try {
    const res = await fetch(
      '/api/admin/students/' + encodeURIComponent(studentId) +
      '/exercises/' + encodeURIComponent(exerciseId)
    );

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      $('sedHypotheses').innerHTML = '<p class="empty-state">' + escapeHtml(data.error || 'Failed to load.') + '</p>';
      $('sedPostMortems').innerHTML = '';
      return;
    }

    const data = await res.json();
    renderExerciseDetail(data);
    if (typeof wireTutorFeedbackHandlers === 'function') {
      wireTutorFeedbackHandlers();
    }
  } catch (err) {
    $('sedHypotheses').innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
    $('sedPostMortems').innerHTML = '';
  }
}

// ═══════════════════════════════════════════════════════════
// Replay panel (exercise detail page)
// ═══════════════════════════════════════════════════════════

function __replaySessionKey(studentId, exerciseId) {
  return 'replay-pos:' + studentId + ':' + exerciseId;
}

const __replay = {
  events: [],
  index: 0,
  playing: false,
  timer: null,
  studentId: null,
  exerciseId: null,
};

async function loadReplayPanel(studentId, exerciseId) {
  const wrap = $('sedReplay');
  const body = $('sedReplayBody');
  if (!wrap || !body) return;

  // Reset state
  if (__replay.timer) { clearInterval(__replay.timer); __replay.timer = null; }
  __replay.events = [];
  __replay.index = 0;
  __replay.playing = false;
  __replay.studentId = studentId;
  __replay.exerciseId = exerciseId;

  body.innerHTML = '<p class="empty-state">Loading replay…</p>';

  try {
    const res = await fetch(
      '/api/admin/students/' + encodeURIComponent(studentId) +
      '/exercises/' + encodeURIComponent(exerciseId) + '/session-events',
      { credentials: 'same-origin' }
    );
    if (!res.ok) { wrap.style.display = 'none'; return; }
    const data = await res.json();
    const events = data.events || [];
    if (events.length === 0) {
      wrap.style.display = 'none';
      return;
    }
    __replay.events = events;
    // Restore the last position for this (student, exercise) pair if
    // the user is coming back to it in the same browser session.
    try {
      const stored = sessionStorage.getItem(__replaySessionKey(studentId, exerciseId));
      if (stored !== null) {
        const parsed = Number(stored);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed < events.length) {
          __replay.index = parsed;
        }
      }
    } catch {
      // sessionStorage unavailable — ignore
    }
    wrap.style.display = 'block';
    renderReplayPanel(body);
  } catch {
    wrap.style.display = 'none';
  }
}

function replayStateAtIndex(idx) {
  const upTo = __replay.events.slice(0, idx + 1);
  let code = '';
  let errorOutput = '';
  let codeSnapshotAt = null;
  for (const e of upTo) {
    if (e.type === 'code-snapshot') {
      code = e.payload.codeSnapshot || '';
      errorOutput = e.payload.errorOutput || '';
      codeSnapshotAt = e.recordedAt;
    }
  }
  const timeline = upTo.map((e) => ({
    type: e.type,
    when: e.recordedAt,
    payload: e.payload,
  }));
  return { code, errorOutput, codeSnapshotAt, timeline };
}

function replayCurrentEventLabel() {
  const e = __replay.events[__replay.index];
  if (!e) return '—';
  const labels = {
    'code-snapshot': 'Code snapshot',
    'hint-request': 'Hint requested',
    'hint-served': 'Hint served',
    'hypothesis-written': 'Hypothesis written',
    'post-mortem-saved': 'Post-mortem saved',
    'session-completed': 'Session completed',
  };
  return labels[e.type] || e.type;
}

function formatReplayTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleTimeString();
  } catch { return ''; }
}

/**
 * Split code into lines and mark lines that are new since the previous
 * snapshot. Very simple line-based diff (no LCS) — sufficient for a
 * tutor to see which lines the student touched.
 */
function renderReplayCodeHtml(current, previous) {
  const curLines = String(current || '').split('\n');
  // If there is no previous snapshot, nothing is "new" — render plain.
  if (!previous) {
    return curLines.map((line) => escapeHtml(line)).join('\n');
  }
  const prevSet = new Set(String(previous || '').split('\n'));
  return curLines.map((line) => {
    const isNew = line.trim().length > 0 && !prevSet.has(line);
    const cls = isNew ? ' class="rp-line-added"' : '';
    return '<span' + cls + '>' + escapeHtml(line) + '</span>';
  }).join('\n');
}

function renderReplayPanel(body) {
  const idx = __replay.index;
  const total = __replay.events.length;
  const state = replayStateAtIndex(idx);
  const currentLabel = replayCurrentEventLabel();
  const atStart = idx === 0;
  const atEnd = idx === total - 1;

  // Timeline: reuse the timeline items to build a "what happened" list.
  // Each entry: timestamp + description.
  const describeEvent = (e) => {
    switch (e.type) {
      case 'code-snapshot':
        return 'Code snapshot (' + ((e.payload && e.payload.reason) || 'auto') + ')';
      case 'hint-request':
        return 'Hint requested';
      case 'hint-served': {
        const t = (e.payload && e.payload.hintText) || '';
        return 'Hint: ' + t.slice(0, 80) + (t.length > 80 ? '…' : '');
      }
      case 'hypothesis-written':
        return 'Hypothesis: ' + ((e.payload && e.payload.text) || '').slice(0, 80);
      case 'post-mortem-saved':
        return 'Post-mortem: ' + ((e.payload && e.payload.text) || '').slice(0, 80);
      case 'session-completed':
        return 'Session completed';
      default:
        return e.type;
    }
  };

  const timelineRows = state.timeline.map((e, i) => {
    const isCurrent = i === idx;
    const when = formatReplayTime(e.when);
    return `<li class="rp-timeline-row${isCurrent ? ' rp-current' : ''}" data-rp-jump="${i}" role="button" tabindex="0">
      <span class="rp-timeline-time">${escapeHtml(when)}</span>
      <span class="rp-timeline-label">${escapeHtml(describeEvent(e))}</span>
    </li>`;
  }).join('');

  // Build a map of previous snapshot for the current index (for diff)
  let previousCode = '';
  {
    // Walk backwards from idx-1 to find the previous code-snapshot
    for (let i = idx - 1; i >= 0; i--) {
      const e = __replay.events[i];
      if (e.type === 'code-snapshot') {
        previousCode = e.payload.codeSnapshot || '';
        break;
      }
    }
  }

  // Event ticks on the scrubber
  const ticks = __replay.events.map((e, i) => {
    const pct = total > 1 ? (i / (total - 1)) * 100 : 0;
    const cls = i === idx ? 'rp-tick rp-tick-active'
              : i < idx ? 'rp-tick rp-tick-past'
              : 'rp-tick';
    return `<span class="${cls}" style="left:${pct}%" title="${escapeHtml(formatReplayTime(e.recordedAt))} · ${escapeHtml(describeEvent(e))}"></span>`;
  }).join('');

  body.innerHTML = `
    <div class="rp-controls">
      <button type="button" class="rp-btn" data-rp-action="play" ${atEnd ? 'disabled' : ''}>
        ${__replay.playing ? '❚❚ Pause' : '▶ Play'}
      </button>
      <button type="button" class="rp-btn rp-btn-secondary" data-rp-action="prev" ${atStart ? 'disabled' : ''}>◀ Prev</button>
      <button type="button" class="rp-btn rp-btn-secondary" data-rp-action="next" ${atEnd ? 'disabled' : ''}>Next ▶</button>
      <span class="rp-counter">Event ${idx + 1} of ${total} · <span class="rp-current-label">${escapeHtml(currentLabel)}</span></span>
    </div>

    <div class="rp-scrubber-wrap">
      <input type="range" min="0" max="${Math.max(0, total - 1)}" value="${idx}" class="rp-scrubber" data-rp-scrubber />
      <div class="rp-ticks">${ticks}</div>
    </div>

    <div class="rp-view">
      <div class="rp-pane">
        <div class="rp-pane-title">Code at this moment</div>
        <pre class="rp-code" id="rpCode">${renderReplayCodeHtml(state.code, previousCode) || escapeHtml('(empty)')}</pre>
        <div class="rp-pane-title rp-pane-title-error">Error output</div>
        <pre class="rp-error" id="rpError">${escapeHtml(state.errorOutput || '(none)')}</pre>
      </div>
      <div class="rp-pane">
        <div class="rp-pane-title">What happened</div>
        <ul class="rp-timeline">${timelineRows || '<li class="empty-state">No events yet.</li>'}</ul>
      </div>
    </div>
  `;

  // Wire controls
  body.querySelectorAll('[data-rp-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.rpAction;
      if (action === 'play') toggleReplayPlay();
      else if (action === 'prev') setReplayIndex(__replay.index - 1);
      else if (action === 'next') setReplayIndex(__replay.index + 1);
    });
  });
  const scrubber = body.querySelector('[data-rp-scrubber]');
  if (scrubber) {
    scrubber.addEventListener('input', (e) => {
      setReplayIndex(Number(e.target.value), { fromScrubber: true });
    });
  }
  body.querySelectorAll('[data-rp-jump]').forEach((row) => {
    const jump = () => setReplayIndex(Number(row.dataset.rpJump));
    row.addEventListener('click', jump);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); }
    });
  });
  if (typeof wireReplayKeyboard === 'function') wireReplayKeyboard();
}

let __replayKeyboardWired = false;
function wireReplayKeyboard() {
  if (__replayKeyboardWired) return;
  __replayKeyboardWired = true;
  document.addEventListener('keydown', (e) => {
    const wrap = document.getElementById('sedReplay');
    if (!wrap || wrap.style.display === 'none') return;
    // Ignore if typing in an input/textarea/select
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    // Ignore if a modal is open (let modals own the keys)
    const confirmModal = document.getElementById('confirmModal');
    const nudgeModal = document.getElementById('nudgeModal');
    const messagesModal = document.getElementById('messagesModal');
    if ((confirmModal && !confirmModal.hidden) ||
        (nudgeModal && !nudgeModal.hidden) ||
        (messagesModal && !messagesModal.hidden)) return;

    const total = __replay.events.length;
    if (total === 0) return;

    console.log('[rp-key] key=', e.key, 'code=', e.code, 'index=', __replay.index, 'total=', total);
    switch (e.key) {
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        toggleReplayPlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        setReplayIndex(__replay.index - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        setReplayIndex(__replay.index + 1);
        break;
      case 'Home':
        e.preventDefault();
        setReplayIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setReplayIndex(total - 1);
        break;
      default:
        break;
    }
  });
}

function setReplayIndex(idx, opts) {
  const total = __replay.events.length;
  if (total === 0) return;
  idx = Math.max(0, Math.min(total - 1, idx));
  __replay.index = idx;
  // Stop playing if the user scrubbed
  if (opts && opts.fromScrubber && __replay.playing) {
    __replay.playing = false;
    if (__replay.timer) { clearInterval(__replay.timer); __replay.timer = null; }
  }
  // Reached the end while playing → stop
  if (__replay.playing && idx === total - 1) {
    __replay.playing = false;
    if (__replay.timer) { clearInterval(__replay.timer); __replay.timer = null; }
  }
  // Persist the new position for this (student, exercise) pair
  try {
    if (__replay.studentId && __replay.exerciseId) {
      sessionStorage.setItem(
        __replaySessionKey(__replay.studentId, __replay.exerciseId),
        String(__replay.index)
      );
    }
  } catch {
    // ignore
  }
  const body = $('sedReplayBody');
  if (body) renderReplayPanel(body);
}

function toggleReplayPlay() {
  const total = __replay.events.length;
  if (total === 0) return;
  if (__replay.playing) {
    // Pause
    __replay.playing = false;
    if (__replay.timer) { clearInterval(__replay.timer); __replay.timer = null; }
    const body = $('sedReplayBody');
    if (body) renderReplayPanel(body);
    return;
  }
  // If we're at the end, restart from the beginning
  if (__replay.index >= total - 1) {
    __replay.index = 0;
  }
  __replay.playing = true;
  __replay.timer = setInterval(() => {
    if (__replay.index >= total - 1) {
      __replay.playing = false;
      if (__replay.timer) { clearInterval(__replay.timer); __replay.timer = null; }
      const body = $('sedReplayBody');
      if (body) renderReplayPanel(body);
      return;
    }
    setReplayIndex(__replay.index + 1);
  }, 800);
  const body = $('sedReplayBody');
  if (body) renderReplayPanel(body);
}

// Cleanup when leaving the exercise detail view
function teardownReplay() {
  if (__replay.timer) { clearInterval(__replay.timer); __replay.timer = null; }
  __replay.playing = false;
  __replay.events = [];
  __replay.index = 0;
}

function renderExerciseDetail(data) {
  // Replay panel (loads asynchronously)
  if (typeof loadReplayPanel === 'function' && currentStudentId && currentExerciseId) {
    loadReplayPanel(currentStudentId, currentExerciseId);
  }

  // Session summary
  const s = data.session;
  if (s) {
    const stateLabels = {
      open: 'In progress',
      resolved: 'Awaiting post-mortem',
      complete: 'Completed',
    };
    $('sedState').textContent = stateLabels[s.state] || s.state;
    $('sedState').className = 'sd-metric-value';
    $('sedLevel').textContent = String(s.currentLevel);
    $('sedAttempts').textContent = String(s.totalAttempts);
  } else {
    $('sedState').textContent = '—';
    $('sedLevel').textContent = '—';
    $('sedAttempts').textContent = '—';
  }

  // Hypotheses (with tutor feedback)
  if (!data.hypotheses || !data.hypotheses.length) {
    $('sedHypotheses').innerHTML = '<p class="empty-state">No hypotheses written.</p>';
  } else {
    $('sedHypotheses').innerHTML = data.hypotheses.map((h) => `
      <div class="sed-item" data-target-type="hypothesis" data-target-id="${h.id}">
        <div class="sed-item-header">
          <span class="sed-item-label">
            Level ${h.level}
            ${h.quality ? `<span class="quality-badge q-${escapeHtml(h.quality)}">${escapeHtml(h.quality)}</span>` : ''}
          </span>
          <span class="sed-item-time">${h.createdAt ? relativeTime(h.createdAt) : ''}</span>
        </div>
        <div class="sed-item-body">${escapeHtml(h.text)}</div>
        ${renderOutcomeRow(h.id, h.outcome)}
        ${renderTutorFeedback(h.tutorFeedback)}
      </div>
    `).join('');
  }

  // Post-mortems (with scorer feedback + tutor feedback)
  if (!data.postMortems || !data.postMortems.length) {
    $('sedPostMortems').innerHTML = '<p class="empty-state">No post-mortems written.</p>';
  } else {
    $('sedPostMortems').innerHTML = data.postMortems.map((pm) => `
      <div class="sed-item" data-target-type="post_mortem" data-target-id="${pm.id}">
        <div class="sed-item-header">
          <span class="sed-item-label">
            ${pm.score ? `<span class="quality-badge q-score-${escapeHtml(pm.score)}">${escapeHtml(pm.score)}</span>` : ''}
          </span>
          <span class="sed-item-time">${pm.createdAt ? relativeTime(pm.createdAt) : ''}</span>
        </div>
        <div class="sed-item-body">${escapeHtml(pm.text)}</div>
        ${pm.scorerFeedback ? `<div class="sed-item-feedback">${escapeHtml(pm.scorerFeedback)}</div>` : ''}
        ${renderTutorFeedback(pm.tutorFeedback)}
      </div>
    `).join('');
  }
}

/**
 * Render the outcome row for a hypothesis: 4 pills (Confirmed / Refuted
 * / Unclear / Clear). The currently-active outcome is highlighted.
 */
function renderOutcomeRow(hypothesisId, currentOutcome) {
  function pill(value, label, extraClass) {
    const active = (currentOutcome || null) === value;
    return '<button class="outcome-pill ' + (extraClass || '') + (active ? ' active' : '') +
      '" data-hypothesis-id="' + hypothesisId + '" data-outcome="' + (value || '') + '">' +
      label + '</button>';
  }
  return (
    '<div class="sed-outcome-row">' +
      '<span class="sed-outcome-label">Outcome:</span>' +
      pill('confirmed', '✓ Confirmed', 'outcome-confirmed') +
      pill('refuted', '✗ Refuted', 'outcome-refuted') +
      pill('unclear', '? Unclear', 'outcome-unclear') +
      (currentOutcome ? '<button class="outcome-pill outcome-clear" data-hypothesis-id="' + hypothesisId + '" data-outcome="">Clear</button>' : '') +
    '</div>'
  );
}

/**
 * Handle clicks on outcome pills: PATCH the server, then re-fetch the
 * exercise detail so the UI reflects the new state.
 */
async function handleOutcomeClick(btn) {
  const hypothesisId = btn.dataset.hypothesisId;
  const outcomeRaw = btn.dataset.outcome;
  const outcome = outcomeRaw === '' ? null : outcomeRaw;

  try {
    const res = await fetch(
      '/api/admin/students/' + encodeURIComponent(currentStudentId) +
      '/exercises/' + encodeURIComponent(currentExerciseId) +
      '/hypotheses/' + encodeURIComponent(hypothesisId) + '/outcome',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Could not update outcome.');
      return;
    }
    // Re-fetch exercise detail to refresh counts + active pill
    await openExerciseDetail(currentStudentId, currentExerciseId, $('sedExerciseTitle').textContent);
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

/**
 * Render tutor feedback (list + add button) for one work item.
 * `items` is an array of TutorFeedback objects (possibly empty).
 */
function renderTutorFeedback(items) {
  const list = (items || []).map((fb) => `
    <div class="sed-tutor-feedback-item" data-feedback-id="${escapeHtml(fb.id)}">
      <div class="sed-tutor-feedback-meta">
        <span class="sed-tutor-feedback-author">${escapeHtml(fb.instructorName || 'Instructor')}</span>
        <span class="sed-tutor-feedback-time">${fb.createdAt ? relativeTime(fb.createdAt) : ''}</span>
        <button class="sed-tutor-feedback-delete" title="Delete feedback" data-feedback-id="${escapeHtml(fb.id)}">×</button>
      </div>
      <div class="sed-tutor-feedback-text">${escapeHtml(fb.text)}</div>
    </div>
  `).join('');

  return `
    <div class="sed-tutor-feedback">
      ${list}
      <div class="sed-tutor-feedback-composer" hidden>
        <textarea class="sed-tutor-feedback-input" rows="2" placeholder="Leave feedback on this item…"></textarea>
        <div class="sed-tutor-feedback-actions">
          <button class="ghost small sed-tutor-feedback-cancel">Cancel</button>
          <button class="primary small sed-tutor-feedback-save">Save</button>
        </div>
      </div>
      <button class="sed-tutor-feedback-add ghost small">+ Add feedback</button>
    </div>
  `;
}

/**
 * Wire the feedback add/save/cancel/delete handlers on the exercise detail view.
 * Called once after renderExerciseDetail populates the DOM.
 */
function wireTutorFeedbackHandlers() {
  const root = document.getElementById('studentExerciseDetailView');
  if (!root) return;

  root.querySelectorAll('.outcome-pill').forEach((btn) => {
    btn.addEventListener('click', () => handleOutcomeClick(btn));
  });

  root.querySelectorAll('.sed-tutor-feedback-add').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wrapper = btn.closest('.sed-tutor-feedback');
      const composer = wrapper.querySelector('.sed-tutor-feedback-composer');
      composer.hidden = false;
      btn.hidden = true;
      composer.querySelector('textarea').focus();
    });
  });

  root.querySelectorAll('.sed-tutor-feedback-cancel').forEach((btn) => {
    btn.addEventListener('click', () => {
      const composer = btn.closest('.sed-tutor-feedback-composer');
      const wrapper = composer.closest('.sed-tutor-feedback');
      composer.hidden = true;
      composer.querySelector('textarea').value = '';
      wrapper.querySelector('.sed-tutor-feedback-add').hidden = false;
    });
  });

  root.querySelectorAll('.sed-tutor-feedback-save').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const composer = btn.closest('.sed-tutor-feedback-composer');
      const item = composer.closest('.sed-item');
      const targetType = item.dataset.targetType;
      const targetId = item.dataset.targetId;
      const text = composer.querySelector('textarea').value.trim();
      if (!text) return;

      btn.disabled = true;
      try {
        const res = await fetch(
          '/api/admin/students/' + encodeURIComponent(currentStudentId) +
          '/exercises/' + encodeURIComponent(currentExerciseId) +
          '/feedback',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetType, targetId, text }),
          }
        );
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || 'Could not save feedback.');
          return;
        }
        // Re-render the exercise detail to pick up the new feedback
        await openExerciseDetail(currentStudentId, currentExerciseId, $('sedExerciseTitle').textContent);
      } catch (err) {
        alert('Failed: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });

  root.querySelectorAll('.sed-tutor-feedback-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const feedbackId = btn.dataset.feedbackId;
      if (!confirm('Delete this feedback?')) return;
      try {
        const res = await fetch(
          '/api/admin/students/' + encodeURIComponent(currentStudentId) +
          '/exercises/' + encodeURIComponent(currentExerciseId) +
          '/feedback/' + encodeURIComponent(feedbackId),
          { method: 'DELETE' }
        );
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || 'Could not delete feedback.');
          return;
        }
        await openExerciseDetail(currentStudentId, currentExerciseId, $('sedExerciseTitle').textContent);
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    });
  });
}

async function resetExerciseProgress() {
  if (!currentStudentId || !currentExerciseId) return;

  const ok = confirm(
    'Reset progress on this exercise?\n\n' +
    'This will delete all sessions, hypotheses, post-mortems, and mistake patterns for this student on this exercise.\n\n' +
    'This cannot be undone.'
  );
  if (!ok) return;

  try {
    const res = await fetch(
      '/api/admin/students/' + encodeURIComponent(currentStudentId) +
      '/exercises/' + encodeURIComponent(currentExerciseId) +
      '/progress',
      { method: 'DELETE' }
    );

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Reset failed.');
      return;
    }

    alert('Progress reset. Removed ' +
      (data.removed?.sessions ?? 0) + ' session(s), ' +
      (data.removed?.hypotheses ?? 0) + ' hypothesis(es), ' +
      (data.removed?.postMortems ?? 0) + ' post-mortem(s), ' +
      (data.removed?.patterns ?? 0) + ' pattern(s).');

    // Reload the exercise detail (now empty) and the roster stats
    const exerciseTitle = $('sedExerciseTitle').textContent;
    await openExerciseDetail(currentStudentId, currentExerciseId, exerciseTitle);
  } catch (err) {
    alert('Reset failed: ' + err.message);
  }
}

/**
 * Show the privacy view. Hides all other top-level views.
 * We don't touch the URL hash (v1), but returning restores the previous
 * view based on auth state.
 */
/**
 * Open the confirm-by-typing modal.
 * @param opts.title         modal heading
 * @param opts.message       HTML string for the body (trusted, sanitize caller-side)
 * @param opts.requiredText  the user must type this (case-sensitive)
 * @param opts.confirmLabel  label for the confirm button (default: "Delete")
 * @param opts.onConfirm     async callback; return false to keep modal open
 */
function showConfirmModal(opts) {
  const modal = $('confirmModal');
  if (!modal) return;

  $('confirmModalTitle').textContent = opts.title || 'Confirm';
  $('confirmModalMessage').innerHTML = opts.message || '';
  $('confirmModalRequired').textContent = opts.requiredText || '';
  $('confirmModalSubmit').textContent = opts.confirmLabel || 'Delete';
  $('confirmModalSubmit').disabled = true;

  modal.hidden = false;
  modal.__onConfirm = opts.onConfirm || null;
  modal.__requiredText = opts.requiredText || '';

  // ── Wire input + buttons on EVERY open, so we never depend on
  //    script-load order (the earlier IIFE was exiting early because
  //    the modal HTML wasn't in the DOM yet when app.js loaded). ──

  // Input: enable submit only when the value matches the required text
  const inputEl = $('confirmModalInput');
  if (inputEl) {
    // Clone-and-replace to strip any stale listeners from prior opens
    const freshInput = inputEl.cloneNode(true);
    inputEl.parentNode.replaceChild(freshInput, inputEl);
    freshInput.value = '';
    freshInput.addEventListener('input', () => {
      $('confirmModalSubmit').disabled =
        freshInput.value !== (modal.__requiredText || '');
    });
    // Focus after the modal is on screen
    setTimeout(() => freshInput.focus(), 30);
  }

  // Cancel button: clone-and-replace too, to avoid stacking listeners
  const cancelBtn = $('confirmModalCancel');
  if (cancelBtn) {
    const freshCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(freshCancel, cancelBtn);
    freshCancel.addEventListener('click', () => closeConfirmModal());
  }

  // Submit button
  const submitBtn = $('confirmModalSubmit');
  if (submitBtn) {
    const freshSubmit = submitBtn.cloneNode(true);
    submitBtn.parentNode.replaceChild(freshSubmit, submitBtn);
    freshSubmit.disabled = true;
    freshSubmit.addEventListener('click', async () => {
      const onConfirm = modal.__onConfirm;
      if (!onConfirm) {
        closeConfirmModal();
        return;
      }
      freshSubmit.disabled = true;
      try {
        const keepOpen = await onConfirm();
        if (keepOpen) freshSubmit.disabled = false;
        else closeConfirmModal();
      } catch (err) {
        alert('Failed: ' + err.message);
        freshSubmit.disabled = false;
      }
    });
  }

  // Backdrop click + Escape close the modal (attach once per modal element)
  if (!modal.__backdropWired) {
    modal.__backdropWired = true;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeConfirmModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isConfirmModalOpen()) closeConfirmModal();
    });
  }
}

function closeConfirmModal() {
  const modal = $('confirmModal');
  if (modal) {
    modal.hidden = true;
    modal.__onConfirm = null;
    modal.__requiredText = '';
  }
}

function isConfirmModalOpen() {
  const modal = $('confirmModal');
  return modal && !modal.hidden;
}

/**
 * Danger zone: wire up delete + export buttons. Called from
 * renderStudentDetail so the button only appears when a student is open.
 */
function wireStudentDangerZone(student) {
  const zone = $('sdDangerZone');
  if (!zone) return;
  if (!student) {
    zone.style.display = 'none';
    return;
  }
  zone.style.display = 'block';

  const exportBtn = $('sdDangerExportBtn');
  const deleteBtn = $('sdDangerDeleteBtn');

  // Replace listeners by cloning
  if (exportBtn) {
    const fresh = exportBtn.cloneNode(true);
    exportBtn.parentNode.replaceChild(fresh, exportBtn);
    fresh.addEventListener('click', () => {
      if (currentStudentId) {
        window.location = '/api/admin/students/' + encodeURIComponent(currentStudentId) + '/export.csv';
      }
    });
  }

  if (deleteBtn) {
    const fresh = deleteBtn.cloneNode(true);
    deleteBtn.parentNode.replaceChild(fresh, deleteBtn);
    fresh.addEventListener('click', () => {
      if (!currentStudentId) return;
      showConfirmModal({
        title: 'Delete all data for ' + student.displayName + '?',
        message:
          '<p>This will permanently erase the student\'s debug history ' +
          '(sessions, hypotheses, post-mortems, mistake patterns, telemetry) ' +
          'for exercises in your class.</p>' +
          '<p class="confirm-modal-warn">Their account and enrollment are <b>not</b> affected.</p>' +
          '<p>This action cannot be undone.</p>',
        requiredText: student.displayName,
        confirmLabel: 'Delete all data',
        onConfirm: async () => {
          try {
            const res = await fetch(
              '/api/admin/students/' + encodeURIComponent(currentStudentId) + '/data',
              { method: 'DELETE' }
            );
            const data = await res.json();
            if (!res.ok) {
              alert(data.error || 'Deletion failed.');
              return false;
            }
            const r = data.removed || {};
            const parts = [];
            for (const k of ['hypotheses','hint_sessions','post_mortems','mistake_patterns','telemetry']) {
              if (r[k]) parts.push(r[k] + ' ' + k.replace(/_/g,' '));
            }
            alert('Deleted: ' + (parts.join(', ') || 'no rows') + '.');
            // Reload the student detail so counts reset
            if (typeof openStudentDetail === 'function') {
              await openStudentDetail(currentStudentId);
            }
            return true;
          } catch (err) {
            alert('Failed: ' + err.message);
            return false;
          }
        },
      });
    });
  }
}

function showPrivacy() {
  // Hide every top-level section AND remove .active from tab-panels — the
  // .tab-panel.active rule sets display: block and would otherwise override
  // the hidden attribute.
  document.querySelectorAll('section').forEach(function (s) {
    s.hidden = true;
    s.classList.remove('active');
  });
  // Also hide the top-level detail views that are divs, not sections.
  ['studentDetailView', 'studentExerciseDetailView'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  var pv = $('privacyView');
  if (pv) pv.hidden = false;
  // Close the user menu
  var m = $('userMenuDropdown'); if (m) m.hidden = true;
  // Unlock page scroll so the full notice is reachable
  document.body.classList.add('privacy-open');
  // Scroll to top
  window.scrollTo(0, 0);
}

function hidePrivacy() {
  document.body.classList.remove('privacy-open');
  var pv = $('privacyView');
  if (pv) pv.hidden = true;
  // Reload so the normal auth-boot path decides which view to show.
  location.reload();
}

// Wire the buttons
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.id) return;

  if (t.id === 'backToAnalyticsBtn') {
    // Set hash first so deep-links and reload land on Analytics
    window.location.hash = 'class';
    // Then trigger the standard tab switch (handles visibility)
    const analyticsTab = document.querySelector('.tab[data-tab="class"]');
    if (analyticsTab) analyticsTab.click();
    return;
  } else if (t.id === 'backToStudentBtn') {
    showStudentDetailFromExercise();
    // Refresh the parent student detail so session history reflects changes
    if (currentStudentId) openStudentDetail(currentStudentId);
  } else if (t.id === 'sedResetBtn') {
    resetExerciseProgress();
  } else if (t.id === 'sdPrintBtn') {
    window.print();
  } else if (t.id === 'sdExportCsvBtn') {
    if (currentStudentId) {
      window.location = '/api/admin/students/' + encodeURIComponent(currentStudentId) + '/export.csv';
    }
  } else if (t.id === 'deleteAccountBtn') {
    deleteMyAccount();
  } else if (t.id === 'openMessagesBtn') {
    toggleUserMenu(false);
    openMessagesModal();
  } else if (t.id === 'messagesModalClose') {
    closeMessagesModal();
  } else if (t.id === 'messagesModalBack') {
    currentMessagesThreadId = null;
    updateMessagesModalChrome('threads');
    renderThreadsList();
  } else if (t.id === 'messagesModal') {
    if (e.target === t) closeMessagesModal();
  } else if (t.id === 'nudgeModalClose') {
    closeNudgeModal();
  } else if (t.id === 'nudgeModal') {
    if (e.target === t) closeNudgeModal();
  } else if (t.id === 'openPrivacyBtn') {
    showPrivacy();
  } else if (t.id === 'backFromPrivacyBtn') {
    hidePrivacy();
  }
});

// ═══════════════════════════════════════════════════════════
// Tutor notes panel
// ═══════════════════════════════════════════════════════════

let currentNotesStudentId = null;
let currentNotesCohortId = null;
let currentNotesCache = [];

function isMobileNotes() {
  return window.innerWidth <= 1000;
}

function notesPanelCollapsed() {
  try {
    return localStorage.getItem('codeteach.notesCollapsed') === '1';
  } catch { return false; }
}
function setNotesPanelCollapsed(v) {
  try { localStorage.setItem('codeteach.notesCollapsed', v ? '1' : '0'); } catch {}
  const layout = $('sdLayout');
  if (!layout) return;
  if (v) layout.classList.add('collapsed');
  else layout.classList.remove('collapsed');

  // Add a reopen button if collapsed and not present
  let reopen = $('sdNotesReopenBtn');
  if (v && !reopen) {
    const btn = document.createElement('button');
    btn.id = 'sdNotesReopenBtn';
    btn.className = 'sd-notes-reopen';
    btn.textContent = 'Show notes';
    btn.addEventListener('click', () => setNotesPanelCollapsed(false));
    layout.appendChild(btn);
  } else if (!v && reopen) {
    reopen.remove();
  }
}

async function loadTutorNotes(studentId, cohortId) {
  currentNotesStudentId = studentId;
  currentNotesCohortId = cohortId || null;

  const listDesktop = $('sdNotesList');
  const listMobile = $('sdNotesListMobile');
  const countBadge = $('sdNotesCount');

  if (listDesktop) listDesktop.innerHTML = '<p class="empty-state">Loading...</p>';
  if (listMobile) listMobile.innerHTML = '<p class="empty-state">Loading...</p>';
  if (countBadge) countBadge.textContent = '';

  try {
    const url = '/api/admin/students/' + encodeURIComponent(studentId) + '/notes' +
      (cohortId ? '?cohortId=' + encodeURIComponent(cohortId) : '');
    const res = await fetch(url);
    if (!res.ok) {
      const msg = '<p class="empty-state">Could not load notes.</p>';
      if (listDesktop) listDesktop.innerHTML = msg;
      if (listMobile) listMobile.innerHTML = msg;
      return;
    }
    const notes = await res.json();
    currentNotesCache = notes;

    if (countBadge) countBadge.textContent = notes.length ? String(notes.length) : '';

    if (!notes.length) {
      const msg = '<p class="empty-state">No notes yet.</p>';
      if (listDesktop) listDesktop.innerHTML = msg;
      if (listMobile) listMobile.innerHTML = msg;
      return;
    }

    const html = notes.map(renderNoteRow).join('');
    if (listDesktop) listDesktop.innerHTML = html;
    if (listMobile) listMobile.innerHTML = html;
    wireNoteActions();
  } catch (err) {
    const msg = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
    if (listDesktop) listDesktop.innerHTML = msg;
    if (listMobile) listMobile.innerHTML = msg;
  }
}

function renderNoteRow(n) {
  const created = new Date(n.createdAt).getTime();
  const updated = new Date(n.updatedAt).getTime();
  const edited = updated - created > 1000; // >1s difference means edited

  return `
    <div class="sd-note" data-note-id="${escapeHtml(n.id)}">
      <div class="sd-note-header">
        <span class="sd-note-time">
          ${relativeTime(n.createdAt)}${edited ? ' · edited' : ''}
        </span>
        <div class="sd-note-actions">
          <button class="sd-note-action sd-note-edit" data-note-id="${escapeHtml(n.id)}">Edit</button>
          <button class="sd-note-action sd-note-delete" data-note-id="${escapeHtml(n.id)}">Delete</button>
        </div>
      </div>
      <div class="sd-note-text">${escapeHtml(n.text)}</div>
    </div>
  `;
}

function wireNoteActions() {
  document.querySelectorAll('.sd-note-edit').forEach((btn) => {
    btn.addEventListener('click', () => startEditNote(btn.dataset.noteId));
  });
  document.querySelectorAll('.sd-note-delete').forEach((btn) => {
    btn.addEventListener('click', () => deleteTutorNote(btn.dataset.noteId));
  });
}

function startEditNote(noteId) {
  const note = currentNotesCache.find((n) => n.id === noteId);
  if (!note) return;

  const el = document.querySelector('.sd-note[data-note-id="' + noteId + '"]');
  if (!el) return;

  el.innerHTML = `
    <textarea class="sd-note-edit-textarea" id="edit-${escapeHtml(noteId)}">${escapeHtml(note.text)}</textarea>
    <div class="sd-note-edit-actions">
      <button class="ghost small" data-action="cancel">Cancel</button>
      <button class="primary small" data-action="save">Save</button>
    </div>
  `;

  const textarea = el.querySelector('textarea');
  textarea.focus();

  el.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    loadTutorNotes(currentNotesStudentId, currentNotesCohortId);
  });

  el.querySelector('[data-action="save"]').addEventListener('click', () => {
    saveEditNote(noteId, textarea.value);
  });
}

async function saveEditNote(noteId, text) {
  const trimmed = text.trim();
  if (!trimmed) {
    alert('Note cannot be empty.');
    return;
  }
  try {
    const res = await fetch('/api/admin/notes/' + encodeURIComponent(noteId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmed }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Could not save.');
      return;
    }
    await loadTutorNotes(currentNotesStudentId, currentNotesCohortId);
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

async function saveTutorNote(source) {
  const textarea = source === 'mobile' ? $('sdNotesInputMobile') : $('sdNotesInput');
  const btn = source === 'mobile' ? $('sdNotesSaveBtnMobile') : $('sdNotesSaveBtn');
  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text) return;
  if (!currentNotesStudentId) return;

  btn.disabled = true;
  try {
    const res = await fetch(
      '/api/admin/students/' + encodeURIComponent(currentNotesStudentId) + '/notes',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          ...(currentNotesCohortId ? { cohortId: currentNotesCohortId } : {}),
        }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Could not save note.');
      return;
    }
    textarea.value = '';
    await loadTutorNotes(currentNotesStudentId, currentNotesCohortId);
  } catch (err) {
    alert('Failed: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function deleteTutorNote(noteId) {
  if (!confirm('Delete this note?')) return;
  try {
    const res = await fetch('/api/admin/notes/' + encodeURIComponent(noteId), {
      method: 'DELETE',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Could not delete.');
      return;
    }
    await loadTutorNotes(currentNotesStudentId, currentNotesCohortId);
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

function openNotesDrawer() {
  $('sdNotesDrawer').hidden = false;
}
function closeNotesDrawer() {
  $('sdNotesDrawer').hidden = true;
}

// Wire buttons — attached once at load
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.id) return;

  if (t.id === 'sdNotesSaveBtn') saveTutorNote('desktop');
  else if (t.id === 'sdNotesSaveBtnMobile') saveTutorNote('mobile');
  else if (t.id === 'sdNotesCollapseBtn') setNotesPanelCollapsed(true);
  else if (t.id === 'sdNotesToggleBtn') {
    if (isMobileNotes()) openNotesDrawer();
    else setNotesPanelCollapsed(!notesPanelCollapsed());
  }
  else if (t.id === 'sdNotesDrawerCloseBtn') closeNotesDrawer();
  else if (t.id === 'sdNotesDrawerBackdrop') closeNotesDrawer();
});

// ═══════════════════════════════════════════════════════════
// Tab persistence via URL hash
// ═══════════════════════════════════════════════════════════

const VALID_TABS = ['tutor', 'weak-spots', 'health', 'class', 'students', 'exercises', 'my-sessions'];

function activateTabFromHash() {
  const raw = (window.location.hash || '').replace(/^#/, '');

  // Special-case the filtered students view: '#filter?by=...&value=...'
  if (raw.startsWith('filter?')) {
    const qs = raw.slice('filter?'.length);
    const params = new URLSearchParams(qs);
    const by = params.get('by');
    const value = params.get('value');
    if (by && value) {
      showFilteredStudents();
      loadFilteredStudents(by, value);
      return;
    }
  }

  const tabName = VALID_TABS.includes(raw) ? raw : 'tutor';

  const tab = document.querySelector('.tab[data-tab="' + tabName + '"]');
  if (!tab) {
    // Tab might be hidden for this role — fall back to tutor
    const tutorTab = document.querySelector('.tab[data-tab="tutor"]');
    if (tutorTab) tutorTab.click();
    return;
  }
  tab.click();
}

// Update the hash whenever a tab is clicked
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    if (VALID_TABS.includes(name) && window.location.hash !== '#' + name) {
      history.replaceState(null, '', '#' + name);
    }
  });
});

// NOTE: intentionally NOT listening for hashchange. The hash is a passive
// label so refresh preserves the active tab, but back/forward do not
// navigate between tabs — in-app views (student detail, exercise detail)
// aren't part of the URL, so Back would jump unpredictably.
//
// If we ever want Back to mean "go back one view", we need a real router
// with history entries for every in-app transition. See
// docs/session-b-backlog.md.

// ═══════════════════════════════════════════════════════════
// Sparkline renderer
// ═══════════════════════════════════════════════════════════

/**
 * Render a small line chart as inline SVG.
 *
 * @param points  Array of { value: number | null }. Nulls break the line.
 * @param opts    { width, height, classification, showLastDot }
 * @returns SVG string. Returns '' when fewer than 2 non-null points exist.
 */
function renderSparkline(points, opts) {
  opts = opts || {};
  const width = opts.width || 88;
  const height = opts.height || 24;
  const padding = 3;
  const classification = opts.classification || 'stable';
  const showLastDot = opts.showLastDot !== false;

  const valid = points.filter((p) => p.value !== null);
  if (valid.length < 2) return '';

  const values = valid.map((p) => p.value);
  const min = Math.min.apply(null, values);
  const max = Math.max.apply(null, values);
  const range = max - min || 1;

  const stepX = (width - padding * 2) / Math.max(1, points.length - 1);

  // Build segments, breaking on nulls
  const segments = [];
  let current = [];

  points.forEach((p, i) => {
    if (p.value === null) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    const x = padding + i * stepX;
    const y = height - padding - ((p.value - min) / range) * (height - padding * 2);
    current.push({ x: x, y: y, last: false });
  });
  if (current.length) segments.push(current);

  // Mark the last point of the last segment
  if (segments.length) {
    const lastSeg = segments[segments.length - 1];
    if (lastSeg.length) lastSeg[lastSeg.length - 1].last = true;
  }

  const linePaths = segments
    .filter((seg) => seg.length >= 2)
    .map((seg) =>
      'M ' + seg.map((pt) => pt.x.toFixed(1) + ' ' + pt.y.toFixed(1)).join(' L ')
    )
    .join(' ');

  if (!linePaths) return '';

  const dots = showLastDot
    ? segments
        .filter((seg) => seg.length)
        .map((seg) => {
          const pt = seg[seg.length - 1];
          return '<circle class="spark-dot ' + classification + '" cx="' + pt.x.toFixed(1) + '" cy="' + pt.y.toFixed(1) + '" r="2.5" />';
        })
        .join('')
    : '';

  return (
    '<svg class="sparkline" width="' + width + '" height="' + height +
    '" viewBox="0 0 ' + width + ' ' + height + '" aria-hidden="true">' +
    '<path class="spark-line ' + classification + '" d="' + linePaths + '" />' +
    dots +
    '</svg>'
  );
}

/**
 * Format a metric value for display based on the metric's "kind":
 *   - 'percent': 0-1 range → "45%"
 *   - 'ratio': plain number with 1 decimal → "3.2"
 */
function formatTrendValue(value, kind) {
  if (value === null || value === undefined) return '—';
  if (kind === 'percent') return Math.round(value * 100) + '%';
  return (Math.round(value * 10) / 10).toFixed(1);
}

// ═══════════════════════════════════════════════════════════
// Render trend sparklines on the student detail page
// ═══════════════════════════════════════════════════════════

function renderTrends(data) {
  if (!data || !data.trends) return;

  const { reasoningQuality, hintDependency, progress } = data.trends;

  renderOneTrend('sdReasoningTrend', 'sdReasoningSub', reasoningQuality, {
    kind: 'percent',
    currentValue: data.metrics.reasoningQuality,
    currentIsPrecisePct: true,
    emptyLabel: 'No hypotheses yet',
    sparseLabel: 'Started this week',
  });

  renderOneTrend('sdHintDepTrend', 'sdHintDepSub', hintDependency, {
    kind: 'ratio',
    currentValue: data.metrics.hintDependency,
    currentIsHintsPerSession: true,
    emptyLabel: 'No completed sessions',
    sparseLabel: 'Started this week',
  });

  // Progress trend uses session counts, not a metric from data.metrics
  renderOneTrend('sdProgressTrend', 'sdProgressSub', progress, {
    kind: 'percent',
    currentValue: null,
    sessionCounts: {
      attempted: data.sessionHistory.length,
      completed: data.sessionHistory.filter((s) => s.state === 'complete').length,
    },
    emptyLabel: 'No exercises attempted',
    sparseLabel: 'Started this week',
  });
}

function renderOneTrend(trendElId, subElId, trend, opts) {
  const trendEl = $(trendElId);
  const subEl = $(subElId);
  if (!trendEl) return;

  const points = trend.points || [];
  const validCount = points.filter((p) => p.value !== null).length;

  // 0 or 1 valid point: no direction to describe. Clear the sub-label
  // entirely — the metric's description lives in the sd-metric-meta
  // element below it, so an empty sub is fine.
  // Render the sparkline if we have 1 point; clear it if we have none.
  if (validCount < 2) {
    if (validCount === 1) {
      trendEl.innerHTML = renderSparkline(points, {
        classification: trend.classification,
        width: 88,
        height: 24,
      });
    } else {
      trendEl.innerHTML = '';
    }
    if (subEl) subEl.textContent = '';
    return;
  }

  // 2+ valid points: render sparkline and replace sub-label with the
  // trend summary "Improving · 45% → 62%".
  trendEl.innerHTML = renderSparkline(points, {
    classification: trend.classification,
    width: 88,
    height: 24,
  });

  const first = points.find((p) => p.value !== null);
  const last = [...points].reverse().find((p) => p.value !== null);

  const firstFmt = formatTrendValue(first.value, opts.kind);
  const lastFmt = formatTrendValue(last.value, opts.kind);

  const label = classificationLabel(trend.classification);
  const labelClass = trend.classification;

  if (subEl) {
    subEl.innerHTML =
      '<span class="sd-trend-label ' + labelClass + '">' + label + '</span>' +
      ' · ' + firstFmt + ' → ' + lastFmt;
  }
}


function classificationLabel(c) {
  if (c === 'improving') return 'Improving';
  if (c === 'worsening') return 'Worsening';
  return 'Stable';
}


// ═══════════════════════════════════════════════════════════
// Global Escape handler — closes the topmost open modal
// ═══════════════════════════════════════════════════════════
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  var messages = document.getElementById('messagesModal');
  var nudge = document.getElementById('nudgeModal');
  var confirm = document.getElementById('confirmModal');
  if (messages && !messages.hidden) { closeMessagesModal(); return; }
  if (nudge && !nudge.hidden) { closeNudgeModal(); return; }
  if (confirm && !confirm.hidden && typeof closeConfirmModal === 'function') {
    closeConfirmModal();
  }
});
