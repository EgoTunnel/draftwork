// Dropdown menus (a Word-style menu bar) and simple anchored popovers.
import { h } from './dom.js';

let openPop = null;

function closePop() {
  if (!openPop) return;
  const p = openPop;
  openPop = null;
  p.el.remove();
  document.removeEventListener('pointerdown', p.outside, true);
  document.removeEventListener('keydown', p.key, true);
  p.anchor.setAttribute('aria-expanded', 'false');
  if (p.onClose) p.onClose();
}

function place(el, anchor, align = 'left') {
  const r = anchor.getBoundingClientRect();
  el.style.top = `${r.bottom + 4}px`;
  const w = el.getBoundingClientRect().width;
  let left = align === 'right' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  el.style.left = `${left}px`;
  const bottom = el.getBoundingClientRect().bottom;
  if (bottom > innerHeight - 8) el.style.maxHeight = `${innerHeight - r.bottom - 16}px`;
}

// Shows content in a small floating panel under the anchor. Clicking outside or Escape closes it.
export function popover(anchor, content, { onClose, align = 'right', className = 'popover' } = {}) {
  const same = openPop && openPop.anchor === anchor;
  closePop();
  if (same) return null;
  const el = h('div', { class: className, role: 'dialog' }, content);
  document.body.append(el);
  place(el, anchor, align);
  const p = {
    el, anchor, onClose,
    outside: (e) => {
      if (!el.contains(e.target) && !anchor.contains(e.target)) closePop();
    },
    key: (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closePop();
        anchor.focus();
      }
    },
  };
  openPop = p;
  anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', p.outside, true);
  document.addEventListener('keydown', p.key, true);
  return { el, close: closePop };
}

export const closePopover = closePop;

// items: { label, shortcut, action, checked(), disabled(), tip } | '-' | { header }
function menuList(items, close) {
  const list = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') {
      list.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if (it.header) {
      list.append(h('div', { class: 'menu-header' }, it.header));
      continue;
    }
    if (it.hidden && it.hidden()) continue;
    const checked = it.checked ? it.checked() : null;
    const disabled = it.disabled ? it.disabled() : false;
    list.append(h('button', {
      class: 'menu-item', type: 'button', role: checked == null ? 'menuitem' : 'menuitemcheckbox',
      'aria-checked': checked == null ? null : String(!!checked), disabled, 'data-tip': it.tip || null,
      onclick: () => {
        close();
        it.action();
      },
    }, h('span', { class: 'menu-check', 'aria-hidden': 'true' }, checked ? '✓' : ''), h('span', { class: 'menu-label' }, it.label),
    it.shortcut ? h('span', { class: 'menu-shortcut' }, it.shortcut) : null));
  }
  list.addEventListener('keydown', (e) => {
    const buttons = [...list.querySelectorAll('.menu-item:not([disabled])')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[(i + 1) % buttons.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length].focus();
    }
  });
  return list;
}

// A row of menu buttons. menus: [{ label, items: () => [...] }]
export function menuBar(menus, { onClose } = {}) {
  const bar = h('nav', { class: 'menubar-menus', 'aria-label': 'Menu' });
  const buttons = menus.map((m) => {
    const b = h('button', { class: 'menu-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, m.label);
    const open = (focusFirst) => {
      const pop = popover(b, menuList(m.items(), () => closePop()), { align: 'left', className: 'popover menu-pop', onClose });
      if (pop && focusFirst) {
        const first = pop.el.querySelector('.menu-item:not([disabled])');
        if (first) first.focus();
      }
    };
    b.addEventListener('click', () => open(false));
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!openPop || openPop.anchor !== b) open(true);
      }
    });
    // Moving across the bar while a menu is open switches menus, as in desktop apps.
    b.addEventListener('pointerenter', () => {
      if (openPop && openPop.anchor !== b && buttons.includes(openPop.anchor)) open(false);
    });
    bar.append(b);
    return b;
  });
  return bar;
}
