/**
 * Serveur Spotifake :
 *  - sert les fichiers statiques de l'application (dossier /public),
 *  - expose le hub de signalisation WebSocket sur /signal.
 *
 * Usage : `npm start` puis ouvrir http://localhost:3000
 * Variables d'environnement : PORT (défaut 3000), HOST (défaut 0.0.0.0).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { SignalingHub } from './hub.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // normalize() supprime les « .. » : impossible de sortir de /public.
    const filePath = join(PUBLIC_DIR, normalize(pathname));
    if (!filePath.startsWith(PUBLIC_DIR.replace(/[\\/]$/, '') + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

const hub = new SignalingHub();
const wss = new WebSocketServer({ server, path: '/signal', maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  const send = (message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };
  const { onMessage, onClose } = hub.connect(send);

  ws.on('message', (raw) => {
    try {
      onMessage(JSON.parse(raw.toString()));
    } catch {
      // JSON invalide : ignoré.
    }
  });
  ws.on('close', onClose);
});

// Détection des connexions mortes (onglet fermé brutalement, Wi-Fi coupé…).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  const lanAddresses = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  console.log('\n  Spotifake est lancé 🎧\n');
  console.log(`  Application     http://localhost:${PORT}`);
  for (const ip of lanAddresses) {
    console.log(`  Signalisation   ws://${ip}:${PORT}/signal   (à partager avec les autres)`);
  }
  console.log('');
});
