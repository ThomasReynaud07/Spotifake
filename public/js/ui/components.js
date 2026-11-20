/**
 * Composants d'interface réutilisables : pochettes, avatars, états vides,
 * interrupteurs, notifications (toasts) et barre d'outils collante.
 */
import { h, icon } from './dom.js';
import { hashString, initials } from '../core/format.js';

/** Teinte stable (0–359) dérivée d'un texte : chaque album / pair garde sa couleur. */
export const hueOf = (text) => hashString(String(text ?? '')) % 360;

/**
 * Pochette : l'image si elle existe, sinon un dégradé généré à partir de `seed`
 * (même album ⇒ même couleur, chez tout le monde).
 */
export function artwork({ url = null, seed = '', className = '' } = {}) {
  const hue = hueOf(seed);
  const el = h(
    'div',
    {
      class: `art ${className}`.trim(),
      style: { '--c1': `hsl(${hue} 72% 60%)`, '--c2': `hsl(${(hue + 55) % 360} 62% 30%)` },
    },
    icon('music'),
  );
  if (url) setArtworkImage(el, url);
  return el;
}

export function setArtworkImage(el, url) {
  if (!url || el.querySelector('img')) return;
  el.append(h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' }));
}

export function avatar(name, seed = name, className = '') {
  return h(
    'div',
    { class: `avatar ${className}`.trim(), style: { '--hue': hueOf(seed) }, 'aria-hidden': 'true' },
    initials(name),
  );
}

export function emptyState({ iconName = 'music', title, text, actions = [], busy = false }) {
  return h(
    'div',
    { class: 'empty' },
    busy ? h('div', { class: 'spinner', role: 'progressbar' }) : h('div', { class: 'empty-icon' }, icon(iconName)),
    h('h2', {}, title),
    text && h('p', {}, text),
    actions.length > 0 && h('div', { class: 'actions' }, actions),
  );
}

export function toggleSwitch({ checked, label, onChange }) {
  const button = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(checked), 'aria-label': label });
  button.addEventListener('click', () => {
    const value = button.getAttribute('aria-checked') !== 'true';
    button.setAttribute('aria-checked', String(value));
    onChange(value);
  });
  return button;
}

/** Bouton « menu » visible uniquement sur petit écran. */
export function menuButton() {
  return h(
    'button',
    {
      class: 'icon-btn menu-btn',
      'aria-label': 'Ouvrir le menu',
      onClick: () => document.getElementById('app').classList.add('nav-open'),
    },
    icon('menu'),
  );
}

/**
 * Garde l'en-tête du tableau collé sous la barre d'outils, quelle que soit sa hauteur,
 * et ajoute une bordure quand la barre « colle » en haut. Retourne une fonction de nettoyage.
 */
export function stickyToolbar(view, toolbar) {
  const main = document.getElementById('main');
  const resize = new ResizeObserver(() => view.style.setProperty('--toolbar-h', `${toolbar.offsetHeight}px`));
  resize.observe(toolbar);
  const onScroll = () => toolbar.classList.toggle('stuck', toolbar.getBoundingClientRect().top <= main.getBoundingClientRect().top + 1);
  main.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    resize.disconnect();
    main.removeEventListener('scroll', onScroll);
  };
}

/* ------------------------------------------------------------------ Toasts */

const TOAST_ICONS = { success: 'checkCircle', error: 'alert', info: 'info' };

export function toast(message, type = 'info', duration = 4500) {
  const root = document.getElementById('toasts');
  const dismiss = () => {
    if (el.classList.contains('leaving')) return;
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };
  const el = h(
    'div',
    { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' },
    icon(TOAST_ICONS[type] ?? 'info'),
    h('p', {}, message),
    h(
      'button',
      { class: 'icon-btn', style: { width: '24px', height: '24px' }, 'aria-label': 'Fermer', onClick: dismiss },
      icon('close'),
    ),
  );
  root.append(el);
  while (root.children.length > 4) root.firstElementChild.remove();
  setTimeout(dismiss, duration);
}
