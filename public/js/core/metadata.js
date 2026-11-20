/**
 * Lecture des métadonnées audio (titre, artiste, album, année, pochette)
 * directement depuis les octets du fichier, sans librairie externe.
 *
 * Formats pris en charge :
 *  - MP3 : ID3v2.2 / 2.3 / 2.4 (début du fichier) et ID3v1 (fin du fichier)
 *  - FLAC : blocs STREAMINFO (durée), VORBIS_COMMENT et PICTURE
 *  - OGG Vorbis / Opus : commentaires Vorbis (si contenus dans les premières pages)
 * Pour tout le reste (ou si un champ manque) on se rabat sur le nom du fichier,
 * p. ex. « 03 - Daft Punk - Veridis Quo.mp3 ».
 *
 * Module pur (aucune API DOM) : testé dans test/metadata.test.js.
 */

const latin1 = new TextDecoder('windows-1252');
const utf8 = new TextDecoder('utf-8');

/* ------------------------------------------------------------------ */
/*  API publique                                                       */
/* ------------------------------------------------------------------ */

/**
 * Combien d'octets lire au début du fichier pour obtenir les tags ?
 * @param {Uint8Array} first10 les 10 premiers octets du fichier
 */
export function headBytesNeeded(first10) {
  const MAX = 16 * 1024 * 1024;
  if (isId3(first10)) return Math.min(MAX, id3TotalSize(first10) + 16);
  if (startsWith(first10, 'fLaC')) return 4 * 1024 * 1024;
  return 256 * 1024;
}

/**
 * @param {Uint8Array} head début du fichier (cf. headBytesNeeded)
 * @param {Uint8Array|null} tail 128 derniers octets (pour ID3v1), facultatif
 * @param {string} fileName nom du fichier, utilisé en dernier recours
 * @returns {{title: string, artist: string, album: string, year: number|null,
 *            duration: number|null, picture: {mime: string, data: Uint8Array}|null}}
 */
export function parseTags(head, tail, fileName = '') {
  let tags = {};
  try {
    if (isId3(head)) tags = parseId3v2(head);
    else if (startsWith(head, 'fLaC')) tags = parseFlac(head);
    else if (startsWith(head, 'OggS')) tags = parseOgg(head);
  } catch {
    // Fichier corrompu ou tronqué : on garde ce qu'on a pu lire.
  }

  if (tail && (!tags.title || !tags.artist)) fillMissing(tags, parseId3v1(tail));
  fillMissing(tags, parseFileName(fileName));

  return {
    title: tags.title || fileName || 'Sans titre',
    artist: tags.artist || tags.albumArtist || '',
    album: tags.album || '',
    year: tags.year ?? null,
    duration: tags.duration ?? null,
    picture: tags.picture ?? null,
  };
}

/** « 01 - Artiste - Titre.mp3 » → { artist, title }. */
export function parseFileName(fileName) {
  let base = String(fileName)
    .replace(/\.[^./]+$/, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  base = base.replace(/^\d{1,3}\s*[-.)]\s*/, '').replace(/^\d{1,3}\s+(?=\D)/, '');

  const parts = base.split(/\s+-\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { title: base };
}

/** Extrait une année plausible d'une chaîne (« 2019-05-03 » → 2019). */
export function parseYear(value) {
  const match = String(value ?? '').match(/\b(1[89]\d{2}|2\d{3})\b/);
  return match ? Number(match[1]) : null;
}

/* ------------------------------------------------------------------ */
/*  Outils binaires                                                    */
/* ------------------------------------------------------------------ */

function startsWith(bytes, ascii, offset = 0) {
  if (bytes.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

function indexOfAscii(bytes, ascii, from = 0) {
  outer: for (let i = from; i <= bytes.length - ascii.length; i++) {
    for (let j = 0; j < ascii.length; j++) {
      if (bytes[i + j] !== ascii.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

const uint32BE = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const synchsafe = (b, o) =>
  ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

function fillMissing(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== null && value !== '' && !target[key]) target[key] = value;
  }
}

function cleanValues(text) {
  return text
    .split('\u0000')
    .map((v) => v.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/*  ID3v2                                                              */
/* ------------------------------------------------------------------ */

const isId3 = (b) => startsWith(b, 'ID3') && b.length >= 10;

/** Taille totale du tag ID3v2 (en-tête + footer éventuel compris). */
function id3TotalSize(b) {
  return 10 + synchsafe(b, 6) + (b[5] & 0x10 ? 10 : 0);
}

/** Décode un texte ID3 selon son octet d'encodage (0: latin1, 1: UTF-16 BOM, 2: UTF-16BE, 3: UTF-8). */
function decodeId3Text(bytes, encoding) {
  switch (encoding) {
    case 1: {
      const bigEndian = bytes[0] === 0xfe && bytes[1] === 0xff;
      return new TextDecoder(bigEndian ? 'utf-16be' : 'utf-16le').decode(bytes);
    }
    case 2:
      return new TextDecoder('utf-16be').decode(bytes);
    case 3:
      return utf8.decode(bytes);
    default:
      return latin1.decode(bytes);
  }
}

/** Position du caractère nul terminant une chaîne (1 octet ou 2 octets alignés en UTF-16). */
function findTerminator(bytes, start, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let i = start; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return { end: i, size: 2 };
    }
    return { end: bytes.length, size: 0 };
  }
  const i = bytes.indexOf(0, start);
  return i === -1 ? { end: bytes.length, size: 0 } : { end: i, size: 1 };
}

/** Annule la « désynchronisation » ID3 (0xFF 0x00 → 0xFF). */
function removeUnsync(bytes) {
  const out = new Uint8Array(bytes.length);
  let j = 0;
  for (let i = 0; i < bytes.length; i++) {
    out[j++] = bytes[i];
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

// Les identifiants ID3v2.2 font 3 caractères : on les ramène à ceux de la v2.3+.
const V22_IDS = { TT2: 'TIT2', TP1: 'TPE1', TP2: 'TPE2', TAL: 'TALB', TYE: 'TYER', TOR: 'TORY', PIC: 'APIC' };

function parseId3v2(bytes) {
  const version = bytes[3];
  const flags = bytes[5];
  let body = bytes.subarray(10, Math.min(bytes.length, 10 + synchsafe(bytes, 6)));
  if (version < 4 && flags & 0x80) body = removeUnsync(body);

  let offset = 0;
  if (flags & 0x40 && version >= 3) {
    offset = version === 4 ? synchsafe(body, 0) : uint32BE(body, 0) + 4;
  }

  const idLength = version === 2 ? 3 : 4;
  const headerLength = version === 2 ? 6 : 10;
  const tags = {};

  while (offset + headerLength <= body.length) {
    const rawId = String.fromCharCode(...body.subarray(offset, offset + idLength));
    if (!/^[A-Z0-9]+$/.test(rawId)) break; // on a atteint le padding

    let size;
    if (version === 2) size = (body[offset + 3] << 16) | (body[offset + 4] << 8) | body[offset + 5];
    else if (version === 4) size = synchsafe(body, offset + 4);
    else size = uint32BE(body, offset + 4);

    const formatFlags = version >= 3 ? body[offset + 9] : 0;
    let data = body.subarray(offset + headerLength, offset + headerLength + size);
    offset += headerLength + size;

    if (version === 4) {
      if (formatFlags & 0x4c) continue; // groupé / compressé / chiffré : ignoré
      if (formatFlags & 0x01) data = data.subarray(4); // indicateur de longueur
      if (formatFlags & 0x02 || flags & 0x80) data = removeUnsync(data);
    } else if (version === 3 && formatFlags & 0xe0) {
      continue;
    }

    handleId3Frame(V22_IDS[rawId] ?? rawId, data, tags, version);
  }
  return tags;
}

function handleId3Frame(id, data, tags, version) {
  if (data.length < 2) return;

  if (id === 'APIC') {
    const picture = version === 2 ? parsePic22(data) : parseApic(data);
    // On privilégie la pochette « couverture avant » (type 3).
    if (picture && (!tags.picture || picture.type === 3)) tags.picture = picture;
    return;
  }

  if (!id.startsWith('T') || id === 'TXXX') return;
  const values = cleanValues(decodeId3Text(data.subarray(1), data[0]));
  if (values.length === 0) return;

  switch (id) {
    case 'TIT2':
      tags.title ??= values[0];
      break;
    case 'TPE1':
      tags.artist ??= values.join(', ');
      break;
    case 'TPE2':
      tags.albumArtist ??= values[0];
      break;
    case 'TALB':
      tags.album ??= values[0];
      break;
    case 'TYER':
    case 'TDRC':
    case 'TDOR':
    case 'TORY':
      tags.year ??= parseYear(values[0]);
      break;
    case 'TLEN': {
      const ms = Number(values[0]);
      if (ms > 0) tags.duration ??= ms / 1000;
      break;
    }
  }
}

function parseApic(data) {
  const encoding = data[0];
  const mimeEnd = data.indexOf(0, 1);
  if (mimeEnd === -1) return null;
  let mime = latin1.decode(data.subarray(1, mimeEnd)).toLowerCase();
  if (!mime.includes('/')) mime = `image/${mime || 'jpeg'}`;
  const type = data[mimeEnd + 1];
  const { end, size } = findTerminator(data, mimeEnd + 2, encoding);
  return { mime, type, data: data.subarray(end + size) };
}

function parsePic22(data) {
  const encoding = data[0];
  const format = latin1.decode(data.subarray(1, 4)).toLowerCase();
  const type = data[4];
  const { end, size } = findTerminator(data, 5, encoding);
  return { mime: format === 'png' ? 'image/png' : 'image/jpeg', type, data: data.subarray(end + size) };
}

/* ------------------------------------------------------------------ */
/*  ID3v1 (128 derniers octets)                                        */
/* ------------------------------------------------------------------ */

function parseId3v1(tail) {
  if (!tail || tail.length < 128) return {};
  const b = tail.subarray(tail.length - 128);
  if (!startsWith(b, 'TAG')) return {};
  const field = (from, to) => latin1.decode(b.subarray(from, to)).replace(/\u0000.*$/s, '').trim();
  return {
    title: field(3, 33),
    artist: field(33, 63),
    album: field(63, 93),
    year: parseYear(field(93, 97)),
  };
}

/* ------------------------------------------------------------------ */
/*  FLAC / Vorbis comments                                             */
/* ------------------------------------------------------------------ */

function parseFlac(bytes) {
  const tags = {};
  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const isLast = header & 0x80;
    const type = header & 0x7f;
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const block = bytes.subarray(offset + 4, offset + 4 + length);
    if (block.length < length) break; // bloc tronqué (lecture partielle)

    if (type === 0) tags.duration = flacDuration(block);
    else if (type === 4) {
      const { picture, ...comment } = parseVorbisComment(block);
      Object.assign(tags, comment);
      tags.picture ??= picture;
    } else if (type === 6) {
      const picture = parseFlacPicture(block);
      if (picture && (!tags.picture || picture.type === 3)) tags.picture = picture;
    }

    offset += 4 + length;
    if (isLast) break;
  }
  if (!tags.picture) delete tags.picture;
  return tags;
}

/** Durée = nombre total d'échantillons / fréquence d'échantillonnage (bloc STREAMINFO). */
function flacDuration(b) {
  if (b.length < 18) return null;
  const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
  const totalSamples = (b[13] & 0x0f) * 2 ** 32 + uint32BE(b, 14);
  return sampleRate > 0 && totalSamples > 0 ? totalSamples / sampleRate : null;
}

function parseFlacPicture(b) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const type = view.getUint32(0);
  const mimeLength = view.getUint32(4);
  const mime = latin1.decode(b.subarray(8, 8 + mimeLength));
  let o = 8 + mimeLength;
  const descriptionLength = view.getUint32(o);
  o += 4 + descriptionLength + 16; // description + largeur/hauteur/profondeur/couleurs
  const dataLength = view.getUint32(o);
  const data = b.subarray(o + 4, o + 4 + dataLength);
  return data.length === dataLength ? { mime: mime || 'image/jpeg', type, data } : null;
}

/** Commentaires Vorbis (FLAC et OGG). Entiers en little-endian. */
function parseVorbisComment(b) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tags = {};
  const artists = [];
  let o = 4 + view.getUint32(0, true); // on saute le « vendor »
  const count = view.getUint32(o, true);
  o += 4;

  for (let i = 0; i < count && o + 4 <= b.length; i++) {
    const length = view.getUint32(o, true);
    o += 4;
    if (o + length > b.length) break;
    const entry = utf8.decode(b.subarray(o, o + length));
    o += length;

    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).toUpperCase();
    const value = entry.slice(eq + 1).trim();
    if (!value) continue;

    switch (key) {
      case 'TITLE':
        tags.title ??= value;
        break;
      case 'ARTIST':
        artists.push(value);
        break;
      case 'ALBUMARTIST':
        tags.albumArtist ??= value;
        break;
      case 'ALBUM':
        tags.album ??= value;
        break;
      case 'DATE':
      case 'YEAR':
        tags.year ??= parseYear(value);
        break;
      case 'METADATA_BLOCK_PICTURE':
        try {
          tags.picture ??= parseFlacPicture(base64ToBytes(value));
        } catch {
          /* pochette illisible */
        }
        break;
    }
  }
  if (artists.length) tags.artist = artists.join(', ');
  return tags;
}

function parseOgg(bytes) {
  // Le paquet de commentaires suit l'en-tête « \x03vorbis » (Vorbis) ou « OpusTags » (Opus).
  let start = indexOfAscii(bytes, 'OpusTags');
  if (start !== -1) start += 8;
  else {
    start = indexOfAscii(bytes, '\u0003vorbis');
    if (start !== -1) start += 7;
  }
  return start === -1 ? {} : parseVorbisComment(bytes.subarray(start));
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
