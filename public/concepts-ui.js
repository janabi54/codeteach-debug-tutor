/**
 * Concept catalog admin UI.
 *
 * Renders into #conceptsRoot, which lives inside the Webhooks tab.
 * Self-contained. Hooks into the Webhooks tab click the same way
 * webhooks-ui.js does.
 */

(function () {
  'use strict';

  const ROOT_ID = 'conceptsRoot';
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

  function busyClick(btn, busyText, fn) {
    let busy = false;
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      if (busy) return;
      busy = true;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = busyText;
      try {
        await fn();
      } catch (err) {
        alert('Action failed: ' + err.message);
      } finally {
        busy = false;
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  }

  function showMessage(el, html) {
    if (!el) return;
    el.innerHTML = html;
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    catch { el.scrollIntoView(); }
  }

  async function render() {
    if (rendering) return;
    rendering = true;
    const root = document.getElementById(ROOT_ID);
    if (!root) { rendering = false; return; }

    root.innerHTML = '<p class="wh-muted">Loading catalog…</p>';

    let concepts;
    try {
      concepts = await api('/api/admin/concepts');
    } catch (err) {
      root.innerHTML = '<p class="wh-err">Failed to load concepts: ' + esc(err.message) + '</p>';
      rendering = false;
      return;
    }

    root.innerHTML = `
      <div class="wh-card">
        <h3>Concept catalog <span class="wh-muted">(${concepts.length})</span></h3>
        <p class="wh-muted">Concepts available for exercise tagging. Used by weak spots and next-action recommendations.</p>
        ${concepts.length === 0 ? '<p class="wh-muted">None yet.</p>' : `
          <table class="wh-table">
            <thead><tr><th>Slug</th><th>Name</th><th>Description</th><th></th></tr></thead>
            <tbody>
              ${concepts.map((c) => `
                <tr>
                  <td><code>${esc(c.slug)}</code></td>
                  <td>${esc(c.name)}</td>
                  <td>${esc(c.description)}</td>
                  <td><button class="wh-btn danger" data-del-concept="${esc(c.slug)}">Delete</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
        <div class="wh-form">
          <input type="text" id="cnSlug" placeholder="slug (e.g. off-by-one)" style="min-width:200px;" />
          <input type="text" id="cnName" placeholder="Display name" style="min-width:200px;" />
          <input type="text" id="cnDescription" placeholder="Short description (optional)" style="flex:2;" />
          <button class="wh-btn primary" id="cnCreate">Create</button>
        </div>
        <div id="cnMsg" class="wh-msg"></div>
      </div>
    `;

    wire(root);
    rendering = false;
  }

  function wire(root) {
    // Delete
    root.querySelectorAll('[data-del-concept]').forEach((btn) => {
      busyClick(btn, '…', async () => {
        const slug = btn.dataset.delConcept;
        if (!confirm('Delete concept "' + slug + '"?\n\nExercises that reference it will show the slug as an unknown concept.')) return;
        await api('/api/admin/concepts/' + encodeURIComponent(slug), { method: 'DELETE' });
        await render();
      });
    });

    // Create
    const createBtn = root.querySelector('#cnCreate');
    if (createBtn) {
      busyClick(createBtn, 'Creating…', async () => {
        const msg = root.querySelector('#cnMsg');
        const slug = root.querySelector('#cnSlug').value.trim();
        const name = root.querySelector('#cnName').value.trim();
        const description = root.querySelector('#cnDescription').value.trim();

        if (!slug || !name) {
          showMessage(msg, '<p class="wh-err">slug and name are required.</p>');
          throw new Error('validation');
        }

        try {
          await api('/api/admin/concepts', {
            method: 'POST',
            body: JSON.stringify({ slug, name, description }),
          });
          root.querySelector('#cnSlug').value = '';
          root.querySelector('#cnName').value = '';
          root.querySelector('#cnDescription').value = '';
          showMessage(msg, '<p class="wh-muted">Created <code>' + esc(slug) + '</code>.</p>');
          await render();
          const m2 = document.getElementById('cnMsg');
          showMessage(m2, '<p class="wh-muted">Created <code>' + esc(slug) + '</code>.</p>');
        } catch (err) {
          showMessage(msg, '<p class="wh-err">' + esc(err.message) + '</p>');
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
      await render();
    }
  }

  // Same hook pattern as webhooks-ui.js
  document.addEventListener('click', (ev) => {
    const tab = ev.target.closest && ev.target.closest('.tab[data-tab="webhooks"]');
    if (tab) setTimeout(tryLoad, 60); // slightly later than webhooks-ui.js so we don't race
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryLoad, 220));
  } else {
    setTimeout(tryLoad, 220);
  }

  window.loadConcepts = render;
})();
