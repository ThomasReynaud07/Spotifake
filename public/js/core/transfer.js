/**
 * Protocole d'échange entre deux pairs, au-dessus des DataChannels WebRTC.
 *
 * Canal « control » (messages JSON) :
 *   { t: 'catalog', v, index, last, tracks }  catalogue envoyé par tranches (limite de taille des messages)
 *   { t: 'get-covers', ids }                  demande de pochettes
 *   { t: 'cover', id, data }                  pochette en data-URL
 *   { t: 'get-file', id, req }                demande d'un son
 *   { t: 'file-error', req, message }
 *
 * Un fichier est envoyé sur un canal dédié « file:<req> » ouvert par l'émetteur :
 *   1er message : JSON { name, size, type }
 *   puis        : morceaux binaires (ArrayBuffer)
 *   dernier     : la chaîne 'end'
 */

export const CHUNK_SIZE = 64 * 1024;
export const CATALOG_SLICE = 400;

/** Découpe un catalogue en messages de taille raisonnable. */
export function catalogMessages(tracks, version) {
  const messages = [];
  for (let index = 0; index === 0 || index * CATALOG_SLICE < tracks.length; index++) {
    const slice = tracks.slice(index * CATALOG_SLICE, (index + 1) * CATALOG_SLICE);
    messages.push({ t: 'catalog', v: version, index, last: (index + 1) * CATALOG_SLICE >= tracks.length, tracks: slice });
  }
  return messages;
}

/** Réassemble un catalogue reçu par tranches. Retourne le catalogue complet ou null. */
export class CatalogAssembler {
  #buffer = [];
  #version = null;

  push(message) {
    if (message.index === 0) {
      this.#buffer = [];
      this.#version = message.v;
    }
    if (message.v !== this.#version) return null; // tranche d'une ancienne version
    this.#buffer.push(...(Array.isArray(message.tracks) ? message.tracks : []));
    return message.last ? this.#buffer.map(sanitizeRemoteTrack) : null;
  }
}

/** On ne fait pas confiance aux données d'un pair : types vérifiés, textes bornés. */
export function sanitizeRemoteTrack(raw) {
  const text = (value, max = 200) => String(value ?? '').slice(0, max);
  const number = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
  return {
    id: text(raw?.id, 64),
    title: text(raw?.title) || 'Sans titre',
    artist: text(raw?.artist),
    album: text(raw?.album),
    year: number(raw?.year),
    duration: number(raw?.duration),
    size: number(raw?.size) ?? 0,
    type: text(raw?.type, 64),
    fileName: safeFileName(raw?.fileName),
    hasCover: raw?.hasCover === true,
    fingerprint: text(raw?.fingerprint, 500),
  };
}

/** Empêche un pair malveillant d'imposer un chemin (« ../../ ») ou un nom invalide. */
export function safeFileName(name) {
  const cleaned = String(name ?? '')
    .replace(/[/\\?%*:|"<>\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 150);
  return cleaned || 'son-importe';
}

/** Attend que le tampon d'envoi d'un DataChannel se vide (contrôle de flux). */
export function waitForBufferLow(channel) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      channel.removeEventListener('bufferedamountlow', onLow);
      channel.removeEventListener('close', onClose);
    };
    const onLow = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Canal fermé pendant le transfert'));
    };
    channel.addEventListener('bufferedamountlow', onLow);
    channel.addEventListener('close', onClose);
  });
}
