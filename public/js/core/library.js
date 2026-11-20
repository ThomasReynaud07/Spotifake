/**
 * Médiathèque locale : emplacements (dossiers), analyse des fichiers,
 * métadonnées, pochettes et import de sons reçus du réseau.
 *
 * Événements émis :
 *  - « locations » : la liste des emplacements a changé
 *  - « change »    : la liste des morceaux a changé (émis au plus ~6×/s)
 *  - « scan »      : progression de l'analyse ({ done, total } ou null)
 */
import { Emitter } from './emitter.js';
import { db } from './db.js';
import { headBytesNeeded, parseTags } from './metadata.js';
import { hashString, trackFingerprint } from './format.js';

export const AUDIO_EXTENSIONS = ['mp3', 'flac', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'weba'];
export const supportsFolderAccess = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const IMPORTS_LOCATION_ID = 'browser-imports';
const IMPORT_SUBFOLDER = 'Importés';
const SCAN_CONCURRENCY = 4;
const COVER_SIZE = 300;

/**
 * @typedef {Object} Location
 * @property {string} id
 * @property {string} name
 * @property {'folder'|'session'|'imports'} kind  folder = dossier persistant (File System Access API),
 *   session = fichiers choisis via <input> (navigateurs sans l'API), imports = stockage du navigateur
 * @property {'ready'|'needs-permission'|'unavailable'} status
 * @property {FileSystemDirectoryHandle} [handle]
 * @property {File[]} [files]
 *
 * @typedef {Object} Track
 * @property {string} id
 * @property {string} locationId
 * @property {string} path      chemin relatif dans l'emplacement
 * @property {string} fileName
 * @property {number} size      en octets
 * @property {string} type      type MIME
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {number|null} year
 * @property {number|null} duration en secondes
 * @property {Blob|null} cover  miniature JPEG
 * @property {string} fingerprint
 */

export class Library extends Emitter {
  /** @type {Location[]} */
  locations = [];
  /** @type {Map<string, Track>} */
  tracks = new Map();
  /** @type {{done: number, total: number} | null} */
  scan = null;
  importLocationId = null;

  #sources = new Map(); // id du morceau → () => Promise<Blob>
  #coverUrls = new Map();
  #fingerprints = null;
  #changeTimer = null;

  async init() {
    const saved = (await db.get('kv', 'locations')) ?? [];
    this.importLocationId = (await db.get('kv', 'importLocationId')) ?? null;
    this.locations = await Promise.all(
      saved.map(async ({ id, name, handle }) => ({
        id,
        name,
        handle,
        kind: 'folder',
        status: await permissionStatus(handle),
      })),
    );
    if ((await db.keys('imports')).length > 0) this.#ensureImportsLocation();
    this.emit('locations');
    await this.scanAll();
  }

  /* ----------------------------- Emplacements ----------------------------- */

  get pendingLocations() {
    return this.locations.filter((l) => l.status === 'needs-permission');
  }

  /** Ouvre le sélecteur de dossier du système. Lève AbortError si l'utilisateur annule. */
  async addFolder() {
    const handle = await window.showDirectoryPicker({ id: 'spotifake-music', mode: 'read' });
    for (const location of this.locations) {
      if (location.handle && (await location.handle.isSameEntry(handle))) {
        throw new Error(`« ${handle.name} » fait déjà partie de votre médiathèque.`);
      }
    }
    const location = { id: uid(), name: handle.name, kind: 'folder', handle, status: 'ready' };
    this.locations.push(location);
    await this.#saveLocations();
    this.emit('locations');
    await this.scanLocation(location);
    return location;
  }

  /** Solution de repli (Firefox, Safari) : fichiers choisis via <input webkitdirectory>. */
  async addFiles(fileList) {
    const files = [...fileList].filter((f) => isAudioFile(f.name));
    if (files.length === 0) throw new Error('Aucun fichier audio trouvé dans cette sélection.');
    const name = files[0].webkitRelativePath?.split('/')[0] || 'Sélection';
    const location = { id: uid(), name, kind: 'session', files, status: 'ready' };
    this.locations.push(location);
    this.emit('locations');
    await this.scanLocation(location);
    return location;
  }

  countTracks(locationId) {
    let count = 0;
    for (const track of this.tracks.values()) if (track.locationId === locationId) count++;
    return count;
  }

  async removeLocation(id) {
    this.locations = this.locations.filter((l) => l.id !== id);
    for (const track of [...this.tracks.values()]) {
      if (track.locationId === id) this.#removeTrack(track.id);
    }
    if (this.importLocationId === id) await this.setImportLocation(null);
    await this.#saveLocations();
    this.emit('locations');
    this.#changed();
  }

  /**
   * Redemande l'accès aux dossiers après un redémarrage du navigateur.
   * Doit être appelé suite à un clic (exigence du navigateur).
   */
  async grantAccess() {
    for (const location of this.pendingLocations) {
      const result = await location.handle.requestPermission({ mode: 'read' });
      location.status = result === 'granted' ? 'ready' : 'needs-permission';
      this.emit('locations');
      if (location.status === 'ready') await this.scanLocation(location);
    }
  }

  get importTarget() {
    const folders = this.locations.filter((l) => l.kind === 'folder' && l.status === 'ready');
    return folders.find((l) => l.id === this.importLocationId) ?? folders[0] ?? null;
  }

  async setImportLocation(id) {
    this.importLocationId = id;
    await db.set('kv', 'importLocationId', id);
    this.emit('locations');
  }

  /* ------------------------------- Analyse -------------------------------- */

  async scanAll() {
    await Promise.all(this.locations.filter((l) => l.status === 'ready').map((l) => this.scanLocation(l)));
  }

  async scanLocation(location) {
    let entries;
    try {
      entries = await listEntries(location);
    } catch (error) {
      console.warn(`Emplacement « ${location.name} » inaccessible`, error);
      location.status = 'unavailable';
      this.emit('locations');
      return;
    }

    this.#progress(0, entries.length);
    const seen = new Set();

    await forEachLimit(entries, SCAN_CONCURRENCY, async (entry) => {
      try {
        const track = await buildTrack(location, entry);
        seen.add(track.id);
        this.#addTrack(track, entry.getFile);
      } catch (error) {
        console.warn(`Lecture impossible : ${entry.path}`, error);
      } finally {
        this.#progress(1, 0);
      }
    });

    // Fichiers supprimés depuis la dernière analyse.
    for (const track of [...this.tracks.values()]) {
      if (track.locationId === location.id && !seen.has(track.id)) this.#removeTrack(track.id);
    }
    this.#changed();
  }

  /* ------------------------------ Morceaux -------------------------------- */

  get trackList() {
    return [...this.tracks.values()];
  }

  get stats() {
    let duration = 0;
    let size = 0;
    for (const t of this.tracks.values()) {
      duration += t.duration || 0;
      size += t.size;
    }
    return { count: this.tracks.size, duration, size };
  }

  /** @returns {Promise<Blob>} */
  async getFile(trackId) {
    const source = this.#sources.get(trackId);
    if (!source) throw new Error('Ce morceau ne fait plus partie de la médiathèque.');
    return source();
  }

  coverUrl(trackId) {
    const track = this.tracks.get(trackId);
    if (!track?.cover) return null;
    if (!this.#coverUrls.has(trackId)) this.#coverUrls.set(trackId, URL.createObjectURL(track.cover));
    return this.#coverUrls.get(trackId);
  }

  /** Empreintes de tous les morceaux locaux (pour détecter les doublons à l'import). */
  get fingerprints() {
    this.#fingerprints ??= new Set([...this.tracks.values()].map((t) => t.fingerprint));
    return this.#fingerprints;
  }

  /** Ce que l'on partage sur le réseau : uniquement des métadonnées, jamais de chemin local. */
  publicCatalog() {
    return this.trackList.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      year: t.year,
      duration: t.duration,
      size: t.size,
      type: t.type,
      fileName: t.fileName,
      hasCover: Boolean(t.cover),
      fingerprint: t.fingerprint,
    }));
  }

  /* -------------------------------- Import -------------------------------- */

  /**
   * À appeler au moment du clic sur « Importer », avant le transfert :
   * le navigateur n'autorise la demande de permission que suite à un geste.
   */
  async prepareImport() {
    const target = this.importTarget;
    if (!target) return;
    const options = { mode: 'readwrite' };
    if ((await target.handle.queryPermission(options)) === 'granted') return;
    if ((await target.handle.requestPermission(options)) !== 'granted') {
      throw new Error(`Spotifake n'a pas l'autorisation d'écrire dans « ${target.name} ».`);
    }
  }

  /** Enregistre un son reçu dans la médiathèque locale et l'ajoute à la liste. */
  async importFile(blob, fileName) {
    const target = this.importTarget;
    let location;
    let entry;

    if (target) {
      // Écrit dans <dossier>/Importés/ : le fichier reste disponible hors de l'application.
      const dir = await target.handle.getDirectoryHandle(IMPORT_SUBFOLDER, { create: true });
      const name = await availableName(dir, fileName);
      const fileHandle = await dir.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      location = target;
      entry = { path: `${IMPORT_SUBFOLDER}/${name}`, name, getFile: () => fileHandle.getFile() };
    } else {
      // Pas de dossier inscriptible : stockage dans le navigateur (IndexedDB).
      const key = uid();
      await db.set('imports', key, { name: fileName, blob });
      location = this.#ensureImportsLocation();
      entry = { path: key, name: fileName, getFile: async () => blob };
    }

    const track = await buildTrack(location, entry);
    this.#addTrack(track, entry.getFile);
    this.#changed();
    return track;
  }

  /* ------------------------------- Interne -------------------------------- */

  #addTrack(track, getFile) {
    this.#revokeCover(track.id);
    this.tracks.set(track.id, track);
    this.#sources.set(track.id, getFile);
    this.#changed();
  }

  #removeTrack(id) {
    this.#revokeCover(id);
    this.tracks.delete(id);
    this.#sources.delete(id);
  }

  #revokeCover(id) {
    const url = this.#coverUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.#coverUrls.delete(id);
  }

  #ensureImportsLocation() {
    let location = this.locations.find((l) => l.id === IMPORTS_LOCATION_ID);
    if (!location) {
      location = { id: IMPORTS_LOCATION_ID, name: 'Importés (navigateur)', kind: 'imports', status: 'ready' };
      this.locations.push(location);
      this.emit('locations');
    }
    return location;
  }

  async #saveLocations() {
    const folders = this.locations
      .filter((l) => l.kind === 'folder')
      .map(({ id, name, handle }) => ({ id, name, handle }));
    await db.set('kv', 'locations', folders);
  }

  #progress(doneDelta, totalDelta) {
    const scan = this.scan ?? { done: 0, total: 0 };
    scan.done += doneDelta;
    scan.total += totalDelta;
    this.scan = scan.done >= scan.total ? null : scan;
    this.emit('scan', this.scan);
  }

  /** Regroupe les notifications pour ne pas redessiner l'interface à chaque fichier. */
  #changed() {
    this.#fingerprints = null;
    if (this.#changeTimer) return;
    this.#changeTimer = setTimeout(() => {
      this.#changeTimer = null;
      this.emit('change');
    }, 150);
  }
}

/* -------------------------------------------------------------------------- */
/*  Fonctions internes (sans état)                                            */
/* -------------------------------------------------------------------------- */

export function isAudioFile(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  return !name.startsWith('.') && AUDIO_EXTENSIONS.includes(ext);
}

function uid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function permissionStatus(handle) {
  try {
    return (await handle.queryPermission({ mode: 'read' })) === 'granted' ? 'ready' : 'needs-permission';
  } catch {
    return 'unavailable';
  }
}

/** Liste les fichiers audio d'un emplacement sous forme { path, name, getFile }. */
async function listEntries(location) {
  switch (location.kind) {
    case 'folder': {
      const entries = [];
      for await (const entry of walkDirectory(location.handle)) entries.push(entry);
      return entries;
    }
    case 'session':
      return location.files.map((file) => ({
        path: file.webkitRelativePath || file.name,
        name: file.name,
        getFile: async () => file,
      }));
    case 'imports': {
      const keys = await db.keys('imports');
      return Promise.all(
        keys.map(async (key) => {
          const { name, blob } = await db.get('imports', key);
          return { path: String(key), name, getFile: async () => blob };
        }),
      );
    }
    default:
      return [];
  }
}

async function* walkDirectory(dir, prefix = '') {
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (handle.kind === 'directory') yield* walkDirectory(handle, `${prefix}${name}/`);
    else if (isAudioFile(name)) yield { path: prefix + name, name, getFile: () => handle.getFile() };
  }
}

/** Construit un morceau, en réutilisant le cache de métadonnées si le fichier n'a pas changé. */
async function buildTrack(location, entry) {
  const file = await entry.getFile();
  const cacheKey = `${location.id}|${entry.path}|${file.size}|${file.lastModified ?? 0}`;

  let meta = await db.get('meta', cacheKey);
  if (!meta) {
    meta = await extractMetadata(file, entry.name);
    await db.set('meta', cacheKey, meta);
  }

  return {
    id: `t${hashString(`${location.id}|${entry.path}`).toString(36)}`,
    locationId: location.id,
    path: entry.path,
    fileName: entry.name,
    size: file.size,
    type: file.type || guessMime(entry.name),
    ...meta,
    fingerprint: trackFingerprint({ size: file.size, title: meta.title, artist: meta.artist }),
  };
}

async function extractMetadata(file, fileName) {
  const readBytes = async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());

  const first = await readBytes(0, 10);
  const head = await readBytes(0, headBytesNeeded(first));
  const tail = file.size > 128 ? await readBytes(file.size - 128, file.size) : null;
  const tags = parseTags(head, tail, fileName);

  return {
    title: tags.title,
    artist: tags.artist,
    album: tags.album,
    year: tags.year,
    duration: tags.duration ?? (await probeDuration(file)),
    cover: tags.picture ? await makeThumbnail(new Blob([tags.picture.data], { type: tags.picture.mime })) : null,
  };
}

/** Durée via le décodeur du navigateur (fonctionne pour tous les formats lisibles). */
function probeDuration(file) {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(null);
    setTimeout(() => done(null), 10_000);
    audio.src = url;
  });
}

/** Réduit la pochette en miniature carrée JPEG (léger à stocker et à envoyer). */
async function makeThumbnail(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = COVER_SIZE;
    canvas
      .getContext('2d')
      .drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, COVER_SIZE, COVER_SIZE);
    bitmap.close();
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  } catch {
    return null;
  }
}

async function availableName(dir, fileName) {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? fileName : `${base} (${i})${ext}`;
    try {
      await dir.getFileHandle(candidate);
    } catch {
      return candidate; // n'existe pas encore
    }
  }
}

function guessMime(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  const map = { mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', weba: 'audio/webm' };
  return map[ext] ?? 'application/octet-stream';
}

async function forEachLimit(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) await worker(items[index++]);
  });
  await Promise.all(runners);
}
