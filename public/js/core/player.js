/**
 * Lecteur audio : file d'attente, aléatoire, répétition, volume.
 * S'intègre aux touches multimédia du système via la Media Session API.
 *
 * Événements émis :
 *  - « track »  : le morceau courant a changé
 *  - « state »  : lecture / pause / modes changés
 *  - « time »   : position de lecture (≈ 4×/s)
 *  - « error »  (message)
 */
import { Emitter } from './emitter.js';
import { db } from './db.js';

export class Player extends Emitter {
  audio = new Audio();
  /** @type {string[]} ordre de lecture (ids des morceaux) */
  queue = [];
  index = -1;
  shuffle = false;
  /** @type {'off'|'all'|'one'} */
  repeat = 'off';

  #originalQueue = [];
  #objectUrl = null;
  #loadToken = 0;

  constructor(library) {
    super();
    this.library = library;
    this.audio.preload = 'auto';

    this.audio.addEventListener('play', () => this.emit('state'));
    this.audio.addEventListener('pause', () => this.emit('state'));
    this.audio.addEventListener('volumechange', () => this.emit('state'));
    this.audio.addEventListener('timeupdate', () => this.emit('time'));
    this.audio.addEventListener('ended', () => this.#onEnded());
    this.audio.addEventListener('error', () => {
      if (this.audio.getAttribute('src')) this.#fail('format non pris en charge par ce navigateur.');
    });

    this.#setupMediaSession();
  }

  async init() {
    const saved = await db.get('kv', 'player');
    if (saved) {
      this.audio.volume = saved.volume ?? 1;
      this.shuffle = Boolean(saved.shuffle);
      this.repeat = saved.repeat ?? 'off';
    }
    this.emit('state');
  }

  get current() {
    return this.library.tracks.get(this.queue[this.index]) ?? null;
  }

  get isPlaying() {
    return !this.audio.paused;
  }

  /** Lance la lecture d'une liste de morceaux à partir de `startId`. */
  playList(ids, startId = ids[0]) {
    this.#originalQueue = [...ids];
    if (this.shuffle) {
      this.queue = shuffled(ids, startId);
      this.index = 0;
    } else {
      this.queue = [...ids];
      this.index = Math.max(0, ids.indexOf(startId));
    }
    this.#load(true);
  }

  toggle() {
    if (!this.current) return;
    if (this.audio.paused) this.audio.play().catch(() => {});
    else this.audio.pause();
  }

  next(auto = false) {
    if (this.queue.length === 0) return;
    if (this.index < this.queue.length - 1) this.index++;
    else if (this.repeat === 'all' || !auto) this.index = 0;
    else {
      this.audio.pause();
      this.audio.currentTime = 0;
      return;
    }
    this.#load(true);
  }

  previous() {
    if (this.audio.currentTime > 3 || this.queue.length === 0) {
      this.audio.currentTime = 0;
      return;
    }
    this.index = this.index > 0 ? this.index - 1 : this.queue.length - 1;
    this.#load(true);
  }

  seek(seconds) {
    if (Number.isFinite(this.audio.duration)) {
      this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration));
    }
  }

  setVolume(volume) {
    this.audio.volume = Math.max(0, Math.min(1, volume));
    this.audio.muted = false;
    this.#save();
  }

  toggleMute() {
    this.audio.muted = !this.audio.muted;
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    const currentId = this.queue[this.index];
    if (currentId) {
      this.queue = this.shuffle ? shuffled(this.#originalQueue, currentId) : [...this.#originalQueue];
      this.index = this.queue.indexOf(currentId);
    }
    this.#save();
    this.emit('state');
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.#save();
    this.emit('state');
  }

  /* ------------------------------- Interne -------------------------------- */

  async #load(autoplay) {
    const track = this.current;
    if (!track) return;
    const token = ++this.#loadToken; // ignore les chargements devenus obsolètes (clics rapides)
    this.emit('track', track);

    let file;
    try {
      file = await this.library.getFile(track.id);
    } catch (error) {
      if (token !== this.#loadToken) return;
      this.#fail(error.name === 'NotAllowedError' ? 'accès au dossier refusé.' : 'fichier introuvable.');
      return;
    }
    if (token !== this.#loadToken) return;

    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
    this.#objectUrl = URL.createObjectURL(file);
    this.audio.src = this.#objectUrl;
    this.#updateMediaSession(track);
    // play() échoue si le navigateur bloque la lecture automatique : l'utilisateur pourra cliquer sur ▶.
    if (autoplay) this.audio.play().catch(() => this.emit('state'));
  }

  #onEnded() {
    if (this.repeat === 'one') {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
    } else {
      this.next(true);
    }
  }

  #fail(message) {
    this.emit('error', `« ${this.current?.title ?? 'Morceau'} » : ${message}`);
    this.emit('state');
  }

  #save() {
    db.set('kv', 'player', { volume: this.audio.volume, shuffle: this.shuffle, repeat: this.repeat });
  }

  #setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const actions = {
      play: () => this.toggle(),
      pause: () => this.toggle(),
      previoustrack: () => this.previous(),
      nexttrack: () => this.next(),
      seekto: ({ seekTime }) => this.seek(seekTime),
    };
    for (const [action, handler] of Object.entries(actions)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        /* action non supportée */
      }
    }
  }

  #updateMediaSession(track) {
    if (!('mediaSession' in navigator)) return;
    const cover = this.library.coverUrl(track.id);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: cover ? [{ src: cover, sizes: '300x300', type: 'image/jpeg' }] : [],
    });
  }
}

/** Mélange de Fisher-Yates, en gardant `firstId` en tête. */
export function shuffled(ids, firstId) {
  const rest = ids.filter((id) => id !== firstId);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return firstId !== undefined && ids.includes(firstId) ? [firstId, ...rest] : rest;
}
