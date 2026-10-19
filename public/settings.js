/**
 * Settings panel + theme switcher.
 *
 * - Sidebar navigation between Appearance / Account / Classes / Danger
 * - Theme picker (Light / Dark / System) with localStorage persistence
 * - Logout shortcut (moved from user menu)
 *
 * Depends on: app.js ($, currentUser), the modal HTML, and CSS variables.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'codeteach.theme';
  const THEMES = ['light', 'dark', 'system'];

  // ── Theme management ─────────────────────────────────────────

  function getStoredTheme() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (THEMES.includes(raw)) return raw;
    } catch {}
    return 'system';
  }

  function getEffectiveTheme(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    // system
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  function applyTheme(pref) {
    const effective = getEffectiveTheme(pref);
    document.documentElement.setAttribute('data-theme', effective);
    // Update radio checked state
    document.querySelectorAll('input[name="themeChoice"]').forEach((r) => {
      r.checked = r.value === pref;
    });
  }

  function setTheme(pref) {
    if (!THEMES.includes(pref)) return;
    try { localStorage.setItem(STORAGE_KEY, pref); } catch {}
    applyTheme(pref);
  }

  function initTheme() {
    applyTheme(getStoredTheme());
    // React to OS theme changes when in System mode
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        const stored = getStoredTheme();
        if (stored === 'system') applyTheme('system');
      });
    }
  }

  // ── Section navigation ──────────────────────────────────────

  function showSettingsSection(name) {
    document.querySelectorAll('.settings-nav-btn').forEach((btn) => {
      const active = btn.dataset.settingsSection === name;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.settings-panel').forEach((panel) => {
      const active = panel.dataset.settingsPanel === name;
      panel.classList.toggle('active', active);
      if (active) panel.removeAttribute('hidden');
    });
  }

  function populateAccountSection() {
    const user = window.currentUser;
    if (!user) return;
    const nameEl = document.getElementById('settingsAccountName');
    const emailEl = document.getElementById('settingsAccountEmail');
    const roleEl = document.getElementById('settingsAccountRole');
    if (nameEl) nameEl.textContent = user.displayName || '—';
    if (emailEl) emailEl.textContent = user.email || '—';
    if (roleEl) roleEl.textContent = (user.role === 'instructor' ? 'Instructor' : 'Student') + (user.isAdmin ? ' · Admin' : '');
  }

  // ── Wire up ──────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();

    // Theme radio change
    document.querySelectorAll('input[name="themeChoice"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        if (e.target.checked) setTheme(e.target.value);
      });
    });

    // Sidebar nav click
    document.querySelectorAll('.settings-nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const section = btn.dataset.settingsSection;
        showSettingsSection(section);
        if (section === 'account') populateAccountSection();
      });
    });

    // Logout button (in Account section)
    const logoutBtn = document.getElementById('settingsLogoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        try {
          await fetch('/api/auth/logout', { method: 'POST' });
        } finally {
          window.location.reload();
        }
      });
    }
  });

  // Expose for app.js to call after opening the modal
  window.showSettingsSection = showSettingsSection;
  window.populateSettingsAccount = populateAccountSection;
  window.applyTheme = applyTheme;

  // Also handle theme when system preference changes if the user hasn't picked
  // (covered by initTheme's matchMedia listener)

})();

// ─── Notification preferences ───
(function () {
  async function loadPrefs() {
    try {
      const r = await fetch('/api/me/notification-prefs', { credentials: 'same-origin' });
      if (!r.ok) return;
      const p = await r.json();
      const e1 = document.getElementById('npEmailNudges');
      const e2 = document.getElementById('npEmailAnnouncements');
      if (e1) e1.checked = p.emailNudges !== false;
      if (e2) e2.checked = p.emailAnnouncements !== false;
    } catch {}
  }

  async function savePrefs() {
    const e1 = document.getElementById('npEmailNudges');
    const e2 = document.getElementById('npEmailAnnouncements');
    const msg = document.getElementById('npSaveMsg');
    if (!e1 || !e2) return;
    try {
      const r = await fetch('/api/me/notification-prefs', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailNudges: e1.checked, emailAnnouncements: e2.checked }),
      });
      if (r.ok && msg) { msg.textContent = 'Saved.'; msg.hidden = false; setTimeout(() => { msg.hidden = true; }, 1500); }
    } catch {}
  }

  document.addEventListener('DOMContentLoaded', () => {
    const e1 = document.getElementById('npEmailNudges');
    const e2 = document.getElementById('npEmailAnnouncements');
    if (!e1 || !e2) return;
    loadPrefs();
    e1.addEventListener('change', savePrefs);
    e2.addEventListener('change', savePrefs);
  });
})();
