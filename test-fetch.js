// ========================================
// CONFIGURAZIONE & COSTANTI
// ========================================

const CONFIG = {
  API_BASE: "http://localhost:3000/api",
  CACHE_DURATION: 5 * 60 * 1000, // 5 minuti
  DEBOUNCE_DELAY: 300,
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000
};

// Cache per le richieste API
const cache = new Map();

// ========================================
// UTILITÀ
// ========================================

/**
 * Debounce function per limitare le chiamate API
 */
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

/**
 * Gestisce il caching delle richieste
 */
function getCached(key) {
  const cached = cache.get(key);
  if (!cached) return null;
  
  const isExpired = Date.now() - cached.timestamp > CONFIG.CACHE_DURATION;
  if (isExpired) {
    cache.delete(key);
    return null;
  }
  
  return cached.data;
}

function setCache(key, data) {
  cache.set(key, {
    data,
    timestamp: Date.now()
  });
}

/**
 * Fetch con retry e gestione errori
 */
async function fetchWithRetry(url, retries = CONFIG.MAX_RETRIES) {
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
      return fetchWithRetry(url, retries - 1);
    }
    throw error;
  }
}

/**
 * Mostra messaggio di errore
 */
function showError(message) {
  const errorDiv = document.getElementById("error");
  errorDiv.textContent = message;
  errorDiv.style.display = "block";
  
  setTimeout(() => {
    errorDiv.style.display = "none";
  }, 5000);
}

/**
 * Toggle loading spinner
 */
function setLoading(isLoading) {
  const loadingDiv = document.getElementById("loading");
  loadingDiv.style.display = isLoading ? "flex" : "none";
}

/**
 * Sanitizza HTML per prevenire XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ========================================
// DARK MODE
// ========================================

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

// ========================================
// RICERCA ARTISTI
// ========================================

async function searchArtist() {
  const searchInput = document.getElementById("search");
  const query = searchInput.value.trim();
  
  if (!query) {
    showError("Inserisci il nome di un artista");
    return;
  }
  
  const artistsDiv = document.getElementById("artists");
  artistsDiv.innerHTML = "";
  
  // Controlla cache
  const cacheKey = `search:${query}`;
  const cachedData = getCached(cacheKey);
  
  if (cachedData) {
    renderArtists(cachedData);
    return;
  }
  
  setLoading(true);
  
  try {
    const artists = await fetchWithRetry(
      `${CONFIG.API_BASE}/search/artist?q=${encodeURIComponent(query)}`
    );
    
    if (!artists || artists.length === 0) {
      showError("Nessun artista trovato");
      setLoading(false);
      return;
    }
    
    // Fetch info aggiuntive in parallelo
    const artistsWithInfo = await Promise.all(
      artists.map(async (artist) => {
        try {
          const [wikiData, spotifyData] = await Promise.all([
            fetchWithRetry(`${CONFIG.API_BASE}/artist/${encodeURIComponent(artist.name)}/info`)
              .catch(() => ({ bio: null, image: null })),
            fetchWithRetry(`${CONFIG.API_BASE}/artist/${encodeURIComponent(artist.name)}/photo`)
              .catch(() => ({ image: null }))
          ]);
          
          return {
            ...artist,
            bio: wikiData.bio || "Nessuna biografia disponibile",
            photo: spotifyData.image || wikiData.image || "https://via.placeholder.com/140?text=No+Image"
          };
        } catch (error) {
          console.error(`Errore caricamento info per ${artist.name}:`, error);
          return {
            ...artist,
            bio: "Nessuna biografia disponibile",
            photo: "https://via.placeholder.com/140?text=No+Image"
          };
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

/**
 * Renderizza gli artisti
 */
function renderArtists(artists) {
  const artistsDiv = document.getElementById("artists");
  
  artists.forEach(artist => {
    const card = document.createElement("div");
    card.className = "artist-card";
    card.setAttribute("data-artist-id", artist.id);
    
    card.innerHTML = `
      <div class="artist-header">
        <img src="${escapeHtml(artist.photo)}" 
             alt="${escapeHtml(artist.name)}" 
             class="artist-photo"
             loading="lazy">
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

// ========================================
// CARICAMENTO RELEASE
// ========================================

async function loadReleases(artistId) {
  const card = document.querySelector(`[data-artist-id="${artistId}"]`);
  
  // Se già aperto, chiudi
  if (card.classList.contains("open")) {
    card.classList.remove("open");
    return;
  }
  
  // Chiudi altre card aperte
  document.querySelectorAll(".artist-card.open").forEach(c => {
    c.classList.remove("open");
  });
  
  card.classList.add("open");
  
  const container = document.getElementById(`releases-${artistId}`);
  
  // Controlla cache
  const cacheKey = `releases:${artistId}`;
  const cachedData = getCached(cacheKey);
  
  if (cachedData) {
    renderReleases(container, cachedData);
    return;
  }
  
  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  
  try {
    const releases = await fetchWithRetry(
      `${CONFIG.API_BASE}/artist/${artistId}/releases`
    );
    
    if (!releases || releases.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">Nessuna release disponibile</p>';
      return;
    }
    
    setCache(cacheKey, releases);
    renderReleases(container, releases);
    
  } catch (error) {
    console.error("Errore caricamento release:", error);
    container.innerHTML = '<p style="text-align: center; color: #ff3b30;">Errore caricamento release</p>';
  }
}

/**
 * Renderizza le release
 */
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
            <img src="${escapeHtml(release.cover)}" 
                 alt="${escapeHtml(release.title)}" 
                 class="album-cover"
                 loading="lazy">
            <h4>${escapeHtml(release.title)}</h4>
            <p>${escapeHtml(release.year || 'N/A')}</p>
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
  
  // Aggiungi event listeners per le card degli album
  container.querySelectorAll(".album-card").forEach(albumCard => {
    const albumId = albumCard.getAttribute("data-album-id");
    albumCard.addEventListener("click", (e) => {
      e.stopPropagation();
      loadTracks(albumId, albumCard);
    });
  });
}

// ========================================
// CARICAMENTO TRACCE
// ========================================

async function loadTracks(albumId, albumCard) {
  // Rimuovi tracce precedenti
  const existingTracks = albumCard.querySelector(".tracks-container");
  if (existingTracks) {
    existingTracks.remove();
    return;
  }
  
  // Chiudi altre tracce aperte
  document.querySelectorAll(".tracks-container").forEach(el => el.remove());
  
  // Controlla cache
  const cacheKey = `tracks:${albumId}`;
  const cachedData = getCached(cacheKey);
  
  if (cachedData) {
    renderTracks(albumCard, cachedData);
    return;
  }
  
  // Mostra loading
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "tracks-container";
  loadingDiv.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  albumCard.appendChild(loadingDiv);
  
  try {
    const tracks = await fetchWithRetry(
      `${CONFIG.API_BASE}/album/${albumId}/tracks`
    );
    
    loadingDiv.remove();
    
    if (!tracks || tracks.length === 0) {
      const noTracksDiv = document.createElement("div");
      noTracksDiv.className = "tracks-container";
      noTracksDiv.innerHTML = '<p class="no-preview">Nessuna traccia disponibile</p>';
      albumCard.appendChild(noTracksDiv);
      return;
    }
    
    setCache(cacheKey, tracks);
    renderTracks(albumCard, tracks);
    
  } catch (error) {
    console.error("Errore caricamento tracce:", error);
    loadingDiv.innerHTML = '<p class="no-preview" style="color: #ff3b30;">Errore caricamento tracce</p>';
  }
}

/**
 * Renderizza le tracce
 */
function renderTracks(albumCard, tracks) {
  const container = document.createElement("div");
  container.className = "tracks-container";
  
  const grid = document.createElement("div");
  grid.className = "tracks-grid";
  
  tracks.forEach(track => {
    const trackCard = document.createElement("div");
    trackCard.className = "track-card";
    
    trackCard.innerHTML = `
      <div class="track-header">
        <img src="${escapeHtml(track.cover)}" 
             alt="${escapeHtml(track.title)}" 
             class="track-cover"
             loading="lazy">
        <div class="track-info">
          <strong>${track.position}. ${escapeHtml(track.title)}</strong>
        </div>
      </div>
      ${track.preview 
        ? `<audio controls preload="none">
             <source src="${escapeHtml(track.preview)}" type="audio/mpeg">
             Il tuo browser non supporta l'elemento audio.
           </audio>` 
        : '<p class="no-preview">Nessuna preview disponibile</p>'
      }
    `;
    
    grid.appendChild(trackCard);
  });
  
  container.appendChild(grid);
  albumCard.appendChild(container);
}

// ========================================
// EVENT LISTENERS & INIT
// ========================================

document.addEventListener("DOMContentLoaded", () => {
  // Init tema
  initTheme();
  
  // Theme toggle
  const themeToggle = document.getElementById("themeToggle");
  themeToggle.addEventListener("click", toggleTheme);
  
  // Search input
  const searchInput = document.getElementById("search");
  
  // Debounced search on input (opzionale)
  // searchInput.addEventListener("input", debounce(searchArtist, CONFIG.DEBOUNCE_DELAY));
  
  // Search on Enter
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      searchArtist();
    }
  });
  
  // Focus search on load
  searchInput.focus();
  
  // Clear cache ogni ora
  setInterval(() => {
    cache.clear();
    console.log("Cache cleared");
  }, 60 * 60 * 1000);
});

// ========================================
// SERVICE WORKER (opzionale per PWA)
// ========================================

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(registration => console.log('SW registered:', registration))
      .catch(err => console.log('SW registration failed:', err));
  });
}