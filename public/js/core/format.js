/**
 * Fonctions utilitaires pures (sans DOM) : formatage et hachage.
 * Testées dans test/format.test.js.
 */

/** 187 → « 3:07 », 3723 → « 1:02:03 ». */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '–:––';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Durée totale lisible : « 42 min », « 2 h 05 min ». */
export function formatTotalDuration(seconds) {
  const minutes = Math.round((Number(seconds) || 0) / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

const SIZE_UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'];

/** Taille en octets → « 4,2 Mo » (notation française). */
export function formatSize(bytes) {
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits).replace('.', ',')} ${SIZE_UNITS[unit]}`;
}

/** « 1 titre » / « 12 titres ». */
export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** Hachage FNV-1a 32 bits → entier non signé. Suffisant pour des identifiants/couleurs. */
export function hashString(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Normalise un texte pour la recherche : minuscules, sans accents. */
export function normalizeText(str) {
  return String(str ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Empreinte d'un morceau, identique chez tous les pairs pour le même fichier.
 * Sert à savoir si un son distant est « déjà dans ma médiathèque ».
 */
export function trackFingerprint({ size, title, artist }) {
  return `${size}:${normalizeText(title)}:${normalizeText(artist)}`;
}

/** Initiales pour un avatar : « Marie Curie » → « MC ». */
export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}

/** Comparateur de tri tolérant (nombres, textes avec accents, valeurs vides en dernier). */
export function compareValues(a, b) {
  const emptyA = a === undefined || a === null || a === '';
  const emptyB = b === undefined || b === null || b === '';
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'fr', { sensitivity: 'base', numeric: true });
}
