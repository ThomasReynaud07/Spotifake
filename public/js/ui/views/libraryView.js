/**
 * Vue « Ma médiathèque » : consultation des contenus locaux
 * (Titre, Artiste, Année, Durée, Taille), recherche, tri et lecture.
 */
import { h, icon, replace } from '../dom.js';
import { artwork, emptyState, menuButton, stickyToolbar } from '../components.js';
import { createTrackTable } from '../trackTable.js';
import { formatSize, formatTotalDuration, plural } from '../../core/format.js';

export function libraryView(app) {
  const { library, player } = app;

  const table = createTrackTable({
    label: 'Morceaux de ma médiathèque',
    getCover: (track) => library.coverUrl(track.id),
    onPlay: (track, visible) => player.playList(visible.map((t) => t.id), track.id),
  });

  const heroMeta = h('div', { class: 'hero-meta' });
  const notices = h('div');
  const content = h('div');

  const playAll = (shuffle) => {
    const ids = table.visible.map((t) => t.id);
    if (ids.length === 0) return;
    if (player.shuffle !== shuffle) player.toggleShuffle();
    player.playList(ids, shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[0]);
  };

  const btnPlay = h('button', { class: 'play-btn', 'aria-label': 'Tout lire', onClick: () => playAll(false) }, icon('play'));
  const btnShuffle = h(
    'button',
    { class: 'icon-btn', 'aria-label': 'Lecture aléatoire', title: 'Lecture aléatoire', onClick: () => playAll(true) },
    icon('shuffle'),
  );
  const search = h('input', {
    type: 'search',
    placeholder: 'Titre, artiste, album, année…',
    'aria-label': 'Rechercher dans ma médiathèque',
    'data-search': '',
    onInput: (event) => table.setQuery(event.target.value),
  });

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    btnPlay,
    btnShuffle,
    h('label', { class: 'search' }, icon('search'), search),
    h('div', { class: 'spacer' }),
    h(
      'button',
      { class: 'btn ghost small', onClick: () => library.scanAll(), title: 'Relire les dossiers' },
      icon('refresh'),
      h('span', { class: 'btn-label' }, 'Actualiser'),
    ),
    h(
      'button',
      { class: 'btn small', onClick: () => app.addFolder(), title: 'Ajouter un dossier' },
      icon('folderPlus'),
      h('span', { class: 'btn-label' }, 'Ajouter un dossier'),
    ),
  );

  const el = h(
    'section',
    { class: 'view' },
    h(
      'header',
      { class: 'hero' },
      menuButton(),
      artwork({ className: 'hero-art', seed: 'spotifake' }),
      h(
        'div',
        { class: 'hero-text' },
        h('div', { class: 'eyebrow' }, 'Médiathèque locale'),
        h('h1', { class: 'hero-title' }, 'Ma médiathèque'),
        heroMeta,
      ),
    ),
    toolbar,
    notices,
    content,
  );

  /* ------------------------------------------------------------ Rendu */

  function renderHeader() {
    const { count, duration, size } = library.stats;
    const folders = library.locations.length;
    replace(
      heroMeta,
      h('span', {}, plural(count, 'titre')),
      count > 0 && h('span', {}, formatTotalDuration(duration)),
      count > 0 && h('span', {}, formatSize(size)),
      h('span', {}, plural(folders, 'emplacement')),
    );
    btnPlay.disabled = count === 0;
  }

  function renderNotices() {
    const pending = library.pendingLocations;
    const missing = library.locations.filter((l) => l.status === 'unavailable');
    const scan = library.scan;

    replace(
      notices,
      pending.length > 0 &&
        h(
          'div',
          { class: 'banner' },
          icon('lock'),
          h(
            'p',
            {},
            `Votre navigateur demande votre accord pour relire ${pending.length > 1 ? `${pending.length} dossiers` : `« ${pending[0].name} »`}. `,
            'C’est normal après un redémarrage.',
          ),
          h('button', { class: 'btn small primary', onClick: () => app.grantAccess() }, 'Autoriser l’accès'),
        ),
      missing.map((loc) =>
        h(
          'div',
          { class: 'banner' },
          icon('alert'),
          h('p', {}, `Le dossier « ${loc.name} » est introuvable. A-t-il été déplacé ou supprimé ?`),
          h('a', { class: 'btn small ghost', href: '#/settings' }, 'Gérer'),
        ),
      ),
      scan &&
        h(
          'div',
          { class: 'scan-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': scan.total, 'aria-valuenow': scan.done },
          `Analyse de vos fichiers… ${scan.done} / ${scan.total}`,
          h('div', { class: 'track' }, h('div', { class: 'fill', style: { '--p': `${(scan.done / scan.total) * 100}%` } })),
        ),
    );
  }

  function renderContent() {
    const hasTracks = library.tracks.size > 0;
    const addButton = h('button', { class: 'btn primary', onClick: () => app.addFolder() }, icon('folderPlus'), 'Ajouter un dossier');

    if (hasTracks) {
      if (table.el.parentElement !== content) replace(content, table.el);
      table.setTracks(library.trackList);
      table.setPlaying(player.current?.id, !player.isPlaying);
    } else if (library.locations.length === 0) {
      replace(
        content,
        emptyState({
          iconName: 'folderPlus',
          title: 'Où se trouve votre musique ?',
          text: 'Ajoutez un ou plusieurs dossiers. Spotifake lit vos fichiers sur place : rien n’est copié ni envoyé sans votre accord.',
          actions: [addButton],
        }),
      );
    } else if (library.scan) {
      replace(content, emptyState({ busy: true, title: 'Analyse en cours…', text: 'Lecture des titres, artistes et pochettes.' }));
    } else if (library.pendingLocations.length > 0) {
      replace(
        content,
        emptyState({
          iconName: 'lock',
          title: 'Accès en attente',
          text: 'Autorisez l’accès à vos dossiers pour retrouver votre médiathèque.',
          actions: [h('button', { class: 'btn primary', onClick: () => app.grantAccess() }, 'Autoriser l’accès')],
        }),
      );
    } else {
      replace(
        content,
        emptyState({
          iconName: 'music',
          title: 'Aucun fichier audio trouvé',
          text: 'Formats reconnus : MP3, FLAC, OGG, Opus, WAV, M4A, AAC. Ajoutez un autre dossier ou importez des sons depuis le réseau.',
          actions: [addButton],
        }),
      );
    }
  }

  function renderAll() {
    renderHeader();
    renderNotices();
    renderContent();
  }

  renderAll();

  const cleanups = [
    library.on('change', renderAll),
    library.on('locations', renderAll),
    library.on('scan', () => {
      renderNotices();
      if (library.tracks.size === 0) renderContent();
    }),
    player.on('track', () => table.setPlaying(player.current?.id, !player.isPlaying)),
    player.on('state', () => table.setPlaying(player.current?.id, !player.isPlaying)),
    stickyToolbar(el, toolbar),
  ];

  return { el, destroy: () => cleanups.forEach((fn) => fn()) };
}
