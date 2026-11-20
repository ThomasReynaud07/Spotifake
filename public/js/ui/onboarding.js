/**
 * Premier démarrage : présentation, choix du nom, puis des emplacements.
 * Lors des démarrages suivants cet écran n'apparaît plus (réglage « onboarded »).
 */
import { h, icon, replace } from './dom.js';
import { plural } from '../core/format.js';
import { supportsFolderAccess } from '../core/library.js';

export function showOnboarding(app) {
  return new Promise((resolve) => {
    const root = document.getElementById('overlay-root');
    const card = h('div', { class: 'onboarding', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'onboarding-title' });
    const overlay = h('div', { class: 'overlay' }, card);
    root.replaceChildren(overlay);

    const steps = (current) => h('div', { class: 'steps', 'aria-hidden': 'true' }, [1, 2].map((n) => h('span', { class: n <= current ? 'on' : '' })));

    /* ---------------------------------------------------- Étape 1 : bienvenue */

    function stepWelcome() {
      const input = h('input', {
        class: 'input',
        id: 'onboarding-name',
        maxlength: 40,
        placeholder: 'ex. Platine de Léa',
        value: app.settings.name,
        autocomplete: 'nickname',
      });
      const next = h('button', { class: 'btn primary', type: 'submit' }, 'Continuer', icon('arrowRight'));
      const sync = () => (next.disabled = input.value.trim() === '');
      input.addEventListener('input', sync);
      sync();

      const feature = (iconName, title, text) =>
        h('li', {}, h('span', { class: 'icon-wrap' }, icon(iconName)), h('div', {}, h('strong', {}, title), h('span', {}, text)));

      replace(
        card,
        h('img', { class: 'logo', src: 'assets/logo.svg', alt: '' }),
        h('h1', { id: 'onboarding-title' }, 'Bienvenue sur Spotifake'),
        h('p', { class: 'lead' }, 'Votre musique, partagée directement entre ordinateurs. Sans compte, sans cloud.'),
        h(
          'ul',
          { class: 'features' },
          feature('shield', 'Vos fichiers restent chez vous', 'Spotifake les lit sur place, sans les copier.'),
          feature('network', 'Partage pair-à-pair', 'Parcourez les médiathèques des personnes connectées au même réseau.'),
          feature('download', 'Importez pour écouter hors ligne', 'Un son importé reste disponible même si son propriétaire se déconnecte.'),
        ),
        h(
          'form',
          {
            onSubmit: async (event) => {
              event.preventDefault();
              const name = input.value.trim();
              if (!name) return;
              await app.updateSettings({ name });
              stepFolders();
            },
          },
          h('div', { class: 'field' }, h('label', { for: 'onboarding-name' }, 'Comment les autres verront votre médiathèque ?'), input),
          h('div', { class: 'onboarding-actions' }, steps(1), next),
        ),
      );
      input.focus();
    }

    /* ---------------------------------------------------- Étape 2 : dossiers */

    function stepFolders() {
      const list = h('div', { class: 'loc-list', style: { 'margin-top': '16px' } });
      const finish = h('button', { class: 'btn primary', onClick: done }, 'Terminer', icon('check'));
      const skip = h('button', { class: 'btn ghost', onClick: done }, 'Plus tard');

      function renderList() {
        const scanning = Boolean(app.library.scan);
        replace(
          list,
          app.library.locations.map((loc) =>
            h(
              'div',
              { class: 'loc-item' },
              h('div', { class: 'loc-icon' }, icon('folder')),
              h(
                'div',
                { class: 'loc-meta' },
                h('div', { class: 'loc-name' }, loc.name),
                h('div', { class: 'loc-sub' }, scanning ? 'Analyse…' : plural(app.library.countTracks(loc.id), 'titre trouvé', 'titres trouvés')),
              ),
            ),
          ),
        );
        const hasLocations = app.library.locations.length > 0;
        finish.hidden = !hasLocations;
        skip.hidden = hasLocations;
      }

      replace(
        card,
        h('h1', { id: 'onboarding-title' }, 'Où se trouve votre musique ?'),
        h(
          'p',
          { class: 'lead' },
          'Choisissez un ou plusieurs dossiers. Vous pourrez en ajouter ou en retirer à tout moment dans « Emplacements & réglages ».',
        ),
        !supportsFolderAccess &&
          h(
            'div',
            { class: 'banner', style: { margin: '0 0 16px' } },
            icon('alert'),
            h('p', {}, 'Votre navigateur ne mémorise pas les dossiers entre deux visites. Pour une expérience complète, utilisez Chrome ou Edge.'),
          ),
        h(
          'button',
          { class: 'dropzone', onClick: () => app.addFolder() },
          icon('folderPlus'),
          h('strong', {}, 'Ajouter un dossier'),
          h('span', {}, 'MP3, FLAC, OGG, Opus, WAV, M4A…'),
        ),
        list,
        h('div', { class: 'onboarding-actions' }, steps(2), h('div', { style: { display: 'flex', gap: '8px' } }, skip, finish)),
      );

      renderList();
      const offs = [app.library.on('locations', renderList), app.library.on('change', renderList), app.library.on('scan', renderList)];
      cleanup = () => offs.forEach((off) => off());
    }

    let cleanup = () => {};

    async function done() {
      cleanup();
      await app.updateSettings({ onboarded: true });
      overlay.remove();
      resolve();
    }

    stepWelcome();
  });
}
