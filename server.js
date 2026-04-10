// server.js
// MusicDB API - robust handling, FIMI mapping, tracks fallback, ratings endpoint

try {
  require('dotenv').config();
} catch (e) {
  console.warn('dotenv non caricato (opzionale).');
}

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const NodeCache = require("node-cache");
const fetch = global.fetch || require('node-fetch');

const app = express();

// ========================================
// CONFIGURAZIONE
// ========================================
const PORT = process.env.PORT || 3000;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";

// FIMI certifications mapping (populate with real collectionId => certification)
const fimiCertifications = {
  // Example:
  // "1440857789": "Platino",
  // "1440857790": "Oro"
};

// In-memory ratings store (optional, non-persistent)
const trackRatings = new Map();

// Cache globale (TTL: 5 minuti)
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// ========================================
// MIDDLEWARE
// ========================================
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  credentials: true
}));

app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Troppe richieste, riprova più tardi" },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ========================================
// UTILITÀ
// ========================================
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

function getCached(key) {
  return cache.get(key);
}
function setCache(key, value) {
  cache.set(key, value);
}

async function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

// ========================================
// SPOTIFY AUTH
// ========================================
let spotifyToken = null;
let tokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.warn("⚠️ Credenziali Spotify non configurate. Foto profilo non disponibili.");
    return null;
  }

  try {
    const response = await fetchWithTimeout(
      "https://accounts.spotify.com/api/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": "Basic " + Buffer.from(
            SPOTIFY_CLIENT_ID + ":" + SPOTIFY_CLIENT_SECRET
          ).toString("base64")
        },
        body: "grant_type=client_credentials"
      }
    );

    const data = await response.json();
    spotifyToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
    return spotifyToken;
  } catch (error) {
    console.error("❌ Errore ottenimento token Spotify:", error.message);
    return null;
  }
}

// ========================================
// ROUTES - ARTISTI
// ========================================
app.get('/api/search/artist', asyncHandler(async (req, res) => {
  const query = req.query.q?.trim();
  if (!query) return res.status(400).json({ error: "Parametro 'q' mancante o vuoto" });

  const cacheKey = `search:${query.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=musicArtist&limit=10`;
  const response = await fetchWithTimeout(url);
  const data = await response.json();

  const artists = (data.results || []).map(artist => ({
    id: artist.artistId,
    name: artist.artistName,
    genre: artist.primaryGenreName,
    link: artist.artistLinkUrl
  }));

  setCache(cacheKey, artists);
  res.json(artists);
}));

app.get("/api/artist/:name/photo", asyncHandler(async (req, res) => {
  const artistName = req.params.name;
  const cacheKey = `photo:${artistName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  const token = await getSpotifyToken();
  if (!token) return res.json({ image: null });

  const searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(artistName)}&type=artist&limit=1`;
  const response = await fetchWithTimeout(searchUrl, {
    headers: { "Authorization": "Bearer " + token }
  });
  const data = await response.json();

  const result = { image: data.artists?.items?.[0]?.images?.[0]?.url || null };
  setCache(cacheKey, result);
  res.json(result);
}));

app.get('/api/artist/:name/info', asyncHandler(async (req, res) => {
  const artistName = req.params.name;
  const cacheKey = `info:${artistName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  const url = `https://it.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(artistName)}`;
  const response = await fetchWithTimeout(url);
  const data = await response.json();

  const result = {
    name: data.title,
    bio: data.extract || null,
    image: data.thumbnail?.source || null,
    url: data.content_urls?.desktop?.page || null
  };

  setCache(cacheKey, result);
  res.json(result);
}));

// ========================================
// ROUTES - RELEASE & TRACCE
// ========================================
app.get('/api/artist/:id/releases', asyncHandler(async (req, res) => {
  const artistId = req.params.id;
  if (!artistId || isNaN(artistId)) return res.status(400).json({ error: "ID artista non valido" });

  const cacheKey = `releases:${artistId}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  const url = `https://itunes.apple.com/lookup?id=${artistId}&entity=album`;
  const response = await fetchWithTimeout(url);
  const data = await response.json();
  const results = data.results || [];

  const releases = results
    .filter(item => {
      const ct = (item.collectionType || '').toString();
      if (!ct) return !!item.collectionName;
      return /album|compilation/i.test(ct);
    })
    .map(release => {
      const title = release.collectionName || 'Untitled';
      const trackCount = release.trackCount || 1;
      let type = "album";
      if (trackCount === 1) type = "single";
      else if ((title.toLowerCase().includes("ep")) || trackCount <= 6) type = "ep";

      return {
        id: release.collectionId,
        title,
        year: release.releaseDate ? release.releaseDate.slice(0, 4) : null,
        cover: (release.artworkUrl100 || '').replace("100x100", "600x600") || "",
        trackCount,
        type,
        genre: release.primaryGenreName || null,
        fimi: fimiCertifications[release.collectionId] || null
      };
    })
    .sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));

  setCache(cacheKey, releases);
  res.json(releases);
}));

app.get('/api/album/:id/tracks', asyncHandler(async (req, res) => {
  const albumId = req.params.id;
  if (!albumId || isNaN(albumId)) return res.status(400).json({ error: "ID album non valido" });

  const cacheKey = `tracks:${albumId}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  const url = `https://itunes.apple.com/lookup?id=${albumId}&entity=song&limit=200`;
  const response = await fetchWithTimeout(url);
  const data = await response.json();

  let tracks = (data.results || []).filter(item => item.wrapperType === "track")
    .map(track => ({
      id: track.trackId,
      title: track.trackName || 'Untitled',
      position: track.trackNumber || 0,
      duration: track.trackTimeMillis || 0,
      preview: track.previewUrl || null,
      cover: (track.artworkUrl100 || '').replace("100x100", "600x600") || "",
      explicit: track.trackExplicitness === "explicit"
    }))
    .sort((a, b) => a.position - b.position);

  let note = null;
  if (!tracks || tracks.length === 0) {
    const collectionName = (data.results && data.results[0] && data.results[0].collectionName) || null;
    const artistName = (data.results && data.results[0] && data.results[0].artistName) || null;

    if (collectionName && artistName) {
      try {
        const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(collectionName + ' ' + artistName)}&entity=song&limit=200`;
        const searchResp = await fetchWithTimeout(searchUrl);
        const searchData = await searchResp.json();
        tracks = (searchData.results || []).map(track => ({
          id: track.trackId,
          title: track.trackName || 'Untitled',
          position: track.trackNumber || 0,
          duration: track.trackTimeMillis || 0,
          preview: track.previewUrl || null,
          cover: (track.artworkUrl100 || '').replace("100x100", "600x600") || "",
          explicit: track.trackExplicitness === "explicit"
        })).sort((a, b) => a.position - b.position);
        if (tracks.length > 0) note = 'Tracks recovered via fallback search by album+artist';
      } catch (err) {
        console.warn('Fallback search failed:', err.message);
      }
    }
  }

  if (!tracks || tracks.length === 0) {
    note = note || 'Nessuna traccia disponibile pubblicamente su iTunes per questo album (compilation/region/restriction).';
    const result = { tracks: [], note };
    setCache(cacheKey, result);
    return res.json(result);
  }

  const result = { tracks, note: note || null };
  setCache(cacheKey, result);
  res.json(result);
}));

// ========================================
// RATINGS ENDPOINT (optional, in-memory)
// ========================================
app.post('/api/track/:id/rating', asyncHandler(async (req, res) => {
  const trackId = req.params.id;
  const { rating } = req.body;
  if (!trackId || rating == null) return res.status(400).json({ error: 'Invalid' });
  const value = Number(rating);
  if (Number.isNaN(value) || value < 1 || value > 10) return res.status(400).json({ error: 'Rating must be 1-10' });
  trackRatings.set(trackId, { rating: value, updatedAt: Date.now() });
  res.json({ ok: true, trackId, rating: value });
}));

app.get('/api/track/:id/rating', (req, res) => {
  const trackId = req.params.id;
  if (!trackId) return res.status(400).json({ error: 'Invalid' });
  const r = trackRatings.get(trackId) || null;
  res.json({ rating: r ? r.rating : null, updatedAt: r ? r.updatedAt : null });
});

// ========================================
// HEALTH & CACHE
// ========================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    cache: { keys: cache.keys().length, stats: cache.getStats() }
  });
});

app.get('/api/cache/clear', (req, res) => {
  cache.flushAll();
  res.json({ message: 'Cache cleared successfully' });
});

// ========================================
// ERROR HANDLING
// ========================================
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint non trovato", path: req.url });
});

app.use((err, req, res, next) => {
  console.error('❌ Errore server:', err);
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Errore interno del server';
  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ========================================
// START
// ========================================
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║     🎵 MusicDB API Server v2.0 🎵     ║
╠════════════════════════════════════════╣
║  Server: http://localhost:${PORT}       ║
║  Environment: ${process.env.NODE_ENV || 'development'}              ║
║  Spotify: ${SPOTIFY_CLIENT_ID ? '✓ Configurato' : '✗ Non configurato'}      ║
╚════════════════════════════════════════╝
  `);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM ricevuto, chiusura server...');
  cache.flushAll();
  process.exit(0);
});
