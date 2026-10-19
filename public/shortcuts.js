/**
 * Global keyboard shortcuts.
 *
 *   g <letter>  jump to tab
 *   ?           open the shortcuts help modal
 *   Esc         close the topmost open modal
 *
 * All shortcuts are skipped when the user is typing into an input/textarea
 * or holding ctrl/alt/meta. Tab jumps respect role gating (hidden tabs).
 */
(function () {
  'use strict';

  const G_PREFIX_TIMEOUT = 1500;   // ms before the "g" prefix expires
  const TAB_MAP = {
    t: 'tutor',
    a: 'analytics',
    s: 'students',
    e: 'exercises',
    h: 'health',
    w: 'webhooks',
    p: 'my-progress',
    m: 'my-sessions',
    b: 'weak-spots',    // "blind spots"
  };

  let gPrefix = false;
  let gTimer = null;

  function isTyping() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function anyModalOpen() {
    const modals = document.querySelectorAll('.modal-backdrop, .nudge-modal-backdrop');
    for (const m of modals) if (!m.hidden) return true;
    return false;
  }

  function helpEl() { return document.getElementById('shortcutsModal'); }

  function openHelp() {
    const m = helpEl();
    if (!m) return;
    // Close other modals first so help is topmost
    document.querySelectorAll('.modal-backdrop').forEach((el) => {
      if (el.id !== 'shortcutsModal') el.hidden = true;
    });
    m.hidden = false;
  }
  function closeHelp() {
    const m = helpEl();
    if (m) m.hidden = true;
  }

  function jumpToTab(tabName) {
    const btn = document.querySelector('.tab[data-tab="' + tabName + '"]');
    if (!btn) return; // role-gated tab removed from DOM
    btn.click();
  }

  function clearPrefix() {
    gPrefix = false;
    if (gTimer) { clearTimeout(gTimer); gTimer = null; }
  }

  document.addEventListener('keydown', (e) => {
    // Never interfere with browser shortcuts or typing
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    // Esc — close topmost open modal
    if (e.key === 'Escape') {
      if (anyModalOpen()) {
        document.querySelectorAll('.modal-backdrop, .nudge-modal-backdrop').forEach((m) => {
          if (!m.hidden) m.hidden = true;
        });
        clearPrefix();
        e.preventDefault();
      }
      return;
    }

    if (isTyping()) { clearPrefix(); return; }

    // ? — toggle help
    if (e.key === '?') {
      if (helpEl() && !helpEl().hidden) closeHelp();
      else openHelp();
      clearPrefix();
      e.preventDefault();
      return;
    }

    // If any modal is open, don't act on other shortcuts
    if (anyModalOpen()) return;

    // g prefix start
    if (e.key.toLowerCase() === 'g' && !e.shiftKey) {
      gPrefix = true;
      if (gTimer) clearTimeout(gTimer);
      gTimer = setTimeout(clearPrefix, G_PREFIX_TIMEOUT);
      e.preventDefault();
      return;
    }

    // Second key after g
    if (gPrefix) {
      const key = e.key.toLowerCase();
      clearPrefix();
      if (TAB_MAP[key]) {
        jumpToTab(TAB_MAP[key]);
        e.preventDefault();
      }
    }
  });

  // Menu item + close button + backdrop click
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('openShortcutsBtn')?.addEventListener('click', () => {
      // Close the user menu, then open help
      if (typeof toggleUserMenu === 'function') toggleUserMenu(false);
      else {
        const menu = document.getElementById('userMenuDropdown');
        if (menu) menu.hidden = true;
      }
      openHelp();
    });

    document.getElementById('closeShortcutsBtn')?.addEventListener('click', closeHelp);

    const help = helpEl();
    if (help) {
      help.addEventListener('click', (e) => {
        if (e.target === help) closeHelp();
      });
    }
  });
})();
