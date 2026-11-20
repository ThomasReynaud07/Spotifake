/**
 * Hub de signalisation.
 *
 * Le serveur ne voit JAMAIS passer de musique : il sert uniquement à
 *  1. annoncer qui est en ligne (découverte des médiathèques),
 *  2. relayer les messages WebRTC (offre / réponse / candidats ICE)
 *     nécessaires pour que deux navigateurs ouvrent une connexion directe.
 *
 * Cette logique est indépendante de la librairie WebSocket pour pouvoir
 * être testée unitairement : chaque client est représenté par une fonction
 * `send(message)`.
 */

const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 40;

/** Nettoie les infos publiques d'un pair (jamais de confiance envers le client). */
export function sanitizePeerInfo(raw = {}) {
  const name = String(raw.name ?? '').trim().slice(0, MAX_NAME_LENGTH) || 'Anonyme';
  const trackCount = Number.isFinite(raw.trackCount) ? Math.max(0, Math.floor(raw.trackCount)) : 0;
  return { name, trackCount };
}

function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

export class SignalingHub {
  /** @type {Map<string, { id: string, name: string, trackCount: number, send: (msg: object) => void }>} */
  peers = new Map();

  /**
   * Enregistre une nouvelle connexion. Retourne les callbacks à brancher
   * sur les événements « message » et « close » du transport.
   */
  connect(send) {
    let peerId = null;

    const onMessage = (msg) => {
      if (!msg || typeof msg !== 'object') return;

      switch (msg.type) {
        case 'join': {
          const id = msg.peer?.id;
          if (peerId || !isValidId(id) || this.peers.has(id)) {
            send({ type: 'error', message: 'Identifiant invalide ou déjà utilisé' });
            return;
          }
          peerId = id;
          const peer = { id, ...sanitizePeerInfo(msg.peer), send };
          send({ type: 'welcome', peers: this.publicList(id) });
          this.broadcast(id, { type: 'peer-joined', peer: publicInfo(peer) });
          this.peers.set(id, peer);
          break;
        }
        case 'update': {
          const peer = peerId && this.peers.get(peerId);
          if (!peer) return;
          Object.assign(peer, sanitizePeerInfo({ ...publicInfo(peer), ...msg.peer }));
          this.broadcast(peerId, { type: 'peer-updated', peer: publicInfo(peer) });
          break;
        }
        case 'signal': {
          const target = peerId && this.peers.get(msg.to);
          if (!target) return;
          target.send({ type: 'signal', from: peerId, data: msg.data });
          break;
        }
        default:
          // Message inconnu : ignoré silencieusement.
          break;
      }
    };

    const onClose = () => {
      if (!peerId) return;
      this.peers.delete(peerId);
      this.broadcast(peerId, { type: 'peer-left', id: peerId });
      peerId = null;
    };

    return { onMessage, onClose };
  }

  publicList(exceptId) {
    return [...this.peers.values()].filter((p) => p.id !== exceptId).map(publicInfo);
  }

  broadcast(exceptId, message) {
    for (const peer of this.peers.values()) {
      if (peer.id !== exceptId) peer.send(message);
    }
  }
}

function publicInfo({ id, name, trackCount }) {
  return { id, name, trackCount };
}
