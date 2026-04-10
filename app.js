// public/app.js
const CONFIG = {
  API_BASE: "http://localhost:3000/api",
  CACHE_DURATION: 5 * 60 * 1000,
  DEBOUNCE_DELAY: 300,
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000
};

const cache = new Map();

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function getCached(key) {
  const cached = cache.get(key);
  if (!cached) return null;
  const isExpired = Date.now() - cached.timestamp > CONFIG.CACHE_DURATION;
  if (isExpired) { cache.delete(key); return null; }
  return cached.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

async function fetchWithRetry(url, retries = CONFIG.MAX_RETRIES) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
      return fetchWithRetry(url, retries - 1);
    }
    throw error;
  }
}

function showError(message) {
  const errorDiv = document.getElementById("error");
  errorDiv.textContent = message;
  errorDiv.style.display = "block";
  setTimeout(() => { errorDiv.style.display = "none"; }, 5000);
}

function setLoading(isLoading) {
  const loadingDiv = document.getElementById("loading");
  loadingDiv.style.display = isLoading ? "flex" : "none";
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function initTheme() {
  const savedTheme = localStorage.getItem('theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', savedTheme);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
}

async function searchArtist() {
  const searchInput = document.getElementById("search");
  const query = searchInput.value.trim();
  if (!query) { showError("Inserisci il nome di un artista"); return; }

  const artistsDiv = document.getElementById("artists");
  artistsDiv.innerHTML = "";

  const cacheKey = `search:${query}`;
  const cachedData = getCached(cacheKey);
  if (cachedData) { renderArtists(cachedData); return; }

  setLoading(true);

  try {
    const artists = await fetchWithRetry(`${CONFIG.API_BASE}/search/artist?q=${encodeURIComponent(query)}`);
    if (!artists || artists.length === 0) { showError("Nessun artista trovato"); setLoading(false); return; }

    const artistsWithInfo = await Promise.all(
      artists.map(async (artist) => {
        try {
          const [wikiData, spotifyData] = await Promise.all([
            fetchWithRetry(`${CONFIG.API_BASE}/artist/${encodeURIComponent(artist.name)}/info`).catch(() => ({ bio: null, image: null })),
            fetchWithRetry(`${CONFIG.API_BASE}/artist/${encodeURIComponent(artist.name)}/photo`).catch(() => ({ image: null }))
          ]);
          return {
            ...artist,
            bio: wikiData.bio || "Nessuna biografia disponibile",
            photo: spotifyData.image || wikiData.image || "https://via.placeholder.com/140?text=No+Image"
          };
        } catch (error) {
          console.error(`Errore caricamento info per ${artist.name}:`, error);
          return { ...artist, bio: "Nessuna biografia disponibile", photo: "https://via.placeholder.com/140?text=No+Image" };
        }
      })
    );

    setCache(cacheKey, artistsWithInfo);
    renderArtists(artistsWithInfo);

  } catch (error) {
    console.error("Errore ricerca artisti:", error);
    showError("Errore durante la ricerca. Riprova più tardi.");
  } finally {
    setLoading(false);
  }
}

function renderArtists(artists) {
  const artistsDiv = document.getElementById("artists");
  artists.forEach(artist => {
    const card = document.createElement("div");
    card.className = "artist-card";
    card.setAttribute("data-artist-id", artist.id);

    card.innerHTML = `
      <div class="artist-header">
        <img src="${escapeHtml(artist.photo)}" alt="${escapeHtml(artist.name)}" class="artist-photo" loading="lazy" onerror="this.src='https://via.placeholder.com/140?text=No+Image'">
        <div class="artist-info">
          <h2>${escapeHtml(artist.name)}</h2>
          <p class="artist-bio">${escapeHtml(artist.bio)}</p>
        </div>
      </div>
      <div id="releases-${artist.id}" class="artist-releases"></div>
    `;

    card.addEventListener("click", () => loadReleases(artist.id));
    artistsDiv.appendChild(card);
  });
}

async function loadReleases(artistId) {
  const card = document.querySelector(`[data-artist-id="${artistId}"]`);
  if (!card) return;

  if (card.classList.contains("open")) { card.classList.remove("open"); return; }
  document.querySelectorAll(".artist-card.open").forEach(c => c.classList.remove("open"));
  card.classList.add("open");

  const container = document.getElementById(`releases-${artistId}`);
  const cacheKey = `releases:${artistId}`;
  const cachedData = getCached(cacheKey);
  if (cachedData) { renderReleases(container, cachedData); return; }

  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

  try {
    const releases = await fetchWithRetry(`${CONFIG.API_BASE}/artist/${artistId}/releases`);
    if (!releases || releases.length === 0) {
      container.innerHTML = '<p style="text-align:center;color:var(--text-secondary);">Nessuna release disponibile</p>';
      return;
    }
    setCache(cacheKey, releases);
    renderReleases(container, releases);
  } catch (error) {
    console.error("Errore caricamento release:", error);
    container.innerHTML = '<p style="text-align:center;color:#ff3b30;">Errore caricamento release</p>';
  }
}

function renderReleases(container, releases) {
  const albums = releases.filter(r => r.type === "album");
  const eps = releases.filter(r => r.type === "ep");
  const singles = releases.filter(r => r.type === "single");

  function createSection(title, items) {
    if (!items.length) return "";
    return `
      <h3 class="section-title">${escapeHtml(title)}</h3>
      <div class="album-grid">
        ${items.map(release => `
          <div class="album-card" data-album-id="${release.id}">
            <img src="${escapeHtml(release.cover || 'https://via.placeholder.com/600?text=No+Cover')}" alt="${escapeHtml(release.title)}" class="album-cover" loading="lazy" onerror="this.src='https://via.placeholder.com/600?text=No+Cover'">
            <h4>${escapeHtml(release.title)}</h4>
            <p>${escapeHtml(release.year || 'N/A')} ${release.fimi ? ' • ' + escapeHtml(release.fimi) : ''}</p>
          </div>
        `).join("")}
      </div>
    `;
  }

  container.innerHTML = `
    ${createSection("Album", albums)}
    ${createSection("EP", eps)}
    ${createSection("Singoli", singles)}
  `;

  container.querySelectorAll(".album-card").forEach(albumCard => {
    const albumId = albumCard.getAttribute("data-album-id");
    albumCard.addEventListener("click", (e) => {
      e.stopPropagation();
      loadTracks(albumId, albumCard);
    });
  });
}

/* ---------- Modal full-screen for tracks ---------- */
function openTrackModal(contentHtml) {
  let modal = document.getElementById('trackModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'trackModal';
    modal.className = 'track-modal';
    document.body.appendChild(modal);
  }
  modal.innerHTML = contentHtml;
  modal.style.display = 'flex';

  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.classList.contains('modal-close')) {
      closeTrackModal();
    }
  });

  document.addEventListener('keydown', modalEscHandler);
}

function modalEscHandler(e) {
  if (e.key === 'Escape') closeTrackModal();
}

function closeTrackModal() {
  const modal = document.getElementById('trackModal');
  if (modal) {
    modal.style.display = 'none';
    modal.innerHTML = '';
  }
  document.removeEventListener('keydown', modalEscHandler);
}

/* ---------- Tracks loading with fallback-aware payload ---------- */
async function loadTracks(albumId, albumCard) {
  const modal = document.getElementById('trackModal');
  if (modal && modal.style.display === 'flex') { closeTrackModal(); return; }

  const cacheKey = `tracks:${albumId}`;
  const cachedData = getCached(cacheKey);
  if (cachedData) { renderTracksModal(albumId, cachedData); return; }

  openTrackModal(`<div class="tracks-modal-inner"><div class="loading-spinner"><div class="spinner"></div><p>Caricamento tracce...</p></div></div>`);

  try {
    const payload = await fetchWithRetry(`${CONFIG.API_BASE}/album/${albumId}/tracks`);
    const tracks = Array.isArray(payload) ? payload : (payload.tracks || []);
    const note = payload.note || null;

    if (!tracks || tracks.length === 0) {
      openTrackModal(`<div class="tracks-modal-inner"><p class="no-preview">${escapeHtml(note || 'Nessuna traccia disponibile')}</p><button class="modal-close">×</button></div>`);
      return;
    }

    setCache(cacheKey, { tracks, note });
    renderTracksModal(albumId, { tracks, note });
  } catch (error) {
    console.error("Errore caricamento tracce:", error);
    openTrackModal(`<div class="tracks-modal-inner"><p class="no-preview" style="color:#ff3b30;">Errore caricamento tracce</p><div class="esc"><button class="modal-close">×</button></div>`);
  }
}

function renderTracksModal(albumId, payload) {
  const tracks = payload.tracks || payload;
  const note = payload.note || null;

  const tracksHtml = tracks.map(track => {
    const savedRating = getTrackRating(track.id);
    const options = Array.from({length:10}, (_,i) => `<option value="${i+1}" ${savedRating === (i+1) ? 'selected' : ''}>${i+1}</option>`).join('');
    return `
      <div class="track-card" data-track-id="${track.id}">
        <div class="track-header">
          <img src="${escapeHtml(track.cover || 'https://via.placeholder.com/600?text=No+Cover')}" alt="${escapeHtml(track.title)}" class="track-cover" loading="lazy" onerror="this.src='https://via.placeholder.com/600?text=No+Cover'">
          <div class="track-info">
            <strong>${track.position}. ${escapeHtml(track.title)}</strong>
            <div class="track-meta">${formatDuration(track.duration)}</div>
          </div>
          <div class="track-rating">
            <label for="rating-${track.id}" class="sr-only">Valuta traccia</label>
            <select id="rating-${track.id}" class="rating-select" data-track-id="${track.id}">
              <option value="">—</option>
              ${options}
            </select>
          </div>
        </div>
        ${track.preview ? `<audio controls preload="none"><source src="${escapeHtml(track.preview)}" type="audio/mpeg">Il tuo browser non supporta l'elemento audio.</audio>` : '<p class="no-preview">Nessuna preview disponibile</p>'}
      </div>
    `;
  }).join('');

  const content = `
    <div class="tracks-modal-inner">
      <button class="modal-close" aria-label="Chiudi">×</button>
      ${note ? `<p style="color:var(--text-secondary);">${escapeHtml(note)}</p>` : ''}
      <div class="tracks-grid modal-grid">
        ${tracksHtml}
      </div>
    </div>
  `;

  openTrackModal(content);

  document.querySelectorAll('.rating-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const trackId = e.target.getAttribute('data-track-id');
      const value = e.target.value ? Number(e.target.value) : null;
      setTrackRating(trackId, value);
      // Optional: sync to server
      if (value !== null) {
        fetch(`${CONFIG.API_BASE}/track/${trackId}/rating`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating: value })
        }).catch(err => console.warn('Rating sync failed', err));
      }
    });
  });
}

/* ---------- Helpers: duration & ratings ---------- */
function formatDuration(ms) {
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2,'0')}`;
}

function setTrackRating(trackId, rating) {
  if (!trackId) return;
  const key = `rating:track:${trackId}`;
  if (rating === null || rating === undefined || rating === '') {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, String(rating));
  }
}

function getTrackRating(trackId) {
  const key = `rating:track:${trackId}`;
  const v = localStorage.getItem(key);
  return v ? Number(v) : null;
}

/* ---------- INIT ---------- */
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  const themeToggle = document.getElementById("themeToggle");
  themeToggle.addEventListener("click", toggleTheme);

  const searchInput = document.getElementById("search");
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchArtist();
  });

  searchInput.focus();

  setInterval(() => {
    cache.clear();
    console.log("Cache cleared");
  }, 60 * 60 * 1000);
});
