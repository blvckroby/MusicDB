// server.js — MusicDB API v4.0
// Certificazioni FIMI, foto/info via MusicBrainz+Fanart, tracce robuste

try { require('dotenv').config(); } catch (e) {}

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const NodeCache = require("node-cache");
const fetch = global.fetch || require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";
const FANART_API_KEY = process.env.FANART_API_KEY || "5c6b04c68e904cfed1e6cbc1eb9bcd42"; // demo key pubblica

// ============================================================
// CERTIFICAZIONI FIMI (collectionId → { level, unit, count })
// Popola con dati reali. level: 'oro'|'platino'|'diamante'|'multiplatino'
// unit: 'album'|'singolo'
// ============================================================
const fimiCertifications = {
  // Esempi dimostrativi — sostituisci con dati reali
  // "1440857789": { level: "platino", count: 2, unit: "album" },
  // "1234567890": { level: "oro", count: 1, unit: "singolo" },
};

// ============================================================
// IN-MEMORY STORE
// ============================================================
const trackRatings = new Map(); // trackId → { sum, count }
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors({ origin: process.env.CORS_ORIGIN || "*", credentials: true }));
app.use(express.json());
app.use(express.static('public'));
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, max: 300,
  message: { error: "Troppe richieste, riprova più tardi" },
  standardHeaders: true, legacyHeaders: false,
}));
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ============================================================
// UTILS
// ============================================================
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const getCached = key => cache.get(key);
const setCache = (key, val, ttl) => ttl ? cache.set(key, val, ttl) : cache.set(key, val);

async function fetchJson(url, options = {}, timeout = 12000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(id);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) { clearTimeout(id); throw e; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// SPOTIFY AUTH
// ============================================================
let spotifyToken = null, tokenExpiry = 0;
async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return null;
  try {
    const data = await fetchJson("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")
      },
      body: "grant_type=client_credentials"
    });
    spotifyToken = data.access_token;
    tokenExpiry = Date.now() + data.expires_in * 1000 - 60000;
    return spotifyToken;
  } catch { return null; }
}

// ============================================================
// MUSICBRAINZ — artista: info + MBID
// ============================================================
async function mbSearchArtist(name) {
  const url = `https://musicbrainz.org/ws/2/artist/?query=artist:${encodeURIComponent(name)}&limit=1&fmt=json`;
  const data = await fetchJson(url, { headers: { "User-Agent": "MusicDB/4.0 (musicdb@example.com)" } });
  const a = data.artists?.[0];
  if (!a) return null;
  return {
    mbid: a.id,
    name: a.name,
    disambiguation: a.disambiguation || null,
    country: a.country || null,
    area: a.area?.name || null,
    type: a.type || null,
    lifeSpan: a["life-span"] || null,
    genres: (a.genres || a.tags || []).slice(0, 3).map(g => g.name || g.name).filter(Boolean),
  };
}

// ============================================================
// FANART.TV — foto artista tramite MBID
// ============================================================
async function fanartPhoto(mbid) {
  if (!mbid) return null;
  try {
    const data = await fetchJson(
      `https://webservice.fanart.tv/v3/music/${mbid}?api_key=${FANART_API_KEY}`,
      {}, 8000
    );
    return data.artistthumb?.[0]?.url
      || data.artistbackground?.[0]?.url
      || data.hdmusiclogo?.[0]?.url
      || null;
  } catch { return null; }
}

// ============================================================
// SPOTIFY — foto artista
// ============================================================
async function spotifyPhoto(name) {
  const token = await getSpotifyToken();
  if (!token) return null;
  try {
    const data = await fetchJson(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(name)}&type=artist&limit=1`,
      { headers: { Authorization: "Bearer " + token } }
    );
    const imgs = data.artists?.items?.[0]?.images;
    return imgs?.[0]?.url || null;
  } catch { return null; }
}

// ============================================================
// ITUNES — foto artista (artwork album come fallback)
// ============================================================
async function itunesArtistPhoto(artistId) {
  try {
    const data = await fetchJson(
      `https://itunes.apple.com/lookup?id=${artistId}&entity=album&limit=1`
    );
    const album = data.results?.find(r => r.wrapperType === 'collection');
    return album?.artworkUrl100?.replace('100x100', '600x600') || null;
  } catch { return null; }
}

// ============================================================
// ROUTES — ARTISTI
// ============================================================
app.get('/api/search/artist', asyncHandler(async (req, res) => {
  const query = req.query.q?.trim();
  if (!query) return res.status(400).json({ error: "Parametro 'q' mancante" });

  const ck = `search:${query.toLowerCase()}`;
  const cached = getCached(ck);
  if (cached) return res.json(cached);

  const data = await fetchJson(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=musicArtist&limit=10`
  );
  const artists = (data.results || []).map(a => ({
    id: a.artistId,
    name: a.artistName,
    genre: a.primaryGenreName,
    link: a.artistLinkUrl
  }));

  setCache(ck, artists);
  res.json(artists);
}));

// Endpoint unificato: foto + info artista
app.get('/api/artist/:id/profile', asyncHandler(async (req, res) => {
  const artistId = req.params.id;
  const artistName = req.query.name || '';
  const ck = `profile:${artistId}`;
  const cached = getCached(ck);
  if (cached) return res.json(cached);

  let photo = null, mbInfo = null, genres = [], description = null;

  // 1. MusicBrainz per info strutturate
  if (artistName) {
    try {
      mbInfo = await mbSearchArtist(artistName);
      if (mbInfo) {
        genres = mbInfo.genres || [];
        // Costruisci descrizione strutturata da dati MB
        const parts = [];
        if (mbInfo.type) parts.push(mbInfo.type);
        if (mbInfo.area) parts.push(`originario di ${mbInfo.area}`);
        if (mbInfo.country) parts.push(`(${mbInfo.country})`);
        if (mbInfo.lifeSpan?.begin) {
          parts.push(`attivo dal ${mbInfo.lifeSpan.begin.slice(0,4)}`);
          if (mbInfo.lifeSpan.ended && mbInfo.lifeSpan.end) {
            parts.push(`al ${mbInfo.lifeSpan.end.slice(0,4)}`);
          }
        }
        if (mbInfo.disambiguation) parts.push(`· ${mbInfo.disambiguation}`);
        description = parts.length > 0 ? parts.join(' ') : null;
      }
    } catch (e) { console.warn('MusicBrainz info failed:', e.message); }
  }

  // 2. Foto: Spotify → Fanart.tv (via MBID) → iTunes artwork
  if (SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) {
    photo = await spotifyPhoto(artistName);
  }
  if (!photo && mbInfo?.mbid) {
    photo = await fanartPhoto(mbInfo.mbid);
  }
  if (!photo) {
    photo = await itunesArtistPhoto(artistId);
  }

  const result = { photo, description, genres, mbid: mbInfo?.mbid || null, mbInfo };
  setCache(ck, result, 3600);
  res.json(result);
}));

// ============================================================
// ROUTES — RELEASE
// ============================================================
app.get('/api/artist/:id/releases', asyncHandler(async (req, res) => {
  const artistId = req.params.id;
  if (!artistId || isNaN(artistId)) return res.status(400).json({ error: "ID non valido" });

  const ck = `releases:${artistId}`;
  const cached = getCached(ck);
  if (cached) return res.json(cached);

  const data = await fetchJson(
    `https://itunes.apple.com/lookup?id=${artistId}&entity=album&limit=500`
  );

  const releases = (data.results || [])
    .filter(r => r.wrapperType === 'collection' || (r.collectionType && /album|compilation/i.test(r.collectionType)))
    .map(r => {
      const title = r.collectionName || 'Untitled';
      const trackCount = r.trackCount || 1;
      let type = "album";
      if (trackCount === 1) type = "single";
      else if (/\bep\b/i.test(title) || (trackCount >= 2 && trackCount <= 6)) type = "ep";

      const cert = fimiCertifications[String(r.collectionId)] || null;

      return {
        id: r.collectionId,
        title,
        year: r.releaseDate?.slice(0, 4) || null,
        cover: (r.artworkUrl100 || '').replace(/\d+x\d+bb/, '600x600bb').replace(/\d+x\d+/, '600x600'),
        trackCount,
        type,
        genre: r.primaryGenreName || null,
        certification: cert
      };
    })
    .sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));

  setCache(ck, releases);
  res.json(releases);
}));

// ============================================================
// ROUTES — TRACCE (multi-strategia robusta)
// ============================================================
function mapItunesTrack(t) {
  return {
    id: t.trackId,
    title: t.trackName || 'Untitled',
    position: t.trackNumber || 0,
    discNumber: t.discNumber || 1,
    duration: t.trackTimeMillis || 0,
    preview: t.previewUrl || null,
    cover: (t.artworkUrl100 || '').replace(/\d+x\d+bb/, '600x600bb').replace(/\d+x\d+/, '600x600'),
    explicit: t.trackExplicitness === "explicit",
    certification: fimiCertifications[String(t.trackId)] || null
  };
}

function sortTracks(tracks) {
  return tracks.sort((a, b) => (a.discNumber - b.discNumber) || (a.position - b.position));
}

function deduplicateTracks(tracks) {
  const seen = new Set();
  return tracks.filter(t => {
    const key = `${t.position}-${t.title.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

app.get('/api/album/:id/tracks', asyncHandler(async (req, res) => {
  const albumId = req.params.id;
  if (!albumId || isNaN(albumId)) return res.status(400).json({ error: "ID non valido" });

  const ck = `tracks:${albumId}`;
  const cached = getCached(ck);
  if (cached) return res.json(cached);

  let tracks = [], note = null;
  let artistName = null, collectionName = null, artistId = null;

  // ── Strategia 1: Lookup diretto ──
  try {
    const data = await fetchJson(
      `https://itunes.apple.com/lookup?id=${albumId}&entity=song&limit=500`
    );
    const results = data.results || [];
    const col = results.find(r => r.collectionId == albumId && r.wrapperType === 'collection');
    const firstTrack = results.find(r => r.wrapperType === 'track');
    artistName = col?.artistName || firstTrack?.artistName || null;
    collectionName = col?.collectionName || firstTrack?.collectionName || null;
    artistId = col?.artistId || firstTrack?.artistId || null;

    tracks = sortTracks(
      results.filter(r => r.wrapperType === 'track' && (r.kind === 'song' || r.kind === 'music-video'))
             .map(mapItunesTrack)
    );
    console.log(`[Strategy 1] Album ${albumId}: ${tracks.length} tracce`);
  } catch (e) { console.warn('[Strategy 1] failed:', e.message); }

  // ── Strategia 2: Lookup senza entity (a volte iTunes restituisce più dati) ──
  if (tracks.length === 0 && collectionName && artistName) {
    try {
      await sleep(300); // rate limit gentile
      const data = await fetchJson(
        `https://itunes.apple.com/lookup?id=${albumId}&entity=song&country=it&limit=500`
      );
      tracks = sortTracks(
        (data.results || [])
          .filter(r => r.wrapperType === 'track')
          .map(mapItunesTrack)
      );
      if (tracks.length > 0) note = 'Tracce caricate con parametri regionali (IT)';
      console.log(`[Strategy 2] Album ${albumId}: ${tracks.length} tracce`);
    } catch (e) { console.warn('[Strategy 2] failed:', e.message); }
  }

  // ── Strategia 3: Search per collectionId nel termine ──
  if (tracks.length === 0 && collectionName && artistName) {
    try {
      await sleep(300);
      const term = `${artistName} ${collectionName}`;
      const data = await fetchJson(
        `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=200`
      );
      const candidates = (data.results || []).filter(r =>
        r.collectionId == albumId ||
        (r.collectionName?.toLowerCase() === collectionName.toLowerCase() &&
         r.artistName?.toLowerCase() === artistName.toLowerCase())
      );
      if (candidates.length > 0) {
        tracks = sortTracks(candidates.map(mapItunesTrack));
        note = 'Tracce caricate tramite ricerca artista+album';
      }
      console.log(`[Strategy 3] Album ${albumId}: ${tracks.length} tracce`);
    } catch (e) { console.warn('[Strategy 3] failed:', e.message); }
  }

  // ── Strategia 4: Ricerca solo per titolo album ──
  if (tracks.length === 0 && collectionName) {
    try {
      await sleep(300);
      const data = await fetchJson(
        `https://itunes.apple.com/search?term=${encodeURIComponent(collectionName)}&entity=song&limit=200`
      );
      const candidates = (data.results || []).filter(r =>
        artistName ? r.artistName?.toLowerCase().includes(artistName.toLowerCase().split(' ')[0]) : true
      );
      if (candidates.length > 0) {
        tracks = sortTracks(candidates.map(mapItunesTrack));
        note = 'Tracce caricate tramite ricerca per titolo (approssimata)';
      }
      console.log(`[Strategy 4] Album ${albumId}: ${tracks.length} tracce`);
    } catch (e) { console.warn('[Strategy 4] failed:', e.message); }
  }

  // ── Strategia 5: MusicBrainz tracklist (fallback finale) ──
  if (tracks.length === 0 && collectionName && artistName) {
    try {
      await sleep(500);
      const mbSearch = await fetchJson(
        `https://musicbrainz.org/ws/2/release/?query=release:${encodeURIComponent(collectionName)}+artist:${encodeURIComponent(artistName)}&limit=5&fmt=json`,
        { headers: { "User-Agent": "MusicDB/4.0 (musicdb@example.com)" } }
      );
      const release = mbSearch.releases?.[0];
      if (release?.id) {
        await sleep(1000); // MB rate limit: 1 req/sec
        const mbRelease = await fetchJson(
          `https://musicbrainz.org/ws/2/release/${release.id}?inc=recordings&fmt=json`,
          { headers: { "User-Agent": "MusicDB/4.0 (musicdb@example.com)" } }
        );
        const mbTracks = [];
        (mbRelease.media || []).forEach(medium => {
          (medium.tracks || []).forEach((t, i) => {
            mbTracks.push({
              id: t.id,
              title: t.title,
              position: t.position || (i + 1),
              discNumber: medium.position || 1,
              duration: t.length || 0,
              preview: null,
              cover: '',
              explicit: false,
              certification: null
            });
          });
        });
        if (mbTracks.length > 0) {
          tracks = sortTracks(mbTracks);
          note = 'Tracklist da MusicBrainz (nessuna preview disponibile)';
        }
      }
      console.log(`[Strategy 5/MB] Album ${albumId}: ${tracks.length} tracce`);
    } catch (e) { console.warn('[Strategy 5/MB] failed:', e.message); }
  }

  tracks = deduplicateTracks(tracks);

  if (tracks.length === 0) {
    note = 'Nessuna traccia trovata. Questo album potrebbe avere restrizioni geografiche su iTunes.';
  }

  const result = { tracks, note: note || null };
  setCache(ck, result);
  res.json(result);
}));

// ============================================================
// CERTIFICAZIONI — endpoint dedicato per ricerca manuale
// ============================================================
app.get('/api/certifications', (req, res) => {
  res.json(fimiCertifications);
});

// ============================================================
// RATINGS — community
// ============================================================
app.post('/api/track/:id/rating', asyncHandler(async (req, res) => {
  const trackId = String(req.params.id);
  const value = Number(req.body?.rating);
  if (!trackId || isNaN(value) || value < 1 || value > 10) {
    return res.status(400).json({ error: 'Rating deve essere 1-10' });
  }
  const r = trackRatings.get(trackId) || { sum: 0, count: 0 };
  r.sum += value; r.count += 1;
  trackRatings.set(trackId, r);
  const avg = r.sum / r.count;
  res.json({ ok: true, trackId, rating: value, community: { average: Math.round(avg * 10) / 10, count: r.count } });
}));

app.get('/api/track/:id/rating', (req, res) => {
  const r = trackRatings.get(String(req.params.id));
  if (!r || r.count === 0) return res.json({ average: null, count: 0 });
  res.json({ average: Math.round((r.sum / r.count) * 10) / 10, count: r.count });
});

app.get('/api/tracks/ratings', (req, res) => {
  const ids = (req.query.ids || '').split(',').filter(Boolean);
  const result = {};
  for (const id of ids) {
    const r = trackRatings.get(id);
    result[id] = r && r.count > 0
      ? { average: Math.round((r.sum / r.count) * 10) / 10, count: r.count }
      : { average: null, count: 0 };
  }
  res.json(result);
});

// ============================================================
// HEALTH
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cache: { keys: cache.keys().length }, ratings: trackRatings.size });
});

app.get('/api/cache/clear', (req, res) => { cache.flushAll(); res.json({ ok: true }); });

// ============================================================
// ERROR HANDLING
// ============================================================
app.use((req, res) => res.status(404).json({ error: "Endpoint non trovato" }));
app.use((err, req, res, next) => {
  console.error('❌', err.message);
  res.status(err.statusCode || 500).json({ error: err.message || 'Errore interno' });
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║    🎵  MusicDB API Server v4.0  🎵      ║
╠══════════════════════════════════════════╣
║  http://localhost:${PORT}                   ║
║  Spotify : ${SPOTIFY_CLIENT_ID ? '✓' : '✗ (usa Fanart+iTunes)'}                     ║
║  Fanart  : ✓ (chiave pubblica demo)      ║
╚══════════════════════════════════════════╝`);
});

process.on('SIGTERM', () => { cache.flushAll(); process.exit(0); });
