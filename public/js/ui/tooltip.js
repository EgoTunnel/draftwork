// Hover and focus tooltips for any element with a data-tip attribute.
let tipEl = null;
let timer = null;
let current = null;

function hide() {
  clearTimeout(timer);
  timer = null;
  current = null;
  if (tipEl) tipEl.classList.remove('show');
}

function show(target) {
  const text = target.dataset.tip;
  if (!text || !document.body.contains(target)) return;
  tipEl.textContent = text;
  tipEl.classList.add('show');
  const r = target.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  const gap = 8;
  let top = r.bottom + gap;
  if (top + t.height > innerHeight - 4) top = r.top - t.height - gap;
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(8, Math.min(left, innerWidth - t.width - 8));
  tipEl.style.top = `${Math.max(4, top)}px`;
  tipEl.style.left = `${left}px`;
}

export function initTooltips() {
  if (tipEl) return;
  tipEl = document.createElement('div');
  tipEl.className = 'tooltip';
  tipEl.setAttribute('role', 'tooltip');
  document.body.append(tipEl);

  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t === current) return;
    hide();
    if (!t) return;
    current = t;
    timer = setTimeout(() => show(t), 450);
  });
  document.addEventListener('pointerout', (e) => {
    if (current && !current.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    hide();
    if (t && t.matches(':focus-visible')) {
      current = t;
      timer = setTimeout(() => show(t), 300);
    }
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', hide, true);
  document.addEventListener('scroll', hide, true);
}
