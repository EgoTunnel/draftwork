// Theme and text size, remembered in this browser. Each page applies them early with a small
// inline script in <head> so there is no flash; this module provides the picker.
import { h } from './dom.js';
import { popover } from './menu.js';

const KEY = 'draftwork.appearance';
export const THEMES = { system: 'System', light: 'Light', dark: 'Dark', sepia: 'Sepia', contrast: 'High contrast' };
export const SIZES = { small: 'Small', normal: 'Default', large: 'Large' };

export function getAppearance() {
  try {
    return { theme: 'system', size: 'normal', ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { theme: 'system', size: 'normal' };
  }
}

export function setAppearance(patch) {
  const a = { ...getAppearance(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch { /* storage unavailable: applies to this page only */ }
  applyAppearance(a);
  return a;
}

export function applyAppearance(a = getAppearance()) {
  const root = document.documentElement;
  if (a.theme && a.theme !== 'system') root.dataset.theme = a.theme;
  else delete root.dataset.theme;
  if (a.size && a.size !== 'normal') root.dataset.size = a.size;
  else delete root.dataset.size;
}

const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/></svg>';

function segmented(label, options, value, onPick, tips = {}) {
  const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  for (const [k, text] of Object.entries(options)) {
    group.append(h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(k === value), 'data-tip': tips[k] || null,
      onclick: () => {
        for (const b of group.children) b.setAttribute('aria-checked', 'false');
        group.querySelector(`[data-k="${k}"]`).setAttribute('aria-checked', 'true');
        onPick(k);
      },
      dataset: { k },
    }, text));
  }
  return h('div', { class: 'stack-sm' }, h('div', { class: 'pop-label' }, label), group);
}

// The appearance button for a page's top bar.
export function appearanceButton() {
  const btn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Appearance', 'data-tip': 'Appearance: theme and text size', html: ICON });
  btn.addEventListener('click', () => {
    const a = getAppearance();
    popover(btn, h('div', { class: 'appearance-pop' },
      segmented('Theme', THEMES, a.theme, (theme) => setAppearance({ theme }), { system: 'Follow your computer’s light or dark setting' }),
      segmented('Text size', SIZES, a.size, (size) => setAppearance({ size }), { small: 'Smaller text throughout the app', large: 'Larger text throughout the app' }),
    ));
  });
  return btn;
}
