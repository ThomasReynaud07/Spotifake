/**
 * Vue d'une médiathèque distante : consultation de son contenu et import
 * de sons dans ma médiathèque locale.
 */
import { h, icon, replace } from '../dom.js';
import { avatar, emptyState, hueOf, menuButton, stickyToolbar } from '../components.js';
import { createTrackTable } from '../trackTable.js';
import { formatSize, formatTotalDuration, plural } from '../../core/format.js';

const STATE_LABELS = { connected: 'Connexion directe', connecting: 'Connexion…', disconnected: 'Injoignable' };

export function peerView(app, { id }) {
  const { network, library } = app;
  const getPeer = () => network.peers.get(id);

  const table = createTrackTable({
    label: 'Morceaux de la médiathèque distante',
    getCover: (track) => getPeer()?.covers.get(track.id),
    renderAction: (track) => importButton(track),
  });

  /* --------------------------------------------------- Bouton d'import */

  function importButton(track) {
    const peer = getPeer();
    const job = app.imports.get(app.importKey(id, track.id));
    const owned = library.fingerprints.has(track.fingerprint);

    if (job?.state === 'progress') {
      const pct = Math.round(job.progress * 100);
      return h(
        'button',
        { class: 'import-btn is-progress', style: { '--p': `${pct}%` }, disabled: true, 'aria-label': `Import en cours : ${pct} %` },
        h('span', {}, `${pct} %`),
      );
    }
    if (job?.state === 'done' || owned) {
      return h(
        'button',
        { class: `import-btn ${job?.state === 'done' ? 'is-done' : 'is-owned'}`, disabled: true, title: 'Déjà dans ma médiathèque' },
        icon('check'),
        h('span', { class: 'txt' }, job?.state === 'done' ? 'Importé' : 'Déjà chez moi'),
      );
    }
    return h(
      'button',
      {
        class: 'import-btn',
        disabled: peer?.state !== 'connected',
        title: `Importer « ${track.title} » dans ma médiathèque`,
        onClick: () => app.importTrack(getPeer(), track),
      },
      icon(job?.state === 'error' ? 'refresh' : 'download'),
      h('span', { class: 'txt' }, job?.state === 'error' ? 'Réessayer' : 'Importer'),
    );
  }

  /* ------------------------------------------------------------- Structure */

  const heroAvatar = h('div');
  const heroTitle = h('h1', { class: 'hero-title' });
  const heroMeta = h('div', { class: 'hero-meta' });
  const hero = h(
    'header',
    { class: 'hero' },
    menuButton(),
    heroAvatar,
    h('div', { class: 'hero-text' }, h('div', { class: 'eyebrow' }, 'Médiathèque distante'), heroTitle, heroMeta),
  );

  const btnImportAll = h('button', { class: 'btn small', onClick: importMissing }, icon('download'));
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h(
      'label',
      { class: 'search' },
      icon('search'),
      h('input', {
        type: 'search',
        placeholder: 'Rechercher dans cette médiathèque…',
        'aria-label': 'Rechercher dans la médiathèque distante',
        'data-search': '',
        onInput: (event) => {
          table.setQuery(event.target.value);
          renderToolbar();
        },
      }),
    ),
    h('div', { class: 'spacer' }),
    btnImportAll,
  );
  const notice = h(
    'div',
    { class: 'banner info' },
    icon('info'),
    h('p', {}, 'Un son importé est copié chez vous : vous pourrez l’écouter même quand cette médiathèque sera hors ligne.'),
  );
  const content = h('div');
  const el = h('section', { class: 'view' }, hero, toolbar, notice, content);

  function missingTracks() {
    const peer = getPeer();
    if (!peer?.catalog) return [];
    return table.visible.filter(
      (t) => !library.fingerprints.has(t.fingerprint) && !['progress', 'done'].includes(app.imports.get(app.importKey(id, t.id))?.state),
    );
  }

  async function importMissing() {
    const peer = getPeer();
    const tracks = missingTracks();
    if (!peer || tracks.length === 0) return;
    for (const track of tracks) {
      if (peer.state !== 'connected') break;
      await app.importTrack(peer, track, { quiet: tracks.length > 1 });
    }
    if (tracks.length > 1) app.toast(`Import terminé depuis ${peer.name}.`, 'success');
  }

  /* ------------------------------------------------------------------ Rendu */

  function renderHero() {
    const peer = getPeer();
    const name = peer?.name ?? 'Médiathèque hors ligne';
    hero.style.setProperty('--hue', hueOf(id));
    replace(heroAvatar, avatar(name, id, 'xl'));
    heroTitle.textContent = name;

    const catalog = peer?.catalog ?? [];
    const duration = catalog.reduce((sum, t) => sum + (t.duration || 0), 0);
    const size = catalog.reduce((sum, t) => sum + t.size, 0);
    replace(
      heroMeta,
      h('span', { class: 'status' }, h('span', { class: `dot ${peer?.state ?? 'offline'}` }), peer ? STATE_LABELS[peer.state] : 'Hors ligne'),
      peer && h('span', {}, plural(peer.catalog ? catalog.length : peer.trackCount, 'titre')),
      catalog.length > 0 && h('span', {}, formatTotalDuration(duration)),
      catalog.length > 0 && h('span', {}, formatSize(size)),
    );
  }

  function renderToolbar() {
    const count = missingTracks().length;
    replace(btnImportAll, icon('download'), h('span', { class: 'btn-label' }, count > 0 ? `Importer ce qui me manque (${count})` : 'Rien à importer'));
    btnImportAll.disabled = count === 0 || getPeer()?.state !== 'connected';
  }

  function renderContent() {
    const peer = getPeer();
    const back = h('a', { class: 'btn', href: '#/library' }, 'Retour à ma médiathèque');

    if (!peer) {
      replace(content, emptyState({ iconName: 'wifiOff', title: 'Cette médiathèque n’est plus en ligne', text: 'Les sons déjà importés restent disponibles dans votre médiathèque.', actions: [back] }));
    } else if (peer.catalog && peer.catalog.length > 0) {
      if (table.el.parentElement !== content) replace(content, table.el);
      table.setTracks(peer.catalog);
      peer.requestCovers();
    } else if (peer.catalog) {
      replace(content, emptyState({ iconName: 'music', title: `${peer.name} ne partage encore aucun titre`, text: 'Revenez plus tard : la liste se met à jour automatiquement.' }));
    } else if (peer.state === 'disconnected') {
      replace(
        content,
        emptyState({
          iconName: 'wifiOff',
          title: 'Connexion directe impossible',
          text: `${peer.name} est annoncé sur le réseau, mais la connexion pair-à-pair n’a pas pu s’établir (pare-feu, réseau isolé…). Nouvelle tentative automatique.`,
        }),
      );
    } else {
      replace(content, emptyState({ busy: true, title: `Connexion à ${peer.name}…`, text: 'Récupération de la liste des titres.' }));
    }
  }

  function renderAll() {
    renderHero();
    renderContent();
    renderToolbar(); // après le tableau : le compte se base sur les lignes visibles
  }

  renderAll();

  const cleanups = [
    network.on('peers', () => {
      renderHero();
      renderToolbar();
      // On ne redessine le tableau que si l'état de connexion le nécessite.
      const peer = getPeer();
      if (!peer?.catalog || peer.catalog.length === 0) renderContent();
      else table.refreshActions();
    }),
    network.on('catalog', (peer) => peer.id === id && renderAll()),
    network.on('cover', (peer, trackId) => peer.id === id && table.setCover(trackId, peer.covers.get(trackId))),
    library.on('change', () => {
      table.refreshActions();
      renderToolbar();
    }),
    app.on('import', ({ peerId, trackId }) => {
      if (peerId !== id) return;
      table.refreshAction(trackId);
      renderToolbar();
    }),
    stickyToolbar(el, toolbar),
  ];

  return { el, destroy: () => cleanups.forEach((fn) => fn()) };
}
