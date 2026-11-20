/**
 * Barre de lecture (bas de l'écran). Construite une seule fois puis mise à jour
 * en fonction des événements du lecteur.
 */
import { h, icon, replace } from './dom.js';
import { artwork } from './components.js';
import { formatDuration } from '../core/format.js';

const SEEK_STEPS = 1000;

export function mountPlayerBar(app) {
  const { player, library } = app;
  const root = document.getElementById('player');

  const art = h('div');
  const title = h('div', { class: 'now-title' });
  const artist = h('div', { class: 'now-artist' });
  const now = h('div', { class: 'now' }, art, h('div', { class: 'now-text' }, title, artist));

  const btnShuffle = h('button', { class: 'icon-btn opt', onClick: () => player.toggleShuffle() }, icon('shuffle'));
  const btnPrev = h('button', { class: 'icon-btn', 'aria-label': 'Précédent', onClick: () => player.previous() }, icon('prev'));
  const btnToggle = h('button', { class: 'main-toggle', onClick: () => player.toggle() });
  const btnNext = h('button', { class: 'icon-btn', 'aria-label': 'Suivant', onClick: () => player.next() }, icon('next'));
  const btnRepeat = h('button', { class: 'icon-btn opt', onClick: () => player.cycleRepeat() });

  const timeCurrent = h('time', {}, '0:00');
  const timeTotal = h('time', {}, '0:00');
  const seek = h('input', { class: 'range', type: 'range', min: 0, max: SEEK_STEPS, value: 0, step: 1, 'aria-label': 'Position de lecture' });

  const btnMute = h('button', { class: 'icon-btn', onClick: () => player.toggleMute() });
  const volume = h('input', { class: 'range', type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Volume' });

  replace(
    root,
    now,
    h(
      'div',
      { class: 'controls' },
      h('div', { class: 'ctrl-buttons' }, btnShuffle, btnPrev, btnToggle, btnNext, btnRepeat),
      h('div', { class: 'timeline' }, timeCurrent, seek, timeTotal),
    ),
    h('div', { class: 'extras' }, btnMute, volume),
  );

  /* ------------------------------------------------------------ Actions */

  let seeking = false;
  seek.addEventListener('input', () => {
    seeking = true;
    fill(seek, seek.value / SEEK_STEPS);
    timeCurrent.textContent = formatDuration((seek.value / SEEK_STEPS) * player.audio.duration);
  });
  seek.addEventListener('change', () => {
    player.seek((seek.value / SEEK_STEPS) * player.audio.duration);
    seeking = false;
  });
  volume.addEventListener('input', () => player.setVolume(volume.value / 100));

  /* ------------------------------------------------------------ Mises à jour */

  function renderTrack() {
    const track = player.current;
    now.classList.toggle('idle', !track);
    replace(art, artwork({ url: track && library.coverUrl(track.id), seed: track ? track.album || track.title : 'spotifake' }));
    title.textContent = track ? track.title : 'Aucune lecture en cours';
    artist.textContent = track ? track.artist || 'Artiste inconnu' : (matchMedia('(hover: none)').matches ? 'Touchez' : 'Double-cliquez sur') + ' un titre pour l’écouter';
    document.title = track ? `${track.title} · ${track.artist || 'Spotifake'}` : 'Spotifake';
    renderState();
    renderTime();
  }

  function renderState() {
    const hasTrack = Boolean(player.current);
    const playing = player.isPlaying;
    replace(btnToggle, icon(playing ? 'pause' : 'play'));
    btnToggle.setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
    for (const b of [btnToggle, btnPrev, btnNext, seek]) b.disabled = !hasTrack;

    btnShuffle.classList.toggle('active', player.shuffle);
    btnShuffle.setAttribute('aria-label', player.shuffle ? 'Désactiver la lecture aléatoire' : 'Activer la lecture aléatoire');
    btnShuffle.setAttribute('aria-pressed', String(player.shuffle));

    replace(btnRepeat, icon(player.repeat === 'one' ? 'repeatOne' : 'repeat'));
    btnRepeat.classList.toggle('active', player.repeat !== 'off');
    btnRepeat.setAttribute('aria-label', { off: 'Répéter : désactivé', all: 'Répéter : tout', one: 'Répéter : ce titre' }[player.repeat]);

    const { muted, volume: v } = player.audio;
    replace(btnMute, icon(muted || v === 0 ? 'mute' : v < 0.5 ? 'volumeLow' : 'volume'));
    btnMute.setAttribute('aria-label', muted ? 'Réactiver le son' : 'Couper le son');
    volume.value = muted ? 0 : Math.round(v * 100);
    fill(volume, muted ? 0 : v);
  }

  function renderTime() {
    if (seeking) return;
    const { currentTime, duration } = player.audio;
    const ratio = duration > 0 ? currentTime / duration : 0;
    seek.value = Math.round(ratio * SEEK_STEPS);
    fill(seek, ratio);
    timeCurrent.textContent = formatDuration(currentTime || 0).replace('–:––', '0:00');
    timeTotal.textContent = formatDuration(duration || player.current?.duration).replace('–:––', '0:00');
  }

  player.on('track', renderTrack);
  player.on('state', renderState);
  player.on('time', renderTime);
  player.audio.addEventListener('loadedmetadata', renderTime);
  renderTrack();
}

function fill(range, ratio) {
  range.style.setProperty('--p', `${Math.max(0, Math.min(1, ratio || 0)) * 100}%`);
}
