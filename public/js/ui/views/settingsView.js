/**
 * Vue « Emplacements & réglages » : profil, emplacements des contenus locaux
 * (ajout / retrait / destination des imports) et paramètres réseau.
 */
import { h, icon, replace } from '../dom.js';
import { menuButton, toggleSwitch } from '../components.js';
import { plural } from '../../core/format.js';
import { supportsFolderAccess } from '../../core/library.js';

const KIND_LABELS = { folder: 'Dossier', session: 'Sélection temporaire', imports: 'Stockage du navigateur' };
const STATUS_LABELS = { 'needs-permission': 'Autorisation requise', unavailable: 'Introuvable' };

export function settingsView(app) {
  const { library, network } = app;

  /* ----------------------------------------------------------------- Profil */

  const nameInput = h('input', {
    class: 'input',
    id: 'profile-name',
    maxlength: 40,
    value: app.settings.name,
    autocomplete: 'nickname',
  });
  nameInput.addEventListener('change', () => {
    const name = nameInput.value.trim();
    if (name) app.updateSettings({ name });
    else nameInput.value = app.settings.name;
  });

  const profileCard = h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Profil'), h('p', { class: 'hint' }, 'Le nom sous lequel les autres voient votre médiathèque.'))),
    h('div', { class: 'field' }, h('label', { for: 'profile-name' }, 'Nom affiché'), nameInput),
  );

  /* ----------------------------------------------------------- Emplacements */

  const locList = h('div', { class: 'loc-list' });

  function locationItem(loc) {
    const isImportTarget = library.importTarget?.id === loc.id;
    const count = library.countTracks(loc.id);
    return h(
      'div',
      { class: 'loc-item' },
      h('div', { class: 'loc-icon' }, icon(loc.kind === 'imports' ? 'harddrive' : 'folder')),
      h(
        'div',
        { class: 'loc-meta' },
        h('div', { class: 'loc-name' }, loc.name, ' ', isImportTarget && h('span', { class: 'pill' }, 'Reçoit les imports')),
        h(
          'div',
          { class: 'loc-sub' },
          h('span', {}, KIND_LABELS[loc.kind]),
          h('span', {}, plural(count, 'titre')),
          STATUS_LABELS[loc.status] && h('span', { class: 'warn' }, STATUS_LABELS[loc.status]),
        ),
      ),
      loc.status === 'needs-permission' && h('button', { class: 'btn small primary', onClick: () => app.grantAccess() }, 'Autoriser'),
      loc.kind === 'folder' &&
        loc.status === 'ready' &&
        !isImportTarget &&
        h('button', { class: 'btn small ghost', onClick: () => library.setImportLocation(loc.id), title: 'Les sons importés iront dans un sous-dossier « Importés »' }, 'Recevoir les imports'),
      loc.kind !== 'imports' &&
        h(
          'button',
          {
            class: 'icon-btn',
            'aria-label': `Retirer ${loc.name}`,
            title: 'Retirer de la médiathèque (les fichiers ne sont pas supprimés)',
            onClick: async () => {
              if (confirm(`Retirer « ${loc.name} » de la médiathèque ?\nVos fichiers ne seront pas supprimés.`)) {
                await library.removeLocation(loc.id);
                app.toast(`« ${loc.name} » a été retiré.`);
              }
            },
          },
          icon('trash'),
        ),
    );
  }

  function renderLocations() {
    replace(
      locList,
      library.locations.length > 0
        ? library.locations.map(locationItem)
        : h('p', { class: 'hint' }, 'Aucun emplacement pour l’instant.'),
    );
  }

  const locationsCard = h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        {},
        h('h2', {}, 'Emplacements'),
        h('p', { class: 'hint' }, 'Les dossiers où Spotifake cherche votre musique (sous-dossiers compris).'),
      ),
      h('button', { class: 'btn small primary', onClick: () => app.addFolder() }, icon('folderPlus'), 'Ajouter un dossier'),
    ),
    !supportsFolderAccess &&
      h(
        'div',
        { class: 'banner', style: { margin: '0 0 16px' } },
        icon('alert'),
        h('p', {}, 'Ce navigateur ne peut pas mémoriser vos dossiers : il faudra les resélectionner à chaque visite. Utilisez Chrome, Edge ou Opera pour une expérience complète.'),
      ),
    locList,
  );

  /* ------------------------------------------------------------------ Réseau */

  const urlInput = h('input', { class: 'input mono', id: 'signal-url', value: app.settings.signalingUrl, spellcheck: 'false' });
  const statusLine = h('span', { class: 'status' });

  function renderStatus() {
    const labels = { online: 'Connecté au serveur de découverte', connecting: 'Connexion au serveur…', offline: 'Déconnecté' };
    replace(statusLine, h('span', { class: `dot ${network.status}` }), labels[network.status]);
  }

  const networkCard = h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('div', {}, h('h2', {}, 'Réseau'), h('p', { class: 'hint' }, 'Le serveur sert uniquement à se trouver : la musique passe directement d’un navigateur à l’autre (WebRTC).')),
      statusLine,
    ),
    h(
      'div',
      { class: 'toggle-row' },
      h('div', {}, h('strong', {}, 'Partager ma médiathèque'), h('span', {}, 'Désactivé : vous êtes invisible et ne voyez pas les autres.')),
      toggleSwitch({ checked: app.settings.sharing, label: 'Partager ma médiathèque', onChange: (sharing) => app.updateSettings({ sharing }) }),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'signal-url' }, 'Serveur de découverte'),
      h(
        'div',
        { class: 'field-row' },
        urlInput,
        h(
          'button',
          {
            class: 'btn',
            onClick: () => {
              app.updateSettings({ signalingUrl: urlInput.value.trim() || app.defaultSignalingUrl });
              urlInput.value = app.settings.signalingUrl;
              app.toast('Reconnexion au serveur de découverte…');
            },
          },
          icon('refresh'),
          'Se connecter',
        ),
      ),
      h(
        'p',
        { class: 'hint' },
        'En classe : un poste lance ',
        h('code', {}, 'npm start'),
        ', les autres saisissent ici ',
        h('code', {}, 'ws://<IP-du-poste>:3000/signal'),
        '.',
      ),
    ),
  );

  const el = h(
    'section',
    { class: 'view' },
    h(
      'header',
      { class: 'hero', style: { '--hue': 230 } },
      menuButton(),
      h('div', { class: 'hero-text' }, h('div', { class: 'eyebrow' }, 'Réglages'), h('h1', { class: 'hero-title' }, 'Emplacements & réglages')),
    ),
    h('div', { class: 'settings' }, profileCard, locationsCard, networkCard),
  );

  renderLocations();
  renderStatus();

  const cleanups = [
    library.on('locations', renderLocations),
    library.on('change', renderLocations),
    network.on('status', renderStatus),
  ];
  return { el, destroy: () => cleanups.forEach((fn) => fn()) };
}
