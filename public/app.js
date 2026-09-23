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
    studentId: $('studentId').value.trim() || 'test-student',
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
        studentId: $('studentId').value.trim() || 'test-student',
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
  const sid = $('studentId').value.trim() || 'test-student';
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
  const sid = $('studentId').value.trim() || 'test-student';
  const list = $('weakSpotsList');
  list.innerHTML = '<p class="empty-state">Loading...</p>';
  try {
    const res = await fetch('/api/debug-tutor/weak-spots/' + encodeURIComponent(sid));
    const spots = await res.json();
    if (!spots.length) {
      list.innerHTML = '<p class="empty-state">No patterns logged yet. Ask the tutor for hints and we\'ll start building your map.</p>';
      return;
    }
    list.innerHTML = spots.map(s => `
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
    `).join('');
  } catch (err) {
    list.innerHTML = '<p class="empty-state">Failed to load: ' + escapeHtml(err.message) + '</p>';
  }
}

// --- Health ---
$('refreshHealth').addEventListener('click', async () => {
  const key = $('adminKey').value.trim();
  const body = $('healthBody');
  body.innerHTML = '<p class="empty-state">Loading...</p>';
  try {
    const res = await fetch('/api/admin/health/debug-tutor?hours=24', {
      headers: { 'x-admin-key': key },
    });
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
        <div class="stat">
          <div class="stat-label">Total hints</div>
          <div class="stat-value">${h.hints.total}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Fallback rate</div>
          <div class="stat-value ${fbClass}">${pct}%</div>
          <div class="stat-sub">${h.hints.fromFallback} of ${h.hints.total}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Avg latency</div>
          <div class="stat-value">${h.hints.avgLatencyMs ?? '—'}${h.hints.avgLatencyMs ? 'ms' : ''}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Circuit breaker</div>
          <div class="stat-value ${h.circuitBreaker.state === 'open' ? 'bad' : 'good'}">${h.circuitBreaker.state}</div>
        </div>
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
});

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
          studentId: $('studentId').value.trim() || 'test-student',
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
  const studentId = $('studentId').value.trim() || 'test-student';
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


// --- Persist studentId and exerciseId across refreshes ---
(function persistIds() {
  const sidEl = $('studentId');
  const eidEl = $('exerciseId');
  if (!sidEl || !eidEl) return;

  // Restore from localStorage on load
  try {
    const savedSid = localStorage.getItem('codeteach.studentId');
    const savedEid = localStorage.getItem('codeteach.exerciseId');
    if (savedSid) sidEl.value = savedSid;
    if (savedEid) eidEl.value = savedEid;
  } catch (e) {}

  // Save on change
  sidEl.addEventListener('input', () => {
    try { localStorage.setItem('codeteach.studentId', sidEl.value); } catch (e) {}
  });
  eidEl.addEventListener('input', () => {
    try { localStorage.setItem('codeteach.exerciseId', eidEl.value); } catch (e) {}
  });

  // Now that fields have the right values, hydrate the session
  hydrateSession();
})();

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
