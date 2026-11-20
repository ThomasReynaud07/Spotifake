/**
 * Tableau de morceaux, partagé par la médiathèque locale et les médiathèques distantes.
 * Gère le tri par colonne, la recherche et la mise en évidence du morceau en cours.
 */
import { h, icon, replace } from './dom.js';
import { artwork, setArtworkImage } from './components.js';
import { compareValues, formatDuration, formatSize, normalizeText } from '../core/format.js';

const COLUMNS = [
  { key: 'title', label: 'Titre' },
  { key: 'artist', label: 'Artiste', className: 'col-artist' },
  { key: 'album', label: 'Album', className: 'col-album' },
  { key: 'year', label: 'Année', className: 'col-year', numeric: true },
  { key: 'duration', label: 'Durée', className: 'col-duration', numeric: true },
  { key: 'size', label: 'Taille', className: 'col-size', numeric: true },
];

/**
 * @param {Object} options
 * @param {string} options.label                          nom accessible du tableau
 * @param {(track) => string|null} [options.getCover]     URL de la pochette
 * @param {(track, visible: Array) => void} [options.onPlay]  lecture (absent = non jouable)
 * @param {(track) => Node} [options.renderAction]         contenu de la dernière colonne
 */
const isTouch = () => matchMedia('(hover: none)').matches;

export function createTrackTable({ label, getCover, onPlay, renderAction }) {
  let tracks = [];
  let byId = new Map();
  let visible = [];
  let query = '';
  let sort = { key: 'artist', dir: 1 };
  let playing = { id: null, paused: true };
  let selectedId = null;

  const head = h('div', { class: 'thead', role: 'row' });
  const body = h('div', { role: 'rowgroup' });
  const el = h(
    'div',
    {
      class: ['tracks', renderAction && 'with-action', onPlay && 'playable'].filter(Boolean).join(' '),
      role: 'table',
      'aria-label': label,
    },
    head,
    body,
  );

  /* ------------------------------------------------------------ Rendu */

  function renderHead() {
    replace(
      head,
      h('div', { class: 'th num', role: 'columnheader' }, '#'),
      COLUMNS.map((col) => {
        const sorted = sort.key === col.key;
        return h(
          'button',
          {
            class: ['th', col.className, col.numeric && 'num', sorted && 'sorted'].filter(Boolean).join(' '),
            role: 'columnheader',
            'aria-sort': sorted ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none',
            title: `Trier par ${col.label.toLowerCase()}`,
            onClick: () => setSort(col.key),
          },
          col.label,
          sorted && icon(sort.dir > 0 ? 'arrowUp' : 'arrowDown'),
        );
      }),
      renderAction && h('div', { class: 'th', role: 'columnheader' }, h('span', { class: 'visually-hidden' }, 'Action')),
    );
  }

  function renderRow(track, index) {
    const row = h(
      'div',
      {
        class: 'row',
        role: 'row',
        dataset: { id: track.id },
        // Sur écran tactile, un simple toucher lance la lecture.
        onClick: () => (isTouch() && onPlay ? onPlay(track, visible) : select(track.id)),
        onDblclick: () => onPlay?.(track, visible),
      },
      h(
        'div',
        { class: 'cell cell-index', role: 'cell' },
        h('span', { class: 'n' }, index + 1),
        h('span', { class: 'eq', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
        onPlay &&
          h(
            'button',
            {
              class: 'row-play',
              'aria-label': `Lire ${track.title}`,
              onClick: (event) => {
                event.stopPropagation();
                onPlay(track, visible);
              },
            },
            icon('play'),
          ),
      ),
      h(
        'div',
        { class: 'cell cell-title', role: 'cell' },
        artwork({ url: getCover?.(track), seed: track.album || track.title }),
        h(
          'div',
          { class: 'title-text' },
          h('span', { class: 't-title', title: track.title }, track.title),
          h('span', { class: 't-sub' }, track.artist || 'Artiste inconnu'),
        ),
      ),
      h('div', { class: 'cell col-artist', role: 'cell' }, h('span', { title: track.artist }, track.artist || '—')),
      h('div', { class: 'cell col-album', role: 'cell' }, h('span', { title: track.album }, track.album || '—')),
      h('div', { class: 'cell num col-year', role: 'cell' }, track.year ?? '—'),
      h('div', { class: 'cell num col-duration', role: 'cell' }, formatDuration(track.duration)),
      h('div', { class: 'cell num col-size', role: 'cell' }, formatSize(track.size)),
      renderAction && h('div', { class: 'cell cell-action', role: 'cell' }, renderAction(track)),
    );
    if (track.id === playing.id) row.classList.add('playing', ...(playing.paused ? ['paused'] : []));
    if (track.id === selectedId) row.classList.add('selected');
    return row;
  }

  function renderBody() {
    if (tracks.length > 0 && visible.length === 0) {
      replace(
        body,
        h('div', { class: 'empty' }, h('p', {}, `Aucun résultat pour « ${query} ».`)),
      );
      return;
    }
    const fragment = document.createDocumentFragment();
    visible.forEach((track, index) => fragment.append(renderRow(track, index)));
    body.replaceChildren(fragment);
  }

  /* ------------------------------------------------------- Tri / filtre */

  function compute() {
    const terms = normalizeText(query).split(/\s+/).filter(Boolean);
    const matches = (t) => {
      if (terms.length === 0) return true;
      const haystack = normalizeText(`${t.title} ${t.artist} ${t.album} ${t.year ?? ''}`);
      return terms.every((term) => haystack.includes(term));
    };
    const { key, dir } = sort;
    visible = tracks.filter(matches).sort(
      (a, b) =>
        compareValues(a[key], b[key]) * dir ||
        compareValues(a.artist, b.artist) ||
        compareValues(a.album, b.album) ||
        compareValues(a.title, b.title),
    );
  }

  function refresh() {
    compute();
    renderBody();
  }

  function setSort(key) {
    sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: 1 };
    renderHead();
    refresh();
  }

  function select(id) {
    body.querySelector('.row.selected')?.classList.remove('selected');
    selectedId = id;
    rowOf(id)?.classList.add('selected');
  }

  const rowOf = (id) => body.querySelector(`.row[data-id="${CSS.escape(id)}"]`);

  renderHead();

  /* ------------------------------------------------------------- API */

  return {
    el,
    get visible() {
      return visible;
    },
    setTracks(list) {
      tracks = list;
      byId = new Map(list.map((t) => [t.id, t]));
      refresh();
    },
    setQuery(value) {
      query = value;
      refresh();
    },
    setPlaying(id, paused) {
      body.querySelectorAll('.row.playing').forEach((r) => r.classList.remove('playing', 'paused'));
      playing = { id, paused };
      const row = id && rowOf(id);
      if (row) row.classList.add('playing', ...(paused ? ['paused'] : []));
    },
    setCover(id, url) {
      const art = rowOf(id)?.querySelector('.art');
      if (art) setArtworkImage(art, url);
    },
    /** Redessine la colonne d'action (ex. progression d'un import). */
    refreshAction(id) {
      const cell = rowOf(id)?.querySelector('.cell-action');
      const track = byId.get(id);
      if (cell && track) replace(cell, renderAction(track));
    },
    refreshActions() {
      for (const cell of body.querySelectorAll('.cell-action')) {
        const track = byId.get(cell.parentElement.dataset.id);
        if (track) replace(cell, renderAction(track));
      }
    },
  };
}
