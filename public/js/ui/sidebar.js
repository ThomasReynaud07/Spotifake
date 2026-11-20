/**
 * Barre latérale : navigation, liste des médiathèques en ligne, profil et partage.
 */
import { h, icon, replace } from './dom.js';
import { avatar, toggleSwitch } from './components.js';
import { plural } from '../core/format.js';

const NETWORK_LABELS = { online: 'Connecté', connecting: 'Connexion…', offline: 'Hors ligne' };
const PEER_LABELS = { connecting: 'Connexion directe…', disconnected: 'Injoignable' };

export function mountSidebar(app) {
  const el = document.getElementById('sidebar');
  const { library, network } = app;

  function navItem(href, iconName, label, badge, active) {
    return h(
      'a',
      { class: `nav-item ${active ? 'active' : ''}`, href, 'aria-current': active ? 'page' : null },
      icon(iconName),
      h('span', { class: 'label' }, label),
      badge !== null && h('span', { class: 'badge' }, badge),
    );
  }

  function peerItem(peer) {
    const active = app.route.name === 'peer' && app.route.params.id === peer.id;
    return h(
      'a',
      {
        class: `peer-item ${active ? 'active' : ''}`,
        href: `#/peer/${encodeURIComponent(peer.id)}`,
        'aria-current': active ? 'page' : null,
      },
      avatar(peer.name, peer.id),
      h(
        'span',
        { class: 'peer-meta' },
        h('span', { class: 'peer-name' }, peer.name),
        h('span', { class: 'peer-sub' }, PEER_LABELS[peer.state] ?? plural(peer.trackCount, 'titre')),
      ),
      h('span', { class: `dot ${peer.state}`, title: peer.state }),
    );
  }

  function peersEmptyText() {
    if (!app.settings.sharing) return 'Le partage est désactivé. Activez-le pour voir les autres médiathèques.';
    if (network.status !== 'online') return 'Recherche du serveur de découverte…';
    return "Personne d'autre en ligne pour l'instant.";
  }

  function render() {
    const { route, settings } = app;
    const peers = network.peerList;

    replace(
      el,
      h(
        'a',
        { class: 'brand', href: '#/library' },
        h('img', { src: 'assets/logo.svg', alt: '' }),
        h('div', {}, 'Spotifake', h('small', {}, 'BitRuisseau · pair-à-pair')),
      ),
      h(
        'nav',
        { class: 'sidebar-scroll' },
        h('div', { class: 'nav-title' }, 'Bibliothèque'),
        navItem('#/library', 'library', 'Ma médiathèque', library.tracks.size, route.name === 'library'),
        navItem('#/settings', 'settings', 'Emplacements & réglages', null, route.name === 'settings'),
        h(
          'div',
          { class: 'nav-title' },
          h('span', {}, 'Sur le réseau'),
          h('span', { class: 'status' }, h('span', { class: `dot ${network.status}` }), NETWORK_LABELS[network.status]),
        ),
        peers.length > 0 ? peers.map(peerItem) : h('div', { class: 'peers-empty' }, peersEmptyText()),
      ),
      h(
        'div',
        { class: 'sidebar-footer' },
        avatar(settings.name || '?', settings.name),
        h(
          'div',
          { class: 'me' },
          h('div', { class: 'me-name' }, settings.name || 'Sans nom'),
          h('div', { class: 'status' }, settings.sharing ? 'Médiathèque partagée' : 'Partage désactivé'),
        ),
        toggleSwitch({
          checked: settings.sharing,
          label: 'Partager ma médiathèque sur le réseau',
          onChange: (sharing) => app.updateSettings({ sharing }),
        }),
      ),
    );
  }

  render();
  for (const [emitter, event] of [
    [network, 'peers'],
    [network, 'status'],
    [library, 'change'],
    [app, 'route'],
    [app, 'settings'],
  ]) {
    emitter.on(event, render);
  }
}
