/**
 * Webhooks admin UI.
 *
 * Self-contained. Hooks the Webhooks tab (data-tab="webhooks") by
 * listening for clicks + checking on load. No changes to app.js.
 *
 * All fetches use credentials: 'same-origin' so the session cookie rides along.
 */

(function () {
  'use strict';

  const ROOT_ID = 'webhooksRoot';
  let loadedOnce = false;
  let rendering = false;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const msg = body && body.error ? body.error : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return body;
  }

  function fmtTime(s) {
    if (!s) return '—';
    return String(s).replace('T', ' ').slice(0, 19);
  }

  /**
   * Attach a click handler that:
   *  - guards against double-fire (busy flag)
   *  - disables + relabels the button while in-flight
   *  - restores on completion
   *  - never re-enters while busy
   */
  function busyClick(btn, busyText, fn) {
    let busy = false;
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      if (busy) return;
      busy = true;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = busyText;
      try {
        await fn();
      } catch (err) {
        alert('Action failed: ' + err.message);
      } finally {
        busy = false;
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  }

  function showMessage(el, html) {
    if (!el) return;
    el.innerHTML = html;
    // Scroll into view so the user sees the confirmation even if the
    // table below it has pushed it off-screen.
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch {
      el.scrollIntoView();
    }
  }

  async function render() {
    if (rendering) return;
    rendering = true;
    const root = document.getElementById(ROOT_ID);
    if (!root) { rendering = false; return; }

    root.innerHTML = '<p class="wh-muted">Loading…</p>';

    let subs, eps, dels, evs, cohorts;
    try {
      [subs, eps, dels, evs, cohorts] = await Promise.all([
        api('/api/admin/webhook-subscriptions'),
        api('/api/admin/webhook-endpoints'),
        api('/api/admin/webhook-deliveries?limit=20'),
        api('/api/admin/webhook-inbound-events?limit=20'),
        api('/api/admin/cohorts'),
      ]);
    } catch (err) {
      root.innerHTML = '<p class="wh-err">Failed to load: ' + esc(err.message) + '</p>';
      rendering = false;
      return;
    }

    const cohortOptions = cohorts
      .map((c) => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>')
      .join('');

    root.innerHTML = `
      <style>
        .wh-grid { display: grid; gap: 24px; }
        .wh-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; background: #fff; }
        .wh-card h3 { margin: 0 0 12px; font-size: 16px; }
        .wh-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .wh-table th, .wh-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #f1f3f5; vertical-align: top; }
        .wh-table th { font-weight: 600; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
        .wh-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; padding-top: 12px; border-top: 1px dashed #e5e7eb; }
        .wh-form input, .wh-form select { padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; }
        .wh-form input[type="text"] { min-width: 280px; flex: 1; }
        .wh-btn { padding: 6px 12px; border: 1px solid #d1d5db; background: #fff; border-radius: 6px; cursor: pointer; font-size: 13px; }
        .wh-btn:hover { background: #f9fafb; }
        .wh-btn:disabled { opacity: 0.6; cursor: default; }
        .wh-btn.primary { background: #4f46e5; color: #fff; border-color: #4f46e5; }
        .wh-btn.danger { color: #b91c1c; }
        .wh-status { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; }
        .wh-status.delivered { background: #dcfce7; color: #166534; }
        .wh-status.pending { background: #fef3c7; color: #92400e; }
        .wh-status.failed, .wh-status.dead { background: #fee2e2; color: #991b1b; }
        .wh-status.ok { background: #dbeafe; color: #1e40af; }
        .wh-muted { color: #6b7280; font-size: 12px; }
        .wh-secret { font-family: monospace; font-size: 11px; word-break: break-all; background: #f3f4f6; padding: 6px; border-radius: 4px; margin-top: 6px; }
        .wh-err { color: #b91c1c; font-size: 12px; }
        .wh-msg { margin-top: 10px; }
      </style>

      <div class="wh-grid">

        <div class="wh-card">
          <h3>Outbound subscriptions <span class="wh-muted">(${subs.length})</span></h3>
          <p class="wh-muted">CodeTeach POSTs signed events to these URLs.</p>
          ${subs.length === 0 ? '<p class="wh-muted">None yet.</p>' : `
            <table class="wh-table">
              <thead><tr><th>ID</th><th>Cohort</th><th>URL</th><th>Events</th><th>Active</th><th></th></tr></thead>
              <tbody>
                ${subs.map((s) => `
                  <tr>
                    <td>${s.id}</td>
                    <td>${esc(s.cohort_id.slice(0, 8))}…</td>
                    <td>${esc(s.url)}</td>
                    <td>${esc(s.event_types)}</td>
                    <td>${s.active ? '✓' : '—'}</td>
                    <td>
                      <button class="wh-btn" data-test-sub="${s.id}">Test</button>
                      <button class="wh-btn danger" data-del-sub="${s.id}">Delete</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `}
          <div class="wh-form">
            <select id="whSubCohort">${cohortOptions}</select>
            <input type="text" id="whSubUrl" placeholder="https://hooks.slack.com/..." />
            <input type="text" id="whSubEvents" placeholder='["exercise.completed"]' value='["exercise.completed"]' />
            <button class="wh-btn primary" id="whCreateSub">Create</button>
          </div>
          <div id="whSubMsg" class="wh-msg"></div>
        </div>

        <div class="wh-card">
          <h3>Inbound endpoints <span class="wh-muted">(${eps.length})</span></h3>
          <p class="wh-muted">Providers POST events to <code>/webhooks/in/&lt;slug&gt;</code>.</p>
          ${eps.length === 0 ? '<p class="wh-muted">None yet.</p>' : `
            <table class="wh-table">
              <thead><tr><th>ID</th><th>Provider</th><th>Slug</th><th>Cohort</th><th>Active</th><th></th></tr></thead>
              <tbody>
                ${eps.map((e) => `
                  <tr>
                    <td>${e.id}</td>
                    <td>${esc(e.provider)}</td>
                    <td><code>${esc(e.slug)}</code></td>
                    <td>${e.cohort_id ? esc(e.cohort_id.slice(0, 8)) + '…' : '—'}</td>
                    <td>${e.active ? '✓' : '—'}</td>
                    <td><button class="wh-btn danger" data-del-ep="${e.id}">Delete</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `}
          <div class="wh-form">
            <select id="whEpProvider">
              <option value="github">github</option>
              <option value="generic">generic</option>
            </select>
            <select id="whEpCohort"><option value="">(no cohort)</option>${cohortOptions}</select>
            <button class="wh-btn primary" id="whCreateEp">Create</button>
          </div>
          <div id="whEpMsg" class="wh-msg"></div>
        </div>

        <div class="wh-card">
          <h3>Recent deliveries <span class="wh-muted">(last 20)</span></h3>
          ${dels.length === 0 ? '<p class="wh-muted">None yet.</p>' : `
            <table class="wh-table">
              <thead><tr><th>ID</th><th>Sub</th><th>Event</th><th>Status</th><th>Attempts</th><th>Last HTTP</th><th>When</th><th></th></tr></thead>
              <tbody>
                ${dels.map((d) => `
                  <tr>
                    <td>${d.id}</td>
                    <td>${d.subscription_id}</td>
                    <td>${esc(d.event_type)}</td>
                    <td><span class="wh-status ${esc(d.status)}">${esc(d.status)}</span></td>
                    <td>${d.attempts}</td>
                    <td>${d.last_status == null ? '—' : d.last_status}</td>
                    <td>${fmtTime(d.created_at)}</td>
                    <td><button class="wh-btn" data-redeliver="${d.id}">Redeliver</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `}
        </div>

        <div class="wh-card">
          <h3>Recent inbound events <span class="wh-muted">(last 20)</span></h3>
          ${evs.length === 0 ? '<p class="wh-muted">None yet.</p>' : `
            <table class="wh-table">
              <thead><tr><th>ID</th><th>Provider</th><th>Event</th><th>Sig</th><th>Processed</th><th>External ID</th><th>When</th></tr></thead>
              <tbody>
                ${evs.map((e) => `
                  <tr>
                    <td>${e.id}</td>
                    <td>${esc(e.provider)}</td>
                    <td>${esc(e.event_type || '—')}</td>
                    <td>${e.signature_ok ? '<span class="wh-status ok">ok</span>' : '<span class="wh-status failed">bad</span>'}</td>
                    <td>${e.processed ? '✓' : '…'}</td>
                    <td><code class="wh-muted">${esc(e.external_id)}</code></td>
                    <td>${fmtTime(e.received_at)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `}
        </div>

      </div>
    `;

    wire(root);
    rendering = false;
  }

  function wire(root) {
    // Test-fire a subscription
    root.querySelectorAll('[data-test-sub]').forEach((btn) => {
      busyClick(btn, 'Testing…', async () => {
        await api('/api/admin/webhook-subscriptions/' + btn.dataset.testSub + '/test', { method: 'POST' });
        await render();
      });
    });

    // Delete a subscription
    root.querySelectorAll('[data-del-sub]').forEach((btn) => {
      busyClick(btn, '…', async () => {
        if (!confirm('Delete subscription ' + btn.dataset.delSub + '?')) return;
        await api('/api/admin/webhook-subscriptions/' + btn.dataset.delSub, { method: 'DELETE' });
        await render();
      });
    });

    // Delete an endpoint
    root.querySelectorAll('[data-del-ep]').forEach((btn) => {
      busyClick(btn, '…', async () => {
        if (!confirm('Delete endpoint ' + btn.dataset.delEp + '? Future requests will 404.')) return;
        await api('/api/admin/webhook-endpoints/' + btn.dataset.delEp, { method: 'DELETE' });
        await render();
      });
    });

    // Redeliver a delivery
    root.querySelectorAll('[data-redeliver]').forEach((btn) => {
      busyClick(btn, '…', async () => {
        await api('/api/admin/webhook-deliveries/' + btn.dataset.redeliver + '/redeliver', { method: 'POST' });
        await render();
      });
    });

    // Create subscription
    const createSub = root.querySelector('#whCreateSub');
    if (createSub) {
      busyClick(createSub, 'Creating…', async () => {
        const msg = root.querySelector('#whSubMsg');
        const cohort_id = root.querySelector('#whSubCohort').value;
        const url = root.querySelector('#whSubUrl').value.trim();
        const eventsRaw = root.querySelector('#whSubEvents').value.trim();
        let event_types;
        try {
          event_types = JSON.parse(eventsRaw);
        } catch {
          showMessage(msg, '<p class="wh-err">event_types must be valid JSON.</p>');
          throw new Error('invalid JSON');
        }
        try {
          const res = await api('/api/admin/webhook-subscriptions', {
            method: 'POST',
            body: JSON.stringify({ cohort_id, url, event_types }),
          });
          // Clear the URL input so an accidental second click doesn't re-create the same row
          root.querySelector('#whSubUrl').value = '';
          showMessage(
            msg,
            '<p class="wh-muted">Created. <strong>Secret (store now, shown once):</strong></p>' +
            '<div class="wh-secret">' + esc(res.secret) + '</div>'
          );
          // Re-render tables without losing the message we just showed.
          await render();
          const m2 = document.getElementById('whSubMsg');
          showMessage(
            m2,
            '<p class="wh-muted">Created. <strong>Secret (store now, shown once):</strong></p>' +
            '<div class="wh-secret">' + esc(res.secret) + '</div>'
          );
        } catch (err) {
          showMessage(msg, '<p class="wh-err">Create failed: ' + esc(err.message) + '</p>');
          throw err;
        }
      });
    }

    // Create endpoint
    const createEp = root.querySelector('#whCreateEp');
    if (createEp) {
      busyClick(createEp, 'Creating…', async () => {
        const msg = root.querySelector('#whEpMsg');
        const provider = root.querySelector('#whEpProvider').value;
        const cohort_id = root.querySelector('#whEpCohort').value || null;
        try {
          const res = await api('/api/admin/webhook-endpoints', {
            method: 'POST',
            body: JSON.stringify({ provider, cohort_id }),
          });
          showMessage(
            msg,
            '<p class="wh-muted">Created. <strong>Store these now (shown once):</strong></p>' +
            '<div class="wh-secret">URL path: ' + esc(res.url_path) + '<br>Secret: ' + esc(res.secret) + '</div>'
          );
          // Re-render tables without losing the message we just showed.
          await render();
          const m2 = document.getElementById('whEpMsg');
          showMessage(
            m2,
            '<p class="wh-muted">Created. <strong>Store these now (shown once):</strong></p>' +
            '<div class="wh-secret">URL path: ' + esc(res.url_path) + '<br>Secret: ' + esc(res.secret) + '</div>'
          );
        } catch (err) {
          showMessage(msg, '<p class="wh-err">Create failed: ' + esc(err.message) + '</p>');
          throw err;
        }
      });
    }
  }

  async function tryLoad() {
    const tab = document.querySelector('.tab[data-tab="webhooks"]');
    const panel = document.getElementById('tab-webhooks');
    if (!tab || !panel) return;
    if (tab.classList.contains('active') || panel.classList.contains('active')) {
      loadedOnce = true;
      await render();
    }
  }

  // Hook tab clicks
  document.addEventListener('click', (ev) => {
    const tab = ev.target.closest && ev.target.closest('.tab[data-tab="webhooks"]');
    if (tab) setTimeout(tryLoad, 50);
  });

  // Initial load if we landed on #webhooks
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryLoad, 200));
  } else {
    setTimeout(tryLoad, 200);
  }

  // Expose for manual refresh
  window.loadWebhooks = render;
})();
