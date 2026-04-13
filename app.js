// public/app.js — MusicDB v4.0

const CONFIG = {
  API_BASE: "http://localhost:3000/api",
  CACHE_DURATION: 5 * 60 * 1000,
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000
};

const cache = new Map();

// ─────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────
function getCached(key) {
  const c = cache.get(key);
  if (!c) return null;
  if (Date.now() - c.timestamp > CONFIG.CACHE_DURATION) { cache.delete(key); return null; }
  return c.data;
}
function setCache(key, data) { cache.set(key, { data, timestamp: Date.now() }); }

// ─────────────────────────────────────────
// FETCH
// ─────────────────────────────────────────
async function fetchWithRetry(url, retries = CONFIG.MAX_RETRIES) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY));
      return fetchWithRetry(url, retries - 1);
    }
    throw e;
  }
}

// ─────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById("error");
  el.textContent = msg; el.style.display = "block";
  setTimeout(() => el.style.display = "none", 5000);
}
function setLoading(v) { document.getElementById("loading").style.display = v ? "flex" : "none"; }
function escapeHtml(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }
function formatDuration(ms) {
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}
function getInitials(name) { return name.split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase(); }

// ─────────────────────────────────────────
// THEME
// ─────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', saved);
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
}

// ─────────────────────────────────────────
// CERTIFICAZIONI FIMI — icone visive
// ─────────────────────────────────────────
const CERT_CONFIG = {
  oro:         { emoji: '🥇', label: 'Oro',       color: '#C9A84C', bg: 'rgba(201,168,76,0.12)',  border: 'rgba(201,168,76,0.4)' },
  platino:     { emoji: '💿', label: 'Platino',   color: '#A0AEC0', bg: 'rgba(160,174,192,0.12)', border: 'rgba(160,174,192,0.4)' },
  multiplatino:{ emoji: '💿', label: 'Platino',   color: '#6B8EBF', bg: 'rgba(107,142,191,0.12)', border: 'rgba(107,142,191,0.4)' },
  diamante:    { emoji: '💎', label: 'Diamante',  color: '#67E8F9', bg: 'rgba(103,232,249,0.12)', border: 'rgba(103,232,249,0.4)' },
};

function certificationBadgeHtml(cert) {
  if (!cert) return '';
  const cfg = CERT_CONFIG[cert.level] || CERT_CONFIG.oro;
  const label = cert.count > 1
    ? `${cert.count}x ${cfg.label}`
    : cfg.label;
  return `
    <span class="cert-badge" 
          style="color:${cfg.color}; background:${cfg.bg}; border-color:${cfg.border};"
          title="FIMI: ${label}">
      <span class="cert-icon">${cfg.emoji}</span>
      <span class="cert-label">${label}</span>
    </span>
  `;
}

// ─────────────────────────────────────────
// STELLE & RATING
// ─────────────────────────────────────────
function renderStars(value) {
  if (!value) return '';
  const stars = value / 2;
  const full = Math.floor(stars);
  const half = stars - full >= 0.5;
  const empty = 5 - full - (half ? 1 : 0);
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}
function communityBadgeHtml(avg, count) {
  if (!avg) return `<span class="community-badge empty">Nessun voto</span>`;
  return `
    <span class="community-badge" title="${count} vot${count === 1 ? 'o' : 'i'} community">
      <span class="community-stars">${renderStars(avg)}</span>
      <span class="community-score">${avg.toFixed(1)}</span>
      <span class="community-count">(${count})</span>
    </span>`;
}
function getMyRating(id) { const v = localStorage.getItem(`rating:track:${id}`); return v ? Number(v) : null; }
function setMyRating(id, r) {
  if (!r) localStorage.removeItem(`rating:track:${id}`);
  else localStorage.setItem(`rating:track:${id}`, String(r));
}

// ─────────────────────────────────────────
// SEARCH
// ─────────────────────────────────────────
async function searchArtist() {
  const query = document.getElementById("search").value.trim();
  if (!query) { showError("Inserisci il nome di un artista"); return; }

  document.getElementById("artists").innerHTML = "";
  const ck = `search:${query}`;
  const cd = getCached(ck);
  if (cd) { renderArtists(cd); return; }

  setLoading(true);
  try {
    const artists = await fetchWithRetry(`${CONFIG.API_BASE}/search/artist?q=${encodeURIComponent(query)}`);
    if (!artists?.length) { showError("Nessun artista trovato"); return; }

    // Carica profili in parallelo (foto + info da MusicBrainz)
    const enriched = await Promise.all(artists.map(async a => {
      try {
        const profile = await fetchWithRetry(
          `${CONFIG.API_BASE}/artist/${a.id}/profile?name=${encodeURIComponent(a.name)}`
        );
        return { ...a, photo: profile.photo, description: profile.description, genres: profile.genres || [] };
      } catch {
        return { ...a, photo: null, description: null, genres: [] };
      }
    }));

    setCache(ck, enriched);
    renderArtists(enriched);
  } catch (e) {
    console.error(e);
    showError("Errore durante la ricerca. Riprova più tardi.");
  } finally {
    setLoading(false);
  }
}

function renderArtists(artists) {
  const div = document.getElementById("artists");
  artists.forEach(artist => {
    const card = document.createElement("div");
    card.className = "artist-card";
    card.setAttribute("data-artist-id", artist.id);

    const photoHtml = artist.photo
      ? `<img src="${escapeHtml(artist.photo)}" alt="${escapeHtml(artist.name)}" class="artist-photo" loading="lazy"
           onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'">
         <div class="artist-avatar-placeholder" style="display:none">${getInitials(artist.name)}</div>`
      : `<div class="artist-avatar-placeholder">${getInitials(artist.name)}</div>`;

    const genresHtml = (artist.genres || []).length
      ? `<div class="artist-genres">${artist.genres.map(g => `<span class="genre-pill">${escapeHtml(g)}</span>`).join('')}</div>`
      : (artist.genre ? `<div class="artist-genres"><span class="genre-pill">${escapeHtml(artist.genre)}</span></div>` : '');

    const descHtml = artist.description
      ? `<p class="artist-description">${escapeHtml(artist.description)}</p>`
      : '';

    card.innerHTML = `
      <div class="artist-header">
        <div class="artist-photo-wrapper">${photoHtml}</div>
        <div class="artist-info">
          <h2>${escapeHtml(artist.name)}</h2>
          ${genresHtml}
          ${descHtml}
        </div>
      </div>
      <div id="releases-${artist.id}" class="artist-releases"></div>
    `;

    card.addEventListener("click", () => loadReleases(artist.id));
    div.appendChild(card);
  });
}

// ─────────────────────────────────────────
// RELEASES
// ─────────────────────────────────────────
async function loadReleases(artistId) {
  const card = document.querySelector(`[data-artist-id="${artistId}"]`);
  if (!card) return;
  if (card.classList.contains("open")) { card.classList.remove("open"); return; }
  document.querySelectorAll(".artist-card.open").forEach(c => c.classList.remove("open"));
  card.classList.add("open");

  const container = document.getElementById(`releases-${artistId}`);
  const ck = `releases:${artistId}`;
  const cd = getCached(ck);
  if (cd) { renderReleases(container, cd); return; }

  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  try {
    const releases = await fetchWithRetry(`${CONFIG.API_BASE}/artist/${artistId}/releases`);
    if (!releases?.length) { container.innerHTML = '<p class="empty-state">Nessuna release disponibile</p>'; return; }
    setCache(ck, releases);
    renderReleases(container, releases);
  } catch {
    container.innerHTML = '<p class="empty-state error-text">Errore caricamento release</p>';
  }
}

function renderReleases(container, releases) {
  const albums  = releases.filter(r => r.type === "album");
  const eps     = releases.filter(r => r.type === "ep");
  const singles = releases.filter(r => r.type === "single");

  function createSection(title, items) {
    if (!items.length) return "";
    return `
      <h3 class="section-title">${escapeHtml(title)}</h3>
      <div class="album-grid">
        ${items.map(r => `
          <div class="album-card" data-album-id="${r.id}">
            <div class="album-cover-wrapper">
              <img src="${escapeHtml(r.cover || '')}" alt="${escapeHtml(r.title)}"
                   class="album-cover" loading="lazy"
                   onerror="this.src='https://via.placeholder.com/600x600?text=♪'">
              <div class="album-overlay">
                <span class="album-play">▶</span>
              </div>
              ${r.certification ? `<div class="album-cert-badge">${certificationBadgeHtml(r.certification)}</div>` : ''}
            </div>
            <div class="album-info">
              <h4 title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</h4>
              <p class="album-meta">
                ${r.year || ''}
                ${r.trackCount ? `<span>· ${r.trackCount} tracce</span>` : ''}
              </p>
            </div>
          </div>
        `).join("")}
      </div>`;
  }

  container.innerHTML = createSection("Album", albums) + createSection("EP", eps) + createSection("Singoli", singles);

  container.querySelectorAll(".album-card").forEach(ac => {
    ac.addEventListener("click", e => { e.stopPropagation(); loadTracks(ac.getAttribute("data-album-id")); });
  });
}

// ─────────────────────────────────────────
// MODAL
// ─────────────────────────────────────────
function openModal(html) {
  let m = document.getElementById('trackModal');
  if (!m) { m = document.createElement('div'); m.id = 'trackModal'; m.className = 'track-modal'; document.body.appendChild(m); }
  m.innerHTML = html;
  m.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  m.addEventListener('click', e => { if (e.target === m || e.target.classList.contains('modal-close')) closeModal(); });
  document.addEventListener('keydown', escHandler);
}
function escHandler(e) { if (e.key === 'Escape') closeModal(); }
function closeModal() {
  const m = document.getElementById('trackModal');
  if (m) { m.style.display = 'none'; m.innerHTML = ''; }
  document.body.style.overflow = '';
  document.removeEventListener('keydown', escHandler);
}

// ─────────────────────────────────────────
// TRACKS
// ─────────────────────────────────────────
async function loadTracks(albumId) {
  const m = document.getElementById('trackModal');
  if (m?.style.display === 'flex') { closeModal(); return; }

  const ck = `tracks:${albumId}`;
  const cd = getCached(ck);
  if (cd) { await renderTracksModal(albumId, cd); return; }

  openModal(`<div class="tracks-modal-inner">
    <div class="loading-spinner"><div class="spinner"></div><p>Caricamento tracce...</p></div>
  </div>`);

  try {
    const payload = await fetchWithRetry(`${CONFIG.API_BASE}/album/${albumId}/tracks`);
    const tracks = Array.isArray(payload) ? payload : (payload.tracks || []);
    const note = payload.note || null;

    if (!tracks.length) {
      openModal(`<div class="tracks-modal-inner">
        <button class="modal-close">×</button>
        <p class="no-preview">${escapeHtml(note || 'Nessuna traccia disponibile')}</p>
      </div>`);
      return;
    }
    const result = { tracks, note };
    setCache(ck, result);
    await renderTracksModal(albumId, result);
  } catch {
    openModal(`<div class="tracks-modal-inner">
      <button class="modal-close">×</button>
      <p class="no-preview" style="color:#ff3b30;">Errore caricamento tracce</p>
    </div>`);
  }
}

async function renderTracksModal(albumId, payload) {
  const tracks = payload.tracks || payload;
  const note = payload.note || null;

  // Batch fetch community ratings
  let communityRatings = {};
  try {
    const ids = tracks.map(t => t.id).join(',');
    communityRatings = await fetchWithRetry(`${CONFIG.API_BASE}/tracks/ratings?ids=${ids}`);
  } catch {}

  // Raggruppa per disco
  const discs = {};
  tracks.forEach(t => {
    const d = t.discNumber || 1;
    if (!discs[d]) discs[d] = [];
    discs[d].push(t);
  });
  const multiDisc = Object.keys(discs).length > 1;

  const ratingLabels = ['','Pessimo','Scarso','Mediocre','Sufficiente','Discreto','Buono','Molto buono','Ottimo','Eccellente','Capolavoro'];

  function trackHtml(track) {
    const myRating = getMyRating(track.id);
    const comm = communityRatings[track.id] || { average: null, count: 0 };
    const opts = Array.from({length:10}, (_,i) =>
      `<option value="${i+1}" ${myRating === i+1 ? 'selected' : ''}>${i+1} — ${ratingLabels[i+1]}</option>`
    ).join('');
    const hasCover = track.cover && track.cover.trim() !== '';

    return `
      <div class="track-card" data-track-id="${track.id}">
        <div class="track-header">
          ${hasCover
            ? `<img src="${escapeHtml(track.cover)}" alt="" class="track-cover" loading="lazy"
                 onerror="this.src='https://via.placeholder.com/100x100?text=♪'">`
            : `<div class="track-cover-placeholder">♪</div>`}
          <div class="track-info">
            <strong class="track-title">
              <span class="track-num">${track.position}.</span>
              ${escapeHtml(track.title)}
              ${track.explicit ? '<span class="explicit-badge">E</span>' : ''}
              ${track.certification ? certificationBadgeHtml(track.certification) : ''}
            </strong>
            <div class="track-meta">
              ${track.duration ? `<span>⏱ ${formatDuration(track.duration)}</span>` : ''}
            </div>
            <div class="community-rating-row" id="cr-${track.id}">
              ${communityBadgeHtml(comm.average, comm.count)}
            </div>
          </div>
        </div>

        <div class="rating-section">
          <span class="rating-label">Il tuo voto</span>
          <div class="rating-controls">
            <select class="rating-select" data-track-id="${track.id}">
              <option value="">— Non votato —</option>
              ${opts}
            </select>
            <span class="my-rating-stars">${myRating ? renderStars(myRating) : ''}</span>
          </div>
        </div>

        ${track.preview
          ? `<audio controls preload="none" class="track-audio"><source src="${escapeHtml(track.preview)}" type="audio/mpeg"></audio>`
          : `<p class="no-preview">Nessuna preview disponibile</p>`}
      </div>`;
  }

  function discSectionHtml(discNum, discTracks) {
    const header = multiDisc ? `<div class="disc-header"><span class="disc-label">Disco ${discNum}</span></div>` : '';
    return header + discTracks.map(trackHtml).join('');
  }

  const tracksContent = Object.entries(discs)
    .sort(([a],[b]) => Number(a)-Number(b))
    .map(([d, t]) => discSectionHtml(Number(d), t))
    .join('');

  openModal(`
    <div class="tracks-modal-inner">
      <div class="modal-header">
        <div class="modal-title-group">
          <span class="modal-track-count">${tracks.length} tracce</span>
          ${note ? `<span class="modal-note">${escapeHtml(note)}</span>` : ''}
        </div>
        <button class="modal-close" aria-label="Chiudi">×</button>
      </div>
      <div class="tracks-grid modal-grid">
        ${tracksContent}
      </div>
    </div>
  `);

  // Rating listeners
  document.querySelectorAll('.rating-select').forEach(sel => {
    sel.addEventListener('change', async e => {
      const trackId = e.target.getAttribute('data-track-id');
      const value = e.target.value ? Number(e.target.value) : null;
      setMyRating(trackId, value);

      const starsEl = e.target.parentElement.querySelector('.my-rating-stars');
      if (starsEl) starsEl.textContent = value ? renderStars(value) : '';

      if (value !== null) {
        try {
          const resp = await fetch(`${CONFIG.API_BASE}/track/${trackId}/rating`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating: value })
          });
          const data = await resp.json();
          if (data.community) {
            const el = document.getElementById(`cr-${trackId}`);
            if (el) {
              el.innerHTML = communityBadgeHtml(data.community.average, data.community.count);
              el.classList.add('updated');
              setTimeout(() => el.classList.remove('updated'), 800);
            }
          }
        } catch {}
      }
    });
  });
}

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  document.getElementById("themeToggle").addEventListener("click", toggleTheme);
  const si = document.getElementById("search");
  si.addEventListener("keydown", e => { if (e.key === "Enter") searchArtist(); });
  si.focus();
  setInterval(() => { cache.clear(); console.log("Cache cleared"); }, 60 * 60 * 1000);
});
