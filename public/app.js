// --- Tab switching ---
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'weak-spots') loadWeakSpots();
  });
});

// --- Element refs ---
const $ = id => document.getElementById(id);
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

    btn.disabled = true;
    try {
      const data = await callHintApi(text);
      handleHintResponse(data);
    } catch (err) {
      appendMessage({ kind: 'system', text: 'Request failed: ' + err.message });
    }
  });
}

function handleHintResponse(data) {
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
    } else if (data.state === 'complete') {
      appendMessage({
        kind: 'system',
        text: 'This session is complete. Start a new exercise to keep debugging.',
      });
    } else {
      setLevel(data.currentLevel || 1);
    }
  } catch (err) {
    // silent — fall through to placeholder
  }
}


// (persistIds removed — identity comes from session)

// --- Class fingerprint tab ---
$('refreshClass').addEventListener('click', async () => {
  const key = $('adminKeyClass').value.trim();
  const body = $('classBody');
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

async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null;
    const data = await res.json();
    return data.user;
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
    if (typeof loadInviteCodes === 'function') loadInviteCodes();
    if (typeof loadHealth === 'function') loadHealth();
  }, 100);
}

function applyRoleVisibility() {
  const adminTabs = ['health', 'class'];
  document.querySelectorAll('.tab').forEach(tab => {
    if (adminTabs.includes(tab.dataset.tab) && currentUser.role !== 'instructor') {
      tab.style.display = 'none';
    } else {
      tab.style.display = '';
    }
  });
  const nameEl = $('currentUserName');
  if (nameEl) nameEl.textContent = currentUser.displayName;
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
  const body = loginMode === 'login'
    ? { email, password }
    : {
        email,
        password,
        displayName,
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
      loadExercises();
    }
  });
});

async function loadExercises() {
  const list = $('exercisesList');
  if (!list) return;
  list.innerHTML = '<p class="empty-state">Loading...</p>';

  try {
    const res = await fetch('/api/admin/exercises');
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

  if (currentUser) {
    $('settingsEmail').textContent = currentUser.email || '—';
    $('settingsRole').textContent = currentUser.role === 'instructor' ? 'Instructor' : 'Student';
  }

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

    list.innerHTML = cohorts.map((c) => `
      <div class="settings-class-row">
        <div>
          <div class="settings-class-name">${escapeHtml(c.name)}</div>
          <span class="settings-class-meta">joined ${new Date(c.joinedAt).toLocaleDateString()}</span>
        </div>
        <button class="settings-leave-btn" data-cohort-id="${escapeHtml(c.id)}" data-cohort-name="${escapeHtml(c.name)}">Leave</button>
      </div>
    `).join('');

    list.querySelectorAll('.settings-leave-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        leaveClass(btn.dataset.cohortId, btn.dataset.cohortName);
      });
    });
  } catch (err) {
    list.innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
  }
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
