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
    // Everyone
    if (typeof loadExercisePicker === 'function') loadExercisePicker();

    // Instructor-only
    if (currentUser && currentUser.role === 'instructor') {
      if (typeof loadInviteCodes === 'function') loadInviteCodes();
      if (typeof loadHealth === 'function') loadHealth();
    }

    // Restore the tab from the URL hash
    if (typeof activateTabFromHash === 'function') activateTabFromHash();
  }, 100);
}

function applyRoleVisibility() {
  const adminTabs = ['health', 'class', 'students', 'exercises'];
  document.querySelectorAll('.tab').forEach(tab => {
    if (adminTabs.includes(tab.dataset.tab) && currentUser.role !== 'instructor') {
      tab.remove();
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

  if (currentUser) {
    const line = $('settingsAccountLine');
    if (line) {
      const role = currentUser.role === 'instructor' ? 'Instructor' : 'Student';
      line.textContent = 'Signed in as ' + (currentUser.email || 'unknown') + ' (' + role + ')';
    }
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
            <th>Attempted</th>
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
              <td>${s.exercisesAttempted}</td>
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
  el.innerHTML =
    '<div class="sd-next-action-title">' + escapeHtml(nextAction.title) + '</div>' +
    '<div class="sd-next-action-detail">' + escapeHtml(nextAction.detail) + '</div>';

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

  if (!cc || cc.peerCount === 0) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  const cohortLabel = (cc.cohortNames || []).join(', ') || 'your cohort';

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
  $('studentDetailView').hidden = true;
  const exView = $('studentExerciseDetailView');
  if (exView) exView.hidden = true;
  currentStudentId = null;
}

function showStudentDetail() {
  $('studentsRoster').hidden = true;
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
  $('sdHintDepValue').textContent = '—';
  $('sdHintDepSub').textContent = 'Loading...';
  $('sdProgressValue').textContent = '—';
  $('sdProgressSub').textContent = 'Loading...';
  // Clear sparkline containers so switching students doesn't show stale trends
  var rt = $('sdReasoningTrend'); if (rt) rt.innerHTML = '';
  var ht = $('sdHintDepTrend'); if (ht) ht.innerHTML = '';
  var pt = $('sdProgressTrend'); if (pt) pt.innerHTML = '';
  $('sdWeakSpots').innerHTML = '<p class="empty-state">Loading...</p>';
  $('sdSessionHistory').innerHTML = '<p class="empty-state">Loading...</p>';
  var st = $('sdStrengths'); if (st) st.innerHTML = '<p class="empty-state">Loading...</p>';
  var na = $('sdNextAction'); if (na) { na.style.display = 'none'; na.innerHTML = ''; }
  var cc = $('sdCohortComparison'); if (cc) { cc.style.display = 'none'; cc.innerHTML = ''; }
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
  $('sdClasses').textContent = classes;
  $('sdJoined').textContent = joinedAt
    ? new Date(joinedAt).toLocaleDateString()
    : '—';

  const status = data.status || rosterEntry?.status;
  const statusReasons = data.statusReasons || rosterEntry?.statusReasons || [];
  $('sdStatusBadge').innerHTML = status ? renderStatusBadge(status, statusReasons) : '';

  // Recommended next action banner
  renderNextAction(data.nextAction);

  // Cohort comparison panel
  renderCohortComparison(data.cohortComparison);

  // Reasoning quality card
  const rq = data.metrics.reasoningQuality;
  if (rq.total === 0) {
    $('sdReasoningValue').textContent = '—';
    $('sdReasoningSub').textContent = 'No hypotheses yet';
  } else {
    const precisePct = Math.round((rq.precise / rq.total) * 100);
    $('sdReasoningValue').textContent = precisePct + '%';
    $('sdReasoningSub').textContent = rq.precise + ' precise · ' + rq.plausible + ' plausible · ' + rq.vague + ' vague' +
      (rq.unscored ? ' · ' + rq.unscored + ' unscored' : '');
  }

  // Hint dependency card
  const hd = data.metrics.hintDependency;
  if (hd.sessions === 0) {
    $('sdHintDepValue').textContent = '—';
    $('sdHintDepSub').textContent = 'No completed sessions';
  } else {
    $('sdHintDepValue').textContent = hd.avgHintsPerSession.toFixed(1);
    $('sdHintDepSub').textContent = 'hints per session · ' + hd.sessions + ' completed session' + (hd.sessions === 1 ? '' : 's');
  }

  // Progress card — prefer server-computed { completed, assigned, percent }
  const prog = data.progress || null;
  if (prog && prog.assigned > 0) {
    $('sdProgressValue').textContent = prog.completed + ' / ' + prog.assigned;
    $('sdProgressSub').innerHTML =
      renderFullProgress(prog.completed, prog.assigned, prog.percent) +
      '<div class="sd-progress-caption">' +
        Math.round(prog.percent * 100) + '% of assigned exercises complete' +
      '</div>';
  } else {
    const attempted = (data.sessionHistory || []).length;
    const completed = (data.sessionHistory || []).filter((s) => s.state === 'complete').length;
    if (attempted === 0) {
      $('sdProgressValue').textContent = '—';
      $('sdProgressSub').textContent = 'No exercises attempted';
    } else {
      $('sdProgressValue').textContent = completed + ' / ' + attempted;
      $('sdProgressSub').textContent = Math.round((completed / attempted) * 100) + '% complete';
    }
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
      select.innerHTML = '<option value="ex-1">ex-1 (no cohort)</option>';
      if (hint) {
        hint.textContent = 'You are not enrolled in any class yet. Ask your instructor for an enrollment code.';
        hint.hidden = false;
      }
      return;
    }

    const exercises = await res.json();

    if (!exercises.length) {
      select.innerHTML = '<option value="ex-1">ex-1 (no cohort)</option>';
      if (hint) {
        hint.textContent = 'You are not enrolled in any class yet. Open Join Class from the top-right menu to enter a code.';
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
  } catch (err) {
    $('sedHypotheses').innerHTML = '<p class="empty-state">Failed: ' + escapeHtml(err.message) + '</p>';
    $('sedPostMortems').innerHTML = '';
  }
}

function renderExerciseDetail(data) {
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

  // Hypotheses
  if (!data.hypotheses || !data.hypotheses.length) {
    $('sedHypotheses').innerHTML = '<p class="empty-state">No hypotheses written.</p>';
  } else {
    $('sedHypotheses').innerHTML = data.hypotheses.map((h) => `
      <div class="sed-item">
        <div class="sed-item-header">
          <span class="sed-item-label">
            Level ${h.level}
            ${h.quality ? `<span class="quality-badge q-${escapeHtml(h.quality)}">${escapeHtml(h.quality)}</span>` : ''}
          </span>
          <span class="sed-item-time">${h.createdAt ? relativeTime(h.createdAt) : ''}</span>
        </div>
        <div class="sed-item-body">${escapeHtml(h.text)}</div>
      </div>
    `).join('');
  }

  // Post-mortems
  if (!data.postMortems || !data.postMortems.length) {
    $('sedPostMortems').innerHTML = '<p class="empty-state">No post-mortems written.</p>';
  } else {
    $('sedPostMortems').innerHTML = data.postMortems.map((p) => `
      <div class="sed-item">
        <div class="sed-item-header">
          <span class="sed-item-label">
            ${p.score ? `<span class="quality-badge q-score-${escapeHtml(p.score)}">${escapeHtml(p.score)}</span>` : ''}
          </span>
          <span class="sed-item-time">${p.createdAt ? relativeTime(p.createdAt) : ''}</span>
        </div>
        <div class="sed-item-body">${escapeHtml(p.text)}</div>
        ${p.feedback ? `<div class="sed-item-feedback">${escapeHtml(p.feedback)}</div>` : ''}
      </div>
    `).join('');
  }
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

// Wire the buttons
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.id) return;

  if (t.id === 'backToStudentBtn') {
    showStudentDetailFromExercise();
    // Refresh the parent student detail so session history reflects changes
    if (currentStudentId) openStudentDetail(currentStudentId);
  } else if (t.id === 'sedResetBtn') {
    resetExerciseProgress();
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

const VALID_TABS = ['tutor', 'weak-spots', 'health', 'class', 'students', 'exercises'];

function activateTabFromHash() {
  const raw = (window.location.hash || '').replace(/^#/, '');
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

  // 0 or 1 valid point: there is no direction to describe, so leave the
  // sub-label set by renderStudentDetail() intact (it carries the actual
  // metric description). Only render the sparkline if we have 1 point,
  // and clear it if we have none.
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
