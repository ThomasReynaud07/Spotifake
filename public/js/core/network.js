/**
 * Réseau pair-à-pair.
 *
 *  ┌────────┐  WebSocket (découverte + signalisation)  ┌─────────┐
 *  │ Pair A │ ───────────────────────────────────────► │ Serveur │
 *  └───┬────┘                                          └─────────┘
 *      │  WebRTC DataChannel (catalogue, pochettes, fichiers) — direct, sans serveur
 *  ┌───▼────┐
 *  │ Pair B │
 *  └────────┘
 *
 * Le nouvel arrivant initie la connexion vers chaque pair déjà présent :
 * il n'y a donc jamais deux offres croisées.
 *
 * Événements émis :
 *  - « status »  : 'offline' | 'connecting' | 'online'
 *  - « peers »   : la liste ou l'état des pairs a changé
 *  - « catalog » (peer) : le catalogue d'un pair a été (re)reçu
 *  - « cover »   (peer, trackId) : une pochette distante est arrivée
 *  - « upload »  ({ peer, track }) : un pair vient de télécharger un de nos sons
 */
import { Emitter } from './emitter.js';
import { CHUNK_SIZE, CatalogAssembler, catalogMessages, waitForBufferLow } from './transfer.js';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const INACTIVITY_TIMEOUT = 30_000;
const MAX_RETRY_DELAY = 15_000;

export class Network extends Emitter {
  /** @type {'offline'|'connecting'|'online'} */
  status = 'offline';
  /** @type {Map<string, RemotePeer>} */
  peers = new Map();
  id = randomId();
  catalogVersion = 0;

  #ws = null;
  #url = '';
  #name = '';
  #enabled = false;
  #retryDelay = 1000;
  #retryTimer = null;
  #catalogTimer = null;

  constructor(library) {
    super();
    this.library = library;
    // Quand la médiathèque change, on prévient les pairs (regroupé pour éviter le spam pendant une analyse).
    library.on('change', () => {
      clearTimeout(this.#catalogTimer);
      this.#catalogTimer = setTimeout(() => this.#broadcastCatalog(), 1200);
    });
  }

  get peerList() {
    return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }

  start(url, name) {
    this.#url = url;
    this.#name = name;
    this.#enabled = true;
    this.#connect();
  }

  stop() {
    this.#enabled = false;
    clearTimeout(this.#retryTimer);
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.#setStatus('offline');
    this.emit('peers');
  }

  setName(name) {
    this.#name = name;
    this.#sendSignaling({ type: 'update', peer: { name } });
  }

  /** Utilisé par RemotePeer pour transmettre offre / réponse / candidats ICE. */
  signal(to, data) {
    this.#sendSignaling({ type: 'signal', to, data });
  }

  /* ---------------------------- Signalisation ----------------------------- */

  #connect() {
    clearTimeout(this.#retryTimer);
    this.#setStatus('connecting');

    let ws;
    try {
      ws = new WebSocket(this.#url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;

    ws.onopen = () => {
      this.#retryDelay = 1000;
      this.#sendSignaling({
        type: 'join',
        peer: { id: this.id, name: this.#name, trackCount: this.library.tracks.size },
      });
    };
    ws.onmessage = ({ data }) => {
      try {
        this.#onSignalingMessage(JSON.parse(data));
      } catch (error) {
        console.warn('Message de signalisation invalide', error);
      }
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return; // fermeture volontaire
      this.#ws = null;
      // Les connexions WebRTC déjà établies continuent de fonctionner sans le serveur.
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect() {
    if (!this.#enabled) return;
    this.#setStatus('connecting');
    this.#retryTimer = setTimeout(() => this.#connect(), this.#retryDelay);
    this.#retryDelay = Math.min(this.#retryDelay * 2, MAX_RETRY_DELAY);
  }

  #sendSignaling(message) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
  }

  #onSignalingMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        this.#setStatus('online');
        for (const info of msg.peers ?? []) this.#addPeer(info, true);
        break;
      case 'peer-joined':
        this.#addPeer(msg.peer, false);
        break;
      case 'peer-updated': {
        const peer = this.peers.get(msg.peer?.id);
        if (peer) {
          peer.name = msg.peer.name;
          if (!peer.catalog) peer.trackCount = msg.peer.trackCount;
          this.emit('peers');
        }
        break;
      }
      case 'peer-left':
        this.peers.get(msg.id)?.close();
        this.peers.delete(msg.id);
        this.emit('peers');
        break;
      case 'signal': {
        let peer = this.peers.get(msg.from);
        // Une nouvelle offre sur un pair connu = il se reconnecte : on repart de zéro.
        if (msg.data?.description?.type === 'offer' && peer?.pc.remoteDescription) {
          peer.close();
          peer = null;
        }
        peer ??= this.#addPeer({ id: msg.from, name: this.peers.get(msg.from)?.name ?? '…' }, false);
        peer.handleSignal(msg.data);
        break;
      }
      case 'error':
        console.warn('Signalisation :', msg.message);
        this.#ws?.close();
        break;
    }
  }

  #addPeer(info, initiator) {
    if (!info?.id || info.id === this.id) return null;
    const existing = this.peers.get(info.id);
    if (existing && existing.state !== 'disconnected') {
      Object.assign(existing, { name: info.name ?? existing.name });
      this.emit('peers');
      return existing;
    }
    existing?.close();

    const peer = new RemotePeer(this, info, initiator);
    this.peers.set(peer.id, peer);
    this.emit('peers');
    return peer;
  }

  /** Appelé quand une connexion directe tombe : on retente si le pair est toujours annoncé. */
  onPeerDisconnected(peer) {
    this.emit('peers');
    if (this.id > peer.id) return; // un seul des deux côtés relance (évite les offres croisées)
    setTimeout(() => {
      if (this.status === 'online' && this.peers.get(peer.id) === peer && peer.state === 'disconnected') {
        this.#addPeer({ id: peer.id, name: peer.name, trackCount: peer.trackCount }, true);
      }
    }, 3000);
  }

  #broadcastCatalog() {
    this.#sendSignaling({ type: 'update', peer: { trackCount: this.library.tracks.size } });
    for (const peer of this.peers.values()) peer.sendCatalog();
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }
}

/* -------------------------------------------------------------------------- */

/** Connexion WebRTC avec un autre pair, et le protocole décrit dans transfer.js. */
export class RemotePeer {
  /** @type {'connecting'|'connected'|'disconnected'} */
  state = 'connecting';
  /** @type {Array|null} catalogue distant (null tant qu'il n'est pas reçu) */
  catalog = null;
  /** @type {Map<string, string>} pochettes reçues (data-URL) */
  covers = new Map();

  #control = null;
  #pendingCandidates = [];
  #transfers = new Map();
  #assembler = new CatalogAssembler();
  #coversRequested = false;

  constructor(network, info, initiator) {
    this.network = network;
    this.id = info.id;
    this.name = info.name || 'Anonyme';
    this.trackCount = info.trackCount ?? 0;

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) network.signal(this.id, { candidate: candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(this.pc.connectionState)) this.#setState('disconnected');
    };
    this.pc.ondatachannel = ({ channel }) => {
      if (channel.label === 'control') this.#setupControl(channel);
      else if (channel.label.startsWith('file:')) this.#receiveFile(channel);
    };

    if (initiator) {
      this.#setupControl(this.pc.createDataChannel('control'));
      this.#sendOffer();
    }
  }

  async #sendOffer() {
    try {
      await this.pc.setLocalDescription();
      this.network.signal(this.id, { description: this.pc.localDescription });
    } catch (error) {
      console.warn('Création de l’offre WebRTC impossible', error);
      this.#setState('disconnected');
    }
  }

  async handleSignal({ description, candidate } = {}) {
    try {
      if (description) {
        await this.pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await this.pc.setLocalDescription();
          this.network.signal(this.id, { description: this.pc.localDescription });
        }
        for (const pending of this.#pendingCandidates.splice(0)) await this.pc.addIceCandidate(pending);
      } else if (candidate) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate);
        else this.#pendingCandidates.push(candidate);
      }
    } catch (error) {
      console.warn(`Signalisation avec ${this.name} échouée`, error);
    }
  }

  close() {
    for (const transfer of this.#transfers.values()) transfer.reject(new Error(`${this.name} s'est déconnecté.`));
    this.pc.close();
    this.state = 'disconnected';
  }

  /* ------------------------------ Contrôle -------------------------------- */

  #setupControl(channel) {
    this.#control = channel;
    channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onopen = () => {
      this.#setState('connected');
      this.sendCatalog();
    };
    channel.onclose = () => this.#setState('disconnected');
    channel.onmessage = ({ data }) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      this.#onControlMessage(message);
    };
  }

  #send(message) {
    if (this.#control?.readyState !== 'open') return false;
    this.#control.send(JSON.stringify(message));
    return true;
  }

  sendCatalog() {
    const version = ++this.network.catalogVersion;
    for (const message of catalogMessages(this.network.library.publicCatalog(), version)) this.#send(message);
  }

  /** Demande toutes les pochettes du catalogue (une seule fois par connexion et par catalogue). */
  requestCovers() {
    if (this.#coversRequested || !this.catalog) return;
    const ids = this.catalog.filter((t) => t.hasCover && !this.covers.has(t.id)).map((t) => t.id);
    if (ids.length && this.#send({ t: 'get-covers', ids })) this.#coversRequested = true;
  }

  #onControlMessage(msg) {
    switch (msg.t) {
      case 'catalog': {
        const catalog = this.#assembler.push(msg);
        if (catalog) {
          this.catalog = catalog;
          this.trackCount = catalog.length;
          this.#coversRequested = false;
          this.network.emit('catalog', this);
          this.network.emit('peers');
        }
        break;
      }
      case 'get-covers':
        this.#sendCovers(msg.ids);
        break;
      case 'cover':
        if (typeof msg.data === 'string' && msg.data.startsWith('data:image/') && msg.data.length < 300_000) {
          this.covers.set(String(msg.id), msg.data);
          this.network.emit('cover', this, String(msg.id));
        }
        break;
      case 'get-file':
        this.#sendFile(String(msg.req), String(msg.id));
        break;
      case 'file-error':
        this.#transfers.get(String(msg.req))?.reject(new Error(String(msg.message)));
        break;
    }
  }

  async #sendCovers(ids) {
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      const track = this.network.library.tracks.get(id);
      if (!track?.cover) continue;
      try {
        if (this.#control.bufferedAmount > 1024 * 1024) await waitForBufferLow(this.#control);
        this.#send({ t: 'cover', id, data: await blobToDataUrl(track.cover) });
      } catch {
        return; // canal fermé
      }
    }
  }

  /* ------------------------------ Fichiers -------------------------------- */

  /**
   * Télécharge un son du pair.
   * @param {string} trackId
   * @param {(received: number, total: number) => void} [onProgress]
   * @returns {Promise<{ blob: Blob, name: string }>}
   */
  requestFile(trackId, onProgress) {
    const req = randomId(8);
    return new Promise((resolve, reject) => {
      let timer;
      const armTimeout = () => {
        clearTimeout(timer);
        timer = setTimeout(() => transfer.reject(new Error(`${this.name} ne répond plus.`)), INACTIVITY_TIMEOUT);
      };
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        this.#transfers.delete(req);
        fn(value);
      };
      const transfer = {
        resolve: settle(resolve),
        reject: settle(reject),
        onProgress: (received, total) => {
          armTimeout();
          onProgress?.(received, total);
        },
      };

      this.#transfers.set(req, transfer);
      if (!this.#send({ t: 'get-file', id: trackId, req })) {
        transfer.reject(new Error(`${this.name} n'est pas connecté.`));
        return;
      }
      armTimeout();
    });
  }

  async #sendFile(req, trackId) {
    let channel = null;
    try {
      const track = this.network.library.tracks.get(trackId);
      if (!track) throw new Error("Ce morceau n'est plus disponible.");
      const file = await this.network.library.getFile(trackId);

      channel = this.pc.createDataChannel(`file:${req}`);
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = CHUNK_SIZE * 8;
      await new Promise((resolve, reject) => {
        channel.onopen = resolve;
        channel.onclose = () => reject(new Error('Canal fermé'));
      });

      channel.send(JSON.stringify({ name: track.fileName, size: file.size, type: track.type }));
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        if (channel.bufferedAmount > CHUNK_SIZE * 16) await waitForBufferLow(channel);
        channel.send(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
      }
      channel.send('end');
      this.network.emit('upload', { peer: this, track });
    } catch (error) {
      this.#send({ t: 'file-error', req, message: error.message });
      channel?.close();
    }
  }

  #receiveFile(channel) {
    const transfer = this.#transfers.get(channel.label.slice('file:'.length));
    if (!transfer) {
      channel.close();
      return;
    }

    channel.binaryType = 'arraybuffer';
    const chunks = [];
    let header = null;
    let received = 0;

    channel.onmessage = ({ data }) => {
      if (typeof data !== 'string') {
        chunks.push(data);
        received += data.byteLength;
        transfer.onProgress(received, header?.size ?? 0);
      } else if (!header) {
        try {
          header = JSON.parse(data);
          transfer.onProgress(0, header.size);
        } catch {
          transfer.reject(new Error('En-tête de transfert invalide.'));
          channel.close();
        }
      } else if (data === 'end') {
        channel.close();
        const blob = new Blob(chunks, { type: header.type || 'application/octet-stream' });
        if (blob.size === header.size) transfer.resolve({ blob, name: header.name });
        else transfer.reject(new Error('Transfert incomplet.'));
      }
    };
    channel.onclose = () => transfer.reject(new Error('Transfert interrompu.'));
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    if (state === 'disconnected') {
      for (const transfer of this.#transfers.values()) transfer.reject(new Error(`${this.name} s'est déconnecté.`));
      this.network.onPeerDisconnected(this);
    } else {
      this.network.emit('peers');
    }
  }
}

/* -------------------------------------------------------------------------- */

function randomId(bytes = 12) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
