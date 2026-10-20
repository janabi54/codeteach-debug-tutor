/**
 * Onboarding tour (Phase 6.2).
 * Self-contained — fetches /api/auth/me instead of relying on globals.
 */
(function () {
  'use strict';

  const STUDENT_STEPS = [
    { selector: null, title: 'Welcome to CodeTeach', body: 'A guided debugging lab. 30 seconds to show you around.', placement: 'center' },
    { selector: '#runPrediction', title: 'Predict first', body: 'Before you run, predict what the code will do. This primes your mental model.', placement: 'bottom' },
    { selector: '#runBtn', title: 'Run here', body: 'Run your code in the sandbox. The tutor sees the actual output — no IDE hand-off.', placement: 'right' },
    { selector: '#investigation', title: 'Investigate', body: 'Expected vs actual, plus a trace of every loop iteration. This is where learning happens.', placement: 'right' },
    { selector: '#askBtn', title: 'Ask for hints', body: 'Stuck? Ask. Hints get more specific each level. First is a nudge; last explains the root cause.', placement: 'left' },
  ];

  const INSTRUCTOR_STEPS = [
    { selector: null, title: 'Welcome to CodeTeach', body: 'Quick tour of the instructor surface.', placement: 'center' },
    { selector: '.tab[data-tab="students"]', title: 'Students', body: 'Roster, drill into any student\'s sessions and struggles.', placement: 'bottom' },
    { selector: '.tab[data-tab="exercises"]', title: 'Exercises', body: 'Author, tag concepts, set expected output. Students practice from here.', placement: 'bottom' },
    { selector: '.tab[data-tab="class"]', title: 'Analytics', body: 'Cohort metrics: progress, weak concepts, at-risk students.', placement: 'bottom' },
    { selector: '.tab[data-tab="webhooks"]', title: 'Webhooks', body: 'Optional: ship events to Slack, Discord, or any endpoint. Admin only.', placement: 'bottom' },
  ];

  let steps = [], idx = 0, active = false, booted = false, bootTries = 0;
  let overlay, tooltip, spotlight;

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'tour-overlay';
    overlay.hidden = true;
    spotlight = document.createElement('div');
    spotlight.className = 'tour-spotlight';
    spotlight.hidden = true;
    overlay.appendChild(spotlight);
    tooltip = document.createElement('div');
    tooltip.className = 'tour-tooltip';
    overlay.appendChild(tooltip);
    document.body.appendChild(overlay);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function render() {
    const s = steps[idx];
    if (!s) return end();
    const last = idx === steps.length - 1;

    tooltip.innerHTML =
      '<div class="tour-step-count">' + (idx + 1) + ' / ' + steps.length + '</div>' +
      '<h3 class="tour-title">' + esc(s.title) + '</h3>' +
      '<p class="tour-body">' + esc(s.body) + '</p>' +
      '<div class="tour-actions">' +
        '<button class="ghost small" data-tour="skip">Skip</button>' +
        (idx > 0 ? '<button class="ghost small" data-tour="prev">Back</button>' : '') +
        '<button class="primary small" data-tour="' + (last ? 'done' : 'next') + '">' + (last ? 'Done' : 'Next') + '</button>' +
      '</div>';

    if (!s.selector) {
      spotlight.hidden = true;
      tooltip.style.top = '50%';
      tooltip.style.left = '50%';
      tooltip.style.transform = 'translate(-50%, -50%)';
      return;
    }

    const target = document.querySelector(s.selector);
    if (!target) return next();
    const r = target.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return next();  // hidden

    spotlight.hidden = false;
    spotlight.style.top = (r.top - 8) + 'px';
    spotlight.style.left = (r.left - 8) + 'px';
    spotlight.style.width = (r.width + 16) + 'px';
    spotlight.style.height = (r.height + 16) + 'px';
    tooltip.style.transform = '';

    const W = 340, H = 180;
    let top, left;
    switch (s.placement) {
      case 'bottom': top = r.bottom + 20; left = r.left; break;
      case 'top':    top = r.top - H - 20; left = r.left; break;
      case 'right':  top = r.top; left = r.right + 20; break;
      case 'left':   top = r.top; left = r.left - W - 20; break;
      default:       top = r.bottom + 20; left = r.left;
    }
    top = Math.max(12, Math.min(window.innerHeight - H - 12, top));
    left = Math.max(12, Math.min(window.innerWidth - W - 12, left));
    tooltip.style.top = top + 'px';
    tooltip.style.left = left + 'px';
  }

  function next() { idx++; if (idx >= steps.length) return end(); render(); }
  function prev() { if (idx > 0) idx--; render(); }
  function end() {
    active = false;
    if (overlay) overlay.hidden = true;
    fetch('/api/auth/seen-tour', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  }

  async function getMe() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!r.ok) return null;
      const d = await r.json();
      return d.user || null;
    } catch { return null; }
  }

  function start(user) {
    if (active || !user) return;
    ensureDom();
    steps = user.role === 'instructor' ? INSTRUCTOR_STEPS : STUDENT_STEPS;
    idx = 0;
    active = true;
    overlay.hidden = false;
    render();
  }

  async function maybeStart() {
    if (booted) return;
    bootTries++;
    const u = await getMe();
    if (!u) {
      if (bootTries < 30) setTimeout(maybeStart, 800);
      return;
    }
    booted = true;
    if (u.hasSeenTour === false) {
      setTimeout(() => start(u), 800);
    }
  }

  document.addEventListener('click', (e) => {
    if (!active) return;
    const btn = e.target.closest('[data-tour]');
    if (!btn) return;
    const a = btn.getAttribute('data-tour');
    if (a === 'next') next();
    else if (a === 'prev') prev();
    else if (a === 'skip' || a === 'done') end();
  });

  window.addEventListener('resize', () => { if (active) render(); });

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('openTourBtn');
    if (btn) btn.addEventListener('click', async () => {
      const menu = document.getElementById('userMenuDropdown');
      if (menu) menu.hidden = true;
      const u = await getMe();
      if (u) start(u);
    });
    setTimeout(maybeStart, 500);
  });

  window.startTour = async () => { const u = await getMe(); if (u) start(u); };
})();
