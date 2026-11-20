/**
 * Point d'entrée : crée les modèles (médiathèque, lecteur, réseau),
 * gère les réglages, la navigation (#/library, #/peer/<id>, #/settings)
 * et les actions transverses (ajout de dossier, import d'un son).
 */
import { Emitter } from './core/emitter.js';
import { db } from './core/db.js';
import { Library, supportsFolderAccess } from './core/library.js';
import { Player } from './core/player.js';
import { Network } from './core/network.js';
import { safeFileName } from './core/transfer.js';
import { plural } from './core/format.js';
import { replace } from './ui/dom.js';
import { toast } from './ui/components.js';
import { mountSidebar } from './ui/sidebar.js';
import { mountPlayerBar } from './ui/playerBar.js';
import { showOnboarding } from './ui/onboarding.js';
import { libraryView } from './ui/views/libraryView.js';
import { peerView } from './ui/views/peerView.js';
import { settingsView } from './ui/views/settingsView.js';

class App extends Emitter {
  library = new Library();
  player = new Player(this.library);
  network = new Network(this.library);

  defaultSignalingUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`;
  settings = { name: '', sharing: true, signalingUrl: this.defaultSignalingUrl, onboarded: false };
  route = { name: 'library', params: {} };

  /** Imports en cours ou terminés, par « idPair:idMorceau ». */
  imports = new Map();

  #view = null;

  toast = toast;
  importKey = (peerId, trackId) => `${peerId}:${trackId}`;

  async start() {
    this.settings = { ...this.settings, ...((await db.get('kv', 'settings')) ?? {}) };

    mountSidebar(this);
    mountPlayerBar(this);
    window.addEventListener('hashchange', () => this.#route());
    this.#route();
    this.#bindGlobalEvents();

    await this.player.init();
    this.library.init().catch((error) => toast(`Chargement de la médiathèque impossible : ${error.message}`, 'error'));

    if (!this.settings.onboarded) await showOnboarding(this);
    this.#applyNetworkSettings();
  }

  /* -------------------------------------------------------------- Réglages */

  async updateSettings(patch) {
    const previous = this.settings;
    this.settings = { ...previous, ...patch };
    await db.set('kv', 'settings', this.settings);
    this.emit('settings', this.settings);

    if (!this.settings.onboarded) return;
    if (patch.name !== undefined && patch.name !== previous.name) this.network.setName(this.settings.name);
    if ((patch.sharing !== undefined && patch.sharing !== previous.sharing) || patch.signalingUrl !== undefined) {
      this.#applyNetworkSettings();
    }
  }

  #applyNetworkSettings() {
    this.network.stop();
    if (this.settings.sharing) this.network.start(this.settings.signalingUrl, this.settings.name);
  }

  /* ---------------------------------------------------------------- Actions */

  async addFolder() {
    try {
      const location = supportsFolderAccess
        ? await this.library.addFolder()
        : await this.library.addFiles(await pickFilesFallback());
      if (!location) return;
      const count = this.library.countTracks(location.id);
      toast(`« ${location.name} » ajouté : ${plural(count, 'titre trouvé', 'titres trouvés')}.`, count > 0 ? 'success' : 'info');
    } catch (error) {
      if (error.name !== 'AbortError') toast(error.message, 'error');
    }
  }

  async grantAccess() {
    try {
      await this.library.grantAccess();
    } catch (error) {
      toast(`Autorisation impossible : ${error.message}`, 'error');
    }
  }

  /** Importe un son d'une médiathèque distante dans la médiathèque locale. */
  async importTrack(peer, track, { quiet = false } = {}) {
    if (!peer) return;
    const key = this.importKey(peer.id, track.id);
    if (this.imports.get(key)?.state === 'progress') return;

    const notify = () => this.emit('import', { peerId: peer.id, trackId: track.id });
    const setJob = (job) => {
      this.imports.set(key, job);
      notify();
    };

    try {
      await this.library.prepareImport(); // demande d'écriture : doit suivre le clic immédiatement
    } catch (error) {
      toast(error.message, 'error');
      return;
    }

    setJob({ state: 'progress', progress: 0 });
    let lastUpdate = 0;
    try {
      const { blob, name } = await peer.requestFile(track.id, (received, total) => {
        const now = performance.now();
        if (now - lastUpdate < 120) return; // limite les redessins
        lastUpdate = now;
        setJob({ state: 'progress', progress: total ? received / total : 0 });
      });
      setJob({ state: 'progress', progress: 1 });
      await this.library.importFile(blob, safeFileName(name || track.fileName));
      setJob({ state: 'done' });
      if (!quiet) toast(`« ${track.title} » a été ajouté à votre médiathèque.`, 'success');
    } catch (error) {
      setJob({ state: 'error' });
      toast(`Import de « ${track.title} » échoué : ${error.message}`, 'error', 6000);
    }
  }

  /* ------------------------------------------------------------- Navigation */

  #route() {
    const [, name = 'library', param] = location.hash.split('/');
    const routes = {
      library: () => libraryView(this),
      settings: () => settingsView(this),
      peer: () => peerView(this, { id: decodeURIComponent(param ?? '') }),
    };
    if (!routes[name]) {
      location.hash = '#/library';
      return;
    }

    this.route = { name, params: name === 'peer' ? { id: decodeURIComponent(param ?? '') } : {} };
    this.#view?.destroy();
    this.#view = routes[name]();

    const main = document.getElementById('main');
    replace(main, this.#view.el);
    main.scrollTop = 0;
    document.getElementById('app').classList.remove('nav-open');
    this.emit('route', this.route);
  }

  /* ------------------------------------------------------ Événements globaux */

  #bindGlobalEvents() {
    this.player.on('error', (message) => toast(message, 'error'));
    this.network.on('upload', ({ peer, track }) => toast(`${peer.name} a importé « ${track.title} ».`));

    // Menu mobile : fermeture en cliquant à côté.
    const appEl = document.getElementById('app');
    const scrim = document.getElementById('scrim');
    new MutationObserver(() => (scrim.hidden = !appEl.classList.contains('nav-open'))).observe(appEl, {
      attributes: true,
      attributeFilter: ['class'],
    });
    scrim.addEventListener('click', () => appEl.classList.remove('nav-open'));

    // Raccourcis clavier : Espace = lecture/pause, « / » = recherche, Alt+←/→ = précédent/suivant.
    document.addEventListener('keydown', (event) => {
      const typing = event.target.closest('input, textarea, [contenteditable]');
      if (typing) return;
      if (event.code === 'Space' && !event.target.closest('button, a')) {
        event.preventDefault();
        this.player.toggle();
      } else if (event.key === '/') {
        event.preventDefault();
        document.querySelector('[data-search]')?.focus();
      } else if (event.altKey && event.key === 'ArrowRight') {
        this.player.next();
      } else if (event.altKey && event.key === 'ArrowLeft') {
        this.player.previous();
      }
    });
  }
}

/** Navigateurs sans File System Access API : sélection de dossier via <input>. */
function pickFilesFallback() {
  return new Promise((resolve, reject) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true });
    input.webkitdirectory = true;
    input.addEventListener('change', () => resolve(input.files));
    input.addEventListener('cancel', () => reject(new DOMException('Annulé', 'AbortError')));
    input.click();
  });
}

new App().start().catch((error) => {
  console.error(error);
  toast(`Erreur au démarrage : ${error.message}`, 'error', 10_000);
});
