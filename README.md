# Spotifake

```
███████╗██████╗  ██████╗ ████████╗██╗███████╗ █████╗ ██╗  ██╗███████╗
██╔════╝██╔══██╗██╔═══██╗╚══██╔══╝██║██╔════╝██╔══██╗██║ ██╔╝██╔════╝
███████╗██████╔╝██║   ██║   ██║   ██║█████╗  ███████║█████╔╝ █████╗
╚════██║██╔═══╝ ██║   ██║   ██║   ██║██╔══╝  ██╔══██║██╔═██╗ ██╔══╝
███████║██║     ╚██████╔╝   ██║   ██║██║     ██║  ██║██║  ██╗███████╗
╚══════╝╚═╝      ╚═════╝    ╚═╝   ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝
```

> **BitRuisseau** — médiathèque audio partagée en pair-à-pair, dans le navigateur.

## Démarrage

```bash
npm install
npm start          # http://localhost:3000
npm test           # tests unitaires (node --test)
```

Navigateur recommandé : **Chrome, Edge ou Opera** (File System Access API : les dossiers sont mémorisés entre deux visites).
Firefox et Safari fonctionnent en mode dégradé : les dossiers doivent être resélectionnés à chaque visite.

> ⚠️ L'application doit être ouverte via `http://localhost` (contexte sécurisé exigé par le navigateur pour l'accès aux dossiers).
> Chaque poste lance donc son propre `npm start`.

### Démo en classe (plusieurs postes)

1. Chaque poste lance `npm start` et ouvre `http://localhost:3000`.
2. Un seul poste sert de **serveur de découverte** : son adresse est affichée au démarrage (`ws://<IP>:3000/signal`).
3. Sur les autres postes : *Emplacements & réglages → Réseau → Serveur de découverte*, coller cette adresse.

## Fonctionnalités

| Cas d'utilisation (CDC) | Où |
| --- | --- |
| Premier démarrage / redémarrages | Écran d'accueil (nom + dossiers), puis bandeau « Autoriser l'accès » si le navigateur le redemande |
| Emplacements des contenus locaux | *Emplacements & réglages* : ajout, retrait, choix du dossier qui reçoit les imports |
| Consultation des contenus locaux | *Ma médiathèque* : Titre, Artiste, Album, Année, Durée, Taille — tri par colonne, recherche |
| Médiathèques disponibles sur le réseau | Barre latérale, section « Sur le réseau » |
| Consulter une médiathèque distante | Clic sur un pair |
| Importer un son distant | Bouton « Importer » (écrit dans `<dossier>/Importés/`) |
| Jouer les contenus | Double-clic / barre de lecture, aléatoire, répétition, touches multimédia |

## Architecture

```
server/
  server.js      serveur HTTP statique + WebSocket /signal
  hub.js         découverte des pairs et relais de signalisation (testé)
public/js/
  core/          logique sans interface
    library.js   emplacements, analyse des fichiers, cache, import
    metadata.js  lecture ID3v1/v2, FLAC, OGG (sans dépendance, testé)
    network.js   connexions WebRTC entre pairs
    transfer.js  protocole d'échange (catalogue, pochettes, fichiers) (testé)
    player.js    file de lecture, aléatoire, répétition
    db.js        IndexedDB (réglages, cache, dossiers mémorisés)
  ui/            interface (vues, composants, tableau, lecteur)
  main.js        démarrage, navigation, actions transverses
test/            tests unitaires
```

**Pair-à-pair** : le serveur ne voit jamais passer de musique. Il sert uniquement à annoncer qui est en ligne
et à relayer l'établissement des connexions WebRTC. Catalogues, pochettes et fichiers transitent
ensuite directement d'un navigateur à l'autre (DataChannels).

### Protocole (DataChannel « control », JSON)

| Message | Sens | Rôle |
| --- | --- | --- |
| `{ t: 'catalog', v, index, last, tracks }` | → | Catalogue envoyé par tranches de 400 titres |
| `{ t: 'get-covers', ids }` / `{ t: 'cover', id, data }` | ↔ | Pochettes (miniatures JPEG) |
| `{ t: 'get-file', id, req }` | → | Demande d'un son ; réponse sur un canal dédié `file:<req>` (en-tête JSON, morceaux binaires de 64 Ko, `end`) |
| `{ t: 'file-error', req, message }` | ← | Échec d'un transfert |
