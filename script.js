// script.js
const API_URL = window.location.origin.startsWith("http")
    ? window.location.origin
    : "http://localhost:3000"; // connect to your local GitHub server
const SHOW_COLLECTIONS_STORAGE_KEY = 'mediaTrackerShowCollections';

const LAYOUT_STORAGE_KEY = 'mediaTrackerLayouts';
const LAYOUT_VERSION = 2;

// Helper function for fetch with credentials
function apiFetch(url, options = {}) {
    return fetch(url, { ...options, credentials: 'include' });
}

// Media Tracker App - Main JavaScript File
class MediaTracker {
    constructor() {
        this.currentTab = 'home';
        this.currentView = 'home';
        this.homeDataLoaded = {
            latestTrailers: false,
            moviesCombined: false,
            tvCombined: false,
            animeAiring: false,
            gamesTrending: false,
            peoplePopular: false,
        };
        this.homeListenersSetup = false;
        this.homeLoading = {}; // Track ongoing requests to prevent duplicates
        this.homeCache = {
            gamesTrending: null,
        };
        this.currentItem = null;
        this.previousView = null; // Track previous view for navigation
        this.previousTab = null; // Track previous tab for sequels navigation
        this.sequelsViewSource = null; // Track source of sequels view: 'mal', 'steam', 'tmdb', or 'library'
        this.sequelsViewSourceItem = null; // Store the item that triggered the sequels view (for restoration)
        this.searchResults = {}; // Store search results for filtering: { movies: [], tv: [], anime: [], games: [], actors: [] }
        this.filteredSearchResults = {}; // Store filtered search results
        this.searchState = null; // Store search state (query, filters) when navigating away
        this.currentSequelsResults = []; // Store current sequels results
        this.actorSearchSource = 'tmdb'; // Track actor search source: 'tmdb' or 'spotify' for filtering (from any source)
        this.searchCategory = 'all'; // Default search category

        this.isDeleteMode = false;
        this.selectedItems = new Set();
        this.selectedLinkedMovies = []; // Store selected movies for linking
        this.navigationStack = []; // Track navigation history for actor -> linked movie -> back to actor
        this.collections = []; // Store collections
        this.currentCollectionItems = new Set(); // Items selected for current collection being created
        this.showCollectionsInLibrary = false; // Toggle for showing collections in library view
        this.currentViewedCollection = null; // Currently viewed collection (for adding items)
        this.currentEditingCollectionForPoster = null; // Collection being edited for poster change
        this.collectionToReturnTo = null; // Collection to return to when going back from add items view
        this.previousViewBeforeInsights = null; // Track prior view before opening insights
        this.currentInsightsCategory = null; // Remember which category insights are showing
        this.formStarRatingValue = 0; // Track current form rating for half-star support
        this.layoutEditMode = false; // Track if layout editor is active
        this.currentLayouts = {}; // Store custom layouts per category
        this.basePath = '/';
        this.lastKnownRootTab = this.currentTab;

        // Inline placeholder image (avoids missing /assets/img/placeholder.png 404)
        this.PLACEHOLDER_IMAGE = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="100%" height="100%" fill="%23e6e6e6"/><text x="50%" y="50%" font-size="24" text-anchor="middle" dominant-baseline="middle" fill="%23808080" font-family="Arial, sans-serif">No Image</text></svg>';

        // Watchlist toggle state
        this.showWatchlistInLibrary = false;

        // In-memory model (synced from GitHub)
        this.data = {
            items: [],
            settings: {
                themeBackgroundColor: '#000000',
                themeHoverColor: '#ff0000',
                themeTitleColor: '#ffffff',
                themeTextColor: '#cccccc',
                themeFontFamily: 'system-ui, sans-serif',
                themeDropdownColor: '#ff0000',
                tmdbApiKey: '',
                malApiKey: '',
                steamApiKey: '',
                steamgriddbApiKey: '',
                fanarttvApiKey: '',
                spotifyClientId: '',
                spotifyClientSecret: ''
            }
        };

        // TMDB genre mapping
        this.tmdbGenres = {
            28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
            99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
            27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction',
            10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
            // TV specific
            10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
            10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics'
        };
    }

    // Handle image selection when invoked from the Add New Item form.
    // Tries to call the existing `openImageSelector` if available (to reuse the image modal).
    // If not present or if the modal flow isn't desired, falls back to a simple prompt
    // where the user can paste a full image URL or a TMDB path (e.g. `/abc.jpg`).
    async handleAddFormImageSelect(type, source) {
        try {
            if (typeof this.openImageSelector === 'function') {
                // If the existing image selector supports being opened, prefer it.
                // Note: older implementations may not accept a target context; we call it
                // anyway to keep existing behavior where possible.
                try {
                    this.openImageSelector(type, source);
                    return;
                } catch (e) {
                    // swallow and continue to fallback
                    console.warn('openImageSelector failed, falling back to prompt', e);
                }
            }

            // Fallback: ask the user for an image URL or TMDB path
            const hint = source === 'tmdb' ? "Enter full image URL or TMDB path (e.g. /kqjL...jpg)" : "Enter full image URL";
            const input = window.prompt(hint, '');
            if (!input) return;

            let url = input.trim();
            if (url.startsWith('/')) {
                // Treat as TMDB path -> build proxied TMDB image URL
                const tmdbFull = `https://image.tmdb.org/t/p/w500${url}`;
                url = `${API_URL}/api/tmdb-image?url=${encodeURIComponent(tmdbFull)}`;
            }

            // For Steam or other sources, accept full URLs as-is
            this.setFormImagePreview(type, url);
        } catch (err) {
            console.error('Error in handleAddFormImageSelect:', err);
        }
    }

    // Sets the preview image in the Add New Item form for `poster` or `banner`.
    setFormImagePreview(type, url) {
        try {
            const previewId = type === 'poster' ? 'posterPreview' : 'bannerPreview';
            const previewEl = document.getElementById(previewId);
            if (!previewEl) return;

            previewEl.innerHTML = '';
            const img = document.createElement('img');
            img.src = url;
            img.alt = type;
            img.style.maxWidth = '100%';
            img.style.maxHeight = '160px';
            img.loading = 'lazy';
            previewEl.appendChild(img);
        } catch (e) {
            console.error('setFormImagePreview error', e);
        }
    }

    // Open the shared image selector modal and populate with results for the given source.
    async openImageSelector(type = 'poster', source = 'tmdb') {
        try {
            const modal = document.getElementById('imageSelectModal');
            const titleEl = document.getElementById('imageSelectTitle');
            const grid = document.getElementById('imageSelectionGrid');
            const animeSearchContainer = document.getElementById('animeSearchContainer');
            const animeSearchInput = document.getElementById('animeSearchInput');

            if (!modal || !grid || !titleEl) return;

            // Determine target context: if currently in detail view, target detail item, else assume add-form
            const target = (this.currentView === 'detail') ? 'detail' : 'add-form';
            this._imageSelectorContext = { target, type, source };

            titleEl.textContent = `Select ${type === 'poster' ? 'Poster' : 'Banner'} (${source.toUpperCase()})`;
            grid.innerHTML = '';

            // Show anime search field only when category is anime
            if (animeSearchContainer) animeSearchContainer.style.display = (this.currentTab === 'anime') ? 'block' : 'none';
            if (animeSearchInput) animeSearchInput.value = '';

            // Open modal
            modal.style.display = 'block';

            // Determine a sensible query: prefer form name/title, fallback to prompt
            let query = '';
            if (target === 'add-form') {
                query = (document.getElementById('itemName')?.value || '').trim();
            } else {
                query = (this.currentItem?.title || this.currentItem?.name || '').trim();
            }
            if (!query) {
                query = window.prompt('Search query for images (title):', '') || '';
            }

            if (!query) {
                // No query -> show manual URL entry helper
                const info = document.createElement('div');
                info.className = 'image-selector-info';
                info.textContent = 'No search query provided. Paste an image URL below or cancel.';
                const urlInput = document.createElement('input');
                urlInput.type = 'text';
                urlInput.placeholder = 'https://example.com/image.jpg';
                urlInput.style.width = '100%';
                urlInput.style.marginTop = '0.5rem';
                const applyBtn = document.createElement('button');
                applyBtn.textContent = 'Apply URL';
                applyBtn.className = 'small-btn';
                applyBtn.addEventListener('click', () => {
                    const url = urlInput.value.trim();
                    if (url) this.applySelectedImage(url);
                });
                grid.appendChild(info);
                grid.appendChild(urlInput);
                grid.appendChild(applyBtn);
                return;
            }

            // Perform TMDB search via server proxy for reasonable categories
            let category = 'movie';
            if (this.currentTab === 'tv' || (this.currentView === 'detail' && this.currentItem?.type === 'tv')) category = 'tv';
            if (this.currentTab === 'anime' || (this.currentView === 'detail' && this.currentItem?.type === 'anime')) category = 'movie';
            if (this.currentTab === 'games' || (this.currentView === 'detail' && this.currentItem?.type === 'games')) category = 'games';

            // Use existing universal search helper and fall back to a simple TMDB search by title
            let results = [];
            try {
                if (source === 'tmdb') {
                    // Search both movie and tv for broader matches
                    const movieResults = await this.searchAPIForUniversal(query, 'movies', 'tmdb').catch(() => []);
                    const tvResults = await this.searchAPIForUniversal(query, 'tv', 'tmdb').catch(() => []);
                    results = [...(movieResults || []), ...(tvResults || [])].slice(0, 40);
                } else {
                    // Other sources: try games search
                    results = await this.searchAPIForUniversal(query, (category === 'games') ? 'games' : 'movies', source).catch(() => []);
                }
            } catch (e) {
                console.warn('Image selector search failed', e);
            }

            if (!results || !results.length) {
                const noRes = document.createElement('div');
                noRes.textContent = 'No images found for that query.';
                grid.appendChild(noRes);
                return;
            }

            // Create image tiles
            results.forEach(result => {
                // Determine poster/backdrop candidates
                const posterCandidates = [
                    result.poster_path,
                    result.profile_path,
                    result.poster,
                    result.header_image,
                    result.main_picture?.large,
                    result.main_picture?.medium,
                    result.backdrop_path
                ];

                const posterRaw = posterCandidates.find(p => p && p !== '');
                let imgSrc = '';
                if (posterRaw) {
                    if (typeof posterRaw === 'string' && posterRaw.startsWith('http')) {
                        imgSrc = posterRaw;
                    } else {
                        const tmdbPath = String(posterRaw).startsWith('/') ? posterRaw : `/${posterRaw}`;
                        imgSrc = `${API_URL}/api/tmdb-image?url=${encodeURIComponent(`https://image.tmdb.org/t/p/w500${tmdbPath}`)}`;
                    }
                }

                if (!imgSrc) return;

                const tile = document.createElement('div');
                tile.className = 'image-tile';
                const img = document.createElement('img');
                img.src = imgSrc;
                img.alt = result.title || result.name || '';
                img.loading = 'lazy';
                img.style.width = '100%';
                img.style.cursor = 'pointer';
                img.addEventListener('click', () => this.applySelectedImage(imgSrc));
                tile.appendChild(img);
                grid.appendChild(tile);
            });
        } catch (err) {
            console.error('openImageSelector error', err);
        }
    }

    // Apply the selected image URL to the appropriate target (add-form or detail)
    applySelectedImage(url) {
        try {
            const ctx = this._imageSelectorContext || { target: 'add-form', type: 'poster' };
            if (ctx.target === 'add-form') {
                this.setFormImagePreview(ctx.type, url);
            } else if (ctx.target === 'detail') {
                // For detail view, attempt to set the detail poster/banner upload preview
                if (ctx.type === 'poster') {
                    const detailPoster = document.getElementById('detailPoster');
                    if (detailPoster) detailPoster.src = url;
                } else {
                    const bannerImageEl = document.getElementById('bannerImage');
                    if (bannerImageEl) bannerImageEl.src = url;
                }
            }
            this.closeImageSelector();
        } catch (e) {
            console.error('applySelectedImage error', e);
        }
    }

    closeImageSelector() {
        try {
            const modal = document.getElementById('imageSelectModal');
            const grid = document.getElementById('imageSelectionGrid');
            if (modal) modal.style.display = 'none';
            if (grid) grid.innerHTML = '';
            this._imageSelectorContext = null;
        } catch (e) {
            console.error('closeImageSelector error', e);
        }
    }

    switchImageTab(tab) {
        try {
            const posterTab = document.getElementById('posterTab');
            const bannerTab = document.getElementById('bannerTab');
            if (posterTab && bannerTab) {
                posterTab.classList.toggle('active', tab === 'poster');
                bannerTab.classList.toggle('active', tab === 'banner');
            }
            // Update context
            if (!this._imageSelectorContext) this._imageSelectorContext = { target: 'add-form', type: tab, source: 'tmdb' };
            else this._imageSelectorContext.type = tab;
        } catch (e) {
            console.error('switchImageTab error', e);
        }
    }

    mapGenreIdsToNames(genreIds) {
        if (!genreIds || !Array.isArray(genreIds)) return '';
        return genreIds.map(id => this.tmdbGenres[id] || '').filter(name => name).join(', ');
    }

    stripHtml(html) {
        if (!html) return '';
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        return tempDiv.textContent || tempDiv.innerText || '';
    }

    normalizeRecommendation(rec, sourceType) {
        const type = (sourceType || '').toLowerCase();
        let externalId = null;
        let name = '';

        if (type === 'games') {
            externalId = rec?.appid ?? rec?.id ?? rec?.gameId ?? null;
            name = rec?.name || rec?.title || '';
        } else if (type === 'anime') {
            externalId = rec?.entry?.mal_id ?? rec?.mal_id ?? rec?.id ?? null;
            name = rec?.entry?.title || rec?.title || rec?.name || '';
        } else if (type === 'movies' || type === 'tv') {
            externalId = rec?.id ?? rec?.external_id ?? null;
            name = rec?.title || rec?.name || '';
        } else {
            return { type, externalId: null, name: '', libraryItem: null };
        }

        const lookup = { type };
        if (externalId != null) lookup.externalApiId = String(externalId);
        if (name) lookup.name = name;

        const libraryItem = this.findLibraryItem(lookup);

        return {
            type,
            externalId: externalId != null ? String(externalId) : null,
            name,
            libraryItem
        };
    }

    // Helper to proxy GitHub images
    getProxiedImageUrl(url) {
        if (!url) return '';
        if (url.includes('raw.githubusercontent.com') || (url.includes('github.com') && url.includes('/blob/'))) {
            return `${API_URL}/api/github-image?url=${encodeURIComponent(url)}`;
        }
        return url;
    }

    // ---------- INIT ----------
    async init() {
        // 1) Load from DB first (items + settings)
        await this.loadItemsFromDB();
        await this.loadSettingsFromDB();

        // Load collections from GitHub
        await this.loadCollectionsFromDB();

        // 2) Apply settings to CSS vars
        this.loadSettings();

        // 3) Wire UI + render
        this.setupEventListeners();
        this.setupRuntimeSlider();
        this.setupVotesSlider();
        this.setupRatingSlider();
        this.updateCollectionsToggleUI();
        const routeHandled = await this.setupRouting();

        // Show home page by default (only if no overlay route is handled)
        if (!routeHandled) {
            if (this.currentTab === 'home') {
                this.showHomeView();
            } else {
                // Show library view for the restored tab (showLibraryView already calls renderLibrary)
                this.showLibraryView();
                this.updateFilterOptions();
            }
        }
    }

    async setupRouting() {
        const initialPath = window.location.pathname;
        const initialSearch = window.location.search || '';
        const initialHash = window.location.hash || '';
        const parsed = this.parsePathname(initialPath);

        // If the URL explicitly points to insights, open the insights view as its own page
        if (initialPath.endsWith('/insights') || initialHash === '#insights') {
            this.showInsightsView();
            return true;
        }

        console.log('setupRouting: Parsed pathname', { initialPath, parsed });

        this.basePath = parsed.basePath;

        // Restore tab from URL path first, then history state, then parsed state, default to 'home'
        const existingState = window.history.state;
        const tabFromState = parsed.detectedTab || existingState?.tab || parsed.state?.tab || this.currentTab || 'home';
        this.currentTab = tabFromState;
        this.lastKnownRootTab = tabFromState;

        // Update parsed state with correct tab
        parsed.state.tab = tabFromState;

        const composedUrl = `${initialPath}${initialSearch}${initialHash}`;

        if (!existingState) {
            console.log('setupRouting: No existing state, setting new state', parsed.state);
            window.history.replaceState({ ...parsed.state }, '', composedUrl);
        } else if (parsed.state.view === 'detail' && existingState.view !== 'detail') {
            console.log('setupRouting: Updating to detail state', parsed.state);
            window.history.replaceState({ ...parsed.state }, '', composedUrl);
        } else if (parsed.state.view === 'root' && existingState.view !== 'root') {
            console.log('setupRouting: Updating to root state', parsed.state);
            window.history.replaceState({ ...parsed.state }, '', composedUrl);
        }

        window.addEventListener('popstate', (event) => this.handlePopState(event));

        if (parsed.state.view === 'detail') {
            console.log('setupRouting: Detected detail view, restoring...', parsed.state);
            const restored = await this.restoreDetailFromState(parsed.state, { fromInitialLoad: true });
            console.log('setupRouting: Restoration result', restored);
            return restored;
        }

        // Restore tab UI state for root views
        if (this.isTabType(tabFromState)) {
            this.updateActiveTabContext(tabFromState);
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            const tabBtn = document.querySelector(`[data-tab="${tabFromState}"]`);
            if (tabBtn) {
                tabBtn.classList.add('active');
            }
        }

        this.syncRootHistoryState({ tab: this.currentTab, ensureUrl: false });
        return false;
    }

    parsePathname(pathname) {
        const segments = pathname.split('/').filter(Boolean);
        let type = null;
        let routeId = null;
        let baseSegments = segments.slice();
        let detectedTab = null;

        if (segments.length >= 2) {
            const potentialType = decodeURIComponent(segments[segments.length - 2]);
            const potentialId = decodeURIComponent(segments[segments.length - 1]);
            if (this.isOverlayMediaType(potentialType)) {
                type = potentialType;
                routeId = potentialId;
                baseSegments = segments.slice(0, segments.length - 2);
            }
        }

        // Check if the first segment is a tab name (for paths like /anime, /movies, /tv, /games, /actors)
        if (segments.length === 1 && !type) {
            const firstSegment = decodeURIComponent(segments[0]);
            if (this.isTabType(firstSegment) && firstSegment !== 'home') {
                detectedTab = firstSegment;
                baseSegments = []; // Empty base since the entire path is the tab
            }
        }

        let basePath = `/${baseSegments.join('/')}`;
        if (baseSegments.length === 0) basePath = '/';
        if (!basePath.endsWith('/')) basePath += '/';

        const identifierInfo = this.parseRouteIdentifier(type, routeId);

        const state = type && routeId
            ? {
                view: 'detail',
                itemType: type,
                routeId,
                externalApiId: identifierInfo?.externalApiId || null,
                tab: detectedTab || this.currentTab
            }
            : {
                view: 'root',
                tab: detectedTab || this.currentTab
            };

        return { type, routeId, basePath, state, detectedTab };
    }

    isOverlayMediaType(type) {
        return ['movies', 'tv', 'anime', 'games', 'actors'].includes(type);
    }

    isTabType(type) {
        return ['home', 'movies', 'tv', 'anime', 'games', 'actors'].includes(type);
    }

    getExternalPrefix(type) {
        if (type === 'movies' || type === 'tv') return 'tmdb_';
        if (type === 'anime') return 'mal_';
        if (type === 'games') return 'steam_';
        if (type === 'actors') return 'tmdb_person_';
        return '';
    }

    parseRouteIdentifier(type, routeId) {
        if (!type || !routeId) return null;
        const prefix = this.getExternalPrefix(type);
        if (prefix && routeId.startsWith(prefix)) {
            return {
                externalApiId: routeId.slice(prefix.length),
                isExternal: true
            };
        }
        return {
            externalApiId: null,
            isExternal: false
        };
    }

    syncRootHistoryState({ tab = this.currentTab, ensureUrl = false } = {}) {
        const currentState = window.history.state;
        let targetUrl;
        if (ensureUrl) {
            // Build URL path based on tab: / for home, /anime, /movies, /tv, /games, /actors for library tabs
            if (tab === 'home') {
                targetUrl = '/';
            } else {
                targetUrl = `/${tab}`;
            }
        } else {
            targetUrl = window.location.pathname + (window.location.search || '') + (window.location.hash || '');
        }
        console.log('syncRootHistoryState: Setting URL to', targetUrl, 'for tab', tab);

        // Use pushState instead of replaceState to create history entries for back/forward navigation
        if (ensureUrl && (!currentState || currentState.tab !== tab || window.location.pathname !== targetUrl)) {
            window.history.pushState({ view: 'root', tab }, '', targetUrl);
        } else if (!currentState || currentState.view !== 'root' || currentState.tab !== tab) {
            window.history.replaceState({ view: 'root', tab }, '', targetUrl);
        }
        this.lastKnownRootTab = tab;
    }

    pushViewHistoryState(state = {}) {
        const payload = {
            ...state,
            tab: this.currentTab,
            timestamp: Date.now()
        };
        window.history.pushState(payload, '', window.location.pathname);
    }

    resetUrlToBaseIfOverlay({ historyMode = 'replace', tab = this.currentTab } = {}) {
        const parsed = this.parsePathname(window.location.pathname);
        if (parsed.type && parsed.routeId) {
            const state = { view: 'root', tab };
            if (historyMode === 'push') {
                window.history.pushState(state, '', this.basePath);
            } else {
                window.history.replaceState(state, '', this.basePath);
            }
            this.lastKnownRootTab = tab;
        } else {
            this.syncRootHistoryState({ tab, ensureUrl: false });
        }
    }

    buildOverlayRoute(item) {
        const type = item?.type || this.currentTab || 'movies';
        const isLibraryItem = this.isItemInLibrary(item) || this.data.items.some(libItem => libItem.id === item?.id);
        const externalId = this.getExternalIdForItem(item);
        let routeId = item?.id || null;

        if (!isLibraryItem) {
            const prefix = this.getExternalPrefix(type);
            if (externalId) {
                routeId = `${prefix}${externalId}`;
            } else if (!routeId) {
                routeId = `${type}_${Date.now()}`;
            }
        } else if (!routeId && externalId) {
            routeId = `${this.getExternalPrefix(type)}${externalId}`;
        }

        if (!routeId) {
            routeId = `${type}_${Date.now()}`;
        }

        return {
            type,
            routeId,
            externalId,
            itemId: isLibraryItem ? (item?.id || null) : null,
            isLibraryItem
        };
    }

    getExternalIdForItem(item) {
        if (!item) return null;
        return item.externalApiId || item.externalId || item.tmdbId || item.malId || null;
    }

    buildOverlayUrl(type, routeId) {
        const safeType = encodeURIComponent(type || '');
        const safeId = encodeURIComponent(routeId || '');
        return `${this.basePath}${safeType}/${safeId}`;
    }

    createHistorySnapshot(item) {
        try {
            return JSON.parse(JSON.stringify(item));
        } catch (err) {
            console.warn('Unable to create history snapshot:', err);
            return null;
        }
    }

    findItemByRouteId(type, routeId) {
        if (!routeId) return null;
        const byId = this.data.items.find(entry => entry.id === routeId);
        if (byId) return byId;
        const parsed = this.parseRouteIdentifier(type, routeId);
        if (parsed?.externalApiId) {
            return this.data.items.find(entry => entry.type === type && entry.externalApiId === parsed.externalApiId);
        }
        return null;
    }

    async resolveItemFromState(state) {
        if (!state) return null;
        if (state.snapshot) return state.snapshot;

        if (state.itemId) {
            const byId = this.data.items.find(item => item.id === state.itemId);
            if (byId) return byId;
        }

        if (state.routeId) {
            const byRoute = this.findItemByRouteId(state.itemType, state.routeId);
            if (byRoute) return byRoute;
        }

        const externalId = state.externalApiId || this.parseRouteIdentifier(state.itemType, state.routeId)?.externalApiId;
        if (externalId) {
            const fromLibrary = this.data.items.find(item => item.externalApiId === externalId && item.type === state.itemType);
            if (fromLibrary) return fromLibrary;
            return await this.buildTransientItemFromExternal(state.itemType, externalId);
        }

        return null;
    }

    async buildTransientItemFromExternal(type, externalId, context = {}) {
        if (!externalId) return null;
        const name = context.name || '';
        const recommendation = context.recommendation || null;

        if (type === 'games') {
            const detail = await this.fetchSelectionDetails('games', externalId);
            if (!detail) return null;

            const descriptionRaw = detail.detailed_description || detail.about_the_game || detail.short_description || '';
            const description = this.stripHtml(descriptionRaw).replace(/\s+/g, ' ').trim();
            const releaseDate = detail.release_date || '';
            const year = releaseDate ? releaseDate.split(', ').pop() : '';
            const genres = Array.isArray(detail.genres) ? detail.genres.map(g => g.description || g.name || g).filter(Boolean).join(', ') : '';
            const developers = Array.isArray(detail.developers) ? detail.developers.filter(Boolean).join(', ') : '';
            const headerImage = detail.header_image || recommendation?.header_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${externalId}/header.jpg`;
            const bannerImage = detail.background_raw || detail.background || headerImage;
            const timeToBeatMinutes = detail.time_to_beat?.average_minutes || detail.time_to_beat?.median_minutes || null;
            const userScore = detail.metacritic?.score ? parseInt(detail.metacritic.score, 10) : 0;

            return {
                id: `rec_game_${externalId}`,
                type: 'games',
                externalApiId: String(externalId),
                name: detail.name || name || recommendation?.name || 'Untitled',
                title: detail.name || name || recommendation?.name || 'Untitled',
                description: description || 'No description available.',
                year: year || '',
                genre: genres,
                developer: developers,
                posterBase64: headerImage,
                bannerBase64: bannerImage,
                timeToBeat: timeToBeatMinutes ? String(timeToBeatMinutes) : '',
                userScore: Number.isFinite(userScore) ? userScore : 0
            };
        }

        if (type === 'anime') {
            const response = await fetch(`https://api.jikan.moe/v4/anime/${externalId}/full`);
            if (!response.ok) return null;
            const payload = await response.json();
            const anime = payload.data || {};

            const posterUrl = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || recommendation?.entry?.images?.jpg?.image_url || '';
            // Prefer TMDB backdrop for transient/on-demand anime banners.
            // Fall back to Jikan trailer image or anime image if TMDB search fails.
            let bannerUrl = '';

            try {
                // Try searching TMDB via server proxy by title (search against both movie and tv categories)
                const query = encodeURIComponent(anime.title || name || '');
                if (query) {
                    // Try TV first (many anime are TV shows on TMDB)
                    let tmdbResp = await apiFetch(`${API_URL}/api/search?query=${query}&category=tv&service=tmdb`);
                    let tmdbData = tmdbResp.ok ? await tmdbResp.json() : null;
                    let first = (tmdbData && tmdbData.results && tmdbData.results.length) ? tmdbData.results[0] : null;
                    // If no result in tv, try movie
                    if (!first) {
                        tmdbResp = await apiFetch(`${API_URL}/api/search?query=${query}&category=movie&service=tmdb`);
                        tmdbData = tmdbResp.ok ? await tmdbResp.json() : null;
                        first = (tmdbData && tmdbData.results && tmdbData.results.length) ? tmdbData.results[0] : null;
                    }

                    if (first && (first.backdrop_path || first.backdrop)) {
                        const backdropPath = first.backdrop_path || first.backdrop;
                        bannerUrl = backdropPath.startsWith('http') ? backdropPath : `https://image.tmdb.org/t/p/original${backdropPath}`;
                        console.log('Using TMDB backdrop for transient anime banner:', bannerUrl);
                    }
                }
            } catch (e) {
                console.warn('TMDB search for anime banner failed:', e);
            }

            // Fall back to Jikan-provided images if TMDB didn't provide a backdrop
            if (!bannerUrl) {
                bannerUrl = anime.trailer?.images?.maximum_image_url || anime.images?.jpg?.image_url || posterUrl;
            }
            const genres = Array.isArray(anime.genres) ? anime.genres.map(g => g.name).filter(Boolean).join(', ') : '';
            const studios = Array.isArray(anime.studios) ? anime.studios.map(s => s.name).filter(Boolean).join(', ') : '';
            const description = anime.synopsis || 'No description available.';
            const year = anime.aired?.prop?.from?.year || '';
            const episodes = Number.isFinite(anime.episodes) ? String(anime.episodes) : '';
            const episodeRuntime = anime.duration ? String(parseInt(anime.duration, 10)) : '';
            const score = Number.isFinite(anime.score) ? Math.round(anime.score * 10) : 0;

            return {
                id: `rec_anime_${externalId}`,
                type: 'anime',
                externalApiId: String(externalId),
                name: anime.title || name || recommendation?.entry?.title || recommendation?.title || 'Untitled',
                title: anime.title || name || recommendation?.entry?.title || recommendation?.title || 'Untitled',
                description,
                year: year || '',
                genre: genres,
                studio: studios,
                posterBase64: posterUrl,
                bannerBase64: bannerUrl,
                relations: anime.relations || [],
                userScore: score,
                episodes,
                episodeRuntime
            };
        }

        if (type === 'movies' || type === 'tv') {
            const detail = await this.fetchSelectionDetails(type, externalId);
            if (!detail) return null;

            const posterPath = detail.poster_path || recommendation?.poster_path || '';
            const posterUrl = posterPath
                ? (posterPath.startsWith('http') ? posterPath : `https://image.tmdb.org/t/p/w500${posterPath}`)
                : '';
            const backdropPath = detail.backdrop_path || recommendation?.backdrop_path || '';
            const backdropUrl = backdropPath
                ? (backdropPath.startsWith('http') ? backdropPath : `https://image.tmdb.org/t/p/original${backdropPath}`)
                : '';
            const description = detail.overview || recommendation?.overview || 'No description available.';
            const releaseDate = detail.release_date || detail.first_air_date || recommendation?.release_date || recommendation?.first_air_date || '';
            const year = releaseDate ? releaseDate.split('-')[0] : '';
            const genres = Array.isArray(detail.genres) ? detail.genres.map(g => g.name).filter(Boolean).join(', ') : '';

            // vote_average handling: /api/details doesn't return vote_average for movies/TV
            // Priority: recommendation.vote_average (from search, already 0-100) > fetch from TMDB directly
            let userScore = 0;

            // Use recommendation.vote_average first since it's from search results (already in 0-100 scale)
            if (Number.isFinite(recommendation?.vote_average) && recommendation.vote_average > 0) {
                // Search results already in 0-100 scale (converted by server), use directly
                userScore = Math.round(recommendation.vote_average);
            } else if (Number.isFinite(detail.vote_average) && detail.vote_average > 0) {
                // Fallback: detail.vote_average might exist from other sources (like /api/tmdb-details)
                // Check if it's in 0-100 scale (value > 10) or 0-10 scale (value <= 10)
                if (detail.vote_average > 10) {
                    // Already in 0-100 scale, use directly
                    userScore = Math.round(detail.vote_average);
                } else {
                    // In 0-10 scale, convert to 0-100
                    userScore = Math.round(detail.vote_average * 10);
                }
            } else {
                // Fetch vote_average directly from TMDB if not available
                try {
                    const mediaType = type === 'movies' ? 'movie' : 'tv';
                    const tmdbResponse = await apiFetch(`${API_URL}/api/tmdb-details?category=${mediaType}&id=${externalId}`);
                    if (tmdbResponse.ok) {
                        const tmdbData = await tmdbResponse.json();
                        if (Number.isFinite(tmdbData.vote_average) && tmdbData.vote_average > 0) {
                            // TMDB returns vote_average on 0-10 scale, convert to 0-100
                            userScore = Math.round(tmdbData.vote_average * 10);
                        }
                    }
                } catch (err) {
                    console.warn('Failed to fetch vote_average from TMDB:', err);
                }
            }

            const runtimeMinutes = type === 'movies' ? (detail.runtime_minutes || detail.runtime || null) : null;
            const episodeCount = type === 'tv' ? (detail.episode_count || detail.number_of_episodes || null) : null;
            const episodeRuntimeMinutes = type === 'tv'
                ? (detail.average_episode_runtime_minutes
                    || (Array.isArray(detail.episode_run_time) && detail.episode_run_time.length
                        ? Math.round(detail.episode_run_time.reduce((acc, val) => acc + val, 0) / detail.episode_run_time.length)
                        : null))
                : null;

            return {
                id: `rec_${type}_${externalId}`,
                type,
                externalApiId: String(externalId),
                name: detail.title || detail.name || name || recommendation?.title || recommendation?.name || 'Untitled',
                title: detail.title || detail.name || name || recommendation?.title || recommendation?.name || 'Untitled',
                description,
                year: year || '',
                genre: genres,
                posterBase64: posterUrl,
                bannerBase64: backdropUrl,
                userScore,
                runtime: runtimeMinutes ? String(runtimeMinutes) : '',
                episodes: episodeCount ? String(episodeCount) : '',
                episodeRuntime: episodeRuntimeMinutes ? String(episodeRuntimeMinutes) : '',
                status: detail.status || ''
            };
        }

        if (type === 'actors') {
            // Fetch actor details from TMDB person endpoint
            try {
                const response = await apiFetch(`${API_URL}/api/person/${externalId}`);
                if (!response.ok) return null;
                const detail = await response.json();

                const profilePath = detail.profile_path || '';
                const posterUrl = profilePath
                    ? (profilePath.startsWith('http') ? profilePath : `https://image.tmdb.org/t/p/w500${profilePath}`)
                    : '';

                // Parse social media links from external_ids
                const socialLinks = [];
                if (detail.external_ids) {
                    if (detail.external_ids.facebook_id) {
                        socialLinks.push(`https://www.facebook.com/${detail.external_ids.facebook_id}`);
                    }
                    if (detail.external_ids.twitter_id) {
                        socialLinks.push(`https://twitter.com/${detail.external_ids.twitter_id}`);
                    }
                    if (detail.external_ids.instagram_id) {
                        socialLinks.push(`https://www.instagram.com/${detail.external_ids.instagram_id}`);
                    }
                    if (detail.external_ids.imdb_id) {
                        socialLinks.push(`https://www.imdb.com/name/${detail.external_ids.imdb_id}`);
                    }
                }

                // Fetch combined credits for "Known For" section
                let combinedCredits = [];
                let creditsSummary = null;
                try {
                    const creditsResponse = await apiFetch(`${API_URL}/api/filmography?id=${externalId}`);
                    if (creditsResponse.ok) {
                        const creditsData = await creditsResponse.json();
                        creditsSummary = creditsData;
                        // Combine movies and TV shows, add media_type to each item
                        const allCredits = [
                            ...(creditsData.movies || []).map(item => ({ ...item, media_type: 'movie' })),
                            ...(creditsData.tv || []).map(item => ({ ...item, media_type: 'tv' }))
                        ];

                        // Filter to only on-screen acting roles (exclude voice roles, talk shows, reality, etc.)
                        const filteredCredits = this.filterActingRolesOnly(allCredits);

                        // Sort by popularity (if available) or release date, limit to top 12
                        combinedCredits = filteredCredits
                            .sort((a, b) => {
                                // Sort by popularity if available
                                if (a.popularity && b.popularity) {
                                    return b.popularity - a.popularity;
                                }
                                // Otherwise sort by release date (newest first)
                                const dateA = a.release_date || a.first_air_date || '';
                                const dateB = b.release_date || b.first_air_date || '';
                                return dateB.localeCompare(dateA);
                            })
                            .slice(0, 12);
                    }
                } catch (error) {
                    console.warn('Could not fetch actor credits:', error);
                }

                const actorRoles = this.deriveActorRolesFromSources(detail, creditsSummary);

                return {
                    id: `rec_actor_${externalId}`,
                    type: 'actors',
                    externalApiId: String(externalId),
                    name: detail.name || name || 'Unknown Actor',
                    title: detail.name || name || 'Unknown Actor',
                    description: detail.biography || 'No biography available.',
                    biography: (detail.biography || '').substring(0, 1580),
                    posterBase64: posterUrl,
                    socialMedia: socialLinks.join(', '),
                    linkedMovies: '', // Will be populated from transientCredits
                    transientCredits: combinedCredits, // Store credits for rendering
                    actorRoles,
                    genre: actorRoles.join(', ')
                };
            } catch (error) {
                console.error('Error building transient actor item:', error);
                return null;
            }
        }

        return null;
    }

    async restoreDetailFromState(state, { fromInitialLoad = false } = {}) {
        if (!state || state.view !== 'detail') {
            console.log('restoreDetailFromState: Not a detail view state', state);
            return false;
        }

        console.log('restoreDetailFromState: Attempting to restore', { state, itemsLoaded: this.data.items.length });

        try {
            // Restore tab state first to ensure CSS classes are applied
            if (state.tab && this.isTabType(state.tab)) {
                this.currentTab = state.tab;
                this.updateActiveTabContext(state.tab);
                document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
                const tabBtn = document.querySelector(`[data-tab="${state.tab}"]`);
                if (tabBtn) {
                    tabBtn.classList.add('active');
                }
            }

            // Ensure all menus are closed BEFORE resolving item
            this.closeSettingsMenu();
            this.closeAddMenu();
            this.closeSortMenu();
            this.closeFilterMenu();
            this.closeDetailSettingsMenu();

            const item = await this.resolveItemFromState(state);
            console.log('restoreDetailFromState: Resolved item', item ? { id: item.id, type: item.type, name: item.name } : 'null');

            if (!item) {
                console.warn('Unable to restore detail route - item not found:', state);
                console.log('Available items:', this.data.items.map(i => ({ id: i.id, type: i.type, name: i.name })));
                this.resetUrlToBaseIfOverlay({ historyMode: 'replace', tab: state.tab || this.currentTab });
                // Always show a fallback view, even on initial load
                if (state.tab === 'home') {
                    this.switchTab('home');
                } else if (this.isTabType(state.tab)) {
                    this.switchTab(state.tab);
                } else {
                    this.showLibraryView();
                }
                return false;
            }

            // Double-check menus are closed
            this.closeSettingsMenu();
            this.closeAddMenu();
            this.closeSortMenu();
            this.closeFilterMenu();
            this.closeDetailSettingsMenu();

            console.log('restoreDetailFromState: Showing detail view for', item.name);

            // Restore previous view state before showing detail view
            if (state.previousView === 'search' && state.searchState) {
                // Store search state for navigation back
                this.searchState = state.searchState;
                this.previousView = 'search';
            } else {
                this.previousView = state.previousView || null;
            }

            await this.showDetailView(item, { delayForBanner: true });

            // Remove temporary anti-flash styles if they exist
            const tempStyles = document.querySelectorAll('style[data-anti-flash]');
            tempStyles.forEach(style => style.remove());

            // Final check after a brief delay to ensure detail view is visible
            setTimeout(() => {
                const detailView = document.getElementById('detailView');
                const addMenu = document.getElementById('addMenu');
                if (detailView && detailView.style.display !== 'block') {
                    console.error('Detail view not visible after restoration!');
                    detailView.style.display = 'block';
                }
                if (addMenu && addMenu.classList.contains('show')) {
                    console.error('Add menu still open after restoration!');
                    this.closeAddMenu();
                }
            }, 100);

            return true;
        } catch (error) {
            console.error('Failed to restore detail state:', error);
            // Show fallback view on error
            const fallbackTab = state?.tab || this.currentTab || 'home';
            if (fallbackTab === 'home') {
                this.switchTab('home');
            } else if (this.isTabType(fallbackTab)) {
                this.switchTab(fallbackTab);
            } else {
                this.showLibraryView();
            }
            this.resetUrlToBaseIfOverlay({ historyMode: 'replace', tab: fallbackTab });
            return false;
        }
    }

    async handlePopState(event) {
        try {
            const state = event.state;
            if (state && state.view === 'detail') {
                await this.restoreDetailFromState(state);
                return;
            }

            if (state && state.view === 'collection') {
                const collection = this.collections.find(c => c.id === state.collectionId);
                let sourceItem = null;
                if (state.sourceItemId) {
                    sourceItem = this.data.items.find(item => item.id === state.sourceItemId) || null;
                }
                if (!sourceItem && state.sourceItemSnapshot) {
                    sourceItem = state.sourceItemSnapshot;
                }
                if (collection) {
                    this.showCollectionView([collection], sourceItem, { recordHistory: false });
                } else {
                    this.showLibraryView();
                }
                return;
            }

            // Restore insights view if navigating to it
            if (state && state.view === 'insights') {
                this.showInsightsView();
                return;
            }

            if (state && state.view === 'malRelated') {
                let sourceItem = null;
                if (state.sourceItemId) {
                    sourceItem = this.data.items.find(item => item.id === state.sourceItemId) || null;
                }
                if (!sourceItem && state.sourceItemSnapshot) {
                    sourceItem = state.sourceItemSnapshot;
                }
                if (sourceItem) {
                    this.showAllRelatedAnimeFromMAL(sourceItem, { recordHistory: false });
                } else {
                    this.showLibraryView();
                }
                return;
            }

            // Check if we're returning to search view from history
            if (state && state.previousView === 'search' && state.searchState) {
                this.searchState = state.searchState;
                this.restoreSearchView();
                return;
            }

            // Check if we have stored search state and we're navigating back from detail
            if (this.searchState && this.currentView === 'detail' && this.previousView === 'search') {
                this.restoreSearchView();
                return;
            }

            // Check if we're returning to home view from a detail view
            if (state && state.previousView === 'home') {
                if (this.currentTab !== 'home') {
                    this.switchTab('home');
                } else {
                    this.showHomeView();
                }
                return;
            }

            const targetTab = state?.tab || this.lastKnownRootTab || this.currentTab || 'home';
            if (targetTab === 'home') {
                if (this.currentTab !== 'home') {
                    this.switchTab('home', { fromPopstate: true });
                } else if (this.currentView !== 'home') {
                    this.showHomeView();
                }
                return;
            }

            if (this.isTabType(targetTab)) {
                if (this.currentTab !== targetTab) {
                    this.switchTab(targetTab, { fromPopstate: true });
                } else if (this.currentView !== 'library') {
                    this.showLibraryView();
                }
                return;
            }

            if (this.currentView !== 'library') {
                this.showLibraryView();
            }
        } catch (error) {
            console.error('popstate handling failed:', error);
        }
    }

    async openDetailView(item, options = {}) {
        if (!item) return;

        const { historyMode = 'push', source = null } = options;
        const route = this.buildOverlayRoute(item);
        const state = {
            view: 'detail',
            itemType: route.type,
            routeId: route.routeId,
            externalApiId: route.externalId || null,
            itemId: route.isLibraryItem ? route.itemId : null,
            tab: this.currentTab,
            source: source || null,
            previousView: this.currentView // Store previous view for navigation
        };

        // If coming from search view, store search state
        if (this.currentView === 'search') {
            const searchQuery = document.getElementById('searchQuery').textContent.replace(/"/g, '').trim();
            state.searchState = {
                query: searchQuery,
                results: { ...this.searchResults },
                filteredResults: { ...this.filteredSearchResults },
                filterValues: this.getSearchFilterValues()
            };
            // Also store in instance for back button navigation
            this.searchState = state.searchState;
        }

        if (!route.isLibraryItem) {
            state.snapshot = this.createHistorySnapshot(item);
        }

        const targetUrl = this.buildOverlayUrl(route.type, route.routeId);

        if (historyMode === 'push') {
            const currentState = window.history.state;
            if (!currentState) {
                this.syncRootHistoryState({ tab: this.currentTab, ensureUrl: false });
            }
            if (targetUrl === window.location.pathname) {
                window.history.replaceState(state, '', targetUrl);
            } else {
                window.history.pushState(state, '', targetUrl);
            }
        } else if (historyMode === 'replace') {
            window.history.replaceState(state, '', targetUrl);
        }

        await this.showDetailView(item, { delayForBanner: true });
    }

    // ---------- SETTINGS ----------
    // Pull from DB and place in this.data.settings
    async loadSettingsFromDB() {
        try {
            const res = await apiFetch(`${API_URL}/settings`, { credentials: 'include' });
            if (!res.ok) throw new Error(await res.text());
            const s = await res.json();

            // Handle old gameApiKey field (migration support)
            const steamApiKey = s.steamApiKey || s.gameApiKey || '';

            this.data.settings = {
                themeBackgroundColor: s.themeBackgroundColor || '#000000',
                themeHoverColor: s.themeHoverColor || '#ff0000',
                themeTitleColor: s.themeTitleColor || '#ffffff',
                themeTextColor: s.themeTextColor || '#cccccc',
                themeFontFamily: s.themeFontFamily || "'Momo Trust Sans', sans-serif",
                themeDropdownColor: s.themeDropdownColor || '#ff0000',
                tmdbApiKey: s.tmdbApiKey || '',
                malApiKey: s.malApiKey || '',
                steamApiKey: steamApiKey,
                steamgriddbApiKey: s.steamgriddbApiKey || '',
                fanarttvApiKey: s.fanarttvApiKey || '',
                omdbApiKey: s.omdbApiKey || '',
                spotifyClientId: s.spotifyClientId || '',
                spotifyClientSecret: s.spotifyClientSecret || '',
                youtubeApiKey: s.youtubeApiKey || '',
                bioMaxChars: Number.isFinite(Number(s.bioMaxChars)) ? Number(s.bioMaxChars) : null
            };
            // Load tabBackgrounds from server if present
            try {
                if (s.tabBackgrounds) {
                    this.data.settings.tabBackgrounds = (typeof s.tabBackgrounds === 'string') ? JSON.parse(s.tabBackgrounds) : s.tabBackgrounds;
                } else {
                    this.data.settings.tabBackgrounds = this.data.settings.tabBackgrounds || {};
                }
            } catch (e) {
                this.data.settings.tabBackgrounds = this.data.settings.tabBackgrounds || {};
            }
        } catch (err) {
            console.error("❌ Error loading settings from DB:", err);
        }
    }

    // ---------- COLLECTIONS ----------
    async loadCollectionsFromDB() {
        try {
            const res = await apiFetch(`${API_URL}/collections`);
            if (!res.ok) throw new Error(await res.text());
            this.collections = await res.json();
            console.log("✅ Loaded collections from GitHub:", this.collections.length);
        } catch (err) {
            console.error("❌ Error loading collections from DB:", err);
            this.collections = [];
        }
    }

    async saveCollectionsToDB() {
        try {
            // Save all collections - update existing ones
            for (const collection of this.collections) {
                await apiFetch(`${API_URL}/collections`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(collection)
                });
            }
            console.log("✅ Saved collections to GitHub");
        } catch (err) {
            console.error("❌ Error saving collections to DB:", err);
        }
    }

    async saveCollectionToDB(collection) {
        try {
            await apiFetch(`${API_URL}/collections`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(collection)
            });
            console.log("✅ Saved collection to GitHub:", collection.name);
        } catch (err) {
            console.error("❌ Error saving collection to DB:", err);
        }
    }

    async updateCollectionInDB(collectionId, updates) {
        try {
            await apiFetch(`${API_URL}/collections/${collectionId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(updates)
            });
            console.log("✅ Updated collection in GitHub:", collectionId);
        } catch (err) {
            console.error("❌ Error updating collection in DB:", err);
        }
    }

    async deleteCollectionFromDB(collectionId) {
        try {
            await apiFetch(`${API_URL}/collections/${collectionId}`, {
                method: "DELETE"
            });
            console.log("✅ Deleted collection from GitHub:", collectionId);
        } catch (err) {
            console.error("❌ Error deleting collection from DB:", err);
        }
    }

    loadSettings() {
        if (this.data && this.data.settings) {
            const settings = this.data.settings;
            document.documentElement.style.setProperty('--bg-color', settings.themeBackgroundColor);
            document.documentElement.style.setProperty('--hover-color', settings.themeHoverColor);
            document.documentElement.style.setProperty('--title-color', settings.themeTitleColor);
            document.documentElement.style.setProperty('--text-color', settings.themeTextColor);
            document.documentElement.style.setProperty('--font-family', settings.themeFontFamily);
            document.documentElement.style.setProperty('--dropdown-color', settings.themeDropdownColor);


            // Populate dropdown inputs
            document.getElementById('bgColor').value = settings.themeBackgroundColor;
            document.getElementById('hoverColor').value = settings.themeHoverColor;
            document.getElementById('titleColor').value = settings.themeTitleColor;
            document.getElementById('textColor').value = settings.themeTextColor;
            document.getElementById('dropdownColor').value = settings.themeDropdownColor;
            document.getElementById('tmdbApiKey').value = settings.tmdbApiKey || '';
            document.getElementById('malApiKey').value = settings.malApiKey || '';
            document.getElementById('steamApiKey').value = settings.steamApiKey || '';
            document.getElementById('steamgriddbApiKey').value = settings.steamgriddbApiKey || '';
            document.getElementById('fanarttvApiKey').value = settings.fanarttvApiKey || '';
            document.getElementById('omdbApiKey').value = settings.omdbApiKey || '';
            document.getElementById('spotifyClientId').value = settings.spotifyClientId || '';
            document.getElementById('spotifyClientSecret').value = settings.spotifyClientSecret || '';
            document.getElementById('youtubeApiKey').value = settings.youtubeApiKey || '';
            const bioInput = document.getElementById('bioMaxChars');
            if (bioInput) bioInput.value = (settings.bioMaxChars != null) ? String(settings.bioMaxChars) : '';
            // Load per-tab background settings: prefer server-stored `tabBackgrounds`, fallback to localStorage
            const storedTabBgs = window.localStorage.getItem('tabBackgrounds');
            try {
                if (!this.data.settings.tabBackgrounds || Object.keys(this.data.settings.tabBackgrounds || {}).length === 0) {
                    this.data.settings.tabBackgrounds = storedTabBgs ? JSON.parse(storedTabBgs) : {};
                } else {
                    // If server has values, ensure localStorage stays in sync
                    try { window.localStorage.setItem('tabBackgrounds', JSON.stringify(this.data.settings.tabBackgrounds)); } catch (e) { }
                }
            } catch (e) {
                this.data.settings.tabBackgrounds = this.data.settings.tabBackgrounds || {};
            }
            // Populate background controls for currently selected tab
            const sel = document.getElementById('tabBgSelect');
            const urlInput = document.getElementById('tabBgUrl');
            const opacityInput = document.getElementById('tabBgOpacity');
            if (sel && urlInput && opacityInput) {
                const currentTab = this.currentTab || 'home';
                sel.value = currentTab;
                const info = this.data.settings.tabBackgrounds[currentTab] || {};
                urlInput.value = info.url || '';
                opacityInput.value = (info.opacity != null) ? String(Math.round((info.opacity || 0) * 100)) : '40';
            }
            // Apply background for initial tab
            this.applyTabBackground(this.currentTab || 'home');
        }
    }

    applyTabBackground(tab) {
        try {
            const overlay = document.getElementById('tabBackground') || (() => {
                const div = document.createElement('div');
                div.id = 'tabBackground';
                div.className = 'tab-background';
                document.body.appendChild(div);
                return div;
            })();
            const info = (this.data.settings && this.data.settings.tabBackgrounds && this.data.settings.tabBackgrounds[tab]) || null;
            if (!info || !info.url) {
                overlay.style.backgroundImage = '';
                overlay.style.opacity = '0';
                return;
            }
            overlay.style.backgroundImage = `url("${info.url}")`;
            const op = (info.opacity != null) ? info.opacity : 0.4;
            overlay.style.opacity = String(op);
        } catch (e) { console.warn('applyTabBackground failed', e); }
    }

    saveTabBackground(tab, url, opacity) {
        this.data.settings = this.data.settings || {};
        this.data.settings.tabBackgrounds = this.data.settings.tabBackgrounds || {};
        this.data.settings.tabBackgrounds[tab] = { url: url || '', opacity: (opacity != null) ? Number(opacity) : 0 };
        try { window.localStorage.setItem('tabBackgrounds', JSON.stringify(this.data.settings.tabBackgrounds)); } catch (e) { }
        this.applyTabBackground(tab);
        // Persist to DB so backgrounds are loaded on other machines/reloads
        try { this.persistSettings(); } catch (e) { console.warn('persistSettings failed', e); }
    }

    async persistSettings() {
        try {
            await apiFetch(`${API_URL}/settings`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(this.data.settings),
                credentials: 'include'
            });
            console.log("✅ Settings saved to GitHub");
        } catch (err) {
            console.error("❌ Error saving settings to DB:", err);
        }
    }

    // ---------- EVENT LISTENERS ----------
    setupEventListeners() {
        this.setupCategoryShortcuts();

        // Tab switching
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchTab(e.target.dataset.tab));
        });

        // Settings background controls
        const tabSelect = document.getElementById('tabBgSelect');
        const tabUrl = document.getElementById('tabBgUrl');
        const tabUpload = document.getElementById('tabBgUpload');
        const tabOpacity = document.getElementById('tabBgOpacity');
        const tabApply = document.getElementById('tabBgApplyBtn');
        const tabClear = document.getElementById('tabBgClearBtn');
        if (tabSelect && tabUrl && tabUpload && tabOpacity && tabApply && tabClear) {
            tabSelect.addEventListener('change', (e) => {
                const t = e.target.value;
                const info = (this.data.settings && this.data.settings.tabBackgrounds && this.data.settings.tabBackgrounds[t]) || {};
                tabUrl.value = info.url || '';
                tabOpacity.value = (info.opacity != null) ? String(Math.round((info.opacity || 0) * 100)) : '40';
                this.applyTabBackground(t);
            });

            tabUpload.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => { tabUrl.value = ev.target.result; };
                reader.readAsDataURL(file);
            });

            tabApply.addEventListener('click', (e) => {
                const t = tabSelect.value || this.currentTab || 'home';
                const url = tabUrl.value && tabUrl.value.trim() ? tabUrl.value.trim() : '';
                const opacity = Math.max(0, Math.min(100, Number(tabOpacity.value || 40))) / 100;
                this.saveTabBackground(t, url, opacity);
            });

            tabClear.addEventListener('click', (e) => {
                const t = tabSelect.value || this.currentTab || 'home';
                this.saveTabBackground(t, '', 0);
                tabUrl.value = '';
                tabOpacity.value = '40';
            });
        }

        // Category Images settings controls
        const categoryImgSelect = document.getElementById('categoryImgSelect');
        const categoryImgUrl = document.getElementById('categoryImgUrl');
        const categoryImgUpload = document.getElementById('categoryImgUpload');
        const categoryImgPreview = document.getElementById('categoryImgPreview');
        const categoryImgPreviewGroup = document.getElementById('categoryImgPreviewGroup');
        const categoryImgApply = document.getElementById('categoryImgApplyBtn');
        const categoryImgClear = document.getElementById('categoryImgClearBtn');

        if (categoryImgSelect && categoryImgUrl && categoryImgUpload && categoryImgApply && categoryImgClear) {
            // When category changes, show current image
            categoryImgSelect.addEventListener('change', (e) => {
                const cat = e.target.value;
                const img = document.getElementById(`img-${cat}`);
                if (img && img.src) {
                    categoryImgUrl.value = '';
                    if (categoryImgPreview && categoryImgPreviewGroup) {
                        categoryImgPreview.src = img.src;
                        categoryImgPreviewGroup.style.display = 'block';
                    }
                } else {
                    categoryImgUrl.value = '';
                    if (categoryImgPreviewGroup) categoryImgPreviewGroup.style.display = 'none';
                }
            });

            // When file is uploaded, show preview
            categoryImgUpload.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    categoryImgUrl.value = ev.target.result;
                    if (categoryImgPreview && categoryImgPreviewGroup) {
                        categoryImgPreview.src = ev.target.result;
                        categoryImgPreviewGroup.style.display = 'block';
                    }
                };
                reader.readAsDataURL(file);
            });

            // When URL changes, show preview
            categoryImgUrl.addEventListener('change', (e) => {
                const url = e.target.value.trim();
                if (url && categoryImgPreview && categoryImgPreviewGroup) {
                    categoryImgPreview.src = url;
                    categoryImgPreviewGroup.style.display = 'block';
                }
            });

            // Apply button
            categoryImgApply.addEventListener('click', async () => {
                const cat = categoryImgSelect.value;
                const url = categoryImgUrl.value.trim();
                if (!url) {
                    alert('Please provide an image URL or upload an image.');
                    return;
                }

                // Update the small box image
                const smallImg = document.getElementById(`img-${cat}`);
                if (smallImg) smallImg.src = url;

                // Update preview if this category is selected
                const previewBox = document.getElementById('categoryPreviewBox');
                if (previewBox && previewBox.dataset.category === cat) {
                    const previewImg = document.getElementById('preview-img');
                    if (previewImg) previewImg.src = url;
                }

                // Save to GitHub
                await this.saveCategoryImage(cat, url);

                // Clear inputs
                categoryImgUrl.value = '';
                categoryImgUpload.value = '';
                if (categoryImgPreviewGroup) categoryImgPreviewGroup.style.display = 'none';
            });

            // Clear button
            categoryImgClear.addEventListener('click', async () => {
                const cat = categoryImgSelect.value;

                // Clear the small box image
                const smallImg = document.getElementById(`img-${cat}`);
                if (smallImg) smallImg.src = '';

                // Clear preview if this category is selected
                const previewBox = document.getElementById('categoryPreviewBox');
                if (previewBox && previewBox.dataset.category === cat) {
                    const previewImg = document.getElementById('preview-img');
                    if (previewImg) previewImg.src = '';
                }

                // Save empty to GitHub
                await this.saveCategoryImage(cat, '');

                // Clear inputs and preview
                categoryImgUrl.value = '';
                categoryImgUpload.value = '';
                if (categoryImgPreviewGroup) categoryImgPreviewGroup.style.display = 'none';
            });
        }

        // App title click - go to home
        const appTitle = document.getElementById('appTitle');
        if (appTitle) {
            appTitle.addEventListener('click', () => {
                console.log('App title clicked, switching to home');
                this.switchTab('home');
            });
        }

        // Navigation Menu
        const navMenuBtn = document.getElementById('navMenuBtn');
        const navSlideMenu = document.getElementById('navSlideMenu');

        if (navMenuBtn && navSlideMenu) {
            // Toggle menu on button click
            navMenuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                navSlideMenu.classList.toggle('show');
            });

            // Close menu when clicking outside
            document.addEventListener('click', (e) => {
                if (!navSlideMenu.contains(e.target) && !navMenuBtn.contains(e.target)) {
                    navSlideMenu.classList.remove('show');
                }
            });

            // Handle menu item clicks
            const navMenuItems = navSlideMenu.querySelectorAll('.nav-menu-item');
            navMenuItems.forEach(item => {
                item.addEventListener('click', () => {
                    const view = item.dataset.view;
                    const tab = item.dataset.tab;

                    // Close the menu
                    navSlideMenu.classList.remove('show');

                    // Navigate to the view
                    if (view === 'home') {
                        this.showHomeView();
                    } else if (view === 'library' && tab) {
                        this.showLibraryView();
                        // Wait a bit for the view to render, then switch tab
                        setTimeout(() => {
                            this.switchTab(tab);
                        }, 50);
                    }
                });
            });
        }

        // Search
        // Focus search input when clicking the search icon
        const searchContainer = document.querySelector('.search-container');
        if (searchContainer) {
            searchContainer.addEventListener('click', () => {
                document.getElementById('searchInput').focus();
            });
        }

        // Search input - handle Enter key for universal search
        // Top bar search input event listeners
        document.getElementById('searchInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const query = document.getElementById('searchInput').value.trim();
                if (query) {
                    this.performUniversalSearch(query);
                }
            }
        });
        // Still handle input for library filtering
        document.getElementById('searchInput').addEventListener('input', () => this.handleSearch());

        // Search filter event listeners
        document.getElementById('searchFilterApply').addEventListener('click', () => this.applySearchFilters());
        document.getElementById('searchFilterReset').addEventListener('click', () => this.resetSearchFilters());

        // Title/Name filter - re-apply filters when changed
        const titleFilter = document.getElementById('searchFilterTitle');
        if (titleFilter) {
            let titleFilterTimeout;
            titleFilter.addEventListener('input', () => {
                // Clear existing timeout
                if (titleFilterTimeout) {
                    clearTimeout(titleFilterTimeout);
                }

                // If we're in search view and have results, re-filter them
                if (this.currentView === 'search') {
                    if (Object.keys(this.searchResults).length > 0) {
                        // Debounce filter application
                        titleFilterTimeout = setTimeout(() => {
                            this.applySearchFilters();
                        }, 300);
                    }
                }
            });

            // Also trigger search on Enter key in Title filter
            titleFilter.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const query = titleFilter.value.trim();
                    if (query) {
                        // Perform new search
                        this.performUniversalSearch(query);
                    } else {
                        // If empty, clear Title filter and re-apply other filters
                        titleFilter.value = '';
                        if (Object.keys(this.searchResults).length > 0) {
                            this.applySearchFilters();
                        }
                    }
                }
            });
        }

        // Custom dropdown for Type filter
        this.setupCustomTypeDropdown();

        // Sort + Filter - show dropdowns
        document.getElementById('sortBtn').addEventListener('click', () => this.toggleSortMenu());
        document.getElementById('filterBtn').addEventListener('click', () => this.toggleFilterMenu());

        // Collections toggle
        document.getElementById('collectionsBtn').addEventListener('click', () => this.toggleCollectionsInLibrary());

        // Watchlist toggle
        document.getElementById('watchlistToggleBtn').addEventListener('click', () => this.toggleWatchlistView());

        // Handle sort/filter menu clicks
        document.querySelectorAll('#sortMenu .menu-option').forEach(option => {
            option.addEventListener('click', (e) => {
                const value = e.target.dataset.value;
                document.getElementById('sortSelect').value = value;
                this.handleSort();
                this.toggleSortMenu();
            });
        });

        document.getElementById('sortSelect').addEventListener('change', () => this.handleSort());
        document.getElementById('filterSelect').addEventListener('change', () => this.handleFilter());

        // Controls
        document.getElementById('addBtn').addEventListener('click', () => this.toggleAddMenu());
        document.getElementById('deleteBtn').addEventListener('click', () => this.toggleDeleteMode());
        document.getElementById('insightsBtn').addEventListener('click', () => this.toggleInsightsView());

        // Modal tabs
        document.getElementById('manualTab').addEventListener('click', () => this.showManualTab());
        document.getElementById('apiTab').addEventListener('click', () => this.showApiTab());

        // Actor search tabs (TMDB vs Spotify)
        document.getElementById('tmdbActorTab')?.addEventListener('click', () => this.switchActorSearchSource('tmdb'));
        document.getElementById('spotifySingerTab')?.addEventListener('click', () => this.switchActorSearchSource('spotify'));

        // Trailer modal close button
        const closeTrailerBtn = document.getElementById('closeTrailerModal');
        if (closeTrailerBtn) {
            closeTrailerBtn.addEventListener('click', () => this.closeTrailerModal());
        }

        // Cancel button closes dropdown and resets form
        document.getElementById('cancelForm').addEventListener('click', () => {
            this.resetItemForm();
            this.closeAddMenu();
        });

        // Settings button
        document.getElementById('settingsBtn').addEventListener('click', () => this.toggleSettingsMenu());

        // Form submit
        document.getElementById('itemForm').addEventListener('submit', (e) => { e.preventDefault(); this.saveItem(); });

        // Collection search in form
        document.getElementById('itemCollectionSearch').addEventListener('input', (e) => {
            this.searchCollectionsForForm(e.target.value);
        });

        // Scroll-to-top button (library view)
        try {
            const scrollBtn = document.getElementById('scrollTopBtn');
            if (scrollBtn) {
                scrollBtn.addEventListener('click', () => {
                    const lib = document.getElementById('libraryView');
                    if (lib) {
                        // Smoothly bring the library view into focus and scroll its content to top
                        lib.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        const grid = document.getElementById('gridContainer');
                        if (grid) {
                            grid.scrollTop = 0;
                        }
                        // Also ensure window is at top of lib
                        window.scrollTo({ top: lib.offsetTop, behavior: 'smooth' });
                    } else {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    }
                });
            }
        } catch (e) {
            console.warn('Failed to attach scrollTopBtn handler', e);
        }

        // Check for collection auto-match when item name changes
        document.getElementById('itemName').addEventListener('input', (e) => {
            this.checkAndShowCollectionAutoMatch(e.target.value);
        });

        // Clear collection search when form is reset
        document.getElementById('itemForm').addEventListener('reset', () => {
            document.getElementById('itemCollectionSearch').value = '';
            document.getElementById('collectionSearchResults').innerHTML = '';
            document.getElementById('itemCollection').value = '';

            // Remove auto-match notification
            const collectionGroup = document.getElementById('collectionGroup');
            if (collectionGroup) {
                const notification = collectionGroup.querySelector('.collection-auto-match-notification');
                if (notification) {
                    notification.remove();
                }
            }
        });

        // API search
        document.getElementById('apiSearchExecuteBtn').addEventListener('click', () => this.searchAPI());
        document.getElementById('apiSearchInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.searchAPI();
        });

        // Spotify search event listeners
        const spotifySearchBtn = document.getElementById('spotifySearchBtn');
        const spotifySearchInput = document.getElementById('spotifySearchInput');
        if (spotifySearchBtn) {
            spotifySearchBtn.addEventListener('click', () => this.searchSpotifyArtists());
        }
        if (spotifySearchInput) {
            spotifySearchInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.searchSpotifyArtists();
            });
        }

        // Linked movies search
        document.getElementById('linkedMoviesSearchBtn').addEventListener('click', () => this.searchLinkedMovies());
        document.getElementById('linkedMoviesSearchInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.searchLinkedMovies();
        });

        // Back button (removed from UI, using browser back button only)
        const backBtn = document.getElementById('backBtn');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                if (this.currentView === 'detail') {
                    window.history.back();
                } else {
                    this.handleBackNavigation();
                }
            });
        }

        // App title click - return to main page
        document.querySelector('.app-title').addEventListener('click', () => {
            if (this.currentView === 'detail') {
                // Clear navigation stack and go to library
                this.navigationStack = [];
            }
            this.showLibraryView();
        });

        // Delete controls
        document.getElementById('confirmDeleteBtn').addEventListener('click', () => this.confirmDelete());
        document.getElementById('cancelDeleteBtn').addEventListener('click', () => this.cancelDelete());

        // Detail settings menu
        document.getElementById('detailSettingsBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleDetailSettingsMenu();
        });

        // Image change buttons
        document.getElementById('changePosterBtn').addEventListener('click', () => {
            this.closeDetailSettingsMenu();
            this.openImageSelector('poster', 'tmdb');
        });
        document.getElementById('changeBannerBtn').addEventListener('click', () => {
            this.closeDetailSettingsMenu();
            this.openImageSelector('banner', 'tmdb');
        });
        document.getElementById('changePosterFanartBtn').addEventListener('click', () => {
            this.closeDetailSettingsMenu();
            this.openImageSelector('poster', 'fanart');
        });
        document.getElementById('changeBannerFanartBtn').addEventListener('click', () => {
            this.closeDetailSettingsMenu();
            this.openImageSelector('banner', 'fanart');
        });
        document.getElementById('uploadPosterBtn').addEventListener('click', () => {
            this.closeDetailSettingsMenu();
            this.triggerImageUpload('poster');
        });
        document.getElementById('uploadBannerBtn').addEventListener('click', () => {
            this.closeDetailSettingsMenu();
            this.triggerImageUpload('banner');
        });

        // Image selection modal
        document.getElementById('closeImageModal').addEventListener('click', () => this.closeImageSelector());
        document.getElementById('posterTab').addEventListener('click', () => this.switchImageTab('poster'));
        document.getElementById('bannerTab').addEventListener('click', () => this.switchImageTab('banner'));
        document.getElementById('animeSearchInput').addEventListener('input', () => this.handleAnimeImageSearch());

        // Add-form image select buttons - use safe wrapper so add-form can pick images even if
        // the detail image selector isn't available. Prompts for an image URL/path as fallback.
        document.getElementById('selectPosterFromTMDB')?.addEventListener('click', () => this.handleAddFormImageSelect('poster', 'tmdb'));
        document.getElementById('selectBannerFromTMDB')?.addEventListener('click', () => this.handleAddFormImageSelect('banner', 'tmdb'));
        document.getElementById('selectPosterFromSteam')?.addEventListener('click', () => this.handleAddFormImageSelect('poster', 'rawg'));
        document.getElementById('selectBannerFromSteam')?.addEventListener('click', () => this.handleAddFormImageSelect('banner', 'rawg'));

        // Add-form upload buttons - trigger the visible file inputs in the add form
        document.getElementById('uploadPosterBtnAdd')?.addEventListener('click', (e) => {
            e.preventDefault();
            const input = document.getElementById('itemPoster');
            if (input) input.click();
        });
        document.getElementById('uploadBannerBtnAdd')?.addEventListener('click', (e) => {
            e.preventDefault();
            const input = document.getElementById('itemBanner');
            if (input) input.click();
        });

        // Stars
        this.setupStarRatings();

        // Image uploads
        document.getElementById('itemPoster').addEventListener('change', (e) => this.handleImageUpload(e, 'posterPreview'));
        document.getElementById('itemBanner').addEventListener('change', (e) => this.handleImageUpload(e, 'bannerPreview'));

        // Detail view image uploads
        document.getElementById('detailPosterUpload').addEventListener('change', (e) => this.handleDetailImageUpload(e, 'poster'));
        document.getElementById('detailBannerUpload').addEventListener('change', (e) => this.handleDetailImageUpload(e, 'banner'));

        // Collection poster upload
        document.getElementById('collectionPosterUpload').addEventListener('change', (e) => this.handleCollectionPosterUpload(e));

        // Collection banner upload
        document.getElementById('collectionBannerUpload').addEventListener('change', (e) => this.handleCollectionBannerUpload(e));

        // Settings (gear)
        this.setupSettingsListeners();

        // Mouse wheel scrolling for actor linked movies
        this.setupActorLinkedMoviesWheelScroll();

        // Read More button for biography
        document.getElementById('readMoreBtn').addEventListener('click', () => {
            const biographyEl = document.getElementById('actorBiography');
            const readMoreBtn = document.getElementById('readMoreBtn');
            const full = biographyEl.dataset.fullBiography || biographyEl.textContent || '';
            const defaultMax = 1580;
            const bioMax = (this.data && this.data.settings && Number.isFinite(Number(this.data.settings.bioMaxChars))) ? Number(this.data.settings.bioMaxChars) : defaultMax;

            if (biographyEl.classList.contains('collapsed')) {
                // expand
                biographyEl.classList.remove('collapsed');
                biographyEl.textContent = full;
                readMoreBtn.textContent = 'Read Less';
            } else {
                // collapse back to configured max
                biographyEl.classList.add('collapsed');
                biographyEl.textContent = full.substring(0, bioMax);
                readMoreBtn.textContent = 'Read More';
            }
        });

        // Layout Editor
        document.getElementById('editLayoutBtn').addEventListener('click', () => this.toggleLayoutEditMode());
        document.getElementById('closeLayoutEditorBtn').addEventListener('click', () => this.toggleLayoutEditMode());
        document.getElementById('saveLayoutBtn').addEventListener('click', () => this.saveCurrentLayout());
        document.getElementById('resetLayoutBtn').addEventListener('click', () => this.resetLayoutToDefault());

        // Click-outside to close dropdowns
        document.addEventListener('click', (e) => {
            // Don't close add menu if clicking inside add-menu or the image selector modal
            if (!e.target.closest('.add-dropdown') && !e.target.closest('#addMenu') && !e.target.closest('#imageSelectModal')) {
                this.closeAddMenu();
            }
            if (!e.target.closest('.sort-dropdown')) this.closeSortMenu();
            if (!e.target.closest('.filter-dropdown')) this.closeFilterMenu();
            if (!e.target.closest('.collections-toggle')) {
                // Collections toggle doesn't need to close on click outside
            }
            if (!e.target.closest('.settings-dropdown')) this.closeSettingsMenu();
            if (!e.target.closest('.detail-settings-dropdown')) this.closeDetailSettingsMenu();
            // Click outside modal to close
        });

        // Live preview
        ['bgColor', 'hoverColor', 'titleColor', 'textColor', 'dropdownColor'].forEach(id => {
            document.getElementById(id).addEventListener('input', () => this.updateSettingsPreview());
        });

        // Search Category Dropdown
        this.setupSearchCategoryDropdown();

        // Advanced Search Filters
        this.setupAdvancedSearchListeners();
    }

    async setupCategoryShortcuts() {
        const categoryNames = {
            anime: 'Anime',
            movies: 'Movies',
            tv: 'Series',
            games: 'Games',
            actors: 'People'
        };

        // Load saved images from GitHub
        await this.loadCategoryImages();

        // Initialize preview with first category (anime)
        this.updateCategoryPreview('anime');

        // Preview box click - navigate to library
        const previewBox = document.getElementById('categoryPreviewBox');
        if (previewBox) {
            previewBox.addEventListener('click', (e) => {
                if (e.target.closest('.category-preview-upload-btn') || e.target.closest('.category-preview-upload')) {
                    return;
                }
                const category = previewBox.dataset.category;
                this.switchTab(category);
            });

            const previewUploadBtn = previewBox.querySelector('.category-preview-upload-btn');
            const previewFileInput = previewBox.querySelector('.category-preview-upload');

            if (previewUploadBtn && previewFileInput) {
                previewUploadBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    previewFileInput.click();
                });

                previewFileInput.addEventListener('change', async (e) => {
                    const file = e.target.files[0];
                    if (file) {
                        const category = previewBox.dataset.category;
                        const reader = new FileReader();
                        reader.onload = async (event) => {
                            const base64 = event.target.result;
                            const previewImg = document.getElementById('preview-img');
                            if (previewImg) previewImg.src = base64;
                            const smallImg = document.getElementById(`img-${category}`);
                            if (smallImg) smallImg.src = base64;

                            // Save to GitHub
                            await this.saveCategoryImage(category, base64);
                        };
                        reader.readAsDataURL(file);
                    }
                });
            }
        }

        document.querySelectorAll('.category-box').forEach(box => {
            const category = box.dataset.category;
            const uploadBtn = box.querySelector('.category-upload-btn');
            const fileInput = box.querySelector('.category-upload');
            const img = box.querySelector('.category-img');

            box.addEventListener('click', (e) => {
                if (e.target.closest('.category-upload-btn') || e.target.closest('.category-upload')) {
                    return;
                }
                this.updateCategoryPreview(category);
            });

            if (uploadBtn && fileInput) {
                uploadBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    fileInput.click();
                });

                fileInput.addEventListener('change', async (e) => {
                    const file = e.target.files[0];
                    if (file) {
                        const reader = new FileReader();
                        reader.onload = async (event) => {
                            const base64 = event.target.result;
                            if (img) img.src = base64;
                            const previewBox = document.getElementById('categoryPreviewBox');
                            if (previewBox && previewBox.dataset.category === category) {
                                const previewImg = document.getElementById('preview-img');
                                if (previewImg) previewImg.src = base64;
                            }

                            // Save to GitHub
                            await this.saveCategoryImage(category, base64);
                        };
                        reader.readAsDataURL(file);
                    }
                });
            }
        });
    }

    async loadCategoryImages() {
        console.log('🖼️ Loading category images from GitHub...');
        try {
            const response = await apiFetch(`${API_URL}/category-images`);
            console.log(`🖼️ Load response status: ${response.status}`);

            // Check if response is actually JSON
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                console.warn('⚠️ Category images endpoint returned non-JSON response, skipping load');
                return;
            }

            if (response.ok) {
                const images = await response.json();
                console.log(`✅ Loaded ${images.length} category images:`, images.map(i => i.category));

                images.forEach(item => {
                    const img = document.getElementById(`img-${item.category}`);
                    if (img && item.image) {
                        img.src = item.image;
                        console.log(`🖼️ Applied image to ${item.category}`);
                    } else {
                        console.warn(`⚠️ Could not apply image for ${item.category} - img element:`, !!img, ', has image:', !!item.image);
                    }
                });
            } else {
                const errorText = await response.text();
                console.warn(`❌ Failed to load category images: ${response.status} ${response.statusText} - ${errorText}`);
            }
        } catch (err) {
            console.error('❌ Failed to load category images from GitHub:', err);
        }
    }

    async saveCategoryImage(category, base64) {
        console.log(`🖼️ Saving category image for: ${category}, size: ${base64.length} chars`);
        try {
            const response = await apiFetch(`${API_URL}/category-images`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category, image: base64 })
            });

            console.log(`🖼️ Save response status: ${response.status}`);

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`❌ Failed to save category image: ${response.status} - ${errorText}`);
                throw new Error(`Failed to save category image: ${errorText}`);
            }

            const result = await response.json();
            console.log(`✅ Category image for ${category} saved to GitHub, SHA: ${result.sha}`);
        } catch (err) {
            console.error('❌ Failed to save category image to GitHub:', err);
            alert('Failed to save category image. Check console for details.');
        }
    }

    updateCategoryPreview(category) {
        const categoryNames = {
            anime: 'Anime',
            movies: 'Movies',
            tv: 'Series',
            games: 'Games',
            actors: 'People'
        };

        const previewBox = document.getElementById('categoryPreviewBox');
        const previewImg = document.getElementById('preview-img');
        const previewName = document.getElementById('preview-name');

        if (!previewBox || !previewImg || !previewName) return;

        previewBox.dataset.category = category;

        previewName.style.transition = 'opacity 0.15s ease';
        previewName.style.opacity = '0';
        setTimeout(() => {
            previewName.textContent = categoryNames[category] || category;
            previewName.style.opacity = '1';
        }, 150);

        const smallImg = document.getElementById(`img-${category}`);
        if (smallImg && smallImg.src) {
            previewImg.style.transition = 'opacity 0.15s ease';
            previewImg.style.opacity = '0';
            setTimeout(() => {
                previewImg.src = smallImg.src;
                previewImg.alt = categoryNames[category] || category;
                previewImg.style.opacity = '1';
            }, 150);
        }

        document.querySelectorAll('.category-box').forEach(box => {
            if (box.dataset.category === category) {
                box.classList.add('active');
            } else {
                box.classList.remove('active');
            }
        });
    }

    setupSettingsListeners() {
        document.getElementById('saveSettings').addEventListener('click', async () => {
            this.saveSettings();
            await this.persistSettings();
        });
    }

    setupActorLinkedMoviesWheelScroll() {
        // Vertical scrolling is handled by CSS overflow-y: auto
        // This handler is no longer needed but kept for potential future customization
    }

    setupStarRatings() {
        const setup = (star, isForm) => {
            const containerSelector = isForm ? '#formStarRating' : '#starRating';
            const getCurrentRating = () => isForm ? this.formStarRatingValue : (this.currentItem?.myRank || 0);

            const computeRatingFromEvent = (event) => {
                const baseValue = parseInt(star.dataset.rating, 10);
                const rect = star.getBoundingClientRect();
                const clientX = event.touches?.[0]?.clientX ?? event.clientX;
                if (clientX == null) return baseValue;
                let relativeX = clientX - rect.left;
                relativeX = Math.max(0, Math.min(rect.width, relativeX));
                const isHalf = relativeX < rect.width / 2;
                let rating = baseValue - (isHalf ? 0.5 : 0);
                return Math.max(0, Math.min(5, Math.round(rating * 2) / 2));
            };

            const previewHover = (event) => {
                if (event.type === 'mousemove' && event.buttons !== 0) return;
                const rating = computeRatingFromEvent(event);
                this.updateStarDisplay(containerSelector, rating);

                try {
                    const container = document.querySelector(containerSelector);
                    const tooltip = container?.querySelector('.rating-tooltip');
                    if (tooltip) {
                        const map = {
                            '5': '⭐ 5  Masterpiece',
                            '4.5': '⭐ 4.5  legendary',
                            '4': '⭐ 4  Excellent',
                            '3.5': '⭐ 3.5  Good',
                            '3': '⭐ 3  Average',
                            '2.5': '⭐ 2.5 Meh',
                            '2': '⭐ 2  Bad',
                            '1.5': '⭐ 1.5  Awful',
                            '1': '⭐ 1  Trash',
                            '0.5': '⭐ 0.5  zenah'
                        };
                        const key = (Math.round(rating * 2) / 2).toString();
                        const label = map[key] || `⭐ ${key} –`;
                        if (rating > 0) {
                            tooltip.textContent = label;
                            tooltip.style.display = 'block';
                        } else {
                            tooltip.style.display = 'none';
                        }
                    }
                } catch (e) {
                    // ignore tooltip errors
                }
            };

            const restoreDisplay = () => {
                this.updateStarDisplay(containerSelector, getCurrentRating());
            };

            const handleClick = async (event) => {
                const rating = computeRatingFromEvent(event);
                const currentRating = getCurrentRating();
                let finalRating = rating;
                if (rating === currentRating) {
                    finalRating = Math.max(0, rating - 0.5);
                }
                if (isForm) {
                    this.setFormStarRating(finalRating);
                } else {
                    await this.setDetailStarRating(finalRating);
                }
            };

            star.addEventListener('click', handleClick);
            star.addEventListener('touchstart', (event) => {
                event.preventDefault();
                handleClick(event);
            }, { passive: false });
            star.addEventListener('mouseenter', previewHover);
            star.addEventListener('mousemove', previewHover);
        };

        document.querySelectorAll('#formStarRating .star').forEach(star => setup(star, true));
        document.querySelectorAll('#starRating .star').forEach(star => setup(star, false));

        const formContainer = document.getElementById('formStarRating');
        if (formContainer && !formContainer.dataset.hoverResetAttached) {
            formContainer.addEventListener('mouseleave', () => {
                this.updateStarDisplay('#formStarRating', this.formStarRatingValue);
                const tt = formContainer.querySelector('.rating-tooltip');
                if (tt) tt.style.display = 'none';
            });
            formContainer.dataset.hoverResetAttached = 'true';
        }

        const detailContainer = document.getElementById('starRating');
        if (detailContainer && !detailContainer.dataset.hoverResetAttached) {
            detailContainer.addEventListener('mouseleave', () => {
                const current = this.currentItem?.myRank || 0;
                this.updateStarDisplay('#starRating', current);
                const tt = detailContainer.querySelector('.rating-tooltip');
                if (tt) tt.style.display = 'none';
            });
            detailContainer.dataset.hoverResetAttached = 'true';
        }
    }

    setupSearchCategoryDropdown() {
        const dropdownBtn = document.getElementById('searchCategoryBtn');
        const dropdownMenu = document.getElementById('searchCategoryMenu');
        const searchInput = document.getElementById('searchInput');

        if (!dropdownBtn || !dropdownMenu || !searchInput) return;

        // Toggle dropdown
        dropdownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdownBtn.parentElement.classList.toggle('open');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!dropdownBtn.parentElement.contains(e.target)) {
                dropdownBtn.parentElement.classList.remove('open');
            }
        });

        // Handle option selection
        dropdownMenu.querySelectorAll('.search-category-option').forEach(option => {
            option.addEventListener('click', () => {
                const category = option.dataset.category;

                if (category === 'advanced') {
                    // Switch to search view with empty state
                    // Hide all views
                    const views = ['homeView', 'libraryView', 'sequelsView', 'collectionView', 'insightsView', 'detailView', 'searchView'];
                    views.forEach(id => {
                        const el = document.getElementById(id);
                        if (el) el.style.display = 'none';
                    });

                    // Show search view
                    const searchView = document.getElementById('searchView');
                    if (searchView) searchView.style.display = 'block';
                    document.getElementById('searchInput').style.display = 'block';
                    this.currentView = 'search';

                    // Clear input
                    searchInput.value = '';

                    // Clear results
                    ['searchMoviesGrid', 'searchTvGrid', 'searchAnimeGrid', 'searchGamesGrid', 'searchActorsGrid'].forEach(id => {
                        const el = document.getElementById(id);
                        if (el) el.innerHTML = '';
                    });
                    ['searchMoviesSection', 'searchTvSection', 'searchAnimeSection', 'searchGamesSection', 'searchActorsSection'].forEach(id => {
                        const el = document.getElementById(id);
                        if (el) el.style.display = 'none';
                    });

                    document.getElementById('searchTitle').textContent = 'Advanced Search';
                    document.getElementById('searchQuery').textContent = '';
                    document.getElementById('searchLoading').style.display = 'none';
                    document.getElementById('searchError').style.display = 'none';

                    dropdownBtn.parentElement.classList.remove('open');
                    return;
                }

                // Update state
                this.searchCategory = category;

                // Update UI
                dropdownMenu.querySelectorAll('.search-category-option').forEach(opt => opt.classList.remove('active'));
                option.classList.add('active');
                dropdownBtn.parentElement.classList.remove('open');

                // Update placeholder
                const categoryNames = {
                    all: 'All',
                    movies: 'Movies',
                    tv: 'TV',
                    anime: 'Anime',
                    games: 'Games',
                    actors: 'People'
                };
                searchInput.placeholder = category === 'all' ? 'Search...' : `Search ${categoryNames[category]}...`;

                // Trigger search if input is not empty
                if (searchInput.value.trim()) {
                    this.performUniversalSearch(searchInput.value.trim());
                }
            });
        });
    }

    setupAdvancedSearchListeners() {
        // Filter Apply button
        const applyBtn = document.getElementById('searchFilterApply');
        if (applyBtn) {
            applyBtn.addEventListener('click', () => {
                const query = document.getElementById('searchFilterTitle').value.trim();
                const typeSelect = document.getElementById('searchFilterType');
                const type = typeSelect ? typeSelect.value : '';

                if (query) {
                    this.searchCategory = type || 'all';
                    this.performUniversalSearch(query);
                } else {
                    // Discovery mode (empty title, use filters)
                    this.searchCategory = type || 'all';
                    this.performUniversalSearch('', true);
                }
            });
        }

        // Title Enter key
        const titleInput = document.getElementById('searchFilterTitle');
        if (titleInput) {
            titleInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    const query = titleInput.value.trim();
                    const typeSelect = document.getElementById('searchFilterType');
                    const type = typeSelect ? typeSelect.value : '';
                    if (query) {
                        this.searchCategory = type || 'all';
                        this.performUniversalSearch(query);
                    } else {
                        // Discovery mode
                        this.searchCategory = type || 'all';
                        this.performUniversalSearch('', true);
                    }
                }
            });
        }

        // Reset button
        const resetBtn = document.getElementById('searchFilterReset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                // Clear all inputs
                // Clear all inputs
                document.querySelectorAll('.search-filter-input').forEach(input => input.value = '');
                const typeSelect = document.getElementById('searchFilterType');
                if (typeSelect) typeSelect.value = '';
                const sortSelect = document.getElementById('searchFilterSort');
                if (sortSelect) sortSelect.value = 'popularity.desc';
                document.querySelectorAll('.genre-tag').forEach(tag => tag.classList.remove('active'));
                const genreInput = document.getElementById('searchFilterGenre');
                if (genreInput) genreInput.value = '';

                // Re-apply empty filters (shows all loaded results)
                this.applySearchFilters();
            });
        }

        // Genre Tags
        const genreTags = document.querySelectorAll('.genre-tag');
        const genreInput = document.getElementById('searchFilterGenre');
        if (genreTags.length > 0 && genreInput) {
            genreTags.forEach(tag => {
                tag.addEventListener('click', () => {
                    tag.classList.toggle('active');

                    // Update hidden input
                    const activeTags = [];
                    document.querySelectorAll('.genre-tag.active').forEach(t => {
                        activeTags.push(t.dataset.value);
                    });
                    genreInput.value = activeTags.join(',');
                });
            });
        }
    }

    // ---------- TABS & VIEWS ----------
    switchTab(tab, { fromPopstate = false } = {}) {
        console.log(`switchTab called with tab: ${tab}`);
        this.currentTab = tab;
        this.updateActiveTabContext(tab);

        // Show/hide tabs and controls based on tab
        const tabsRow = document.querySelector('.tabs-row');
        const controlsRow = document.querySelector('.controls-row');

        if (tab === 'home') {
            // Hide tabs and controls on home
            if (tabsRow) tabsRow.style.display = 'none';
            if (controlsRow) controlsRow.style.display = 'none';
        } else {
            // Show tabs and controls on other tabs
            if (tabsRow) tabsRow.style.display = 'flex';
            if (controlsRow) controlsRow.style.display = 'flex';
        }

        // Hide all other views when switching tabs
        document.getElementById('sequelsView').style.display = 'none';
        document.getElementById('collectionView').style.display = 'none';
        document.getElementById('detailView').style.display = 'none';
        document.getElementById('searchView').style.display = 'none';

        // Clear search input
        document.getElementById('searchInput').value = '';

        // Update active tab
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        const tabBtn = document.querySelector(`[data-tab="${tab}"]`);
        if (tabBtn) {
            tabBtn.classList.add('active');
            console.log(`Tab ${tab} activated`);
        } else {
            console.warn(`Tab button for ${tab} not found`);
        }

        if (tab === 'home') {
            console.log('Switching to home view');
            // Always show home view, even if already on home tab
            // This ensures content reloads when clicking title
            this.showHomeView();
        } else {
            this.currentView = 'library';
            this.showLibraryView();
            this.updateFilterOptions();
            this.renderLibrary();
            this.updateFormFieldsByTab(); // Update form fields for actor-specific fields
        }

        // Only push to history if not coming from popstate (back/forward button)
        if (!fromPopstate) {
            this.syncRootHistoryState({ tab: this.currentTab, ensureUrl: true });
        }
    }

    updateActiveTabContext(tab) {
        const activeTab = tab || this.currentTab || 'home';
        const body = document.body;
        if (body) {
            const tabClassPrefix = 'tab-';
            const classesToRemove = Array.from(body.classList).filter(cls => cls.startsWith(tabClassPrefix));
            if (classesToRemove.length) {
                body.classList.remove(...classesToRemove);
            }
            body.classList.add(`${tabClassPrefix}${activeTab}`);
            body.dataset.activeTab = activeTab;
        }
        const appContainer = document.querySelector('.app-container');
        if (appContainer) {
            const tabClassPrefix = 'tab-';
            const classesToRemove = Array.from(appContainer.classList).filter(cls => cls.startsWith(tabClassPrefix));
            if (classesToRemove.length) {
                appContainer.classList.remove(...classesToRemove);
            }
            appContainer.classList.add(`${tabClassPrefix}${activeTab}`);
            appContainer.dataset.activeTab = activeTab;
        }
        // Apply the tab-specific background when the active tab changes
        try {
            this.applyTabBackground(activeTab);
        } catch (e) { }
    }

    showHomeView() {
        console.log('showHomeView called');
        this.updateActiveTabContext('home');
        // Close any open menus
        this.closeDetailSettingsMenu();

        // Hide scroll-to-top button when not in library
        const scrollBtn = document.getElementById('scrollTopBtn');
        if (scrollBtn) scrollBtn.classList.remove('show');

        // Hide all other views explicitly
        document.getElementById('sequelsView').style.display = 'none';
        document.getElementById('collectionView').style.display = 'none';
        document.getElementById('detailView').style.display = 'none';
        document.getElementById('libraryView').style.display = 'none';
        document.getElementById('insightsView').style.display = 'none';
        this.setInsightsButtonState(false);
        this.currentInsightsCategory = null;
        this.updateInsightsSubtitle(null);

        // Hide "Add Items" button if it exists
        const addItemsBtn = document.querySelector('.add-items-to-collection-btn');
        if (addItemsBtn) {
            addItemsBtn.style.display = 'none';
        }

        // Show home view
        this.currentView = 'home';
        this.currentTab = 'home'; // Ensure currentTab is set to home
        const homeView = document.getElementById('homeView');
        if (homeView) {
            homeView.style.display = 'block';
            console.log('Home view displayed');
        } else {
            console.error('homeView element not found!');
            return;
        }
        this.resetUrlToBaseIfOverlay({ historyMode: 'replace', tab: 'home' });
        const backBtn1 = document.getElementById('backBtn');
        if (backBtn1) backBtn1.style.display = 'none';
        // Show top bar search input on home view
        document.getElementById('searchInput').style.display = 'block';
        document.getElementById('settingsBtn').style.display = 'flex';
        document.getElementById('detailSettingsBtn').style.display = 'none';
        // Hide controls row on home tab (sort, filter, collections, delete, add buttons)
        // Do this multiple times to ensure it's hidden regardless of timing
        const hideControlsRow = () => {
            const controlsRow = document.querySelector('.controls-row');
            if (controlsRow) {
                controlsRow.classList.add('hidden');
                controlsRow.style.display = 'none'; // Explicitly hide with inline style
            }
        };
        hideControlsRow();
        // Also hide after a brief delay to catch any late updates
        setTimeout(hideControlsRow, 0);
        requestAnimationFrame(hideControlsRow);
        // Show tabs row
        const tabsRow = document.querySelector('.tabs-row');
        if (tabsRow) {
            tabsRow.classList.remove('hidden');
            tabsRow.style.display = ''; // Remove any inline display style
        }

        // Reset loaded flags to force reload when switching to home
        // This ensures content loads even if user navigates away and comes back
        this.homeDataLoaded = {
            latestTrailers: false,
            moviesCombined: false,
            tvCombined: false,
            animeAiring: false,
            gamesTrending: false,
        };

        // Clear any existing loading states and force reload
        this.homeLoading = {};

        // Ensure containers are reset to loading state
        const containerIds = [
            'latestTrailersRow',
            'moviesCombinedRow',
            'tvCombinedRow',
            'animeAiringRow',
            'gamesTrendingRow',
        ];

        containerIds.forEach(id => {
            const container = document.getElementById(id);
            if (container) {
                container.innerHTML = '<div class="home-loading">Loading...</div>';
            }
        });

        // Render home page with on-demand API calls
        // Use requestAnimationFrame to ensure DOM updates are complete
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                console.log('Calling renderHome after double RAF');
                // Force a reflow to ensure display changes are applied
                if (homeView) {
                    homeView.offsetHeight; // Force reflow
                }
                // Call renderHome - it will check containers and retry if needed
                this.renderHome();
            });
        });
    }

    showLibraryView() {
        this.updateActiveTabContext(this.currentTab);
        // Close any open menus
        this.closeDetailSettingsMenu();

        // Hide all other views explicitly
        document.getElementById('sequelsView').style.display = 'none';
        document.getElementById('collectionView').style.display = 'none';
        document.getElementById('detailView').style.display = 'none';
        document.getElementById('homeView').style.display = 'none';
        document.getElementById('insightsView').style.display = 'none';
        document.getElementById('searchView').style.display = 'none';
        this.setInsightsButtonState(false);
        this.currentInsightsCategory = null;
        this.updateInsightsSubtitle(null);

        // Hide "Add Items" button if it exists
        const addItemsBtn = document.querySelector('.add-items-to-collection-btn');
        if (addItemsBtn) {
            addItemsBtn.style.display = 'none';
        }

        // Clear collection search
        const collectionSearchInput = document.getElementById('collectionSearchInput');
        if (collectionSearchInput) {
            collectionSearchInput.value = '';
        }

        // Show library view
        this.currentView = 'library';
        document.getElementById('libraryView').style.display = 'block';
        // Update URL to show current tab path
        this.syncRootHistoryState({ tab: this.currentTab, ensureUrl: true });
        const backBtn2 = document.getElementById('backBtn');
        if (backBtn2) backBtn2.style.display = 'none';
        // Show top bar search input on library view
        document.getElementById('searchInput').style.display = 'block';
        document.getElementById('settingsBtn').style.display = 'flex';
        document.getElementById('detailSettingsBtn').style.display = 'none';
        // Show controls row on library tabs (sort, filter, collections, delete, add buttons)
        const controlsRow = document.querySelector('.controls-row');
        if (controlsRow) {
            controlsRow.classList.remove('hidden');
            controlsRow.style.display = ''; // Remove inline style to allow CSS to control display
        }
        document.querySelector('.tabs-row').classList.remove('hidden');

        // Clear navigation stack when returning to library
        this.navigationStack = [];

        this.renderLibrary();
        // Show scroll-to-top button only when on a library tab (not the main 'home' tab)
        try {
            const scrollBtn = document.getElementById('scrollTopBtn');
            if (scrollBtn) {
                if (this.currentTab && this.currentTab !== 'home' && this.isTabType(this.currentTab)) {
                    scrollBtn.classList.add('show');
                } else {
                    scrollBtn.classList.remove('show');
                }
            }
        } catch (e) {
            console.warn('scrollTopBtn show/hide failed', e);
        }
    }

    toggleInsightsView() {
        if (this.currentView === 'insights') {
            const previous = this.previousViewBeforeInsights;
            this.previousViewBeforeInsights = null;
            this.currentInsightsCategory = null;
            this.updateInsightsSubtitle(null);
            // Restore URL when leaving insights
            try {
                const targetTab = previous === 'home' ? 'home' : (this.lastKnownRootTab || 'home');
                this.syncRootHistoryState({ tab: targetTab, ensureUrl: true });
            } catch (e) { }
            if (previous === 'home') {
                this.showHomeView();
            } else {
                this.showLibraryView();
            }
        } else {
            const categoryFilter = this.getInsightsCategoryForCurrentTab();
            this.showInsightsView(categoryFilter);
        }
    }

    showInsightsView(categoryFilter = null) {
        this.previousViewBeforeInsights = this.currentView;
        const normalizedFilter = this.normalizeInsightsCategory(categoryFilter);
        this.currentInsightsCategory = normalizedFilter;
        this.closeAddMenu();
        this.closeDetailSettingsMenu();
        this.closeSortMenu();
        this.closeFilterMenu();

        document.getElementById('homeView').style.display = 'none';
        document.getElementById('libraryView').style.display = 'none';
        document.getElementById('detailView').style.display = 'none';
        document.getElementById('sequelsView').style.display = 'none';
        document.getElementById('collectionView').style.display = 'none';
        document.getElementById('searchView').style.display = 'none';

        const insightsView = document.getElementById('insightsView');
        if (insightsView) {
            insightsView.style.display = 'block';
        }
        // Hide scroll-to-top button when in insights or non-library views
        try {
            const scrollBtn = document.getElementById('scrollTopBtn');
            if (scrollBtn) scrollBtn.classList.remove('show');
        } catch (e) { }

        this.currentView = 'insights';
        const backBtn3 = document.getElementById('backBtn');
        if (backBtn3) backBtn3.style.display = 'none';
        document.getElementById('searchInput').style.display = 'none';
        document.getElementById('settingsBtn').style.display = 'flex';
        document.getElementById('detailSettingsBtn').style.display = 'none';
        this.setInsightsButtonState(true);
        this.updateInsightsSubtitle(normalizedFilter);
        // Push history state so insights can be addressable as its own page
        try {
            const base = this.basePath || '/';
            const prefix = base.endsWith('/') ? base : base + '/';
            const url = prefix + 'insights';
            window.history.pushState({ view: 'insights' }, '', url);
        } catch (e) { }

        const controlsRow = document.querySelector('.controls-row');
        if (controlsRow) {
            controlsRow.classList.add('hidden');
            controlsRow.style.display = 'none';
        }

        const tabsRow = document.querySelector('.tabs-row');
        if (tabsRow) {
            tabsRow.classList.remove('hidden');
            tabsRow.style.display = '';
        }

        this.renderInsights(normalizedFilter);
        // Trigger fetching missing duration data in background and re-render when available
        this.fetchMissingDurationsForCategory(normalizedFilter).catch(() => { });
    }

    setInsightsButtonState(isActive) {
        const btn = document.getElementById('insightsBtn');
        if (btn) {
            btn.classList.toggle('active', !!isActive);
        }
    }

    // Fetch missing duration/time-to-beat data for items in a given insights category
    async fetchMissingDurationsForCategory(categoryFilter = null) {
        try {
            const categoriesToCheck = [];
            if (!categoryFilter) {
                categoriesToCheck.push('movies', 'tv', 'anime', 'games');
            } else {
                categoriesToCheck.push(categoryFilter);
            }

            let updated = false;

            for (const key of categoriesToCheck) {
                const items = this.data.items.filter(it => it.type === key);
                if (!items || !items.length) continue;

                const missing = items.filter(it => {
                    if (key === 'movies') return !(it.runtime && String(it.runtime).trim());
                    if (key === 'tv' || key === 'anime') return !(it.episodes && String(it.episodes).trim()) || !(it.episodeRuntime && String(it.episodeRuntime).trim());
                    if (key === 'games') return !(it.timeToBeat && String(it.timeToBeat).trim());
                    return false;
                });

                if (!missing.length) continue;

                // Fetch details for each missing item (sequential to avoid rate limits)
                for (const item of missing) {
                    try {
                        const apiId = this.getNormalizedExternalId(item.type, item.externalApiId) || item.externalApiId || item.id;
                        if (!apiId) continue;
                        const detail = await this.fetchSelectionDetails(item.type, apiId);
                        if (!detail) continue;

                        if (key === 'movies') {
                            const runtime = detail.runtime_minutes ?? detail.runtime ?? null;
                            if (runtime != null) {
                                item.runtime = String(runtime);
                                updated = true;
                            }
                        } else if (key === 'tv' || key === 'anime') {
                            const eps = detail.episode_count ?? detail.number_of_episodes ?? detail.episode_count ?? null;
                            const epMin = detail.average_episode_runtime_minutes ?? detail.average_episode_duration_minutes ?? null;
                            if (eps != null) { item.episodes = String(eps); updated = true; }
                            if (epMin != null) { item.episodeRuntime = String(epMin); updated = true; }
                        } else if (key === 'games') {
                            const ttb = detail.time_to_beat ?? detail.timeToBeat ?? null;
                            if (ttb) {
                                // store the object or average minutes as string
                                if (ttb.average_minutes != null) {
                                    item.timeToBeat = String(ttb.average_minutes);
                                } else if (ttb.average_hours != null) {
                                    item.timeToBeat = String(Math.round(ttb.average_hours * 60));
                                } else {
                                    item.timeToBeat = JSON.stringify(ttb);
                                }
                                updated = true;
                            }
                        }

                        // update matching item in this.data.items (by id)
                        const idx = this.data.items.findIndex(i => i.id === item.id);
                        if (idx !== -1) this.data.items[idx] = item;
                        // Persist updated fields to server DB
                        try {
                            const payload = { id: item.id };
                            if (key === 'movies' && item.runtime) payload.runtime = item.runtime;
                            if ((key === 'tv' || key === 'anime') && (item.episodes || item.episodeRuntime)) {
                                if (item.episodes) payload.episodes = item.episodes;
                                if (item.episodeRuntime) payload.episodeRuntime = item.episodeRuntime;
                            }
                            if (key === 'games' && item.timeToBeat) payload.timeToBeat = item.timeToBeat;

                            // Send PATCH to /update to persist
                            if (Object.keys(payload).length > 1) {
                                apiFetch(`${API_URL}/update`, {
                                    method: 'PATCH',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(payload)
                                }).then(resp => {
                                    if (!resp.ok) return resp.text().then(t => console.warn('Persist update failed', t));
                                }).catch(err => console.warn('Persist update error', err));
                            }
                        } catch (e) {
                            console.warn('Failed to persist updated item', e);
                        }
                    } catch (err) {
                        console.warn('Failed to fetch missing duration for', item, err);
                    }
                }
            }

            if (updated) {
                // Re-render insights to reflect new durations
                try { this.renderInsights(this.currentInsightsCategory); } catch (e) { }
            }
        } catch (e) {
            console.warn('fetchMissingDurationsForCategory failed', e);
        }
    }

    renderInsights(categoryFilter = this.currentInsightsCategory) {
        const container = document.getElementById('insightsContent');
        if (!container) return;

        const baseCategories = [
            { key: 'movies', label: 'Movies' },
            { key: 'tv', label: 'TV Series' },
            { key: 'anime', label: 'Anime' },
            { key: 'games', label: 'Games' },
            { key: 'music', label: 'Music' }
        ];

        const normalizedFilter = this.normalizeInsightsCategory(categoryFilter);
        this.currentInsightsCategory = normalizedFilter;

        const categories = baseCategories.filter(cat => !normalizedFilter || cat.key === normalizedFilter);

        if (categories.length === 0) {
            container.innerHTML = `
                <section class="insights-category">
                    <header class="insights-category-header">
                        <h3 class="insights-category-title">No Insights Available</h3>
                        <span class="insights-category-subtitle">Start adding titles to unlock insights.</span>
                    </header>
                </section>
            `;
            return;
        }

        const sections = categories.map(({ key, label }) => {
            const items = this.data.items.filter(item => item.type === key);
            if (items.length === 0) {
                return '';
            }

            const totalCount = items.length;
            const rankedItems = items
                .map(item => ({ ...item, myRank: parseFloat(item.myRank) || 0 }))
                .filter(item => item.myRank > 0);

            const averageRank = rankedItems.length
                ? (rankedItems.reduce((sum, item) => sum + item.myRank, 0) / rankedItems.length)
                : null;

            const genreCounts = new Map();
            items.forEach(item => {
                if (!item.genre) return;
                item.genre.split(',').forEach(raw => {
                    const trimmed = raw.trim();
                    if (!trimmed) return;
                    const keyLower = trimmed.toLowerCase();
                    const existing = genreCounts.get(keyLower) || { count: 0, label: trimmed };
                    existing.count += 1;
                    genreCounts.set(keyLower, existing);
                });
            });

            let topGenre = null;
            let topGenreCount = 0;
            genreCounts.forEach(({ count, label }) => {
                if (count > topGenreCount) {
                    topGenreCount = count;
                    topGenre = label;
                }
            });

            const topRankedItem = rankedItems.length
                ? rankedItems.reduce((best, item) => (item.myRank > best.myRank ? item : best), rankedItems[0])
                : null;
            const lowestRankedItem = rankedItems.length
                ? rankedItems.reduce((worst, item) => (item.myRank < worst.myRank ? item : worst), rankedItems[0])
                : null;

            let latestYear = null;
            items.forEach(item => {
                const year = parseInt(item.year, 10);
                if (!isNaN(year)) {
                    if (latestYear === null || year > latestYear) {
                        latestYear = year;
                    }
                }
            });

            const avgDisplay = averageRank !== null ? averageRank.toFixed(1) : '—';
            const ratedCountDisplay = rankedItems.length;
            const latestYearDisplay = latestYear !== null ? latestYear : '—';

            const palette = ['#4975ff', '#7A5CFF', '#FF6B6B', '#FFC260', '#26C6DA'];
            const sortedGenres = Array.from(genreCounts.values())
                .sort((a, b) => b.count - a.count)
                .slice(0, 5);
            const maxGenreCount = sortedGenres.reduce((max, genre) => Math.max(max, genre.count), 0);
            const genreListMarkup = sortedGenres.length
                ? `
                    <div class="insights-genre-bars">
                        ${sortedGenres.map(({ label: genreLabel, count }, index) => {
                    const widthPercent = maxGenreCount ? (count / maxGenreCount) * 100 : 0;
                    const safeName = this.escapeHtml(this.formatTitleCase(genreLabel));
                    return `
                                <div class="insights-genre-bar">
                                    <span class="insights-genre-bar-label">${safeName}</span>
                                    <div class="insights-genre-bar-meter" data-count="${count}">
                                        <span class="insights-genre-bar-fill" style="width: ${widthPercent}%;">
                                            <span class="insights-genre-bar-tooltip">${count} title${count === 1 ? '' : 's'}</span>
                                        </span>
                                    </div>
                                </div>
                            `;
                }).join('')}
                    </div>
                `
                : `<p class="insights-empty insights-genre-empty">No genre data yet.</p>`;

            const roleConfigMap = {
                movies: { field: 'directorCreator', label: 'Director/Creator' },
                tv: { field: 'directorCreator', label: 'Director/Creator' },
                anime: { field: 'studio', label: 'Studio' },
                games: { field: 'developer', label: 'Developer' }
            };

            const roleConfig = roleConfigMap[key];
            let creatorInsightsMarkup = '';
            if (roleConfig) {
                const entityStats = new Map();

                items.forEach(item => {
                    const raw = item?.[roleConfig.field];
                    if (!raw) return;

                    raw.split(',')
                        .map(name => name?.trim())
                        .filter(Boolean)
                        .forEach(name => {
                            const normalized = name.toLowerCase();
                            if (!entityStats.has(normalized)) {
                                entityStats.set(normalized, {
                                    name,
                                    count: 0,
                                    ratedCount: 0,
                                    totalRank: 0
                                });
                            }
                            const stat = entityStats.get(normalized);
                            stat.count += 1;
                            const rank = parseFloat(item.myRank);
                            if (Number.isFinite(rank) && rank > 0) {
                                stat.ratedCount += 1;
                                stat.totalRank += rank;
                            }
                        });
                });

                const entities = Array.from(entityStats.values());

                const favouriteEntity = entities
                    .filter(entity => entity.ratedCount > 0)
                    .map(entity => ({
                        ...entity,
                        average: entity.totalRank / entity.ratedCount
                    }))
                    .sort((a, b) =>
                        b.average - a.average ||
                        b.ratedCount - a.ratedCount ||
                        b.count - a.count ||
                        a.name.localeCompare(b.name)
                    )[0];

                const mostWatchedEntity = entities
                    .slice()
                    .sort((a, b) =>
                        b.count - a.count ||
                        b.ratedCount - a.ratedCount ||
                        a.name.localeCompare(b.name)
                    )[0];

                const favouriteMarkup = favouriteEntity
                    ? `
                        <div class="insights-role-card">
                            <span class="insights-role-card-title">Favourite ${roleConfig.label}</span>
                            <span class="insights-role-card-name">${this.escapeHtml(favouriteEntity.name)}</span>
                            <span class="insights-role-card-meta">${favouriteEntity.average.toFixed(1)} ★ avg • ${favouriteEntity.ratedCount} rated</span>
                        </div>
                    `
                    : `
                        <div class="insights-role-card insights-role-card--empty">
                            <span class="insights-role-card-title">Favourite ${roleConfig.label}</span>
                            <span>No rated data yet.</span>
                        </div>
                    `;

                const watchedMarkup = mostWatchedEntity
                    ? `
                        <div class="insights-role-card">
                            <span class="insights-role-card-title">Most Watched ${roleConfig.label}</span>
                            <span class="insights-role-card-name">${this.escapeHtml(mostWatchedEntity.name)}</span>
                            <span class="insights-role-card-meta">${mostWatchedEntity.count} title${mostWatchedEntity.count === 1 ? '' : 's'}</span>
                        </div>
                    `
                    : `
                        <div class="insights-role-card insights-role-card--empty">
                            <span class="insights-role-card-title">Most Watched ${roleConfig.label}</span>
                            <span>No data yet.</span>
                        </div>
                    `;

                creatorInsightsMarkup = `
                    <div class="insights-role-insights">
                        <div class="insights-role-grid">
                            ${favouriteMarkup}
                            ${watchedMarkup}
                        </div>
                    </div>
                `;
            }

            const topRatedMarkup = topRankedItem
                ? `
                    <div class="insights-top-item">
                        <span class="insights-top-item-label">Top Rated</span>
                        <span class="insights-top-item-value">${this.escapeHtml(topRankedItem.name)}</span>
                        <span class="insights-top-item-score">${topRankedItem.myRank.toFixed(1)} ★</span>
                    </div>
                `
                : `
                    <div class="insights-top-item insights-top-item--empty">
                        <span class="insights-top-item-label">Top Rated</span>
                        <span>No ranked titles yet</span>
                    </div>
                `;

            const lowestRatedMarkup = lowestRankedItem
                ? `
                    <div class="insights-low-item">
                        <span class="insights-low-item-label">Lowest Rated</span>
                        <span class="insights-low-item-value">${this.escapeHtml(lowestRankedItem.name)}</span>
                        <span class="insights-low-item-score">${lowestRankedItem.myRank.toFixed(1)} ★</span>
                    </div>
                `
                : `
                    <div class="insights-low-item insights-low-item--empty">
                        <span class="insights-low-item-label">Lowest Rated</span>
                        <span>No ranked titles yet</span>
                    </div>
                `;

            // Calculate estimated total time spent for this category (in minutes)
            const parseMinutes = (v) => {
                if (v == null) return null;
                if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
                if (typeof v === 'string') {
                    const num = parseFloat(String(v).replace(/[^0-9.]/g, ''));
                    return Number.isFinite(num) ? Math.round(num) : null;
                }
                return null;
            };

            let totalMinutesSpent = 0;
            try {
                if (key === 'movies') {
                    items.forEach(item => {
                        const m = parseMinutes(item.runtime) ?? parseMinutes(item.runtime_minutes) ?? parseMinutes(item.runtimeMinutes) ?? 0;
                        totalMinutesSpent += Number.isFinite(m) ? m : 0;
                    });
                } else if (key === 'tv' || key === 'anime') {
                    items.forEach(item => {
                        const eps = Number(item.episodes || item.episode_count || item.episodeCount || 0) || 0;
                        let epMin = parseMinutes(item.episodeRuntime) ?? parseMinutes(item.episode_runtime_minutes) ?? parseMinutes(item.episodeRuntimeMinutes) ?? null;
                        if (!Number.isFinite(epMin) || epMin == null) {
                            const info = this.getEpisodeRuntimeInfo(item);
                            epMin = (info && Number.isFinite(info.averageMinutes)) ? info.averageMinutes : 0;
                        }
                        totalMinutesSpent += (Number.isFinite(eps) ? eps : 0) * (Number.isFinite(epMin) ? epMin : 0);
                    });
                } else if (key === 'games') {
                    items.forEach(item => {
                        // timeToBeat may be stored as a JSON string, a plain minutes string, or an object.
                        let raw = item.timeToBeat || item.time_to_beat || item.timeToBeatInfo || null;
                        let ttbObj = null;
                        if (typeof raw === 'string') {
                            const s = raw.trim();
                            if (s.startsWith('{') || s.startsWith('[')) {
                                try { ttbObj = JSON.parse(s); } catch (e) { ttbObj = null; }
                            } else {
                                // numeric string like "120" (minutes)
                                const n = parseMinutes(s);
                                if (n != null) {
                                    totalMinutesSpent += n;
                                    return;
                                }
                            }
                        } else if (typeof raw === 'object' && raw) {
                            ttbObj = raw;
                        }

                        const ttb = this.getTimeToBeatInfo(ttbObj);
                        let mins = (ttb && Number.isFinite(ttb.averageMinutes)) ? ttb.averageMinutes : null;
                        if (!Number.isFinite(mins)) {
                            mins = parseMinutes(item.timeToBeatMinutes) ?? parseMinutes(item.playtime) ?? parseMinutes(item.playTime) ?? 0;
                        }
                        totalMinutesSpent += Number.isFinite(mins) ? mins : 0;
                    });
                } else {
                    // fallback: try to use runtime-like fields
                    items.forEach(item => {
                        const m = parseMinutes(item.runtime) ?? parseMinutes(item.episodeRuntime) ?? 0;
                        totalMinutesSpent += Number.isFinite(m) ? m : 0;
                    });
                }
            } catch (e) {
                totalMinutesSpent = 0;
            }

            const totalDays = totalMinutesSpent ? Math.round((totalMinutesSpent / 1440) * 10) / 10 : 0;
            const totalHours = totalMinutesSpent ? Math.round((totalMinutesSpent / 60) * 10) / 10 : 0;
            let timeStatValue = totalDays ? `${totalDays}` : '0';
            let timeStatSub = totalMinutesSpent ? '' : 'No duration data available';

            if (key === 'movies') {
                const moviesWithRuntime = items.filter(it => parseMinutes(it.runtime) || parseMinutes(it.runtime_minutes) || parseMinutes(it.runtimeMinutes)).length;
                const missing = items.length - moviesWithRuntime;
                timeStatValue = `${totalDays} d (${totalHours} h)`;
                if (missing) {
                    timeStatSub = `${missing} missing runtime`;
                } else {
                    timeStatSub = `${totalHours} h across ${items.length} movie${items.length === 1 ? '' : 's'}`;
                }
            } else if (key === 'games') {
                const gamesWithTtb = items.filter(it => {
                    const raw = it.timeToBeat || it.time_to_beat || it.timeToBeatInfo || null;
                    let parsed = null;
                    if (typeof raw === 'string') {
                        const s = raw.trim();
                        if (s.startsWith('{') || s.startsWith('[')) {
                            try { parsed = JSON.parse(s); } catch (e) { parsed = null; }
                        } else if (s.length) {
                            const n = parseMinutes(s);
                            if (n) return true;
                        }
                    } else if (typeof raw === 'object' && raw) {
                        parsed = raw;
                    }
                    const ttb = this.getTimeToBeatInfo(parsed);
                    return (ttb && Number.isFinite(ttb.averageMinutes)) || parseMinutes(it.timeToBeatMinutes) || parseMinutes(it.playtime) || parseMinutes(it.playTime);
                }).length;
                const missing = items.length - gamesWithTtb;
                timeStatValue = `${totalDays} d (${totalHours} h)`;
                if (missing) {
                    timeStatSub = `${missing} missing time-to-beat`;
                } else {
                    timeStatSub = `${totalHours} h across ${items.length} game${items.length === 1 ? '' : 's'}`;
                }
            } else if (key === 'tv' || key === 'anime') {
                const contributing = items.filter(it => {
                    const eps = Number(it.episodes || it.episode_count || it.episodeCount || 0) || 0;
                    const epMin = parseMinutes(it.episodeRuntime) ?? parseMinutes(it.episode_runtime_minutes) ?? null;
                    const info = (!Number.isFinite(epMin) && it) ? this.getEpisodeRuntimeInfo(it) : null;
                    const effectiveEpMin = Number.isFinite(epMin) ? epMin : (info && Number.isFinite(info.averageMinutes) ? info.averageMinutes : 0);
                    return eps > 0 && effectiveEpMin > 0;
                }).length;
                const missing = items.length - contributing;
                timeStatValue = `${totalDays} d (${totalHours} h)`;
                if (missing) {
                    timeStatSub = `${missing} missing episodes/runtime`;
                } else {
                    timeStatSub = `${totalHours} h across ${items.length} ${key === 'tv' ? 'TV' : 'Anime'} series`;
                }
            } else {
                timeStatValue = `${totalDays} d (${totalHours} h)`;
                timeStatSub = `${totalHours} h across ${items.length} item${items.length === 1 ? '' : 's'}`;
            }
            const bucketLabels = ['0★', '0.5★', '1★', '1.5★', '2★', '2.5★', '3★', '3.5★', '4★', '4.5★', '5★'];
            const rankBuckets = Array(bucketLabels.length).fill(0);
            rankedItems.forEach(item => {
                const rawRank = parseFloat(item.myRank);
                if (!Number.isFinite(rawRank)) return;
                const clamped = Math.max(0, Math.min(5, rawRank));
                const bucketIndex = Math.round(clamped * 2);
                if (rankBuckets[bucketIndex] !== undefined) {
                    rankBuckets[bucketIndex] += 1;
                }
            });

            const maxBucketCount = rankBuckets.reduce((max, count) => Math.max(max, count), 0);
            const unratedCount = totalCount - rankedItems.length;

            const rankBarsMarkup = rankBuckets.map((count, index) => {
                const heightPercent = maxBucketCount ? Math.max((count / maxBucketCount) * 100, 8) : 0;
                const labelText = bucketLabels[index] || `${(index / 2).toFixed(1)}★`;
                return `
                    <div class="insights-rank-bar" data-count="${count}" data-star="${labelText}">
                        <div class="insights-rank-bar-visual" style="height: ${heightPercent}%;"></div>
                        <div class="insights-rank-label">${labelText}</div>
                    </div>
                `;
            }).join('');

            const rankChartMarkup = rankedItems.length
                ? `
                    <div class="insights-rank-bars">
                        ${rankBarsMarkup}
                    </div>
                    <div class="insights-rank-footer">
                        <span>${rankedItems.length} rated title${rankedItems.length === 1 ? '' : 's'}</span>
                        <span>${unratedCount} unrated</span>
                    </div>
                `
                : `
                    <p class="insights-rank-empty">
                        Add personal ranks to see the distribution of your favourites.
                    </p>
                `;

            return `
                <section class="insights-category">
                    <div class="insights-stat-grid">
                        <div class="insights-stat">
                            <span class="insights-stat-label">Total Entries</span>
                            <span class="insights-stat-value">${totalCount}</span>
                            <span class="insights-stat-subvalue">All items tracked</span>
                        </div>
                        <div class="insights-stat">
                            <span class="insights-stat-label">Time Spent (days)</span>
                            <span class="insights-stat-value">${this.escapeHtml(timeStatValue)}</span>
                            <span class="insights-stat-subvalue">${this.escapeHtml(timeStatSub)}</span>
                        </div>
                        <div class="insights-stat">
                            <span class="insights-stat-label">Average Rank</span>
                            <span class="insights-stat-value">${avgDisplay}</span>
                            <span class="insights-stat-subvalue">${averageRank !== null ? 'Across rated titles' : 'No rank data yet'}</span>
                        </div>
                        <div class="insights-stat">
                            <span class="insights-stat-label">Top Genre</span>
                            <span class="insights-stat-value">${topGenre ? this.escapeHtml(this.formatTitleCase(topGenre)) : '—'}</span>
                            <span class="insights-stat-subvalue">${topGenre ? `${topGenreCount} title${topGenreCount === 1 ? '' : 's'}` : 'No genre data yet'}</span>
                        </div>
                        <div class="insights-stat">
                            <span class="insights-stat-label">Latest Release</span>
                            <span class="insights-stat-value">${latestYearDisplay}</span>
                            <span class="insights-stat-subvalue">${latestYear !== null ? 'Newest release year' : 'No release year data'}</span>
                        </div>
                    </div>
                    <div class="insights-visuals">
                        <div class="insights-visual">
                            <div class="insights-visual-title">
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M3 17h2v-7H3v7zm4 0h2V7H7v10zm4 0h2v-4h-2v4zm4 0h2V9h-2v8zm4 0h2v-12h-2v12z"></path>
                                </svg>
                                Rank Distribution
                            </div>
                            ${rankChartMarkup}
                        </div>
                        <div class="insights-visual">
                            <div class="insights-visual-title">
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 2a8 8 0 0 1 7.32 11.07l-5.13-2.04a2 2 0 0 0-.51-.11l-1.66-5.54A2 2 0 0 0 12 5.5a2 2 0 0 0-1.92 2.5l-1.66 5.56a2 2 0 0 0-.51.11L2.81 13.1A8 8 0 0 1 12 4z"></path>
                                </svg>
                                Top Genres
                            </div>
                            ${genreListMarkup}
                            ${creatorInsightsMarkup}
                            <div class="insights-top-low-grid">
                                ${topRatedMarkup}
                                ${lowestRatedMarkup}
                            </div>
                        </div>
                    </div>
                </section>
            `;
        }).join('');

        container.innerHTML = sections;
    }

    normalizeInsightsCategory(category) {
        const allowed = ['movies', 'tv', 'anime', 'games', 'music'];
        if (!category) return null;
        return allowed.includes(category) ? category : null;
    }

    getInsightsCategoryForCurrentTab() {
        return this.normalizeInsightsCategory(this.currentTab);
    }

    getInsightsCategoryLabel(category) {
        const labels = {
            movies: 'Movies',
            tv: 'TV Series',
            anime: 'Anime',
            games: 'Games',
            music: 'Music'
        };
        return labels[category] || 'Collection';
    }

    updateInsightsSubtitle(category) {
        const subtitleEl = document.querySelector('.insights-subtitle');
        if (!subtitleEl) return;
        subtitleEl.textContent = '';
    }

    escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    formatTitleCase(value) {
        if (!value) return '';
        return value
            .split(' ')
            .map(word => {
                if (!word) return word;
                return word.charAt(0).toUpperCase() + word.slice(1);
            })
            .join(' ');
    }

    formatDepartmentLabel(department) {
        if (!department || typeof department !== 'string') return '';
        const normalized = department.trim();
        if (!normalized) return '';
        const replacements = {
            'Acting': 'Actor',
            'Actor': 'Actor',
            'Production': 'Producer',
            'Production Management': 'Producer',
            'Writing': 'Writer',
            'Directing': 'Director',
            'Sound': 'Sound',
            'Crew': 'Crew',
            'Costume & Make-Up': 'Costume & Make-Up',
            'Camera': 'Camera',
            'Art': 'Art',
            'Visual Effects': 'Visual Effects',
            'Lighting': 'Lighting',
            'Editing': 'Editor',
            'Additional Crew': 'Additional Crew'
        };
        const label = replacements[normalized] || normalized;
        return this.formatTitleCase(label);
    }

    normalizeActorRolesInput(value) {
        if (!value) return [];
        const rawList = Array.isArray(value) ? value : String(value).split(/[,|]/);
        const roles = [];
        const seen = new Set();
        rawList.forEach(role => {
            const label = this.formatDepartmentLabel(role);
            if (label && !seen.has(label)) {
                seen.add(label);
                roles.push(label);
            }
        });
        return roles;
    }

    truncateActorDescription(type, text) {
        if (!text) return '';
        if (type !== 'actors') return text;
        const normalized = text.trim().replace(/\s+/g, ' ');
        if (!normalized) return '';
        const words = normalized.split(' ');
        if (words.length <= 180) return normalized;
        return words.slice(0, 180).join(' ');
    }

    deriveActorRolesFromSources(detail = {}, creditsData = null) {
        const roles = [];
        const seen = new Set();
        // If this item is a Spotify artist (singer), always set role to 'Singer'
        if (detail && (detail.source === 'spotify' || detail.spotifyUrl || (detail.socialMedia && String(detail.socialMedia).includes('spotify')))) {
            return ['Singer'];
        }
        const isFemaleActor = detail?.gender === 1
            || detail?.gender === '1'
            || (typeof detail?.gender === 'string' && detail.gender.toLowerCase() === 'female');
        const normalizeRoleLabel = (role) => {
            const label = this.formatDepartmentLabel(role);
            if (label && label.toLowerCase() === 'actor' && isFemaleActor) {
                return 'Actress';
            }
            return label;
        };
        const addRole = (role) => {
            const label = normalizeRoleLabel(role);
            if (label && !seen.has(label)) {
                seen.add(label);
                roles.push(label);
            }
        };

        if (detail?.known_for_department) {
            addRole(detail.known_for_department);
        }

        if (creditsData) {
            const actingCredits =
                (Array.isArray(creditsData.movies) ? creditsData.movies.length : 0) +
                (Array.isArray(creditsData.tv) ? creditsData.tv.length : 0) +
                (Array.isArray(creditsData.cast) ? creditsData.cast.length : 0);
            if (actingCredits > 0) {
                addRole('Actor');
            }

            const crewDepartments = Array.isArray(creditsData.crewDepartments)
                ? creditsData.crewDepartments
                : [];
            crewDepartments.forEach(entry => {
                if (!entry) return;
                if (typeof entry === 'string') addRole(entry);
                else if (entry.department) addRole(entry.department);
            });

            if (Array.isArray(creditsData.crew)) {
                creditsData.crew.forEach(entry => addRole(entry?.department));
            }
        }

        if (!roles.length) {
            addRole('Actor');
        }

        const nonActorRoles = roles.filter(role => role !== 'Actor');
        if (nonActorRoles.length > 0) {
            return nonActorRoles;
        }

        return roles;
    }

    getActorRoles(item) {
        if (!item || item.type !== 'actors') return [];
        // If this is a Spotify-sourced artist, always return Singer
        if (item && (item.source === 'spotify' || item.spotifyUrl || (item.socialMedia && String(item.socialMedia).includes('spotify')))) {
            item.actorRoles = ['Singer'];
            return item.actorRoles;
        }

        if (Array.isArray(item.actorRoles) && item.actorRoles.length) {
            return item.actorRoles;
        }
        const derived = this.normalizeActorRolesInput(item.genre || item.known_for_department || '');
        if (derived.length) {
            item.actorRoles = derived;
            return derived;
        }
        return [];
    }

    formatRuntimeFromMinutes(minutes) {
        if (!Number.isFinite(minutes)) return '';
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        return hours ? `${hours}h ${mins}m` : `${mins}m`;
    }

    getEpisodeRuntimeInfo(metadata, fallbackRuntimes = []) {
        const result = {
            formatted: '',
            averageMinutes: null
        };

        if (!metadata) return result;

        const runtimes = [];
        const addRuntimeValue = (value) => {
            const num = Number(value);
            if (Number.isFinite(num)) {
                runtimes.push(num);
            }
        };

        const avgEpisodeMinutes = metadata.average_episode_runtime_minutes ?? metadata.average_episode_duration_minutes;
        addRuntimeValue(avgEpisodeMinutes);

        addRuntimeValue(metadata.omdb_episode_runtime_minutes);

        const averageEpisodeSeconds = metadata.average_episode_duration_seconds;
        if (Number.isFinite(averageEpisodeSeconds)) {
            addRuntimeValue(parseFloat((averageEpisodeSeconds / 60).toFixed(1)));
        }

        const arraysToConsider = [
            metadata.episode_runtime_minutes,
            metadata.episode_run_time,
            fallbackRuntimes
        ];

        arraysToConsider.forEach(arr => {
            if (Array.isArray(arr)) {
                arr.forEach(addRuntimeValue);
            } else if (arr != null) {
                addRuntimeValue(arr);
            }
        });

        const validRuntimes = [...new Set(runtimes.filter(Number.isFinite).map(val => Number(val)))];
        if (validRuntimes.length === 0) return result;

        const sum = validRuntimes.reduce((acc, val) => acc + val, 0);
        result.averageMinutes = Math.round((sum / validRuntimes.length) * 10) / 10;

        if (validRuntimes.length === 1) {
            result.formatted = `${validRuntimes[0]} min`;
            return result;
        }

        const min = Math.min(...validRuntimes);
        const max = Math.max(...validRuntimes);
        result.formatted = `${min}-${max} min`;
        return result;
    }

    getTimeToBeatInfo(timeToBeat) {
        const result = {
            formatted: '',
            averageMinutes: null
        };

        if (!timeToBeat) return result;

        const averageMinutes = Number.isFinite(timeToBeat.average_minutes)
            ? timeToBeat.average_minutes
            : (Number.isFinite(timeToBeat.average_hours) ? timeToBeat.average_hours * 60 : null);

        if (Number.isFinite(averageMinutes)) result.averageMinutes = Math.round(averageMinutes);

        if (result.averageMinutes != null) {
            const avgHours = result.averageMinutes / 60;
            if (avgHours >= 1) {
                result.formatted = `${parseFloat(avgHours.toFixed(1))} h`;
            } else {
                result.formatted = `${result.averageMinutes} min`;
            }
        }

        return result;
    }

    getNormalizedExternalId(type, externalId) {
        if (!externalId) return null;
        const idString = String(externalId);
        if (type === 'games' && idString.startsWith('steam_')) return idString.slice(6);
        if (type === 'anime' && idString.startsWith('mal_')) return idString.slice(4);
        if ((type === 'movies' || type === 'tv') && idString.startsWith('tmdb_')) return idString.slice(5);
        return idString;
    }

    getDetailBannerSource(item) {
        if (!item) return '';
        if (item.bannerBase64) {
            // Proxy GitHub URLs even if they're in bannerBase64 (happens when bannerPath is mapped to bannerBase64 during load)
            return this.getProxiedImageUrl(item.bannerBase64);
        }
        if (item.bannerPath) {
            const p = item.bannerPath.startsWith('http') ? item.bannerPath : `${API_URL}/${item.bannerPath}`;
            return this.getProxiedImageUrl(p);
        }
        // Avoid returning generated asset banner for Spotify artists (they use external images)
        // Treat non-numeric externalApiId or explicit spotify source as Spotify
        const isSpotify = (item.source === 'spotify') ||
            (item.externalApiId && !/^[0-9]+$/.test(String(item.externalApiId))) ||
            (item.spotifyUrl && item.spotifyUrl.includes('spotify')) ||
            (item.socialMedia && item.socialMedia.includes('spotify'));
        if (isSpotify) {
            // Prefer poster image for artist (square) rather than banner
            if (item.posterBase64) return this.getProxiedImageUrl(item.posterBase64);
            if (item.posterPath) {
                const p = item.posterPath.startsWith('http') ? item.posterPath : `${API_URL}/${item.posterPath}`;
                return this.getProxiedImageUrl(p);
            }
            return '';
        }
        return '';
    }

    shouldDelayDetailBanner(item) {
        return !!this.getDetailBannerSource(item);
    }

    async preloadDetailBanner(item, timeout = 5000) {
        const bannerSrc = this.getDetailBannerSource(item);
        if (!bannerSrc) return;
        await this.preloadImageSource(bannerSrc, timeout);
    }

    preloadImageSource(src, timeout = 5000) {
        if (!src) return Promise.resolve();
        if (!this.imagePreloadCache) {
            this.imagePreloadCache = new Map();
        }
        if (this.imagePreloadCache.get(src)) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const img = new Image();
            let settled = false;
            const finish = () => {
                if (!settled) {
                    settled = true;
                    this.imagePreloadCache.set(src, true);
                    resolve();
                }
            };
            const timer = setTimeout(() => {
                console.warn('Image preload timed out for', src);
                finish();
            }, timeout);
            img.onload = () => {
                clearTimeout(timer);
                finish();
            };
            img.onerror = () => {
                clearTimeout(timer);
                finish();
            };
            img.src = src;
        });
    }

    async waitForImageElementLoad(img, timeout = 5000) {
        if (!img) return;
        if (img.complete && img.naturalWidth > 0) return;

        const decodePromise = img.decode ? img.decode().catch(() => { }) : null;

        await new Promise((resolve) => {
            let settled = false;
            const cleanup = () => {
                img.removeEventListener('load', onLoad);
                img.removeEventListener('error', onError);
                clearTimeout(timer);
            };
            const finish = () => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    resolve();
                }
            };
            const onLoad = () => finish();
            const onError = () => finish();
            const timer = setTimeout(() => finish(), timeout);
            img.addEventListener('load', onLoad, { once: true });
            img.addEventListener('error', onError, { once: true });
            if (decodePromise) {
                decodePromise.then(() => finish());
            }
        });
    }

    async waitForDetailBannerReady(item, timeout = 5000) {
        const bannerImageEl = document.getElementById('bannerImage');
        if (!bannerImageEl) return;
        const expectedId = item?.id || `${item?.type || ''}_${item?.externalApiId || ''}`;
        if (!expectedId) return;
        if (bannerImageEl.dataset.bannerItemId === expectedId &&
            bannerImageEl.complete &&
            bannerImageEl.naturalWidth > 0) {
            return;
        }
        await this.waitForImageElementLoad(bannerImageEl, timeout);
    }

    handleBackNavigation() {
        // Always go back 1 step to the previous view
        if (this.currentView === 'library') {
            // From library view, go back to home tab
            this.showHomeView();
            return;
        }

        if (this.currentView === 'collection') {
            // Check if we're coming from "add items to collection" view
            if (this.collectionToReturnTo) {
                // Return to the collection view
                this.showCollectionView([this.collectionToReturnTo], null);
                this.collectionToReturnTo = null; // Clear the return target
                return;
            }
            // From collection view, always go back to the library view
            this.showLibraryView();
            return;
        }

        if (this.currentView === 'sequels') {
            // Check if this is a collection view
            if (this.sequelsViewSource === 'collection') {
                // From collection view, always go back to the library view
                this.showLibraryView();
                return;
            }

            // From sequels view, go back to library and restore previous tab
            document.getElementById('sequelsView').style.display = 'none';
            document.getElementById('libraryView').style.display = 'block';
            const backBtnEl = document.getElementById('backBtn');
            if (backBtnEl) backBtnEl.style.display = 'none';
            document.getElementById('searchInput').style.display = 'block';
            document.getElementById('settingsBtn').style.display = 'inline-block';
            // Show controls row when returning to library view
            const controlsRow = document.querySelector('.controls-row');
            if (controlsRow && this.currentTab !== 'home') {
                controlsRow.classList.remove('hidden');
                controlsRow.style.display = ''; // Remove inline style to allow CSS to control display
            }
            document.querySelector('.tabs-row').classList.remove('hidden');
            // Hide "Add Items" button if it exists
            const addItemsBtn = document.querySelector('.add-items-to-collection-btn');
            if (addItemsBtn) {
                addItemsBtn.style.display = 'none';
            }
            // Clear search input
            document.getElementById('searchInput').value = '';
            this.currentView = 'library';
            this.previousView = null;
            this.sequelsViewSource = null;
            this.sequelsViewSourceItem = null;
            this.currentSequelsResults = []; // Clear sequels results

            // Restore previous tab if it was tracked
            if (this.previousTab) {
                this.switchTab(this.previousTab);
            }

            this.previousTab = null;
            this.renderLibrary();
            return;
        }

        if (this.currentView === 'detail') {
            // From detail view, go back to previous view
            if (this.previousView === 'search') {
                // Return to search view and restore state
                this.restoreSearchView();
                return;
            } else if (this.previousView === 'sequels') {
                // Check if sequels view was from external source, collection, or library
                if (this.sequelsViewSourceItem) {
                    if (this.sequelsViewSource === 'collection') {
                        // Restore collection view using the stored collection
                        // First try to use currentViewedCollection if it exists
                        let collectionToShow = null;
                        if (this.currentViewedCollection) {
                            collectionToShow = this.collections.find(c => c.id === this.currentViewedCollection.id);
                        }

                        // If not found, try to find by item ID
                        if (!collectionToShow) {
                            const collectionsContainingItem = this.collections.filter(c =>
                                c.itemIds && c.itemIds.includes(this.sequelsViewSourceItem.id)
                            );
                            if (collectionsContainingItem.length > 0) {
                                collectionToShow = collectionsContainingItem[0];
                            }
                        }

                        if (collectionToShow) {
                            // Ensure we have the full collection data
                            this.showCollectionView([collectionToShow], this.sequelsViewSourceItem);
                        } else {
                            // No collection found, go back to library
                            this.showLibraryView();
                        }
                        return;
                    } else if (this.sequelsViewSource === 'mal') {
                        // Restore MAL sequels view
                        this.showAllRelatedAnimeFromMAL(this.sequelsViewSourceItem);
                        return;
                    } else if (this.sequelsViewSource === 'steam') {
                        // Restore Steam sequels view
                        this.showAllRelatedGamesFromSteam(this.sequelsViewSourceItem);
                        return;
                    } else if (this.sequelsViewSource === 'tmdb') {
                        // Restore TMDB sequels view
                        this.showAllRelatedMoviesSeriesFromTMDB(this.sequelsViewSourceItem);
                        return;
                    }
                }

                // Go back to library sequels view - find the base name from current item
                const baseName = this.extractBaseAnimeName(this.currentItem?.name || '');
                const sequels = this.data.items.filter(item => {
                    if (item.type !== 'anime') return false;
                    const itemBaseName = this.extractBaseAnimeName(item.name);
                    return itemBaseName.toLowerCase() === baseName.toLowerCase();
                }).sort((a, b) => {
                    const yearA = parseInt(a.year) || 0;
                    const yearB = parseInt(b.year) || 0;
                    if (yearA !== yearB) return yearA - yearB;
                    return a.name.localeCompare(b.name);
                });

                // Show sequels view
                document.getElementById('detailView').style.display = 'none';
                document.getElementById('sequelsView').style.display = 'block';
                // Hide banner for non-collection views
                document.getElementById('sequelsBannerContainer').style.display = 'none';
                document.getElementById('sequelsView').classList.remove('has-banner');
                // Update title and count separately
                document.getElementById('sequelsTitle').textContent = baseName;
                document.getElementById('sequelsItemCount').textContent = `${sequels.length} ${sequels.length === 1 ? 'item' : 'items'}`;
                document.getElementById('sequelsCompletionRate').textContent = '';

                // Render sequels
                const container = document.getElementById('sequelsGridContainer');
                container.innerHTML = '';
                sequels.forEach(item => {
                    container.appendChild(this.createGridItem(item));
                });

                this.currentView = 'sequels';
                this.sequelsViewSource = 'library';
                this.sequelsViewSourceItem = this.currentItem;
                this.previousView = 'library';
            } else if (this.navigationStack.length > 0) {
                // If there's something in the navigation stack, go back to it
                const previousItem = this.navigationStack.pop();
                this.currentItem = previousItem;
                this.openDetailView(previousItem, { historyMode: 'replace' });
            } else {
                // Otherwise, go back to library view
                this.showLibraryView();
            }
            return;
        }

        // Otherwise, go back to library view
        this.showLibraryView();
    }

    extractBaseAnimeName(animeName) {
        // Extract base name by removing season numbers, sequel indicators, etc.
        // Examples: "Boku no Hero Academia 2nd Season" -> "Boku no Hero Academia"
        //           "Attack on Titan Season 4" -> "Attack on Titan"

        let baseName = animeName.trim();

        // Remove common sequel/season patterns
        const patterns = [
            /\s*\d+(st|nd|rd|th)\s*Season/i,
            /\s*Season\s*\d+/i,
            /\s*S\d+/i,
            /\s*-\s*[^-]+$/, // Remove everything after dash (e.g., "Name - Sequel")
            /\s*\(.*sequel.*\)/i,
            /\s*\(.*season.*\)/i,
            /\s*Part\s*\d+/i,
            /\s*\d+\s*$/, // Remove trailing numbers
            // Remove subtitles after colon only if they're clearly additional content
            // Don't remove if the part before colon is very short (likely subtitle, not main title)
            /:\s*(?:The|A|An)\s+[^:]+$/, // Remove ": The ..." or ": A ..." at the end
        ];

        for (const pattern of patterns) {
            baseName = baseName.replace(pattern, '');
        }

        // If there's a colon and the part before it is substantial (at least 3 words or 15 chars),
        // consider taking only the part before the colon as base name
        // This handles cases like "Trinity Seven: Nanatsu no Taizai to Nana Madoushi"
        // But keeps "Nanatsu no Taizai: Grudge of Edinburgh" intact
        const colonIndex = baseName.indexOf(':');
        if (colonIndex > 0) {
            const beforeColon = baseName.substring(0, colonIndex).trim();
            const afterColon = baseName.substring(colonIndex + 1).trim();

            // If the part before colon is substantial and contains what looks like a complete title
            // and the part after contains words that might indicate it's a different series
            if (beforeColon.length >= 10 && afterColon.length > 5) {
                // Check if after colon contains "no" (Japanese particle, suggesting it's a different title)
                // or if before colon is already a complete-sounding title
                const beforeWords = beforeColon.split(/\s+/).length;
                if (beforeWords >= 2) {
                    // Take only the part before colon as base name
                    baseName = beforeColon;
                }
            }
        }

        return baseName.trim();
    }

    calculateTitleOverlap(str1, str2) {
        // Calculate how many characters match at the start of both strings
        let overlap = 0;
        const minLen = Math.min(str1.length, str2.length);
        for (let i = 0; i < minLen; i++) {
            if (str1[i] === str2[i]) {
                overlap++;
            } else {
                break;
            }
        }
        return overlap;
    }

    extractFranchiseBaseName(animeName) {
        // Extract franchise base name by removing series suffixes and season indicators
        // Examples: "Dragon Ball Super" -> "Dragon Ball"
        //           "Dragon Ball Z" -> "Dragon Ball"
        //           "Nanatsu no Taizai" -> "Nanatsu no Taizai"

        let baseName = animeName.trim();

        // Remove common series suffixes (Super, Z, GT, etc.)
        const seriesSuffixes = [
            /\s+Super\s*$/i,
            /\s+Z\s*$/i,
            /\s+GT\s*$/i,
            /\s+Kai\s*$/i,
            /\s+Heroes\s*$/i,
            /\s+Evolution\s*$/i,
            // Remove season numbers
            /\s*\d+(st|nd|rd|th)\s*Season/i,
            /\s*Season\s*\d+/i,
            /\s*S\d+/i,
        ];

        for (const pattern of seriesSuffixes) {
            baseName = baseName.replace(pattern, '');
        }

        // Remove common sequel/season patterns
        const patterns = [
            /\s*-\s*[^-]+$/, // Remove everything after dash
            /\s*\(.*sequel.*\)/i,
            /\s*\(.*season.*\)/i,
            /\s*Part\s*\d+/i,
            /\s*\d+\s*$/, // Remove trailing numbers
            /:\s*(?:The|A|An)\s+[^:]+$/, // Remove ": The ..." or ": A ..." at the end
        ];

        for (const pattern of patterns) {
            baseName = baseName.replace(pattern, '');
        }

        // Handle colons - if part before colon is substantial, use it
        const colonIndex = baseName.indexOf(':');
        if (colonIndex > 0) {
            const beforeColon = baseName.substring(0, colonIndex).trim();
            const afterColon = baseName.substring(colonIndex + 1).trim();

            if (beforeColon.length >= 10 && afterColon.length > 5) {
                const beforeWords = beforeColon.split(/\s+/).length;
                if (beforeWords >= 2) {
                    baseName = beforeColon;
                }
            }
        }

        return baseName.trim();
    }

    normalizeMalId(value) {
        if (value === null || value === undefined) return null;

        if (typeof value === 'number' && Number.isFinite(value)) {
            return value > 0 ? String(Math.trunc(value)) : null;
        }

        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return null;

            if (/^\d+$/.test(trimmed)) return trimmed;

            const malMatch = trimmed.match(/mal[_\-\s]?(\d+)/i);
            if (malMatch?.[1]) return malMatch[1];

            const urlMatch = trimmed.match(/myanimelist\.net\/anime\/(\d+)/i);
            if (urlMatch?.[1]) return urlMatch[1];

            const digits = trimmed.match(/(\d{3,})/);
            if (digits?.[1]) return digits[1];
        }

        return null;
    }

    getAnimeMalId(item) {
        if (!item || typeof item !== 'object') return null;

        const tryNormalize = (...values) => {
            for (const value of values) {
                const normalized = this.normalizeMalId(value);
                if (normalized) return normalized;
            }
            return null;
        };

        const directId = tryNormalize(
            item.externalApiId,
            item.externalAPIId,
            item.external_id,
            item.externalId,
            item.malId,
            item.mal_id,
            item.apiId,
            item.api_id
        );
        if (directId) return directId;

        const idNormalized = tryNormalize(item.id);
        if (idNormalized) return idNormalized;

        const containers = [
            item.extraMetadata,
            item.metadata,
            item.detailMetadata,
            item.details,
            item.externalDetails
        ];

        for (const container of containers) {
            if (!container) continue;

            if (typeof container === 'string') {
                try {
                    const parsed = JSON.parse(container);
                    const parsedId = tryNormalize(
                        parsed?.mal_id,
                        parsed?.malId,
                        parsed?.externalApiId,
                        parsed?.external_id
                    );
                    if (parsedId) return parsedId;
                } catch (err) {
                    // Ignore JSON parse errors
                }
            } else if (typeof container === 'object') {
                const parsedId = tryNormalize(
                    container.mal_id,
                    container.malId,
                    container.externalApiId,
                    container.external_id
                );
                if (parsedId) return parsedId;
            }
        }

        const urlFallback = tryNormalize(
            item.url,
            item.siteUrl,
            item.malUrl,
            item.detailUrl,
            item.link
        );
        if (urlFallback) return urlFallback;

        return null;
    }

    extractYouTubeId(url) {
        if (!url || typeof url !== 'string') return null;
        const patterns = [
            /youtube(?:-nocookie)?\.com\/embed\/([^?&\s]+)/i,
            /youtube(?:-nocookie)?\.com\/watch\?v=([^&\s]+)/i,
            /youtu\.be\/([^?&\s]+)/i
        ];
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match?.[1]) return match[1];
        }
        return null;
    }

    // Extract base game name (removes numbers, DLC indicators, etc.)
    extractBaseGameName(gameName) {
        let baseName = gameName.trim();

        // Remove common game sequel patterns
        const patterns = [
            /\s*\d+\s*$/, // Remove trailing numbers (e.g., "Far Cry 1" -> "Far Cry")
            /\s*:\s*.*$/, // Remove everything after colon (e.g., "Game: Subtitle")
            /\s*-\s*.*$/, // Remove everything after dash
            /\s*\(.*DLC.*\)/i,
            /\s*\(.*Expansion.*\)/i,
            /\s*\(.*Pack.*\)/i,
            /\s*DLC\s*$/i,
            /\s*Expansion\s*$/i,
            /\s*Remastered\s*$/i,
            /\s*Remake\s*$/i,
            /\s*Definitive Edition\s*$/i,
            /\s*GOTY\s*$/i,
            /\s*Edition\s*$/i
        ];

        for (const pattern of patterns) {
            baseName = baseName.replace(pattern, '');
        }

        return baseName.trim();
    }

    // Extract base movie/series name (removes numbers, sequel indicators, etc.)
    extractBaseMovieSeriesName(name) {
        let baseName = name.trim();

        // Remove common sequel/season patterns
        const patterns = [
            /\s*\d+\s*$/, // Remove trailing numbers
            /\s*:\s*.*$/, // Remove everything after colon (e.g., "Movie: Subtitle")
            /\s*-\s*.*$/, // Remove everything after dash
            /\s*\(.*sequel.*\)/i,
            /\s*\(.*season.*\)/i,
            /\s*Season\s*\d+/i,
            /\s*S\d+/i,
            /\s*Part\s*\d+/i,
            /\s*\d+(st|nd|rd|th)\s*Season/i,
            /\s*:\s*New Blood\s*$/i, // Special case for "Dexter: New Blood"
        ];

        for (const pattern of patterns) {
            baseName = baseName.replace(pattern, '');
        }

        return baseName.trim();
    }

    // Helper method to check if an item exists in the library
    isItemInLibrary(item) {
        if (!item) return false;

        // Check by externalApiId first (most reliable)
        if (item.externalApiId) {
            const found = this.data.items.find(libItem =>
                libItem.externalApiId === item.externalApiId &&
                libItem.type === item.type
            );
            if (found) return true;
        }

        // Check by name match (case-insensitive, trimmed)
        const itemNameLower = (item.name || '').toLowerCase().trim();
        if (itemNameLower) {
            const found = this.data.items.find(libItem =>
                (libItem.name || '').toLowerCase().trim() === itemNameLower &&
                libItem.type === item.type
            );
            if (found) return true;
        }

        return false;
    }

    // Helper method to find the library item that matches the given item
    findLibraryItem(item) {
        if (!item) return null;

        // Check by externalApiId first (most reliable)
        if (item.externalApiId) {
            const found = this.data.items.find(libItem =>
                libItem.externalApiId === item.externalApiId &&
                libItem.type === item.type
            );
            if (found) return found;
        }

        // Check by name match (case-insensitive, trimmed)
        const itemNameLower = (item.name || '').toLowerCase().trim();
        if (itemNameLower) {
            const found = this.data.items.find(libItem =>
                (libItem.name || '').toLowerCase().trim() === itemNameLower &&
                libItem.type === item.type
            );
            if (found) return found;
        }

        return null;
    }

    findAnimeSequels(animeItem) {
        const baseName = this.extractBaseAnimeName(animeItem.name);
        const sequels = this.data.items.filter(item => {
            if (item.type !== 'anime') return false;
            const itemBaseName = this.extractBaseAnimeName(item.name);
            return itemBaseName.toLowerCase() === baseName.toLowerCase();
        });

        // Sort by year (ascending), then by name if years are same
        return sequels.sort((a, b) => {
            const yearA = parseInt(a.year) || 0;
            const yearB = parseInt(b.year) || 0;
            if (yearA !== yearB) {
                return yearA - yearB;
            }
            return a.name.localeCompare(b.name);
        });
    }

    showSequelsView(animeItem) {
        // Prevent sequels view from opening in delete mode
        if (this.isDeleteMode) {
            return;
        }

        // Close any open menus
        this.closeSettingsMenu();
        this.closeDetailSettingsMenu();
        this.closeAddMenu();
        this.closeSortMenu();
        this.closeFilterMenu();

        const sequels = this.findAnimeSequels(animeItem);
        const baseName = this.extractBaseAnimeName(animeItem.name);

        // Track previous view and tab
        this.previousView = this.currentView;
        this.previousTab = this.currentTab;

        // Hide library and detail views, show sequels view
        document.getElementById('libraryView').style.display = 'none';
        document.getElementById('detailView').style.display = 'none';
        document.getElementById('collectionView').style.display = 'none';
        document.getElementById('searchView').style.display = 'none';
        document.getElementById('sequelsView').style.display = 'block';

        // Update header separately
        document.getElementById('sequelsTitle').textContent = baseName;
        document.getElementById('sequelsItemCount').textContent = `${sequels.length} ${sequels.length === 1 ? 'item' : 'items'}`;
        document.getElementById('sequelsCompletionRate').textContent = '';

        // Show back button in header (same place as normal)
        const backBtnEl = document.getElementById('backBtn');
        if (backBtnEl) backBtnEl.style.display = 'inline-block';
        document.getElementById('searchInput').style.display = 'none';
        document.getElementById('settingsBtn').style.display = 'none';
        document.querySelector('.controls-row').classList.add('hidden');
        document.querySelector('.tabs-row').classList.add('hidden');

        // Render sequels grid - items will open detail view when clicked
        const container = document.getElementById('sequelsGridContainer');
        container.innerHTML = '';
        sequels.forEach(item => {
            container.appendChild(this.createGridItem(item));
        });

        this.currentView = 'sequels';
        this.sequelsViewSource = 'library';
        this.sequelsViewSourceItem = animeItem;
    }

    showItemContextMenu(e, item) {
        // Close any existing context menu
        const existingMenu = document.getElementById('itemContextMenu');
        if (existingMenu) {
            existingMenu.remove();
        }

        // Create context menu
        const menu = document.createElement('div');
        menu.id = 'itemContextMenu';
        menu.className = 'anime-context-menu';

        let menuText = '';
        let handler = null;

        if (item.type === 'anime') {
            menuText = 'Show me all animes related to that anime';
            handler = () => this.showAllRelatedAnimeFromMAL(item);
        } else if (item.type === 'games') {
            menuText = 'Show me all games related to that game';
            handler = () => this.showAllRelatedGamesFromSteam(item);
        } else if (item.type === 'movies' || item.type === 'tv') {
            menuText = 'Show me all related movies/series';
            handler = () => this.showAllRelatedMoviesSeriesFromTMDB(item);
        }

        if (handler) {
            const showAllRelated = document.createElement('button');
            showAllRelated.className = 'context-menu-item';
            showAllRelated.textContent = menuText;
            showAllRelated.addEventListener('click', () => {
                menu.remove();
                handler();
            });

            menu.appendChild(showAllRelated);
        }

        // Add "Create Collection" option only for library items (not API items)
        const isLibraryItem = this.isItemInLibrary(item) && !item.id.startsWith('mal_') && !item.id.startsWith('steam_') && !item.id.startsWith('tmdb_');
        if (isLibraryItem) {
            // Check if item is in any collections
            const collectionsContainingItem = this.collections.filter(collection =>
                collection.itemIds && collection.itemIds.includes(item.id)
            );

            // Add "View Collection" option if item is in collections
            if (collectionsContainingItem.length > 0) {
                const viewCollection = document.createElement('button');
                viewCollection.className = 'context-menu-item';
                viewCollection.textContent = `View Collection${collectionsContainingItem.length > 1 ? 's' : ''} (${collectionsContainingItem.length})`;
                viewCollection.addEventListener('click', () => {
                    menu.remove();
                    this.showCollectionView(collectionsContainingItem, item);
                });

                menu.appendChild(viewCollection);
            }

            const createCollection = document.createElement('button');
            createCollection.className = 'context-menu-item';
            createCollection.textContent = 'Create Collection';
            createCollection.addEventListener('click', () => {
                menu.remove();
                this.showCollectionCreation(item);
            });

            menu.appendChild(createCollection);
        }

        // Position menu at cursor
        menu.style.position = 'fixed';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.style.zIndex = '10000';

        document.body.appendChild(menu);

        // Close menu when clicking outside
        const closeMenu = (event) => {
            if (!menu.contains(event.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
                document.removeEventListener('contextmenu', closeMenu);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeMenu);
            document.addEventListener('contextmenu', closeMenu);
        }, 0);
    }

    async showAllRelatedAnimeFromMAL(animeItem, options = {}) {
        const { recordHistory = true } = options;
        // Extract base name for searching
        const baseName = this.extractBaseAnimeName(animeItem.name);

        // Show loading state
        document.getElementById('libraryView').style.display = 'none';
        document.getElementById('detailView').style.display = 'none';
        document.getElementById('collectionView').style.display = 'none';
        document.getElementById('searchView').style.display = 'none';
        document.getElementById('sequelsView').style.display = 'block';
        // Hide banner for non-collection views
        document.getElementById('sequelsBannerContainer').style.display = 'none';
        document.getElementById('sequelsView').classList.remove('has-banner');
        document.getElementById('sequelsTitle').textContent = `Searching for "${baseName}"...`;
        document.getElementById('sequelsItemCount').textContent = '';
        document.getElementById('sequelsCompletionRate').textContent = '';
        const backBtnEl = document.getElementById('backBtn');
        if (backBtnEl) backBtnEl.style.display = 'inline-block';
        document.getElementById('searchInput').style.display = 'block';
        document.getElementById('settingsBtn').style.display = 'inline-block';
        document.querySelector('.controls-row').classList.add('hidden');
        document.querySelector('.tabs-row').classList.add('hidden');

        const container = document.getElementById('sequelsGridContainer');
        container.innerHTML = '<p style="text-align: center; color: var(--text-color);">Searching MAL API...</p>';

        try {
            // Search MAL API using Jikan
            const response = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(baseName)}&limit=25`);
            if (!response.ok) {
                throw new Error(`API error: ${response.statusText}`);
            }

            const data = await response.json();
            const results = data.data || [];

            if (results.length === 0) {
                container.innerHTML = `<p style="text-align: center; color: var(--text-color);">No anime found with name "${baseName}"</p>`;
                document.getElementById('sequelsTitle').textContent = `No results for "${baseName}"`;
                this.currentView = 'sequels';
                return;
            }

            // Filter results to only include anime from the same franchise
            // First extract the franchise base name (removes series suffixes like "Super", "Z", etc.)
            const franchiseBaseName = this.extractFranchiseBaseName(animeItem.name).toLowerCase().trim();
            const baseNameLower = baseName.toLowerCase().trim();

            const filteredResults = results.filter(anime => {
                const animeTitle = anime.title || anime.name || '';
                const animeTitleLower = animeTitle.toLowerCase().trim();
                const animeBaseName = this.extractBaseAnimeName(animeTitle).toLowerCase().trim();
                const animeFranchiseBase = this.extractFranchiseBaseName(animeTitle).toLowerCase().trim();

                // Primary check: franchise base names match (handles "Dragon Ball Super" vs "Dragon Ball Z")
                if (franchiseBaseName === animeFranchiseBase && franchiseBaseName.length > 0) {
                    return true;
                }

                // Secondary check: exact base name match (handles sequels like "Nanatsu no Taizai" vs "Nanatsu no Taizai Season 2")
                if (animeBaseName === baseNameLower) {
                    return true;
                }

                // Tertiary check: base name appears at the START of the result's base name
                // This handles cases like "Nanatsu no Taizai" matching "Nanatsu no Taizai: Grudge of Edinburgh"
                if (animeBaseName.startsWith(baseNameLower + ' ') ||
                    animeBaseName.startsWith(baseNameLower + ':') ||
                    animeBaseName.startsWith(baseNameLower + '：')) {
                    return true;
                }

                // Fourth check: result's base name appears at the START of search base name
                // This handles reverse cases
                if (baseNameLower.startsWith(animeBaseName + ' ') ||
                    baseNameLower.startsWith(animeBaseName + ':') ||
                    baseNameLower.startsWith(animeBaseName + '：')) {
                    return true;
                }

                // Fifth check: franchise base appears at start of result (handles "Dragon Ball" matching "Dragon Ball Super: Broly")
                if (animeTitleLower.startsWith(franchiseBaseName + ' ') ||
                    animeBaseName.startsWith(franchiseBaseName + ' ') ||
                    animeFranchiseBase.startsWith(franchiseBaseName + ' ')) {
                    return true;
                }

                // If titles are very similar (Levenshtein-like check for small differences)
                // Only if they share significant overlap at the start
                if (animeBaseName.length > 0 && baseNameLower.length > 0) {
                    const minLen = Math.min(animeBaseName.length, baseNameLower.length);
                    const overlap = this.calculateTitleOverlap(animeBaseName, baseNameLower);
                    // If 80% or more of the shorter name matches at the start, consider it a match
                    if (minLen >= 5 && overlap >= Math.min(animeBaseName.length, baseNameLower.length) * 0.8) {
                        return true;
                    }
                }

                return false;
            });

            if (filteredResults.length === 0) {
                container.innerHTML = `<p style="text-align: center; color: var(--text-color);">No anime found with matching base name "${baseName}"</p>`;
                document.getElementById('sequelsTitle').textContent = `No matching results for "${baseName}"`;
                this.currentView = 'sequels';
                return;
            }

            // Sort by release date (year)
            filteredResults.sort((a, b) => {
                const yearA = parseInt(a.year || a.aired?.prop?.from?.year || '0') || 0;
                const yearB = parseInt(b.year || b.aired?.prop?.from?.year || '0') || 0;
                if (yearA !== yearB) {
                    return yearA - yearB;
                }
                // If same year, sort by title
                const titleA = a.title || a.name || '';
                const titleB = b.title || b.name || '';
                return titleA.localeCompare(titleB);
            });

            // Convert MAL results to item format and render
            container.innerHTML = '';
            let itemsInLibrary = 0;
            this.currentSequelsResults = []; // Store items for search filtering
            filteredResults.forEach(anime => {
                // Create item from MAL data
                const malItem = {
                    id: anime.mal_id || anime.id || `mal_${Date.now()}_${Math.random()}`,
                    type: 'anime',
                    name: anime.title || anime.name || 'Untitled',
                    year: anime.year || anime.aired?.prop?.from?.year || '',
                    genre: anime.genres ? anime.genres.map(g => g.name || g).join(', ') : '',
                    description: anime.synopsis || '',
                    userScore: anime.score || 0,
                    myRank: 0,
                    posterBase64: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || anime.main_picture?.large || anime.main_picture?.medium || '',
                    externalApiId: anime.mal_id || anime.id,
                    studio: anime.studios ? anime.studios.map(s => s.name || s).join(', ') : ''
                };

                // Check if this item exists in library - if so, use library poster
                const libraryItem = this.findLibraryItem(malItem);
                if (libraryItem) {
                    itemsInLibrary++;
                }
                const item = libraryItem ? {
                    ...malItem,
                    posterBase64: libraryItem.posterBase64 || malItem.posterBase64
                } : malItem;

                this.currentSequelsResults.push(item); // Store for search filtering
                container.appendChild(this.createGridItem(item, { onlyLibraryItems: true }));
            });

            // Calculate completion percentage
            const totalCount = filteredResults.length;
            const completionPercentage = totalCount > 0 ? Math.round((itemsInLibrary / totalCount) * 100) : 0;

            // Update title, count, and completion separately
            document.getElementById('sequelsTitle').textContent = `${baseName} from MAL`;
            document.getElementById('sequelsItemCount').textContent = `${filteredResults.length} ${filteredResults.length === 1 ? 'result' : 'results'}`;
            document.getElementById('sequelsCompletionRate').textContent = `${completionPercentage}% Complete`;

            // Track previous view and tab
            this.previousView = this.currentView;
            this.previousTab = this.currentTab;
            this.currentView = 'sequels';
            this.sequelsViewSource = 'mal';
            this.sequelsViewSourceItem = animeItem;
            if (recordHistory) {
                this.pushViewHistoryState({
                    view: 'malRelated',
                    sourceItemId: animeItem?.id || null,
                    sourceItemSnapshot: animeItem ? this.createHistorySnapshot(animeItem) : null
                });
            }
        } catch (error) {
            console.error('Error fetching related anime from MAL:', error);
            container.innerHTML = `<p style="text-align: center; color: var(--hover-color);">Error: ${error.message}</p>`;
            document.getElementById('sequelsTitle').textContent = `Error searching for "${baseName}"`;
            this.currentView = 'sequels';
        }
    }

    async showAllRelatedGamesFromSteam(gameItem) {
        // Extract base name for searching
        const baseName = this.extractBaseGameName(gameItem.name);

        // Show loading state
        document.getElementById('libraryView').style.display = 'none';
        document.getElementById('detailView').style.display = 'none';
        document.getElementById('collectionView').style.display = 'none';
        document.getElementById('searchView').style.display = 'none';
        document.getElementById('sequelsView').style.display = 'block';
        // Hide banner for non-collection views
        document.getElementById('sequelsBannerContainer').style.display = 'none';
        document.getElementById('sequelsView').classList.remove('has-banner');
        document.getElementById('sequelsTitle').textContent = `Searching for "${baseName}"...`;
        document.getElementById('sequelsItemCount').textContent = '';
        document.getElementById('sequelsCompletionRate').textContent = '';
        const backBtnEl = document.getElementById('backBtn');
        if (backBtnEl) backBtnEl.style.display = 'inline-block';
        document.getElementById('searchInput').style.display = 'block';
        document.getElementById('settingsBtn').style.display = 'inline-block';
        document.querySelector('.controls-row').classList.add('hidden');
        document.querySelector('.tabs-row').classList.add('hidden');

        const container = document.getElementById('sequelsGridContainer');
        container.innerHTML = '<p style="text-align: center; color: var(--text-color);">Searching Steam API...</p>';

        try {
            // First, get Steam app list (this is a large file, so we'll search it)
            // Use backend proxy to avoid CORS issues
            const appListResponse = await apiFetch(`${API_URL}/api/steam/applist`);
            if (!appListResponse.ok) {
                throw new Error(`Steam API error: ${appListResponse.statusText}`);
            }

            const appListData = await appListResponse.json();
            const appList = appListData.applist?.apps || [];

            if (appList.length === 0) {
                container.innerHTML = `<p style="text-align: center; color: var(--text-color);">Failed to fetch Steam app list</p>`;
                document.getElementById('sequelsTitle').textContent = `Error searching Steam`;
                this.currentView = 'sequels';
                return;
            }

            // Search for games matching the base name
            // Normalize base name by removing special characters for better matching
            const baseNameNormalized = baseName.toLowerCase().replace(/[®™©]/g, '').trim();
            const baseNameLower = baseName.toLowerCase().trim();
            const matchingApps = appList.filter(app => {
                const appName = (app.name || '').toLowerCase().replace(/[®™©]/g, '');
                const appBaseName = this.extractBaseGameName(app.name || '').toLowerCase().replace(/[®™©]/g, '').trim();

                // Check if base name matches (more inclusive matching)
                return appName.includes(baseNameNormalized) ||
                    appName.includes(baseNameLower) ||
                    appBaseName === baseNameNormalized ||
                    appBaseName === baseNameLower ||
                    appBaseName.startsWith(baseNameNormalized + ' ') ||
                    appBaseName.startsWith(baseNameLower + ' ') ||
                    baseNameNormalized.startsWith(appBaseName + ' ') ||
                    baseNameLower.startsWith(appBaseName + ' ');
            });

            if (matchingApps.length === 0) {
                container.innerHTML = `<p style="text-align: center; color: var(--text-color);">No games found with name "${baseName}"</p>`;
                document.getElementById('sequelsTitle').textContent = `No results for "${baseName}"`;
                this.currentView = 'sequels';
                return;
            }

            // Sort matching apps to prioritize exact/base name matches first
            matchingApps.sort((a, b) => {
                const aName = (a.name || '').toLowerCase();
                const bName = (b.name || '').toLowerCase();
                const aBase = this.extractBaseGameName(a.name || '').toLowerCase().trim();
                const bBase = this.extractBaseGameName(b.name || '').toLowerCase().trim();

                // Exact base name match gets highest priority
                const aExact = aBase === baseNameLower ? 0 : 1;
                const bExact = bBase === baseNameLower ? 0 : 1;
                if (aExact !== bExact) return aExact - bExact;

                // Then prioritize names that start with base name
                const aStarts = aName.startsWith(baseNameLower) ? 0 : 1;
                const bStarts = bName.startsWith(baseNameLower) ? 0 : 1;
                if (aStarts !== bStarts) return aStarts - bStarts;

                // Finally sort by name
                return aName.localeCompare(bName);
            });

            // Fetch details for matching apps in parallel batches for better performance
            const gameDetails = [];
            const maxGames = Math.min(matchingApps.length, 50); // Reduced to 50 to avoid rate limiting
            const batchSize = 3; // Reduced batch size to avoid Steam rate limits
            const delayBetweenBatches = 500; // Increased delay to 500ms between batches

            // Process games in parallel batches
            for (let i = 0; i < maxGames; i += batchSize) {
                const batch = matchingApps.slice(i, Math.min(i + batchSize, maxGames));

                // Fetch all games in this batch in parallel with retry logic
                const batchPromises = batch.map(async (app) => {
                    const appId = app.appid.toString();

                    // Retry logic for rate limiting
                    let retries = 2;
                    let delay = 1000; // Start with 1 second delay

                    while (retries >= 0) {
                        try {
                            const detailsResponse = await apiFetch(`${API_URL}/api/steam/appdetails?appids=${encodeURIComponent(appId)}`);

                            // If we get a 403, wait and retry
                            if (detailsResponse.status === 403 && retries > 0) {
                                console.warn(`Rate limited for app ${appId}, retrying in ${delay}ms...`);
                                await new Promise(resolve => setTimeout(resolve, delay));
                                delay *= 2; // Exponential backoff
                                retries--;
                                continue;
                            }

                            if (!detailsResponse.ok) {
                                console.warn(`Failed to fetch details for app ${appId}: ${detailsResponse.status}`);
                                return null;
                            }

                            const detailsData = await detailsResponse.json();
                            const details = detailsData[appId]?.data;

                            if (!details || details.type !== 'game') {
                                return null; // Skip non-games (DLC, etc.)
                            }

                            // Filter by franchise/base name - be more inclusive for sequels
                            const gameBaseName = this.extractBaseGameName(details.name || app.name || '').toLowerCase().trim();
                            const gameNameLower = (details.name || app.name || '').toLowerCase();

                            // Include if: exact base match, base name is a prefix, or game name contains base name
                            if (gameBaseName === baseNameLower ||
                                gameBaseName.startsWith(baseNameLower + ' ') ||
                                baseNameLower.startsWith(gameBaseName + ' ') ||
                                (gameNameLower.includes(baseNameLower) && gameBaseName.length >= baseNameLower.length * 0.8)) {
                                // Extract release date as string (handle both object and string formats)
                                const releaseDateStr = typeof details.release_date === 'string'
                                    ? details.release_date
                                    : (details.release_date?.date || '');

                                return {
                                    appid: app.appid,
                                    name: details.name || app.name,
                                    release_date: releaseDateStr,
                                    genres: details.genres ? details.genres.map(g => g.description).join(', ') : '',
                                    short_description: details.short_description || '',
                                    header_image: details.header_image || '',
                                    metacritic: details.metacritic?.score || 0,
                                    ...details,
                                    // Override release_date after spread to ensure it's a string
                                    release_date: releaseDateStr
                                };
                            }
                            return null;
                        } catch (err) {
                            // If it's a network error and we have retries left, try again
                            if (retries > 0) {
                                console.warn(`Error fetching app ${appId}, retrying in ${delay}ms...`, err);
                                await new Promise(resolve => setTimeout(resolve, delay));
                                delay *= 2;
                                retries--;
                                continue;
                            }
                            console.error(`Error fetching details for app ${appId}:`, err);
                            return null;
                        }
                    }

                    return null; // Exhausted retries
                });

                // Wait for all requests in this batch to complete
                const batchResults = await Promise.all(batchPromises);
                // Filter out null results and add to gameDetails
                batchResults.forEach(result => {
                    if (result) {
                        gameDetails.push(result);
                    }
                });

                // Longer delay between batches to avoid overwhelming the API
                if (i + batchSize < maxGames) {
                    await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
                }
            }

            if (gameDetails.length === 0) {
                container.innerHTML = `<p style="text-align: center; color: var(--text-color);">No games found with matching base name "${baseName}"</p>`;
                document.getElementById('sequelsTitle').textContent = `No matching results for "${baseName}"`;
                this.currentView = 'sequels';
                return;
            }

            // Sort by release date (year)
            gameDetails.sort((a, b) => {
                // Handle release_date being either a string or an object with a date property
                const dateA = typeof a.release_date === 'string' ? a.release_date : (a.release_date?.date || '');
                const dateB = typeof b.release_date === 'string' ? b.release_date : (b.release_date?.date || '');
                const yearA = parseInt(dateA.match(/\d{4}/)?.[0] || '0') || 0;
                const yearB = parseInt(dateB.match(/\d{4}/)?.[0] || '0') || 0;
                if (yearA !== yearB) {
                    return yearA - yearB;
                }
                // If same year, sort by name
                return (a.name || '').localeCompare(b.name || '');
            });

            // Convert Steam results to item format and render
            container.innerHTML = '';
            let itemsInLibrary = 0;
            this.currentSequelsResults = []; // Store items for search filtering

            gameDetails.forEach(game => {
                // Create item from Steam data
                const steamItem = {
                    id: `steam_${game.appid}`,
                    type: 'games',
                    name: game.name || 'Untitled',
                    year: (typeof game.release_date === 'string' ? game.release_date : (game.release_date?.date || '')).match(/\d{4}/)?.[0] || '',
                    genre: game.genres || '',
                    description: game.short_description || '',
                    userScore: game.metacritic || 0,
                    myRank: 0,
                    posterBase64: game.header_image || '',
                    externalApiId: `steam_${game.appid}`,
                    developer: game.developers ? game.developers.join(', ') : '',
                    publisher: game.publishers ? game.publishers.join(', ') : ''
                };

                // Check if this item exists in library - if so, use library poster
                const libraryItem = this.findLibraryItem(steamItem);
                if (libraryItem) {
                    itemsInLibrary++;
                }
                const item = libraryItem ? {
                    ...steamItem,
                    posterBase64: libraryItem.posterBase64 || steamItem.posterBase64
                } : steamItem;

                this.currentSequelsResults.push(item); // Store for search filtering
                container.appendChild(this.createGridItem(item, { onlyLibraryItems: true }));
            });

            // Calculate completion percentage
            const totalCount = gameDetails.length;
            const completionPercentage = totalCount > 0 ? Math.round((itemsInLibrary / totalCount) * 100) : 0;

            // Update title, count, and completion separately
            document.getElementById('sequelsTitle').textContent = `${baseName} from Steam`;
            document.getElementById('sequelsItemCount').textContent = `${totalCount} ${totalCount === 1 ? 'result' : 'results'}`;
            document.getElementById('sequelsCompletionRate').textContent = `${completionPercentage}% Complete`;

            // Track previous view and tab
            this.previousView = this.currentView;
            this.previousTab = this.currentTab;
            this.currentView = 'sequels';
            this.sequelsViewSource = 'steam';
            this.sequelsViewSourceItem = gameItem;
        } catch (error) {
            console.error('Error fetching related games from Steam:', error);
            container.innerHTML = `<p style="text-align: center; color: var(--hover-color);">Error: ${error.message}</p>`;
            document.getElementById('sequelsTitle').textContent = `Error searching for "${baseName}"`;
            this.currentView = 'sequels';
        }
    }

    async showAllRelatedMoviesSeriesFromTMDB(item) {
        const isMovie = item.type === 'movies';
        const mediaType = isMovie ? 'movie' : 'tv';
        const itemName = item.name || '';
        const itemYear = item.year || '';

        // Show loading state
        document.getElementById('libraryView').style.display = 'none';
        document.getElementById('detailView').style.display = 'none';
        document.getElementById('collectionView').style.display = 'none';
        document.getElementById('searchView').style.display = 'none';
        document.getElementById('sequelsView').style.display = 'block';
        // Hide banner for non-collection views
        document.getElementById('sequelsBannerContainer').style.display = 'none';
        document.getElementById('sequelsView').classList.remove('has-banner');
        document.getElementById('sequelsTitle').textContent = `Searching for related items...`;
        document.getElementById('sequelsItemCount').textContent = '';
        document.getElementById('sequelsCompletionRate').textContent = '';
        const backBtnEl = document.getElementById('backBtn');
        if (backBtnEl) backBtnEl.style.display = 'inline-block';
        document.getElementById('searchInput').style.display = 'block';
        document.getElementById('settingsBtn').style.display = 'inline-block';
        document.querySelector('.controls-row').classList.add('hidden');
        document.querySelector('.tabs-row').classList.add('hidden');

        const container = document.getElementById('sequelsGridContainer');
        container.innerHTML = '<p style="text-align: center; color: var(--text-color);">Searching TMDB API...</p>';

        try {
            const tmdbApiKey = this.data.settings.tmdbApiKey;
            if (!tmdbApiKey) {
                throw new Error('TMDB API key not set. Please add it in settings.');
            }

            let allResults = [];
            let originalItemId = null;
            let collectionName = null;

            // First, try to find the exact item by externalApiId
            if (item.externalApiId) {
                originalItemId = parseInt(item.externalApiId);
                try {
                    const detailsResponse = await fetch(`https://api.themoviedb.org/3/${mediaType}/${originalItemId}?api_key=${tmdbApiKey}&language=en-US`);
                    if (detailsResponse.ok) {
                        const details = await detailsResponse.json();

                        if (isMovie && details.belongs_to_collection) {
                            // For movies, get collection (franchise) - this shows related movies
                            const collectionId = details.belongs_to_collection.id;
                            collectionName = details.belongs_to_collection.name;
                            const collectionResponse = await fetch(`https://api.themoviedb.org/3/collection/${collectionId}?api_key=${tmdbApiKey}&language=en-US`);

                            if (collectionResponse.ok) {
                                const collection = await collectionResponse.json();
                                allResults = collection.parts || [];
                                // Update collection name from collection response (more accurate)
                                if (collection.name) {
                                    collectionName = collection.name;
                                }
                            }
                        } else {
                            // For TV series or movies without collection - only show the exact item
                            // TV series don't have "related series" in TMDB, they are standalone
                            allResults = [details];
                        }
                    }
                } catch (err) {
                    console.error('Error fetching item details by ID:', err);
                }
            }

            // If we couldn't find by ID, search for exact match by name and year
            if (allResults.length === 0) {
                const searchResponse = await fetch(`https://api.themoviedb.org/3/search/${mediaType}?api_key=${tmdbApiKey}&query=${encodeURIComponent(itemName)}&language=en-US`);
                if (!searchResponse.ok) {
                    throw new Error(`TMDB API error: ${searchResponse.statusText}`);
                }

                const searchData = await searchResponse.json();
                const searchResults = searchData.results || [];

                if (searchResults.length === 0) {
                    container.innerHTML = `<p style="text-align: center; color: var(--text-color);">No ${mediaType} found with name "${itemName}"</p>`;
                    document.getElementById('sequelsTitle').textContent = `No results for "${itemName}"`;
                    this.currentView = 'sequels';
                    return;
                }

                // Find exact match by name and year
                const exactMatch = searchResults.find(result => {
                    const resultName = (result.title || result.name || '').toLowerCase().trim();
                    const resultYear = (result.release_date || result.first_air_date || '').substring(0, 4);
                    const itemNameLower = itemName.toLowerCase().trim();

                    return resultName === itemNameLower &&
                        (!itemYear || resultYear === itemYear || !resultYear);
                });

                if (exactMatch) {
                    originalItemId = exactMatch.id;
                    const detailsResponse = await fetch(`https://api.themoviedb.org/3/${mediaType}/${exactMatch.id}?api_key=${tmdbApiKey}&language=en-US`);
                    if (detailsResponse.ok) {
                        const details = await detailsResponse.json();

                        if (isMovie && details.belongs_to_collection) {
                            // For movies, get collection (franchise)
                            const collectionId = details.belongs_to_collection.id;
                            collectionName = details.belongs_to_collection.name;
                            const collectionResponse = await fetch(`https://api.themoviedb.org/3/collection/${collectionId}?api_key=${tmdbApiKey}&language=en-US`);

                            if (collectionResponse.ok) {
                                const collection = await collectionResponse.json();
                                allResults = collection.parts || [];
                                // Update collection name from collection response (more accurate)
                                if (collection.name) {
                                    collectionName = collection.name;
                                }
                            } else {
                                // If collection fetch fails, only show the exact match
                                allResults = [details];
                            }
                        } else {
                            // TV series or movie without collection - only show the exact match
                            allResults = [details];
                        }
                    }
                }
            }

            if (allResults.length === 0) {
                container.innerHTML = `<p style="text-align: center; color: var(--text-color);">No related ${mediaType} found for "${itemName}"</p>`;
                document.getElementById('sequelsTitle').textContent = `No related results for "${itemName}"`;
                this.currentView = 'sequels';
                return;
            }

            // Sort by release date (year)
            allResults.sort((a, b) => {
                const yearA = parseInt((a.release_date || a.first_air_date || '').substring(0, 4)) || 0;
                const yearB = parseInt((b.release_date || b.first_air_date || '').substring(0, 4)) || 0;
                if (yearA !== yearB) {
                    return yearA - yearB;
                }
                // If same year, sort by name
                const nameA = (a.title || a.name || '').toLowerCase();
                const nameB = (b.title || b.name || '').toLowerCase();
                return nameA.localeCompare(nameB);
            });

            // Convert TMDB results to item format and render
            container.innerHTML = '';
            let itemsInLibrary = 0;
            this.currentSequelsResults = []; // Store items for search filtering

            allResults.forEach(result => {
                // Create item from TMDB data
                const tmdbItem = {
                    id: `${mediaType}_${result.id}`,
                    type: isMovie ? 'movies' : 'tv',
                    name: result.title || result.name || 'Untitled',
                    year: (result.release_date || result.first_air_date || '').substring(0, 4) || '',
                    genre: result.genre_ids ? this.mapGenreIdsToNames(result.genre_ids) : '',
                    description: result.overview || '',
                    userScore: Math.round((result.vote_average || 0) * 10),
                    myRank: 0,
                    posterBase64: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : '',
                    externalApiId: result.id,
                    backdropBase64: result.backdrop_path ? `https://image.tmdb.org/t/p/w1280${result.backdrop_path}` : ''
                };

                // Check if this item exists in library - if so, use library poster
                const libraryItem = this.findLibraryItem(tmdbItem);
                if (libraryItem) {
                    itemsInLibrary++;
                }
                const finalItem = libraryItem ? {
                    ...tmdbItem,
                    posterBase64: libraryItem.posterBase64 || tmdbItem.posterBase64,
                    backdropBase64: libraryItem.backdropBase64 || tmdbItem.backdropBase64
                } : tmdbItem;

                this.currentSequelsResults.push(finalItem); // Store for search filtering
                container.appendChild(this.createGridItem(finalItem, { onlyLibraryItems: true }));
            });

            // Calculate completion percentage
            const totalCount = allResults.length;
            const completionPercentage = totalCount > 0 ? Math.round((itemsInLibrary / totalCount) * 100) : 0;

            // For movies with collections, show collection name; otherwise show item name
            const displayName = (isMovie && collectionName && allResults.length > 1) ? collectionName : itemName;

            // Update title, count, and completion separately
            document.getElementById('sequelsTitle').textContent = `${displayName} from TMDB`;
            document.getElementById('sequelsItemCount').textContent = `${totalCount} ${totalCount === 1 ? 'result' : 'results'}`;
            document.getElementById('sequelsCompletionRate').textContent = `${completionPercentage}% Complete`;

            // Track previous view and tab
            this.previousView = this.currentView;
            this.previousTab = this.currentTab;
            this.currentView = 'sequels';
            this.sequelsViewSource = 'tmdb';
            this.sequelsViewSourceItem = item;
        } catch (error) {
            console.error('Error fetching related movies/series from TMDB:', error);
            container.innerHTML = `<p style="text-align: center; color: var(--hover-color);">Error: ${error.message}</p>`;
            document.getElementById('sequelsTitle').textContent = `Error searching for "${itemName}"`;
            this.currentView = 'sequels';
        }
    }

    showCollectionCreation(initialItem = null) {
        // Store the item type for filtering (same tab)
        const itemType = initialItem ? initialItem.type : this.currentTab;

        // Reset collection selection
        this.currentCollectionItems.clear();
        if (initialItem) {
            this.currentCollectionItems.add(initialItem.id);
        }

        // Show collection view
        document.getElementById('libraryView').style.display = 'none';
        document.getElementById('detailView').style.display = 'none';
        document.getElementById('sequelsView').style.display = 'none';
        document.getElementById('searchView').style.display = 'none';
        document.getElementById('collectionView').style.display = 'block';
        const backBtnEl = document.getElementById('backBtn');
        if (backBtnEl) backBtnEl.style.display = 'inline-block';
        document.getElementById('searchInput').style.display = 'none';
        document.getElementById('settingsBtn').style.display = 'inline-block';
        document.querySelector('.controls-row').classList.add('hidden');
        document.querySelector('.tabs-row').classList.add('hidden');

        // Reset collection name input
        document.getElementById('collectionNameInput').value = '';
        document.getElementById('collectionNameInput').disabled = false;
        document.getElementById('collectionTitle').textContent = 'Create New Collection';
        this.currentEditingCollection = null; // Clear any editing state

        // Clear search input
        document.getElementById('collectionSearchInput').value = '';

        // Setup event listeners if not already set up
        this.setupCollectionListeners();

        // Update current view
        this.currentView = 'collection';

        // Store item type for filtering
        this.collectionCreationItemType = itemType;

        // Render library items filtered by type
        this.renderCollectionItems();
    }

    setupCollectionListeners() {
        // Search functionality
        const searchInput = document.getElementById('collectionSearchInput');
        if (!searchInput.hasAttribute('data-listener-attached')) {
            searchInput.setAttribute('data-listener-attached', 'true');
            searchInput.addEventListener('input', (e) => {
                this.renderCollectionItems(e.target.value);
            });
        }

        // Save collection button
        const saveBtn = document.getElementById('saveCollectionBtn');
        if (!saveBtn.hasAttribute('data-listener-attached')) {
            saveBtn.setAttribute('data-listener-attached', 'true');
            saveBtn.addEventListener('click', () => {
                this.saveCollection();
            });
        }
    }

    renderCollectionItems(searchTerm = '') {
        const container = document.getElementById('collectionGridContainer');
        container.innerHTML = '';

        // Filter library items by item type (same tab) and search term
        let filteredItems = this.data.items.filter(item => {
            if (!item || item.type === 'actors') return false;
            // Filter by the same type as the initial item
            if (this.collectionCreationItemType && item.type !== this.collectionCreationItemType) {
                return false;
            }
            if (searchTerm) {
                const searchLower = searchTerm.toLowerCase();
                return (item.name || '').toLowerCase().includes(searchLower);
            }
            return true;
        });

        // Render items with selection capability
        filteredItems.forEach(item => {
            const div = this.createCollectionGridItem(item);
            container.appendChild(div);
        });
    }

    showAddItemsToCollection(collection) {
        // Use the same collection creation view but for adding to existing collection
        this.currentCollectionItems.clear();
        // Pre-populate with items already in collection
        if (collection.itemIds) {
            collection.itemIds.forEach(id => this.currentCollectionItems.add(id));
        }

        // Store the collection being edited
        this.currentEditingCollection = collection;
        // Store the collection we should return to when going back
        this.collectionToReturnTo = collection;
        this.collectionCreationItemType = null; // Will be determined from collection items

        // Determine item type from collection items
        if (collection.itemIds && collection.itemIds.length > 0) {
            const firstItem = this.data.items.find(i => i.id === collection.itemIds[0]);
            if (firstItem) {
                this.collectionCreationItemType = firstItem.type;
            }
        }

        // Show collection view
        document.getElementById('libraryView').style.display = 'none';
        document.getElementById('detailView').style.display = 'none';
        document.getElementById('sequelsView').style.display = 'none';
        document.getElementById('searchView').style.display = 'none';
        document.getElementById('collectionView').style.display = 'block';
        const backBtnEl = document.getElementById('backBtn');
        if (backBtnEl) backBtnEl.style.display = 'inline-block';
        document.getElementById('searchInput').style.display = 'none';
        document.getElementById('settingsBtn').style.display = 'inline-block';
        document.querySelector('.controls-row').classList.add('hidden');
        document.querySelector('.tabs-row').classList.add('hidden');

        // Update collection name input (read-only, show it's editing)
        document.getElementById('collectionNameInput').value = collection.name;
        document.getElementById('collectionNameInput').disabled = true;
        document.getElementById('collectionTitle').textContent = `Add Items to: ${collection.name}`;

        // Clear search input
        const collectionSearchInput = document.getElementById('collectionSearchInput');
        if (collectionSearchInput) {
            collectionSearchInput.value = '';
        }

        // Setup event listeners if not already set up
        this.setupCollectionListeners();

        // Update current view
        this.currentView = 'collection';

        // Render items
        this.renderCollectionItems();
    }

    createCollectionGridItem(item) {
        const div = document.createElement('div');
        div.className = 'grid-item';
        if (this.currentCollectionItems.has(item.id)) {
            div.classList.add('collection-selected');
        }

        // Toggle selection on click
        div.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.currentCollectionItems.has(item.id)) {
                this.currentCollectionItems.delete(item.id);
                div.classList.remove('collection-selected');
            } else {
                this.currentCollectionItems.add(item.id);
                div.classList.add('collection-selected');
            }
        });

        const img = document.createElement('img');
        img.loading = "lazy";
        img.decoding = "async";
        img.src = item.posterBase64 || 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjEwMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD4KPC9zdmc+';
        img.alt = item.name;

        const overlay = document.createElement('div');
        overlay.className = 'grid-item-overlay';
        const nameDiv = document.createElement('div');
        nameDiv.className = 'grid-item-name';
        nameDiv.textContent = item.name || 'Untitled';
        overlay.appendChild(nameDiv);

        div.appendChild(img);
        div.appendChild(overlay);

        return div;
    }

    // ---------- TRAILER MODAL ----------
    openTrailerModal(videoId) {
        const modal = document.getElementById('trailerModal');
        const iframe = document.getElementById('trailerIframe');
        if (!modal || !iframe) return;

        // Use YouTube embed URL with autoplay
        iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&enablejsapi=1`;
        modal.style.display = 'flex';
        modal.classList.add('show');

        // Close on click outside
        modal.onclick = (e) => {
            if (e.target === modal) {
                this.closeTrailerModal();
            }
        };

        // Close on Escape key
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                this.closeTrailerModal();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    closeTrailerModal() {
        const modal = document.getElementById('trailerModal');
        const iframe = document.getElementById('trailerIframe');
        if (!modal || !iframe) return;

        iframe.src = ''; // Stop video
        modal.style.display = 'none';
        modal.classList.remove('show');
        modal.onclick = null;
    }

    showCollectionView(collections, item, options = {}) {
        const { recordHistory = true } = options;
        // If multiple collections, show the first one (or could show a list)
        // For now, show the first collection
        const collection = collections[0];

        // Store current collection being viewed
        this.currentViewedCollection = collection;
        this.currentEditingCollectionForPoster = null; // Clear poster editing state

        // Get items in the collection
        const collectionItems = collection.itemIds
            .map(id => this.data.items.find(item => item.id === id))
            .filter(item => item !== undefined);

        // Track previous view before switching
        this.previousView = this.currentView;

        // Show sequels view with collection items
        document.getElementById('libraryView').style.display = 'none';
        document.getElementById('detailView').style.display = 'none';
        document.getElementById('collectionView').style.display = 'none';
        document.getElementById('searchView').style.display = 'none';
        document.getElementById('sequelsView').style.display = 'block';
        const backBtnEl = document.getElementById('backBtn');
        if (backBtnEl) backBtnEl.style.display = 'inline-block';
        document.getElementById('searchInput').style.display = 'block';
        document.getElementById('settingsBtn').style.display = 'inline-block';
        document.querySelector('.controls-row').classList.add('hidden');
        document.querySelector('.tabs-row').classList.add('hidden');

        // Track this as a collection view (set before checking for button)
        this.currentView = 'sequels';
        this.sequelsViewSource = 'collection';
        this.sequelsViewSourceItem = item;
        // Hide scroll-to-top button when viewing collections/sequels
        const scrollBtn = document.getElementById('scrollTopBtn');
        if (scrollBtn) scrollBtn.classList.remove('show');
        if (recordHistory) {
            this.pushViewHistoryState({
                view: 'collection',
                collectionId: collection?.id || null,
                sourceItemId: item?.id || null,
                sourceItemSnapshot: item ? this.createHistorySnapshot(item) : null
            });
        }

        // Update title and count separately
        document.getElementById('sequelsTitle').textContent = collection.name;
        document.getElementById('sequelsItemCount').textContent = `${collectionItems.length} ${collectionItems.length === 1 ? 'item' : 'items'}`;
        document.getElementById('sequelsCompletionRate').textContent = '';

        // Show/hide banner for collection view
        const bannerContainer = document.getElementById('sequelsBannerContainer');
        const bannerImage = document.getElementById('sequelsBannerImage');
        const sequelsView = document.getElementById('sequelsView');
        // Use bannerPath if available, fallback to bannerBase64 for migration
        // Proxy GitHub URLs for both
        let bannerSrc = '';
        if (collection.bannerPath) {
            bannerSrc = this.getProxiedImageUrl(collection.bannerPath.startsWith('http') ? collection.bannerPath : `${API_URL}/${collection.bannerPath}`);
        } else if (collection.bannerBase64) {
            bannerSrc = this.getProxiedImageUrl(collection.bannerBase64);
        }
        if (bannerSrc) {
            bannerImage.src = bannerSrc;
            bannerImage.style.display = 'block';
            bannerContainer.style.display = 'block';
            sequelsView.classList.add('has-banner');
            // Remove click handler if it exists (banner is set)
            bannerContainer.style.cursor = 'default';
            bannerContainer.onclick = null;
            bannerContainer.classList.remove('wild-banner');
        } else {
            // Hide wild banner placeholder - banner selection is now in dropdown
            bannerContainer.style.display = 'none';
            sequelsView.classList.remove('has-banner');
            bannerContainer.classList.remove('wild-banner');
            bannerImage.src = ''; // Clear image
            bannerImage.style.display = 'none';
            // Remove click handler - banner selection is now in dropdown
            bannerContainer.style.cursor = 'default';
            bannerContainer.onclick = null;
            bannerContainer.title = '';
        }

        // Add "Add Items" button, "Change Poster" button, and "Change Banner" button to the right alongside the item count
        const sequelsItemCount = document.getElementById('sequelsItemCount');
        const sequelsHeader = sequelsItemCount.parentElement;

        // Create or get the buttons container
        let buttonsContainer = sequelsHeader.querySelector('.collection-buttons-container');
        if (!buttonsContainer) {
            buttonsContainer = document.createElement('div');
            buttonsContainer.className = 'collection-buttons-container';
            // Insert after the item count
            sequelsItemCount.parentElement.insertBefore(buttonsContainer, sequelsItemCount.nextSibling);
        }

        let addItemsBtn = buttonsContainer.querySelector('.add-items-to-collection-btn');
        let changePosterBtn = buttonsContainer.querySelector('.change-collection-poster-btn');
        let changeBannerBtn = buttonsContainer.querySelector('.change-collection-banner-btn');
        let bannerDropdown = buttonsContainer.querySelector('.collection-banner-dropdown');
        let posterDropdown = buttonsContainer.querySelector('.collection-poster-dropdown');

        if (!addItemsBtn) {
            addItemsBtn = document.createElement('button');
            addItemsBtn.className = 'add-items-to-collection-btn';
            addItemsBtn.innerHTML = `
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"></line>
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
              `;
            addItemsBtn.title = 'Add Items';
            addItemsBtn.addEventListener('click', () => {
                this.showAddItemsToCollection(collection);
            });
            buttonsContainer.appendChild(addItemsBtn);
        }

        if (!posterDropdown) {
            // Create dropdown container for poster
            posterDropdown = document.createElement('div');
            posterDropdown.className = 'collection-poster-dropdown';

            changePosterBtn = document.createElement('button');
            changePosterBtn.className = 'add-items-to-collection-btn change-collection-poster-btn';
            changePosterBtn.innerHTML = `
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                      <circle cx="8.5" cy="8.5" r="1.5"></circle>
                      <polyline points="21 15 16 10 5 21"></polyline>
                  </svg>
              `;
            changePosterBtn.title = 'Change Poster';

            // Create dropdown menu
            const posterMenu = document.createElement('div');
            posterMenu.className = 'collection-poster-menu';
            posterMenu.innerHTML = `
                  <button class="poster-menu-option" data-action="upload">Upload from PC</button>
                  <button class="poster-menu-option" data-action="search">Search for Poster</button>
              `;

            // Add click handlers for menu options
            posterMenu.querySelector('[data-action="upload"]').addEventListener('click', () => {
                // Use currentViewedCollection to ensure we use the right collection
                const currentCollection = this.currentViewedCollection || collection;
                this.triggerCollectionPosterUpload(currentCollection);
                posterMenu.classList.remove('show');
            });

            posterMenu.querySelector('[data-action="search"]').addEventListener('click', () => {
                // Use currentViewedCollection to ensure we use the right collection
                const currentCollection = this.currentViewedCollection || collection;
                this.searchCollectionPoster(currentCollection);
                posterMenu.classList.remove('show');
            });

            // Toggle dropdown on button click
            changePosterBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Close other dropdowns
                document.querySelectorAll('.collection-poster-menu.show, .collection-banner-menu.show').forEach(menu => {
                    if (menu !== posterMenu) menu.classList.remove('show');
                });
                posterMenu.classList.toggle('show');
            });

            // Close dropdown when clicking outside (use once to avoid multiple listeners)
            const closeHandler = (e) => {
                if (!posterDropdown.contains(e.target)) {
                    posterMenu.classList.remove('show');
                }
                // Also close banner dropdown if clicking outside both
                const bannerDropdownEl = buttonsContainer.querySelector('.collection-banner-dropdown');
                if (bannerDropdownEl && !bannerDropdownEl.contains(e.target)) {
                    const bannerMenu = bannerDropdownEl.querySelector('.collection-banner-menu');
                    if (bannerMenu) bannerMenu.classList.remove('show');
                }
            };
            // Store handler for potential cleanup
            posterMenu._closeHandler = closeHandler;
            document.addEventListener('click', closeHandler);

            posterDropdown.appendChild(changePosterBtn);
            posterDropdown.appendChild(posterMenu);

            // Insert after add items button
            buttonsContainer.appendChild(posterDropdown);
        }

        if (!bannerDropdown) {
            // Create dropdown container
            bannerDropdown = document.createElement('div');
            bannerDropdown.className = 'collection-banner-dropdown';

            changeBannerBtn = document.createElement('button');
            changeBannerBtn.className = 'add-items-to-collection-btn change-collection-banner-btn';
            changeBannerBtn.innerHTML = `
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                      <line x1="3" y1="9" x2="21" y2="9"></line>
                      <line x1="9" y1="21" x2="9" y2="9"></line>
                  </svg>
              `;
            changeBannerBtn.title = 'Change Banner';

            // Create dropdown menu
            const bannerMenu = document.createElement('div');
            bannerMenu.className = 'collection-banner-menu';
            bannerMenu.innerHTML = `
                  <button class="banner-menu-option" data-action="upload">Upload from PC</button>
                  <button class="banner-menu-option" data-action="search">Search for Banner</button>
              `;

            // Add click handlers for menu options
            bannerMenu.querySelector('[data-action="upload"]').addEventListener('click', () => {
                // Use currentViewedCollection to ensure we use the right collection
                const currentCollection = this.currentViewedCollection || collection;
                this.triggerCollectionBannerUpload(currentCollection);
                bannerMenu.classList.remove('show');
            });

            bannerMenu.querySelector('[data-action="search"]').addEventListener('click', () => {
                // Use currentViewedCollection to ensure we use the right collection
                const currentCollection = this.currentViewedCollection || collection;
                this.searchCollectionBanner(currentCollection);
                bannerMenu.classList.remove('show');
            });

            // Toggle dropdown on button click
            changeBannerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Close other dropdowns
                document.querySelectorAll('.collection-banner-menu.show, .collection-poster-menu.show').forEach(menu => {
                    if (menu !== bannerMenu) menu.classList.remove('show');
                });
                bannerMenu.classList.toggle('show');
            });

            // Close dropdown when clicking outside (use once to avoid multiple listeners)
            const closeHandler = (e) => {
                if (!bannerDropdown.contains(e.target)) {
                    bannerMenu.classList.remove('show');
                }
                // Also close poster dropdown if clicking outside both
                const posterDropdownEl = buttonsContainer.querySelector('.collection-poster-dropdown');
                if (posterDropdownEl && !posterDropdownEl.contains(e.target)) {
                    const posterMenu = posterDropdownEl.querySelector('.collection-poster-menu');
                    if (posterMenu) posterMenu.classList.remove('show');
                }
            };
            // Store handler for potential cleanup
            bannerMenu._closeHandler = closeHandler;
            document.addEventListener('click', closeHandler);

            bannerDropdown.appendChild(changeBannerBtn);
            bannerDropdown.appendChild(bannerMenu);

            // Insert after poster dropdown (or after add items button if poster dropdown doesn't exist)
            if (posterDropdown && posterDropdown.parentElement === buttonsContainer) {
                buttonsContainer.insertBefore(bannerDropdown, posterDropdown.nextSibling);
            } else {
                buttonsContainer.appendChild(bannerDropdown);
            }
        }

        // Always show buttons container and buttons when viewing a collection
        buttonsContainer.style.display = 'flex';
        addItemsBtn.style.display = 'flex';
        if (posterDropdown) {
            posterDropdown.style.display = 'block';
            const posterBtn = posterDropdown.querySelector('.change-collection-poster-btn');
            if (posterBtn) posterBtn.style.display = 'flex';
        }
        if (bannerDropdown) {
            bannerDropdown.style.display = 'block';
            const bannerBtn = bannerDropdown.querySelector('.change-collection-banner-btn');
            if (bannerBtn) bannerBtn.style.display = 'flex';
        }

        // Add delete collection button
        let deleteCollectionBtn = buttonsContainer.querySelector('.delete-collection-btn');
        if (!deleteCollectionBtn) {
            deleteCollectionBtn = document.createElement('button');
            deleteCollectionBtn.className = 'add-items-to-collection-btn delete-collection-btn';
            deleteCollectionBtn.innerHTML = `
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
              `;
            deleteCollectionBtn.title = 'Delete Collection';
            deleteCollectionBtn.addEventListener('click', async () => {
                if (!confirm(`Delete collection "${collection.name}"? This will not delete the items inside it.`)) {
                    return;
                }

                try {
                    // Delete from database
                    await this.deleteCollectionFromDB(collection.id);

                    // Remove from local collections
                    this.collections = this.collections.filter(c => c.id !== collection.id);

                    // Go back to library view
                    this.showLibraryView();

                    alert('Collection deleted successfully!');
                } catch (error) {
                    console.error('❌ Error deleting collection:', error);
                    alert('Failed to delete collection. Please try again.');
                }
            });
            buttonsContainer.appendChild(deleteCollectionBtn);
        }
        deleteCollectionBtn.style.display = 'flex';

        // Render collection items
        const container = document.getElementById('sequelsGridContainer');
        container.innerHTML = '';
        this.currentSequelsResults = collectionItems;

        collectionItems.forEach(item => {
            container.appendChild(this.createGridItem(item));
        });
    }

    searchCollectionsForForm(searchTerm) {
        const resultsContainer = document.getElementById('collectionSearchResults');
        const collectionSelect = document.getElementById('itemCollection');

        if (!searchTerm || searchTerm.trim() === '') {
            resultsContainer.innerHTML = '';
            return;
        }

        const searchLower = searchTerm.toLowerCase().trim();

        // Filter collections that contain items from the same tab
        const matchingCollections = this.collections.filter(collection => {
            // Check if collection name matches
            if (!collection.name || !collection.name.toLowerCase().includes(searchLower)) {
                return false;
            }

            // Check if collection has items from the current tab
            if (!collection.itemIds || collection.itemIds.length === 0) {
                return true; // Empty collection can accept any type
            }

            // Check if at least one item in collection is from current tab
            const hasMatchingType = collection.itemIds.some(itemId => {
                const item = this.data.items.find(i => i.id === itemId);
                return item && item.type === this.currentTab;
            });

            return hasMatchingType;
        });

        // Build HTML for matching collections
        let resultsHTML = '';

        if (matchingCollections.length === 0) {
            resultsHTML = '<p style="padding: 0.5rem; color: var(--text-color); opacity: 0.7;">No collections found</p>';
        } else {
            resultsHTML = matchingCollections.map(collection => {
                const itemCount = collection.itemIds ? collection.itemIds.length : 0;
                const isSelected = collectionSelect.value === collection.id;
                return `
                      <div class="collection-search-result-item ${isSelected ? 'selected' : ''}" 
                           data-collection-id="${collection.id}"
                           data-collection-name="${collection.name.replace(/"/g, '&quot;')}">
                          <strong>${collection.name}</strong> (${itemCount} ${itemCount === 1 ? 'item' : 'items'})
                      </div>
                  `;
            }).join('');
        }

        // Add "Create New Collection" option
        resultsHTML += `
              <div class="collection-search-result-item create-collection-option" 
                   data-create-collection="true"
                   style="border-top: 1px solid rgba(255, 255, 255, 0.1); margin-top: 0.5rem; padding-top: 0.5rem;">
                  <strong style="color: var(--accent-color);">+ Create New Collection: "${searchTerm.trim()}"</strong>
              </div>
          `;

        resultsContainer.innerHTML = resultsHTML;

        // Add click handlers to result items
        resultsContainer.querySelectorAll('.collection-search-result-item').forEach(item => {
            item.addEventListener('click', async (e) => {
                e.stopPropagation(); // Prevent event from bubbling up and closing the menu
                if (item.dataset.createCollection === 'true') {
                    // Create new collection - get current value from input field
                    const currentSearchValue = document.getElementById('itemCollectionSearch').value.trim();
                    await this.createCollectionFromForm(currentSearchValue || searchTerm.trim());
                } else {
                    const collectionId = item.dataset.collectionId;
                    const collectionName = item.dataset.collectionName;
                    this.selectCollectionForForm(collectionId, collectionName);
                }
            });
        });
    }

    selectCollectionForForm(collectionId, collectionName) {
        document.getElementById('itemCollection').value = collectionId;
        document.getElementById('itemCollectionSearch').value = collectionName;
        document.getElementById('collectionSearchResults').innerHTML = '';

        // Remove auto-match notification when manually selecting a collection
        const collectionGroup = document.getElementById('collectionGroup');
        if (collectionGroup) {
            const notification = collectionGroup.querySelector('.collection-auto-match-notification');
            if (notification) {
                notification.remove();
            }
        }

        // Update selected state in results
        document.querySelectorAll('.collection-search-result-item').forEach(item => {
            if (item.dataset.collectionId === collectionId) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }

    async createCollectionFromForm(collectionName) {
        if (!collectionName || collectionName.trim() === '') {
            alert('Please enter a collection name');
            return;
        }

        // Check if collection already exists
        const existingCollection = this.collections.find(c =>
            c.name && c.name.toLowerCase() === collectionName.toLowerCase()
        );

        if (existingCollection) {
            // If collection exists, just select it
            this.selectCollectionForForm(existingCollection.id, existingCollection.name);
            return;
        }

        // Create new collection
        const collection = {
            id: `collection_${Date.now()}_${Math.random()}`,
            name: collectionName.trim(),
            itemIds: [],
            type: this.currentTab, // Store the tab where collection was created
            createdAt: new Date().toISOString()
        };

        // Add to collections
        this.collections.push(collection);

        // Save to GitHub
        await this.saveCollectionToDB(collection);

        // Select the newly created collection
        this.selectCollectionForForm(collection.id, collection.name);

        // Show success message
        alert(`Collection "${collectionName}" created successfully!`);
    }

    checkAndShowCollectionAutoMatch(itemName) {
        if (!itemName) return;

        // Get the current tab type to determine which extraction method to use
        const currentType = this.currentTab;

        // Extract base name from item name for matching (same logic as autoMatchCollectionByName)
        let baseName = '';
        if (currentType === 'anime') {
            baseName = this.extractBaseAnimeName(itemName);
        } else if (currentType === 'games') {
            baseName = this.extractBaseGameName(itemName);
        } else if (currentType === 'movies' || currentType === 'tv') {
            baseName = this.extractBaseMovieSeriesName(itemName);
        } else {
            baseName = itemName.trim();
        }

        if (!baseName) return;

        // Normalize the base name (remove special characters)
        const normalizedBaseName = this.normalizeForMatching(baseName);

        // Find collections with matching names (same type as current tab)
        const candidateCollections = this.collections.filter(collection => {
            if (!collection.name) return false;

            // Check if collection has items from the same type (or is empty)
            if (collection.itemIds && collection.itemIds.length > 0) {
                const hasMatchingType = collection.itemIds.some(itemId => {
                    const existingItem = this.data.items.find(i => i.id === itemId);
                    return existingItem && existingItem.type === currentType;
                });
                if (!hasMatchingType) return false;
            }

            return true; // Collection matches type requirement
        });

        if (candidateCollections.length === 0) return;

        // Normalize collection names and calculate match scores
        const scoredCollections = candidateCollections.map(collection => {
            const normalizedCollectionName = this.normalizeForMatching(collection.name);

            // Check if first word matches
            const baseWords = normalizedBaseName.split(/\s+/);
            const collectionWords = normalizedCollectionName.split(/\s+/);

            const firstWordMatch = baseWords[0] && collectionWords[0] && baseWords[0] === collectionWords[0];

            // Calculate word match score
            const wordScore = this.wordMatchScore(normalizedBaseName, normalizedCollectionName);

            // Check for exact match or starts-with match
            const exactMatch = normalizedBaseName === normalizedCollectionName;
            const startsWithMatch = normalizedBaseName.startsWith(normalizedCollectionName + ' ') ||
                normalizedCollectionName.startsWith(normalizedBaseName + ' ');

            return {
                collection,
                normalizedCollectionName,
                firstWordMatch,
                wordScore,
                exactMatch,
                startsWithMatch,
                score: exactMatch ? 1000 : (startsWithMatch ? 500 : (firstWordMatch ? wordScore * 10 : wordScore))
            };
        });

        // Sort by score (highest first)
        scoredCollections.sort((a, b) => b.score - a.score);

        // Get the best match (must have at least first word match or high word score)
        const bestMatch = scoredCollections.find(sc => sc.firstWordMatch || sc.wordScore >= 2) || scoredCollections[0];

        // Show notification if we have a good match
        if (bestMatch && (bestMatch.score > 0 || bestMatch.wordScore > 0)) {
            const collection = bestMatch.collection;
            const collectionGroup = document.getElementById('collectionGroup');
            if (collectionGroup) {
                // Check if notification already exists
                let notification = collectionGroup.querySelector('.collection-auto-match-notification');
                if (!notification) {
                    notification = document.createElement('div');
                    notification.className = 'collection-auto-match-notification';
                    collectionGroup.appendChild(notification);
                }

                notification.innerHTML = `
                      <div style="background: var(--hover-color); opacity: 0.2; padding: 0.5rem; border-radius: 4px; margin-top: 0.5rem; border: 1px solid var(--hover-color);">
                          <span style="color: var(--text-color);">✓ Will be added to collection: <strong>${collection.name}</strong></span>
                      </div>
                  `;

                // Auto-select the matched collection in the form (only if it exists - no auto-creation)
                document.getElementById('itemCollection').value = collection.id;
                document.getElementById('itemCollectionSearch').value = collection.name;
                document.getElementById('collectionSearchResults').innerHTML = '';
            }
        } else {
            // Remove notification if no match
            const collectionGroup = document.getElementById('collectionGroup');
            if (collectionGroup) {
                const notification = collectionGroup.querySelector('.collection-auto-match-notification');
                if (notification) {
                    notification.remove();
                }
            }

            // Clear collection selection if no match found and user hasn't manually selected one
            const currentCollectionValue = document.getElementById('itemCollection').value;
            const currentSearchValue = document.getElementById('itemCollectionSearch').value;
            // Only clear if the value was set by auto-match (check if search value matches a collection name)
            if (!currentCollectionValue || !currentSearchValue) {
                document.getElementById('itemCollection').value = '';
                document.getElementById('itemCollectionSearch').value = '';
            }
        }
    }

    normalizeForMatching(text) {
        // Remove special characters: : ' " ® ™ © and others, then normalize spaces
        return (text || '')
            .replace(/[®™©:'"]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    wordMatchScore(text1, text2) {
        // Calculate how many words match between two texts
        const words1 = text1.split(/\s+/).filter(w => w.length > 0);
        const words2 = text2.split(/\s+/).filter(w => w.length > 0);

        if (words1.length === 0 || words2.length === 0) return 0;

        // Count matching words (order matters - first word match is more important)
        let matches = 0;
        const maxLength = Math.max(words1.length, words2.length);

        for (let i = 0; i < Math.min(words1.length, words2.length); i++) {
            if (words1[i] === words2[i]) {
                matches++;
            } else {
                break; // Stop at first non-matching word for word-order matching
            }
        }

        // Also check if all words from shorter text are in longer text (for partial matches)
        if (matches === 0) {
            const shorter = words1.length <= words2.length ? words1 : words2;
            const longer = words1.length > words2.length ? words1 : words2;

            for (const word of shorter) {
                if (longer.includes(word)) {
                    matches++;
                }
            }
        }

        return matches;
    }

    async autoMatchCollectionByName(item) {
        // Extract base name from item name for matching
        let baseName = '';
        if (item.type === 'anime') {
            baseName = this.extractBaseAnimeName(item.name || '');
        } else if (item.type === 'games') {
            baseName = this.extractBaseGameName(item.name || '');
        } else if (item.type === 'movies' || item.type === 'tv') {
            baseName = this.extractBaseMovieSeriesName(item.name || '');
        } else {
            baseName = item.name || '';
        }

        if (!baseName) return;

        // Normalize the base name (remove special characters)
        const normalizedBaseName = this.normalizeForMatching(baseName);

        // Find collections with matching names (same type)
        const candidateCollections = this.collections.filter(collection => {
            if (!collection.name) return false;

            // Check if collection has items from the same type (or is empty)
            if (collection.itemIds && collection.itemIds.length > 0) {
                const hasMatchingType = collection.itemIds.some(itemId => {
                    const existingItem = this.data.items.find(i => i.id === itemId);
                    return existingItem && existingItem.type === item.type;
                });
                if (!hasMatchingType) return false;
            }

            return true; // Collection matches type requirement
        });

        if (candidateCollections.length === 0) return;

        // Normalize collection names and calculate match scores
        const scoredCollections = candidateCollections.map(collection => {
            const normalizedCollectionName = this.normalizeForMatching(collection.name);

            // Check if first word matches
            const baseWords = normalizedBaseName.split(/\s+/);
            const collectionWords = normalizedCollectionName.split(/\s+/);

            const firstWordMatch = baseWords[0] && collectionWords[0] && baseWords[0] === collectionWords[0];

            // Calculate word match score
            const wordScore = this.wordMatchScore(normalizedBaseName, normalizedCollectionName);

            // Check for exact match or starts-with match
            const exactMatch = normalizedBaseName === normalizedCollectionName;
            const startsWithMatch = normalizedBaseName.startsWith(normalizedCollectionName + ' ') ||
                normalizedCollectionName.startsWith(normalizedBaseName + ' ');

            return {
                collection,
                normalizedCollectionName,
                firstWordMatch,
                wordScore,
                exactMatch,
                startsWithMatch,
                score: exactMatch ? 1000 : (startsWithMatch ? 500 : (firstWordMatch ? wordScore * 10 : wordScore))
            };
        });

        // Sort by score (highest first)
        scoredCollections.sort((a, b) => b.score - a.score);

        // Get the best match (must have at least first word match or high word score)
        const bestMatch = scoredCollections.find(sc => sc.firstWordMatch || sc.wordScore >= 2) || scoredCollections[0];

        // Add item to best matching collection if we have a good match
        if (bestMatch && (bestMatch.score > 0 || bestMatch.wordScore > 0)) {
            const collection = bestMatch.collection;
            if (!collection.itemIds) {
                collection.itemIds = [];
            }
            if (!collection.itemIds.includes(item.id)) {
                collection.itemIds.push(item.id);
                console.log(`Auto-added "${item.name}" to collection "${collection.name}" (match score: ${bestMatch.score}, word score: ${bestMatch.wordScore})`);

                // Save collections to GitHub
                await this.saveCollectionToDB(collection);
            }
        }
    }

    async saveCollection() {
        const collectionName = document.getElementById('collectionNameInput').value.trim();
        if (!collectionName) {
            alert('Please enter a collection name');
            return;
        }

        if (this.currentCollectionItems.size === 0) {
            alert('Please select at least one item for the collection');
            return;
        }

        // Check if we're editing an existing collection
        if (this.currentEditingCollection) {
            // Update existing collection
            this.currentEditingCollection.itemIds = Array.from(this.currentCollectionItems);

            // Save to GitHub
            await this.saveCollectionToDB(this.currentEditingCollection);

            // Show success message and go back to collection view
            alert(`Collection "${collectionName}" updated with ${this.currentCollectionItems.size} item(s)!`);

            // Refresh the collection view
            const collectionToShow = this.currentEditingCollection;
            this.currentEditingCollection = null;
            this.collectionToReturnTo = null; // Clear return target since we're going back
            this.showCollectionView([collectionToShow], null);
            return;
        }

        // Create new collection object
        const collection = {
            id: `collection_${Date.now()}_${Math.random()}`,
            name: collectionName,
            itemIds: Array.from(this.currentCollectionItems),
            createdAt: new Date().toISOString()
        };

        // Add to collections
        this.collections.push(collection);

        // Save to GitHub
        await this.saveCollectionToDB(collection);

        // Show success message and go back
        alert(`Collection "${collectionName}" created with ${this.currentCollectionItems.size} item(s)!`);
        this.showLibraryView();
    }

    async showDetailView(item, options = {}) {
        // Prevent detail view from opening in delete mode
        if (this.isDeleteMode) {
            return;
        }

        // Hide scroll-to-top button when showing detail
        try {
            const scrollBtn = document.getElementById('scrollTopBtn');
            if (scrollBtn) scrollBtn.classList.remove('show');
        } catch (e) {
            /* ignore */
        }

        // Enrich raw items from Home/Search if they are missing details
        // This ensures items clicked from "Trending" etc. load full details (poster, banner, trailer)
        if (item && !this.isItemInLibrary(item) &&
            !String(item.id).startsWith('rec_') &&
            ['movies', 'tv', 'anime', 'games'].includes(item.type)) {

            // Check if it's a raw item (missing externalApiId or description)
            if (!item.externalApiId || !item.description || item.description === 'No description available.') {
                console.log('🔍 Enriching raw item for detail view:', {
                    id: item.id,
                    type: item.type,
                    title: item.title || item.name,
                    hasExternalApiId: !!item.externalApiId,
                    hasDescription: !!item.description,
                    hasPoster: !!item.posterBase64,
                    hasBanner: !!item.bannerBase64
                });
                try {
                    const enriched = await this.buildTransientItemFromExternal(item.type, item.id, {
                        name: item.title || item.name,
                        recommendation: item
                    });

                    if (enriched) {
                        console.log('✅ Enriched item successfully:', {
                            id: enriched.id,
                            type: enriched.type,
                            title: enriched.title || enriched.name,
                            hasExternalApiId: !!enriched.externalApiId,
                            externalApiId: enriched.externalApiId,
                            hasDescription: !!enriched.description,
                            hasPoster: !!enriched.posterBase64,
                            hasBanner: !!enriched.bannerBase64,
                            posterUrl: enriched.posterBase64?.substring(0, 100),
                            bannerUrl: enriched.bannerBase64?.substring(0, 100)
                        });
                        item = enriched;
                    } else {
                        // Fallback: For OMDB items, fetch TMDB data on-demand for detail sections
                        console.warn('Enrichment returned null, fetching TMDB data on-demand');
                        if (item.type === 'movies' || item.type === 'tv') {
                            // Keep OMDB data for display
                            if (!item.description && item.overview) item.description = item.overview;
                            if (!item.posterBase64 && item.poster_path) {
                                item.posterBase64 = item.poster_path.startsWith('http') ? item.poster_path : `https://image.tmdb.org/t/p/w500${item.poster_path}`;
                            }
                            if (!item.bannerBase64 && item.backdrop_path) {
                                item.bannerBase64 = item.backdrop_path.startsWith('http') ? item.backdrop_path : `https://image.tmdb.org/t/p/original${item.backdrop_path}`;
                            }

                            // Fetch TMDB ID for detail sections (trailer, recommendations, reviews, cast)
                            if (item.id && !item.externalApiId) {
                                try {
                                    const mediaType = item.type === 'movies' ? 'movies' : 'tv';
                                    const tmdbResponse = await apiFetch(`${API_URL}/api/tmdb-details?category=${mediaType}&id=${item.id}`);
                                    if (tmdbResponse.ok) {
                                        const tmdbData = await tmdbResponse.json();
                                        item.externalApiId = String(item.id);
                                        console.log('✅ Fetched TMDB data for detail sections, externalApiId:', item.externalApiId);
                                    }
                                } catch (err) {
                                    console.warn('Failed to fetch TMDB data:', err);
                                }
                            }
                            // If we still don't have an externalApiId, try searching TMDB by title as a fallback
                            if (!item.externalApiId && item.title) {
                                try {
                                    const query = encodeURIComponent(item.title || item.name || '');
                                    const serviceType = item.type === 'movies' ? 'movie' : (item.type === 'tv' ? 'tv' : '');
                                    console.log('🔎 Attempting TMDB search fallback for title:', item.title, 'type:', serviceType);
                                    const searchResp = await apiFetch(`${API_URL}/api/search?query=${query}&category=${serviceType}&service=tmdb`);
                                    if (searchResp.ok) {
                                        const searchData = await searchResp.json();
                                        const first = (searchData.results && searchData.results.length) ? searchData.results[0] : null;
                                        if (first && first.id) {
                                            item.externalApiId = String(first.id);
                                            console.log('✅ TMDB search fallback found id:', item.externalApiId, 'for', item.title);
                                            // Populate poster/banner URLs from the search result so the detail view can show images immediately
                                            try {
                                                if (!item.posterBase64) {
                                                    const posterPath = first.poster_path || first.poster;
                                                    if (posterPath) {
                                                        item.posterBase64 = posterPath.startsWith('http') ? posterPath : `https://image.tmdb.org/t/p/w500${posterPath}`;
                                                    }
                                                }
                                                if (!item.bannerBase64) {
                                                    const backdropPath = first.backdrop_path || first.backdrop;
                                                    if (backdropPath) {
                                                        item.bannerBase64 = backdropPath.startsWith('http') ? backdropPath : `https://image.tmdb.org/t/p/original${backdropPath}`;
                                                    }
                                                }
                                            } catch (imgErr) {
                                                console.warn('Failed to set poster/banner from TMDB search result:', imgErr);
                                            }
                                        } else {
                                            console.warn('TMDB search fallback returned no results for', item.title);
                                        }
                                    }
                                } catch (err) {
                                    console.warn('TMDB search fallback failed:', err);
                                }
                            }
                        }
                    }

                    // Ensure externalApiId is set for detail sections to load
                    if (!item.externalApiId && item.id) {
                        item.externalApiId = String(item.id);
                        console.log('Set externalApiId from id:', item.externalApiId);
                    }
                } catch (err) {
                    console.error('Failed to enrich item:', err);
                }
            }
        }

        const { delayForBanner = false } = options;

        // Close any open menus
        this.closeSettingsMenu();
        this.closeDetailSettingsMenu();
        this.closeAddMenu();
        this.closeSortMenu();
        this.closeFilterMenu();

        // Track previous view before switching to detail
        const isTransient = item && typeof item.id === 'string' && item.id.startsWith('rec_');

        if (this.currentView !== 'detail') {
            this.previousView = this.currentView;
            // If coming from search view, store search state
            if (this.currentView === 'search') {
                // Store search query and results state
                const searchQuery = document.getElementById('searchQuery').textContent.replace(/"/g, '').trim();
                this.searchState = {
                    query: searchQuery,
                    results: { ...this.searchResults },
                    filteredResults: { ...this.filteredSearchResults },
                    filterValues: this.getSearchFilterValues()
                };
            }
            // If coming from collection view, preserve the sequelsViewSource
            if (this.currentView === 'sequels' && this.sequelsViewSource === 'collection') {
                // Preserve sequelsViewSourceItem if not already set
                if (!this.sequelsViewSourceItem && this.currentViewedCollection) {
                    // Set it to the item being viewed
                    this.sequelsViewSourceItem = item;
                }
            }
        }

        const detailViewElement = document.getElementById('detailView');
        let previousDetailOpacity = '';
        let previousDetailPointerEvents = '';
        // Skip banner preload delay for library items - their images are stored locally
        // Only delay for non-library items (from home/search) that need to fetch remote images
        const isLibraryItem = this.isItemInLibrary(item);
        const shouldDelayBanner = delayForBanner && this.shouldDelayDetailBanner(item);
        const shouldMaskDetail = shouldDelayBanner && detailViewElement;

        if (shouldMaskDetail) {
            previousDetailOpacity = detailViewElement.style.opacity || '';
            previousDetailPointerEvents = detailViewElement.style.pointerEvents || '';
            detailViewElement.style.opacity = '0';
            detailViewElement.style.pointerEvents = 'none';
        }

        if (shouldDelayBanner) {
            try {
                await this.preloadDetailBanner(item);
            } catch (err) {
                console.warn('Failed to preload detail banner:', err);
            }
        }

        this.currentView = 'detail';
        this.currentItem = item;

        // Hide all views, show detail view
        const homeView = document.getElementById('homeView');
        const libraryView = document.getElementById('libraryView');
        const sequelsView = document.getElementById('sequelsView');
        const collectionView = document.getElementById('collectionView');
        const insightsView = document.getElementById('insightsView');
        const searchView = document.getElementById('searchView');

        if (homeView) homeView.style.display = 'none';
        if (libraryView) libraryView.style.display = 'none';
        if (sequelsView) sequelsView.style.display = 'none';
        if (collectionView) collectionView.style.display = 'none';
        if (insightsView) insightsView.style.display = 'none';
        if (searchView) searchView.style.display = 'none';
        this.setInsightsButtonState(false);
        if (detailViewElement) detailViewElement.style.display = 'block';
        const backBtnEl = document.getElementById('backBtn');
        if (backBtnEl) backBtnEl.style.display = 'inline-block';
        document.getElementById('searchInput').style.display = 'block';
        document.getElementById('settingsBtn').style.display = 'none';
        document.querySelector('.controls-row').classList.add('hidden');
        document.querySelector('.tabs-row').classList.add('hidden');

        // Ensure detail view starts at the top
        const detailContent = document.getElementById('detailContentContainer');
        if (detailViewElement) detailViewElement.scrollTop = 0;
        if (detailContent) detailContent.scrollTop = 0;
        requestAnimationFrame(() => {
            if (detailViewElement) detailViewElement.scrollTop = 0;
            if (detailContent) detailContent.scrollTop = 0;
            window.scrollTo({ top: 0, behavior: 'auto' });
        });

        if (detailViewElement) {
            if (item.type === 'actors') detailViewElement.classList.add('actor-view');
            else detailViewElement.classList.remove('actor-view');

            if (isTransient) {
                detailViewElement.classList.add('transient-view');
            } else {
                detailViewElement.classList.remove('transient-view');
            }

            // Add non-library class for items not in user's library (for darker banner)
            if (!this.isItemInLibrary(item)) {
                detailViewElement.classList.add('non-library');
            } else {
                detailViewElement.classList.remove('non-library');
            }
        }

        await this.renderDetailView(item);

        // Final safety check: ensure menus are closed after rendering
        requestAnimationFrame(() => {
            this.closeAddMenu();
            this.closeSettingsMenu();
            this.closeSortMenu();
            this.closeFilterMenu();

            // Force hide add menu with inline style as well
            const addMenu = document.getElementById('addMenu');
            if (addMenu) {
                addMenu.classList.remove('show');
                addMenu.style.display = 'none';
            }

            // Ensure detail view is visible
            const detailViewCheck = document.getElementById('detailView');
            if (detailViewCheck) {
                detailViewCheck.style.display = 'block';
            }
        });

        if (shouldMaskDetail && detailViewElement) {
            await this.waitForDetailBannerReady(item);
            detailViewElement.style.opacity = previousDetailOpacity;
            detailViewElement.style.pointerEvents = previousDetailPointerEvents;
        }
    }

    /**
     * Applies current filters and sorting to a given array of items.
     * This method is reusable for different item sources (library, watchlist, search results).
     * @param {Array<Object>} items - The array of items to filter and sort.
     * @returns {Array<Object>} The filtered and sorted array of items.
     */
    applyFilters(items) {
        let filteredItems = [...items];
        const searchTerm = document.getElementById('searchInput').value.toLowerCase();
        if (searchTerm) {
            filteredItems = filteredItems.filter(item =>
                (item.name && item.name.toLowerCase().includes(searchTerm)) ||
                (item.genre && item.genre.toLowerCase().includes(searchTerm)) ||
                (item.description && item.description.toLowerCase().includes(searchTerm))
            );
        }

        const genreFilter = document.getElementById('filterSelect').value;
        if (genreFilter) {
            filteredItems = filteredItems.filter(item =>
                item.genre && item.genre.toLowerCase().includes(genreFilter.toLowerCase())
            );
        }

        const sortValue = document.getElementById('sortSelect').value;
        const [field, direction] = sortValue.split('-');

        filteredItems.sort((a, b) => {
            let aVal = a[field], bVal = b[field];
            if (field === 'name') {
                aVal = (aVal || '').toLowerCase();
                bVal = (bVal || '').toLowerCase();
            } else if (field === 'myRank') {
                aVal = parseFloat(aVal) || 0;
                bVal = parseFloat(bVal) || 0;
            } else if (field === 'year' || field === 'userScore') {
                aVal = parseInt(aVal) || 0;
                bVal = parseInt(bVal) || 0;
            }
            return direction === 'asc' ? (aVal > bVal ? 1 : -1) : (aVal < bVal ? 1 : -1);
        });

        return filteredItems;
    }

    /**
     * Retrieves items from the library and applies current filters and sorting.
     * @returns {Array<Object>} The filtered and sorted library items.
     */
    getFilteredItems(items = null) {
        const filteredItems = items || this.data.items.filter(item => item.type === this.currentTab);
        return this.applyFilters(filteredItems);
    }

    // ---------- RENDERING ----------
    renderLibrary() {
        const container = document.getElementById('gridContainer');
        let items;
        container.innerHTML = '';

        // If showing watchlist, show ALL watchlisted items (library + on-demand)
        if (this.showWatchlistInLibrary) {
            const watchlist = this.getWatchlist();
            console.log(`📋 Watchlist toggle active - Total items in watchlist: ${watchlist.length}`);
            console.log(`📋 Watchlist items by type:`, watchlist.reduce((acc, w) => { acc[w.type || 'undefined'] = (acc[w.type || 'undefined'] || 0) + 1; return acc; }, {}));
            console.log(`📋 Current tab: ${this.currentTab}`);

            // Filter watchlist by current tab
            const watchlistForTab = watchlist.filter(w => w.type === this.currentTab);
            console.log(`📋 Watchlist items matching current tab '${this.currentTab}': ${watchlistForTab.length}`);

            // Map to library items if available, otherwise keep watchlist item
            const combinedItems = watchlistForTab.map(w => {
                // Try to find in library by ID or external ID
                const libraryItem = this.data.items.find(i =>
                    (w.id && i.id === w.id) ||
                    (w.externalApiId && i.externalApiId === w.externalApiId && i.type === w.type)
                );
                // If found, use library item. If not, use watchlist item
                return libraryItem || w;
            });

            // Apply filters (search, sort, etc.)
            items = this.applyFilters(combinedItems);

            console.log(`📋 Watchlist view: Showing ${items.length} items for ${this.currentTab}`);
            items.forEach(item => container.appendChild(this.createGridItem(item, { showRank: true })));
            return;
        }

        // Normal library view
        items = this.getFilteredItems();

        // If showing collections, filter out items that are in visible collections
        let itemsToShow = items;
        let collectionsToShow = [];

        if (this.showCollectionsInLibrary) {
            // Get collections that match the current tab OR are empty collections created in this tab
            // Show empty collections only if they were created in the current tab
            // Show collections with items from current tab
            collectionsToShow = this.collections.filter(collection => {
                // Show empty collections only if they match the current tab
                if (!collection.itemIds || collection.itemIds.length === 0) {
                    // If collection has a type field, only show if it matches current tab
                    if (collection.type) {
                        const matches = collection.type === this.currentTab;
                        if (matches) {
                            console.log(`📦 Showing empty collection created in "${this.currentTab}" tab: "${collection.name}"`);
                        } else {
                            console.log(`📦 Hiding empty collection created in "${collection.type}" tab (current: "${this.currentTab}"): "${collection.name}"`);
                        }
                        return matches;
                    }
                    // If no type field, show it (for backward compatibility with old collections)
                    console.log(`📦 Showing empty collection (no type): "${collection.name}"`);
                    return true;
                }
                // Show collections that have at least one item from current tab
                // Filter out invalid itemIds (items that don't exist anymore)
                const validItemIds = collection.itemIds.filter(itemId => {
                    return this.data.items.some(i => i.id === itemId);
                });
                // If collection has no valid items, show it only if it matches the current tab (like empty collections)
                if (validItemIds.length === 0) {
                    if (collection.type) {
                        const matches = collection.type === this.currentTab;
                        if (matches) {
                            console.log(`📦 Showing collection with invalid itemIds (created in "${this.currentTab}" tab): "${collection.name}"`);
                        } else {
                            console.log(`📦 Hiding collection with invalid itemIds (created in "${collection.type}" tab, current: "${this.currentTab}"): "${collection.name}"`);
                        }
                        return matches;
                    }
                    // If no type field, show it (for backward compatibility)
                    console.log(`📦 Showing collection with invalid itemIds (no type): "${collection.name}"`);
                    return true;
                }
                // Show if it has at least one valid item from current tab
                const hasMatchingItem = validItemIds.some(itemId => {
                    const item = this.data.items.find(i => i.id === itemId);
                    return item && item.type === this.currentTab;
                });
                if (!hasMatchingItem) {
                    console.log(`📦 Hiding collection "${collection.name}" - has ${validItemIds.length} items but none match current tab "${this.currentTab}"`);
                } else {
                    console.log(`📦 Showing collection "${collection.name}" - has items matching tab "${this.currentTab}"`);
                }
                return hasMatchingItem;
            });

            console.log(`📚 Total collections: ${this.collections.length}, Showing: ${collectionsToShow.length}, Current tab: ${this.currentTab}`);

            // Apply search filter to collections if there's a search term
            const searchTerm = document.getElementById('searchInput').value.toLowerCase();
            if (searchTerm) {
                collectionsToShow = collectionsToShow.filter(collection => {
                    return collection.name && collection.name.toLowerCase().includes(searchTerm);
                });
            }

            // Get all item IDs that are in visible collections
            const itemsInCollections = new Set();
            collectionsToShow.forEach(collection => {
                if (collection.itemIds) {
                    collection.itemIds.forEach(id => itemsInCollections.add(id));
                }
            });

            // Filter out items that are in visible collections
            itemsToShow = items.filter(item => !itemsInCollections.has(item.id));
        }

        // Render collections first
        collectionsToShow.forEach(collection => {
            container.appendChild(this.createCollectionLibraryItem(collection));
        });

        // Render remaining items
        itemsToShow.forEach(item => {
            container.appendChild(this.createGridItem(item, { showRank: true }));
        });
    }

    // ---------- HOME PAGE ----------
    renderHome() {
        console.log('renderHome called');
        // Ensure controls row is hidden on home tab
        const controlsRow = document.querySelector('.controls-row');
        if (controlsRow && this.currentTab === 'home') {
            controlsRow.classList.add('hidden');
            controlsRow.style.display = 'none';
        }

        // Setup scroll buttons for home rows
        this.setupHomeScrollButtons();

        // Ensure home view is visible
        const homeView = document.getElementById('homeView');
        if (!homeView) {
            console.error('homeView element not found in renderHome');
            // Try again after a short delay
            setTimeout(() => this.renderHome(), 100);
            return;
        }

        // Force show the home view if it's not visible
        const computedStyle = window.getComputedStyle(homeView);
        if (homeView.style.display === 'none' || computedStyle.display === 'none') {
            console.warn('homeView is hidden, forcing display');
            homeView.style.display = 'block';
            // Wait for display change to take effect
            requestAnimationFrame(() => {
                this.renderHome();
            });
            return;
        }

        // Verify containers exist - they should exist in the DOM
        const containerIds = ['latestTrailersRow', 'moviesCombinedRow', 'tvCombinedRow', 'animeAiringRow', 'gamesTrendingRow', 'peoplePopularRow'];
        const containers = {};
        let allContainersFound = true;

        for (const id of containerIds) {
            const container = document.getElementById(id);
            containers[id] = container;
            if (!container) {
                console.error(`Container ${id} not found!`);
                allContainersFound = false;
            }
        }

        if (!allContainersFound) {
            console.error('Some containers are missing, retrying in 100ms...');
            setTimeout(() => {
                console.log('Retrying renderHome after missing containers');
                this.renderHome();
            }, 100);
            return;
        }

        console.log('All containers found, proceeding with load');

        // Always load all rows when renderHome is called
        // Force reload to ensure fresh data is loaded
        console.log('Starting to load all home page data...');
        this.loadLatestTrailers(true);
        this.loadMoviesCombined(true);
        this.loadTVCombined(true);
        this.loadAnimeAiring(true);
        this.loadGamesTrending(true);
        this.loadPeoplePopular(true);
        console.log('All load functions called');
    }

    setupHomeScrollButtons() {
        // Setup scroll buttons for all home rows
        const scrollButtons = document.querySelectorAll('.home-scroll-btn');
        scrollButtons.forEach(btn => {
            // Remove existing listeners to prevent duplicates
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);

            newBtn.addEventListener('click', (e) => {
                const targetId = newBtn.getAttribute('data-target');
                const container = document.getElementById(targetId);
                if (!container) return;

                const scrollContainer = container.querySelector('.home-row-scroll');
                if (!scrollContainer) return;

                const scrollAmount = 600; // Scroll by 600px (about 3 items)
                const isLeft = newBtn.classList.contains('home-scroll-left');

                scrollContainer.scrollBy({
                    left: isLeft ? -scrollAmount : scrollAmount,
                    behavior: 'smooth'
                });
            });
        });
    }

    async loadMoviesTrending(timeWindow = 'week', forceReload = false) {
        console.log(`loadMoviesTrending called with timeWindow: ${timeWindow}, forceReload: ${forceReload}`);
        const container = document.getElementById('moviesTrendingRow');
        if (!container) {
            console.error('moviesTrendingRow container not found!');
            return;
        }

        // Check if we're already loading this exact data to prevent duplicate requests (unless forcing reload)
        const cacheKey = `moviesTrending_${timeWindow}`;
        if (!forceReload && this.homeLoading && this.homeLoading[cacheKey]) {
            console.log('Already loading moviesTrending, skipping');
            return;
        }

        if (!this.homeLoading) {
            this.homeLoading = {};
        }
        this.homeLoading[cacheKey] = true;

        container.innerHTML = '<div class="home-loading">Loading...</div>';

        try {
            console.log(`Fetching trending movies from: ${API_URL}/api/home/trending?timeWindow=${timeWindow}`);
            const response = await apiFetch(`${API_URL}/api/home/trending?timeWindow=${timeWindow}`);
            console.log(`Response status: ${response.status}`);
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to load trending: ${response.status} ${text.substring(0, 100)}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                throw new Error(`Expected JSON but got ${contentType}. Response: ${text.substring(0, 100)}`);
            }

            const data = await response.json();
            console.log(`Received trending movies data, results count:`, data.results?.length || 0);
            this.renderHomeRow(container, data.results || [], 'movies');
            this.homeDataLoaded.moviesTrending = true;
            console.log('Trending movies loaded successfully');
        } catch (error) {
            console.error('Error loading trending movies:', error);
            container.innerHTML = '<div class="home-error">Failed to load trending movies. Please check your API keys in Settings.</div>';
        } finally {
            delete this.homeLoading[cacheKey];
        }
    }

    async loadMoviesTrailers(forceReload = false) {
        console.log(`loadMoviesTrailers called, forceReload: ${forceReload}`);
        const container = document.getElementById('moviesTrailersRow');
        if (!container) {
            console.error('moviesTrailersRow container not found!');
            return;
        }

        // Check if we're already loading this exact data to prevent duplicate requests (unless forcing reload)
        const cacheKey = 'moviesTrailers';
        if (!forceReload && this.homeLoading && this.homeLoading[cacheKey]) {
            console.log('Already loading moviesTrailers, skipping');
            return;
        }

        if (!this.homeLoading) {
            this.homeLoading = {};
        }
        this.homeLoading[cacheKey] = true;

        container.innerHTML = '<div class="home-loading">Loading...</div>';

        try {
            console.log(`Fetching movies trailers from: ${API_URL}/api/home/movies/trailers`);
            const response = await apiFetch(`${API_URL}/api/home/movies/trailers`);
            console.log(`Response status: ${response.status}`);
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to load movies trailers: ${response.status} ${text.substring(0, 100)}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                throw new Error(`Expected JSON but got ${contentType}. Response: ${text.substring(0, 100)}`);
            }

            const data = await response.json();
            console.log(`Received movies trailers data, results count:`, data.results?.length || 0);
            this.renderHomeRow(container, data.results || [], 'trailers');
            this.homeDataLoaded.moviesTrailers = true;
            console.log('Movies trailers loaded successfully');
        } catch (error) {
            console.error('Error loading movies trailers:', error);
            container.innerHTML = '<div class="home-error">Failed to load movies trailers. Please check your API keys in Settings.</div>';
        } finally {
            delete this.homeLoading[cacheKey];
        }
    }

    async loadTVTrailers(forceReload = false) {
        console.log(`loadTVTrailers called, forceReload: ${forceReload}`);
        const container = document.getElementById('tvTrailersRow');
        if (!container) {
            console.error('tvTrailersRow container not found!');
            return;
        }

        // Check if we're already loading this exact data to prevent duplicate requests (unless forcing reload)
        const cacheKey = 'tvTrailers';
        if (!forceReload && this.homeLoading && this.homeLoading[cacheKey]) {
            console.log('Already loading tvTrailers, skipping');
            return;
        }

        if (!this.homeLoading) {
            this.homeLoading = {};
        }
        this.homeLoading[cacheKey] = true;

        container.innerHTML = '<div class="home-loading">Loading...</div>';

        try {
            console.log(`Fetching TV trailers from: ${API_URL}/api/home/tv/trailers`);
            const response = await apiFetch(`${API_URL}/api/home/tv/trailers`);
            console.log(`Response status: ${response.status}`);
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to load TV trailers: ${response.status} ${text.substring(0, 100)}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                throw new Error(`Expected JSON but got ${contentType}. Response: ${text.substring(0, 100)}`);
            }

            const data = await response.json();
            console.log(`Received TV trailers data, results count:`, data.results?.length || 0);
            this.renderHomeRow(container, data.results || [], 'trailers');
            this.homeDataLoaded.tvTrailers = true;
            console.log('TV trailers loaded successfully');
        } catch (error) {
            console.error('Error loading TV trailers:', error);
            container.innerHTML = '<div class="home-error">Failed to load TV trailers. Please check your API keys in Settings.</div>';
        } finally {
            delete this.homeLoading[cacheKey];
        }
    }

    async loadLatestTrailers(forceReload = false) {
        console.log(`loadLatestTrailers called, forceReload: ${forceReload}`);
        const container = document.getElementById('latestTrailersRow');
        if (!container) {
            console.error('latestTrailersRow container not found!');
            return;
        }

        // Check if we're already loading this exact data to prevent duplicate requests (unless forcing reload)
        const cacheKey = 'latestTrailers';
        if (!forceReload && this.homeLoading && this.homeLoading[cacheKey]) {
            console.log('Already loading latestTrailers, skipping');
            return;
        }

        if (!this.homeLoading) {
            this.homeLoading = {};
        }
        this.homeLoading[cacheKey] = true;

        container.innerHTML = '<div class="home-loading">Loading...</div>';

        try {
            console.log(`Fetching latest trailers from: ${API_URL}/api/home/movies/latest-trailers`);
            const response = await apiFetch(`${API_URL}/api/home/movies/latest-trailers`);
            console.log(`Response status: ${response.status}`);
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to load latest trailers: ${response.status} ${text.substring(0, 100)}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                throw new Error(`Expected JSON but got ${contentType}. Response: ${text.substring(0, 100)}`);
            }

            const data = await response.json();
            console.log(`Received latest trailers data, results count:`, data.results?.length || 0);
            this.renderTrailerCarousel(container, data.results || []);
            this.homeDataLoaded.latestTrailers = true;
            console.log('Latest trailers loaded successfully');
        } catch (error) {
            console.error('Error loading latest trailers:', error);
            container.innerHTML = '<div class="home-error">Failed to load trailers. Please check your API keys in Settings.</div>';
        } finally {
            delete this.homeLoading[cacheKey];
        }
    }

    async loadMoviesCombined(forceReload = false) {
        console.log(`loadMoviesCombined called, forceReload: ${forceReload}`);
        const container = document.getElementById('moviesCombinedRow');
        if (!container) {
            console.error('moviesCombinedRow container not found!');
            return;
        }

        // Check if we're already loading this exact data to prevent duplicate requests (unless forcing reload)
        const cacheKey = 'moviesCombined';
        if (!forceReload && this.homeLoading && this.homeLoading[cacheKey]) {
            console.log('Already loading moviesCombined, skipping');
            return;
        }

        if (!this.homeLoading) {
            this.homeLoading = {};
        }
        this.homeLoading[cacheKey] = true;

        container.innerHTML = '<div class="home-loading">Loading...</div>';

        try {
            console.log(`Fetching combined movies from: ${API_URL}/api/home/movies/combined`);
            const response = await apiFetch(`${API_URL}/api/home/movies/combined`);
            console.log(`Response status: ${response.status}`);
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to load combined movies: ${response.status} ${text.substring(0, 100)}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                throw new Error(`Expected JSON but got ${contentType}. Response: ${text.substring(0, 100)}`);
            }

            const data = await response.json();
            console.log(`Received combined movies data, results count:`, data.results?.length || 0);
            // Explicitly set type to 'movies' for each item
            const results = (data.results || []).map(item => ({ ...item, type: 'movies' }));
            this.renderHomeRow(container, results, 'movies');
            this.homeDataLoaded.moviesCombined = true;
            console.log('Combined movies loaded successfully');
        } catch (error) {
            console.error('Error loading combined movies:', error);
            container.innerHTML = '<div class="home-error">Failed to load movies. Please check your API keys in Settings.</div>';
        } finally {
            delete this.homeLoading[cacheKey];
        }
    }

    async loadTVCombined(forceReload = false) {
        console.log(`loadTVCombined called, forceReload: ${forceReload}`);
        const container = document.getElementById('tvCombinedRow');
        if (!container) {
            console.error('tvCombinedRow container not found!');
            return;
        }

        // Check if we're already loading this exact data to prevent duplicate requests (unless forcing reload)
        const cacheKey = 'tvCombined';
        if (!forceReload && this.homeLoading && this.homeLoading[cacheKey]) {
            console.log('Already loading tvCombined, skipping');
            return;
        }

        if (!this.homeLoading) {
            this.homeLoading = {};
        }
        this.homeLoading[cacheKey] = true;

        container.innerHTML = '<div class="home-loading">Loading...</div>';

        try {
            console.log(`Fetching combined TV series from: ${API_URL}/api/home/tv/combined`);
            const response = await apiFetch(`${API_URL}/api/home/tv/combined`);
            console.log(`Response status: ${response.status}`);
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to load combined TV series: ${response.status} ${text.substring(0, 100)}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                throw new Error(`Expected JSON but got ${contentType}. Response: ${text.substring(0, 100)}`);
            }

            const data = await response.json();
            console.log(`Received combined TV series data, results count:`, data.results?.length || 0);
            // Explicitly set type to 'tv' for each item
            const results = (data.results || []).map(item => ({ ...item, type: 'tv' }));
            this.renderHomeRow(container, results, 'movies'); // Use 'movies' type as it handles both movies and TV shows
            this.homeDataLoaded.tvCombined = true;
            console.log('Combined TV series loaded successfully');
        } catch (error) {
            console.error('Error loading combined TV series:', error);
            container.innerHTML = '<div class="home-error">Failed to load TV series. Please check your API keys in Settings.</div>';
        } finally {
            delete this.homeLoading[cacheKey];
        }
    }

    async loadAnimeAiring(forceReload = false) {
        console.log(`loadAnimeAiring called, forceReload: ${forceReload}`);
        const container = document.getElementById('animeAiringRow');
        if (!container) {
            console.warn('animeAiringRow container not found');
            return;
        }

        const cacheKey = 'animeAiring';
        if (!forceReload && this.homeLoading && this.homeLoading[cacheKey]) {
            console.log('Already loading animeAiring, skipping');
            return;
        }

        if (!this.homeLoading) {
            this.homeLoading = {};
        }
        this.homeLoading[cacheKey] = true;

        container.innerHTML = '<div class="home-loading">Loading...</div>';

        try {
            console.log(`Fetching airing anime from: ${API_URL}/api/home/anime/airing`);
            const response = await apiFetch(`${API_URL}/api/home/anime/airing`);
            console.log(`Response status: ${response.status}`);
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to load airing anime: ${response.status} ${text.substring(0, 100)}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                throw new Error(`Expected JSON but got ${contentType}. Response: ${text.substring(0, 100)}`);
            }

            const data = await response.json();
            console.log(`Received airing anime data, count:`, data.data?.length || 0);
            // Flatten anime structure and set type
            const results = (data.data || []).map(item => {
                const node = item.node || item;
                return {
                    ...node,
                    type: 'anime',
                    malId: node.id, // Ensure ID is available for getExternalIdForItem
                    id: node.id
                };
            });
            this.renderHomeRow(container, results, 'anime');
            this.homeDataLoaded.animeAiring = true;
            console.log('Airing anime loaded successfully');
        } catch (error) {
            console.error('Error loading airing anime:', error);
            container.innerHTML = '<div class="home-error">Failed to load airing anime. Please check your API keys in Settings.</div>';
        } finally {
            delete this.homeLoading[cacheKey];
        }
    }


    async loadGamesTrending(forceReload = false) {
        console.log(`loadGamesTrending called, forceReload: ${forceReload}`);
        const container = document.getElementById('gamesTrendingRow');
        if (!container) {
            console.warn('gamesTrendingRow container not found');
            return;
        }

        const cacheKey = 'gamesTrending';
        if (!forceReload && this.homeLoading && this.homeLoading[cacheKey]) {
            console.log('Already loading gamesTrending, skipping');
            return;
        }

        if (!this.homeLoading) {
            this.homeLoading = {};
        }
        this.homeLoading[cacheKey] = true;

        container.innerHTML = '<div class="home-loading">Loading...</div>';

        try {
            console.log(`Fetching trending games from: ${API_URL}/api/home/games/trending`);
            const response = await apiFetch(`${API_URL}/api/home/games/trending`);
            console.log(`Response status: ${response.status}`);
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to load trending games: ${response.status} ${text.substring(0, 100)}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                throw new Error(`Expected JSON but got ${contentType}. Response: ${text.substring(0, 100)}`);
            }

            const data = await response.json();
            console.log(`Received trending games data, results count:`, data.results?.length || 0);

            if (data.error) {
                throw new Error(data.error);
            }

            if (!data.results || data.results.length === 0) {
                container.innerHTML = '<div class="home-error">No trending games found. The Steam API may be slow or unavailable.</div>';
                return;
            }

            this.homeCache.gamesTrending = data.results;
            // Explicitly set type to 'games' for each item
            const results = (data.results || []).map(item => ({ ...item, type: 'games' }));
            this.renderHomeRow(container, results, 'games');
            this.homeDataLoaded.gamesTrending = true;
            console.log('Trending games loaded successfully');
        } catch (error) {
            console.error('Error loading trending games:', error);
            const fallbackGames = this.homeCache?.gamesTrending;
            if (fallbackGames && fallbackGames.length) {
                container.innerHTML = '';
                const notice = document.createElement('div');
                notice.className = 'home-error';
                notice.textContent = 'Steam API is temporarily unavailable. Showing your last synced trending games.';
                container.appendChild(notice);

                const fallbackContainer = document.createElement('div');
                container.appendChild(fallbackContainer);
                this.renderHomeRow(fallbackContainer, fallbackGames, 'games');
            } else {
                container.innerHTML = `<div class="home-error">Failed to load trending games: ${error.message}</div>`;
            }
        } finally {
            delete this.homeLoading[cacheKey];
        }
    }


    async loadPeoplePopular(forceReload = false) {
        console.log(`loadPeoplePopular called, forceReload: ${forceReload}`);
        const container = document.getElementById('peoplePopularRow');
        if (!container) {
            console.warn('peoplePopularRow container not found');
            return;
        }

        const cacheKey = 'peoplePopular';
        if (!forceReload && this.homeLoading && this.homeLoading[cacheKey]) {
            console.log('Already loading peoplePopular, skipping');
            return;
        }

        if (!this.homeLoading) {
            this.homeLoading = {};
        }
        this.homeLoading[cacheKey] = true;

        container.innerHTML = '<div class="home-loading">Loading...</div>';

        try {
            console.log(`Fetching popular people from: ${API_URL}/api/home/people/popular`);
            const response = await apiFetch(`${API_URL}/api/home/people/popular`);
            console.log(`Response status: ${response.status}`);
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Failed to load popular people: ${response.status} ${text.substring(0, 100)}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                throw new Error(`Expected JSON but got ${contentType}. Response: ${text.substring(0, 100)}`);
            }

            const data = await response.json();
            console.log(`Received popular people data, results count:`, data.results?.length || 0);

            if (data.error) {
                throw new Error(data.error);
            }

            if (!data.results || data.results.length === 0) {
                container.innerHTML = '<div class="home-error">No popular people found.</div>';
                return;
            }

            // Explicitly set type to 'actors' for each item
            const results = (data.results || []).map(item => ({ ...item, type: 'actors' }));
            this.renderHomeRow(container, results, 'actors');
            this.homeDataLoaded.peoplePopular = true;
            console.log('Popular people loaded successfully');
        } catch (error) {
            console.error('Error loading popular people:', error);
            container.innerHTML = `<div class="home-error">Failed to load popular people: ${error.message}</div>`;
        } finally {
            delete this.homeLoading[cacheKey];
        }
    }


    renderTrailerCarousel(container, items) {
        container.innerHTML = '';
        if (!items || items.length === 0) {
            container.innerHTML = '<div class="home-error">No trailers found</div>';
            return;
        }

        // Filter items that have trailer keys or IDs (we need to be able to play them)
        // For the carousel, we prefer items with direct trailer keys for thumbnails
        // But we can fallback to poster if needed, though user asked for YouTube thumbnail
        const validItems = items.filter(item => item.trailer_key || item.id);

        if (validItems.length === 0) {
            container.innerHTML = '<div class="home-error">No valid trailers found</div>';
            return;
        }

        const carouselContainer = document.createElement('div');
        carouselContainer.className = 'trailer-carousel-container';

        const track = document.createElement('div');
        track.className = 'trailer-carousel-track';

        // Create cards
        validItems.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'trailer-card-3d';
            card.dataset.index = index;

            // YouTube Thumbnail with multiple fallbacks
            let thumbUrl = '';
            let posterFallbackUrl = '';

            // Determine poster fallback URL (handle both full URLs and TMDB path fragments)
            if (item.poster_path) {
                if (item.poster_path.startsWith('http')) {
                    posterFallbackUrl = item.poster_path;
                } else {
                    posterFallbackUrl = `https://image.tmdb.org/t/p/w780${item.poster_path}`;
                }
            }
            // Also try backdrop as fallback (often works better for trailer thumbnails)
            if (!posterFallbackUrl && item.backdrop_path) {
                if (item.backdrop_path.startsWith('http')) {
                    posterFallbackUrl = item.backdrop_path;
                } else {
                    posterFallbackUrl = `https://image.tmdb.org/t/p/w1280${item.backdrop_path}`;
                }
            }

            if (item.trailer_key) {
                thumbUrl = `https://img.youtube.com/vi/${item.trailer_key}/maxresdefault.jpg`;
            } else if (posterFallbackUrl) {
                thumbUrl = posterFallbackUrl;
            }

            const img = document.createElement('img');
            img.src = thumbUrl;
            img.alt = item.title || item.name;

            // Multi-level fallback for YouTube thumbnails
            if (item.trailer_key) {
                let fallbackLevel = 0;
                img.onerror = function () {
                    fallbackLevel++;
                    if (fallbackLevel === 1) {
                        // First fallback: try hqdefault
                        this.src = `https://img.youtube.com/vi/${item.trailer_key}/hqdefault.jpg`;
                    } else if (fallbackLevel === 2 && posterFallbackUrl) {
                        // Second fallback: use TMDB poster/backdrop
                        this.src = posterFallbackUrl;
                    } else {
                        // Final fallback: remove onerror to prevent loop
                        this.onerror = null;
                    }
                };
            }

            const playIcon = document.createElement('div');
            playIcon.className = 'play-icon';
            playIcon.innerHTML = '▶';

            const infoOverlay = document.createElement('div');
            infoOverlay.className = 'trailer-info-overlay';

            const title = document.createElement('h3');
            title.className = 'trailer-title-3d';
            title.textContent = this.truncateTitleAtColon(item.title || item.name);

            infoOverlay.appendChild(title);
            card.appendChild(img);
            card.appendChild(playIcon);
            card.appendChild(infoOverlay);

            // Play button click handler
            playIcon.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent card click bubbling
                updateCarousel(index); // Rotate to this card
                this.playTrailer(item, 'trailers'); // Play the video
            });

            // Card click handler (navigation)
            card.addEventListener('click', () => {
                if (!card.classList.contains('active')) {
                    updateCarousel(index);
                } else {
                    // If active, clicking background also plays
                    this.playTrailer(item, 'trailers');
                }
            });

            track.appendChild(card);
        });

        // Navigation Buttons
        const prevBtn = document.createElement('button');
        prevBtn.className = 'carousel-nav-btn carousel-prev';
        prevBtn.innerHTML = '‹';

        const nextBtn = document.createElement('button');
        nextBtn.className = 'carousel-nav-btn carousel-next';
        nextBtn.innerHTML = '›';

        carouselContainer.appendChild(track);
        carouselContainer.appendChild(prevBtn);
        carouselContainer.appendChild(nextBtn);
        container.appendChild(carouselContainer);

        // Carousel Logic
        let activeIndex = 0;
        const cards = track.querySelectorAll('.trailer-card-3d');
        const totalCards = cards.length;

        const updateCarousel = (newIndex) => {
            activeIndex = (newIndex + totalCards) % totalCards;


            cards.forEach((card, i) => {
                // Calculate distance from active index
                let offset = i - activeIndex;

                // Handle wrap-around for infinite feel logic (simplified here)
                // For true 3D stack, we just want relative positions

                // Reset styles
                card.className = 'trailer-card-3d';
                card.style.transform = '';
                card.style.zIndex = '';
                card.style.opacity = '';

                if (i === activeIndex) {
                    card.classList.add('active');
                    card.style.zIndex = 10;
                    card.style.transform = 'translateX(0) scale(1)';
                    card.style.opacity = 1;
                } else if (i === (activeIndex - 1 + totalCards) % totalCards) {
                    // Previous
                    card.style.zIndex = 5;
                    card.style.transform = 'translateX(-60%) scale(0.8)';
                    card.style.opacity = 0.6;
                } else if (i === (activeIndex + 1) % totalCards) {
                    // Next
                    card.style.zIndex = 5;
                    card.style.transform = 'translateX(60%) scale(0.8)';
                    card.style.opacity = 0.6;
                } else {
                    // Others hidden behind
                    card.style.zIndex = 0;
                    card.style.opacity = 0;
                    // Position them behind center to avoid popping
                    card.style.transform = 'translateX(0) scale(0.5)';
                }
            });
        };

        prevBtn.addEventListener('click', () => updateCarousel(activeIndex - 1));
        nextBtn.addEventListener('click', () => updateCarousel(activeIndex + 1));

        // Touch/Swipe support for mobile
        let touchStartX = 0;
        let touchEndX = 0;

        track.addEventListener('touchstart', (e) => {
            touchStartX = e.changedTouches[0].screenX;
        }, { passive: true });

        track.addEventListener('touchend', (e) => {
            touchEndX = e.changedTouches[0].screenX;
            handleSwipe();
        }, { passive: true });

        const handleSwipe = () => {
            const swipeThreshold = 50; // minimum swipe distance in pixels
            const swipeDistance = touchStartX - touchEndX;

            if (Math.abs(swipeDistance) > swipeThreshold) {
                if (swipeDistance > 0) {
                    // Swiped left - go to next
                    updateCarousel(activeIndex + 1);
                } else {
                    // Swiped right - go to previous
                    updateCarousel(activeIndex - 1);
                }
            }
        };

        // Initialize
        updateCarousel(0);

        // Auto-rotate? Maybe not for trailers, user wants to browse.

    }

    // Helper function to truncate title at colon for cleaner display
    truncateTitleAtColon(title) {
        if (!title) return '';
        const colonIndex = title.indexOf(':');
        if (colonIndex > 0) {
            return title.substring(0, colonIndex).trim();
        }
        return title;
    }

    renderHomeRow(container, items, type) {
        container.innerHTML = '';

        if (!items || items.length === 0) {
            container.innerHTML = '<div class="home-error">No items found</div>';
            return;
        }

        const scrollContainer = document.createElement('div');
        scrollContainer.className = 'home-row-scroll';

        items.forEach(item => {
            const card = document.createElement('div');
            card.className = 'home-item-card';

            let posterUrl = '';
            let title = '';
            let subtitle = '';
            let rating = '';

            if (type === 'movies') {
                // Handle OMDb poster URLs (full URLs) or TMDb paths
                if (item.poster_path) {
                    if (item.poster_path.startsWith('http')) {
                        // OMDb full URL - use proxy to avoid CORS
                        posterUrl = `${API_URL}/api/poster?url=${encodeURIComponent(item.poster_path)}`;
                    } else {
                        // TMDb path
                        posterUrl = `https://image.tmdb.org/t/p/w300${item.poster_path}`;
                    }
                }
                title = this.truncateTitleAtColon(item.title || item.name || '');
                subtitle = item.release_date || item.first_air_date || '';
                rating = item.vote_average ? `${Math.round(item.vote_average)}%` : '';

                // Click handler for movies/series to open detail view
                card.style.cursor = 'pointer';
                card.addEventListener('click', () => {
                    this.openDetailView(item);
                });
            } else if (type === 'trailers') {
                // Handle OMDb poster URLs (full URLs) or TMDb paths
                if (item.poster_path) {
                    if (item.poster_path.startsWith('http')) {
                        // OMDb full URL - use proxy to avoid CORS
                        posterUrl = `${API_URL}/api/poster?url=${encodeURIComponent(item.poster_path)}`;
                    } else {
                        // TMDb path
                        posterUrl = `https://image.tmdb.org/t/p/w300${item.poster_path}`;
                    }
                }
                title = this.truncateTitleAtColon(item.title || item.name || '');
                // Truncate overview to 100 characters for trailers to prevent spacing issues
                const overview = item.overview || '';
                subtitle = overview.length > 100 ? overview.substring(0, 100).trim() + '...' : overview;
                rating = item.vote_average ? `${Math.round(item.vote_average)}%` : '';
                card.classList.add('trailer-card');

                // Add click handler to open YouTube trailer
                if (item.trailer_key || item.trailer_search_url || item.id) {
                    card.style.cursor = 'pointer';
                    card.addEventListener('click', () => {
                        this.playTrailer(item, 'trailers');
                    });
                }
            } else if (type === 'anime') {
                const node = item.node || item;
                posterUrl = node.main_picture?.large || node.main_picture?.medium || '';
                title = node.title || '';
                // Format number with commas (e.g., 217836 -> 217,836)
                const membersCount = node.num_list_users || 0;
                const formattedMembers = membersCount.toLocaleString('en-US');
                subtitle = `${formattedMembers} members`;
                rating = node.mean ? `${Math.round(node.mean * 10)}%` : 'N/A';
            } else if (type === 'games') {
                posterUrl = item.header_image || item.poster_path || '';
                title = item.name || item.title || '';
                subtitle = item.release_date?.date || item.release_date || '';
                rating = item.vote_average ? `${Math.round(item.vote_average)}%` : '';
                card.classList.add('home-item-card-game');

                // Add click handler for games to open detail view
                card.style.cursor = 'pointer';
                card.addEventListener('click', () => {
                    this.openDetailView(item);
                });
            } else if (type === 'actors') {
                // Handle people/celebrities from TMDB
                posterUrl = item.profile_path || item.poster_path || '';
                title = item.name || '';
                // Show known for department or known_for titles
                if (item.known_for && item.known_for.length > 0) {
                    subtitle = item.known_for.map(k => k.title || k.name).filter(Boolean).slice(0, 2).join(', ');
                } else {
                    subtitle = item.known_for_department || 'Acting';
                }
                // Use popularity as a pseudo-rating (scaled to percentage)
                rating = item.popularity ? `${Math.round(item.popularity)}` : '';

                // Add class for circular poster styling
                card.classList.add('home-item-card-actor');

                // Add click handler for actors to open detail view
                card.style.cursor = 'pointer';
                card.addEventListener('click', () => {
                    this.openDetailView(item);
                });
            }

            // Check if this anime has a trailer (all anime in airing section should have trailers)
            const hasTrailer = type === 'anime' && (item.node?.trailer_search_url || item.node?.trailer_key || item.trailer_search_url || item.trailer_key);

            // Determine if this item has a trailer/play button
            // Only show play button for the "Latest Trailers" section
            const hasPlayButton = type === 'trailers';

            // Create poster container
            const posterDiv = document.createElement('div');
            posterDiv.className = 'home-item-poster';

            // Create image or placeholder
            if (posterUrl) {
                const img = document.createElement('img');
                img.src = posterUrl;
                img.alt = title || '';
                img.loading = 'lazy';
                img.onerror = function () {
                    this.onerror = null;
                    const placeholder = document.createElement('div');
                    placeholder.className = 'home-item-placeholder';
                    placeholder.textContent = 'No Image';
                    this.parentElement.replaceChild(placeholder, this);
                };
                posterDiv.appendChild(img);
            } else {
                const placeholder = document.createElement('div');
                placeholder.className = 'home-item-placeholder';
                placeholder.textContent = 'No Image';
                posterDiv.appendChild(placeholder);
            }

            // Add rating badge (hidden on hover) - circular score indicator
            // Skip for actors (people) as requested
            if (rating && type !== 'actors') {
                const scoreValue = parseInt(rating) || 0;
                const ratingBadge = document.createElement('div');
                ratingBadge.className = 'home-item-rating';

                // Calculate stroke properties for the progress circle
                const radius = 16;
                const circumference = 2 * Math.PI * radius;
                const strokeDashoffset = circumference - (scoreValue / 100) * circumference;

                // Determine color based on score
                let strokeColor = '#21d07a'; // Green for good scores (70+)
                let trackColor = 'rgba(33, 208, 122, 0.3)';
                if (scoreValue < 40) {
                    strokeColor = '#db2360'; // Red for bad scores
                    trackColor = 'rgba(219, 35, 96, 0.3)';
                } else if (scoreValue < 70) {
                    strokeColor = '#d2d531'; // Yellow for medium scores
                    trackColor = 'rgba(210, 213, 49, 0.3)';
                }

                ratingBadge.innerHTML = `
                    <svg class="score-ring" viewBox="0 0 40 40">
                        <circle class="score-ring-bg" cx="20" cy="20" r="${radius}" 
                            fill="none" stroke="${trackColor}" stroke-width="3"/>
                        <circle class="score-ring-progress" cx="20" cy="20" r="${radius}" 
                            fill="none" stroke="${strokeColor}" stroke-width="3"
                            stroke-linecap="round"
                            stroke-dasharray="${circumference}"
                            stroke-dashoffset="${strokeDashoffset}"
                            transform="rotate(-90 20 20)"/>
                    </svg>
                    <span class="score-value">${scoreValue}<sup>%</sup></span>
                `;
                posterDiv.appendChild(ratingBadge);
            }

            // Add hover overlay (show play button only)
            if (hasPlayButton) {
                const overlay = document.createElement('div');
                overlay.className = 'home-item-hover-overlay';

                const playBtn = document.createElement('div');
                playBtn.className = 'home-hover-play-button';
                playBtn.textContent = '▶';
                overlay.appendChild(playBtn);

                posterDiv.appendChild(overlay);
            }

            // Create info section
            const infoDiv = document.createElement('div');
            infoDiv.className = 'home-item-info';

            const titleDiv = document.createElement('div');
            titleDiv.className = 'home-item-title';
            titleDiv.textContent = title || '';

            const subtitleDiv = document.createElement('div');
            subtitleDiv.className = 'home-item-subtitle';
            subtitleDiv.textContent = subtitle || '';

            infoDiv.appendChild(titleDiv);
            infoDiv.appendChild(subtitleDiv);

            // Append to card
            card.appendChild(posterDiv);
            card.appendChild(infoDiv);

            // Add click handler for all anime (they all have trailers in the airing section)
            if (type === 'anime') {
                card.classList.add('trailer-card');
                card.style.cursor = 'pointer';
                card.addEventListener('click', () => {
                    // User requested to open detail view instead of playing trailer for anime
                    this.openDetailView(item);
                });
            }

            scrollContainer.appendChild(card);
        });

        container.appendChild(scrollContainer);

        // Setup scroll buttons after content is rendered
        // Use setTimeout to ensure DOM is ready
        setTimeout(() => {
            this.setupHomeScrollButtons();
        }, 0);
    }

    // ---------- TRAILER PLAYBACK ----------
    async playTrailer(item, type) {
        let trailerKey = item.trailer_key;

        // If we already have a key, play it
        if (trailerKey) {
            this.openTrailerModal(trailerKey);
            return;
        }

        // If no key, try to fetch it
        if (type === 'movies' || type === 'tv' || type === 'trailers') {
            const mediaType = type === 'tv' ? 'tv' : 'movie';
            const id = item.id; // TMDB ID

            if (id) {
                try {
                    console.log(`🎬 Fetching trailer for ${mediaType} ${id}...`);
                    const response = await apiFetch(`${API_URL}/api/videos?category=${mediaType}&id=${id}`);
                    if (response.ok) {
                        const data = await response.json();
                        const videos = data.results || [];
                        // Find YouTube trailer
                        const trailer = videos.find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                            videos.find(v => v.site === 'YouTube'); // Fallback to any YouTube video

                        if (trailer) {
                            console.log(`✅ Found trailer: ${trailer.key}`);
                            this.openTrailerModal(trailer.key);
                            return;
                        }
                    }
                } catch (error) {
                    console.error('Error fetching trailer:', error);
                }
            }
        } else if (type === 'anime') {
            const node = item.node || item;
            // For anime, we might need to fetch more info if not present
            // But usually 'anime' type items in home row are from MAL which has trailer info
            if (node.trailer_key) {
                this.openTrailerModal(node.trailer_key);
                return;
            }
        }

        // Fallback: if we have a search URL, use it (better than nothing)
        // But user requested "direct", so maybe we should try to search YouTube via API?
        // For now, let's stick to the requested behavior: "not search the video name on youtoube"
        // If we really can't find a direct video, we might have to show an alert or do nothing.
        // However, the existing fallback was window.open.
        // Let's try one last ditch effort: search YouTube via our backend if possible?
        // No backend search endpoint for YouTube is visible.

        // If we have a search URL, we'll use it as a last resort but maybe in a new tab is what they wanted to avoid?
        // The user said "not direct make them direct".
        // If we absolutely fail to find a key, we can't play it "direct".

        if (item.trailer_search_url || (item.node && item.node.trailer_search_url)) {
            window.open(item.trailer_search_url || item.node.trailer_search_url, '_blank');
        } else {
            alert('No trailer available for this title.');
        }
    }

    createGridItem(item, options = {}) {
        const { onlyLibraryItems = false, showRank = false } = options;
        const div = document.createElement('div');
        div.className = 'grid-item';
        div.dataset.itemId = item.id;

        if (this.isDeleteMode) {
            div.classList.add('delete-mode');
            // In delete mode, clicking anywhere on the item toggles selection (no detail view)
            div.addEventListener('click', (e) => {
                // Don't toggle if clicking directly on checkbox or its overlay
                if (e.target.type === 'checkbox' ||
                    e.target.classList.contains('delete-checkbox') ||
                    e.target.closest('.delete-checkbox-overlay')) {
                    return;
                }
                e.stopPropagation();
                e.preventDefault();
                this.toggleItemSelection(item.id);
            });
        } else {
            // Add click handler - only allow if item is in library when onlyLibraryItems is true
            div.addEventListener('click', () => {
                if (onlyLibraryItems) {
                    // Check if item exists in library
                    const isInLibrary = this.isItemInLibrary(item);
                    if (!isInLibrary) {
                        // Item not in library, don't open detail view
                        return;
                    }
                    // Item is in library, find the actual library item and use that
                    const libraryItem = this.findLibraryItem(item);
                    if (libraryItem) {
                        this.openDetailView(libraryItem);
                    }
                } else {
                    this.openDetailView(item);
                }
            });

            // Add right-click handler for all item types to show context menu
            if (item.type === 'anime' || item.type === 'games' || item.type === 'movies' || item.type === 'tv') {
                div.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.showItemContextMenu(e, item);
                });
            }
        }

        // Gray out items not in library when in MAL results tab
        if (onlyLibraryItems) {
            const isInLibrary = this.isItemInLibrary(item);
            if (!isInLibrary) {
                div.classList.add('not-in-library');
                div.style.opacity = '0.5';
                div.style.filter = 'grayscale(100%)';
            }
        }

        const visualContainer = document.createElement('div');
        visualContainer.className = 'grid-item-visual';

        const img = document.createElement('img');
        img.loading = "lazy";
        img.decoding = "async";
        img.src = this.getProxiedImageUrl(item.posterPath) || this.getProxiedImageUrl(item.posterBase64) || 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjEwMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD4KPC9zdmc+';
        img.alt = item.name;

        // Checkbox overlay (shown only in delete mode)
        const checkboxOverlay = document.createElement('div');
        checkboxOverlay.className = 'delete-checkbox-overlay';
        if (!this.isDeleteMode) {
            checkboxOverlay.style.display = 'none';
        }
        // Prevent all clicks on checkbox overlay from bubbling up
        checkboxOverlay.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
        });
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'delete-checkbox';
        checkbox.checked = this.selectedItems.has(item.id);
        checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
            // Prevent the click from bubbling to parent div
        });
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            // The checkbox state is already updated, just sync our selection
            if (checkbox.checked) {
                this.selectedItems.add(item.id);
                div.classList.add('selected');
            } else {
                this.selectedItems.delete(item.id);
                div.classList.remove('selected');
            }
        });
        checkboxOverlay.appendChild(checkbox);

        const overlay = document.createElement('div');
        overlay.className = 'grid-item-overlay';
        const name = document.createElement('div');
        name.className = 'grid-item-name';
        name.textContent = item.name;
        overlay.appendChild(name);

        visualContainer.appendChild(img);
        visualContainer.appendChild(overlay);
        div.appendChild(visualContainer);
        div.appendChild(checkboxOverlay);

        if (item.type === 'actors') {
            const roles = this.getActorRoles(item);
            if (roles.length) {
                const rolesDiv = document.createElement('div');
                rolesDiv.className = 'grid-item-actor-roles';
                rolesDiv.textContent = roles.slice(0, 2).join(' • ');
                div.appendChild(rolesDiv);
            }
        }

        if (showRank && item.type !== 'actors') {
            div.classList.add('grid-item-with-rank');
            const rankWrapper = document.createElement('div');
            rankWrapper.className = 'grid-item-rank';

            const userScoreValue = Number.isFinite(item.userScore)
                ? `${Math.round(item.userScore)}%`
                : '—';
            const userScoreLabel = document.createElement('span');
            userScoreLabel.className = 'grid-item-user-score';
            userScoreLabel.textContent = userScoreValue;

            const starsWrapper = document.createElement('div');
            starsWrapper.className = 'grid-item-rank-stars';

            const normalizedRank = Math.max(0, Math.min(5, Math.round((parseFloat(item.myRank) || 0) * 2) / 2));

            for (let starValue = 1; starValue <= 5; starValue += 1) {
                const star = document.createElement('span');
                star.className = 'grid-item-rank-star';
                star.textContent = '★';

                if (normalizedRank >= starValue) {
                    star.classList.add('filled');
                } else if (normalizedRank >= starValue - 0.5) {
                    star.classList.add('half');
                }

                starsWrapper.appendChild(star);
            }

            rankWrapper.appendChild(userScoreLabel);
            rankWrapper.appendChild(starsWrapper);
            div.appendChild(rankWrapper);
        }

        return div;
    }

    createCollectionLibraryItem(collection) {
        const div = document.createElement('div');
        div.className = 'grid-item collection-item';
        div.dataset.collectionId = collection.id;

        // Check for custom collection poster first, then fall back to first item
        const visualContainer = document.createElement('div');
        visualContainer.className = 'grid-item-visual';

        const img = document.createElement('img');
        img.loading = "lazy";
        img.decoding = "async";
        // Use posterPath if available, fallback to posterBase64 for migration
        // Proxy GitHub URLs for both sources
        let posterSrc = '';
        if (collection.posterPath) {
            posterSrc = this.getProxiedImageUrl(collection.posterPath.startsWith('http') ? collection.posterPath : `${API_URL}/${collection.posterPath}`);
        } else if (collection.posterBase64) {
            posterSrc = this.getProxiedImageUrl(collection.posterBase64);
        }
        if (posterSrc) {
            img.src = posterSrc;
        } else {
            // Get the first item from the collection to use as poster
            const firstItemId = collection.itemIds && collection.itemIds.length > 0 ? collection.itemIds[0] : null;
            const firstItem = firstItemId ? this.data.items.find(item => item.id === firstItemId) : null;

            if (firstItem && firstItem.posterBase64) {
                img.src = this.getProxiedImageUrl(firstItem.posterBase64);
            } else if (firstItem) {
                img.src = this.getProxiedImageUrl(firstItem.posterPath) || this.getProxiedImageUrl(firstItem.posterBase64) || `${API_URL}/assets/img/${firstItem.id}_poster.webp`;
            } else {
                img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjEwMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD4KPC9zdmc+';
            }
        }
        img.alt = collection.name;
        visualContainer.appendChild(img);

        // Checkbox overlay (shown only in delete mode)
        const checkboxOverlay = document.createElement('div');
        checkboxOverlay.className = 'delete-checkbox-overlay';
        if (!this.isDeleteMode) {
            checkboxOverlay.style.display = 'none';
        }
        checkboxOverlay.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
        });
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'delete-checkbox';
        checkbox.checked = this.selectedItems.has(collection.id);
        checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            if (checkbox.checked) {
                this.selectedItems.add(collection.id);
                div.classList.add('selected');
            } else {
                this.selectedItems.delete(collection.id);
                div.classList.remove('selected');
            }
        });
        checkboxOverlay.appendChild(checkbox);

        const overlay = document.createElement('div');
        overlay.className = 'grid-item-overlay';
        const name = document.createElement('div');
        name.className = 'grid-item-name';
        name.textContent = collection.name;
        const count = document.createElement('div');
        count.className = 'grid-item-collection-count';
        // Count actual items that exist in the collection
        const actualItems = collection.itemIds ? collection.itemIds
            .map(id => this.data.items.find(item => item.id === id))
            .filter(item => item !== undefined) : [];
        const itemCount = actualItems.length;
        count.textContent = `${itemCount} item${itemCount !== 1 ? 's' : ''}`;
        overlay.appendChild(name);
        overlay.appendChild(count);

        visualContainer.appendChild(overlay);
        div.appendChild(visualContainer);
        div.appendChild(checkboxOverlay);

        // Click handler to show collection view
        if (!this.isDeleteMode) {
            div.addEventListener('click', () => {
                this.showCollectionView([collection], null);
            });
        } else {
            div.addEventListener('click', (e) => {
                if (e.target.type === 'checkbox' ||
                    e.target.classList.contains('delete-checkbox') ||
                    e.target.closest('.delete-checkbox-overlay')) {
                    return;
                }
                e.stopPropagation();
                e.preventDefault();
                this.toggleItemSelection(collection.id);
            });
        }

        return div;
    }

    async renderDetailView(item) {
        const bannerImageEl = document.getElementById('bannerImage');
        if (bannerImageEl) {
            const bannerSrc = this.getDetailBannerSource(item);
            const bannerItemId = item?.id || `${item?.type || ''}_${item?.externalApiId || ''}`;
            bannerImageEl.dataset.bannerItemId = bannerItemId;
            if (bannerSrc) {
                if (bannerImageEl.src !== bannerSrc) {
                    bannerImageEl.src = bannerSrc;
                } else if (!bannerImageEl.complete) {
                    // Ensure load event will still fire if the same src is being reused
                    bannerImageEl.removeAttribute('src');
                    bannerImageEl.src = bannerSrc;
                }
            } else {
                bannerImageEl.removeAttribute('src');
            }
        }

        const posterEl = document.getElementById('detailPoster');
        if (posterEl) {
            if (item.posterPath) {
                posterEl.src = this.getProxiedImageUrl(item.posterPath);
            } else if (item.posterBase64) {
                // Proxy GitHub URLs even if in posterBase64
                posterEl.src = this.getProxiedImageUrl(item.posterBase64);
            } else if (item.id) {
                posterEl.src = `${API_URL}/assets/img/${item.id}_poster.webp`;
            } else {
                // Fallback placeholder for items without ID or poster
                posterEl.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450"%3E%3Crect width="300" height="450" fill="%23333"/%3E%3Ctext x="50%25" y="50%25" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="20" fill="%23999"%3ENo Poster%3C/text%3E%3C/svg%3E';
            }
        }

        const detailTitleEl = document.getElementById('detailTitle');
        if (detailTitleEl) {
            detailTitleEl.textContent = item.title || item.name || "Untitled";
        }

        // Check if this is an actor
        const isActor = item.type === 'actors';
        const linkedMoviesContainer = document.getElementById('actorLinkedMoviesContainer');
        const detailContentContainer = document.getElementById('detailContentContainer');
        const detailExtraMetaContainer = document.getElementById('detailExtraMeta');

        // Apply actor layout class
        if (isActor && detailContentContainer) {
            detailContentContainer.classList.add('actor-layout');
            // Mark spotify-sourced artists to allow CSS tweaks (prevent layout shifting)
            const isSpotifyArtistQuick = (item.source === 'spotify') ||
                (item.externalApiId && !/^[0-9]+$/.test(String(item.externalApiId))) ||
                (item.spotifyUrl && item.spotifyUrl.includes('spotify')) ||
                (item.socialMedia && item.socialMedia.includes('spotify'));
            if (isSpotifyArtistQuick) {
                detailContentContainer.classList.add('spotify-artist');
            } else {
                detailContentContainer.classList.remove('spotify-artist');
            }
        } else if (detailContentContainer) {
            detailContentContainer.classList.remove('actor-layout');
        }

        if (isActor) {
            // Actor-specific detail view
            // Hide regular meta, show actor-specific info
            document.getElementById('detailMeta').textContent = '';
            document.getElementById('detailTitle').style.display = 'none';
            document.getElementById('actorInfo').style.display = 'block';
            if (detailExtraMetaContainer) {
                detailExtraMetaContainer.style.display = 'none';
                detailExtraMetaContainer.innerHTML = '';
            }
            const creatorInfoEl = document.getElementById('detailCreatorInfo');
            const creatorLabelEl = document.getElementById('creatorLabel');
            const creatorValueEl = document.getElementById('creatorValue');
            if (creatorInfoEl) creatorInfoEl.style.display = 'none';
            if (creatorLabelEl) creatorLabelEl.textContent = '';
            if (creatorValueEl) creatorValueEl.textContent = '';
            const animeRelationsContainer = document.getElementById('animeRelationsContainer');
            if (animeRelationsContainer) {
                animeRelationsContainer.style.display = 'none';
                const sequelGrid = document.getElementById('animeSequelGrid');
                const prequelGrid = document.getElementById('animePrequelGrid');
                if (sequelGrid) sequelGrid.innerHTML = '';
                if (prequelGrid) prequelGrid.innerHTML = '';
            }
            const gameRelationsContainer = document.getElementById('gameRelationsContainer');
            if (gameRelationsContainer) {
                gameRelationsContainer.style.display = 'none';
                const dlcGrid = document.getElementById('gameDlcGrid');
                const similarGrid = document.getElementById('gameSimilarGrid');
                if (dlcGrid) dlcGrid.innerHTML = '';
                if (similarGrid) similarGrid.innerHTML = '';
            }
            this.hideCastSection();
            this.updateSidebarVisibility();

            // Set actor title in the right panel
            document.getElementById('actorTitle').textContent = item.title || item.name || "Untitled";

            const actorRolesEl = document.getElementById('actorRoles');
            if (actorRolesEl) {
                const roles = this.getActorRoles(item);
                if (roles.length) {
                    actorRolesEl.innerHTML = roles
                        .map(role => `<span class="actor-role-chip">${this.escapeHtml(role)}</span>`)
                        .join('');
                    actorRolesEl.style.display = 'flex';
                } else {
                    actorRolesEl.innerHTML = '';
                    actorRolesEl.style.display = 'none';
                }
            }

            // Social Media Icons
            const socialMediaEl = document.getElementById('actorSocialMedia');
            socialMediaEl.innerHTML = '';
            // For Spotify-sourced artists, prefer showing only the Spotify profile link
            const isSpotifyArtist = (item.source === 'spotify') ||
                (item.externalApiId && !/^[0-9]+$/.test(String(item.externalApiId))) ||
                (item.spotifyUrl && item.spotifyUrl.includes('spotify')) ||
                (item.socialMedia && item.socialMedia.includes('spotify'));

            let spotifyProfile = '';
            if (isSpotifyArtist) {
                if (item.spotifyUrl && item.spotifyUrl.includes('spotify')) {
                    spotifyProfile = item.spotifyUrl;
                } else if (item.externalApiId && !/^[0-9]+$/.test(String(item.externalApiId))) {
                    // treat externalApiId as spotify artist id
                    spotifyProfile = `https://open.spotify.com/artist/${encodeURIComponent(String(item.externalApiId))}`;
                } else if (item.socialMedia && item.socialMedia.includes('spotify')) {
                    // try to extract a spotify url or spotify:artist:uri from the stored social field
                    const sm = item.socialMedia;
                    const m = sm.match(/(https?:\/\/open\.spotify\.com\/artist\/[A-Za-z0-9_-]+)/) || sm.match(/(spotify:artist:[A-Za-z0-9_-]+)/);
                    if (m && m[1]) {
                        spotifyProfile = m[1];
                        if (spotifyProfile.startsWith('spotify:artist:')) {
                            const id = spotifyProfile.split(':').pop();
                            spotifyProfile = `https://open.spotify.com/artist/${id}`;
                        }
                    }
                }

                if (spotifyProfile) {
                    this.renderSocialMediaIcons(spotifyProfile, socialMediaEl);

                    // Also attempt to fetch TMDB external_ids for this artist by name
                    // and render those links alongside the Spotify profile (IMDb, Twitter, Instagram, Facebook)
                    if (item.name || item.title) {
                        try {
                            const nameToSearch = encodeURIComponent(item.name || item.title);
                            const searchResp = await apiFetch(`${API_URL}/api/search?query=${nameToSearch}&category=actors&service=tmdb`);
                            if (searchResp.ok) {
                                const searchData = await searchResp.json();
                                const first = (searchData.results && searchData.results.length) ? searchData.results[0] : null;
                                if (first && first.id) {
                                    const personResp = await apiFetch(`${API_URL}/api/person/${first.id}`);
                                    if (personResp.ok) {
                                        const personData = await personResp.json();
                                        if (personData && personData.external_ids) {
                                            const tmdbLinks = [];
                                            const ext = personData.external_ids;
                                            if (ext.imdb_id) tmdbLinks.push(`https://www.imdb.com/name/${ext.imdb_id}`);
                                            if (ext.twitter_id) tmdbLinks.push(`https://twitter.com/${ext.twitter_id}`);
                                            if (ext.instagram_id) tmdbLinks.push(`https://www.instagram.com/${ext.instagram_id}`);
                                            if (ext.facebook_id) tmdbLinks.push(`https://www.facebook.com/${ext.facebook_id}`);

                                            // If we have any TMDB links, render them (they'll appear after the Spotify icon)
                                            if (tmdbLinks.length) {
                                                // Deduplicate against any existing socialMedia entries
                                                const uniqueLinks = Array.from(new Set(tmdbLinks));
                                                this.renderSocialMediaIcons(uniqueLinks.join(', '), socialMediaEl);
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (err) {
                            console.warn('TMDB external_ids lookup failed:', err && err.message ? err.message : err);
                        }
                    }
                }
            } else {
                if (item.socialMedia) this.renderSocialMediaIcons(item.socialMedia, socialMediaEl);
            }

            // Spotify Player Injection
            const spotifyPlayerSection = document.getElementById('spotifyPlayerSection');
            const spotifyPlayerContainer = document.getElementById('spotifyPlayerContainer');

            if (spotifyPlayerSection && spotifyPlayerContainer) {
                let spotifyId = null;

                if (isSpotifyArtist) {
                    // 1. Check externalApiId (if non-numeric)
                    if (item.externalApiId && !/^[0-9]+$/.test(String(item.externalApiId))) {
                        spotifyId = item.externalApiId;
                    }
                    // 2. Check item.spotifyUrl
                    else if (item.spotifyUrl) {
                        const m = item.spotifyUrl.match(/(?:artist\/|artist:)([A-Za-z0-9]+)/);
                        if (m) spotifyId = m[1];
                    }
                    // 3. Check extracted spotifyProfile (which might come from socialMedia)
                    else if (spotifyProfile) {
                        const m = spotifyProfile.match(/(?:artist\/|artist:)([A-Za-z0-9]+)/);
                        if (m) spotifyId = m[1];
                    }
                }

                if (spotifyId) {
                    spotifyPlayerContainer.innerHTML = `<iframe style="border-radius:12px" src="https://open.spotify.com/embed/artist/${spotifyId}?utm_source=generator&theme=0" width="100%" height="352" frameBorder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`;
                    spotifyPlayerSection.style.display = 'block';
                } else {
                    spotifyPlayerSection.style.display = 'none';
                    spotifyPlayerContainer.innerHTML = '';
                }
            }

            document.getElementById('detailDescription').textContent = item.description || 'No description available.';

            // Show and populate linked movies
            if (linkedMoviesContainer) {
                const grid = document.getElementById('linkedMoviesGrid');
                const knownForHeading = document.getElementById('knownForHeading');
                if (grid) {
                    // Clear previous content immediately to avoid flash of prior actor's Known For
                    grid.innerHTML = '<div class="linked-loading">Loading…</div>';
                }
                linkedMoviesContainer.style.display = 'block';

                // Hide "Known For" section for Spotify artists (singers)
                if (isSpotifyArtist) {
                    if (grid) grid.style.display = 'none';
                    if (knownForHeading) knownForHeading.style.display = 'none';
                } else {
                    if (grid) grid.style.display = '';
                    if (knownForHeading) knownForHeading.style.display = '';
                    // For all actors (library or transient), fetch and merge credits
                    this.loadAndRenderActorLinkedMovies(item);
                }
                // Load YouTube interviews for this person
                const interviewsSection = document.getElementById('actorInterviewsSection');
                if (interviewsSection) {
                    if (isSpotifyArtist) {
                        interviewsSection.classList.remove('regular-actor-interviews');
                    } else {
                        interviewsSection.classList.add('regular-actor-interviews');
                    }
                }
                this.loadAndRenderActorInterviews(item);
            }

            // Show and populate biography
            const biographyWrapper = document.getElementById('actorBiographyWrapper');
            const biographyEl = document.getElementById('actorBiography');
            const readMoreBtn = document.getElementById('readMoreBtn');
            if (biographyEl && biographyWrapper) {
                let biographyText = (item.biography && item.biography.trim())
                    ? item.biography.trim()
                    : (item.description && item.description.trim())
                        ? item.description.trim()
                        : '';

                // If this is a Spotify artist, always attempt to fetch the TMDB biography first
                // (use TMDB over Spotify-provided biography). If TMDB yields nothing, fall back
                // to the item's existing biography/description.
                if (isSpotifyArtist && (item.name || item.title)) {
                    try {
                        const searchResp = await apiFetch(`${API_URL}/api/search?query=${encodeURIComponent(item.name || item.title)}&category=actors&service=tmdb`);
                        if (searchResp.ok) {
                            const searchData = await searchResp.json();
                            const first = (searchData.results && searchData.results.length) ? searchData.results[0] : null;
                            if (first && first.id) {
                                const personResp = await apiFetch(`${API_URL}/api/person/${first.id}`);
                                if (personResp.ok) {
                                    const personData = await personResp.json();
                                    if (personData && personData.biography && personData.biography.trim()) {
                                        biographyText = personData.biography.trim();
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        console.warn('TMDB biography lookup failed:', err && err.message ? err.message : err);
                    }
                }

                // If TMDB returned nothing, keep whatever we had from the item (Spotify)

                if (biographyText) {
                    // Keep the full biography but display only up to configured max on demand
                    const fullBiography = biographyText;
                    const defaultMax = 1580;
                    const bioMax = (this.data && this.data.settings && Number.isFinite(Number(this.data.settings.bioMaxChars))) ? Number(this.data.settings.bioMaxChars) : defaultMax;

                    // Store full biography in DOM so read-more can toggle it
                    biographyEl.dataset.fullBiography = fullBiography;
                    biographyWrapper.style.display = 'block';

                    if (fullBiography.length > bioMax) {
                        biographyEl.textContent = fullBiography.substring(0, bioMax);
                        biographyEl.classList.add('collapsed');
                        readMoreBtn.style.display = 'block';
                        readMoreBtn.textContent = 'Read More';
                    } else {
                        biographyEl.textContent = fullBiography;
                        biographyEl.classList.remove('collapsed');
                        readMoreBtn.style.display = 'none';
                    }
                } else {
                    biographyWrapper.style.display = 'none';
                    biographyEl.textContent = '';
                    if (readMoreBtn) readMoreBtn.style.display = 'none';
                }
            }
        } else {
            // Hide actor info for non-actors
            document.getElementById('actorInfo').style.display = 'none';
            const actorRolesEl = document.getElementById('actorRoles');
            if (actorRolesEl) {
                actorRolesEl.innerHTML = '';
                actorRolesEl.style.display = 'none';
            }
            document.getElementById('detailTitle').style.display = 'block';
            // Regular item detail view
            const meta = [];
            if (item.year) meta.push(item.year);
            if (item.genre) meta.push(item.genre);
            document.getElementById('detailMeta').textContent = meta.join(' • ');

            // Limit description to 466 characters (for everything except actors)
            const fullDescription = item.description || 'No description available.';
            let displayDescription = fullDescription;
            if (item.type !== 'actors' && fullDescription.length > 466) {
                displayDescription = fullDescription.substring(0, 466);
            }
            document.getElementById('detailDescription').textContent = displayDescription;

            // Debug logging
            console.log('Detail view - Item:', item.name, 'Type:', item.type);
            console.log('Detail view - Studio:', item.studio, 'Developer:', item.developer, 'DirectorCreator:', item.directorCreator);

            await this.populateDetailExtraMeta(item);

            // Render score circle if score exists (never for actors, checked earlier)
            // For movies/TV transient items (on demand detail view), always fetch fresh score from TMDB
            // This ensures we have the correct score even if it wasn't fetched during buildTransientItemFromExternal
            if ((item.type === 'movies' || item.type === 'tv') && item.externalApiId) {
                // Check if this is a transient item (not in library) by checking if it has a rec_ prefix
                const isTransientItem = item.id && item.id.startsWith('rec_');
                // Also fetch if score is missing or seems incorrect (very low for popular content)
                const needsScoreFetch = !item.userScore || item.userScore === 0 || (item.userScore < 20 && isTransientItem);

                if (isTransientItem || needsScoreFetch) {
                    try {
                        const mediaType = item.type === 'movies' ? 'movies' : 'tv';
                        const tmdbResponse = await apiFetch(`${API_URL}/api/tmdb-details?category=${mediaType}&id=${item.externalApiId}`);
                        if (tmdbResponse.ok) {
                            const tmdbData = await tmdbResponse.json();
                            if (Number.isFinite(tmdbData.vote_average) && tmdbData.vote_average > 0) {
                                // TMDB returns vote_average on 0-10 scale, convert to 0-100
                                const calculatedScore = Math.round(tmdbData.vote_average * 10);
                                // Update item's score if it was missing or seems incorrect
                                if (!item.userScore || item.userScore === 0 || (isTransientItem && Math.abs(item.userScore - calculatedScore) > 5)) {
                                    item.userScore = calculatedScore;
                                }
                            }
                        }
                    } catch (err) {
                        console.warn('Failed to fetch vote_average from TMDB in renderDetailView:', err);
                    }
                }
            }

            if (item.userScore && item.userScore > 0) {
                this.renderScoreCircle(item.userScore, item.type, item.externalApiId || item.id);
            } else {
                document.getElementById('detailScoreCircle').style.display = 'none';
            }

            // IMDb rating is now stored in userScore when item is added, no need to fetch separately

            // Hide linked movies for non-actors
            if (linkedMoviesContainer) {
                linkedMoviesContainer.style.display = 'none';
            }

            // Handle anime relations (sequel/prequel) for anime items
            const animeRelationsContainer = document.getElementById('animeRelationsContainer');
            const castContainer = document.getElementById('castCharactersContainer');
            const shouldShowCast = item.type === 'movies' || item.type === 'tv';
            if (!shouldShowCast) {
                this.hideCastSection();
            } else if (castContainer) {
                castContainer.style.display = 'none';
                const castGrid = document.getElementById('castCharactersGrid');
                if (castGrid) castGrid.innerHTML = '';
            }

            if (item.type === 'anime' && animeRelationsContainer) {
                const malId = this.getAnimeMalId(item);
                const sequelGrid = document.getElementById('animeSequelGrid');
                const prequelGrid = document.getElementById('animePrequelGrid');
                const sequelContainer = document.querySelector('.anime-sequel-container');
                const prequelContainer = document.querySelector('.anime-prequel-container');

                // Parse relations from MAL/Jikan API format
                // Relations structure: [{ relation: "Sequel", entry: [...] }, { relation: "Prequel", entry: [...] }]
                let sequelData = [];
                let prequelData = [];

                // Try to parse relations if it's a string (JSON stored in database)
                let relations = item.relations;
                if (typeof relations === 'string') {
                    try {
                        relations = JSON.parse(relations);
                    } catch (e) {
                        console.warn('Failed to parse relations JSON:', e);
                    }
                }

                // If relations don't exist but we have MAL ID, fetch from Jikan API
                if (!relations && malId) {
                    try {
                        const response = await fetch(`https://api.jikan.moe/v4/anime/${malId}/full`);
                        if (response.ok) {
                            const data = await response.json();
                            if (data.data && data.data.relations) {
                                relations = data.data.relations;
                                console.log('Fetched relations from Jikan API:', relations);
                            }
                        }
                    } catch (e) {
                        console.warn('Failed to fetch relations from Jikan API:', e);
                    }
                }

                // Debug: log the item to see its structure
                console.log('Anime item:', item);
                console.log('Relations (parsed):', relations);

                if (relations && Array.isArray(relations)) {
                    relations.forEach(rel => {
                        console.log('Relation object:', rel);
                        if (rel.relation && rel.entry && Array.isArray(rel.entry)) {
                            const relationType = rel.relation.toLowerCase();
                            console.log('Relation type:', relationType);
                            // Match "Sequel", "Sequel (TV)", "Sequel (Movie)", etc.
                            if (relationType.includes('sequel')) {
                                // Flatten nested arrays and add entries
                                rel.entry.forEach(entry => {
                                    if (entry && typeof entry === 'object') {
                                        sequelData.push(entry);
                                    }
                                });
                                console.log('Found sequel data:', sequelData);
                            } else if (relationType.includes('prequel')) {
                                // Flatten nested arrays and add entries
                                rel.entry.forEach(entry => {
                                    if (entry && typeof entry === 'object') {
                                        prequelData.push(entry);
                                    }
                                });
                                console.log('Found prequel data:', prequelData);
                            }
                        }
                    });
                } else if (relations && typeof relations === 'object') {
                    // Try alternative structure: { Sequel: [...], Prequel: [...] }
                    if (relations.Sequel) {
                        sequelData = Array.isArray(relations.Sequel) ? relations.Sequel : [];
                    }
                    if (relations.Prequel) {
                        prequelData = Array.isArray(relations.Prequel) ? relations.Prequel : [];
                    }
                    console.log('Using alternative relations structure');
                }

                console.log('Final sequelData:', sequelData);
                console.log('Final prequelData:', prequelData);

                // Fallback: check for direct sequel/prequel properties
                if (sequelData.length === 0) {
                    sequelData = item.sequel || item.sequels || item.sequelAnime || [];
                }
                if (prequelData.length === 0) {
                    prequelData = item.prequel || item.prequels || item.prequelAnime || [];
                }

                const hasSequel = Array.isArray(sequelData) && sequelData.length > 0;
                const hasPrequel = Array.isArray(prequelData) && prequelData.length > 0;

                if (hasSequel || hasPrequel) {
                    animeRelationsContainer.style.display = 'flex';

                    // Render sequel
                    if (hasSequel && sequelGrid) {
                        sequelGrid.innerHTML = '';
                        for (const anime of sequelData) {
                            console.log('Rendering sequel anime:', anime);
                            const img = document.createElement('img');
                            // Handle MAL API entry format (has mal_id and images)
                            const animeMalId = anime.mal_id || anime.id;
                            const animeTitle = anime.title || anime.name || 'Untitled';

                            // Get image URL - prioritize database, then Jikan API images
                            let posterSrc = '';
                            let dbAnime = null;

                            // First: Check if we have this anime in our database by MAL ID
                            if (animeMalId) {
                                dbAnime = this.data.items.find(i =>
                                    (i.externalApiId && String(i.externalApiId) === String(animeMalId)) ||
                                    (i.type === 'anime' && i.name === animeTitle)
                                );
                                console.log('Found in DB:', dbAnime ? 'Yes' : 'No', 'MAL ID:', animeMalId);

                                if (dbAnime) {
                                    // Use database poster
                                    if (dbAnime.posterPath) {
                                        posterSrc = this.getProxiedImageUrl(dbAnime.posterPath);
                                    } else if (dbAnime.posterBase64) {
                                        posterSrc = dbAnime.posterBase64;
                                    } else if (dbAnime.id) {
                                        posterSrc = `${API_URL}/assets/img/${dbAnime.id}_poster.webp`;
                                    }
                                }
                            }

                            // Second: Try Jikan API image URLs if not found in DB
                            if (!posterSrc && anime.images) {
                                if (anime.images.jpg && anime.images.jpg.large_image_url) {
                                    posterSrc = anime.images.jpg.large_image_url;
                                    console.log('Using Jikan large_image_url');
                                } else if (anime.images.jpg && anime.images.jpg.image_url) {
                                    posterSrc = anime.images.jpg.image_url;
                                    console.log('Using Jikan image_url');
                                }
                            }

                            // Third: Try direct posterBase64 from relation entry
                            if (!posterSrc && anime.posterBase64) {
                                posterSrc = anime.posterBase64;
                                console.log('Using relation entry posterBase64');
                            }

                            // If we still don't have a poster, try fetching the anime details from Jikan
                            if (!posterSrc && animeMalId) {
                                try {
                                    const transient = await this.buildTransientItemFromExternal('anime', animeMalId);
                                    if (transient && transient.posterBase64) {
                                        posterSrc = transient.posterBase64;
                                        console.log('Fetched poster from Jikan for sequel id', animeMalId);
                                    }
                                } catch (e) {
                                    console.warn('Failed to fetch Jikan poster for sequel id', animeMalId, e);
                                }
                            }

                            // Fallback placeholder if nothing found
                            if (!posterSrc) {
                                posterSrc = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjEwMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD4KPC9zdmc+';
                                console.log('Using placeholder - no image found');
                            }

                            console.log('Final poster source for sequel:', posterSrc);
                            img.src = posterSrc;
                            img.alt = animeTitle;
                            img.style.cursor = 'pointer';
                            img.style.width = '100%';
                            img.style.aspectRatio = '2/3';
                            img.style.objectFit = 'cover';
                            img.style.borderRadius = '4px';
                            img.onerror = function () {
                                console.error('Failed to load image:', posterSrc);
                                this.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjEwMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD4KPC9zdmc+';
                            };
                            img.addEventListener('click', () => {
                                // Create a proper anime item object for showDetailView
                                // If we found it in DB, use that, otherwise use the relation entry
                                const animeItem = dbAnime || {
                                    ...anime,
                                    id: dbAnime ? dbAnime.id : (anime.id || animeMalId),
                                    type: 'anime',
                                    title: animeTitle,
                                    name: animeTitle,
                                    posterBase64: posterSrc,
                                    externalApiId: animeMalId
                                };
                                this.openDetailView(animeItem, { source: 'relation' });
                            });
                            sequelGrid.appendChild(img);
                        }
                        if (sequelContainer) sequelContainer.style.display = 'block';
                    } else if (sequelContainer) {
                        sequelContainer.style.display = 'none';
                    }

                    // Render prequel
                    if (hasPrequel && prequelGrid) {
                        prequelGrid.innerHTML = '';
                        for (const anime of prequelData) {
                            console.log('Rendering prequel anime:', anime);
                            const img = document.createElement('img');
                            // Handle MAL API entry format (has mal_id and images)
                            const animeMalId = anime.mal_id || anime.id;
                            const animeTitle = anime.title || anime.name || 'Untitled';

                            // Get image URL - prioritize database, then Jikan API images
                            let posterSrc = '';
                            let dbAnime = null;

                            // First: Check if we have this anime in our database by MAL ID
                            if (animeMalId) {
                                dbAnime = this.data.items.find(i =>
                                    (i.externalApiId && String(i.externalApiId) === String(animeMalId)) ||
                                    (i.type === 'anime' && i.name === animeTitle)
                                );
                                console.log('Found in DB:', dbAnime ? 'Yes' : 'No', 'MAL ID:', animeMalId);

                                if (dbAnime) {
                                    // Use database poster
                                    if (dbAnime.posterPath) {
                                        posterSrc = this.getProxiedImageUrl(dbAnime.posterPath);
                                    } else if (dbAnime.posterBase64) {
                                        posterSrc = dbAnime.posterBase64;
                                    } else if (dbAnime.id) {
                                        posterSrc = `${API_URL}/assets/img/${dbAnime.id}_poster.webp`;
                                    }
                                }
                            }

                            // Second: Try Jikan API image URLs if not found in DB
                            if (!posterSrc && anime.images) {
                                if (anime.images.jpg && anime.images.jpg.large_image_url) {
                                    posterSrc = anime.images.jpg.large_image_url;
                                    console.log('Using Jikan large_image_url');
                                } else if (anime.images.jpg && anime.images.jpg.image_url) {
                                    posterSrc = anime.images.jpg.image_url;
                                    console.log('Using Jikan image_url');
                                }
                            }

                            // Third: Try direct posterBase64 from relation entry
                            if (!posterSrc && anime.posterBase64) {
                                posterSrc = anime.posterBase64;
                                console.log('Using relation entry posterBase64');
                            }

                            // If we still don't have a poster, try fetching the anime details from Jikan
                            if (!posterSrc && animeMalId) {
                                try {
                                    const transient = await this.buildTransientItemFromExternal('anime', animeMalId);
                                    if (transient && transient.posterBase64) {
                                        posterSrc = transient.posterBase64;
                                        console.log('Fetched poster from Jikan for prequel id', animeMalId);
                                    }
                                } catch (e) {
                                    console.warn('Failed to fetch Jikan poster for prequel id', animeMalId, e);
                                }
                            }

                            // Fallback placeholder if nothing found
                            if (!posterSrc) {
                                posterSrc = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjEwMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD4KPC9zdmc+';
                                console.log('Using placeholder - no image found');
                            }

                            console.log('Final poster source for prequel:', posterSrc);
                            img.src = posterSrc;
                            img.alt = animeTitle;
                            img.style.cursor = 'pointer';
                            img.style.width = '100%';
                            img.style.aspectRatio = '2/3';
                            img.style.objectFit = 'cover';
                            img.style.borderRadius = '4px';
                            img.onerror = function () {
                                console.error('Failed to load image:', posterSrc);
                                this.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjEwMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD4KPC9zdmc+';
                            };
                            img.addEventListener('click', () => {
                                // Create a proper anime item object for showDetailView
                                // If we found it in DB, use that, otherwise use the relation entry
                                const animeItem = dbAnime || {
                                    ...anime,
                                    id: dbAnime ? dbAnime.id : (anime.id || animeMalId),
                                    type: 'anime',
                                    title: animeTitle,
                                    name: animeTitle,
                                    posterBase64: posterSrc,
                                    externalApiId: animeMalId
                                };
                                this.openDetailView(animeItem, { source: 'relation' });
                            });
                            prequelGrid.appendChild(img);
                        }
                        if (prequelContainer) prequelContainer.style.display = 'block';
                    } else if (prequelContainer) {
                        prequelContainer.style.display = 'none';
                    }
                    this.updateSidebarVisibility();
                } else {
                    animeRelationsContainer.style.display = 'none';
                    this.updateSidebarVisibility();
                }
            } else {
                // Hide anime relations for non-anime items
                if (animeRelationsContainer) {
                    animeRelationsContainer.style.display = 'none';
                    this.updateSidebarVisibility();
                }
            }
        }

        // Always hide score circle for actors
        if (isActor) {
            document.getElementById('detailScoreCircle').style.display = 'none';
        }

        const animeMalIdForDetail = item.type === 'anime' ? this.getAnimeMalId(item) : null;

        // Check if item is in library - only library items can have poster/banner changed and be ranked
        const isInLibrary = this.isItemInLibrary(item);

        // Show/hide detail settings button - only for library items with external ID
        const hasExternalId = ((item.type === 'anime' ? animeMalIdForDetail : item.externalApiId)
            && (item.type === 'movies' || item.type === 'tv' || item.type === 'anime' || item.type === 'games' || item.type === 'actors'));
        // Only show settings button if item is in library AND has external ID
        document.getElementById('detailSettingsBtn').style.display = (hasExternalId && isInLibrary) ? 'flex' : 'none';

        // Update button labels and visibility based on item type
        const changePosterBtn = document.getElementById('changePosterBtn');
        const changeBannerBtn = document.getElementById('changeBannerBtn');
        const changePosterFanartBtn = document.getElementById('changePosterFanartBtn');
        const changeBannerFanartBtn = document.getElementById('changeBannerFanartBtn');

        if (item.type === 'games') {
            changePosterBtn.textContent = 'Change Poster (SteamGridDB)';
            changeBannerBtn.textContent = 'Change Banner (SteamGridDB)';
            changePosterFanartBtn.style.display = 'none';
            changeBannerFanartBtn.style.display = 'none';
        } else if (item.type === 'movies' || item.type === 'tv') {
            changePosterBtn.textContent = 'Change Poster (TMDB)';
            changeBannerBtn.textContent = 'Change Banner (TMDB)';
            // Hide fanart.tv options in detail view (only available in collection view)
            changePosterFanartBtn.style.display = 'none';
            changeBannerFanartBtn.style.display = 'none';
        } else {
            changePosterBtn.textContent = 'Change Poster (TMDB)';
            changeBannerBtn.textContent = 'Change Banner (TMDB)';
            changePosterFanartBtn.style.display = 'none';
            changeBannerFanartBtn.style.display = 'none';
        }

        // Update star rating display and disable state based on library status
        const starRatingContainer = document.getElementById('starRating');
        const detailRating = document.querySelector('.detail-rating');
        if (starRatingContainer) {
            if (isInLibrary) {
                starRatingContainer.classList.remove('disabled');
                if (detailRating) detailRating.classList.remove('disabled');
            } else {
                starRatingContainer.classList.add('disabled');
                if (detailRating) detailRating.classList.add('disabled');
            }
        }

        this.setDetailStarRating(item.myRank || 0);


        // Load and render cast (only for movies/TV, not anime)
        if (item.externalApiId && !isActor && (item.type === 'movies' || item.type === 'tv')) {
            this.loadAndRenderCast(item);
        }

        // Load and render game relations (DLC and related games) for games
        if (!isActor && item.type === 'games') {
            if (item.externalApiId) {
                this.loadAndRenderGameRelations(item, item.externalApiId);
            } else {
                // Hide game relations if no externalApiId
                const gameRelationsContainer = document.getElementById('gameRelationsContainer');
                if (gameRelationsContainer) {
                    gameRelationsContainer.style.display = 'none';
                }
            }
        } else {
            // Hide game relations for non-game items
            const gameRelationsContainer = document.getElementById('gameRelationsContainer');
            if (gameRelationsContainer) {
                gameRelationsContainer.style.display = 'none';
            }
        }

        // Load new detail sections (only for non-actors)
        // For games, try to load even without externalApiId (will show what's available)
        const canLoadDetailSections = !isActor && (
            (item.type === 'anime' && animeMalIdForDetail) ||
            (item.type === 'games') || // Always try to load for games
            (item.type !== 'anime' && item.externalApiId)
        );
        if (canLoadDetailSections) {
            this.populateTrailerSection(item);
            this.populateRecommendationsSection(item);
            this.populateReviewsSection(item);
            this.populateInformationSidebar(item);
        } else {
            // Hide sections for actors or items without required IDs
            document.getElementById('detailTrailerSection').style.display = 'none';
            document.getElementById('detailRecommendationsSection').style.display = 'none';
            document.getElementById('detailReviewsSection').style.display = 'none';
            document.getElementById('detailInformationSidebar').style.display = 'none';
            this.updateSidebarVisibility();
        }

        // Show/Hide edit layout button (hide for actors)
        const editLayoutBtn = document.getElementById('editLayoutBtn');
        if (editLayoutBtn) {
            editLayoutBtn.style.display = isActor ? 'none' : 'flex';
        }

        // Show/Hide watchlist button (hide for actors AND library items)
        const watchlistBtn = document.getElementById('watchlistBtn');
        if (watchlistBtn) {
            // Hide watchlist button for actors and items already in library
            if (isActor || isInLibrary) {
                watchlistBtn.style.display = 'none';
            } else {
                watchlistBtn.style.display = 'flex';
                // Update button state based on whether item is in watchlist
                this.updateWatchlistButtonState(item);

                // Remove existing click listener and add new one
                const newWatchlistBtn = watchlistBtn.cloneNode(true);
                watchlistBtn.parentNode.replaceChild(newWatchlistBtn, watchlistBtn);

                newWatchlistBtn.addEventListener('click', () => {
                    this.toggleWatchlist(item);
                });
            }
        }


        // Load saved custom layout for this category
        if (!isActor) {
            this.loadSavedLayout(item.type);
        }
    }

    // ===== TRAILER SECTION =====
    async populateTrailerSection(item) {
        const section = document.getElementById('detailTrailerSection');
        const container = document.getElementById('trailerContainer');

        if (!section || !container) return;

        const requestToken = `${item.id || item.externalApiId || item.routeId || 'unknown'}_${Date.now()}`;
        this.currentTrailerRequestToken = requestToken;
        section.dataset.trailerRequestToken = requestToken;
        section.style.display = 'none';
        container.innerHTML = '';

        try {
            let trailerKey = null;
            let trailerHtml = '';

            // Fetch trailer based on type
            if (item.type === 'movies' || item.type === 'tv') {
                // TMDB API for movies/TV
                const mediaType = item.type === 'movies' ? 'movies' : 'tv';
                const response = await apiFetch(`${API_URL}/api/videos?category=${mediaType}&id=${item.externalApiId}`);
                if (response.ok) {
                    const data = await response.json();
                    const videos = data.results || [];
                    // Find YouTube trailer
                    const trailer = videos.find(v => v.type === 'Trailer' && v.site === 'YouTube') || videos[0];
                    if (trailer) trailerKey = trailer.key;
                }

                if (trailerKey) {
                    trailerHtml = `<iframe src="https://www.youtube.com/embed/${trailerKey}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
                }
            } else if (item.type === 'anime') {
                const malId = this.getAnimeMalId(item);
                if (!malId) {
                    console.warn('ℹ️ No MAL ID found for anime trailer lookup:', { itemId: item.id, itemName: item.name || item.title });
                } else {
                    // MAL/Jikan API for anime - try multiple sources
                    try {
                        console.log('🎬 Fetching anime trailer for MAL ID:', malId, 'Title:', item.title || item.name);

                        // First try: Get full anime data which includes trailer
                        const fullResponse = await fetch(`https://api.jikan.moe/v4/anime/${malId}/full`);
                        if (fullResponse.ok) {
                            const fullData = await fullResponse.json();
                            const trailerData = fullData.data?.trailer;
                            console.log('📺 Anime trailer data from full endpoint:', trailerData);

                            if (trailerData?.youtube_id) {
                                trailerKey = trailerData.youtube_id;
                                console.log('✅ Found trailer youtube_id:', trailerKey);
                            } else {
                                const embedId = this.extractYouTubeId(trailerData?.embed_url);
                                if (embedId) {
                                    trailerKey = embedId;
                                    console.log('✅ Extracted trailer from embed_url:', trailerKey);
                                } else {
                                    const urlId = this.extractYouTubeId(trailerData?.url);
                                    if (urlId) {
                                        trailerKey = urlId;
                                        console.log('✅ Extracted trailer from url:', trailerKey);
                                    }
                                }
                            }
                        }

                        // Second try: Use videos endpoint as fallback
                        if (!trailerKey) {
                            console.log('⚠️ No trailer from full endpoint, trying videos endpoint...');
                            const videoResponse = await fetch(`https://api.jikan.moe/v4/anime/${malId}/videos`);
                            if (videoResponse.ok) {
                                const videoData = await videoResponse.json();
                                const promos = videoData.data?.promo || [];
                                console.log('📺 Promo videos count:', promos.length);

                                if (promos.length > 0) {
                                    for (const promo of promos) {
                                        const trailerUrl = promo.trailer?.url || promo.trailer?.embed_url;
                                        if (trailerUrl) {
                                            console.log('🔍 Checking promo URL:', trailerUrl);
                                            const extracted = this.extractYouTubeId(trailerUrl);
                                            if (extracted) {
                                                trailerKey = extracted;
                                                console.log('✅ Extracted trailer from promo:', trailerKey);
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // Third try: Check if there's a PV (promotional video) in the episodes/videos
                        if (!trailerKey) {
                            console.log('⚠️ Still no trailer, checking videos/episodes endpoint...');
                            const episodesResponse = await fetch(`https://api.jikan.moe/v4/anime/${malId}/videos/episodes`);
                            if (episodesResponse.ok) {
                                const episodesData = await episodesResponse.json();
                                const episodes = episodesData.data || [];
                                console.log('📺 Episode videos count:', episodes.length);

                                for (const episode of episodes) {
                                    if (episode.title?.toLowerCase().includes('pv') ||
                                        episode.title?.toLowerCase().includes('trailer') ||
                                        episode.title?.toLowerCase().includes('preview')) {
                                        const videoUrl = episode.url;
                                        if (videoUrl) {
                                            console.log('🔍 Found PV/Trailer episode:', episode.title, videoUrl);
                                            const extracted = this.extractYouTubeId(videoUrl);
                                            if (extracted) {
                                                trailerKey = extracted;
                                                console.log('✅ Extracted trailer from PV episode:', trailerKey);
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        console.error('❌ Error fetching anime trailer:', err);
                    }

                    // Fourth try: Manual YouTube search as last resort
                    if (!trailerKey) {
                        console.log('🔍 Trying YouTube search as fallback...');
                        try {
                            const searchQuery = `${item.title || item.name} anime trailer`;
                            const youtubeSearchResponse = await apiFetch(`${API_URL}/api/youtube-search?q=${encodeURIComponent(searchQuery)}`);
                            if (youtubeSearchResponse.ok) {
                                const searchData = await youtubeSearchResponse.json();
                                if (searchData.videoId) {
                                    trailerKey = searchData.videoId;
                                    console.log('✅ Found trailer via YouTube search:', trailerKey);
                                }
                            }
                        } catch (searchErr) {
                            console.error('❌ YouTube search failed:', searchErr);
                        }
                    }

                    if (trailerKey) {
                        console.log('🎉 Using trailer key:', trailerKey);
                        trailerHtml = `<iframe src="https://www.youtube.com/embed/${trailerKey}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
                    } else {
                        console.log('ℹ️ No trailer available for this anime (MAL ID:', malId, '). This is normal for some anime.');
                    }
                }
            } else if (item.type === 'games') {
                // Get Steam game details for trailer
                if (item.externalApiId) {
                    console.log('🎮 Fetching Steam game trailer for ID:', item.externalApiId);
                    try {
                        const response = await apiFetch(`${API_URL}/api/steam-game/${item.externalApiId}`);
                        if (response.ok) {
                            const game = await response.json();
                            const movies = game.movies || [];
                            console.log('🎬 Steam movies/trailers:', movies);

                            if (movies.length > 0) {
                                // Use the first movie (usually the main trailer)
                                const trailer = movies[0];
                                console.log('✅ Using Steam trailer:', trailer);

                                // Steam stores videos with multiple possible URL patterns
                                let videoUrls = [];

                                // Priority 1: Try to get direct video URLs from API response
                                if (trailer.webm) {
                                    const webmData = trailer.webm;
                                    // Try all available quality levels
                                    const webmUrl = webmData.max || webmData['480'] || webmData['360'] ||
                                        (typeof webmData === 'string' ? webmData : null);
                                    if (webmUrl) videoUrls.push(webmUrl);
                                }

                                if (trailer.mp4) {
                                    const mp4Data = trailer.mp4;
                                    // Try all available quality levels  
                                    const mp4Url = mp4Data.max || mp4Data['480'] || mp4Data['360'] ||
                                        (typeof mp4Data === 'string' ? mp4Data : null);
                                    if (mp4Url) videoUrls.push(mp4Url);
                                }

                                // Priority 2: If no direct URLs in API but we have thumbnail, construct URLs
                                // Steam's CDN structure: thumbnail ends with /movie.293x165.jpg, videos are in same dir
                                if (videoUrls.length === 0 && trailer.thumbnail) {
                                    // Extract base path from thumbnail (remove filename)
                                    const baseUrl = trailer.thumbnail.substring(0, trailer.thumbnail.lastIndexOf('/'));

                                    // Try multiple common Steam video naming patterns
                                    // Steam uses different patterns: movie480_vp9.webm, movie_max.webm, movie.webm, etc.
                                    const patterns = [
                                        'movie_max.webm',
                                        'movie_max.mp4',
                                        'movie480_vp9.webm',
                                        'movie480.webm',
                                        'movie480.mp4',
                                        'movie_480.webm',
                                        'movie.webm',
                                        'movie.mp4'
                                    ];

                                    videoUrls = patterns.map(pattern => `${baseUrl}/${pattern}`);
                                    console.log('🔧 Constructed', videoUrls.length, 'video URL patterns from thumbnail');
                                }

                                // Priority 3: Try constructing from app ID directly
                                if (videoUrls.length === 0) {
                                    // Steam CDN pattern: https://cdn.akamai.steamstatic.com/steam/apps/[APPID]/[movie_file]
                                    const cdnBase = `https://cdn.akamai.steamstatic.com/steam/apps/${item.externalApiId}`;
                                    videoUrls = [
                                        `${cdnBase}/movie480_vp9.webm`,
                                        `${cdnBase}/movie_max.webm`,
                                        `${cdnBase}/movie480.webm`,
                                        `${cdnBase}/movie.webm`,
                                        `${cdnBase}/movie480.mp4`,
                                        `${cdnBase}/movie.mp4`
                                    ];
                                    console.log('🔧 Constructed', videoUrls.length, 'video URLs from CDN pattern');
                                }

                                if (videoUrls.length > 0) {
                                    // Create video element with multiple source fallbacks
                                    const sources = videoUrls.map(url => {
                                        const type = url.includes('.webm') ? 'video/webm' : 'video/mp4';
                                        return `<source src="${url}" type="${type}">`;
                                    }).join('\n                                        ');

                                    // Video player with error handling
                                    trailerHtml = `<video controls muted style="width: 100%; border-radius: 8px;" 
                                        onerror="console.error('Video failed to load'); this.style.display='none'; this.nextElementSibling.style.display='block';">
                                        ${sources}
                                        Your browser does not support the video tag.
                                    </video>
                                    <div style="display:none; text-align:center; padding:2rem; background:rgba(0,0,0,0.5); border-radius:8px;">
                                        Video unavailable. <a href="https://store.steampowered.com/app/${item.externalApiId}" target="_blank" style="color:var(--hover-color);">View on Steam</a>
                                    </div>`;
                                    console.log('🎬 Created video element with', videoUrls.length, 'source fallbacks');
                                } else {
                                    // Final fallback: show thumbnail as clickable link to Steam
                                    if (trailer.thumbnail) {
                                        trailerHtml = `<div style="position: relative; cursor: pointer;" onclick="window.open('https://store.steampowered.com/app/${item.externalApiId}', '_blank')">
                                            <img src="${trailer.thumbnail}" style="width: 100%; border-radius: 8px;" alt="Trailer thumbnail">
                                            <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 4rem; color: white; text-shadow: 0 0 10px black;">▶</div>
                                            <div style="position: absolute; bottom: 1rem; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.7); padding: 0.5rem 1rem; border-radius: 4px; color: white; font-size: 0.9rem;">Click to watch on Steam</div>
                                        </div>`;
                                        console.log('🎬 Created clickable thumbnail fallback');
                                    } else {
                                        console.warn('⚠️ No valid video source or thumbnail found');
                                    }
                                }
                            } else {
                                console.warn('❌ No Steam trailer found for ID:', item.externalApiId);
                            }
                        } else {
                            console.warn('❌ Failed to fetch Steam game data:', response.status);
                        }
                    } catch (err) {
                        console.error('❌ Error fetching Steam game trailer:', err);
                    }
                } else {
                    console.warn('⚠️ No externalApiId for game trailer:', item.name || item.title);
                }
            }

            if (this.currentTrailerRequestToken !== requestToken || section.dataset.trailerRequestToken !== requestToken) {
                return;
            }

            if (trailerHtml) {
                container.innerHTML = trailerHtml;
                section.style.display = 'block';
                // Apply saved layout if exists
                this.applySavedLayoutToElement('detailTrailerSection');
            } else {
                section.style.display = 'none';
            }
        } catch (error) {
            console.warn('Error loading trailer:', error);
            if (this.currentTrailerRequestToken !== requestToken) return;
            section.style.display = 'none';
        }
    }

    // ===== RECOMMENDATIONS SECTION =====
    async populateRecommendationsSection(item) {
        const section = document.getElementById('detailRecommendationsSection');
        const container = document.getElementById('recommendationsContainer');

        if (!section || !container) return;

        try {
            let recommendations = [];

            if (item.type === 'movies' || item.type === 'tv') {
                // TMDB recommendations
                const mediaType = item.type === 'movies' ? 'movies' : 'tv';
                const response = await apiFetch(`${API_URL}/api/recommendations?category=${mediaType}&id=${item.externalApiId}`);
                if (response.ok) {
                    const data = await response.json();
                    recommendations = (data.results || []).slice(0, 6);
                }
            } else if (item.type === 'anime') {
                const malId = this.getAnimeMalId(item);
                if (!malId) {
                    console.warn('ℹ️ No MAL ID found for anime recommendations lookup:', { itemId: item.id, itemName: item.name || item.title });
                } else {
                    // MAL recommendations - filter out current anime and duplicates
                    const response = await fetch(`https://api.jikan.moe/v4/anime/${malId}/recommendations`);
                    if (response.ok) {
                        const data = await response.json();
                        const allRecs = data.data || [];
                        console.log('📺 Raw anime recommendations:', allRecs.length);

                        // Filter out duplicates and current anime
                        const seen = new Set();
                        const currentKey = malId != null ? String(malId) : null;
                        if (currentKey) {
                            seen.add(currentKey);
                        }

                        recommendations = allRecs
                            .filter(rec => {
                                const recId = rec.entry?.mal_id;
                                const recKey = recId != null ? String(recId) : null;
                                if (!recKey || seen.has(recKey)) return false;
                                seen.add(recKey);
                                return true;
                            })
                            .slice(0, 6);

                        console.log('✅ Filtered anime recommendations:', recommendations.length);
                    }
                }
            } else if (item.type === 'games') {
                // Get Steam game recommendations
                if (item.externalApiId) {
                    try {
                        const response = await apiFetch(`${API_URL}/api/steam-recommendations/${item.externalApiId}`);
                        if (response.ok) {
                            const data = await response.json();
                            console.log('🎮 Steam recommendations data:', data);

                            // Steam returns app IDs, we need to fetch details for each
                            if (data.recommendations && Array.isArray(data.recommendations) && data.recommendations.length > 0) {
                                console.log('📦 Fetching details for', data.recommendations.length, 'recommended games...');

                                // Fetch details for each recommended game
                                const detailPromises = data.recommendations.slice(0, 6).map(async (rec) => {
                                    try {
                                        const appId = rec.appid || rec.id;
                                        if (!appId) return null;

                                        const detailResponse = await apiFetch(`${API_URL}/api/steam-game/${appId}`);
                                        if (detailResponse.ok) {
                                            const gameDetails = await detailResponse.json();
                                            return {
                                                appid: appId,
                                                name: gameDetails.name,
                                                header_image: gameDetails.header_image
                                            };
                                        }
                                    } catch (err) {
                                        console.warn('Failed to fetch game details:', err);
                                    }
                                    return null;
                                });

                                const detailedRecs = await Promise.all(detailPromises);
                                recommendations = detailedRecs.filter(rec => rec !== null);
                                console.log('✅ Loaded', recommendations.length, 'game recommendations with details');
                            } else {
                                console.log('ℹ️ No Steam recommendations returned for this game');
                            }
                        } else {
                            console.warn('❌ Failed to fetch Steam recommendations:', response.status);
                        }
                    } catch (err) {
                        console.error('❌ Error fetching Steam recommendations:', err);
                    }
                } else {
                    console.warn('⚠️ No externalApiId for game recommendations:', item.name || item.title);
                }
            }

            console.log('Recommendations for', item.type, ':', recommendations);

            if (recommendations.length > 0) {
                container.innerHTML = recommendations.map((rec, idx) => {
                    const normalized = this.normalizeRecommendation(rec, item.type);
                    const libraryItem = normalized.libraryItem;

                    let poster = '';
                    let title = normalized.name || '';
                    let recId = normalized.externalId || '';

                    if (item.type === 'games') {
                        // Steam format (already has full details from our fetch)
                        poster = rec.header_image || `https://cdn.akamai.steamstatic.com/steam/apps/${rec.appid}/header.jpg`;
                        title = title || rec.name || 'Untitled';
                        recId = recId || rec.appid || rec.id || '';
                    } else if (item.type === 'anime') {
                        // MAL format (has .entry)
                        const recData = rec.entry || rec;
                        poster = recData.images?.jpg?.image_url || '';
                        title = title || recData.title || recData.name || 'Untitled';
                        recId = recId || recData.mal_id || recData.id || '';
                    } else {
                        // TMDB format for movies/TV
                        poster = rec.poster_path ? `https://image.tmdb.org/t/p/w200${rec.poster_path}` : '';
                        title = title || rec.title || rec.name || 'Untitled';
                        recId = recId || rec.id || '';
                    }

                    if (libraryItem) {
                        if (libraryItem.posterBase64) {
                            poster = libraryItem.posterBase64;
                        }
                        if (!title) {
                            title = libraryItem.title || libraryItem.name || title;
                        }
                    }

                    // Only show recommendations that have images
                    if (!poster) return '';

                    return `
                        <div class="recommendation-item" data-id="${recId}" data-type="${item.type}" data-index="${idx}">
                            <img src="${poster}" alt="${title}" class="recommendation-poster" onerror="this.parentElement.style.display='none'" />
                            <div class="recommendation-title">${title}</div>
                        </div>
                    `;
                }).filter(html => html).join('');

                // Only show section if we have valid recommendations
                if (container.innerHTML.trim()) {
                    // Add click handlers
                    container.querySelectorAll('.recommendation-item').forEach(el => {
                        el.addEventListener('click', () => {
                            const recType = el.dataset.type;
                            const index = parseInt(el.dataset.index, 10);
                            const recommendation = Number.isInteger(index) ? recommendations[index] : null;
                            this.openRecommendationDetail(recommendation, recType);
                        });
                    });

                    section.style.display = 'block';
                    // Apply saved layout if exists
                    this.applySavedLayoutToElement('detailRecommendationsSection');
                } else {
                    section.style.display = 'none';
                }
            } else {
                section.style.display = 'none';
            }
        } catch (error) {
            console.warn('Error loading recommendations:', error);
            section.style.display = 'none';
        }
    }

    async openRecommendationDetail(recommendation, recType) {
        if (!recType || !recommendation) return;
        const normalized = this.normalizeRecommendation(recommendation, recType);
        const { type, externalId, name, libraryItem } = normalized;
        if (!type) return;

        if (libraryItem) {
            this.openDetailView(libraryItem, { source: 'recommendation' });
            return;
        }

        try {
            const transientItem = await this.buildTransientItemFromExternal(type, externalId, { name, recommendation });
            if (transientItem) {
                this.openDetailView(transientItem, { source: 'recommendation' });
                return;
            }
        } catch (error) {
            console.error('Failed to open recommendation detail:', error);
            alert('Unable to load the recommended item right now. Please try again later.');
        }
    }

    getDisplayReviewAuthor(author, fallback = 'Anonymous') {
        const name = (author ?? '').toString().trim();
        if (!name) return fallback;
        if (/^\d+$/.test(name)) return fallback;
        return name;
    }

    // ===== REVIEWS SECTION =====
    async populateReviewsSection(item) {
        const section = document.getElementById('detailReviewsSection');
        const container = document.getElementById('reviewsContainer');

        if (!section || !container) return;

        try {
            let reviews = [];

            if (item.type === 'movies' || item.type === 'tv') {
                // TMDB reviews
                const mediaType = item.type === 'movies' ? 'movies' : 'tv';
                const response = await apiFetch(`${API_URL}/api/reviews?category=${mediaType}&id=${item.externalApiId}`);
                if (response.ok) {
                    const data = await response.json();
                    reviews = (data.results || []).slice(0, 5).map(review => ({
                        author: this.getDisplayReviewAuthor(review.author, 'Anonymous'),
                        content: review.content
                    }));
                }
            } else if (item.type === 'anime') {
                const malId = this.getAnimeMalId(item);
                if (!malId) {
                    console.warn('ℹ️ No MAL ID found for anime reviews lookup:', { itemId: item.id, itemName: item.name || item.title });
                } else {
                    // MAL reviews
                    const response = await fetch(`https://api.jikan.moe/v4/anime/${malId}/reviews`);
                    if (response.ok) {
                        const data = await response.json();
                        reviews = (data.data || []).slice(0, 5).map(review => ({
                            author: this.getDisplayReviewAuthor(review.user?.username, 'Anonymous'),
                            content: review.review || ''
                        }));
                    }
                }
            } else if (item.type === 'games') {
                // Get Steam reviews
                if (!item.externalApiId) {
                    console.warn('⚠️ No externalApiId for game reviews:', item.name || item.title);
                    section.style.display = 'none';
                    return;
                }
                try {
                    const response = await apiFetch(`${API_URL}/api/steam-reviews/${item.externalApiId}`);
                    if (response.ok) {
                        const data = await response.json();
                        console.log('🎮 Steam reviews data:', data);
                        reviews = (data.reviews || []).slice(0, 5).map(review => {
                            const recommendation = review.voted_up ? '👍 Recommended' : '👎 Not Recommended';
                            const authorName = this.getDisplayReviewAuthor(review.author, 'Steam User');
                            return {
                                author: `${authorName} - ${recommendation}`,
                                content: review.review || ''
                            };
                        });
                    } else {
                        console.warn('❌ Failed to fetch Steam reviews:', response.status);
                    }
                } catch (err) {
                    console.error('❌ Error fetching Steam reviews:', err);
                }
            }

            console.log('📝 Reviews for', item.type, ':', reviews.length, 'reviews');

            if (reviews.length > 0) {
                container.innerHTML = reviews.map(review => {
                    const content = review.content.length > 400
                        ? review.content.substring(0, 400) + '...'
                        : review.content;
                    return `
                        <div class="review-item">
                            <div class="review-author">${review.author}</div>
                            <div class="review-content">${content}</div>
                        </div>
                    `;
                }).join('');
                section.style.display = 'block';
                // Apply saved layout if exists
                this.applySavedLayoutToElement('detailReviewsSection');
            } else {
                section.style.display = 'none';
            }
        } catch (error) {
            console.warn('Error loading reviews:', error);
            section.style.display = 'none';
        }
    }

    // ===== INFORMATION SIDEBAR =====
    async populateInformationSidebar(item) {
        const section = document.getElementById('detailInformationSidebar');
        const container = document.getElementById('informationContent');

        if (!section || !container) return;

        try {
            let infoHTML = '';

            if (item.type === 'anime') {
                const malId = this.getAnimeMalId(item);
                if (!malId) {
                    console.warn('ℹ️ No MAL ID found for anime info lookup:', { itemId: item.id, itemName: item.name || item.title });
                } else {
                    // Fetch full anime details from MAL
                    const response = await fetch(`https://api.jikan.moe/v4/anime/${malId}/full`);
                    if (response.ok) {
                        const data = await response.json();
                        const anime = data.data;

                        const infoFields = [
                            { label: 'Type', value: anime.type },
                            { label: 'Episodes', value: anime.episodes },
                            { label: 'Status', value: anime.status },
                            { label: 'Aired', value: anime.aired?.string },
                            { label: 'Premiered', value: anime.season && anime.year ? `${anime.season} ${anime.year}` : null },
                            { label: 'Broadcast', value: anime.broadcast?.string },
                            { label: 'Studios', value: anime.studios?.map(s => s.name).join(', ') },
                            { label: 'Source', value: anime.source },
                            { label: 'Genres', value: anime.genres?.map(g => g.name).join(', ') },
                            { label: 'Themes', value: anime.themes?.map(t => t.name).join(', ') },
                            { label: 'Demographics', value: anime.demographics?.map(d => d.name).join(', ') },
                            { label: 'Duration', value: anime.duration },
                            { label: 'Rating', value: anime.rating }
                        ];

                        infoHTML = infoFields
                            .filter(field => field.value)
                            .map(field => `
                            <div class="info-row">
                                <div class="info-label">${field.label}:</div>
                                <div class="info-value">${field.value}</div>
                            </div>
                        `).join('');
                    }
                }
            } else if (item.type === 'games') {
                // Helper function to build info from item data
                const buildGamesInfoFromItem = (gameItem) => {
                    const infoFields = [
                        { label: 'Developer', value: gameItem.developer },
                        { label: 'Release Date', value: gameItem.release_date || gameItem.year },
                        { label: 'Genres', value: gameItem.genre },
                        { label: 'Time to Beat', value: gameItem.timeToBeat ? `${Math.round(parseInt(gameItem.timeToBeat) / 60)} hours` : null }
                    ];

                    return infoFields
                        .filter(field => field.value)
                        .map(field => `
                            <div class="info-row">
                                <div class="info-label">${field.label}:</div>
                                <div class="info-value">${field.value}</div>
                            </div>
                        `).join('');
                };

                // Fetch game details from Steam, or use existing item data
                if (item.externalApiId) {
                    try {
                        const response = await apiFetch(`${API_URL}/api/steam-game/${item.externalApiId}`);
                        if (response.ok) {
                            const game = await response.json();

                            // Build genres text: prioritize user-defined tags (more accurate) over official Steam genres
                            let genresText = item.genre;

                            if (game.userTags && Array.isArray(game.userTags) && game.userTags.length > 0) {
                                // User tags are already sorted by popularity, use top 5-6
                                genresText = game.userTags.slice(0, 6).join(', ');
                            } else if (game.genres && Array.isArray(game.genres)) {
                                // Fallback to official genres if user tags aren't available
                                genresText = game.genres.map(g => g.description).join(', ');
                            }

                            const infoFields = [
                                { label: 'Developer', value: game.developers?.join(', ') || item.developer },
                                { label: 'Publisher', value: game.publishers?.join(', ') },
                                { label: 'Release Date', value: game.release_date?.date || item.release_date || item.year },
                                { label: 'Platforms', value: [game.platforms?.windows && 'Windows', game.platforms?.mac && 'Mac', game.platforms?.linux && 'Linux'].filter(Boolean).join(', ') },
                                { label: 'Genres', value: genresText },
                                { label: 'Time to Beat', value: item.timeToBeat ? `${Math.round(parseInt(item.timeToBeat) / 60)} hours` : null }
                            ];

                            infoHTML = infoFields
                                .filter(field => field.value)
                                .map(field => `
                                    <div class="info-row">
                                        <div class="info-label">${field.label}:</div>
                                        <div class="info-value">${field.value}</div>
                                    </div>
                                `).join('');
                        } else {
                            console.warn('❌ Failed to fetch Steam game data:', response.status);
                            // Fallback to item data
                            infoHTML = buildGamesInfoFromItem(item);
                        }
                    } catch (err) {
                        console.error('❌ Error fetching Steam game info:', err);
                        // Fallback to item data
                        infoHTML = buildGamesInfoFromItem(item);
                    }
                } else {
                    // No externalApiId, use item data
                    infoHTML = buildGamesInfoFromItem(item);
                }
            } else if (item.type === 'movies' || item.type === 'tv') {
                // Fetch details from TMDB
                const mediaType = item.type === 'movies' ? 'movies' : 'tv';
                const response = await apiFetch(`${API_URL}/api/tmdb-details?category=${mediaType}&id=${item.externalApiId}`);
                if (response.ok) {
                    const details = await response.json();

                    const infoFields = item.type === 'movies' ? [
                        // Movies: prefer director(s) from TMDB credits, otherwise fallback to stored directorCreator
                        { label: 'Director/Creator', value: (details.credits && details.credits.crew) ? details.credits.crew.filter(c => c.job === 'Director').map(c => c.name).join(', ') || (item.directorCreator || null) : (item.directorCreator || null) },
                        { label: 'Status', value: details.status },
                        { label: 'Original Language', value: details.original_language?.toUpperCase() },
                        { label: 'Budget', value: details.budget ? `$${details.budget.toLocaleString()}` : null },
                        { label: 'Revenue', value: details.revenue ? `$${details.revenue.toLocaleString()}` : null },
                        { label: 'Runtime', value: details.runtime ? `${details.runtime} min` : null },
                        { label: 'Release Date', value: details.release_date },
                        { label: 'Genres', value: details.genres?.map(g => g.name).join(', ') },
                        { label: 'Production Companies', value: details.production_companies?.slice(0, 3).map(c => c.name).join(', ') }
                    ] : [
                        // For TV shows include a Creator row (from TMDB created_by or fallback to stored directorCreator)
                        { label: 'Creator', value: (details.created_by && Array.isArray(details.created_by) && details.created_by.length) ? details.created_by.map(c => c.name).join(', ') : (item.directorCreator || null) },
                        { label: 'Status', value: details.status },
                        { label: 'Type', value: details.type },
                        { label: 'Original Language', value: details.original_language?.toUpperCase() },
                        { label: 'Networks', value: details.networks?.map(n => n.name).join(', ') },
                        { label: 'First Air Date', value: details.first_air_date },
                        { label: 'Last Air Date', value: details.last_air_date },
                        { label: 'Seasons', value: details.number_of_seasons },
                        { label: 'Episodes', value: details.number_of_episodes },
                        { label: 'Genres', value: details.genres?.map(g => g.name).join(', ') }
                    ];

                    infoHTML = infoFields
                        .filter(field => field.value)
                        .map(field => `
                            <div class="info-row">
                                <div class="info-label">${field.label}:</div>
                                <div class="info-value">${field.value}</div>
                            </div>
                        `).join('');
                }
            }

            if (infoHTML) {
                container.innerHTML = infoHTML;
                section.style.display = 'block';
            } else {
                section.style.display = 'none';
            }
        } catch (error) {
            console.warn('Error loading information sidebar:', error);
            section.style.display = 'none';
        } finally {
            this.updateSidebarVisibility();
        }
    }

    updateSidebarVisibility() {
        const sidebar = document.getElementById('detailSidebarColumn');
        if (!sidebar) return;

        const castContainer = document.getElementById('castCharactersContainer');
        const infoSection = document.getElementById('detailInformationSidebar');
        const animeRelations = document.getElementById('animeRelationsContainer');
        const gameRelations = document.getElementById('gameRelationsContainer');
        const castVisible = castContainer && castContainer.style.display !== 'none';
        const infoVisible = infoSection && infoSection.style.display !== 'none';
        const animeVisible = animeRelations && animeRelations.style.display !== 'none';
        const gameVisible = gameRelations && gameRelations.style.display !== 'none';

        if (castVisible || infoVisible || animeVisible || gameVisible) {
            sidebar.style.display = 'flex';
            this.applySavedLayoutToElement('detailSidebarColumn');
        } else {
            sidebar.style.display = 'none';
        }
    }

    // ===== LAYOUT CUSTOMIZATION (STUB) =====
    // These are stub functions for the layout customization feature
    // They do nothing for now but prevent errors from being thrown
    loadSavedLayout(itemType) {
        // TODO: Implement layout loading from localStorage or database
        // This will eventually load and apply saved custom layouts
        return;
    }

    applySavedLayoutToElement(elementId) {
        // TODO: Implement layout application to specific elements
        // This will eventually apply saved layout settings to UI elements
        return;
    }

    hideCastSection() {
        const castContainer = document.getElementById('castCharactersContainer');
        const castGrid = document.getElementById('castCharactersGrid');
        if (castGrid) {
            castGrid.innerHTML = '';
        }
        if (castContainer) {
            castContainer.style.display = 'none';
        }
        this.updateSidebarVisibility();
    }

    async loadAndRenderCast(item) {
        this.hideCastSection();
        try {
            const response = await apiFetch(`${API_URL}/api/cast?category=${item.type}&id=${item.externalApiId}`);
            if (!response.ok) {
                this.hideCastSection();
                return;
            }

            const data = await response.json();
            const cast = (data.cast || []).slice(0, 3); // Top 3 actors

            if (cast.length === 0) {
                this.hideCastSection();
                return;
            }

            this.renderCastCharacters(cast, 'Top Cast');
        } catch (error) {
            console.error('Error loading cast:', error);
            this.hideCastSection();
        }
    }

    async loadAndRenderGameRelations(item, externalId) {
        try {
            const response = await apiFetch(`${API_URL}/api/game-relations/${externalId}`);
            if (!response.ok) {
                document.getElementById('gameRelationsContainer').style.display = 'none';
                this.updateSidebarVisibility();
                return;
            }

            const data = await response.json();
            const dlcList = data.dlc || [];
            const similarGames = data.similar_games || [];

            const gameRelationsContainer = document.getElementById('gameRelationsContainer');
            const dlcGrid = document.getElementById('gameDlcGrid');
            const similarGrid = document.getElementById('gameSimilarGrid');
            const dlcContainer = document.querySelector('.game-dlc-container');
            const similarContainer = document.querySelector('.game-similar-container');

            if (!gameRelationsContainer || !dlcGrid || !similarGrid) {
                return;
            }

            const hasDlc = Array.isArray(dlcList) && dlcList.length > 0;
            const hasSimilar = Array.isArray(similarGames) && similarGames.length > 0;

            if (!hasDlc && !hasSimilar) {
                gameRelationsContainer.style.display = 'none';
                this.updateSidebarVisibility();
                return;
            }

            // Show container
            gameRelationsContainer.style.display = 'flex';

            // Render DLC
            if (hasDlc && dlcGrid) {
                dlcGrid.innerHTML = '';
                dlcList.forEach(dlc => {
                    const img = document.createElement('img');
                    const gameName = dlc.name || 'Unknown';
                    const gameId = dlc.appid || dlc.id;

                    // Check if game exists in library
                    const libraryGame = gameId ? this.data.items.find(i =>
                        i.type === 'games' &&
                        i.externalApiId === String(gameId)
                    ) : null;

                    // Get image URL - prioritize library, then Steam API
                    let posterSrc = '';

                    if (libraryGame) {
                        if (libraryGame.posterBase64) {
                            posterSrc = libraryGame.posterBase64;
                        } else if (libraryGame.id) {
                            posterSrc = `${API_URL}/assets/img/${libraryGame.id}_poster.webp`;
                        }
                    }

                    // Fallback to Steam header image
                    if (!posterSrc) {
                        posterSrc = dlc.header_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${gameId}/header.jpg`;
                    }

                    // Fallback placeholder
                    if (!posterSrc) {
                        posterSrc = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjEwMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD4KPC9zdmc+';
                    }

                    img.src = posterSrc;
                    img.alt = gameName;
                    img.style.cursor = 'pointer';
                    img.style.width = '100%';
                    img.style.aspectRatio = '460/215';
                    img.style.objectFit = 'cover';
                    img.style.borderRadius = '4px';
                    img.onerror = function () {
                        this.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjEwMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD4KPC9zdmc+';
                    };
                    img.addEventListener('click', async () => {
                        // Use library game if found, otherwise create transient item
                        if (libraryGame) {
                            this.openDetailView(libraryGame, { source: 'relation' });
                        } else if (gameId) {
                            const transientGame = await this.buildTransientItemFromExternal('games', String(gameId), {
                                name: gameName
                            });
                            if (transientGame) {
                                this.openDetailView(transientGame, { source: 'relation' });
                            }
                        }
                    });
                    dlcGrid.appendChild(img);
                });
                if (dlcContainer) dlcContainer.style.display = 'block';
            } else if (dlcContainer) {
                dlcContainer.style.display = 'none';
            }

            // Render similar games
            if (hasSimilar && similarGrid) {
                similarGrid.innerHTML = '';
                similarGames.forEach(game => {
                    const img = document.createElement('img');
                    const gameName = game.name || 'Unknown';
                    const gameId = game.appid || game.id;

                    // Check if game exists in library
                    const libraryGame = gameId ? this.data.items.find(i =>
                        i.type === 'games' &&
                        i.externalApiId === String(gameId)
                    ) : null;

                    // Get image URL - prioritize library, then Steam API
                    let posterSrc = '';

                    if (libraryGame) {
                        if (libraryGame.posterBase64) {
                            posterSrc = libraryGame.posterBase64;
                        } else if (libraryGame.id) {
                            posterSrc = `${API_URL}/assets/img/${libraryGame.id}_poster.webp`;
                        }
                    }

                    // Fallback to Steam header image
                    if (!posterSrc) {
                        posterSrc = game.header_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${gameId}/header.jpg`;
                    }

                    // Fallback placeholder
                    if (!posterSrc) {
                        posterSrc = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjEwMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD4KPC9zdmc+';
                    }

                    img.src = posterSrc;
                    img.alt = gameName;
                    img.style.cursor = 'pointer';
                    img.style.width = '100%';
                    img.style.aspectRatio = '460/215';
                    img.style.objectFit = 'cover';
                    img.style.borderRadius = '4px';
                    img.onerror = function () {
                        this.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjEwMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD4KPC9zdmc+';
                    };
                    img.addEventListener('click', async () => {
                        // Use library game if found, otherwise create transient item
                        if (libraryGame) {
                            this.openDetailView(libraryGame, { source: 'relation' });
                        } else if (gameId) {
                            const transientGame = await this.buildTransientItemFromExternal('games', String(gameId), {
                                name: gameName
                            });
                            if (transientGame) {
                                this.openDetailView(transientGame, { source: 'relation' });
                            }
                        }
                    });
                    similarGrid.appendChild(img);
                });
                if (similarContainer) similarContainer.style.display = 'block';
            } else if (similarContainer) {
                similarContainer.style.display = 'none';
            }

            this.updateSidebarVisibility();
        } catch (error) {
            console.error('Error loading game relations:', error);
            document.getElementById('gameRelationsContainer').style.display = 'none';
            this.updateSidebarVisibility();
        }
    }

    renderCastCharacters(castCharacters, title) {
        const container = document.getElementById('castCharactersContainer');
        const titleEl = document.getElementById('castCharactersTitle');
        const grid = document.getElementById('castCharactersGrid');

        if (!container || !titleEl || !grid) return;

        titleEl.textContent = title;
        grid.innerHTML = '';

        castCharacters.forEach(person => {
            const item = document.createElement('div');
            item.className = 'cast-character-item';

            const img = document.createElement('img');

            // Check if actor exists in library
            const actorName = person.name;
            const matchingActor = actorName ? this.data.items.find(item =>
                item.type === 'actors' &&
                item.name &&
                item.name.toLowerCase().trim() === actorName.toLowerCase().trim()
            ) : null;

            // Use library image if actor exists in library, otherwise use TMDB image
            // Store fallback TMDB image path for error handling
            const profilePath = person.profile_path
                ? `https://image.tmdb.org/t/p/w185${person.profile_path}`
                : 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTg1IiBoZWlnaHQ9IjI3OCIgdmlld0JveD0iMCAwIDE4NSAyNzgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIxODUiIGhlaWdodD0iMjc4IiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjkyLjUiIHk9IjEzOSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iIzY2NiIgZm9udC1zaXplPSIxNCI+Tm8gSW1hZ2U8L3RleHQ+Cjwvc3ZnPg==';
            const tmdbImageSrc = profilePath.includes('data:image') ? profilePath : `${API_URL}/api/tmdb-image?url=${encodeURIComponent(profilePath)}`;

            if (matchingActor) {
                // Use the actor's library image (prioritize posterBase64, fallback to webp file)
                if (matchingActor.posterPath) {
                    img.src = this.getProxiedImageUrl(matchingActor.posterPath);
                } else if (matchingActor.posterBase64) {
                    img.src = matchingActor.posterBase64;
                } else if (matchingActor.id) {
                    // Try to load webp file, fallback to TMDB if it fails
                    img.src = `${API_URL}/assets/img/${matchingActor.id}_poster.webp`;
                    img.onerror = () => {
                        // If webp file doesn't exist, fallback to TMDB image
                        img.onerror = null; // Prevent infinite loop
                        img.src = tmdbImageSrc;
                    };
                } else {
                    // Fall back to TMDB image if library actor has no image
                    img.src = tmdbImageSrc;
                }
            } else {
                // Fall back to TMDB image or placeholder
                img.src = tmdbImageSrc;
            }

            img.alt = person.name || person.character || 'Cast member';
            img.loading = 'lazy';

            const name = document.createElement('div');
            name.className = 'cast-character-name';
            name.textContent = person.name || person.character || 'Unknown';

            // Add click handler to navigate to actor if found
            item.addEventListener('click', () => {
                this.navigateToActorFromCast(actorName, person.profile_path, person.id);
            });

            item.appendChild(img);
            item.appendChild(name);
            grid.appendChild(item);
        });

        container.style.display = 'block';
        this.updateSidebarVisibility();
    }

    async navigateToActorFromCast(actorName, profilePath, personId) {
        if (!actorName) {
            return;
        }

        // Find actor in library by matching name
        const matchingActor = this.data.items.find(item =>
            item.type === 'actors' &&
            item.name &&
            item.name.toLowerCase().trim() === actorName.toLowerCase().trim()
        );

        if (matchingActor) {
            // Save current item (movie/series) to navigation stack before navigating to actor
            if (this.currentItem && (this.currentItem.type === 'movies' || this.currentItem.type === 'tv')) {
                this.navigationStack.push(this.currentItem);
            }
            // Navigate to actor detail view
            this.openDetailView(matchingActor, { source: 'cast' });
        } else if (personId) {
            // Actor not in library - create transient actor item on demand
            // Save current item (movie/series) to navigation stack before navigating to actor
            if (this.currentItem && (this.currentItem.type === 'movies' || this.currentItem.type === 'tv')) {
                this.navigationStack.push(this.currentItem);
            }

            // Build transient actor item from TMDB
            const transientActor = await this.buildTransientItemFromExternal('actors', personId, { name: actorName });

            if (transientActor) {
                // Navigate to transient actor detail view
                this.openDetailView(transientActor, { source: 'cast' });
            } else {
                console.warn(`Could not load actor details for "${actorName}" (ID: ${personId})`);
            }
        } else {
            // No person ID available, cannot load actor details
            console.log(`Actor "${actorName}" not found in library and no person ID available`);
        }
    }

    renderScoreCircle(score, category, id) {
        const circle = document.getElementById('detailScoreCircle');
        const scoreNumber = document.getElementById('scoreNumber');
        const circleFill = circle.querySelector('.score-circle-fill');

        // Show the circle
        circle.style.display = 'block';

        // Set the score number
        scoreNumber.textContent = Math.round(score);

        // Calculate the dash offset for the circle (283 is the circumference for r=45: 2π × 45 ≈ 283)
        const circumference = 283;
        const offset = circumference - (score / 100) * circumference;
        circleFill.style.strokeDashoffset = offset;

        // Set the color class based on score
        circleFill.classList.remove('score-excellent', 'score-good', 'score-yellow', 'score-red');
        if (score >= 90) {
            circleFill.classList.add('score-excellent');
        } else if (score >= 70) {
            circleFill.classList.add('score-good');
        } else if (score >= 50) {
            circleFill.classList.add('score-yellow');
        } else {
            circleFill.classList.add('score-red');
        }

        // Add click handler to redirect to original source
        circle.onclick = () => {
            let url = '';
            if (category === 'games') {
                url = `https://store.steampowered.com/app/${id}`;
            } else if (category === 'movies' || category === 'tv' || category === 'actors') {
                url = `https://www.themoviedb.org/${category === 'tv' ? 'tv' : 'movie'}/${id}`;
            } else if (category === 'anime') {
                url = `https://myanimelist.net/anime/${id}`;
            }

            if (url) {
                window.open(url, '_blank');
            }
        };
    }


    renderSocialMediaIcons(socialMediaString, container) {
        if (!socialMediaString) return;

        // Parse URLs (comma-separated)
        const urls = socialMediaString.split(',').map(url => url.trim()).filter(url => url);

        urls.forEach(url => {
            const icon = document.createElement('a');
            icon.href = url;
            icon.target = '_blank';
            icon.rel = 'noopener noreferrer';
            icon.className = 'social-media-icon';

            // Detect platform and set icon
            const urlLower = url.toLowerCase();
            let iconName = 'link';
            let title = 'Social Media';

            if (urlLower.includes('instagram.com')) {
                iconName = 'instagram';
                title = 'Instagram';
            } else if (urlLower.includes('facebook.com')) {
                iconName = 'facebook';
                title = 'Facebook';
            } else if (urlLower.includes('twitter.com') || urlLower.includes('x.com')) {
                iconName = 'twitter';
                title = 'Twitter';
            } else if (urlLower.includes('open.spotify.com') || urlLower.includes('spotify:')) {
                iconName = 'spotify';
                title = 'Spotify';
            } else if (urlLower.includes('imdb.com')) {
                iconName = 'imdb';
                title = 'IMDB';
            } else if (urlLower.includes('youtube.com')) {
                iconName = 'youtube';
                title = 'YouTube';
            } else if (urlLower.includes('linkedin.com')) {
                iconName = 'linkedin';
                title = 'LinkedIn';
            }

            icon.title = title;
            icon.innerHTML = this.getSocialMediaIconSVG(iconName);
            container.appendChild(icon);
        });
    }

    getSocialMediaIconSVG(platform) {
        const icons = {
            instagram: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
            </svg>`,
            facebook: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
            </svg>`,
            twitter: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M23.953 4.57a10 10 0 01-2.825.775 4.958 4.958 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.92 4.92 0 00-8.384 4.482C7.69 8.095 4.067 6.13 1.64 3.162a4.822 4.822 0 00-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616v.06a4.923 4.923 0 003.946 4.827 4.996 4.996 0 01-2.212.085 4.936 4.936 0 004.604 3.417 9.867 9.867 0 01-6.102 2.105c-.39 0-.779-.023-1.17-.067a13.995 13.995 0 007.557 2.209c9.053 0 13.998-7.496 13.998-13.985 0-.21 0-.42-.015-.63A9.935 9.935 0 0024 4.59z"/>
            </svg>`,
            spotify: `<svg width="24" height="24" viewBox="0 0 167.2 167.2" fill="currentColor">
                <path d="M83.6 0C37.4 0 0 37.4 0 83.6s37.4 83.6 83.6 83.6 83.6-37.4 83.6-83.6S129.8 0 83.6 0zm37.8 120.9c-1.9 2.9-5.8 3.8-8.7 1.9-19-12-42.9-14.7-71-8.2-3.4.8-6.6-1.3-7.4-4.7-.8-3.4 1.3-6.6 4.7-7.4 32.6-7.1 59.8-4 82.3 9.6 3 1.9 3.9 5.8 2 8.7zM126 95.6c-2.3 3.5-7.2 4.6-10.7 2.3-21.7-14.1-54.9-18.2-80.7-10.2-4 .1-7.6-2.6-7.7-6.6-.1-4 2.6-7.6 6.6-7.7 29.9-8.4 66.6-4.1 92.5 11.6 3.5 2.3 4.6 7.2 2.3 10.7zM131.3 74c-25-16.2-66-17.6-89.2-9.8-4.6 1.4-9.4-1-10.8-5.6-1.4-4.6 1-9.4 5.6-10.8 28.9-8.9 74.3-7.3 104.5 11 4.1 2.6 5.4 7.9 2.8 12-2.6 4.1-7.9 5.4-12 2.8z"/>
            </svg>`,
            imdb: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.5 6v12h19V6h-19zm15.944 10.872H15.64v-2.264h-1.848v2.264H12.236V7.128h1.556v2.024h1.848V7.128h2.804v9.744zm-4.956-2.608v3.608h2.456V7.128h-2.456v7.136zm-3.264-2.608h1.32v3.608h-1.32v-3.608zM8.36 7.128h1.936l2.38 9.744h-1.676l-.484-1.944H8.104l-.484 1.944H6.092L8.472 7.128H8.36zm-.496 5.888h2.244l-.388-1.56-.56-2.368-.584 2.368-.352 1.56z"/>
            </svg>`,
            youtube: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
            </svg>`,
            linkedin: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
            </svg>`,
            link: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
            </svg>`
        };

        return icons[platform] || icons.link;
    }

    renderLinkedMovies(linkedMoviesString) {
        if (!linkedMoviesString) {
            document.getElementById('linkedMoviesGrid').innerHTML = '<p>No linked movies/TV shows.</p>';
            return;
        }

        const movieIds = linkedMoviesString.split(',').filter(id => id.trim());
        const linkedMovies = [];

        // Find the linked movies in our data
        movieIds.forEach(id => {
            const movie = this.data.items.find(item => item.id === id.trim());
            if (movie) {
                linkedMovies.push(movie);
            }
        });

        if (linkedMovies.length === 0) {
            document.getElementById('linkedMoviesGrid').innerHTML = '<p>No linked movies/TV shows found.</p>';
            return;
        }

        const html = linkedMovies.map(movie => `
            <div class="linked-movie-grid-item" data-movie-id="${movie.id}">
                <img src="${this.getProxiedImageUrl(movie.posterPath) || movie.posterBase64 || `${API_URL}/assets/img/${movie.id}_poster.webp`}" alt="${movie.name}" />
                <div class="linked-movie-overlay">
                    <div class="linked-movie-name">${movie.name}</div>
                </div>
            </div>
        `).join('');

        document.getElementById('linkedMoviesGrid').innerHTML = html;

        // Add click handlers to navigate to linked movie detail view
        document.querySelectorAll('.linked-movie-grid-item').forEach(item => {
            item.addEventListener('click', () => {
                const movieId = item.dataset.movieId;
                const movie = this.data.items.find(m => m.id === movieId);
                if (movie) {
                    // If currently viewing an actor, save it to navigation stack
                    if (this.currentItem && this.currentItem.type === 'actors') {
                        this.navigationStack.push(this.currentItem);
                    }
                    this.currentItem = movie;
                    this.openDetailView(movie, { source: 'linked' });
                }
            });
        });
    }

    async loadAndRenderActorLinkedMovies(actorItem) {
        // Start with library linked movies if available
        const libraryLinkedMovies = [];
        if (actorItem.linkedMovies) {
            const movieIds = actorItem.linkedMovies.split(',').filter(id => id.trim());
            movieIds.forEach(id => {
                const movie = this.data.items.find(item => item.id === id.trim());
                if (movie) {
                    libraryLinkedMovies.push(movie);
                }
            });
        }

        // Fetch credits from TMDB if actor has externalApiId
        let credits = [];
        // Detect a Spotify artist id and, if present, use Spotify top-tracks exclusively
        // Detection checks: explicit source, a stored spotifyUrl, or any spotify link in socialMedia
        const spotifyIdFromSocial = (actorItem.socialMedia || '').match(/(?:open\.spotify\.com\/artist\/|spotify:artist:)([A-Za-z0-9]+)|artist\/([A-Za-z0-9]+)/);
        const spotifyUrl = actorItem.spotifyUrl || (actorItem.socialMedia && actorItem.socialMedia.includes('spotify') ? actorItem.socialMedia : '');
        // If externalApiId is numeric, treat it as TMDB person id (not Spotify).
        let spotifyId = null;
        if (actorItem.externalApiId && !/^[0-9]+$/.test(String(actorItem.externalApiId))) {
            spotifyId = String(actorItem.externalApiId);
        }
        if (!spotifyId) {
            if (actorItem.source === 'spotify' && actorItem.externalApiId) spotifyId = actorItem.externalApiId;
            if (!spotifyId && spotifyIdFromSocial) spotifyId = spotifyIdFromSocial[1] || spotifyIdFromSocial[2];
            if (!spotifyId && spotifyUrl) spotifyId = (spotifyUrl.match(/artist\/([A-Za-z0-9]+)/)?.[1] || spotifyUrl.match(/spotify:artist:([A-Za-z0-9]+)/)?.[1]) || null;
        }

        if (spotifyId) {
            try {
                // Prefer server-side proxy
                let tracks = [];
                try {
                    const proxyResp = await apiFetch(`${API_URL}/spotify/artist/${encodeURIComponent(spotifyId)}/top-tracks?market=US`);
                    if (proxyResp.ok) {
                        const proxyData = await proxyResp.json();
                        tracks = proxyData.tracks || proxyData || [];
                    } else {
                        console.warn('Spotify proxy returned', proxyResp.status);
                    }
                } catch (proxyErr) {
                    console.warn('Spotify proxy fetch failed, will try client-side:', proxyErr.message);
                }

                if (!tracks || tracks.length === 0) {
                    tracks = await this.getSpotifyArtistTopTracks(spotifyId, 'US');
                }

                if (!tracks || tracks.length === 0) {
                    document.getElementById('linkedMoviesGrid').innerHTML = '<p>No songs found.</p>';
                    return;
                }

                // If Spotify top-tracks returned fewer than 12, attempt to gather additional
                // popular tracks from the artist's albums (client-side fallback).
                if (tracks.length < 12) {
                    try {
                        const more = await this.getSpotifyArtistAdditionalTracks(spotifyId, 'US', 12);
                        // Append any unique tracks until we have up to 12
                        const existingIds = new Set((tracks || []).map(t => t.id));
                        for (const t of more) {
                            if (tracks.length >= 12) break;
                            if (!existingIds.has(t.id)) {
                                tracks.push(t);
                                existingIds.add(t.id);
                            }
                        }
                    } catch (e) {
                        console.warn('Failed to fetch additional Spotify tracks:', e && e.message ? e.message : e);
                    }
                }

                // Limit to 12 tracks for Known For
                tracks = (tracks || []).slice(0, 12);

                const html = tracks.map(track => {
                    const img = (track.album && track.album.images && track.album.images.length)
                        ? (track.album.images[1]?.url || track.album.images[0]?.url)
                        : this.PLACEHOLDER_IMAGE;
                    const artists = (track.artists || []).map(a => a.name).join(', ');
                    const safeName = this.escapeHtml(track.name || 'Unknown');
                    const safeArtists = this.escapeHtml(artists || '');
                    return `
                        <div class="linked-movie-grid-item spotify-track" data-track-id="${track.id}" data-preview-url="${track.preview_url || ''}">
                            <img src="${img}" alt="${safeName}" />
                            <div class="linked-movie-overlay">
                                <div class="linked-movie-name">${safeName}</div>
                                <div class="linked-movie-sub">${safeArtists}</div>
                            </div>
                        </div>
                    `;
                }).join('');

                document.getElementById('linkedMoviesGrid').innerHTML = html;

                // Click handlers: play preview if available, otherwise open Spotify track
                document.querySelectorAll('.linked-movie-grid-item.spotify-track').forEach(item => {
                    item.addEventListener('click', () => {
                        const trackId = item.dataset.trackId;
                        const preview = item.dataset.previewUrl;
                        if (preview) {
                            let player = document.getElementById('spotifyPreviewPlayer');
                            if (!player) {
                                player = document.createElement('audio');
                                player.id = 'spotifyPreviewPlayer';
                                player.controls = true;
                                player.style.position = 'fixed';
                                player.style.bottom = '12px';
                                player.style.right = '12px';
                                player.style.zIndex = 9999;
                                document.body.appendChild(player);
                            }
                            if (player.src !== preview) player.src = preview;
                            player.style.display = 'block';
                            player.play().catch(() => { });
                        } else {
                            window.open(`https://open.spotify.com/track/${trackId}`, '_blank');
                        }
                    });
                });

                return;
            } catch (err) {
                console.warn('Spotify top tracks failed, falling back to TMDB credits', err);
            }
        }
        if (actorItem.externalApiId) {
            try {
                // Check if we already have transient credits cached
                if (actorItem.transientCredits && actorItem.transientCredits.length > 0) {
                    credits = actorItem.transientCredits;
                } else {
                    // Fetch credits from TMDB
                    const creditsResponse = await apiFetch(`${API_URL}/api/filmography?id=${actorItem.externalApiId}`);
                    if (creditsResponse.ok) {
                        const creditsData = await creditsResponse.json();
                        // Combine movies and TV shows, add media_type to each item
                        const allCredits = [
                            ...(creditsData.movies || []).map(item => ({ ...item, media_type: 'movie' })),
                            ...(creditsData.tv || []).map(item => ({ ...item, media_type: 'tv' }))
                        ];

                        // Filter to only on-screen acting roles (exclude voice roles, talk shows, reality, etc.)
                        const filteredCredits = this.filterActingRolesOnly(allCredits);

                        // Sort by popularity (if available) or release date, limit to top 20
                        credits = filteredCredits
                            .sort((a, b) => {
                                // Sort by popularity if available
                                if (a.popularity && b.popularity) {
                                    return b.popularity - a.popularity;
                                }
                                // Otherwise sort by release date (newest first)
                                const dateA = a.release_date || a.first_air_date || '';
                                const dateB = b.release_date || b.first_air_date || '';
                                return dateB.localeCompare(dateA);
                            })
                            .slice(0, 12);                        // Cache credits for future use
                        actorItem.transientCredits = credits;
                    }
                }
            } catch (error) {
                console.warn('Could not fetch actor credits:', error);
            }
        } else if (actorItem.transientCredits && actorItem.transientCredits.length > 0) {
            // Use cached transient credits
            credits = actorItem.transientCredits;
        }

        // Merge library linked movies with credits, prioritizing library items
        this.renderLinkedMoviesMerged(libraryLinkedMovies, credits);
    }

    async renderLinkedMoviesMerged(libraryMovies, credits) {
        const linkedMovies = [];
        const usedExternalIds = new Set();

        // First, add all library movies (these take priority)
        libraryMovies.forEach(movie => {
            if (movie.externalApiId) {
                usedExternalIds.add(`${movie.type}_${movie.externalApiId}`);
            }
            linkedMovies.push({
                ...movie,
                isTransient: false
            });
        });

        // Then, process credits and add those not in library
        if (credits && credits.length > 0) {
            for (const credit of credits) {
                const mediaType = credit.media_type === 'movie' ? 'movies' : 'tv';
                const externalId = String(credit.id);
                const key = `${mediaType}_${externalId}`;

                // Skip if already in library (already added above)
                if (usedExternalIds.has(key)) {
                    continue;
                }

                // Check if it's now in library (might have been added since last check)
                const libraryItem = this.data.items.find(item =>
                    item.type === mediaType &&
                    item.externalApiId === externalId
                );

                if (libraryItem) {
                    // It's in library now, use library item (priority)
                    usedExternalIds.add(key);
                    linkedMovies.push({
                        ...libraryItem,
                        isTransient: false
                    });
                } else {
                    // Not in library, create transient item
                    const posterPath = credit.poster_path || '';
                    const posterUrl = posterPath
                        ? (posterPath.startsWith('http')
                            ? posterPath
                            : `${API_URL}/api/tmdb-image?url=${encodeURIComponent(`https://image.tmdb.org/t/p/w300${posterPath}`)}`)
                        : '';

                    linkedMovies.push({
                        id: `transient_${mediaType}_${externalId}`,
                        type: mediaType,
                        externalApiId: externalId,
                        name: credit.title || credit.name || 'Unknown',
                        title: credit.title || credit.name || 'Unknown',
                        posterBase64: posterUrl,
                        isTransient: true
                    });
                }

                // Stop adding if we've reached 12 total items
                if (linkedMovies.length >= 12) {
                    break;
                }
            }
        }

        // Ensure we never show more than 12 items total
        const displayMovies = linkedMovies.slice(0, 12);

        if (displayMovies.length === 0) {
            document.getElementById('linkedMoviesGrid').innerHTML = '<p>No linked movies/TV shows.</p>';
            return;
        }

        const html = displayMovies.map(movie => {
            const posterSrc = this.getProxiedImageUrl(movie.posterPath) || movie.posterBase64 || (movie.id && !movie.isTransient ? `${API_URL}/assets/img/${movie.id}_poster.webp` : 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjEwMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD4KPC9zdmc+');
            return `
                <div class="linked-movie-grid-item" data-movie-id="${movie.id}" data-external-id="${movie.externalApiId}" data-media-type="${movie.type}" data-is-transient="${movie.isTransient || false}">
                    <img src="${posterSrc}" alt="${movie.name}" />
                    <div class="linked-movie-overlay">
                        <div class="linked-movie-name">${movie.name}</div>
                    </div>
                </div>
            `;
        }).join('');

        document.getElementById('linkedMoviesGrid').innerHTML = html;

        // Add click handlers to navigate to linked movie detail view
        document.querySelectorAll('.linked-movie-grid-item').forEach(item => {
            item.addEventListener('click', async () => {
                const movieId = item.dataset.movieId;
                const externalId = item.dataset.externalId;
                const mediaType = item.dataset.mediaType;
                const isTransient = item.dataset.isTransient === 'true';

                // If currently viewing an actor, save it to navigation stack
                if (this.currentItem && this.currentItem.type === 'actors') {
                    this.navigationStack.push(this.currentItem);
                }

                if (isTransient) {
                    // Create transient item on demand
                    const transientItem = await this.buildTransientItemFromExternal(mediaType, externalId);
                    if (transientItem) {
                        this.currentItem = transientItem;
                        this.openDetailView(transientItem, { source: 'linked' });
                    }
                } else {
                    // Use library item - always check library first in case it was just added
                    const movie = this.data.items.find(m => m.id === movieId) ||
                        this.data.items.find(m => m.type === mediaType && m.externalApiId === externalId);
                    if (movie) {
                        this.currentItem = movie;
                        this.openDetailView(movie, { source: 'linked' });
                    }
                }
            });
        });
    }

    async loadAndRenderActorInterviews(actorItem) {
        const interviewsSection = document.getElementById('actorInterviewsSection');
        const interviewsGrid = document.getElementById('interviewsGrid');

        if (!interviewsSection || !interviewsGrid) return;

        // Get YouTube API key from settings
        const youtubeApiKey = this.data?.settings?.youtubeApiKey || '';
        if (!youtubeApiKey) {
            interviewsSection.style.display = 'none';
            return;
        }

        const actorName = actorItem.name || actorItem.title || '';
        if (!actorName) {
            interviewsSection.style.display = 'none';
            return;
        }

        try {
            // Search for interviews - prioritize interview content, exclude trailers and music videos
            // Order by viewCount to get popular videos first, request more results to filter
            const searchQuery = encodeURIComponent(`${actorName} interview`);
            const youtubeSearchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${searchQuery}&type=video&maxResults=30&order=viewCount&videoDuration=medium&key=${youtubeApiKey}`;

            const response = await fetch(youtubeSearchUrl);
            if (!response.ok) {
                console.warn('YouTube API request failed:', response.status);
                interviewsSection.style.display = 'none';
                return;
            }

            const data = await response.json();
            const videos = data.items || [];

            // Get video IDs to fetch statistics (view counts)
            const videoIds = videos.map(v => v.id.videoId).join(',');
            const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}&key=${youtubeApiKey}`;

            const statsResponse = await fetch(statsUrl);
            if (!statsResponse.ok) {
                console.warn('YouTube stats request failed:', statsResponse.status);
                interviewsSection.style.display = 'none';
                return;
            }

            const statsData = await statsResponse.json();
            const statsMap = new Map();
            (statsData.items || []).forEach(item => {
                statsMap.set(item.id, {
                    viewCount: parseInt(item.statistics.viewCount || '0', 10),
                    duration: item.contentDetails.duration
                });
            });

            // Filter out trailers, music videos, shorts, and low-view videos
            const filteredVideos = videos.filter(video => {
                const videoId = video.id.videoId;
                const stats = statsMap.get(videoId);
                const title = (video.snippet.title || '').toLowerCase();
                const description = (video.snippet.description || '').toLowerCase();
                const combined = title + ' ' + description;

                // Exclude videos with less than 10k views
                if (!stats || stats.viewCount < 10000) {
                    return false;
                }

                // Exclude shorts (duration less than 60 seconds)
                // Duration format: PT#M#S or PT#S
                if (stats.duration) {
                    const durationMatch = stats.duration.match(/PT(?:(\d+)M)?(\d+)S/);
                    if (durationMatch) {
                        const minutes = parseInt(durationMatch[1] || '0', 10);
                        const seconds = parseInt(durationMatch[2] || '0', 10);
                        const totalSeconds = minutes * 60 + seconds;
                        if (totalSeconds < 60) {
                            return false;
                        }
                    }
                }

                // Exclude trailers, music videos, songs, and compilations
                const excludeTerms = ['trailer', 'official music video', 'official video', 'lyric video', 'audio', 'full album', 'compilation', 'playlist', '#shorts'];
                const hasExcludedTerm = excludeTerms.some(term => combined.includes(term));

                // Prefer interviews and fact videos
                const preferTerms = ['interview', 'talks about', 'discusses', 'facts', 'things you didn\'t know', 'behind the scenes'];
                const hasPreferredTerm = preferTerms.some(term => combined.includes(term));

                return !hasExcludedTerm || hasPreferredTerm;
            })
                // Sort by recency first (newest videos), then by view count
                .sort((a, b) => {
                    const dateA = new Date(a.snippet.publishedAt);
                    const dateB = new Date(b.snippet.publishedAt);

                    // Compare dates first (newest first)
                    const dateDiff = dateB - dateA;
                    if (Math.abs(dateDiff) > 30 * 24 * 60 * 60 * 1000) { // If more than 30 days apart
                        return dateDiff;
                    }

                    // If dates are close (within 30 days), sort by view count
                    const statsA = statsMap.get(a.id.videoId);
                    const statsB = statsMap.get(b.id.videoId);
                    return (statsB?.viewCount || 0) - (statsA?.viewCount || 0);
                })
                .slice(0, 6);

            if (filteredVideos.length === 0) {
                interviewsSection.style.display = 'none';
                return;
            }

            const html = filteredVideos.map(video => {
                const videoId = video.id.videoId;
                const thumbnail = video.snippet.thumbnails?.medium?.url || video.snippet.thumbnails?.default?.url || '';
                const title = this.escapeHtml(video.snippet.title || 'Untitled');
                const channelTitle = this.escapeHtml(video.snippet.channelTitle || '');

                return `
                    <div class="interview-item" data-video-id="${videoId}">
                        <img src="${thumbnail}" alt="${title}" class="interview-thumbnail" />
                        <div class="interview-overlay">
                            <div class="interview-title">${title}</div>
                            <div class="interview-channel">${channelTitle}</div>
                        </div>
                    </div>
                `;
            }).join('');

            interviewsGrid.innerHTML = html;
            interviewsSection.style.display = 'block';

            // Add click handlers to open videos in embedded player
            document.querySelectorAll('.interview-item').forEach(item => {
                item.addEventListener('click', () => {
                    const videoId = item.dataset.videoId;
                    this.openYouTubeVideoModal(videoId);
                });
            });

        } catch (error) {
            console.warn('Failed to load YouTube interviews:', error);
            interviewsSection.style.display = 'none';
        }
    }

    openYouTubeVideoModal(videoId) {
        // Create modal if it doesn't exist
        let modal = document.getElementById('youtubeVideoModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'youtubeVideoModal';
            modal.className = 'youtube-video-modal';
            modal.innerHTML = `
                <div class="youtube-video-modal-content">
                    <button class="youtube-video-close" id="youtubeVideoClose">&times;</button>
                    <div class="youtube-video-container">
                        <iframe id="youtubeVideoIframe" 
                                frameborder="0" 
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
                                allowfullscreen>
                        </iframe>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            // Close button handler
            const closeBtn = document.getElementById('youtubeVideoClose');
            closeBtn.addEventListener('click', () => {
                this.closeYouTubeVideoModal();
            });

            // Close on background click
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeYouTubeVideoModal();
                }
            });

            // Close on Escape key
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && modal.style.display === 'flex') {
                    this.closeYouTubeVideoModal();
                }
            });
        }

        // Set video source and show modal
        const iframe = document.getElementById('youtubeVideoIframe');
        iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1`;
        modal.style.display = 'flex';
    }

    closeYouTubeVideoModal() {
        const modal = document.getElementById('youtubeVideoModal');
        const iframe = document.getElementById('youtubeVideoIframe');
        if (modal && iframe) {
            iframe.src = ''; // Stop video
            modal.style.display = 'none';
        }
    }

    filterActingRolesOnly(credits) {
        // Genre IDs to exclude for TV shows (talk shows, reality, news, game shows, etc.)
        const excludedTvGenreIds = [
            67,     // Talk Show
            10763,  // News
            10764,  // Reality
            10767,  // Game Show
            99,     // Documentary (for TV)
            10768   // War & Politics (often news/talk)
        ];

        // Genre IDs to exclude for movies (documentaries that aren't scripted)
        const excludedMovieGenreIds = [
            99      // Documentary (unless it's scripted, but we'll exclude all for safety)
        ];

        return credits.filter(credit => {
            // Must be movie or TV
            if (credit.media_type !== 'movie' && credit.media_type !== 'tv') {
                return false;
            }

            // Get character name (lowercase for checking)
            const character = (credit.character || '').toLowerCase();
            const title = (credit.title || credit.name || '').toLowerCase();

            // Exclude voice roles - check character name for voice-related terms
            // (but allow "himself"/"herself" as they might be valid scripted roles)
            const voiceIndicators = [
                '(voice)',
                '(voices)',
                'voice of',
                'narrator',
                'narration',
                'voice-over',
                'voiceover'
            ];

            // Check if character name explicitly indicates voice role
            if (voiceIndicators.some(indicator => character.includes(indicator))) {
                return false;
            }

            // Exclude if character is empty AND it's a TV show (TV shows should have character names)
            // Movies might sometimes have empty character, so be more lenient
            if (credit.media_type === 'tv' && (!character || character.trim() === '')) {
                return false;
            }

            // For TV shows, exclude "Himself"/"Herself" roles as they're usually talk shows/appearances
            // But allow for movies (might be scripted self-referential roles)
            if (credit.media_type === 'tv') {
                if (character === 'himself' || character === 'herself' || character === 'self') {
                    return false;
                }
            }

            // Check genre IDs if available
            const genreIds = credit.genre_ids || [];
            if (credit.media_type === 'tv') {
                // Exclude TV shows with excluded genres
                if (genreIds.some(id => excludedTvGenreIds.includes(id))) {
                    return false;
                }
            } else if (credit.media_type === 'movie') {
                // For movies, only exclude if it's purely documentary
                // (allow scripted content even if it has documentary genre)
                if (genreIds.includes(99) && genreIds.length === 1) {
                    return false;
                }
            }

            // Exclude certain title patterns (talk shows, news, awards, etc.)
            const excludedTitlePatterns = [
                'late night',
                'tonight show',
                'tonight with',
                'talk show',
                'morning show',
                'news',
                'reality',
                'game show',
                'variety show',
                'sketch comedy',
                'stand-up',
                'standup',
                // Awards shows
                'golden globe',
                'academy awards',
                'oscar',
                'emmy',
                'grammy',
                'tony awards',
                'bafta',
                'mtv movie',
                'mtv video',
                'screen actors guild',
                'sag awards',
                'people\'s choice',
                'critics choice',
                'critic\'s choice',
                'billboard music',
                'american music awards',
                'bet awards',
                'nickelodeon',
                'kids\' choice',
                'teen choice',
                'brit awards',
                'iheartradio',
                'cma awards',
                'country music association',
                'acm awards',
                'awards ceremony',
                'award show',
                'awards show'
            ];

            // Check if title suggests non-acting content
            if (excludedTitlePatterns.some(pattern => title.includes(pattern))) {
                return false;
            }

            // Additional check: exclude if it's a TV special or one-off appearance
            // (we want series and movies, not specials)
            if (credit.media_type === 'tv') {
                // Exclude TV movies that are actually specials (usually have very low episode counts)
                // But keep actual TV series
                // We'll keep all TV for now, but could filter by episode count if needed
            }

            // Keep the credit if it passes all filters
            return true;
        });
    }

    // ---------- SEARCH / SORT / FILTER ----------
    getFilteredItems(items = null) {
        const filteredItems = items || this.data.items.filter(item => item.type === this.currentTab);
        return this.applyFilters(filteredItems);
    }

    applyFilters(items) {
        let filteredItems = [...items];
        const searchTerm = document.getElementById('searchInput').value.toLowerCase();
        if (searchTerm) {
            filteredItems = filteredItems.filter(item =>
                (item.name && item.name.toLowerCase().includes(searchTerm)) ||
                (item.genre && item.genre.toLowerCase().includes(searchTerm)) ||
                (item.description && item.description.toLowerCase().includes(searchTerm))
            );
        }

        const genreFilter = document.getElementById('filterSelect').value;
        if (genreFilter) {
            filteredItems = filteredItems.filter(item =>
                item.genre && item.genre.toLowerCase().includes(genreFilter.toLowerCase())
            );
        }

        const sortValue = document.getElementById('sortSelect').value;
        const [field, direction] = sortValue.split('-');

        filteredItems.sort((a, b) => {
            let aVal = a[field], bVal = b[field];
            if (field === 'name') {
                aVal = (aVal || '').toLowerCase();
                bVal = (bVal || '').toLowerCase();
            } else if (field === 'myRank') {
                aVal = parseFloat(aVal) || 0;
                bVal = parseFloat(bVal) || 0;
            } else if (field === 'year' || field === 'userScore') {
                aVal = parseInt(aVal) || 0;
                bVal = parseInt(bVal) || 0;
            }
            return direction === 'asc' ? (aVal > bVal ? 1 : -1) : (aVal < bVal ? 1 : -1);
        });

        return filteredItems;
    }

    handleSearch() {
        if (this.currentView === 'insights') {
            return;
        }
        if (this.currentView === 'search') {
            // Don't filter search results on input - search is triggered by Enter only
            return;
        }
        if (this.currentView === 'sequels' && (this.sequelsViewSource === 'mal' || this.sequelsViewSource === 'steam' || this.sequelsViewSource === 'tmdb' || this.sequelsViewSource === 'collection')) {
            // Filter sequels results from any external source or collection
            this.filterSequelsResults();
        } else {
            this.renderLibrary();
        }
    }

    async performUniversalSearch(query, isDiscovery = false) {
        if (!isDiscovery && (!query || !query.trim())) {
            return;
        }

        // Hide all other views
        const homeView = document.getElementById('homeView');
        const libraryView = document.getElementById('libraryView');
        const sequelsView = document.getElementById('sequelsView');
        const collectionView = document.getElementById('collectionView');
        const insightsView = document.getElementById('insightsView');
        const detailView = document.getElementById('detailView');
        const searchView = document.getElementById('searchView');

        if (homeView) homeView.style.display = 'none';
        if (libraryView) libraryView.style.display = 'none';
        if (sequelsView) sequelsView.style.display = 'none';
        if (collectionView) collectionView.style.display = 'none';
        if (insightsView) insightsView.style.display = 'none';
        if (detailView) detailView.style.display = 'none';
        if (searchView) searchView.style.display = 'block';
        document.getElementById('searchInput').style.display = 'block';

        // Update current view
        this.currentView = 'search';

        // Populate Title/Name filter with the search query
        const titleFilter = document.getElementById('searchFilterTitle');
        if (titleFilter) {
            titleFilter.value = query;
        }

        // Show loading state
        document.getElementById('searchLoading').style.display = 'block';
        document.getElementById('searchError').style.display = 'none';
        document.getElementById('searchTitle').textContent = isDiscovery ? 'Destiny Results' : 'Search Results';
        document.getElementById('searchQuery').textContent = isDiscovery ? '(Filters Applied)' : `"${query}"`;

        // Hide all sections initially
        document.getElementById('searchMoviesSection').style.display = 'none';
        document.getElementById('searchTvSection').style.display = 'none';
        document.getElementById('searchAnimeSection').style.display = 'none';
        document.getElementById('searchGamesSection').style.display = 'none';
        document.getElementById('searchActorsSection').style.display = 'none';

        // Clear all grids
        document.getElementById('searchMoviesGrid').innerHTML = '';
        document.getElementById('searchTvGrid').innerHTML = '';
        document.getElementById('searchAnimeGrid').innerHTML = '';
        document.getElementById('searchGamesGrid').innerHTML = '';
        document.getElementById('searchActorsGrid').innerHTML = '';

        // Search all APIs in parallel
        const searchPromises = [];
        const category = this.searchCategory || 'all';

        // Search TMDB for movies
        if (category === 'all' || category === 'movies') {
            searchPromises.push(
                this.searchAPIForUniversal(query, 'movies', 'tmdb', isDiscovery)
                    .then(results => ({ type: 'movies', results }))
                    .catch(error => ({ type: 'movies', results: [], error }))
            );
        }

        // Search TMDB for TV
        if (category === 'all' || category === 'tv') {
            searchPromises.push(
                this.searchAPIForUniversal(query, 'tv', 'tmdb', isDiscovery)
                    .then(results => ({ type: 'tv', results }))
                    .catch(error => ({ type: 'tv', results: [], error }))
            );
        }

        // Search MAL for anime
        if ((category === 'all' || category === 'anime') && !isDiscovery) {
            searchPromises.push(
                this.searchAPIForUniversal(query, 'anime', 'mal')
                    .then(results => ({ type: 'anime', results }))
                    .catch(error => ({ type: 'anime', results: [], error }))
            );
        }

        // Search Steam/RAWG for games
        if ((category === 'all' || category === 'games') && !isDiscovery) {
            searchPromises.push(
                this.searchAPIForUniversal(query, 'games', 'rawg')
                    .then(results => ({ type: 'games', results }))
                    .catch(error => ({ type: 'games', results: [], error }))
            );
        }

        // Search TMDB for actors
        if ((category === 'all' || category === 'actors') && !isDiscovery) {
            searchPromises.push(
                this.searchAPIForUniversal(query, 'actors', 'tmdb')
                    .then(results => ({ type: 'actors', results }))
                    .catch(error => ({ type: 'actors', results: [], error }))
            );
        }

        try {
            const searchResults = await Promise.all(searchPromises);

            // Hide loading state
            document.getElementById('searchLoading').style.display = 'none';

            // Store all search results for filtering
            this.searchResults = {};
            searchResults.forEach(({ type, results, error }) => {
                if (error) {
                    console.warn(`Error searching ${type}:`, error);
                    this.searchResults[type] = [];
                    return;
                }
                this.searchResults[type] = results || [];
            });

            // Apply filters and render results (Title filter is already set from query)
            this.applySearchFilters();

            // Check if any results were found
            const hasResults = Object.values(this.searchResults).some(results => results && results.length > 0);
            if (!hasResults) {
                document.getElementById('searchTitle').textContent = 'No Results Found';
                document.getElementById('searchQuery').textContent = `"${query}"`;
            }
        } catch (error) {
            console.error('Error performing universal search:', error);
            document.getElementById('searchLoading').style.display = 'none';
            document.getElementById('searchError').style.display = 'block';
            document.getElementById('searchError').textContent = `Error: ${error.message}`;
        }
    }

    async searchAPIForUniversal(query, category, service, isDiscovery = false) {
        try {
            let url;
            if (isDiscovery) {
                // Construct discovery URL with filters
                const genre = document.getElementById('searchFilterGenre')?.value || '';
                const sort = document.getElementById('searchFilterSort')?.value || 'popularity.desc';
                const minVotes = document.getElementById('searchFilterVotes')?.value || '0';
                const minRating = document.getElementById('ratingRangeMin')?.value || '0';
                const maxRating = document.getElementById('ratingRangeMax')?.value || '100';

                const params = new URLSearchParams();
                params.append('type', category); // movies or tv
                if (genre) params.append('genre', genre);
                if (sort) params.append('sort', sort);
                if (minVotes && minVotes !== '0') params.append('min_votes', minVotes);
                if (minRating && minRating !== '0') params.append('min_rating', minRating);
                if (maxRating && maxRating !== '100') params.append('max_rating', maxRating);

                console.log('[Discovery] Calling API with params:', params.toString());
                url = `${API_URL}/api/discover?${params.toString()}`;
            } else {
                url = `${API_URL}/api/search?query=${encodeURIComponent(query)}&category=${category}&service=${service}`;
            }

            const response = await apiFetch(url);
            if (!response.ok) {
                throw new Error(`API error: ${response.statusText}`);
            }
            const data = await response.json();
            return data.results || [];
        } catch (error) {
            console.error(`Error searching ${category} (${service}):`, error);
            return [];
        }
    }

    renderSearchResults(type, results) {
        let sectionId, gridId;

        switch (type) {
            case 'movies':
                sectionId = 'searchMoviesSection';
                gridId = 'searchMoviesGrid';
                break;
            case 'tv':
                sectionId = 'searchTvSection';
                gridId = 'searchTvGrid';
                break;
            case 'anime':
                sectionId = 'searchAnimeSection';
                gridId = 'searchAnimeGrid';
                break;
            case 'games':
                sectionId = 'searchGamesSection';
                gridId = 'searchGamesGrid';
                break;
            case 'actors':
                sectionId = 'searchActorsSection';
                gridId = 'searchActorsGrid';
                break;
            default:
                return;
        }

        const section = document.getElementById(sectionId);
        const grid = document.getElementById(gridId);

        if (!section || !grid) return;

        // Show section
        section.style.display = 'block';
        grid.innerHTML = '';

        // Limit results to top 50 per category (increased for better filtering)
        const limitedResults = results.slice(0, 50);

        limitedResults.forEach(result => {
            const item = document.createElement('div');
            item.className = 'grid-item';

            // Get poster/image URL - try multiple fallbacks so TV items match movie behavior
            let posterUrl = '';
            // Collect candidate fields from various APIs/providers
            const posterCandidates = [
                result.poster_path,
                result.profile_path,
                result.poster,
                result.header_image,
                result.main_picture?.large,
                result.main_picture?.medium,
                result.backdrop_path
            ];

            const posterRaw = posterCandidates.find(p => p && p !== '');
            let tmdbPath = null;
            if (posterRaw) {
                // If the candidate is already a full URL, use it directly
                if (typeof posterRaw === 'string' && posterRaw.startsWith('http')) {
                    posterUrl = posterRaw;
                } else {
                    // Normalize to TMDB path if needed (ensure it starts with '/')
                    tmdbPath = String(posterRaw).startsWith('/') ? posterRaw : `/${posterRaw}`;
                    posterUrl = `${API_URL}/api/tmdb-image?url=${encodeURIComponent(`https://image.tmdb.org/t/p/w300${tmdbPath}`)}`;
                }
            }

            // Create image
            const img = document.createElement('img');
            img.src = posterUrl || 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjEwMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD4KPC9zdmc+';
            img.alt = result.title || result.name || 'Unknown';
            img.loading = 'lazy';

            // Create overlay with title
            const overlay = document.createElement('div');
            overlay.className = 'grid-item-overlay';
            const title = document.createElement('div');
            title.className = 'grid-item-title';
            title.textContent = result.title || result.name || 'Unknown';
            overlay.appendChild(title);

            // Add rating if available (Score Ring)
            if (result.vote_average) {
                // Normalize to 0-100 scale (TMDB uses 0-10, but API may return 0-100)
                let scoreValue = 0;
                if (result.vote_average > 10) {
                    // Already on 0-100 scale
                    scoreValue = Math.round(result.vote_average);
                } else {
                    // TMDB 0-10 scale, convert to 0-100
                    scoreValue = Math.round(result.vote_average * 10);
                }
                const ratingBadge = document.createElement('div');
                ratingBadge.className = 'home-item-rating';
                // Adjust positioning for search grid
                ratingBadge.style.bottom = '10px';
                ratingBadge.style.left = '10px';
                ratingBadge.style.zIndex = '5';

                const radius = 16;
                const circumference = 2 * Math.PI * radius;
                const strokeDashoffset = circumference - (scoreValue / 100) * circumference;

                let strokeColor = '#21d07a'; // Green for good scores (70+)
                let trackColor = 'rgba(33, 208, 122, 0.3)';
                if (scoreValue < 40) {
                    strokeColor = '#db2360'; // Red for bad scores
                    trackColor = 'rgba(219, 35, 96, 0.3)';
                } else if (scoreValue < 70) {
                    strokeColor = '#d2d531'; // Yellow for medium scores
                    trackColor = 'rgba(210, 213, 49, 0.3)';
                }

                ratingBadge.innerHTML = `
                <svg class="score-ring" viewBox="0 0 40 40">
                    <circle class="score-ring-bg" cx="20" cy="20" r="${radius}" 
                        fill="none" stroke="${trackColor}" stroke-width="3"/>
                    <circle class="score-ring-progress" cx="20" cy="20" r="${radius}" 
                        fill="none" stroke="${strokeColor}" stroke-width="3"
                        stroke-linecap="round"
                        stroke-dasharray="${circumference}"
                        stroke-dashoffset="${strokeDashoffset}"
                        transform="rotate(-90 20 20)"/>
                </svg>
                <span class="score-value">${scoreValue}<sup>%</sup></span>
            `;

                item.appendChild(ratingBadge);
            }
            item.appendChild(img);
            item.appendChild(overlay);

            // If proxying images fails (404/500), try the direct TMDB URL as a fallback to help diagnose proxy issues
            img.addEventListener('error', () => {
                try {
                    if (tmdbPath) {
                        const direct = `https://image.tmdb.org/t/p/w300${tmdbPath}`;
                        if (img.src !== direct) {
                            console.warn('Image proxy failed, falling back to direct TMDB URL for', tmdbPath);
                            img.src = direct;
                        }
                    } else if (posterRaw && typeof posterRaw === 'string' && posterRaw.startsWith('http')) {
                        // already a direct URL, nothing to do
                    } else {
                        // final fallback - use placeholder
                        img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjEwMCIgeT0iMTUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjY2IiBmb250LXNpemU9IjE0Ij5ObyBJbWFnZTwvdGV4dD4KPC9zdmc+';
                    }
                } catch (e) {
                    console.error('Error handling image fallback:', e);
                }
            });

            // Add click handler to open detail view
            item.addEventListener('click', async () => {
                const externalId = String(result.id);

                // First, check if this item exists in the library
                const libraryItem = this.data.items.find(libItem =>
                    libItem.type === type &&
                    libItem.externalApiId === externalId
                );

                if (libraryItem) {
                    // Use library item instead of API version
                    this.openDetailView(libraryItem, { source: 'search' });
                } else {
                    // Item not in library, fetch from API
                    const transientItem = await this.buildTransientItemFromExternal(type, externalId, {
                        name: result.title || result.name,
                        recommendation: result
                    });

                    if (transientItem) {
                        this.openDetailView(transientItem, { source: 'search' });
                    }
                }
            });

            grid.appendChild(item);
        });
    }

    applySearchFilters() {
        // Get filter values with null safety
        const filterType = document.getElementById('searchFilterType')?.value || '';
        const filterSort = document.getElementById('searchFilterSort')?.value || '';
        const filterTitle = (document.getElementById('searchFilterTitle')?.value || '').toLowerCase().trim();
        const filterGenre = (document.getElementById('searchFilterGenre')?.value || '').toLowerCase().trim();

        // Rating slider
        const filterRatingMin = parseInt(document.getElementById('ratingRangeMin')?.value) || 0;
        const filterRatingMax = parseInt(document.getElementById('ratingRangeMax')?.value) || 100;

        const filterDateStart = document.getElementById('searchFilterDateStart')?.value || '';
        const filterDateEnd = document.getElementById('searchFilterDateEnd')?.value || '';
        const runtimeStops = [0, 24, 60, 120, 240, 360];
        const runtimeMinIndex = parseInt(document.getElementById('runtimeRangeMin')?.value || '0');
        const runtimeMaxIndex = parseInt(document.getElementById('runtimeRangeMax')?.value || '5');
        const filterRuntimeMin = runtimeStops[runtimeMinIndex] || 0;
        const filterRuntimeMax = runtimeMaxIndex === 5 ? Infinity : (runtimeStops[runtimeMaxIndex] || Infinity);
        const filterEpisodesMinInput = document.getElementById('searchFilterEpisodesMin')?.value || '';
        const filterEpisodesMaxInput = document.getElementById('searchFilterEpisodesMax')?.value || '';
        const filterEpisodesMin = filterEpisodesMinInput ? parseInt(filterEpisodesMinInput) : 0;
        const filterEpisodesMax = filterEpisodesMaxInput ? parseInt(filterEpisodesMaxInput) : Infinity;

        // Minimum votes filter (dropdown now contains actual values)
        const filterVotesMin = parseInt(document.getElementById('searchFilterVotes')?.value || '0') || 0;

        const filterDeveloper = (document.getElementById('searchFilterDeveloper')?.value || '').toLowerCase().trim();

        // Filter results for each type
        this.filteredSearchResults = {};

        Object.keys(this.searchResults).forEach(type => {
            // Filter by type if specified
            if (filterType && type !== filterType) {
                this.filteredSearchResults[type] = [];
                return;
            }

            let filtered = this.searchResults[type].filter(result => {
                // Filter by title/name
                if (filterTitle) {
                    const title = (result.title || result.name || '').toLowerCase();
                    if (!title.includes(filterTitle)) {
                        return false;
                    }
                }

                // Filter by genre (check multiple possible field names)
                // Only filter if we have genre data to check against
                if (filterGenre) {
                    const genres = result.genres || result.genre || result.genre_names || null;
                    console.log(`[GenreFilter] "${result.title || result.name}" (${type}):`, {
                        filterGenre,
                        hasGenres: !!genres,
                        genresField: result.genres,
                        genreField: result.genre,
                        genreNamesField: result.genre_names,
                        allKeys: Object.keys(result)
                    });
                    // If no genre data available, don't filter by genre (pass through)
                    if (genres) {
                        let genreString = '';
                        if (Array.isArray(genres)) {
                            genreString = genres.map(g => (typeof g === 'object' ? (g.name || '') : String(g))).join(' ').toLowerCase();
                        } else if (typeof genres === 'string') {
                            genreString = genres.toLowerCase();
                        }
                        console.log(`[GenreFilter] genreString: "${genreString}", includes "${filterGenre}": ${genreString.includes(filterGenre)}`);
                        // Only filter if we got a non-empty genre string
                        if (genreString && !genreString.includes(filterGenre)) {
                            return false;
                        }
                    }
                    // If no genres field, skip genre filtering for this result
                }

                // Filter by rating (normalize to 0-100 scale)
                // Only apply rating filter if slider is not at default values (0-100)
                const isRatingFilterActive = filterRatingMin > 0 || filterRatingMax < 100;
                if (isRatingFilterActive) {
                    let rating = result.vote_average || 0;
                    // If rating is on 0-10 scale, convert to 0-100
                    if (rating > 0 && rating <= 10) {
                        rating = rating * 10;
                    }
                    if (rating < filterRatingMin || rating > filterRatingMax) {
                        return false;
                    }
                }

                // Filter by release date range
                if (filterDateStart || filterDateEnd) {
                    const releaseDate = result.release_date || result.first_air_date || '';
                    if (releaseDate) {
                        try {
                            const itemDate = new Date(releaseDate);
                            if (isNaN(itemDate.getTime())) {
                                return false; // Invalid date
                            }
                            // Set time to midnight for accurate comparison
                            itemDate.setHours(0, 0, 0, 0);

                            if (filterDateStart) {
                                const startDate = new Date(filterDateStart);
                                startDate.setHours(0, 0, 0, 0);
                                if (itemDate < startDate) return false;
                            }

                            if (filterDateEnd) {
                                const endDate = new Date(filterDateEnd);
                                endDate.setHours(0, 0, 0, 0);
                                if (itemDate > endDate) return false;
                            }
                        } catch (e) {
                            // Ignore date parse errors
                        }
                    } else if (filterDateStart || filterDateEnd) {
                        // If filtering by date but item has no date, exclude it?
                        // Usually yes.
                        return false;
                    }
                }

                // Filter by runtime
                if (filterRuntimeMin > 0 || filterRuntimeMax < Infinity) {
                    if (type === 'movies') {
                        const runtime = result.runtime || 0;
                        if (runtime < filterRuntimeMin || runtime > filterRuntimeMax) return false;
                    }
                }

                // Filter by episodes
                if (filterEpisodesMin > 0 || filterEpisodesMax < Infinity) {
                    if (type === 'tv' || type === 'anime') {
                        const episodes = result.number_of_episodes || result.episodes || result.num_episodes || 0;
                        if (episodes < filterEpisodesMin || episodes > filterEpisodesMax) return false;
                    }
                }

                // Filter by User Votes (TMDB: vote_count, MAL: num_scoring_users, members, num_list_users)
                if (filterVotesMin > 0) {
                    // Check multiple possible vote count fields from different APIs
                    const votes = result.vote_count  // TMDB
                        || result.num_scoring_users  // MAL
                        || result.members            // MAL (members who have the item in their list)
                        || result.num_list_users     // MAL (alternative field)
                        || result.ratings_count      // Generic
                        || result.popularity         // Fallback to popularity for games
                        || 0;
                    console.log(`[VotesFilter] "${result.title || result.name}": votes=${votes}, filterMin=${filterVotesMin}, pass=${votes >= filterVotesMin}`);
                    if (votes < filterVotesMin) return false;
                }

                // Filter by Developer/Studio
                if (filterDeveloper) {
                    let dev = '';
                    if (type === 'games') {
                        dev = result.developers?.map(d => d.name || d).join(' ') || '';
                    } else if (type === 'anime') {
                        dev = result.studios?.map(s => s.name || s).join(' ') || '';
                    }
                    if (dev && !dev.toLowerCase().includes(filterDeveloper)) return false;
                }

                return true;
            });

            // Sort results
            if (filterSort) {
                const [sortField, sortDir] = filterSort.split('.');
                const isDesc = sortDir === 'desc';

                filtered.sort((a, b) => {
                    let valA, valB;

                    if (sortField === 'popularity') {
                        valA = a.popularity || a.members || 0;
                        valB = b.popularity || b.members || 0;
                    } else if (sortField === 'rating') {
                        valA = a.vote_average || a.score || a.rating || 0;
                        valB = b.vote_average || b.score || b.rating || 0;
                    } else if (sortField === 'date') {
                        valA = a.release_date || a.first_air_date || a.start_date || a.released || '';
                        valB = b.release_date || b.first_air_date || b.start_date || b.released || '';
                        // String comparison for ISO dates works
                    } else if (sortField === 'title') {
                        valA = (a.title || a.name || '').toLowerCase();
                        valB = (b.title || b.name || '').toLowerCase();
                    }

                    if (valA < valB) return isDesc ? 1 : -1;
                    if (valA > valB) return isDesc ? -1 : 1;
                    return 0;
                });
            }

            this.filteredSearchResults[type] = filtered;
            this.renderSearchResults(type, filtered);
        });
    }

    getSearchFilterValues() {
        return {
            type: document.getElementById('searchFilterType').value,
            title: document.getElementById('searchFilterTitle').value,
            genre: document.getElementById('searchFilterGenre').value,
            ratingMin: document.getElementById('ratingRangeMin').value,
            ratingMax: document.getElementById('ratingRangeMax').value,
            dateStart: document.getElementById('searchFilterDateStart').value,
            dateEnd: document.getElementById('searchFilterDateEnd').value,
            runtimeMinIdx: document.getElementById('runtimeRangeMin').value,
            runtimeMaxIdx: document.getElementById('runtimeRangeMax').value,
            episodesMin: document.getElementById('searchFilterEpisodesMin').value,
            episodesMax: document.getElementById('searchFilterEpisodesMax').value,
            votes: document.getElementById('searchFilterVotes').value,
            developer: document.getElementById('searchFilterDeveloper').value
        };
    }

    setSearchFilterValues(filterValues) {
        if (!filterValues) return;
        const select = document.getElementById('searchFilterType');
        select.value = filterValues.type || '';
        // Update custom dropdown display
        const wrapper = select?.closest('.search-filter-select-wrapper');
        const displayButton = wrapper?.querySelector('button.search-filter-select');
        if (displayButton) {
            displayButton.textContent = select.options[select.selectedIndex].text;
        }
        // Update selected state in custom menu
        const menu = document.getElementById('searchFilterTypeMenu');
        if (menu) {
            menu.querySelectorAll('.search-filter-select-option').forEach(opt => {
                if (opt.dataset.value === select.value) {
                    opt.classList.add('selected');
                } else {
                    opt.classList.remove('selected');
                }
            });
        }
        document.getElementById('searchFilterTitle').value = filterValues.title || '';

        // Restore genre tags
        const genreInput = document.getElementById('searchFilterGenre');
        if (genreInput) genreInput.value = filterValues.genre || '';
        const activeGenres = (filterValues.genre || '').split(',').map(s => s.trim().toLowerCase());
        document.querySelectorAll('.genre-tag').forEach(tag => {
            if (activeGenres.includes(tag.dataset.value.toLowerCase())) {
                tag.classList.add('active');
            } else {
                tag.classList.remove('active');
            }
        });

        const ratingMin = document.getElementById('ratingRangeMin');
        const ratingMax = document.getElementById('ratingRangeMax');
        if (ratingMin && ratingMax) {
            ratingMin.value = filterValues.ratingMin || '0';
            ratingMax.value = filterValues.ratingMax || '100';
            // Trigger update
            ratingMin.dispatchEvent(new Event('input'));
        }

        document.getElementById('searchFilterDateStart').value = filterValues.dateStart || '';
        document.getElementById('searchFilterDateEnd').value = filterValues.dateEnd || '';

        const rMin = document.getElementById('runtimeRangeMin');
        const rMax = document.getElementById('runtimeRangeMax');
        if (rMin && rMax) {
            rMin.value = filterValues.runtimeMinIdx || '0';
            rMax.value = filterValues.runtimeMaxIdx || '5';
            // Trigger update for visuals
            rMin.dispatchEvent(new Event('input'));
        }

        document.getElementById('searchFilterEpisodesMin').value = filterValues.episodesMin || '';
        document.getElementById('searchFilterEpisodesMax').value = filterValues.episodesMax || '';

        const votesDropdown = document.getElementById('searchFilterVotes');
        if (votesDropdown) {
            votesDropdown.value = filterValues.votes || '0';
        }

        document.getElementById('searchFilterDeveloper').value = filterValues.developer || '';
    }

    restoreSearchView() {
        if (!this.searchState) return;

        // Restore search query
        document.getElementById('searchQuery').textContent = `"${this.searchState.query}"`;

        // Restore search results
        this.searchResults = { ...this.searchState.results };
        this.filteredSearchResults = { ...this.searchState.filteredResults };

        // Restore filter values
        this.setSearchFilterValues(this.searchState.filterValues);

        // Show search view
        const searchView = document.getElementById('searchView');
        const detailView = document.getElementById('detailView');
        if (searchView && detailView) {
            searchView.style.display = 'block';
            detailView.style.display = 'none';
            this.currentView = 'search';

            // Show controls and tabs
            const controlsRow = document.querySelector('.controls-row');
            const tabsRow = document.querySelector('.tabs-row');
            if (controlsRow) controlsRow.classList.remove('hidden');
            if (tabsRow) tabsRow.classList.remove('hidden');
            document.getElementById('searchInput').style.display = 'block';
            document.getElementById('settingsBtn').style.display = 'inline-block';
            const backBtnEl = document.getElementById('backBtn');
            if (backBtnEl) backBtnEl.style.display = 'none';

            // Re-render filtered results
            this.applySearchFilters();
        }
    }

    setupCustomTypeDropdown() {
        const select = document.getElementById('searchFilterType');
        const menu = document.getElementById('searchFilterTypeMenu');
        const wrapper = select?.closest('.search-filter-select-wrapper');

        if (!select || !menu || !wrapper) {
            console.warn('Custom dropdown setup: elements not found', { select: !!select, menu: !!menu, wrapper: !!wrapper });
            return;
        }

        // Hide native select visually but keep it functional for form submission
        select.style.position = 'absolute';
        select.style.opacity = '0';
        select.style.width = '1px';
        select.style.height = '1px';
        select.style.pointerEvents = 'none';
        select.style.zIndex = '-1';
        select.style.left = '-9999px';

        // Remove any existing button to avoid duplicates
        const existingButton = wrapper.querySelector('button.search-filter-select');
        if (existingButton && existingButton !== select) {
            existingButton.remove();
        }

        // Create a visible button that shows the current value
        const displayButton = document.createElement('button');
        displayButton.type = 'button';
        displayButton.className = 'search-filter-select';
        displayButton.style.width = '100%';
        displayButton.style.textAlign = 'left';
        displayButton.style.cursor = 'pointer';
        wrapper.insertBefore(displayButton, select);

        // Update display button when select changes
        const updateDisplay = () => {
            const selectedOption = select.options[select.selectedIndex];
            displayButton.textContent = selectedOption ? selectedOption.text : 'All Types';
            // Update selected state in custom menu
            menu.querySelectorAll('.search-filter-select-option').forEach(opt => {
                if (opt.dataset.value === select.value) {
                    opt.classList.add('selected');
                } else {
                    opt.classList.remove('selected');
                }
            });
        };

        // Toggle menu on button click
        const handleButtonClick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isOpen = menu.classList.contains('show');
            if (isOpen) {
                menu.classList.remove('show');
            } else {
                // Close other dropdowns
                document.querySelectorAll('.search-filter-select-menu.show').forEach(m => {
                    if (m !== menu) m.classList.remove('show');
                });
                menu.classList.add('show');
            }
        };

        displayButton.addEventListener('click', handleButtonClick);

        // Handle option clicks
        const options = menu.querySelectorAll('.search-filter-select-option');
        options.forEach(option => {
            // Remove any existing listeners by cloning
            const newOption = option.cloneNode(true);
            option.parentNode.replaceChild(newOption, option);

            newOption.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const value = newOption.dataset.value || '';
                select.value = value;

                // Trigger change event on select
                const changeEvent = new Event('change', { bubbles: true });
                select.dispatchEvent(changeEvent);

                updateDisplay();
                menu.classList.remove('show');
            });
        });

        // Close menu when clicking outside - use a separate handler
        const handleOutsideClick = (e) => {
            if (!wrapper.contains(e.target) && !menu.contains(e.target)) {
                menu.classList.remove('show');
            }
        };

        // Use capture phase to ensure it runs before other handlers
        document.addEventListener('click', handleOutsideClick, true);

        // Update selected state on initial load
        updateDisplay();

        // Listen for programmatic changes to select
        select.addEventListener('change', updateDisplay);
    }

    resetSearchFilters() {
        // Reset all filter inputs
        const select = document.getElementById('searchFilterType');
        select.value = '';
        // Update custom dropdown display
        const wrapper = select?.closest('.search-filter-select-wrapper');
        const displayButton = wrapper?.querySelector('button.search-filter-select');
        if (displayButton) {
            displayButton.textContent = select.options[select.selectedIndex].text;
        }
        document.getElementById('searchFilterTitle').value = '';
        document.getElementById('searchFilterGenre').value = '';

        const ratingMin = document.getElementById('ratingRangeMin');
        const ratingMax = document.getElementById('ratingRangeMax');
        if (ratingMin) ratingMin.value = '0';
        if (ratingMax) ratingMax.value = '100';
        if (ratingMin) ratingMin.dispatchEvent(new Event('input'));

        document.getElementById('searchFilterDateStart').value = '';
        document.getElementById('searchFilterDateEnd').value = '';
        const rMin = document.getElementById('runtimeRangeMin');
        const rMax = document.getElementById('runtimeRangeMax');
        if (rMin) rMin.value = '0';
        if (rMax) rMax.value = '5';
        if (rMin) rMin.dispatchEvent(new Event('input'));
        document.getElementById('searchFilterEpisodesMin').value = '';
        document.getElementById('searchFilterEpisodesMax').value = '';

        const votesDropdown = document.getElementById('searchFilterVotes');
        if (votesDropdown) {
            votesDropdown.value = '0';
        }

        document.getElementById('searchFilterDeveloper').value = '';

        // Re-render all original results
        Object.keys(this.searchResults).forEach(type => {
            const results = this.searchResults[type];
            if (results && results.length > 0) {
                this.renderSearchResults(type, results);
            }
        });
    }

    filterSequelsResults() {
        const searchTerm = document.getElementById('searchInput').value.toLowerCase().trim();
        const container = document.getElementById('sequelsGridContainer');
        container.innerHTML = '';

        let itemsInLibrary = 0;
        let filteredItems = [];

        if (searchTerm === '') {
            // Show all items
            filteredItems = this.currentSequelsResults;
        } else {
            // Filter by search term
            filteredItems = this.currentSequelsResults.filter(item => {
                const name = (item.name || '').toLowerCase();
                return name.includes(searchTerm);
            });
        }

        // Count items in library and render
        filteredItems.forEach(item => {
            if (this.isItemInLibrary(item)) {
                itemsInLibrary++;
            }
            container.appendChild(this.createGridItem(item, { onlyLibraryItems: true }));
        });

        // Update title with filtered count and completion percentage
        const totalCount = filteredItems.length;
        const completionPercentage = totalCount > 0 ? Math.round((itemsInLibrary / totalCount) * 100) : 0;

        // Get display name based on item type and source
        let displayName = '';
        if (this.sequelsViewSourceItem) {
            if (this.sequelsViewSource === 'tmdb') {
                // For TMDB, just use the item name (we show exact matches or collections, not base name matches)
                displayName = this.sequelsViewSourceItem.name || '';
            } else if (this.sequelsViewSourceItem.type === 'anime') {
                displayName = this.extractBaseAnimeName(this.sequelsViewSourceItem.name || '');
            } else if (this.sequelsViewSourceItem.type === 'games') {
                displayName = this.extractBaseGameName(this.sequelsViewSourceItem.name || '');
            } else {
                displayName = this.extractBaseMovieSeriesName(this.sequelsViewSourceItem.name || '');
            }
        }

        // Get source label
        let sourceLabel = '';
        if (this.sequelsViewSource === 'mal') {
            sourceLabel = 'MAL';
        } else if (this.sequelsViewSource === 'steam') {
            sourceLabel = 'Steam';
        } else if (this.sequelsViewSource === 'tmdb') {
            sourceLabel = 'TMDB';
        } else if (this.sequelsViewSource === 'collection') {
            // For collection, find the collection name
            const collection = this.collections.find(c =>
                c.itemIds && c.itemIds.includes(this.sequelsViewSourceItem?.id)
            );
            if (collection) {
                sourceLabel = collection.name;
                displayName = ''; // Collection name is the title, not item name
            } else {
                sourceLabel = 'Collection';
            }
        }

        // Update title separately from count and completion rate
        if (this.sequelsViewSource === 'collection') {
            // For collection, show just the collection name
            document.getElementById('sequelsTitle').textContent = `${sourceLabel}${searchTerm ? ` matching "${searchTerm}"` : ''}`;
        } else {
            document.getElementById('sequelsTitle').textContent = `${displayName}${searchTerm ? ` matching "${searchTerm}"` : ''}${sourceLabel ? ` from ${sourceLabel}` : ''}`;
        }

        // Update item count (bottom right)
        const itemCountText = `${totalCount} ${totalCount === 1 ? (this.sequelsViewSource === 'collection' ? 'item' : 'result') : (this.sequelsViewSource === 'collection' ? 'items' : 'results')}`;
        document.getElementById('sequelsItemCount').textContent = itemCountText;

        // Update completion rate (top right) - only show for non-collection views
        if (this.sequelsViewSource === 'collection') {
            document.getElementById('sequelsCompletionRate').textContent = '';
        } else {
            document.getElementById('sequelsCompletionRate').textContent = `${completionPercentage}% Complete`;
        }
    }
    handleSort() { this.renderLibrary(); }
    handleFilter() {
        const filterLabel = document.getElementById('filterLabel');
        const filterValue = document.getElementById('filterSelect').value;

        if (filterLabel) {
            if (filterValue) {
                filterLabel.textContent = `Filter: ${filterValue}`;
            } else {
                filterLabel.textContent = '';
            }
        }

        this.renderLibrary();
    }

    updateFilterOptions() {
        const filterSelect = document.getElementById('filterSelect');
        const filterMenu = document.getElementById('filterMenu');
        const currentValue = filterSelect.value;

        const genres = [...new Set(
            this.data.items
                .filter(item => item.type === this.currentTab && item.genre)
                .flatMap(item => item.genre.split(',').map(g => g.trim()))
        )].sort();

        filterSelect.innerHTML = '<option value="">All Genres</option>';
        filterMenu.innerHTML = '<button class="menu-option" data-value="">All Genres</button>';

        genres.forEach(genre => {
            const opt = document.createElement('option');
            opt.value = genre;
            opt.textContent = genre;
            if (genre === currentValue) opt.selected = true;
            filterSelect.appendChild(opt);

            const btn = document.createElement('button');
            btn.className = 'menu-option';
            btn.dataset.value = genre;
            btn.textContent = genre;
            filterMenu.appendChild(btn);
        });

        // Re-attach filter menu event listeners
        document.querySelectorAll('#filterMenu .menu-option').forEach(option => {
            option.addEventListener('click', (e) => {
                const value = e.target.dataset.value;
                document.getElementById('filterSelect').value = value;
                this.handleFilter();
                this.toggleFilterMenu();
            });
        });
    }

    // ---------- ADD / EDIT / DELETE ----------
    toggleAddMenu() {
        const menu = document.getElementById('addMenu');
        if (!menu) return;
        const isOpening = !menu.classList.contains('show');
        menu.classList.toggle('show');
        menu.style.display = menu.classList.contains('show') ? 'block' : 'none';

        // Hide scroll-to-top button when menu is open (mobile)
        const scrollBtn = document.querySelector('.scroll-top-btn');
        if (scrollBtn) {
            scrollBtn.style.display = menu.classList.contains('show') ? 'none' : '';
        }

        if (isOpening) {
            this.resetItemForm();
            this.showManualTab();
        }
    }
    closeAddMenu() {
        const menu = document.getElementById('addMenu');
        if (!menu) return;
        menu.classList.remove('show');
        menu.style.display = 'none';
        this.resetItemForm();
    }

    resetItemForm() {
        this.selectedLinkedMovies = [];
        document.getElementById('itemForm').reset();
        document.getElementById('itemExternalApiId').value = '';
        document.getElementById('posterPreview').innerHTML = '';
        document.getElementById('bannerPreview').innerHTML = '';
        this.setFormStarRating(0);

        // Explicitly clear collection fields to prevent reuse
        document.getElementById('itemCollection').value = '';
        document.getElementById('itemCollectionSearch').value = '';
        document.getElementById('collectionSearchResults').innerHTML = '';
        const rolesInput = document.getElementById('itemRoles');
        if (rolesInput) rolesInput.value = '';

        // Remove auto-match notification
        const collectionGroup = document.getElementById('collectionGroup');
        if (collectionGroup) {
            const notification = collectionGroup.querySelector('.collection-auto-match-notification');
            if (notification) {
                notification.remove();
            }
        }

        this.updateFormFieldsByTab();
        this.renderSelectedLinkedMovies();
    }

    updateFormFieldsByTab() {
        const isActorTab = this.currentTab === 'actors';

        // Hide/show standard fields for actors
        document.getElementById('yearGroup').style.display = isActorTab ? 'none' : 'block';
        const runtimeGroup = document.getElementById('runtimeGroup');
        if (runtimeGroup) runtimeGroup.style.display = (!isActorTab && this.currentTab === 'movies') ? 'block' : 'none';
        const episodeCountGroup = document.getElementById('episodeCountGroup');
        if (episodeCountGroup) episodeCountGroup.style.display = (!isActorTab && (this.currentTab === 'tv' || this.currentTab === 'anime')) ? 'block' : 'none';
        const episodeDurationGroup = document.getElementById('episodeDurationGroup');
        if (episodeDurationGroup) episodeDurationGroup.style.display = (!isActorTab && (this.currentTab === 'tv' || this.currentTab === 'anime')) ? 'block' : 'none';
        document.getElementById('genreGroup').style.display = isActorTab ? 'none' : 'block';
        document.getElementById('scoreGroup').style.display = isActorTab ? 'none' : 'block';
        const timeToBeatGroup = document.getElementById('timeToBeatGroup');
        if (timeToBeatGroup) timeToBeatGroup.style.display = (!isActorTab && this.currentTab === 'games') ? 'block' : 'none';
        document.getElementById('descriptionGroup').style.display = isActorTab ? 'none' : 'block';
        document.getElementById('rankGroup').style.display = isActorTab ? 'none' : 'block';

        // Show/hide actor-specific fields
        document.querySelectorAll('.actor-field').forEach(field => {
            field.style.display = isActorTab ? 'block' : 'none';
        });
        const collectionGroup = document.getElementById('collectionGroup');
        if (collectionGroup) {
            collectionGroup.style.display = isActorTab ? 'none' : 'block';
        }
        const rolesGroup = document.getElementById('rolesGroup');
        if (rolesGroup) {
            rolesGroup.style.display = isActorTab ? 'block' : 'none';
        }

        // Show/hide anime-specific fields (Studio)
        document.getElementById('studioGroup').style.display = this.currentTab === 'anime' ? 'block' : 'none';

        // Show/hide games-specific fields (Developer)
        document.getElementById('developerGroup').style.display = this.currentTab === 'games' ? 'block' : 'none';

        // Show/hide TV/Movies-specific fields (Director/Creator)
        document.getElementById('directorCreatorGroup').style.display = (this.currentTab === 'tv' || this.currentTab === 'movies') ? 'block' : 'none';
    }

    toggleSortMenu() { document.getElementById('sortMenu').classList.toggle('show'); }
    closeSortMenu() { document.getElementById('sortMenu').classList.remove('show'); }

    toggleFilterMenu() { document.getElementById('filterMenu').classList.toggle('show'); }
    closeFilterMenu() { document.getElementById('filterMenu').classList.remove('show'); }

    updateCollectionsToggleUI() {
        const btn = document.getElementById('collectionsBtn');
        if (!btn) return;
        if (this.showCollectionsInLibrary) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    }

    toggleCollectionsInLibrary() {
        this.showCollectionsInLibrary = !this.showCollectionsInLibrary;
        try {
            // Collections toggle state managed in GitHub only
        } catch (storageError) {
            console.warn('Failed to persist collections toggle preference:', storageError);
        }
        this.updateCollectionsToggleUI();
        this.renderLibrary();
    }

    toggleWatchlistView() {
        this.showWatchlistInLibrary = !this.showWatchlistInLibrary;
        try {
            // Watchlist toggle state managed in GitHub only
        } catch (storageError) {
            console.warn('Failed to persist watchlist toggle preference:', storageError);
        }
        this.updateWatchlistToggleUI();
        this.renderLibrary();
    }

    updateWatchlistToggleUI() {
        const btn = document.getElementById('watchlistToggleBtn');
        if (!btn) return;
        if (this.showWatchlistInLibrary) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    }

    toggleSettingsMenu() { document.getElementById('settingsMenu').classList.toggle('show'); }
    closeSettingsMenu() { document.getElementById('settingsMenu').classList.remove('show'); }

    showManualTab() {
        document.getElementById('manualFormContainer').style.display = 'block';
        document.getElementById('apiFormContainer').style.display = 'none';
        document.getElementById('manualTab').classList.add('active');
        document.getElementById('apiTab').classList.remove('active');
    }

    showApiTab() {
        document.getElementById('manualFormContainer').style.display = 'none';
        document.getElementById('apiFormContainer').style.display = 'block';
        document.getElementById('manualTab').classList.remove('active');
        document.getElementById('apiTab').classList.add('active');

        // Show actor search tabs for actors tab
        const isActorsTab = this.currentTab === 'actors';
        const actorSearchTabs = document.getElementById('actorSearchTabs');
        if (actorSearchTabs) {
            actorSearchTabs.style.display = isActorsTab ? 'flex' : 'none';
        }

        // Show Spotify search for actors, regular API search for others
        const spotifySection = document.getElementById('spotifySearchSection');
        const regularSection = document.getElementById('regularApiSearchSection');

        if (spotifySection && regularSection) {
            if (isActorsTab) {
                spotifySection.style.display = 'block';
                regularSection.style.display = 'none';
            } else {
                spotifySection.style.display = 'none';
                regularSection.style.display = 'block';
            }
        }
    }

    // ✅ Save (add or edit) + persist to DB
    async saveItem() {
        const itemType = this.currentTab;
        const isActor = itemType === 'actors';
        const descriptionValue = this.truncateActorDescription(itemType, document.getElementById('itemDescription').value);
        const biographyValue = this.truncateActorDescription(itemType, document.getElementById('itemBiography')?.value || '');
        const item = {
            id: Date.now().toString(),
            type: itemType,
            name: document.getElementById('itemName').value,
            year: document.getElementById('itemYear').value,
            genre: document.getElementById('itemGenre').value,
            userScore: parseFloat(document.getElementById('itemUserScore').value) || 0,
            description: descriptionValue,
            myRank: isActor ? 0 : this.getFormStarRating(), // Actors don't have ranks
            posterBase64: this.getImagePreview('posterPreview'),
            bannerBase64: this.getImagePreview('bannerPreview'),
            socialMedia: document.getElementById('itemSocialMedia')?.value || '',
            biography: biographyValue,
            linkedMovies: this.selectedLinkedMovies.map(m => m.id).join(','),
            externalApiId: document.getElementById('itemExternalApiId').value || '',
            source: document.getElementById('itemExternalApiId')?.dataset?.source || (this.actorSearchSource === 'spotify' && this.currentTab === 'actors' ? 'spotify' : 'tmdb'),
            studio: this.currentTab === 'anime' ? document.getElementById('itemStudio')?.value || '' : '',
            developer: this.currentTab === 'games' ? document.getElementById('itemDeveloper')?.value || '' : '',
            directorCreator: (this.currentTab === 'tv' || this.currentTab === 'movies') ? document.getElementById('itemDirectorCreator')?.value || '' : '',
            runtime: this.currentTab === 'movies' ? document.getElementById('itemRuntimeMinutesHidden')?.value || '' : '',
            episodes: (this.currentTab === 'tv' || this.currentTab === 'anime') ? document.getElementById('itemEpisodeCountHidden')?.value || '' : '',
            episodeRuntime: (this.currentTab === 'tv' || this.currentTab === 'anime') ? document.getElementById('itemEpisodeRuntimeMinutesHidden')?.value || '' : '',
            timeToBeat: this.currentTab === 'games' ? document.getElementById('itemTimeToBeatAverageHidden')?.value || '' : ''
        };

        // Debug logging for Studio/Developer/DirectorCreator
        console.log('💾 Saving item - Form values:', {
            currentTab: this.currentTab,
            studio: item.studio,
            developer: item.developer,
            directorCreator: item.directorCreator,
            studioFieldValue: this.currentTab === 'anime' ? document.getElementById('itemStudio')?.value : 'N/A',
            developerFieldValue: this.currentTab === 'games' ? document.getElementById('itemDeveloper')?.value : 'N/A',
            directorCreatorFieldValue: (this.currentTab === 'tv' || this.currentTab === 'movies') ? document.getElementById('itemDirectorCreator')?.value : 'N/A'
        });

        if (!item.name.trim()) {
            alert('Name is required');
            return;
        }

        if (isActor) {
            const rolesInput = document.getElementById('itemRoles');
            const rolesValue = rolesInput ? rolesInput.value : '';
            item.actorRoles = this.normalizeActorRolesInput(rolesValue || item.genre || item.description || 'Actor');
            if (!item.actorRoles.length) {
                item.actorRoles = ['Actor'];
            }
            item.genre = item.actorRoles.join(', ');
            if (rolesInput) {
                rolesInput.value = item.genre;
            }
        }

        // Handle collection assignment - save the ID for later use
        let selectedCollectionId = document.getElementById('itemCollection').value?.trim();
        const selectedCollectionName = document.getElementById('itemCollectionSearch').value?.trim();

        // If ID is missing but name is provided, try to find collection by name
        if (!selectedCollectionId && selectedCollectionName) {
            console.log(`🔍 Collection ID not set, searching by name: "${selectedCollectionName}"`);
            let foundCollection = this.collections.find(c =>
                c.name && c.name.toLowerCase() === selectedCollectionName.toLowerCase()
            );

            // If not found in current list, reload collections from DB and try again
            if (!foundCollection) {
                console.log(`⚠️ Collection not found in current list, reloading from DB...`);
                await this.loadCollectionsFromDB();
                foundCollection = this.collections.find(c =>
                    c.name && c.name.toLowerCase() === selectedCollectionName.toLowerCase()
                );
            }

            if (foundCollection) {
                selectedCollectionId = foundCollection.id;
                console.log(`✅ Found collection by name: "${selectedCollectionName}" -> ID: ${selectedCollectionId}`);
                // Update the hidden field for consistency
                document.getElementById('itemCollection').value = selectedCollectionId;
            } else {
                console.log(`⚠️ Collection "${selectedCollectionName}" not found. Will create it after saving item.`);
            }
        }

        if (selectedCollectionId) {
            console.log(`📝 Form submitted with collection: ID="${selectedCollectionId}", Name="${selectedCollectionName}"`);
        } else if (selectedCollectionName) {
            console.log(`📝 Form submitted with collection name but no ID: "${selectedCollectionName}"`);
        } else {
            console.log(`📝 Form submitted without collection selection`);
        }

        // If this is a Spotify-sourced artist (robust detection), always try to fetch and persist TMDB biography
        const formSocial = document.getElementById('itemSocialMedia')?.value || '';
        const isSpotifySave = item.type === 'actors' && (
            item.source === 'spotify' ||
            (item.externalApiId && !/^[0-9]+$/.test(String(item.externalApiId))) ||
            String(item.externalApiId).includes('open.spotify.com') ||
            (formSocial && formSocial.toLowerCase().includes('spotify')) ||
            (item.socialMedia && String(item.socialMedia).toLowerCase().includes('spotify'))
        );

        // If saving a Spotify-sourced artist, force role to Singer regardless of form input
        if (isSpotifySave && item.type === 'actors') {
            item.actorRoles = ['Singer'];
            item.genre = item.actorRoles.join(', ');
            const rolesInputAfter = document.getElementById('itemRoles');
            if (rolesInputAfter) rolesInputAfter.value = item.genre;
        }

        if (isSpotifySave) {
            try {
                const nameToSearch = item.name || '';
                if (nameToSearch) {
                    const searchResp = await apiFetch(`${API_URL}/api/search?query=${encodeURIComponent(nameToSearch)}&category=actors&service=tmdb`);
                    if (searchResp.ok) {
                        const searchData = await searchResp.json();
                        const first = (searchData.results && searchData.results.length) ? searchData.results[0] : null;
                        if (first && first.id) {
                            const personResp = await apiFetch(`${API_URL}/api/person/${first.id}`);
                            if (personResp.ok) {
                                const personData = await personResp.json();
                                if (personData && personData.biography && personData.biography.trim()) {
                                    // Override biography with TMDB biography (store truncated version)
                                    item.biography = this.truncateActorDescription('actors', personData.biography.trim());
                                } else {
                                    // If TMDB has no biography, ensure we do NOT persist Spotify-provided bio
                                    item.biography = '';
                                }
                            }
                        } else {
                            // No TMDB match: do not persist Spotify biography
                            item.biography = '';
                        }
                    } else {
                        // Search failed: ensure we don't persist Spotify biography
                        item.biography = '';
                    }
                }
            } catch (err) {
                console.warn('TMDB biography lookup failed during save:', err && err.message ? err.message : err);
                item.biography = '';
            }
        }

        // If this is a movies/TV item and we don't have banner/poster, try to fetch from TMDB
        if ((item.type === 'movies' || item.type === 'tv')) {
            try {
                const mediaType = item.type === 'movies' ? 'movies' : 'tv';
                // Prefer TMDB details when externalApiId is present and numeric
                if (item.externalApiId && /^[0-9]+$/.test(String(item.externalApiId))) {
                    try {
                        const resp = await apiFetch(`${API_URL}/api/tmdb-details?category=${mediaType}&id=${encodeURIComponent(item.externalApiId)}`);
                        if (resp.ok) {
                            const tm = await resp.json();
                            if (tm) {
                                if (!item.posterBase64 && tm.poster_path) {
                                    item.posterBase64 = tm.poster_path.startsWith('http') ? tm.poster_path : `https://image.tmdb.org/t/p/w500${tm.poster_path}`;
                                }
                                if (!item.bannerBase64 && tm.backdrop_path) {
                                    item.bannerBase64 = tm.backdrop_path.startsWith('http') ? tm.backdrop_path : `https://image.tmdb.org/t/p/original${tm.backdrop_path}`;
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('Failed to fetch TMDB details during save:', e);
                    }
                }

                // If still missing images, try a title search fallback
                if ((!item.posterBase64 || !item.bannerBase64) && item.name) {
                    try {
                        const q = encodeURIComponent(item.name);
                        const searchResp = await apiFetch(`${API_URL}/api/search?query=${q}&category=${mediaType}&service=tmdb`);
                        if (searchResp.ok) {
                            const searchData = await searchResp.json();
                            const first = (searchData.results && searchData.results.length) ? searchData.results[0] : null;
                            if (first) {
                                if (!item.posterBase64 && (first.poster_path || first.poster)) {
                                    const p = first.poster_path || first.poster;
                                    item.posterBase64 = p.startsWith('http') ? p : `https://image.tmdb.org/t/p/w500${p}`;
                                }
                                if (!item.bannerBase64 && (first.backdrop_path || first.backdrop)) {
                                    const b = first.backdrop_path || first.backdrop;
                                    item.bannerBase64 = b.startsWith('http') ? b : `https://image.tmdb.org/t/p/original${b}`;
                                }
                                // If we found an id, set externalApiId for downstream features
                                if (!item.externalApiId && first.id) {
                                    item.externalApiId = String(first.id);
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('TMDB search fallback during save failed:', e);
                    }
                }
            } catch (e) {
                console.warn('Error while attempting to enrich item images during save:', e);
            }
        }

        // Update local model immediately (snappy UI)
        this.data.items.push(item);

        // Persist to DB (full detail)
        try {
            const dbItem = {
                id: item.id,
                title: item.name,
                category: item.type,
                rating: item.userScore,
                year: item.year,
                genre: item.genre,
                description: item.description,
                biography: item.biography,
                myRank: item.myRank,
                gender: item.gender,
                birthday: item.birthday,
                placeOfBirth: item.placeOfBirth,
                socialMedia: item.socialMedia,
                biography: item.biography,
                linkedMovies: item.linkedMovies,
                externalApiId: item.externalApiId || '',
                studio: item.studio || '',
                developer: item.developer || '',
                directorCreator: item.directorCreator || '',
                runtime: item.runtime || '',
                episodes: item.episodes || '',
                episodeRuntime: item.episodeRuntime || '',
                timeToBeat: item.timeToBeat || '',
                source: item.source || ''
            };

            if (item.actorRoles && item.actorRoles.length) {
                const rolesString = item.actorRoles.join(', ');
                dbItem.actorRoles = rolesString;
                dbItem.actor_roles = JSON.stringify(item.actorRoles);
            }

            // Send base64 data if it's actual base64 (from new upload)
            // Or send as posterPath if it's already a URL (from external API like TMDB/MAL/Spotify)
            if (item.posterBase64?.startsWith('data:image')) {
                dbItem.posterBase64 = item.posterBase64;
            } else if (item.posterBase64?.startsWith('http')) {
                // It's an external URL, send it as posterPath so server can store it directly
                dbItem.posterPath = item.posterBase64;
            }
            if (item.bannerBase64?.startsWith('data:image')) {
                dbItem.bannerBase64 = item.bannerBase64;
            } else if (item.bannerBase64?.startsWith('http')) {
                // It's an external URL, send it as bannerPath so server can store it directly
                dbItem.bannerPath = item.bannerBase64;
            }

            const resp = await apiFetch(`${API_URL}/add`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(dbItem)
            });
            if (!resp.ok) {
                let errorText;
                try {
                    errorText = await resp.text();
                } catch (e) {
                    errorText = 'Failed to read error message: ' + e.message;
                }
                console.error('Save failed:', errorText);
                alert('Save failed: ' + errorText);
            }
            console.log("✅ Saved to GitHub:", dbItem);
            console.log("✅ Saved Studio/Developer/DirectorCreator to DB:", {
                studio: dbItem.studio,
                developer: dbItem.developer,
                directorCreator: dbItem.directorCreator
            });
        } catch (err) {
            console.error("❌ Error saving to GitHub:", err);
        }

        // Reload from DB (source of truth), but DO NOT wipe UI if empty
        const after = await this.loadItemsFromDB();
        if (!after || after.length === 0) {
            console.warn("DB still empty after save; keeping current UI list.");
        }

        // Add item to collection if selected
        if (selectedCollectionId) {
            console.log(`🔍 Looking for collection with ID: ${selectedCollectionId}`);
            console.log(`🔍 Current collections before reload:`, this.collections.map(c => ({ id: c.id, name: c.name, itemCount: c.itemIds?.length || 0 })));

            // Find the actual saved item from the database (might have different ID)
            let savedItemId = item.id;
            if (after && after.length > 0) {
                // Try to find by externalApiId first (most reliable), then by name and type
                const savedItem = after.find(i =>
                    (item.externalApiId && i.externalApiId === item.externalApiId) ||
                    (i.name === item.name && i.type === item.type)
                );
                if (savedItem) {
                    savedItemId = savedItem.id;
                    console.log(`✅ Found saved item with ID: ${savedItemId} (original: ${item.id})`);
                } else {
                    console.log(`⚠️ Could not find saved item, using original ID: ${item.id}`);
                }
            }

            if (savedItemId) {
                // Try to find collection in current collections first (might be newly created)
                let collectionToAddTo = this.collections.find(c => c.id === selectedCollectionId);

                // If not found, reload collections and try again
                if (!collectionToAddTo) {
                    console.log(`⚠️ Collection not found in current list, reloading from DB...`);
                    await this.loadCollectionsFromDB();
                    collectionToAddTo = this.collections.find(c => c.id === selectedCollectionId);
                    console.log(`🔍 Collections after reload:`, this.collections.map(c => ({ id: c.id, name: c.name, itemCount: c.itemIds?.length || 0 })));
                }

                if (collectionToAddTo) {
                    if (!collectionToAddTo.itemIds) {
                        collectionToAddTo.itemIds = [];
                    }
                    if (!collectionToAddTo.itemIds.includes(savedItemId)) {
                        collectionToAddTo.itemIds.push(savedItemId);
                        console.log(`✅ Adding item ${savedItemId} to collection "${collectionToAddTo.name}" (now has ${collectionToAddTo.itemIds.length} items)`);
                    } else {
                        console.log(`ℹ️ Item ${savedItemId} already in collection "${collectionToAddTo.name}"`);
                    }
                    // Save collections to GitHub
                    await this.saveCollectionToDB(collectionToAddTo);
                    console.log(`✅ Saved collection "${collectionToAddTo.name}" to database`);
                } else {
                    console.error(`❌ Collection with ID ${selectedCollectionId} not found after reload. Available collection IDs:`, this.collections.map(c => c.id));
                    console.error(`❌ Collection name from form:`, document.getElementById('itemCollectionSearch')?.value);
                }
            } else {
                console.error(`❌ Cannot add to collection: savedItemId is invalid`);
            }
        } else if (selectedCollectionName) {
            // Collection name provided but not found - create it
            console.log(`📝 Creating new collection "${selectedCollectionName}" and adding item to it`);
            await this.createCollectionFromForm(selectedCollectionName);

            // Reload collections to get the newly created one
            await this.loadCollectionsFromDB();

            // Find the newly created collection
            const newCollection = this.collections.find(c =>
                c.name && c.name.toLowerCase() === selectedCollectionName.toLowerCase()
            );

            if (newCollection) {
                // Find the actual saved item from the database
                let savedItemId = item.id;
                if (after && after.length > 0) {
                    const savedItem = after.find(i =>
                        (item.externalApiId && i.externalApiId === item.externalApiId) ||
                        (i.name === item.name && i.type === item.type)
                    );
                    if (savedItem) {
                        savedItemId = savedItem.id;
                    }
                }

                if (savedItemId) {
                    if (!newCollection.itemIds) {
                        newCollection.itemIds = [];
                    }
                    if (!newCollection.itemIds.includes(savedItemId)) {
                        newCollection.itemIds.push(savedItemId);
                        console.log(`✅ Added item ${savedItemId} to newly created collection "${newCollection.name}"`);
                    }
                    await this.saveCollectionToDB(newCollection);
                }
            }
        } else {
            console.log(`ℹ️ No collection selected for this item`);
        }

        // Auto-match collections by name for API items
        if (item.externalApiId && !selectedCollectionId && !selectedCollectionName) {
            this.autoMatchCollectionByName(item);
        }

        // Auto-link actors to movies/TV or movies/TV to actors
        // Use the item from database after reload to ensure we have the correct data
        if (item.externalApiId) {
            const savedItem = this.data.items.find(i => i.id === item.id);
            if (savedItem) {
                if (isActor) {
                    await this.autoLinkMoviesToActor(savedItem);
                } else if (item.type === 'movies' || item.type === 'tv') {
                    await this.autoLinkActorsToMovie(savedItem);
                }

                // Reload after auto-linking to ensure UI is updated
                await this.loadItemsFromDB();
            }
        }

        // Final reload of collections to ensure everything is in sync
        await this.loadCollectionsFromDB();

        this.closeAddMenu();
        this.renderLibrary();
    }

    // Auto-link actors when adding a movie/TV
    async autoLinkActorsToMovie(movieItem) {
        if (!movieItem.externalApiId) return;

        try {
            // Fetch cast from TMDB
            const response = await apiFetch(`${API_URL}/api/cast?category=${movieItem.type}&id=${movieItem.externalApiId}`);
            if (!response.ok) {
                console.warn('Could not fetch cast for auto-linking');
                return;
            }

            const data = await response.json();
            const cast = data.cast || [];

            // Find actors in our library that match the cast
            const actorsInLibrary = this.data.items.filter(item =>
                item.type === 'actors' &&
                item.externalApiId &&
                cast.some(castMember => castMember.id.toString() === item.externalApiId)
            );

            if (actorsInLibrary.length === 0) {
                console.log('No matching actors found in library for auto-linking');
                return;
            }

            // Update each actor's linkedMovies
            for (const actor of actorsInLibrary) {
                const currentLinkedMovies = (actor.linkedMovies || '').split(',').filter(id => id.trim());

                // Add the movie ID if not already present
                if (!currentLinkedMovies.includes(movieItem.id)) {
                    currentLinkedMovies.push(movieItem.id);
                    const updatedLinkedMovies = currentLinkedMovies.join(',');

                    // Update in local data
                    const idx = this.data.items.findIndex(i => i.id === actor.id);
                    if (idx !== -1) {
                        this.data.items[idx].linkedMovies = updatedLinkedMovies;
                    }

                    // Update in database
                    try {
                        await apiFetch(`${API_URL}/actor-linked-movies`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                id: actor.id,
                                linkedMovies: updatedLinkedMovies
                            })
                        });
                        console.log(`✅ Auto-linked ${movieItem.name} to actor ${actor.name}`);
                    } catch (err) {
                        console.error(`❌ Error updating linked movies for actor ${actor.name}:`, err);
                    }
                }
            }
        } catch (error) {
            console.error('❌ Error auto-linking actors to movie:', error);
        }
    }

    // Auto-link movies/TV when adding an actor
    async autoLinkMoviesToActor(actorItem) {
        if (!actorItem.externalApiId) return;

        try {
            // Fetch filmography from TMDB
            const response = await apiFetch(`${API_URL}/api/filmography?id=${actorItem.externalApiId}`);
            if (!response.ok) {
                console.warn('Could not fetch filmography for auto-linking');
                return;
            }

            const data = await response.json();
            const allCredits = [
                ...(data.movies || []).map(m => ({ ...m, type: 'movies' })),
                ...(data.tv || []).map(t => ({ ...t, type: 'tv' }))
            ];

            // Find movies/TV in our library that match the filmography
            const moviesInLibrary = this.data.items.filter(item =>
                (item.type === 'movies' || item.type === 'tv') &&
                item.externalApiId &&
                allCredits.some(credit => {
                    // Match by external API ID
                    if (credit.media_type === 'movie' && item.type === 'movies') {
                        return credit.id.toString() === item.externalApiId;
                    } else if (credit.media_type === 'tv' && item.type === 'tv') {
                        return credit.id.toString() === item.externalApiId;
                    }
                    return false;
                })
            );

            if (moviesInLibrary.length === 0) {
                console.log('No matching movies/TV found in library for auto-linking');
                return;
            }

            // Get current linked movies for the actor
            const currentLinkedMovies = (actorItem.linkedMovies || '').split(',').filter(id => id.trim());
            let updatedLinkedMovies = [...currentLinkedMovies];

            // Add movie/TV IDs that aren't already present
            moviesInLibrary.forEach(movie => {
                if (!updatedLinkedMovies.includes(movie.id)) {
                    updatedLinkedMovies.push(movie.id);
                }
            });

            if (updatedLinkedMovies.length === currentLinkedMovies.length) {
                console.log('All matching movies/TV already linked to actor');
                return;
            }

            const updatedLinkedMoviesStr = updatedLinkedMovies.join(',');

            // Update in local data
            const idx = this.data.items.findIndex(i => i.id === actorItem.id);
            if (idx !== -1) {
                this.data.items[idx].linkedMovies = updatedLinkedMoviesStr;
            }

            // Update in database
            try {
                await apiFetch(`${API_URL}/actor-linked-movies`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id: actorItem.id,
                        linkedMovies: updatedLinkedMoviesStr
                    })
                });
                console.log(`✅ Auto-linked ${moviesInLibrary.length} movies/TV to actor ${actorItem.name}`);
            } catch (err) {
                console.error(`❌ Error updating linked movies for actor ${actorItem.name}:`, err);
            }
        } catch (error) {
            console.error('❌ Error auto-linking movies to actor:', error);
        }
    }

    // Load all items from DB → normalize into UI model
    async loadItemsFromDB() {
        try {
            const res = await apiFetch(`${API_URL}/list`);
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();

            // Debug: Log what the database returns for the first row
            if (data && data.length > 0) {
                console.log('🔍 Database row keys:', Object.keys(data[0]));
                console.log('🔍 Sample row data:', data[0]);
            }

            const mapped = (Array.isArray(data) ? data : []).map(row => {
                // Try all possible column name variations
                const directorCreator = row.directorCreator || row.director_creator || row.DirectorCreator || row.directorcreator || row['Director/Creator'] || '';
                const studio = row.studio || row.Studio || '';
                const developer = row.developer || row.Developer || '';
                const actorRolesRaw = row.actorRoles || row.actor_roles || row.actorroles || '';
                const actorRolesList = row.category === 'actors'
                    ? this.normalizeActorRolesInput(
                        actorRolesRaw ||
                        row.genre ||
                        row.known_for_department ||
                        row.knownForDepartment ||
                        ''
                    )
                    : undefined;

                return {
                    id: row.id,
                    type: row.category,
                    name: row.title,
                    userScore: row.rating,
                    year: row.year || "",
                    genre: row.genre || "",
                    description: row.description || "",
                    myRank: row.myRank != null ? parseFloat(row.myRank) || 0 : 0,
                    // Handle absolute URLs, relative paths, and bare filenames
                    // IMPORTANT: Skip local 'assets/img/' paths as they don't persist on Render
                    posterBase64: row.posterPath
                        ? (row.posterPath.startsWith('http')
                            ? row.posterPath
                            : (row.posterPath.startsWith('assets/img/')
                                ? (row.posterImageRepo
                                    ? `https://raw.githubusercontent.com/${window.GITHUB_OWNER || 'ordonbtoosh'}/${row.posterImageRepo}/main/${row.posterPath.replace('assets/img/', '')}`
                                    : '') // Don't use broken local paths
                                : (row.posterPath.includes('/') ? `${API_URL}/${row.posterPath}` : `${API_URL}/assets/img/${row.posterPath}`)))
                        : "",
                    bannerBase64: row.bannerPath
                        ? (row.bannerPath.startsWith('http')
                            ? row.bannerPath
                            : (row.bannerPath.startsWith('assets/img/')
                                ? (row.bannerImageRepo
                                    ? `https://raw.githubusercontent.com/${window.GITHUB_OWNER || 'ordonbtoosh'}/${row.bannerImageRepo}/main/${row.bannerPath.replace('assets/img/', '')}`
                                    : '') // Don't use broken local paths
                                : (row.bannerPath.includes('/') ? `${API_URL}/${row.bannerPath}` : `${API_URL}/assets/img/${row.bannerPath}`)))
                        : "",
                    gender: row.gender || "",
                    birthday: row.birthday || "",
                    placeOfBirth: row.placeOfBirth || "",
                    socialMedia: row.socialMedia || "",
                    biography: row.biography || "",
                    linkedMovies: row.linkedMovies || "",
                    externalApiId: row.externalApiId || "",
                    source: row.source || row.Source || '',
                    studio: studio,
                    developer: developer,
                    directorCreator: directorCreator,
                    runtime: row.runtime || "",
                    episodes: row.episodes || "",
                    episodeRuntime: row.episodeRuntime || "",
                    timeToBeat: row.timeToBeat || "",
                    actorRoles: actorRolesList
                };
            });

            // 🔒 Only replace if DB returned something; otherwise keep current UI list
            if (mapped.length > 0) {
                this.data.items = mapped;
            } else {
                console.warn("DB returned empty; keeping current UI items.");
            }

            console.log("📦 Loaded items from GitHub:", mapped);
            // Debug: Check if Studio/Developer/DirectorCreator are being loaded
            if (mapped.length > 0) {
                const sampleItem = mapped.find(i => i.type === 'tv' || i.type === 'movies') || mapped[0];
                if (sampleItem) {
                    console.log("📦 Sample item loaded from DB:", {
                        name: sampleItem.name,
                        type: sampleItem.type,
                        studio: sampleItem.studio || '(empty)',
                        developer: sampleItem.developer || '(empty)',
                        directorCreator: sampleItem.directorCreator || '(empty)'
                    });
                }
            }
            this.renderLibrary();
            if (this.currentView === 'insights') {
                this.renderInsights();
            }
            return mapped;
        } catch (err) {
            console.error("❌ Error loading items from DB:", err);
            return [];
        }
    }

    toggleDeleteMode() {
        this.isDeleteMode = !this.isDeleteMode;
        this.selectedItems.clear();

        if (this.isDeleteMode) {
            document.getElementById('deleteControls').style.display = 'flex';
            document.querySelectorAll('.grid-item').forEach(item => {
                item.classList.add('delete-mode');
                const checkboxOverlay = item.querySelector('.delete-checkbox-overlay');
                if (checkboxOverlay) {
                    checkboxOverlay.style.display = 'flex';
                    const checkbox = checkboxOverlay.querySelector('.delete-checkbox');
                    if (checkbox) checkbox.checked = false;
                }
                // Update click handler to prevent detail view - remove old handlers first
                const itemId = item.dataset.itemId;
                const newItem = item.cloneNode(true);
                item.parentNode.replaceChild(newItem, item);
                // Reattach event listeners
                const checkboxOverlayNew = newItem.querySelector('.delete-checkbox-overlay');
                if (checkboxOverlayNew) {
                    checkboxOverlayNew.addEventListener('click', (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                    });
                    const checkboxNew = checkboxOverlayNew.querySelector('.delete-checkbox');
                    if (checkboxNew) {
                        checkboxNew.addEventListener('click', (e) => {
                            e.stopPropagation();
                        });
                        checkboxNew.addEventListener('change', (e) => {
                            e.stopPropagation();
                            if (checkboxNew.checked) {
                                this.selectedItems.add(itemId);
                                newItem.classList.add('selected');
                            } else {
                                this.selectedItems.delete(itemId);
                                newItem.classList.remove('selected');
                            }
                        });
                    }
                }
                // Set click handler on the item itself (not on checkbox)
                newItem.addEventListener('click', (e) => {
                    if (e.target.type === 'checkbox' ||
                        e.target.classList.contains('delete-checkbox') ||
                        e.target.closest('.delete-checkbox-overlay')) {
                        return;
                    }
                    e.stopPropagation();
                    e.preventDefault();
                    this.toggleItemSelection(itemId);
                });
            });
        } else {
            document.getElementById('deleteControls').style.display = 'none';
            document.querySelectorAll('.grid-item').forEach(item => {
                item.classList.remove('delete-mode', 'selected');
                const checkboxOverlay = item.querySelector('.delete-checkbox-overlay');
                if (checkboxOverlay) checkboxOverlay.style.display = 'none';
                // Restore click handler to show detail view
                const itemId = item.dataset.itemId;
                const itemData = this.data.items.find(i => i.id === itemId);
                if (itemData) {
                    // Remove old handlers and add new one
                    const newItem = item.cloneNode(true);
                    item.parentNode.replaceChild(newItem, item);
                    newItem.addEventListener('click', () => this.openDetailView(itemData));
                }
            });
        }
    }

    toggleItemSelection(itemId) {
        const el = document.querySelector(`[data-item-id="${itemId}"]`);
        const checkbox = el?.querySelector('.delete-checkbox');

        if (this.selectedItems.has(itemId)) {
            this.selectedItems.delete(itemId);
            el.classList.remove('selected');
            if (checkbox) checkbox.checked = false;
        } else {
            this.selectedItems.add(itemId);
            el.classList.add('selected');
            if (checkbox) checkbox.checked = true;
        }
    }

    async confirmDelete() {
        if (this.selectedItems.size === 0) {
            alert('No items selected');
            return;
        }

        // Separate items and collections
        const selectedItemIds = [];
        const selectedCollectionIds = [];

        Array.from(this.selectedItems).forEach(id => {
            // Skip if id is undefined or null
            if (!id) return;

            // Check if it's a collection (collections have IDs starting with "collection_")
            if (typeof id === 'string' && id.startsWith('collection_')) {
                selectedCollectionIds.push(id);
            } else {
                selectedItemIds.push(id);
            }
        });

        const itemCount = selectedItemIds.length;
        const collectionCount = selectedCollectionIds.length;
        let confirmMessage = '';

        if (itemCount > 0 && collectionCount > 0) {
            confirmMessage = `Delete ${itemCount} item(s) and ${collectionCount} collection(s)?`;
        } else if (itemCount > 0) {
            confirmMessage = `Delete ${itemCount} selected item(s)?`;
        } else if (collectionCount > 0) {
            confirmMessage = `Delete ${collectionCount} selected collection(s)?`;
        }

        if (!confirm(confirmMessage)) return;

        // Delete items
        if (selectedItemIds.length > 0) {
            // Remove locally
            this.data.items = this.data.items.filter(item => !selectedItemIds.includes(item.id));
            // Persist deletion
            try {
                await apiFetch(`${API_URL}/delete`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ids: selectedItemIds })
                });
                console.log("🗑️ Deleted items from GitHub:", selectedItemIds);
            } catch (err) {
                console.error("❌ Error deleting items from GitHub:", err);
            }
        }

        // Delete collections
        if (selectedCollectionIds.length > 0) {
            // Remove locally
            this.collections = this.collections.filter(collection => !selectedCollectionIds.includes(collection.id));
            // Persist deletion
            for (const collectionId of selectedCollectionIds) {
                try {
                    await this.deleteCollectionFromDB(collectionId);
                    console.log("🗑️ Deleted collection from GitHub:", collectionId);
                } catch (err) {
                    console.error("❌ Error deleting collection from GitHub:", err);
                }
            }
        }

        this.toggleDeleteMode();
        await this.loadItemsFromDB(); // refresh items
        await this.loadCollectionsFromDB(); // refresh collections
        this.renderLibrary(); // re-render to update display
    }

    cancelDelete() { this.toggleDeleteMode(); }

    // ---------- STARS ----------
    updateStarDisplay(containerSelector, rating) {
        const normalized = Math.max(0, Math.min(5, Math.round(rating * 2) / 2));
        document.querySelectorAll(`${containerSelector} .star`).forEach(star => {
            const value = parseInt(star.dataset.rating, 10);
            const isFull = normalized >= value;
            const isHalf = normalized >= value - 0.5 && normalized < value;
            star.classList.toggle('active', isFull);
            star.classList.toggle('half-active', isHalf);
        });
    }

    setFormStarRating(rating) {
        const normalized = Math.max(0, Math.min(5, Math.round(rating * 2) / 2));
        this.formStarRatingValue = normalized;
        this.updateStarDisplay('#formStarRating', normalized);
    }

    async setDetailStarRating(rating) {
        const normalized = Math.max(0, Math.min(5, Math.round(rating * 2) / 2));
        this.updateStarDisplay('#starRating', normalized);

        // Save the new rating to the database
        if (this.currentItem && this.currentItem.id) {
            if (this.currentItem.myRank === normalized) {
                return;
            }
            this.currentItem.myRank = normalized;

            // Update local data
            const idx = this.data.items.findIndex(i => i.id === this.currentItem.id);
            if (idx !== -1) {
                this.data.items[idx].myRank = normalized;
            }

            // Persist to DB - use PATCH to update only rating
            try {
                const resp = await apiFetch(`${API_URL}/rating`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: this.currentItem.id, myRank: normalized })
                });

                if (!resp.ok) {
                    console.error("❌ Failed to save rating:", await resp.text());
                } else {
                    console.log("✅ Rating saved:", normalized);
                }
            } catch (err) {
                console.error("❌ Error saving rating to DB:", err);
            }
        }
    }

    getFormStarRating() {
        return this.formStarRatingValue || 0;
    }

    // ---------- IMAGES ----------
    async handleImageUpload(event, previewId) {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (e) => {
            const base64 = e.target.result;
            const preview = document.getElementById(previewId);
            if (!preview) return;

            // Compress if needed before storing
            const compressedBase64 = await this.compressImageIfNeeded(base64);
            preview.innerHTML = `<img src="${compressedBase64}" alt="Preview" style="width:100%;height:auto;border-radius:8px;">`;
            preview.dataset.base64 = compressedBase64; // store compressed version for saveItem()
        };
        reader.readAsDataURL(file);
    }

    getImagePreview(previewId) {
        const el = document.getElementById(previewId);
        if (!el) return "";
        return el.dataset.base64 || el.querySelector("img")?.src || "";
    }

    // ---------- API SEARCH ----------
    async searchAPI() {
        const query = document.getElementById('apiSearchInput').value.trim();
        if (!query) {
            alert('Please enter a search term');
            return;
        }

        const resultsDiv = document.getElementById('apiResults');
        resultsDiv.innerHTML = '<p>Searching...</p>';

        try {
            const category = this.currentTab;
            let service;

            if (category === 'movies' || category === 'tv') {
                service = 'tmdb';
            } else if (category === 'actors') {
                // Determine actor search service from the active tab (DOM),
                // fallback to stored actorSearchSource or 'tmdb'
                const spotifyTab = document.getElementById('spotifySingerTab');
                const tmdbTab = document.getElementById('tmdbActorTab');
                if (spotifyTab && spotifyTab.classList.contains('active')) {
                    service = 'spotify';
                } else if (tmdbTab && tmdbTab.classList.contains('active')) {
                    service = 'tmdb';
                } else {
                    service = this.actorSearchSource || 'tmdb';
                }
                console.debug('Actor API search using service:', service);
            } else if (category === 'anime') {
                service = 'mal';
            } else if (category === 'games') {
                service = 'rawg';
            }

            // Handle Spotify search separately (client-side)
            if (service === 'spotify') {
                await this.searchSpotifyArtists(query, resultsDiv);
                return;
            }

            // Use server proxy to avoid CORS and keep API keys secure
            const response = await apiFetch(`${API_URL}/api/search?query=${encodeURIComponent(query)}&category=${category}&service=${service}`);
            if (!response.ok) {
                let errorMessage = `API error: ${response.statusText}`;
                try {
                    const error = await response.json();
                    errorMessage = error.error || errorMessage;
                } catch (e) {
                    const text = await response.text();
                    errorMessage = text || errorMessage;
                }
                throw new Error(errorMessage);
            }

            const data = await response.json();
            const results = data.results || [];

            this.displaySearchResults(results, resultsDiv);
        } catch (error) {
            console.error('API search error:', error);

            // Provide helpful error messages
            let userMessage = error.message;
            if (error.message.includes('Invalid API key') || error.message.includes('status 401')) {
                userMessage = 'Invalid API key. Please check your API key in settings.';
            } else if (error.message.includes('not configured')) {
                userMessage = 'Please add an API key in settings before searching.';
            }

            resultsDiv.innerHTML = `<p style="color: #ff6666;">Error searching: ${userMessage}</p>`;
        }
    }

    // Spotify API Functions
    async getSpotifyAccessToken() {
        const clientId = this.data.settings.spotifyClientId;
        const clientSecret = this.data.settings.spotifyClientSecret;

        if (!clientId || !clientSecret) {
            throw new Error('Spotify Client ID and Client Secret are required. Please add them in settings.');
        }

        // Check if we have a cached token that's still valid
        const cachedToken = localStorage.getItem('spotifyAccessToken');
        const tokenExpiry = localStorage.getItem('spotifyTokenExpiry');

        if (cachedToken && tokenExpiry && Date.now() < parseInt(tokenExpiry)) {
            return cachedToken;
        }

        // Get new access token
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + btoa(clientId + ':' + clientSecret)
            },
            body: 'grant_type=client_credentials'
        });

        if (!response.ok) {
            throw new Error(`Failed to get Spotify access token: ${response.statusText}`);
        }

        const data = await response.json();
        const accessToken = data.access_token;
        const expiresIn = data.expires_in || 3600; // Default to 1 hour

        // Cache the token with expiry time (subtract 60 seconds for safety margin)
        localStorage.setItem('spotifyAccessToken', accessToken);
        localStorage.setItem('spotifyTokenExpiry', (Date.now() + (expiresIn - 60) * 1000).toString());

        return accessToken;
    }
    async getSpotifyArtistDetails(artistId) {
        try {
            const accessToken = await this.getSpotifyAccessToken();
            const response = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            if (!response.ok) {
                throw new Error(`Spotify API error: ${response.status} ${response.statusText}`);
            }

            const artist = await response.json();

            // Build biography from available information (without URLs)
            let biography = '';
            if (artist.genres && artist.genres.length > 0) {
                biography += `Genres: ${artist.genres.join(', ')}. `;
            }
            if (artist.followers?.total) {
                biography += `Followers: ${artist.followers.total.toLocaleString()}. `;
            }
            if (artist.popularity) {
                biography += `Popularity: ${artist.popularity}/100.`;
            }

            // Collect social media links - prioritize Spotify link
            const socialLinks = [];

            // Add Spotify link first
            if (artist.external_urls?.spotify) {
                socialLinks.push(artist.external_urls.spotify);
            }

            // Note: Spotify API doesn't provide Instagram, Facebook, TikTok, or IMDb links
            // Users can add these manually after selecting the artist
            // The field will be pre-populated with the Spotify link and users can add more

            return {
                biography: biography.trim(),
                genres: artist.genres || [],
                followers: artist.followers?.total || 0,
                popularity: artist.popularity || 0,
                socialMedia: socialLinks.join(', '),
                spotifyUrl: artist.external_urls?.spotify || ''
            };
        } catch (error) {
            console.error('Error fetching Spotify artist details:', error);
            return null;
        }
    }

    async getSpotifyArtistTopTracks(artistId, market = 'US') {
        try {
            const accessToken = await this.getSpotifyAccessToken();
            const response = await fetch(`https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=${encodeURIComponent(market)}`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });

            if (!response.ok) {
                throw new Error(`Spotify API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            return data.tracks || [];
        } catch (err) {
            console.error('Error fetching Spotify top tracks:', err);
            return [];
        }
    }

    // Fetch additional tracks for an artist by scanning their albums/singles.
    // This is a best-effort fallback to provide more than the 10 tracks returned by the
    // /artists/{id}/top-tracks endpoint. It returns an array of track objects similar
    // to the structure returned by the Spotify API.
    async getSpotifyArtistAdditionalTracks(artistId, market = 'US', desired = 12) {
        try {
            const accessToken = await this.getSpotifyAccessToken();

            // Fetch artist albums (albums + singles) - get up to 50 to maximize variety
            const albumsResp = await fetch(`https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}/albums?include_groups=album,single&limit=50`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            if (!albumsResp.ok) {
                throw new Error(`Spotify albums fetch failed: ${albumsResp.status}`);
            }
            const albumsData = await albumsResp.json();
            const albums = (albumsData.items || []).filter(Boolean);

            const tracks = [];
            const seen = new Set();

            // Iterate albums and fetch tracks until we accumulate the desired number
            for (const album of albums) {
                if (tracks.length >= desired) break;
                try {
                    const albumId = album.id;
                    const albumTracksResp = await fetch(`https://api.spotify.com/v1/albums/${encodeURIComponent(albumId)}/tracks?limit=50`, {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    });
                    if (!albumTracksResp.ok) continue;
                    const albumTracksData = await albumTracksResp.json();
                    const albumTracks = albumTracksData.items || [];
                    for (const t of albumTracks) {
                        if (tracks.length >= desired) break;
                        if (!t || !t.id) continue;
                        if (seen.has(t.id)) continue;
                        // Attach album info so rendering can use album images
                        t.album = t.album || { id: album.id, images: album.images, name: album.name };
                        tracks.push(t);
                        seen.add(t.id);
                    }
                } catch (e) {
                    // Continue on errors for individual albums
                    console.warn('Error fetching album tracks:', e && e.message ? e.message : e);
                    continue;
                }
            }

            return tracks.slice(0, desired);
        } catch (err) {
            console.error('Error fetching additional Spotify tracks:', err);
            return [];
        }
    }

    // Normalize and compare names to avoid incorrect TMDB matches for Spotify artists
    normalizeNameForMatch(name) {
        if (!name) return '';
        try {
            // Remove diacritics, non-alphanumerics and lowercase
            return name.normalize && name.normalize('NFD')
                ? name.normalize('NFD').replace(/[ -]/g, c => c).replace(/\p{Diacritic}/gu, '')
                : name;
        } catch (e) {
            // Fallback simple normalization
            return name;
        }
    }

    isNameMatch(a, b) {
        if (!a || !b) return false;
        const normalize = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
        const na = normalize(a);
        const nb = normalize(b);
        if (!na || !nb) return false;
        if (na === nb) return true;
        if (na.includes(nb) || nb.includes(na)) {
            const shorter = Math.min(na.length, nb.length);
            const longer = Math.max(na.length, nb.length);
            return (shorter / longer) >= 0.6; // require at least 60% length similarity when one contains the other
        }
        return false;
    }

    async searchSpotifyArtists(query, resultsDiv) {
        try {
            const accessToken = await this.getSpotifyAccessToken();
            const encodedQuery = encodeURIComponent(query);

            const response = await fetch(`https://api.spotify.com/v1/search?q=${encodedQuery}&type=artist&limit=20`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            if (!response.ok) {
                throw new Error(`Spotify API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            const artists = data.artists?.items || [];

            // Format Spotify artists to match actor format, and attempt to merge TMDB biography + social links
            const formattedResults = [];
            for (const artist of artists) {
                const base = {
                    id: artist.id,
                    name: artist.name,
                    externalApiId: artist.id,
                    type: 'actors',
                    source: 'spotify',
                    posterPath: artist.images && artist.images.length > 0 ? artist.images[0].url : null,
                    posterBase64: null,
                    genre: artist.genres && artist.genres.length > 0 ? artist.genres.join(', ') : '',
                    description: '',
                    biography: '',
                    popularity: artist.popularity || 0,
                    followers: artist.followers?.total || 0,
                    spotifyUrl: artist.external_urls?.spotify || ''
                };

                // Try to find a matching TMDB person by name and merge biography + external ids
                try {
                    const nameToSearch = artist.name;
                    if (nameToSearch) {
                        const searchResp = await apiFetch(`${API_URL}/api/search?query=${encodeURIComponent(nameToSearch)}&category=actors&service=tmdb`);
                        if (searchResp.ok) {
                            const searchData = await searchResp.json();
                            const first = (searchData.results && searchData.results.length) ? searchData.results[0] : null;
                            if (first && first.id) {
                                // Only accept TMDB person matches when the name is a reasonable match to avoid incorrect random matches
                                const tmdbName = first.name || first.title || '';
                                if (this.isNameMatch(nameToSearch, tmdbName)) {
                                    const personResp = await apiFetch(`${API_URL}/api/person/${first.id}`);
                                    if (personResp.ok) {
                                        const personData = await personResp.json();
                                        if (personData) {
                                            if (personData.biography && personData.biography.trim()) {
                                                base.biography = personData.biography.trim();
                                            }

                                            // Build social links: prefer Spotify + any TMDB external ids
                                            const socialLinks = [];
                                            if (artist.external_urls?.spotify) socialLinks.push(artist.external_urls.spotify);
                                            if (personData.external_ids) {
                                                if (personData.external_ids.imdb_id) socialLinks.push(`https://www.imdb.com/name/${personData.external_ids.imdb_id}`);
                                                if (personData.external_ids.twitter_id) socialLinks.push(`https://twitter.com/${personData.external_ids.twitter_id}`);
                                                if (personData.external_ids.instagram_id) socialLinks.push(`https://www.instagram.com/${personData.external_ids.instagram_id}`);
                                                if (personData.external_ids.facebook_id) socialLinks.push(`https://www.facebook.com/${personData.external_ids.facebook_id}`);
                                            }
                                            // Deduplicate and join
                                            base.socialMedia = Array.from(new Set(socialLinks)).join(', ');
                                        }
                                    }
                                } else {
                                    // TMDB candidate name did not sufficiently match the Spotify artist name: skip TMDB merge
                                    base.socialMedia = artist.external_urls?.spotify ? artist.external_urls.spotify : '';
                                }
                            } else {
                                // No tmdb match: still include spotify url
                                base.socialMedia = artist.external_urls?.spotify ? artist.external_urls.spotify : '';
                            }
                        } else {
                            base.socialMedia = artist.external_urls?.spotify ? artist.external_urls.spotify : '';
                        }
                    }
                } catch (err) {
                    console.warn('TMDB merge failed for artist', artist.name, err && err.message ? err.message : err);
                    base.socialMedia = artist.external_urls?.spotify ? artist.external_urls.spotify : '';
                }

                formattedResults.push(base);
            }

            this.displaySearchResults(formattedResults, resultsDiv);
        } catch (error) {
            console.error('Spotify search error:', error);
            let userMessage = error.message;
            if (error.message.includes('Client ID') || error.message.includes('Client Secret')) {
                userMessage = 'Please add Spotify Client ID and Client Secret in settings.';
            }
            resultsDiv.innerHTML = '<p style="color: #ff6666;">Error searching Spotify: ' + userMessage + '</p>';
        }
    }

    displaySearchResults(results, container) {
        if (results.length === 0) {
            container.innerHTML = '<p>No results found.</p>';
            return;
        }

        // ONLY show main games and DLCs for games tab - filter out everything else
        let filteredResults = results;
        if (this.currentTab === 'games') {
            filteredResults = results.filter(item => {
                const title = (item.title || item.name || '').toLowerCase();

                // First, check if it's a DLC/expansion (these are allowed)
                const isDLC = /\b(?:dlc|downloadable\s+content|expansion|add-?on|add-?ons?|season\s+pass|episode|ep\.|ep\s+\d+)\b/i.test(title);

                // Exclude patterns that indicate non-game/non-DLC content
                const excludePatterns = [
                    // Videos and media
                    /\btrailer\b/i,
                    /\be3\b/i,
                    /\bgameplay\b/i,
                    /\bpreview\b/i,
                    /\bteaser\b/i,
                    /\bcinematic\b/i,
                    /\bvideo\b/i,
                    /\bclip\b/i,
                    /\bcompilation\b/i,
                    /\bdlc\s+(video|trailer|preview)/i,
                    // Demos and betas
                    /\bdemo\b/i,
                    /\bbeta\b/i,
                    /\balpha\b/i,
                    /\btest\s+version\b/i,
                    // Guides and documentation
                    /\bguide\b/i,
                    /\beguide\b/i,
                    /\bprima\b/i,
                    /\bofficial\s+(guide|eguide|manual|book)\b/i,
                    /\bwalkthrough\b/i,
                    /\btutorial\b/i,
                    /\bstrategy\s+guide\b/i,
                    // Audio content
                    /\bsoundtrack\b/i,
                    /\bost\b/i,
                    /\baudio\b/i,
                    /\bmusic\b/i,
                    // Packs (unless it's part of a game title, but usually packs are separate items)
                    /\bpack\b/i,
                    // Keys and licenses
                    /\bstandard\s+keys?\b/i,
                    /\bkeys?\s+(?:edition|version|region|only)\b/i,
                    /\b(?:license|activation|key|cd-?key)\b/i,
                    // Updates and patches
                    /\bupdate\b/i,
                    /\bpatch\b/i,
                    /\bhotfix\b/i,
                    // Marketing and announcements
                    /\bannouncement\b/i,
                    /\breveal\b/i,
                    /\bdeep\s+dive\b/i,
                    /\bdeveloper\s+diary\b/i,
                    /\bdev\s+diary\b/i,
                    /\binterview\b/i,
                    /\bpanel\b/i,
                    /\bconference\b/i,
                    /\bevent\b/i,
                    // Other non-game content
                    /\benemies\b/i,
                    /\bcharacters\b/i,
                    /\bweapons\b/i,
                    /\bskins?\b/i,
                    /\bcosmetic\b/i,
                    // Non-English languages (exclude localized versions that aren't the main game)
                    /\b(?:french|français|german|deutsch|spanish|español|italian|italiano|portuguese|português|russian|русский|japanese|日本語|chinese|中文|korean|한국어|polish|polski|dutch|nederlands|turkish|türkçe|arabic|العربية|hebrew|עברית|thai|ไทย|vietnamese|tiếng việt|indonesian|indonesia|hindi|हिन्दी|greek|ελληνικά|czech|čeština|romanian|română|hungarian|magyar|swedish|svenska|norwegian|norsk|danish|dansk|finnish|suomi)\s+(?:version|edition|language|lang)\b/i
                ];

                // Check if title matches any exclusion pattern
                for (const pattern of excludePatterns) {
                    if (pattern.test(title)) {
                        return false;
                    }
                }

                // Additional specific exclusions
                // Exclude if it ends with "Pack" (like "Fortunes Pack")
                if (/\bpack\s*$/i.test(title)) {
                    return false;
                }

                // Exclude if it's clearly a guide (Prima, Official Guide, eGuide, etc.)
                if (/\b(?:prima|eguide|official\s+guide|strategy\s+guide)\b/i.test(title)) {
                    return false;
                }

                // Exclude if it contains "Standard Keys" or ends with "Keys"
                if (/\b(?:standard\s+)?keys?\s*$/i.test(title) || /\bkeys?\s+(?:edition|version|region|only)\b/i.test(title)) {
                    return false;
                }

                // If it's not excluded, it's either a main game or DLC - allow it
                // DLCs are explicitly allowed (checked above with isDLC variable)
                // Main games don't match exclusion patterns
                return true;
            });
        }

        const html = filteredResults.map((item, idx) => {
            let title, poster, year, description;
            const metaBadges = [];

            console.log('Processing result item:', item);

            if (item.title) {
                // TMDB or RAWG format
                title = item.title || item.name;
                // Check if poster_path is a full URL (RAWG) or just a path (TMDB)
                if (item.poster_path?.startsWith('http')) {
                    poster = item.poster_path;
                } else {
                    poster = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '';
                }
                year = item.release_date?.split('-')[0] || item.first_air_date?.split('-')[0] || '';
                description = item.overview || '';
            } else if (item.node) {
                // MAL format
                title = item.node.title;
                poster = item.node.main_picture?.medium || '';
                year = '';
                description = '';
                const episodes = item.num_episodes ?? item.node.num_episodes;
                const avgDurationMinutes = item.average_episode_duration_minutes
                    ?? (item.average_episode_duration_seconds ? parseFloat((item.average_episode_duration_seconds / 60).toFixed(1)) : null)
                    ?? (item.node.average_episode_duration ? parseFloat((item.node.average_episode_duration / 60).toFixed(1)) : null);
                if (episodes) metaBadges.push(`${episodes} eps`);
                if (avgDurationMinutes) metaBadges.push(`${avgDurationMinutes} min`);
            } else if (item.profile_path) {
                // Actor format (TMDB person)
                title = item.name || 'Unknown';
                poster = `https://image.tmdb.org/t/p/w500${item.profile_path}`;
                year = '';
                description = item.known_for_department || '';
            } else {
                // Fallback: support various fields including Spotify formatted results
                title = item.name || 'Unknown';

                // Prefer camelCase posterPath (used for Spotify formatted items), then poster, poster_path, images array, or profile_path
                if (item.posterPath && typeof item.posterPath === 'string') {
                    poster = item.posterPath;
                } else if (item.poster && typeof item.poster === 'string') {
                    poster = item.poster;
                } else if (item.poster_path && typeof item.poster_path === 'string') {
                    poster = item.poster_path.startsWith('http') ? item.poster_path : `https://image.tmdb.org/t/p/w500${item.poster_path}`;
                } else if (item.images && Array.isArray(item.images) && item.images.length > 0 && item.images[0].url) {
                    poster = item.images[0].url;
                } else if (item.profile_path) {
                    poster = `https://image.tmdb.org/t/p/w500${item.profile_path}`;
                } else {
                    poster = '';
                }

                year = '';
                description = '';
            }

            const descText = description ? (description.substring(0, 150) + (description.length > 150 ? '...' : '')) : '';
            const metaMarkup = metaBadges.length
                ? `<div class="api-result-extra">${metaBadges.map(badge => `<span>${badge}</span>`).join('')}</div>`
                : '';

            // Escape title safely for attributes and content
            const safeTitle = this.escapeHtml(title);
            const safeDesc = this.escapeHtml(descText);
            // Use single quotes for attributes to avoid breaking on double-quoted SVG data URIs
            return `
                <div class="api-result-item" data-index='${idx}'>
                    <img src='${poster || this.PLACEHOLDER_IMAGE}' alt='${safeTitle}' />
                    <div>
                        <h4>${safeTitle}</h4>
                        ${year ? `<p>${this.escapeHtml(year)}</p>` : ''}
                        ${descText ? `<p>${safeDesc}</p>` : ''}
                        ${metaMarkup}
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = html;

        // Add click handlers to result items (use filtered results for indexing)
        let originalIndex = 0;
        container.querySelectorAll('.api-result-item').forEach(item => {
            const idx = item.dataset.index;
            item.addEventListener('click', () => {
                // Map back to original results array index
                this.selectSearchResult(filteredResults[idx]);
            });
        });

        const metaContainer = document.getElementById('apiResultMeta');
        if (metaContainer) {
            metaContainer.classList.add('hidden');
            metaContainer.innerHTML = '';
        }
    }

    async fetchSelectionDetails(category, apiId) {
        if (!apiId || !['movies', 'tv', 'anime', 'games'].includes(category)) {
            return null;
        }
        try {
            // The server `/api/details` expects plural category names: 'movies','tv','anime','games'
            const apiCategory = category; // already one of the allowed plural forms
            const response = await apiFetch(`${API_URL}/api/details?category=${encodeURIComponent(apiCategory)}&id=${encodeURIComponent(apiId)}`);
            if (!response.ok) {
                const text = await response.text();
                throw new Error(text || `Failed to fetch metadata (${response.status})`);
            }
            return await response.json();
        } catch (error) {
            console.warn(`⚠️ Failed to fetch detailed metadata for ${category} ${apiId}:`, error.message);
            return null;
        }
    }

    renderSelectionMetadata(category, metadata, fallbackResult) {
        const container = document.getElementById('apiResultMeta');
        if (!container) return;

        if (!['movies', 'tv', 'anime', 'games'].includes(category)) {
            container.classList.add('hidden');
            container.innerHTML = '';
            return;
        }

        const rows = [];

        if (category === 'anime') {
            const base = fallbackResult?.node || fallbackResult || {};
            const episodes = metadata?.num_episodes ?? base.num_episodes ?? null;
            const avgMinutes = metadata?.average_episode_duration_minutes
                ?? (metadata?.average_episode_duration_seconds != null ? parseFloat((metadata.average_episode_duration_seconds / 60).toFixed(1)) : null)
                ?? (base.average_episode_duration_minutes != null ? base.average_episode_duration_minutes : null)
                ?? (base.average_episode_duration != null ? parseFloat((base.average_episode_duration / 60).toFixed(1)) : null);
            if (episodes != null) rows.push({ label: 'Episodes', value: `${episodes}` });
            if (avgMinutes != null) rows.push({ label: 'Avg Episode Length', value: `${avgMinutes} min` });
        } else if (category === 'tv') {
            const episodes = metadata?.episode_count ?? metadata?.number_of_episodes ?? fallbackResult?.number_of_episodes ?? null;
            const seasons = metadata?.season_count ?? metadata?.number_of_seasons ?? fallbackResult?.number_of_seasons ?? null;
            const avgRuntime = metadata?.average_episode_runtime_minutes
                ?? (Array.isArray(metadata?.episode_runtime_minutes) && metadata.episode_runtime_minutes.length
                    ? Math.round(metadata.episode_runtime_minutes.reduce((acc, val) => acc + val, 0) / metadata.episode_runtime_minutes.length)
                    : null)
                ?? metadata?.omdb_episode_runtime_minutes
                ?? (Array.isArray(metadata?.episode_run_time) && metadata.episode_run_time.length
                    ? Math.round(metadata.episode_run_time.reduce((acc, val) => acc + val, 0) / metadata.episode_run_time.length)
                    : null);
            if (episodes != null) rows.push({ label: 'Episodes', value: `${episodes}` });
            if (seasons != null) rows.push({ label: 'Seasons', value: `${seasons}` });
            if (avgRuntime != null) rows.push({ label: 'Avg Runtime', value: `${avgRuntime} min` });
        } else if (category === 'movies') {
            const runtime = metadata?.runtime_minutes ?? metadata?.runtime ?? null;
            if (runtime != null) rows.push({ label: 'Runtime', value: `${runtime} min` });
            if (metadata?.release_date) rows.push({ label: 'Release Date', value: metadata.release_date });
        } else if (category === 'games') {
            const timeToBeat = metadata?.time_to_beat;
            if (timeToBeat) {
                const avgHours = timeToBeat.average_hours ?? (timeToBeat.average_minutes ? parseFloat((timeToBeat.average_minutes / 60).toFixed(1)) : null);
                if (avgHours != null) rows.push({ label: 'Time to Beat', value: `${avgHours} h` });
                else if (timeToBeat.average_minutes) rows.push({ label: 'Time to Beat', value: `${timeToBeat.average_minutes} min` });
            }
        }

        if (rows.length === 0) {
            container.classList.remove('hidden');
            container.innerHTML = `<div class="api-meta-empty">No additional details available.</div>`;
            return;
        }

        const html = rows.map(row => `
            <div class="api-meta-row">
                <span class="api-meta-label">${row.label}</span>
                <span class="api-meta-value">${row.value}</span>
            </div>
        `).join('');

        container.classList.remove('hidden');
        container.innerHTML = `<div class="api-meta-grid">${html}</div>`;
    }

    async selectSearchResult(result) {
        // Handle MAL format (result.node)
        const animeData = this.currentTab === 'anime' && result.node ? result.node : result;
        const actualResult = animeData || result;

        console.log('Selected search result:', actualResult);

        // Populate manual form with search result
        document.getElementById('itemName').value = actualResult.title || actualResult.name || '';

        // Store external API ID for later use in URL generation
        // For MAL anime, use mal_id; for others use id
        const apiId = this.currentTab === 'anime'
            ? (actualResult.mal_id || actualResult.id || result.mal_id || result.id)
            : (actualResult.id || result.id);
        document.getElementById('itemExternalApiId').value = apiId || '';

        // Make sure form fields are visible for current tab
        this.updateFormFieldsByTab();

        // Ensure image selector uses the newly-selected result rather than any previously-opened
        // detail `currentItem`. Store a small transient object so `openImageSelector` will
        // pick up the correct `externalApiId` and `type` when invoked from the add form.
        try {
            const transientId = apiId ? String(apiId) : '';
            this.currentItem = { type: this.currentTab, externalApiId: transientId, name: document.getElementById('itemName').value };
        } catch (e) {
            // If anything goes wrong setting currentItem, silently ignore – existing behaviour will continue
            console.warn('Could not set transient currentItem after selection:', e);
        }

        const selectionCategory = this.currentTab;
        const isActorSelection = selectionCategory === 'actors';
        // Detect Spotify artist broadly (used throughout this flow)
        const isSpotifyArtist = (result && result.source === 'spotify') ||
            (apiId && !/^[0-9]+$/.test(String(apiId))) ||
            ((actualResult && actualResult.spotifyUrl && actualResult.spotifyUrl.includes('spotify')) || (actualResult && actualResult.socialMedia && actualResult.socialMedia.includes('spotify')));
        let detailMetadata = null;
        const metaContainer = document.getElementById('apiResultMeta');
        if (metaContainer) {
            metaContainer.classList.remove('hidden');
            metaContainer.innerHTML = '<div class="api-meta-loading">Loading additional details...</div>';
        }

        if (isActorSelection) {
            // Handle Spotify artists differently - they don't need TMDB details

            if (metaContainer) {
                metaContainer.classList.add('hidden');
                metaContainer.innerHTML = '';
            }

            const rolesInput = document.getElementById('itemRoles');
            if (rolesInput) rolesInput.value = '';
            const bioField = document.getElementById('itemBiography');
            if (bioField) bioField.value = '';
            const socialField = document.getElementById('itemSocialMedia');
            if (socialField) socialField.value = '';

            if (apiId && !isSpotifyArtist) {
                const actorDetail = await this.buildTransientItemFromExternal('actors', apiId, {
                    name: actualResult.name || actualResult.title || ''
                });
                if (actorDetail) {
                    if (rolesInput && actorDetail.actorRoles?.length) {
                        rolesInput.value = actorDetail.actorRoles.join(', ');
                    }
                    if (bioField && actorDetail.biography) {
                        bioField.value = this.truncateActorDescription('actors', actorDetail.biography);
                    }
                    if (socialField && actorDetail.socialMedia) {
                        socialField.value = actorDetail.socialMedia;
                    }
                }
            } else if (isSpotifyArtist && apiId) {
                // Fetch Spotify artist details for social media and genres, but DO NOT use Spotify biography.
                // Instead, always prefer TMDB biography (if available).
                const spotifyDetails = await this.getSpotifyArtistDetails(apiId);
                if (spotifyDetails) {
                    if (socialField && spotifyDetails.socialMedia) {
                        socialField.value = spotifyDetails.socialMedia;
                    }
                    // Always set role to Singer for Spotify artists
                    if (rolesInput) {
                        rolesInput.value = 'Singer';
                    }
                }

                // Try to find TMDB person by name and use their biography (never use Spotify bio)
                try {
                    const nameToSearch = actualResult.name || actualResult.title || '';
                    if (nameToSearch) {
                        const searchResp = await apiFetch(`${API_URL}/api/search?query=${encodeURIComponent(nameToSearch)}&category=actors&service=tmdb`);
                        if (searchResp.ok) {
                            const searchData = await searchResp.json();
                            const first = (searchData.results && searchData.results.length) ? searchData.results[0] : null;
                            if (first && first.id) {
                                const tmdbName = first.name || first.title || '';
                                if (this.isNameMatch(nameToSearch, tmdbName)) {
                                    const personResp = await apiFetch(`${API_URL}/api/person/${first.id}`);
                                    if (personResp.ok) {
                                        const personData = await personResp.json();
                                        if (personData && personData.biography && personData.biography.trim()) {
                                            if (bioField) bioField.value = this.truncateActorDescription('actors', personData.biography.trim());
                                        } else {
                                            // TMDB had no biography: leave bioField empty (do not use Spotify biography)
                                            if (bioField) bioField.value = '';
                                        }

                                        // Persist the found TMDB person ID into the external API ID input so image selector and later saves use the TMDB id
                                        const externalApiIdField = document.getElementById('itemExternalApiId');
                                        if (externalApiIdField) {
                                            externalApiIdField.value = first.id;
                                            externalApiIdField.dataset.source = 'tmdb';
                                        }
                                    }
                                } else {
                                    // Candidate didn't match closely enough by name: do not use TMDB person
                                    if (bioField) bioField.value = '';
                                }
                            } else {
                                if (bioField) bioField.value = '';
                            }
                        } else {
                            if (bioField) bioField.value = '';
                        }
                    }
                } catch (err) {
                    console.warn('TMDB biography lookup failed during selection:', err && err.message ? err.message : err);
                    if (bioField) bioField.value = '';
                }
            } else if (isSpotifyArtist) {
                // For Spotify artists without full details, always set role to Singer
                if (rolesInput) {
                    rolesInput.value = 'Singer';
                }
                // Store source in a hidden field or data attribute for saving
                const externalApiIdField = document.getElementById('itemExternalApiId');
                if (externalApiIdField) {
                    externalApiIdField.dataset.source = 'spotify';
                }
            } else if (rolesInput && actualResult.known_for_department) {
                rolesInput.value = this.formatDepartmentLabel(actualResult.known_for_department);
            }
        } else if (['movies', 'tv', 'anime', 'games'].includes(selectionCategory) && apiId) {
            detailMetadata = await this.fetchSelectionDetails(selectionCategory, apiId);
        }

        const runtimeField = document.getElementById('itemRuntime');
        const episodeCountField = document.getElementById('itemEpisodeCount');
        const episodeDurationField = document.getElementById('itemEpisodeDuration');
        const timeToBeatField = document.getElementById('itemTimeToBeat');

        if (runtimeField) runtimeField.value = '';
        if (episodeCountField) episodeCountField.value = '';
        if (episodeDurationField) episodeDurationField.value = '';
        if (timeToBeatField) timeToBeatField.value = '';
        if (runtimeField) runtimeField.parentElement.style.display = (selectionCategory === 'movies') ? 'block' : 'none';
        if (episodeCountField) episodeCountField.parentElement.style.display = (selectionCategory === 'tv' || selectionCategory === 'anime') ? 'block' : 'none';
        if (episodeDurationField) episodeDurationField.parentElement.style.display = (selectionCategory === 'tv' || selectionCategory === 'anime') ? 'block' : 'none';
        if (timeToBeatField) timeToBeatField.parentElement.style.display = (selectionCategory === 'games') ? 'block' : 'none';

        // Populate fields based on tab type
        if (!isActorSelection) {
            // Non-actor fields (movies, TV, anime, games)
            document.getElementById('itemYear').value = actualResult.release_date?.split('-')[0]
                || actualResult.first_air_date?.split('-')[0]
                || actualResult.start_date?.split('-')[0]
                || actualResult.year
                || '';

            // Map TMDB genre_ids to names, or use genres array if available
            let genres = '';
            if (actualResult.genres && Array.isArray(actualResult.genres)) {
                // Support both TMDB format (g.name) and Steam format (g.description) and MAL format
                genres = actualResult.genres.map(g => g.name || g.title || g.description || g).filter(g => g).join(', ');
            } else if (actualResult.genre_ids) {
                genres = this.mapGenreIdsToNames(actualResult.genre_ids);
            }
            document.getElementById('itemGenre').value = genres;

            // For movies/TV, don't set userScore here - server will fetch IMDb rating
            // For other types (anime, games), use the score from the API
            if (this.currentTab === 'movies' || this.currentTab === 'tv') {
                document.getElementById('itemUserScore').value = ''; // Let server fetch IMDb rating
            } else {
                document.getElementById('itemUserScore').value = Math.round(actualResult.vote_average || actualResult.score || 0) || '';
            }

            // Limit description to 466 characters (for everything except actors)
            const fullDescription = actualResult.overview || actualResult.synopsis || '';
            const truncatedDescription = fullDescription.length > 466
                ? fullDescription.substring(0, 466)
                : fullDescription;
            document.getElementById('itemDescription').value = truncatedDescription;

            // Populate Studio/Developer/Director-Creator based on type
            if (this.currentTab === 'anime') {
                const studioField = document.getElementById('itemStudio');
                if (studioField) {
                    // For anime, try to get studios from result (MAL/Jikan format)
                    if (actualResult.studios && Array.isArray(actualResult.studios)) {
                        const studioNames = actualResult.studios.map(s => s.name || s).filter(s => s).join(', ');
                        if (studioNames) {
                            studioField.value = studioNames;
                            console.log('Populated studio from result:', studioNames);
                        }
                    } else if (actualResult.studio) {
                        studioField.value = actualResult.studio;
                        console.log('Populated studio from result.studio:', actualResult.studio);
                    } else {
                        // Try to fetch detailed anime info to get studios
                        const malId = apiId || actualResult.mal_id;
                        if (malId) {
                            console.log('No studio in search result, fetching detailed anime info for mal_id:', malId);
                            this.fetchDetailedAnimeInfo(malId);
                        } else {
                            console.log('No mal_id found, cannot fetch studio info');
                        }
                    }
                    if (!studioField.value && detailMetadata?.studios && Array.isArray(detailMetadata.studios)) {
                        const studioNames = detailMetadata.studios.map(s => s.name || s).filter(s => s).join(', ');
                        if (studioNames) {
                            studioField.value = studioNames;
                            console.log('Populated studio from metadata:', studioNames);
                        }
                    }
                }
                if (episodeCountField) {
                    const base = actualResult.node || actualResult;
                    const episodes = detailMetadata?.num_episodes ?? base?.num_episodes ?? null;
                    episodeCountField.value = episodes != null ? `${episodes}` : '';
                    episodeCountField.parentElement.style.display = episodes != null ? 'block' : 'none';
                    // Store in hidden field for persistence
                    const hiddenField = document.getElementById('itemEpisodeCountHidden');
                    if (hiddenField) {
                        hiddenField.value = episodes != null ? episodes.toString() : '';
                    }
                }
                if (episodeDurationField) {
                    const base = actualResult.node || actualResult;
                    const fallbackRuntimes = base?.average_episode_duration_minutes
                        ? [base.average_episode_duration_minutes]
                        : (base?.average_episode_duration ? [parseFloat((base.average_episode_duration / 60).toFixed(1))] : []);
                    const runtimeInfo = this.getEpisodeRuntimeInfo(detailMetadata, fallbackRuntimes);
                    episodeDurationField.value = runtimeInfo.formatted || '';
                    episodeDurationField.parentElement.style.display = runtimeInfo.formatted ? 'block' : 'none';
                    // Store minutes in hidden field for persistence
                    const hiddenField = document.getElementById('itemEpisodeRuntimeMinutesHidden');
                    if (hiddenField && runtimeInfo.averageMinutes != null) {
                        hiddenField.value = runtimeInfo.averageMinutes.toString();
                    }
                }
            } else if (this.currentTab === 'games') {
                const developerField = document.getElementById('itemDeveloper');
                if (developerField) {
                    // Clear any existing value first
                    developerField.value = '';

                    // For games, try to get developers from result
                    if (actualResult.developers && Array.isArray(actualResult.developers) && actualResult.developers.length > 0) {
                        // Handle both string arrays and object arrays
                        const devNames = actualResult.developers.map(d => {
                            if (typeof d === 'string') return d;
                            return d.name || d.description || d;
                        }).filter(d => d).join(', ');
                        if (devNames) {
                            developerField.value = devNames;
                            console.log('Populated developer from result:', devNames);
                        }
                    } else if (actualResult.developer) {
                        developerField.value = actualResult.developer;
                        console.log('Populated developer from result.developer:', actualResult.developer);
                    } else if (actualResult.developed_by && Array.isArray(actualResult.developed_by)) {
                        const devNames = actualResult.developed_by.map(d => d.name || d).filter(d => d).join(', ');
                        if (devNames) {
                            developerField.value = devNames;
                            console.log('Populated developer from developed_by:', devNames);
                        }
                    } else {
                        // Try to fetch detailed game info to get developers
                        const gameId = apiId || actualResult.id;
                        if (gameId) {
                            if (!developerField.value && detailMetadata?.developers && Array.isArray(detailMetadata.developers) && detailMetadata.developers.length > 0) {
                                const devNames = detailMetadata.developers.map(d => {
                                    if (typeof d === 'string') return d;
                                    return d.name || d.description || d;
                                }).filter(Boolean).join(', ');
                                if (devNames) {
                                    developerField.value = devNames;
                                    console.log('Populated developer from metadata:', devNames);
                                }
                            }

                            if (!developerField.value) {
                                console.log('No developer in search result, fetching detailed game info for game_id:', gameId);
                                this.fetchGameDeveloper(gameId, developerField);
                            }
                        } else {
                            console.log('No game ID found, cannot fetch developer info');
                        }
                    }

                    if (timeToBeatField) {
                        const timeInfo = this.getTimeToBeatInfo(detailMetadata?.time_to_beat);
                        if (timeInfo.formatted) {
                            timeToBeatField.value = timeInfo.formatted;
                            timeToBeatField.parentElement.style.display = 'block';
                            // Store the minutes value in hidden field for persistence
                            const hiddenField = document.getElementById('itemTimeToBeatAverageHidden');
                            if (hiddenField && timeInfo.averageMinutes != null) {
                                hiddenField.value = timeInfo.averageMinutes.toString();
                            }
                        } else {
                            timeToBeatField.value = '';
                            timeToBeatField.parentElement.style.display = 'none';
                            const hiddenField = document.getElementById('itemTimeToBeatAverageHidden');
                            if (hiddenField) {
                                hiddenField.value = '';
                            }
                        }
                    }
                }
            } else if (this.currentTab === 'tv' || this.currentTab === 'movies') {
                const directorCreatorField = document.getElementById('itemDirectorCreator');
                if (directorCreatorField) {
                    // Clear any existing value first
                    directorCreatorField.value = '';

                    // For TV/Movies, try to get director/creator from result
                    // TV shows have created_by
                    if (actualResult.created_by && Array.isArray(actualResult.created_by) && actualResult.created_by.length > 0) {
                        const creatorNames = actualResult.created_by.map(c => c.name).filter(c => c).join(', ');
                        if (creatorNames) {
                            directorCreatorField.value = creatorNames;
                            console.log('Populated director/creator from created_by:', creatorNames);
                        }
                    } else if (actualResult.director) {
                        // Only use if it's a string (not from a previous movie)
                        if (typeof actualResult.director === 'string' && actualResult.director.trim()) {
                            directorCreatorField.value = actualResult.director;
                            console.log('Populated director from result.director:', actualResult.director);
                        }
                    } else if (actualResult.crew && Array.isArray(actualResult.crew)) {
                        // Try to find director in crew - STRICT filtering for Director job only
                        console.log('Searching crew for Director. Available jobs:', [...new Set(actualResult.crew.map(c => c.job))]);
                        const directors = actualResult.crew
                            .filter(c => {
                                const job = (c.job || '').toLowerCase();
                                return job === 'director' || job === 'co-director';
                            })
                            .map(c => ({
                                name: c.name,
                                order: c.order || 999,
                                popularity: c.popularity || 0
                            }))
                            .sort((a, b) => {
                                if (a.order !== b.order) return a.order - b.order;
                                return b.popularity - a.popularity;
                            })
                            .map(c => c.name)
                            .filter(c => c);

                        if (directors.length > 0) {
                            // Take only the primary director(s)
                            directorCreatorField.value = directors.slice(0, 3).join(', ');
                            console.log('Populated director from crew:', directors.slice(0, 3).join(', '));
                            console.log('All Director entries:', actualResult.crew.filter(c => (c.job || '').toLowerCase() === 'director'));
                        } else {
                            console.log('No Director found in crew array. Crew entries:', actualResult.crew.slice(0, 10));
                            // Don't use producers as fallback - wait for API fetch instead
                        }
                    } else {
                        console.log('No director/creator information found in result, attempting to fetch detailed info');
                        // Try to fetch detailed info (but don't wait for it - it may not be available)
                        const itemId = apiId || actualResult.id || result.id;
                        if (itemId) {
                            this.fetchDetailedMovieTvInfo(itemId).catch(() => {
                                // Ignore errors - this is optional enhancement
                            });
                        }
                    }
                }

                if (this.currentTab === 'movies' && runtimeField) {
                    const runtime = detailMetadata?.runtime_minutes ?? detailMetadata?.runtime ?? null;
                    if (runtime != null) {
                        const hours = Math.floor(runtime / 60);
                        const minutes = runtime % 60;
                        const formatted = hours ? `${hours}h ${minutes}m` : `${minutes}m`;
                        runtimeField.value = formatted;
                        runtimeField.dataset.minutes = runtime;
                        runtimeField.parentElement.style.display = 'block';
                        // Store minutes in hidden field for persistence
                        const hiddenField = document.getElementById('itemRuntimeMinutesHidden');
                        if (hiddenField) {
                            hiddenField.value = runtime.toString();
                        }
                    } else if (runtimeField.dataset.minutes) {
                        const runtimeMinutes = parseInt(runtimeField.dataset.minutes, 10);
                        if (Number.isFinite(runtimeMinutes)) {
                            const hours = Math.floor(runtimeMinutes / 60);
                            const minutes = runtimeMinutes % 60;
                            runtimeField.value = hours ? `${hours}h ${minutes}m` : `${minutes}m`;
                            runtimeField.parentElement.style.display = 'block';
                            // Store in hidden field
                            const hiddenField = document.getElementById('itemRuntimeMinutesHidden');
                            if (hiddenField) {
                                hiddenField.value = runtimeMinutes.toString();
                            }
                        } else {
                            runtimeField.value = '';
                            runtimeField.parentElement.style.display = 'none';
                            delete runtimeField.dataset.minutes;
                            const hiddenField = document.getElementById('itemRuntimeMinutesHidden');
                            if (hiddenField) {
                                hiddenField.value = '';
                            }
                        }
                        delete runtimeField.dataset.minutes;
                    } else {
                        runtimeField.value = '';
                        runtimeField.parentElement.style.display = 'none';
                        delete runtimeField.dataset.minutes;
                        const hiddenField = document.getElementById('itemRuntimeMinutesHidden');
                        if (hiddenField) {
                            hiddenField.value = '';
                        }
                    }
                }

                if (this.currentTab === 'tv') {
                    if (episodeCountField) {
                        const episodes = detailMetadata?.episode_count ?? detailMetadata?.number_of_episodes ?? actualResult?.number_of_episodes ?? null;
                        episodeCountField.value = episodes != null ? `${episodes}` : '';
                        episodeCountField.parentElement.style.display = episodes != null ? 'block' : 'none';
                        // Store in hidden field for persistence
                        const hiddenField = document.getElementById('itemEpisodeCountHidden');
                        if (hiddenField) {
                            hiddenField.value = episodes != null ? episodes.toString() : '';
                        }
                    }
                    if (episodeDurationField) {
                        const fallbackRuntimes = [];
                        if (Array.isArray(actualResult?.episode_run_time)) {
                            fallbackRuntimes.push(...actualResult.episode_run_time.filter(Number.isFinite));
                        } else if (Number.isFinite(actualResult?.episode_run_time)) {
                            fallbackRuntimes.push(actualResult.episode_run_time);
                        }
                        if (Array.isArray(actualResult?.episode_runtime_minutes)) {
                            fallbackRuntimes.push(...actualResult.episode_runtime_minutes.filter(Number.isFinite));
                        } else if (Number.isFinite(actualResult?.episode_runtime_minutes)) {
                            fallbackRuntimes.push(actualResult.episode_runtime_minutes);
                        }
                        const runtimeInfo = this.getEpisodeRuntimeInfo(detailMetadata, fallbackRuntimes);
                        episodeDurationField.value = runtimeInfo.formatted || '';
                        episodeDurationField.parentElement.style.display = runtimeInfo.formatted ? 'block' : 'none';
                        // Store minutes in hidden field for persistence
                        const hiddenField = document.getElementById('itemEpisodeRuntimeMinutesHidden');
                        if (hiddenField && runtimeInfo.averageMinutes != null) {
                            hiddenField.value = runtimeInfo.averageMinutes.toString();
                        }
                    }
                }
            }
        } else {
            if (result.biography) {
                document.getElementById('itemBiography').value = this.truncateActorDescription('actors', result.biography);
            }
            // Only fetch TMDB actor details (which may populate IMDb links) when NOT a Spotify artist
            if (!isSpotifyArtist) {
                this.fetchActorDetails(apiId || result.id);
            }

            if (runtimeField) runtimeField.value = '';
            if (episodeCountField) episodeCountField.value = '';
            if (episodeDurationField) episodeDurationField.value = '';
            if (timeToBeatField) timeToBeatField.value = '';
        }

        // Check for auto-match collection for all types (tv, movies, anime, games)
        if (!isActorSelection) {
            this.checkAndShowCollectionAutoMatch(actualResult.title || actualResult.name || '');
        }

        this.renderSelectionMetadata(selectionCategory, detailMetadata, actualResult);

        // Switch to manual tab and prepopulate poster
        this.showManualTab();

        // If there's a poster, download and convert to base64
        let posterPath = null;
        if (this.currentTab === 'anime' && actualResult.main_picture) {
            // MAL format: main_picture.medium or main_picture.large
            posterPath = actualResult.main_picture.large || actualResult.main_picture.medium || actualResult.main_picture;
        } else if (this.currentTab === 'anime' && actualResult.images) {
            // Jikan format: images.jpg.large_image_url or images.jpg.image_url
            posterPath = actualResult.images?.jpg?.large_image_url || actualResult.images?.jpg?.image_url;
        } else if (result.source === 'spotify' && result.posterPath) {
            // Spotify format: direct URL
            posterPath = result.posterPath;
        } else if (result.poster_path || result.profile_path || actualResult.poster_path) {
            // TMDB format
            posterPath = result.profile_path || result.poster_path || actualResult.poster_path;
        }

        if (posterPath) {
            const posterUrl = posterPath.startsWith('http')
                ? posterPath
                : `https://image.tmdb.org/t/p/w500${posterPath}`;

            document.getElementById('posterPreview').innerHTML = '<p>Loading poster...</p>';

            try {
                const base64 = await this.urlToBase64(posterUrl);
                document.getElementById('posterPreview').innerHTML = `<img src="${base64}" alt="Poster" style="width:100%;height:auto;border-radius:8px;">`;
                document.getElementById('posterPreview').dataset.base64 = base64;
            } catch (error) {
                console.error('Error loading poster:', error);
                document.getElementById('posterPreview').innerHTML = '';
            }
        }
    }

    async populateDetailExtraMeta(item) {
        const container = document.getElementById('detailExtraMeta');
        if (!container) return;

        // Always hide extra meta for games (do not render this section)
        if (item && item.type === 'games') {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        container.innerHTML = '';
        container.style.display = 'none';

        const typeToCategoryMap = {
            movies: 'movies',
            tv: 'tv',
            anime: 'anime',
            games: 'Games',
            music: 'Music'
        };

        const category = typeToCategoryMap[item.type];

        // Add category specific class for styling
        container.className = 'detail-extra-meta';
        if (category) {
            container.classList.add(`detail-extra-meta-${category}`);
        }

        // Build rows from persisted database values only
        const rows = [];

        const creatorRows = [];
        if (item.type === 'movies' && item.directorCreator && item.directorCreator.trim()) {
            creatorRows.push({ label: 'Director/Creator', value: item.directorCreator.trim() });
        } else if (item.type === 'tv' && item.directorCreator && item.directorCreator.trim()) {
            creatorRows.push({ label: 'Creator', value: item.directorCreator.trim() });
        } else if (item.type === 'anime' && item.studio && item.studio.trim()) {
            creatorRows.push({ label: 'Studio', value: item.studio.trim() });
        } else if (item.type === 'games' && item.developer && item.developer.trim()) {
            creatorRows.push({ label: 'Developer', value: item.developer.trim() });
        }

        if (category === 'movies' && item.runtime) {
            const runtimeMinutes = parseInt(item.runtime);
            if (!isNaN(runtimeMinutes)) {
                const formatted = this.formatRuntimeFromMinutes(runtimeMinutes);
                if (formatted) {
                    rows.push({ label: 'Runtime', value: formatted });
                }
            }
        } else if ((category === 'tv' || category === 'anime') && (item.episodes || item.episodeRuntime)) {
            if (item.episodes) {
                const episodes = parseInt(item.episodes);
                if (!isNaN(episodes)) {
                    rows.push({ label: 'Episodes', value: `${episodes}` });
                }
            }
            if (item.episodeRuntime) {
                const episodeRuntimeMinutes = parseInt(item.episodeRuntime);
                if (!isNaN(episodeRuntimeMinutes)) {
                    const formatted = this.formatRuntimeFromMinutes(episodeRuntimeMinutes);
                    if (formatted) {
                        rows.push({ label: 'Episode Runtime', value: formatted });
                    }
                }
            }
        } else if (category === 'games' && item.timeToBeat) {
            const timeToBeatMinutes = parseInt(item.timeToBeat);
            if (!isNaN(timeToBeatMinutes)) {
                const timeInfo = this.getTimeToBeatInfo({ average_minutes: timeToBeatMinutes });
                if (timeInfo.formatted) {
                    rows.push({ label: 'Time to Beat', value: timeInfo.formatted });
                }
            }
        }

        rows.unshift(...creatorRows);

        const allowedLabelsByCategory = {
            movies: ['Director/Creator'],
            tv: ['Creator'],
            anime: ['Studio'],
            games: ['Time to Beat']
        };

        const allowedLabels = allowedLabelsByCategory[category];
        const visibleRows = allowedLabels
            ? rows.filter(row => allowedLabels.includes(row.label))
            : rows;

        // Display persisted data if available, otherwise leave empty
        if (visibleRows.length > 0) {
            container.innerHTML = visibleRows.map(row => {
                const labelSlug = row.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                return `
                <div class="detail-extra-row detail-extra-row-${labelSlug}">
                    <span class="detail-extra-label">${row.label}</span>
                    <span class="detail-extra-value">${row.value}</span>
                </div>
            `}).join('');
            container.style.display = 'grid';
        }
    }

    async fetchAndUpdateStudio(itemId, malId) {
        // Fetch studio info and update the item in the database
        try {
            console.log('Fetching studio for anime mal_id:', malId);
            const response = await fetch(`https://api.jikan.moe/v4/anime/${malId}/full`);
            if (!response.ok) {
                console.warn('Could not fetch anime info:', response.status);
                return '';
            }

            const data = await response.json();
            const details = data.data || data;

            let studioValue = '';
            if (details.studios && Array.isArray(details.studios) && details.studios.length > 0) {
                studioValue = details.studios.map(s => s.name || s).filter(s => s).join(', ');
            } else if (details.studio) {
                studioValue = details.studio;
            }

            // If we found studio info, update the item in the database
            if (studioValue && studioValue.trim()) {
                try {
                    const updateResponse = await apiFetch(`${API_URL}/update`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            id: itemId,
                            studio: studioValue.trim()
                        })
                    });
                    if (updateResponse.ok) {
                        // Update local data
                        const item = this.data.items.find(i => i.id === itemId);
                        if (item) {
                            item.studio = studioValue.trim();
                        }
                        console.log('✅ Updated studio in database:', studioValue.trim());
                    }
                } catch (updateError) {
                    console.error('Error updating item in database:', updateError);
                }
            }

            return studioValue;
        } catch (error) {
            console.error('Error fetching and updating studio info:', error);
            return '';
        }
    }

    async fetchGameDeveloper(gameId, developerField) {
        // Fetch developer info and populate the form field (used when adding new item)
        try {
            console.log('Fetching developer for game_id:', gameId);

            try {
                const serverResponse = await apiFetch(`${API_URL}/api/details?category=games&id=${gameId}`);
                console.log('Developer fetch response status:', serverResponse.status, serverResponse.ok);

                if (serverResponse.ok) {
                    const contentType = serverResponse.headers.get('content-type');
                    console.log('Response content-type:', contentType);

                    if (contentType && contentType.includes('application/json')) {
                        const gameData = await serverResponse.json();
                        console.log('Game data received:', gameData);
                        console.log('Developers array:', gameData.developers);

                        let developerValue = '';
                        if (gameData.developers && Array.isArray(gameData.developers) && gameData.developers.length > 0) {
                            // Handle both string arrays and object arrays
                            developerValue = gameData.developers.map(d => {
                                if (typeof d === 'string') return d;
                                return d.name || d.description || d;
                            }).filter(d => d).join(', ');
                            console.log('Extracted developer value:', developerValue);
                        } else if (gameData.developer) {
                            developerValue = Array.isArray(gameData.developer)
                                ? gameData.developer.map(d => d.name || d).join(', ')
                                : gameData.developer;
                            console.log('Using gameData.developer:', developerValue);
                        } else if (gameData.developed_by) {
                            developerValue = Array.isArray(gameData.developed_by)
                                ? gameData.developed_by.map(d => d.name || d).join(', ')
                                : gameData.developed_by;
                            console.log('Using gameData.developed_by:', developerValue);
                        } else {
                            console.log('⚠️ No developer information found in gameData');
                        }

                        if (developerValue && developerValue.trim() && developerField) {
                            developerField.value = developerValue.trim();
                            console.log('✅ Populated developer field:', developerValue.trim());
                        } else {
                            console.log('⚠️ Developer field not populated. Value:', developerValue, 'Field:', developerField);
                        }
                    } else {
                        console.error('⚠️ Response is not JSON. Content-Type:', contentType);
                        const text = await serverResponse.text();
                        console.log('Response text:', text.substring(0, 200));
                    }
                } else {
                    const errorText = await serverResponse.text();
                    console.error('⚠️ Server response not OK:', serverResponse.status, errorText);
                }
            } catch (serverError) {
                console.error('❌ Error fetching developer info:', serverError);
            }
        } catch (error) {
            console.error('❌ Error in fetchGameDeveloper:', error);
        }
    }

    async fetchAndUpdateDeveloper(itemId, gameId) {
        // Fetch developer info and update the item in the database
        try {
            console.log('Fetching developer for game_id:', gameId);

            // Try server proxy endpoint first
            let developerValue = '';
            try {
                const serverResponse = await apiFetch(`${API_URL}/api/details?category=games&id=${gameId}`);
                if (serverResponse.ok) {
                    const contentType = serverResponse.headers.get('content-type');
                    if (contentType && contentType.includes('application/json')) {
                        const gameData = await serverResponse.json();

                        if (gameData.developers && Array.isArray(gameData.developers) && gameData.developers.length > 0) {
                            // Handle both string arrays and object arrays
                            developerValue = gameData.developers.map(d => {
                                if (typeof d === 'string') return d;
                                return d.name || d.description || d;
                            }).filter(d => d).join(', ');
                        } else if (gameData.developer) {
                            developerValue = Array.isArray(gameData.developer)
                                ? gameData.developer.map(d => d.name || d).join(', ')
                                : gameData.developer;
                        } else if (gameData.developed_by) {
                            developerValue = Array.isArray(gameData.developed_by)
                                ? gameData.developed_by.map(d => d.name || d).join(', ')
                                : gameData.developed_by;
                        }
                    }
                }
            } catch (serverError) {
                console.log('Server endpoint not available, trying alternative methods');
            }

            // If we found developer info, update the item in the database
            if (developerValue && developerValue.trim()) {
                try {
                    const updateResponse = await apiFetch(`${API_URL}/update`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            id: itemId,
                            developer: developerValue.trim()
                        })
                    });
                    if (updateResponse.ok) {
                        // Update local data
                        const item = this.data.items.find(i => i.id === itemId);
                        if (item) {
                            item.developer = developerValue.trim();
                        }
                        console.log('✅ Updated developer in database:', developerValue.trim());
                    }
                } catch (updateError) {
                    console.error('Error updating item in database:', updateError);
                }
            }

            return developerValue;
        } catch (error) {
            console.error('Error fetching and updating developer info:', error);
            return '';
        }
    }

    async fetchDetailedAnimeInfo(malId) {
        // Fetch detailed anime info from Jikan API to get studios
        try {
            console.log('Fetching anime details for mal_id:', malId);
            const response = await fetch(`https://api.jikan.moe/v4/anime/${malId}/full`);
            if (!response.ok) {
                console.warn('Could not fetch detailed anime info:', response.status, response.statusText);
                return;
            }

            const data = await response.json();
            const details = data.data || data;

            console.log('Fetched anime details:', details);

            // Populate studio field if not already set
            const studioField = document.getElementById('itemStudio');
            if (studioField) {
                if (studioField.value) {
                    console.log('Studio field already has value:', studioField.value);
                    return;
                }

                if (details.studios && Array.isArray(details.studios) && details.studios.length > 0) {
                    const studioNames = details.studios.map(s => s.name || s).filter(s => s).join(', ');
                    if (studioNames) {
                        studioField.value = studioNames;
                        console.log('Populated studio from Jikan API:', studioNames);
                    }
                } else if (details.studio) {
                    studioField.value = details.studio;
                    console.log('Populated studio from details.studio:', details.studio);
                } else {
                    console.log('No studio information found in anime details');
                }
            } else {
                console.error('Studio field not found in DOM');
            }
        } catch (error) {
            console.error('Error fetching detailed anime info:', error);
        }
    }

    async fetchAndUpdateDirectorCreator(itemId, externalApiId, itemType) {
        // Fetch director/creator info and update the item in the database
        try {
            const category = itemType === 'tv' ? 'tv' : 'movie';
            let directorCreatorValue = '';

            // Try to fetch credits/crew from TMDB via the server's cast endpoint
            try {
                const castResponse = await apiFetch(`${API_URL}/api/cast?category=${category}&id=${externalApiId}`);
                if (castResponse.ok) {
                    const castData = await castResponse.json();

                    if (castData.crew && Array.isArray(castData.crew)) {
                        const directors = castData.crew
                            .filter(c => c.job === 'Director' || c.job === 'Co-Director')
                            .map(c => ({
                                name: c.name,
                                order: c.order || 999,
                                popularity: c.popularity || 0
                            }))
                            .sort((a, b) => {
                                if (a.order !== b.order) return a.order - b.order;
                                return b.popularity - a.popularity;
                            })
                            .map(c => c.name)
                            .filter(c => c);
                        if (directors.length > 0) {
                            directorCreatorValue = directors.slice(0, 3).join(', ');
                        }
                    }
                }
            } catch (castError) {
                console.log('Cast endpoint did not return crew data');
            }

            // If server endpoints don't work, try fetching from TMDB API directly
            if (!directorCreatorValue) {
                const tmdbApiKey = this.data.settings.tmdbApiKey;
                if (tmdbApiKey) {
                    if (itemType === 'tv') {
                        const tvDetailsResponse = await fetch(`https://api.themoviedb.org/3/tv/${externalApiId}?api_key=${tmdbApiKey}`);
                        if (tvDetailsResponse.ok) {
                            const tvDetails = await tvDetailsResponse.json();
                            if (tvDetails.created_by && Array.isArray(tvDetails.created_by) && tvDetails.created_by.length > 0) {
                                directorCreatorValue = tvDetails.created_by.map(c => c.name).filter(c => c).join(', ');
                            }
                        }
                    } else if (itemType === 'movies') {
                        const creditsResponse = await fetch(`https://api.themoviedb.org/3/movie/${externalApiId}/credits?api_key=${tmdbApiKey}`);
                        if (creditsResponse.ok) {
                            const creditsData = await creditsResponse.json();
                            if (creditsData.crew && Array.isArray(creditsData.crew)) {
                                const directors = creditsData.crew
                                    .filter(c => c.job === 'Director' || c.job === 'Co-Director')
                                    .map(c => ({
                                        name: c.name,
                                        order: c.order || 999,
                                        popularity: c.popularity || 0
                                    }))
                                    .sort((a, b) => {
                                        if (a.order !== b.order) return a.order - b.order;
                                        return b.popularity - a.popularity;
                                    })
                                    .map(c => c.name)
                                    .filter(c => c);
                                if (directors.length > 0) {
                                    directorCreatorValue = directors.slice(0, 3).join(', ');
                                }
                            }
                        }
                    }
                }
            }

            // If we found director/creator info, update the item in the database
            if (directorCreatorValue && directorCreatorValue.trim()) {
                try {
                    const updateResponse = await apiFetch(`${API_URL}/update`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            id: itemId,
                            directorCreator: directorCreatorValue.trim()
                        })
                    });
                    if (updateResponse.ok) {
                        // Update local data
                        const item = this.data.items.find(i => i.id === itemId);
                        if (item) {
                            item.directorCreator = directorCreatorValue.trim();
                        }
                        console.log('✅ Updated directorCreator in database:', directorCreatorValue.trim());
                    }
                } catch (updateError) {
                    console.error('Error updating item in database:', updateError);
                }
            }

            return directorCreatorValue;
        } catch (error) {
            console.error('Error fetching and updating director/creator info:', error);
            return '';
        }
    }

    async fetchDetailedMovieTvInfo(itemId) {
        // Fetch crew/director info from TMDB API directly using the cast endpoint pattern
        // Since /api/details doesn't exist, we'll try using the cast endpoint and extract crew from there
        // Or we can try fetching from TMDB directly
        try {
            const category = this.currentTab === 'tv' ? 'tv' : 'movie';
            const directorCreatorField = document.getElementById('itemDirectorCreator');

            if (!directorCreatorField) {
                // Field doesn't exist
                return;
            }

            // If field already has a value, check if it looks like it's from wrong movie
            // If it's already populated with a valid director, we might want to keep it
            // But if it's clearly wrong (e.g., from previous movie), clear it
            if (directorCreatorField.value && directorCreatorField.value.trim()) {
                console.log('Director field already has value:', directorCreatorField.value);
                // We'll still try to fetch and update with correct value
            }

            // Try to fetch credits/crew from TMDB via the server's cast endpoint (which might include crew)
            try {
                const castResponse = await apiFetch(`${API_URL}/api/cast?category=${category}&id=${itemId}`);
                if (castResponse.ok) {
                    const castData = await castResponse.json();

                    // Check if crew data is included
                    if (castData.crew && Array.isArray(castData.crew)) {
                        // Filter strictly for Director job only
                        const directors = castData.crew
                            .filter(c => c.job === 'Director' || c.job === 'Co-Director')
                            .map(c => ({
                                name: c.name,
                                order: c.order || 999,
                                popularity: c.popularity || 0
                            }))
                            .sort((a, b) => {
                                if (a.order !== b.order) return a.order - b.order;
                                return b.popularity - a.popularity;
                            })
                            .map(c => c.name)
                            .filter(c => c);
                        if (directors.length > 0) {
                            directorCreatorField.value = directors.slice(0, 3).join(', ');
                            console.log('Populated director from cast API crew:', directors.slice(0, 3).join(', '));
                            console.log('All Director jobs from cast API:', castData.crew.filter(c => c.job === 'Director'));
                            return;
                        } else {
                            console.log('Cast API crew jobs:', [...new Set(castData.crew.map(c => c.job))]);
                        }
                    }
                }
            } catch (castError) {
                console.log('Cast endpoint did not return crew data');
            }

            // If server endpoints don't work, try fetching from TMDB API directly
            // This requires the TMDB API key from settings
            const tmdbApiKey = this.data.settings.tmdbApiKey;
            if (!tmdbApiKey) {
                console.log('TMDB API key not available, cannot fetch director info directly');
                return;
            }

            const tmdbEndpoint = this.currentTab === 'tv'
                ? `https://api.themoviedb.org/3/tv/${itemId}/credits?api_key=${tmdbApiKey}`
                : `https://api.themoviedb.org/3/movie/${itemId}/credits?api_key=${tmdbApiKey}`;

            const tmdbResponse = await fetch(tmdbEndpoint);
            if (!tmdbResponse.ok) {
                console.log('Failed to fetch from TMDB API:', tmdbResponse.status);
                return;
            }

            const tmdbData = await tmdbResponse.json();

            if (this.currentTab === 'tv') {
                // TV shows: use created_by (need to fetch from /tv/{id} endpoint instead)
                const tvDetailsResponse = await fetch(`https://api.themoviedb.org/3/tv/${itemId}?api_key=${tmdbApiKey}`);
                if (tvDetailsResponse.ok) {
                    const tvDetails = await tvDetailsResponse.json();
                    if (tvDetails.created_by && Array.isArray(tvDetails.created_by) && tvDetails.created_by.length > 0) {
                        const creatorNames = tvDetails.created_by.map(c => c.name).filter(c => c).join(', ');
                        if (creatorNames) {
                            directorCreatorField.value = creatorNames;
                            console.log('Populated creator from TMDB API created_by:', creatorNames);
                            return;
                        }
                    }
                }
            } else if (this.currentTab === 'movies') {
                // Movies: use director from crew
                if (tmdbData.crew && Array.isArray(tmdbData.crew)) {
                    // Filter for Directors only, and sort by order/relevance (Director usually comes first)
                    // Exclude producers, writers, etc. - only actual Directors
                    const directors = tmdbData.crew
                        .filter(c => c.job === 'Director' || c.job === 'Co-Director')
                        .map(c => ({
                            name: c.name,
                            order: c.order || 999,
                            popularity: c.popularity || 0
                        }))
                        .sort((a, b) => {
                            // Sort by order first, then by popularity
                            if (a.order !== b.order) return a.order - b.order;
                            return b.popularity - a.popularity;
                        })
                        .map(c => c.name)
                        .filter(c => c);

                    if (directors.length > 0) {
                        // Take the primary director(s) - usually just the first one or co-directors
                        directorCreatorField.value = directors.slice(0, 3).join(', ');
                        console.log('Populated director from TMDB API crew:', directors.slice(0, 3).join(', '));
                        console.log('All crew members with Director job:', tmdbData.crew.filter(c => c.job === 'Director'));
                        return;
                    } else {
                        console.log('No Directors found in crew. Crew jobs:', [...new Set(tmdbData.crew.map(c => c.job))]);
                    }
                }
            }

            console.log('No director/creator found even after fetching from TMDB API');
        } catch (error) {
            console.error('Error fetching detailed movie/TV info:', error);
        }
    }

    async fetchActorDetails(personId) {
        // Fetch detailed actor info from TMDB person endpoint
        try {
            const response = await apiFetch(`${API_URL}/api/person/${personId}`);
            if (!response.ok) {
                console.warn('Could not fetch detailed actor info');
                return;
            }

            const details = await response.json();

            // Populate biography if not already set
            if (!document.getElementById('itemBiography').value && details.biography) {
                document.getElementById('itemBiography').value = this.truncateActorDescription('actors', details.biography);
            }

            // Get social media links from external_ids
            if (details.external_ids) {
                const socialLinks = [];
                if (details.external_ids.facebook_id) {
                    socialLinks.push(`https://www.facebook.com/${details.external_ids.facebook_id}`);
                }
                if (details.external_ids.twitter_id) {
                    socialLinks.push(`https://twitter.com/${details.external_ids.twitter_id}`);
                }
                if (details.external_ids.instagram_id) {
                    socialLinks.push(`https://www.instagram.com/${details.external_ids.instagram_id}`);
                }
                if (details.external_ids.imdb_id) {
                    socialLinks.push(`https://www.imdb.com/name/${details.external_ids.imdb_id}`);
                }

                if (socialLinks.length > 0) {
                    document.getElementById('itemSocialMedia').value = socialLinks.join(', ');
                }
            }
        } catch (error) {
            console.error('Error fetching actor details:', error);
        }
    }

    // Compress image base64 to max 1MB if larger
    async compressImageIfNeeded(base64, maxSizeBytes = 1000000) {
        // Calculate base64 size (approximate: base64 is ~33% larger than binary)
        // More accurate: remove data:image/xxx;base64, prefix and calculate
        const base64Data = base64.includes(',') ? base64.split(',')[1] : base64;
        const base64Size = (base64Data.length * 3) / 4;

        // If already under limit, return as-is
        if (base64Size <= maxSizeBytes) {
            return base64;
        }

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                // Calculate initial scale to get close to target size
                // Estimate: jpeg at 0.8 quality needs about (width * height * 0.002) bytes
                let targetRatio = 1;
                let estimatedSize = width * height * 0.002;

                if (estimatedSize > maxSizeBytes) {
                    targetRatio = Math.sqrt(maxSizeBytes / estimatedSize) * 0.9; // 0.9 safety margin
                }

                width = Math.floor(width * targetRatio);
                height = Math.floor(height * targetRatio);

                // Ensure minimum dimensions
                if (width < 100) width = 100;
                if (height < 100) height = 100;

                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // Try different quality levels to get under 1MB
                const qualities = [0.8, 0.7, 0.6, 0.5, 0.4, 0.3];

                const tryQuality = (index) => {
                    if (index >= qualities.length) {
                        // If all qualities fail, use the smallest one
                        resolve(canvas.toDataURL('image/jpeg', 0.3));
                        return;
                    }

                    const quality = qualities[index];
                    const compressed = canvas.toDataURL('image/jpeg', quality);
                    const compressedData = compressed.split(',')[1];
                    const compressedSize = (compressedData.length * 3) / 4;

                    if (compressedSize <= maxSizeBytes) {
                        resolve(compressed);
                    } else {
                        // Try next lower quality
                        tryQuality(index + 1);
                    }
                };

                tryQuality(0);
            };
            img.onerror = reject;
            img.src = base64;
        });
    }

    async urlToBase64(url) {
        // If it's a TMDB, Steam, SteamGridDB, or Fanart.tv image URL, proxy through our server to avoid CORS
        let fetchUrl = url;
        if (url.startsWith('https://image.tmdb.org/')) {
            fetchUrl = `${API_URL}/api/tmdb-image?url=${encodeURIComponent(url)}`;
        } else if (url.startsWith('https://cdn.akamai.steamstatic.com/') || url.startsWith('http://media.steampowered.com/')) {
            fetchUrl = `${API_URL}/api/steam-image?url=${encodeURIComponent(url)}`;
        } else if (url.includes('steamgriddb.com')) {
            fetchUrl = `${API_URL}/api/steamgriddb-image?url=${encodeURIComponent(url)}`;
        } else if (url.includes('fanart.tv') || url.includes('assets.fanart.tv')) {
            fetchUrl = `${API_URL}/api/fanarttv-image?url=${encodeURIComponent(url)}`;
        }

        const response = await fetch(fetchUrl);
        const blob = await response.blob();
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });

        // Compress if needed before returning
        return await this.compressImageIfNeeded(base64);
    }

    // ---------- LINKED MOVIES SEARCH ----------
    async searchLinkedMovies() {
        const query = document.getElementById('linkedMoviesSearchInput').value.trim();
        if (!query) {
            alert('Please enter a search term');
            return;
        }

        const resultsDiv = document.getElementById('linkedMoviesResults');
        resultsDiv.innerHTML = '<p>Searching...</p>';

        try {
            // Search in local movies and tv items
            const localMovies = this.data.items.filter(item =>
                (item.type === 'movies' || item.type === 'tv') &&
                item.name.toLowerCase().includes(query.toLowerCase())
            );

            // Map local items to the format expected by displayLinkedMoviesResults
            const allResults = localMovies.map(item => ({
                id: item.id,
                title: item.name,
                poster_path: item.posterBase64,
                category: item.type,
                year: item.year
            }));

            this.displayLinkedMoviesResults(allResults, resultsDiv);
        } catch (error) {
            console.error('Linked movies search error:', error);
            resultsDiv.innerHTML = `<p style="color: #ff6666;">Error searching: ${error.message}</p>`;
        }
    }

    displayLinkedMoviesResults(results, container) {
        if (results.length === 0) {
            container.innerHTML = '<p>No results found.</p>';
            return;
        }

        const html = results.map((item, idx) => {
            const title = item.title || item.name || 'Unknown';
            const poster = item.poster_path || '';
            const year = item.year || '';
            const category = item.category || '';

            return `
                <div class="linked-movie-item" data-index="${idx}">
                    <img src="${poster || this.PLACEHOLDER_IMAGE}" alt="${title}" />
                    <div class="linked-movie-item-info">
                        <h5>${title}</h5>
                        <p>${year ? `${year} • ` : ''}${category}</p>
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = html;

        // Add click handlers
        container.querySelectorAll('.linked-movie-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent click from bubbling to document
                const idx = item.dataset.index;
                this.selectLinkedMovie(results[idx]);
            });
        });
    }

    selectLinkedMovie(movie) {
        // Check if already selected
        if (this.selectedLinkedMovies.find(m => m.id === movie.id)) {
            alert('This movie/TV is already selected');
            return;
        }

        // Add to selected list
        this.selectedLinkedMovies.push({
            id: movie.id,
            title: movie.title || movie.name,
            category: movie.category
        });

        this.renderSelectedLinkedMovies();

        // Clear search
        document.getElementById('linkedMoviesSearchInput').value = '';
        document.getElementById('linkedMoviesResults').innerHTML = '';

        console.log('Selected linked movies:', this.selectedLinkedMovies);
    }

    renderSelectedLinkedMovies() {
        const container = document.getElementById('linkedMoviesSelected');
        if (!container) return;

        if (this.selectedLinkedMovies.length === 0) {
            container.innerHTML = '';
            return;
        }

        const html = this.selectedLinkedMovies.map((movie, idx) => `
            <div class="selected-movie-chip">
                <span>${movie.title} (${movie.category})</span>
                <button type="button" onclick="tracker.removeLinkedMovie(${idx})">×</button>
            </div>
        `).join('');

        container.innerHTML = html;
    }

    removeLinkedMovie(idx) {
        this.selectedLinkedMovies.splice(idx, 1);
        this.renderSelectedLinkedMovies();
    }

    // ---------- SETTINGS (UI) ----------
    updateSettingsPreview() {
        const bgColor = document.getElementById('bgColor').value;
        const hoverColor = document.getElementById('hoverColor').value;
        const titleColor = document.getElementById('titleColor').value;
        const textColor = document.getElementById('textColor').value;
        const dropdownColor = document.getElementById('dropdownColor').value;

        document.documentElement.style.setProperty('--bg-color', bgColor);
        document.documentElement.style.setProperty('--hover-color', hoverColor);
        document.documentElement.style.setProperty('--title-color', titleColor);
        document.documentElement.style.setProperty('--text-color', textColor);
        document.documentElement.style.setProperty('--dropdown-color', dropdownColor);
    }

    saveSettings() {
        this.data.settings = {
            themeBackgroundColor: document.getElementById('bgColor').value,
            themeHoverColor: document.getElementById('hoverColor').value,
            themeTitleColor: document.getElementById('titleColor').value,
            themeTextColor: document.getElementById('textColor').value,
            themeFontFamily: "'Momo Trust Sans', sans-serif",
            themeDropdownColor: document.getElementById('dropdownColor').value,
            tmdbApiKey: document.getElementById('tmdbApiKey').value || '',
            malApiKey: document.getElementById('malApiKey').value || '',
            steamApiKey: document.getElementById('steamApiKey').value || '',
            steamgriddbApiKey: document.getElementById('steamgriddbApiKey').value || '',
            fanarttvApiKey: document.getElementById('fanarttvApiKey').value || '',
            omdbApiKey: document.getElementById('omdbApiKey').value || '',
            spotifyClientId: document.getElementById('spotifyClientId').value || '',
            spotifyClientSecret: document.getElementById('spotifyClientSecret').value || '',
            youtubeApiKey: document.getElementById('youtubeApiKey').value || '',
            bioMaxChars: (function () {
                const el = document.getElementById('bioMaxChars');
                if (!el) return null;
                const v = parseInt(el.value, 10);
                return Number.isFinite(v) ? v : null;
            })()
        };
        // Preserve any existing tabBackgrounds (don't overwrite with empty on save)
        try {
            const existing = (this.data && this.data.settings && this.data.settings.tabBackgrounds) || {};
            this.data.settings.tabBackgrounds = existing;
        } catch (e) { this.data.settings.tabBackgrounds = this.data.settings.tabBackgrounds || {}; }

        // Save to localStorage so index.html can read it immediately on reload
        try {
            localStorage.setItem('mediaTrackerTheme', JSON.stringify({
                themeBackgroundColor: this.data.settings.themeBackgroundColor,
                themeHoverColor: this.data.settings.themeHoverColor,
                themeTitleColor: this.data.settings.themeTitleColor,
                themeTextColor: this.data.settings.themeTextColor,
                themeFontFamily: this.data.settings.themeFontFamily,
                themeDropdownColor: this.data.settings.themeDropdownColor
            }));
        } catch (e) {
            console.error('Error saving theme to localStorage:', e);
        }

        // Apply immediately
        this.loadSettings();
    }

    switchActorSearchSource(source) {
        this.actorSearchSource = source;
        document.getElementById('tmdbActorTab')?.classList.toggle('active', source === 'tmdb');
        document.getElementById('spotifySingerTab')?.classList.toggle('active', source === 'spotify');

        // Update placeholder text
        const searchInput = document.getElementById('apiSearchInput');
        if (searchInput) {
            searchInput.placeholder = source === 'spotify' ? 'Search for singer/artist...' : 'Search for actor...';
        }
    }

    // ---------- IMAGE SELECTOR ----------
    async openImageSelector(imageType, source = 'tmdb') {
        let item = this.currentItem;

        // If there's no current item or it doesn't have an externalApiId, try to read values from the add form
        if (!item || !item.externalApiId) {
            const formApiEl = document.getElementById('itemExternalApiId');
            const formNameEl = document.getElementById('itemName');
            const formApiId = formApiEl?.value?.trim() || '';
            const formName = formNameEl?.value?.trim() || '';

            if (formApiId) {
                // Use the form-provided external ID (could be TMDB id)
                item = { type: this.currentTab, externalApiId: formApiId, name: formName };
                // preserve dataset source if present
                if (formApiEl?.dataset?.source) item.source = formApiEl.dataset.source;
            } else if (formName) {
                // Try to resolve ID by name based on source
                try {
                    let foundId = null;
                    let foundSource = source; // Default to requested source

                    if (source === 'steam') {
                        foundId = await this.searchSteamByName(formName);
                    } else {
                        // Default logic (TMDB)
                        foundId = await this.searchTMDBByName(formName, this.currentTab);
                        foundSource = 'tmdb';
                    }

                    if (foundId) {
                        // set form field so future operations use the ID
                        if (formApiEl) {
                            formApiEl.value = foundId;
                            formApiEl.dataset.source = foundSource;
                        }
                        item = { type: this.currentTab, externalApiId: foundId, name: formName, source: foundSource };
                    } else {
                        // No ID found by name
                        const modal = document.getElementById('imageSelectModal');
                        modal.classList.add('show');
                        const providerName = source === 'steam' ? 'Steam' : 'TMDB';
                        document.getElementById('imageSelectionGrid').innerHTML = `<p>No ${providerName} ID found for this name. Please enter a valid name or upload an image.</p>`;
                        return;
                    }
                } catch (err) {
                    console.warn(`Name search failed (${source}) while opening image selector:`, err && err.message ? err.message : err);
                    const modal = document.getElementById('imageSelectModal');
                    modal.classList.add('show');
                    document.getElementById('imageSelectionGrid').innerHTML = '<p>Error searching for images. Check your API keys.</p>';
                    return;
                }
            } else {
                alert('Cannot fetch images: No external API ID or name provided. Fill the Name field or upload an image.');
                return;
            }
        }

        this.currentImageType = imageType;
        this.currentImageSource = source; // Store the source (tmdb or fanart)
        const modal = document.getElementById('imageSelectModal');
        const title = document.getElementById('imageSelectTitle');
        const sourceText = source === 'fanart' ? ' (Fanart.tv)' : source === 'tmdb' ? ' (TMDB)' : '';
        title.textContent = `Select ${imageType === 'poster' ? 'Poster' : 'Banner'}${sourceText}`;

        // Set active tab
        if (imageType === 'poster') {
            document.getElementById('posterTab').classList.add('active');
            document.getElementById('bannerTab').classList.remove('active');
        } else {
            document.getElementById('bannerTab').classList.add('active');
            document.getElementById('posterTab').classList.remove('active');
        }

        modal.classList.add('show');
        document.getElementById('imageSelectionGrid').innerHTML = '<p>Loading images...</p>';

        // Show/hide anime search bar
        if (item.type === 'anime') {
            document.getElementById('animeSearchContainer').style.display = 'block';
            document.getElementById('animeSearchInput').value = item.name; // Pre-fill with current anime name
        } else {
            document.getElementById('animeSearchContainer').style.display = 'none';
        }

        // Fetch images based on source and item type
        if (source === 'fanart' && (item.type === 'movies' || item.type === 'tv')) {
            await this.fetchFanartImages(item, imageType);
        } else if (item.type === 'movies' || item.type === 'tv') {
            await this.fetchTMDBImages(item);
        } else if (item.type === 'anime') {
            await this.fetchAnimeImagesFromSearch(item, item.name);
        } else if (item.type === 'games' || source === 'steam') {
            await this.fetchSteamImages(item);
        } else if (item.type === 'actors') {
            await this.fetchActorImages(item);
        }
    }

    switchImageTab(imageType) {
        this.currentImageType = imageType;
        document.getElementById('posterTab').classList.toggle('active', imageType === 'poster');
        document.getElementById('bannerTab').classList.toggle('active', imageType === 'banner');
        this.displayImagesInModal();
    }

    async fetchTMDBImages(item) {
        try {
            const category = item.type === 'tv' ? 'tv' : 'movie';
            const url = `${API_URL}/api/images?category=${category}&id=${item.externalApiId}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(await response.text());
            const data = await response.json();

            this.apiImages = {
                posters: data.posters || [],
                backdrops: data.backdrops || []
            };

            this.displayImagesInModal();
        } catch (error) {
            console.error('Error fetching TMDB images:', error);
            document.getElementById('imageSelectionGrid').innerHTML = '<p style="color: #ff6666;">Error loading images. Make sure TMDB API key is configured.</p>';
        }
    }

    // Helper function to search Steam by name and get ID
    async searchSteamByName(name) {
        if (!name) return null;
        try {
            const url = `${API_URL}/api/steam/search?term=${encodeURIComponent(name)}`;
            const response = await fetch(url);
            if (!response.ok) return null;
            const data = await response.json();
            if (data.items && data.items.length > 0) {
                return data.items[0].id;
            }
            return null;
        } catch (e) {
            console.error('Error searching Steam:', e);
            return null;
        }
    }

    // Helper function to search TMDB by name and get ID
    async searchTMDBByName(itemName, itemType) {
        try {
            let category;
            if (itemType === 'movies') category = 'movie';
            else if (itemType === 'tv') category = 'tv';
            else if (itemType === 'anime') category = 'tv';
            else if (itemType === 'actors' || itemType === 'person' || itemType === 'people') category = 'actors';
            else category = 'movie';

            const searchUrl = `${API_URL}/api/search?query=${encodeURIComponent(itemName)}&category=${category}&service=tmdb`;
            console.log(`🔍 Searching TMDB for "${itemName}" (${category}): ${searchUrl}`);

            const response = await fetch(searchUrl);
            if (!response.ok) {
                console.warn(`❌ TMDB search failed: ${response.status}`);
                return null;
            }

            const searchData = await response.json();
            const results = searchData.results || [];

            if (results.length === 0) {
                console.log(`ℹ️ No TMDB results found for "${itemName}"`);
                return null;
            }

            // Try to find best match
            let matchedItem = results.find(r =>
                (r.title || r.name || '').toLowerCase() === itemName.toLowerCase()
            );

            if (!matchedItem) {
                matchedItem = results.find(r =>
                    (r.title || r.name || '').toLowerCase().includes(itemName.toLowerCase()) ||
                    itemName.toLowerCase().includes((r.title || r.name || '').toLowerCase())
                );
            }

            if (!matchedItem) {
                matchedItem = results[0]; // Use first result as fallback
            }

            const foundId = matchedItem.id;
            console.log(`✅ Found TMDB ID for "${itemName}": ${foundId} (matched: "${matchedItem.title || matchedItem.name}")`);
            return foundId;
        } catch (error) {
            console.error(`❌ Error searching TMDB for "${itemName}":`, error);
            return null;
        }
    }

    async fetchFanartImages(item, imageType) {
        try {
            const type = item.type === 'movies' ? 'movie' : 'tv';
            let apiId = item.externalApiId;
            let triedSearch = false;

            // First try with existing ID
            if (apiId) {
                const url = `${API_URL}/api/fanarttv?type=${type}&id=${apiId}`;
                const response = await fetch(url);

                if (response.ok) {
                    const data = await response.json();
                    console.log(`✅ Fanart.tv data for ${item.name} (ID: ${apiId}):`, data);
                    console.log(`📋 Data keys:`, Object.keys(data));

                    let posters = [];
                    let banners = [];

                    // Fanart.tv uses different keys: 'movieposter'/'tvposter' for posters, 'moviebanner'/'tvbanner' for banners
                    if (imageType === 'poster') {
                        const posterKey = type === 'movie' ? 'movieposter' : 'tvposter';
                        posters = data[posterKey] || data.posters || [];
                        console.log(`✅ Found ${posters.length} posters in ${posterKey} key`);
                    } else {
                        const bannerKey = type === 'movie' ? 'moviebanner' : 'tvbanner';
                        banners = data[bannerKey] || data.banners || [];
                        console.log(`✅ Found ${banners.length} banners in ${bannerKey} key`);
                    }

                    // If we found images, use them
                    if ((imageType === 'poster' && posters.length > 0) || (imageType === 'banner' && banners.length > 0)) {
                        // Convert fanart.tv format to match expected format
                        // Only set 'url' (not 'file_path') so displayImagesInModal doesn't try to construct TMDB URLs
                        posters = posters.map(poster => ({
                            url: poster.url || poster
                        }));

                        banners = banners.map(banner => ({
                            url: banner.url || banner
                        }));

                        this.apiImages = {
                            posters: posters,
                            backdrops: banners
                        };

                        console.log(`✅ Displaying ${imageType === 'poster' ? posters.length : banners.length} ${imageType}s from fanart.tv`);
                        this.displayImagesInModal();
                        return;
                    }
                }
            }

            // If ID search failed or returned no results, try searching by name
            if (!triedSearch) {
                console.log(`⚠️ No results with ID ${apiId}, trying search by name for "${item.name}"`);
                try {
                    const foundId = await this.searchTMDBByName(item.name, item.type);

                    if (foundId) {
                        triedSearch = true;
                        apiId = foundId;
                        console.log(`🔄 Retrying fanart.tv with found ID: ${apiId}`);

                        const url = `${API_URL}/api/fanarttv?type=${type}&id=${apiId}`;
                        const response = await fetch(url);

                        if (response.ok) {
                            const data = await response.json();
                            console.log(`✅ Fanart.tv data for ${item.name} (searched ID: ${apiId}):`, data);

                            let posters = [];
                            let banners = [];

                            if (imageType === 'poster') {
                                const posterKey = type === 'movie' ? 'movieposter' : 'tvposter';
                                posters = data[posterKey] || data.posters || [];
                            } else {
                                const bannerKey = type === 'movie' ? 'moviebanner' : 'tvbanner';
                                banners = data[bannerKey] || data.banners || [];
                            }

                            if ((imageType === 'poster' && posters.length > 0) || (imageType === 'banner' && banners.length > 0)) {
                                // Only set 'url' (not 'file_path') so displayImagesInModal doesn't try to construct TMDB URLs
                                posters = posters.map(poster => ({
                                    url: poster.url || poster
                                }));

                                banners = banners.map(banner => ({
                                    url: banner.url || banner
                                }));

                                this.apiImages = {
                                    posters: posters,
                                    backdrops: banners
                                };

                                console.log(`✅ Displaying ${imageType === 'poster' ? posters.length : banners.length} ${imageType}s from fanart.tv (via name search)`);
                                this.displayImagesInModal();
                                return;
                            }
                        }
                    }
                } catch (searchError) {
                    console.warn(`⚠️ Name search failed for "${item.name}":`, searchError);
                    // Continue to show error message
                }
            }

            // No results found - try TMDB as fallback
            if (item.externalApiId) {
                console.log(`⚠️ No results from fanart.tv, trying TMDB as fallback...`);
                try {
                    const category = item.type === 'tv' ? 'tv' : 'movie';
                    const url = `${API_URL}/api/images?category=${category}&id=${item.externalApiId}`;
                    const response = await fetch(url);
                    if (response.ok) {
                        const data = await response.json();
                        if (imageType === 'poster') {
                            const posters = data.posters || [];
                            if (posters.length > 0) {
                                this.apiImages = {
                                    posters: posters,
                                    backdrops: []
                                };
                                this.displayImagesInModal();
                                return;
                            }
                        } else {
                            const banners = data.backdrops || [];
                            if (banners.length > 0) {
                                this.apiImages = {
                                    posters: [],
                                    backdrops: banners
                                };
                                this.displayImagesInModal();
                                return;
                            }
                        }
                    }
                } catch (tmdbError) {
                    console.warn(`⚠️ TMDB fallback failed:`, tmdbError);
                }
            }

            // No results found anywhere
            if (imageType === 'poster') {
                document.getElementById('imageSelectionGrid').innerHTML = `<p>No posters found on fanart.tv or TMDB for "${item.name}".${triedSearch ? ' (Searched by name)' : ''}</p>`;
            } else {
                document.getElementById('imageSelectionGrid').innerHTML = `<p>No banners found on fanart.tv or TMDB for "${item.name}".${triedSearch ? ' (Searched by name)' : ''}</p>`;
            }
        } catch (error) {
            console.error('Error fetching fanart.tv images:', error);
            document.getElementById('imageSelectionGrid').innerHTML = '<p style="color: #ff6666;">Error loading images from fanart.tv. Check console for details.</p>';
        }
    }

    async fetchActorImages(item) {
        try {
            // Try with the stored externalApiId first (may be a TMDB person id)
            let apiId = item.externalApiId;
            let data = null;

            if (apiId) {
                try {
                    const url = `${API_URL}/api/images?category=person&id=${encodeURIComponent(apiId)}`;
                    const response = await fetch(url);
                    if (response.ok) {
                        data = await response.json();
                    } else {
                        console.warn(`TMDB person images request returned ${response.status} for id=${apiId}`);
                    }
                } catch (err) {
                    console.warn('TMDB person images fetch failed for stored id:', apiId, err && err.message ? err.message : err);
                }
            }

            // If we didn't get usable images, try to search TMDB by name (useful when externalApiId is a Spotify id)
            if (!data || ((Array.isArray(data.posters) && data.posters.length === 0) && (Array.isArray(data.backdrops) && data.backdrops.length === 0))) {
                if (item.name) {
                    console.log(`No images for person id=${apiId}, trying TMDB search by name: ${item.name}`);
                    const foundId = await this.searchTMDBByName(item.name, 'actors');
                    if (foundId && String(foundId) !== String(apiId)) {
                        try {
                            const url2 = `${API_URL}/api/images?category=person&id=${encodeURIComponent(foundId)}`;
                            const resp2 = await fetch(url2);
                            if (resp2.ok) {
                                data = await resp2.json();
                                // update apiId for logging/debugging
                                apiId = foundId;
                            } else {
                                console.warn(`TMDB person images request returned ${resp2.status} for searched id=${foundId}`);
                            }
                        } catch (err2) {
                            console.warn('TMDB person images fetch failed for searched id:', foundId, err2 && err2.message ? err2.message : err2);
                        }
                    }
                }
            }

            // If still no data, throw to trigger error UI
            if (!data) {
                throw new Error('No image data returned from TMDB');
            }

            this.apiImages = {
                posters: data.posters || [],
                backdrops: data.backdrops || []
            };

            this.displayImagesInModal();
        } catch (error) {
            console.error('Error fetching TMDB actor images:', error);
            document.getElementById('imageSelectionGrid').innerHTML = '<p style="color: #ff6666;">Error loading images. Make sure TMDB API key is configured.</p>';
        }
    }

    async fetchMALImages(item) {
        // Old method - kept for compatibility
        await this.fetchAnimeImagesFromSearch(item, item.name);
    }

    async fetchAnimeImagesFromSearch(item, searchQuery) {
        // Use TMDB to search for anime images
        try {
            if (!searchQuery || searchQuery.trim() === '') {
                document.getElementById('imageSelectionGrid').innerHTML = '<p>Enter a search query to find images.</p>';
                return;
            }

            // Search TMDB for this anime title
            const searchUrl = `${API_URL}/api/search?query=${encodeURIComponent(searchQuery)}&category=tv&service=tmdb`;
            const response = await fetch(searchUrl);
            if (!response.ok) throw new Error(await response.text());
            const searchData = await response.json();

            // Extract results array from TMDB response
            const results = searchData.results || [];

            if (results.length === 0) {
                document.getElementById('imageSelectionGrid').innerHTML = '<p>No results found on TMDB. Try a different search term or use upload from PC.</p>';
                return;
            }

            // Find matching anime - be more flexible, try to find best match
            let matchedAnime = results.find(anime =>
                anime.title && anime.title.toLowerCase() === searchQuery.toLowerCase()
            );

            // If no exact match, try partial match
            if (!matchedAnime) {
                matchedAnime = results.find(anime =>
                    anime.title && (
                        anime.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                        searchQuery.toLowerCase().includes(anime.title.toLowerCase())
                    )
                );
            }

            // If still no match, just use the first result from the search
            if (!matchedAnime) {
                matchedAnime = results[0];
            }

            // Now fetch images using TMDB
            const url = `${API_URL}/api/images?category=tv&id=${matchedAnime.id}`;
            const imageResponse = await fetch(url);
            if (!imageResponse.ok) throw new Error(await imageResponse.text());
            const data = await imageResponse.json();

            this.apiImages = {
                posters: data.posters || [],
                backdrops: data.backdrops || []
            };

            this.displayImagesInModal();
        } catch (error) {
            console.error('Error fetching anime images via TMDB:', error);
            document.getElementById('imageSelectionGrid').innerHTML = '<p style="color: #ff6666;">Error loading images. Make sure TMDB API key is configured.</p>';
        }
    }

    handleAnimeImageSearch() {
        const query = document.getElementById('animeSearchInput').value.trim();
        if (query.length >= 2) { // Search when user types at least 2 characters
            clearTimeout(this.animeSearchTimeout);
            this.animeSearchTimeout = setTimeout(() => {
                if (this.currentItem && this.currentItem.type === 'anime') {
                    document.getElementById('imageSelectionGrid').innerHTML = '<p>Searching...</p>';
                    this.fetchAnimeImagesFromSearch(this.currentItem, query);
                }
            }, 500); // Debounce for 500ms
        }
    }

    async fetchSteamImages(item) {
        // Fetch Steam game images from SteamGridDB
        try {
            const url = `${API_URL}/api/steamgriddb-images?appid=${item.externalApiId}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(await response.text());
            const data = await response.json();

            this.apiImages = {
                posters: data.grids || [],
                backdrops: data.heroes || []
            };

            this.displayImagesInModal();
        } catch (error) {
            console.error('Error fetching SteamGridDB images:', error);
            document.getElementById('imageSelectionGrid').innerHTML = '<p style="color: #ff6666;">Error loading images from SteamGridDB.</p>';
        }
    }

    displayImagesInModal() {
        const grid = document.getElementById('imageSelectionGrid');
        const images = this.currentImageType === 'poster' ? this.apiImages?.posters : this.apiImages?.backdrops;

        if (!images || images.length === 0) {
            grid.innerHTML = '<p>No images available.</p>';
            return;
        }

        const itemClass = this.currentImageType === 'poster' ? 'poster-item' : 'banner-item';
        const html = images.map((image, idx) => {
            // Handle different image formats: TMDB uses file_path, fanart.tv/SteamGridDB use url
            let displayUrl = '';
            if (image.file_path) {
                // TMDB format - construct full URL
                displayUrl = `https://image.tmdb.org/t/p/original${image.file_path}`;
            } else if (image.url || image.path) {
                // fanart.tv or SteamGridDB format
                displayUrl = image.url || image.path;
                // Use proxy for fanart.tv URLs to avoid CORS
                if (displayUrl.includes('fanart.tv') || displayUrl.includes('assets.fanart.tv')) {
                    displayUrl = `${API_URL}/api/fanarttv-image?url=${encodeURIComponent(displayUrl)}`;
                }
            }

            if (!displayUrl) {
                console.warn(`⚠️ No valid URL found for image:`, image);
                return '';
            }

            return `
                <div class="image-selection-item ${itemClass}" data-index="${idx}">
                    <img src="${displayUrl}" alt="Image ${idx + 1}" onerror="this.style.display='none'; this.parentElement.innerHTML='<p>Failed to load image</p>';" />
                </div>
            `;
        }).filter(html => html !== '').join('');

        grid.innerHTML = html;

        // Add click handlers
        grid.querySelectorAll('.image-selection-item').forEach(item => {
            item.addEventListener('click', () => {
                const idx = item.dataset.index;
                this.selectImage(images[idx]);
            });
        });
    }

    async selectImage(image) {
        // Handle different image formats: TMDB uses file_path, fanart.tv/SteamGridDB use url
        let imageUrl = '';
        if (image.file_path) {
            // TMDB format - construct full URL
            imageUrl = `https://image.tmdb.org/t/p/original${image.file_path}`;
        } else if (image.url || image.path) {
            imageUrl = image.url || image.path;
            // Note: Don't use proxy here - urlToBase64 should handle the direct URL
        }

        if (!imageUrl) {
            console.error('No valid image URL found:', image);
            return;
        }

        const item = this.currentItem;

        // Download image and convert to base64
        try {
            const base64 = await this.urlToBase64(imageUrl);

            // If there's no current saved item (we're in the add-form flow),
            // update the add-form preview and store base64 on the preview element
            // instead of trying to modify `this.currentItem` or save to DB.
            if (!item || !item.id) {
                if (this.currentImageType === 'poster') {
                    const preview = document.getElementById('posterPreview');
                    if (preview) {
                        preview.innerHTML = `<img src="${base64}" alt="Preview" style="width:100%;height:auto;border-radius:8px;">`;
                        preview.dataset.base64 = base64;
                    }
                } else {
                    const preview = document.getElementById('bannerPreview');
                    if (preview) {
                        preview.innerHTML = `<img src="${base64}" alt="Preview" style="width:100%;height:auto;border-radius:8px;">`;
                        preview.dataset.base64 = base64;
                    }
                }

                // Close modal and return; actual DB save happens when user submits the add form
                this.closeImageSelector();
                return;
            }

            // Update the image for an existing item
            if (this.currentImageType === 'poster') {
                document.getElementById('detailPoster').src = base64;
                item.posterBase64 = base64;
            } else {
                document.getElementById('bannerImage').src = base64;
                item.bannerBase64 = base64;
            }

            // Update in data
            const idx = this.data.items.findIndex(i => i.id === item.id);
            if (idx !== -1) {
                this.data.items[idx] = item;
            }

            // Save to DB
            const dbItem = {
                id: item.id,
                title: item.name,
                category: item.type,
                rating: item.userScore,
                year: item.year,
                genre: item.genre,
                description: item.description,
                myRank: item.myRank,
                gender: item.gender,
                birthday: item.birthday,
                placeOfBirth: item.placeOfBirth,
                socialMedia: item.socialMedia,
                biography: item.biography,
                linkedMovies: item.linkedMovies,
                externalApiId: item.externalApiId || '',
                studio: item.studio || '',
                developer: item.developer || '',
                directorCreator: item.directorCreator || ''
            };

            // Only include the image that's being changed as base64
            if (this.currentImageType === 'poster') {
                dbItem.posterBase64 = base64;
            } else {
                dbItem.bannerBase64 = base64;
            }

            await apiFetch(`${API_URL}/add`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(dbItem)
            });

            // Reload items from DB to ensure consistency
            await this.loadItemsFromDB();

            // Update currentItem to point to the reloaded item
            const reloadedItem = this.data.items.find(i => i.id === item.id);
            if (reloadedItem) {
                this.currentItem = reloadedItem;
                // Update the displayed image to the new one from DB
                if (this.currentImageType === 'poster') {
                    const posterEl = document.getElementById('detailPoster');
                    if (posterEl && reloadedItem.posterBase64) {
                        posterEl.src = this.getProxiedImageUrl(reloadedItem.posterBase64);
                    }
                } else {
                    const bannerEl = document.getElementById('bannerImage');
                    if (bannerEl && reloadedItem.bannerBase64) {
                        bannerEl.src = this.getProxiedImageUrl(reloadedItem.bannerBase64);
                    }
                }
            }

            this.closeImageSelector();
        } catch (error) {
            console.error('Error loading image:', error);
            alert('Failed to load image. Please try again.');
        }
    }

    closeImageSelector() {
        document.getElementById('imageSelectModal').classList.remove('show');
        this.apiImages = null;
    }

    // Detail settings menu
    toggleDetailSettingsMenu() {
        const menu = document.getElementById('detailSettingsMenu');
        menu.classList.toggle('show');
    }

    closeDetailSettingsMenu() {
        const menu = document.getElementById('detailSettingsMenu');
        menu.classList.remove('show');
    }

    // Trigger image upload from detail view
    triggerImageUpload(imageType) {
        const uploadId = imageType === 'poster' ? 'detailPosterUpload' : 'detailBannerUpload';
        document.getElementById(uploadId).click();
    }

    // Handle image upload in detail view
    async handleDetailImageUpload(event, imageType) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const base64 = await this.fileToBase64(file);
            const item = this.currentItem;

            // Update the image in the detail view
            if (imageType === 'poster') {
                document.getElementById('detailPoster').src = base64;
                item.posterBase64 = base64;
            } else {
                document.getElementById('bannerImage').src = base64;
                item.bannerBase64 = base64;
            }

            // Update in data
            const idx = this.data.items.findIndex(i => i.id === item.id);
            if (idx !== -1) {
                this.data.items[idx] = item;
            }

            // Ensure biography is preserved (fallback to description if needed)
            if (item.type === 'actors') {
                const biographyDomText = document.getElementById('actorBiography')?.textContent?.trim();
                const preservedBio = biographyDomText || item.biography || item.description || '';
                // Ensure saved biography is capped at 1580 characters
                item.biography = preservedBio ? preservedBio.substring(0, 1580) : '';
                if (!item.description || !item.description.trim() || item.description === 'No description available.') {
                    item.description = preservedBio;
                }
            }

            // Save to DB
            const dbItem = {
                id: item.id,
                title: item.name,
                category: item.type,
                rating: item.userScore,
                year: item.year,
                genre: item.genre,
                description: item.description,
                myRank: item.myRank,
                gender: item.gender,
                birthday: item.birthday,
                placeOfBirth: item.placeOfBirth,
                socialMedia: item.socialMedia,
                biography: item.biography || '',
                linkedMovies: item.linkedMovies,
                externalApiId: item.externalApiId || '',
                studio: item.studio || '',
                developer: item.developer || '',
                directorCreator: item.directorCreator || ''
            };

            // Only include the image that's being changed as base64
            if (imageType === 'poster') {
                dbItem.posterBase64 = base64;
            } else {
                dbItem.bannerBase64 = base64;
            }

            await apiFetch(`${API_URL}/add`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(dbItem)
            });

            // Reload items from DB to ensure consistency
            await this.loadItemsFromDB();

            // Update currentItem to point to the reloaded item
            const reloadedItem = this.data.items.find(i => i.id === item.id);
            if (reloadedItem) {
                this.currentItem = reloadedItem;
                // Update the displayed image to the new one from DB
                if (imageType === 'poster') {
                    const posterEl = document.getElementById('detailPoster');
                    if (posterEl && reloadedItem.posterBase64) {
                        posterEl.src = this.getProxiedImageUrl(reloadedItem.posterBase64);
                    }
                } else {
                    const bannerEl = document.getElementById('bannerImage');
                    if (bannerEl && reloadedItem.bannerBase64) {
                        bannerEl.src = this.getProxiedImageUrl(reloadedItem.bannerBase64);
                    }
                }
            }

            // Clear the file input
            event.target.value = '';
        } catch (error) {
            console.error('Error uploading image:', error);
            alert('Failed to upload image. Please try again.');
        }
    }

    // Convert file to base64 with compression if needed
    async fileToBase64(file) {
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });

        // Compress if needed before returning
        return await this.compressImageIfNeeded(base64);
    }

    // Trigger collection poster upload
    triggerCollectionPosterUpload(collection) {
        // Use currentViewedCollection to ensure we use the right collection
        const currentCollection = this.currentViewedCollection || collection;
        this.currentEditingCollectionForPoster = currentCollection;
        document.getElementById('collectionPosterUpload').click();
    }

    // Handle collection poster upload
    async handleCollectionPosterUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const base64 = await this.fileToBase64(file);
            const collection = this.currentEditingCollectionForPoster;

            if (!collection) {
                alert('Error: Collection not found');
                return;
            }

            // Update the collection poster (server will convert to file path)
            collection.posterBase64 = base64; // Temporary for sending to server

            // Update in collections array
            const idx = this.collections.findIndex(c => c.id === collection.id);
            if (idx !== -1) {
                this.collections[idx] = collection;
            }

            // Save to GitHub (server converts base64 to file path)
            await this.updateCollectionInDB(collection.id, { posterBase64: base64 });

            // Reload collections to get updated paths
            await this.loadCollectionsFromDB();

            // Refresh the library view to show updated poster
            this.renderLibrary();

            // If we're currently viewing this collection, refresh the view
            if (this.currentView === 'sequels' && this.sequelsViewSource === 'collection') {
                const updatedCollection = this.collections.find(c => c.id === collection.id);
                if (updatedCollection) {
                    this.showCollectionView([updatedCollection], null);
                }
            }

            // Clear the file input
            event.target.value = '';
            this.currentEditingCollectionForPoster = null;

            alert('Collection poster updated successfully!');
        } catch (error) {
            console.error('Error uploading collection poster:', error);
            alert('Failed to upload poster. Please try again.');
        }
    }

    // Trigger collection banner upload
    triggerCollectionBannerUpload(collection) {
        // Use currentViewedCollection to ensure we use the right collection
        const currentCollection = this.currentViewedCollection || collection;
        this.currentEditingCollectionForBanner = currentCollection;
        document.getElementById('collectionBannerUpload').click();
    }

    // Search for collection poster
    async searchCollectionPoster(collection) {
        // Use currentViewedCollection to ensure we use the correct collection
        const currentCollection = this.currentViewedCollection || collection;

        // Get collection items to determine type from the current collection
        const collectionItems = currentCollection.itemIds
            .map(id => this.data.items.find(item => item.id === id))
            .filter(item => item !== undefined);

        if (collectionItems.length === 0) {
            alert('Collection is empty. Add items to search for posters.');
            return;
        }

        // Determine collection type from first item
        const firstItem = collectionItems[0];
        const collectionType = firstItem.type;

        // Store current collection for poster selection
        this.currentCollectionForPoster = currentCollection;
        this.currentCollectionPosterType = collectionType;

        // Open image selection modal
        const modal = document.getElementById('imageSelectModal');
        const title = document.getElementById('imageSelectTitle');
        title.textContent = `Select Poster for ${currentCollection.name}`;

        // Set active tab to posters
        document.getElementById('posterTab').classList.add('active');
        document.getElementById('bannerTab').classList.remove('active');
        this.currentImageType = 'poster';

        // Hide anime search bar
        document.getElementById('animeSearchContainer').style.display = 'none';

        modal.classList.add('show');
        document.getElementById('imageSelectionGrid').innerHTML = '<p>Loading posters...</p>';

        // Fetch posters based on collection type
        if (collectionType === 'games') {
            // Search SteamGridDB for grids (posters) for all games in collection
            await this.fetchCollectionPostersFromSteamGridDB(collectionItems);
        } else if (collectionType === 'movies' || collectionType === 'tv') {
            // Search TMDB for posters
            await this.fetchCollectionPostersFromTMDB(collectionItems, collectionType);
        } else {
            document.getElementById('imageSelectionGrid').innerHTML = '<p>Poster search not available for this collection type.</p>';
        }
    }

    // Fetch posters from SteamGridDB for games collection
    async fetchCollectionPostersFromSteamGridDB(items) {
        try {
            const allGrids = [];

            // Fetch grids for all games in the collection
            for (const item of items) {
                if (!item.externalApiId) continue;

                try {
                    const url = `${API_URL}/api/steamgriddb-images?appid=${item.externalApiId}`;
                    const response = await fetch(url);
                    if (!response.ok) continue;

                    const data = await response.json();
                    const grids = (data.grids || []).map(grid => ({
                        ...grid,
                        gameName: item.name
                    }));
                    allGrids.push(...grids);
                } catch (e) {
                    console.error(`Error fetching grids for ${item.name}:`, e);
                }
            }

            if (allGrids.length === 0) {
                document.getElementById('imageSelectionGrid').innerHTML = '<p>No posters found on SteamGridDB for games in this collection.</p>';
                return;
            }

            this.apiImages = {
                posters: allGrids,
                backdrops: []
            };

            this.displayCollectionPosterImages();
        } catch (error) {
            console.error('Error fetching SteamGridDB grids:', error);
            document.getElementById('imageSelectionGrid').innerHTML = '<p style="color: #ff6666;">Error loading posters from SteamGridDB.</p>';
        }
    }

    // Fetch posters from TMDB for movies/TV collection
    async fetchCollectionPostersFromTMDB(items, type) {
        try {
            const allPosters = [];

            // Fetch posters for all movies/TV in the collection
            for (const item of items) {
                if (!item.externalApiId) continue;

                try {
                    const category = type === 'tv' ? 'tv' : 'movie';
                    const url = `${API_URL}/api/images?category=${category}&id=${item.externalApiId}`;
                    const response = await fetch(url);
                    if (!response.ok) continue;

                    const data = await response.json();
                    const posters = (data.posters || []).map(poster => ({
                        ...poster,
                        itemName: item.name
                    }));
                    allPosters.push(...posters);
                } catch (e) {
                    console.error(`Error fetching TMDB posters for ${item.name}:`, e);
                }
            }

            if (allPosters.length === 0) {
                document.getElementById('imageSelectionGrid').innerHTML = '<p>No posters found on TMDB for items in this collection.</p>';
                return;
            }

            this.apiImages = {
                posters: allPosters,
                backdrops: []
            };

            this.displayCollectionPosterImages();
        } catch (error) {
            console.error('Error fetching TMDB posters:', error);
            document.getElementById('imageSelectionGrid').innerHTML = '<p style="color: #ff6666;">Error loading posters from TMDB.</p>';
        }
    }

    // Display collection poster images in modal
    displayCollectionPosterImages() {
        const grid = document.getElementById('imageSelectionGrid');
        const images = this.apiImages?.posters || [];

        if (!images || images.length === 0) {
            grid.innerHTML = '<p>No posters available.</p>';
            return;
        }

        const html = images.map((image, idx) => {
            // Handle different image formats: TMDB uses file_path, SteamGridDB uses url
            const url = image.file_path
                ? `https://image.tmdb.org/t/p/original${image.file_path}`
                : image.url || image.path || '';
            const label = image.gameName || image.itemName || '';
            return `
                <div class="image-selection-item poster-item" data-index="${idx}">
                    <img src="${url}" alt="Poster ${idx + 1}" />
                    ${label ? `<div class="banner-label">${label}</div>` : ''}
                </div>
            `;
        }).join('');

        grid.innerHTML = html;

        // Add click handlers
        grid.querySelectorAll('.image-selection-item').forEach(item => {
            item.addEventListener('click', () => {
                const idx = item.dataset.index;
                this.selectCollectionPoster(images[idx]);
            });
        });
    }

    // Select and save collection poster
    async selectCollectionPoster(image) {
        // Handle different image formats: TMDB uses file_path, SteamGridDB uses url
        const imageUrl = image.file_path
            ? `https://image.tmdb.org/t/p/original${image.file_path}`
            : image.url || image.path || '';

        if (!imageUrl) return;

        const collection = this.currentCollectionForPoster;
        if (!collection) return;

        try {
            // Download image and convert to base64
            const base64 = await this.urlToBase64(imageUrl);

            // Update collection poster (server will convert to file path)
            collection.posterBase64 = base64; // Temporary for sending to server

            // Update in collections array
            const idx = this.collections.findIndex(c => c.id === collection.id);
            if (idx !== -1) {
                this.collections[idx] = collection;
            }

            // Save to GitHub (server converts base64 to file path)
            await this.updateCollectionInDB(collection.id, { posterBase64: base64 });

            // Reload collections to get updated paths
            await this.loadCollectionsFromDB();

            // Refresh the collection view
            if (this.currentView === 'sequels' && this.sequelsViewSource === 'collection') {
                const updatedCollection = this.collections.find(c => c.id === collection.id);
                if (updatedCollection) {
                    this.showCollectionView([updatedCollection], null);
                }
            }

            this.closeImageSelector();
            alert('Collection poster updated successfully!');
        } catch (error) {
            console.error('Error loading poster:', error);
            alert('Failed to load poster. Please try again.');
        }
    }

    // Search for collection banner (wild banner click)
    async searchCollectionBanner(collection) {
        // Use currentViewedCollection to ensure we use the correct collection
        const currentCollection = this.currentViewedCollection || collection;

        // Get collection items to determine type from the current collection
        const collectionItems = currentCollection.itemIds
            .map(id => this.data.items.find(item => item.id === id))
            .filter(item => item !== undefined);

        if (collectionItems.length === 0) {
            alert('Collection is empty. Add items to search for banners.');
            return;
        }

        // Determine collection type from first item
        const firstItem = collectionItems[0];
        const collectionType = firstItem.type;

        // Store current collection for banner selection
        this.currentCollectionForBanner = currentCollection;
        this.currentCollectionBannerType = collectionType;

        // Open image selection modal
        const modal = document.getElementById('imageSelectModal');
        const title = document.getElementById('imageSelectTitle');
        title.textContent = `Select Banner for ${currentCollection.name}`;

        // Set active tab to banners
        document.getElementById('posterTab').classList.remove('active');
        document.getElementById('bannerTab').classList.add('active');
        this.currentImageType = 'banner';

        // Hide anime search bar
        document.getElementById('animeSearchContainer').style.display = 'none';

        modal.classList.add('show');
        document.getElementById('imageSelectionGrid').innerHTML = '<p>Loading banners...</p>';

        // Fetch banners based on collection type (using collectionItems already fetched above)
        if (collectionType === 'games') {
            // Search SteamGridDB for heroes (banners) for all games in collection
            await this.fetchCollectionBannersFromSteamGridDB(collectionItems);
        } else if (collectionType === 'movies' || collectionType === 'tv') {
            // Search fanart.tv for banners
            await this.fetchCollectionBannersFromFanartTV(collectionItems, collectionType);
        } else {
            document.getElementById('imageSelectionGrid').innerHTML = '<p>Banner search not available for this collection type.</p>';
        }
    }

    // Fetch banners from SteamGridDB for games collection
    async fetchCollectionBannersFromSteamGridDB(items) {
        try {
            const allHeroes = [];

            // Fetch heroes for all games in the collection
            for (const item of items) {
                if (!item.externalApiId) continue;

                try {
                    const url = `${API_URL}/api/steamgriddb-images?appid=${item.externalApiId}`;
                    const response = await fetch(url);
                    if (!response.ok) continue;

                    const data = await response.json();
                    const heroes = (data.heroes || []).map(hero => ({
                        ...hero,
                        gameName: item.name
                    }));
                    allHeroes.push(...heroes);
                } catch (e) {
                    console.error(`Error fetching heroes for ${item.name}:`, e);
                }
            }

            if (allHeroes.length === 0) {
                document.getElementById('imageSelectionGrid').innerHTML = '<p>No banners found on SteamGridDB for games in this collection.</p>';
                return;
            }

            this.apiImages = {
                posters: [],
                backdrops: allHeroes
            };

            this.displayCollectionBannerImages();
        } catch (error) {
            console.error('Error fetching SteamGridDB heroes:', error);
            document.getElementById('imageSelectionGrid').innerHTML = '<p style="color: #ff6666;">Error loading banners from SteamGridDB.</p>';
        }
    }

    // Fetch banners from fanart.tv for movies/TV collection
    async fetchCollectionBannersFromFanartTV(items, type) {
        // Process all items - try with ID first, then search by name if needed
        const itemsWithApiId = items.filter(item => item.externalApiId);
        const itemsToProcess = itemsWithApiId.length > 0 ? itemsWithApiId : items;

        try {
            console.log(`🔍 Fetching fanart.tv banners for ${items.length} items, type: ${type}`);

            // Check if items have externalApiId
            const itemsWithoutApiId = items.filter(item => !item.externalApiId);

            if (itemsWithoutApiId.length > 0) {
                console.warn(`⚠️ ${itemsWithoutApiId.length} items without externalApiId:`, itemsWithoutApiId.map(i => i.name));
            }

            const allBanners = [];
            let successCount = 0;
            let failCount = 0;

            // Fetch banners for all movies/TV in the collection
            for (const item of itemsToProcess) {
                try {
                    let apiId = item.externalApiId;
                    let foundBanners = [];
                    let triedSearch = false;

                    // If no ID, search by name first
                    if (!apiId) {
                        console.log(`⚠️ No externalApiId for "${item.name}", searching by name...`);
                        try {
                            const foundId = await this.searchTMDBByName(item.name, type === 'movies' ? 'movies' : 'tv');
                            if (foundId) {
                                apiId = foundId;
                                triedSearch = true;
                                console.log(`✅ Found ID via name search: ${apiId}`);
                            } else {
                                console.log(`❌ Could not find TMDB ID for "${item.name}"`);
                                failCount++;
                                continue;
                            }
                        } catch (searchError) {
                            console.warn(`⚠️ Name search failed for "${item.name}":`, searchError);
                            failCount++;
                            continue; // Skip this item if search fails
                        }
                    }

                    // First try with ID (either existing or found via search)
                    const url = `${API_URL}/api/fanarttv?type=${type === 'movies' ? 'movie' : 'tv'}&id=${apiId}`;
                    console.log(`📡 Fetching banners for "${item.name}" (${apiId}): ${url}`);

                    const response = await fetch(url);
                    if (response.ok) {
                        const data = await response.json();
                        console.log(`✅ Received data for ${item.name}:`, data);
                        console.log(`📋 Data keys:`, Object.keys(data));

                        // Check for banners (fanart.tv's "Banner" category - wide horizontal banners with logos/characters)
                        // The 'banners' key is the main "Banner" category, not backgrounds (backgrounds are in 'moviebackground'/'tvbackground')
                        // Also check specific keys as fallback
                        const bannerKey = type === 'movies' ? 'moviebanner' : 'tvbanner';

                        if (data.banners && Array.isArray(data.banners) && data.banners.length > 0) {
                            // Prioritize 'banners' key - this is the actual "Banner" category from fanart.tv
                            foundBanners = data.banners;
                            console.log(`✅ Found ${foundBanners.length} banners in 'banners' key (Banner category) for ${item.name}`);
                        } else if (data[bannerKey] && Array.isArray(data[bannerKey]) && data[bannerKey].length > 0) {
                            // Fall back to specific banner keys
                            foundBanners = data[bannerKey];
                            console.log(`✅ Found ${foundBanners.length} banners in ${bannerKey} key for ${item.name}`);
                        } else {
                            console.log(`ℹ️ No banners found for ${item.name}. Available keys:`, Object.keys(data));
                        }
                    } else {
                        console.warn(`❌ API response not OK for ${item.name}: ${response.status} ${response.statusText}`);
                    }

                    // If no banners found with ID and we haven't searched yet, try searching by name
                    if (foundBanners.length === 0 && !triedSearch) {
                        console.log(`⚠️ No banners with ID ${apiId}, trying search by name for "${item.name}"`);
                        try {
                            const foundId = await this.searchTMDBByName(item.name, type === 'movies' ? 'movies' : 'tv');

                            if (foundId && foundId !== apiId) {
                                triedSearch = true;
                                apiId = foundId;
                                console.log(`🔄 Retrying fanart.tv with found ID: ${apiId}`);

                                const retryUrl = `${API_URL}/api/fanarttv?type=${type === 'movies' ? 'movie' : 'tv'}&id=${apiId}`;
                                const retryResponse = await fetch(retryUrl);

                                if (retryResponse.ok) {
                                    const retryData = await retryResponse.json();
                                    console.log(`✅ Received data for ${item.name} (searched ID: ${apiId}):`, retryData);

                                    const bannerKey = type === 'movies' ? 'moviebanner' : 'tvbanner';
                                    if (retryData.banners && Array.isArray(retryData.banners) && retryData.banners.length > 0) {
                                        // Prioritize 'banners' key - this is the actual "Banner" category from fanart.tv
                                        foundBanners = retryData.banners;
                                        console.log(`✅ Found ${foundBanners.length} banners in 'banners' key (Banner category) with searched ID`);
                                    } else if (retryData[bannerKey] && Array.isArray(retryData[bannerKey]) && retryData[bannerKey].length > 0) {
                                        // Fall back to specific banner keys
                                        foundBanners = retryData[bannerKey];
                                        console.log(`✅ Found ${foundBanners.length} banners in ${bannerKey} key with searched ID`);
                                    }
                                }
                            }
                        } catch (searchError) {
                            console.warn(`⚠️ Name search failed for "${item.name}", skipping fallback:`, searchError);
                            // Continue without name search - don't break the loop
                        }
                    }

                    foundBanners = foundBanners.map(banner => ({
                        ...banner,
                        itemName: item.name
                    }));

                    if (foundBanners.length > 0) {
                        console.log(`✅ Found ${foundBanners.length} banners for ${item.name}${triedSearch ? ' (via name search)' : ''}`);
                        allBanners.push(...foundBanners);
                        successCount++;
                    } else {
                        console.log(`ℹ️ No banners found for ${item.name}${triedSearch ? ' (searched by name)' : ''}`);
                        failCount++;
                    }
                } catch (e) {
                    console.error(`❌ Error fetching fanart.tv banners for ${item.name}:`, e);
                    failCount++;
                }
            }

            console.log(`📊 Banner fetch summary: ${successCount} successful, ${failCount} failed, ${allBanners.length} total banners`);

            // Only show banners if we found actual fanart.tv banners (Banner category)
            // Don't fall back to TMDB backdrops as they are backgrounds, not banners
            if (allBanners.length === 0) {
                console.log(`⚠️ No banners found on fanart.tv for any items in this collection`);
                document.getElementById('imageSelectionGrid').innerHTML = '<p>No banners found on fanart.tv for items in this collection. Banners (from the "Banner" category) are different from backgrounds.</p>';
                return;
            }

            this.apiImages = {
                posters: [],
                backdrops: allBanners
            };

            this.displayCollectionBannerImages();
        } catch (error) {
            console.error('❌ Error fetching fanart.tv banners:', error);
            document.getElementById('imageSelectionGrid').innerHTML = '<p style="color: #ff6666;">Error loading wide banners from fanart.tv. Check console for details.</p>';
        }
    }

    // Fetch banners from TMDB for movies/TV collection (fallback when fanart.tv fails)
    async fetchCollectionBannersFromTMDB(items, type) {
        try {
            console.log(`🔄 Fetching TMDB backdrops (banners) for ${items.length} items, type: ${type}`);
            const allBanners = [];

            // Fetch backdrops (banners) for all movies/TV in the collection
            for (const item of items) {
                if (!item.externalApiId) {
                    console.log(`⚠️ Skipping ${item.name} - no externalApiId`);
                    continue;
                }

                try {
                    const category = type === 'tv' ? 'tv' : 'movie';
                    const url = `${API_URL}/api/images?category=${category}&id=${item.externalApiId}`;
                    console.log(`📡 Fetching TMDB backdrops for "${item.name}" (${item.externalApiId}): ${url}`);

                    const response = await fetch(url);
                    if (!response.ok) {
                        console.warn(`❌ TMDB API response not OK for ${item.name}: ${response.status}`);
                        continue;
                    }

                    const data = await response.json();
                    console.log(`✅ TMDB data for ${item.name}:`, data);
                    const backdrops = data.backdrops || [];
                    console.log(`✅ Found ${backdrops.length} backdrops for ${item.name}`);

                    const banners = backdrops.map(banner => ({
                        ...banner,
                        file_path: banner.file_path, // Ensure file_path is preserved
                        itemName: item.name
                    }));
                    allBanners.push(...banners);
                } catch (e) {
                    console.error(`❌ Error fetching TMDB banners for ${item.name}:`, e);
                }
            }

            console.log(`📊 TMDB banner fetch summary: ${allBanners.length} total banners found`);

            if (allBanners.length === 0) {
                document.getElementById('imageSelectionGrid').innerHTML = '<p>No banners found on TMDB or fanart.tv for items in this collection.</p>';
                return;
            }

            this.apiImages = {
                posters: [],
                backdrops: allBanners
            };

            console.log(`✅ Displaying ${allBanners.length} banners from TMDB`);
            this.displayCollectionBannerImages();
        } catch (error) {
            console.error('❌ Error fetching TMDB banners:', error);
            document.getElementById('imageSelectionGrid').innerHTML = '<p style="color: #ff6666;">Error loading banners from TMDB. Check console for details.</p>';
        }
    }

    // Display collection banner images in modal
    displayCollectionBannerImages() {
        const grid = document.getElementById('imageSelectionGrid');
        const images = this.apiImages?.backdrops || [];

        if (!images || images.length === 0) {
            grid.innerHTML = '<p>No banners available.</p>';
            return;
        }

        const html = images.map((image, idx) => {
            // Handle different image formats: TMDB uses file_path, fanart.tv/SteamGridDB use url
            let displayUrl = '';
            if (image.file_path) {
                // TMDB format - construct full URL
                displayUrl = `https://image.tmdb.org/t/p/original${image.file_path}`;
            } else if (image.url || image.path) {
                // fanart.tv or SteamGridDB format
                displayUrl = image.url || image.path;
                // Use proxy for fanart.tv URLs to avoid CORS
                if (displayUrl.includes('fanart.tv') || displayUrl.includes('assets.fanart.tv')) {
                    displayUrl = `${API_URL}/api/fanarttv-image?url=${encodeURIComponent(displayUrl)}`;
                }
            }

            if (!displayUrl) {
                console.warn(`⚠️ No valid URL found for banner image:`, image);
                return '';
            }

            const label = image.gameName || image.itemName || '';
            return `
                <div class="image-selection-item banner-item" data-index="${idx}">
                    <img src="${displayUrl}" alt="Banner ${idx + 1}" onerror="this.style.display='none'; this.parentElement.innerHTML='<p>Failed to load image</p>';" />
                    ${label ? `<div class="banner-label">${label}</div>` : ''}
                </div>
            `;
        }).filter(html => html !== '').join('');

        grid.innerHTML = html;

        // Add click handlers
        grid.querySelectorAll('.image-selection-item').forEach(item => {
            item.addEventListener('click', () => {
                const idx = item.dataset.index;
                this.selectCollectionBanner(images[idx]);
            });
        });
    }

    // Select and save collection banner
    async selectCollectionBanner(image) {
        // Handle different image formats: TMDB uses file_path, fanart.tv/SteamGridDB use url
        let imageUrl = '';
        if (image.file_path) {
            // TMDB format - construct full URL
            imageUrl = `https://image.tmdb.org/t/p/original${image.file_path}`;
        } else if (image.url || image.path) {
            imageUrl = image.url || image.path;
        }

        if (!imageUrl) {
            console.error('No valid image URL found:', image);
            return;
        }

        const collection = this.currentCollectionForBanner;
        if (!collection) return;

        try {
            // Download image and convert to base64
            const base64 = await this.urlToBase64(imageUrl);

            if (!base64 || !base64.startsWith('data:image')) {
                throw new Error('Invalid image data received');
            }

            // Save to GitHub (server converts base64 to file path)
            const response = await apiFetch(`${API_URL}/collections/${collection.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ bannerBase64: base64 })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Server error: ${response.status} - ${errorText}`);
            }

            // Update collection banner (server will convert to file path)
            collection.bannerBase64 = base64; // Temporary for sending to server

            // Update in collections array
            const idx = this.collections.findIndex(c => c.id === collection.id);
            if (idx !== -1) {
                this.collections[idx] = collection;
            }

            // Reload collections to get updated paths
            await this.loadCollectionsFromDB();

            // Refresh the collection view
            if (this.currentView === 'sequels' && this.sequelsViewSource === 'collection') {
                const updatedCollection = this.collections.find(c => c.id === collection.id);
                if (updatedCollection) {
                    this.showCollectionView([updatedCollection], null);
                }
            }

            this.closeImageSelector();
            alert('Collection banner updated successfully!');
        } catch (error) {
            console.error('❌ Error selecting collection banner:', error);
            alert(`Failed to select banner: ${error.message}`);
        }
    }

    // Handle collection banner upload
    async handleCollectionBannerUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const base64 = await this.fileToBase64(file);
            const collection = this.currentEditingCollectionForBanner;

            if (!collection) {
                alert('Error: Collection not found');
                return;
            }

            // Update the collection banner
            collection.bannerBase64 = base64;

            // Update in collections array
            const idx = this.collections.findIndex(c => c.id === collection.id);
            if (idx !== -1) {
                this.collections[idx] = collection;
            }

            // Save to GitHub
            await this.updateCollectionInDB(collection.id, { bannerBase64: base64 });

            // If we're currently viewing this collection, refresh the view
            if (this.currentView === 'sequels' && this.sequelsViewSource === 'collection' && this.currentViewedCollection?.id === collection.id) {
                this.showCollectionView([collection], null);
            }

            // Clear the file input
            event.target.value = '';
            this.currentEditingCollectionForBanner = null;

            alert('Collection banner updated successfully!');
        } catch (error) {
            console.error('Error uploading collection banner:', error);
            alert('Failed to upload banner. Please try again.');
        }
    }


    // ===== LAYOUT EDITOR METHODS =====
    // Replaced by LayoutEditor class
    toggleLayoutEditMode() {
        if (!this.layoutEditor) {
            this.layoutEditor = new LayoutEditor(this);
        }
        this.layoutEditor.toggle();
    }

    // ---------- WATCHLIST ----------
    getWatchlist() {
        const watchlistData = localStorage.getItem('mediaTrackerWatchlist');
        if (!watchlistData) return [];
        try {
            return JSON.parse(watchlistData);
        } catch (error) {
            console.error('Error parsing watchlist:', error);
            return [];
        }
    }

    saveWatchlist(watchlist) {
        try {
            localStorage.setItem('mediaTrackerWatchlist', JSON.stringify(watchlist));
        } catch (error) {
            console.error('Error saving watchlist:', error);
        }
    }

    isInWatchlist(item) {
        const watchlist = this.getWatchlist();
        const itemType = item.type || this.currentTab;
        return watchlist.some(w =>
            (w.externalApiId && w.externalApiId === item.externalApiId && w.type === itemType) ||
            (w.id && w.id === item.id)
        );
    }

    toggleWatchlist(item) {
        const watchlist = this.getWatchlist();
        const isInList = this.isInWatchlist(item);

        // Ensure type is always set - fallback to currentTab if missing
        const itemType = item.type || this.currentTab;

        if (isInList) {
            // Remove from watchlist
            const newWatchlist = watchlist.filter(w =>
                !((w.externalApiId && w.externalApiId === item.externalApiId && w.type === itemType) ||
                    (w.id && w.id === item.id))
            );
            this.saveWatchlist(newWatchlist);
            console.log('📋 Removed from watchlist:', item.name || item.title, '| Type:', itemType);
        } else {
            // Add to watchlist
            const watchlistItem = {
                id: item.id,
                externalApiId: item.externalApiId,
                type: itemType,
                name: item.name || item.title,
                posterPath: item.posterPath,
                posterBase64: item.posterBase64,
                addedAt: new Date().toISOString()
            };
            watchlist.push(watchlistItem);
            this.saveWatchlist(watchlist);
            console.log('📋 Added to watchlist:', item.name || item.title, '| Type:', itemType, '| Item:', watchlistItem);
        }

        // Update button state
        this.updateWatchlistButtonState(item);
    }

    updateWatchlistButtonState(item) {
        const watchlistBtn = document.getElementById('watchlistBtn');
        if (!watchlistBtn) return;

        const isInList = this.isInWatchlist(item);
        const btnText = watchlistBtn.querySelector('.watchlist-btn-text');

        if (isInList) {
            watchlistBtn.classList.add('in-watchlist');
            if (btnText) btnText.textContent = 'Remove from Watchlist';
        } else {
            watchlistBtn.classList.remove('in-watchlist');
            if (btnText) btnText.textContent = 'Add to Watchlist';
        }
    }

    setupRuntimeSlider() {
        const minRange = document.getElementById('runtimeRangeMin');
        const maxRange = document.getElementById('runtimeRangeMax');
        const trackFill = document.getElementById('runtimeTrackFill');
        const display = document.getElementById('runtimeValuesDisplay');
        const stops = [0, 24, 60, 120, 240, 360];

        if (!minRange || !maxRange || !trackFill) return;

        const updateSlider = () => {
            let minVal = parseInt(minRange.value);
            let maxVal = parseInt(maxRange.value);

            // Prevent crossing
            if (minVal > maxVal) {
                // If moving min, push max
                // If moving max, push min
                // Just swap or clamp?
                // Standard UI behavior: clamp the one being moved to the other
                // But simplified: just ensure they don't cross in values read
                // But for UI, we want visual separation?
                // Actually, let's allow them to be equal, but not cross
                if (minVal > maxVal) {
                    const temp = minVal;
                    minVal = maxVal;
                    maxVal = temp;
                    // Or stricter: if active element is min, set min = max
                    // Since we can't easily detect active here easily without event source
                    // We'll rely on the values we read.
                    // But changing the input value creates a loop if we are not careful
                }
            }

            // Calculate percentage
            // Range is 0 to 5
            const minPercent = (minVal / 5) * 100;
            const maxPercent = (maxVal / 5) * 100;

            trackFill.style.left = `${minPercent}%`;
            trackFill.style.width = `${maxPercent - minPercent}%`;

            // Update text
            const minText = stops[minVal];
            const maxText = maxVal === 5 ? '360+' : stops[maxVal];
            display.textContent = `${minText} - ${maxText} min`;
        };

        // Attach listeners
        minRange.addEventListener('input', () => {
            let minVal = parseInt(minRange.value);
            let maxVal = parseInt(maxRange.value);

            if (minVal > maxVal) {
                minRange.value = maxVal;
                minVal = maxVal;
            }
            updateSlider();
        });

        maxRange.addEventListener('input', () => {
            let minVal = parseInt(minRange.value);
            let maxVal = parseInt(maxRange.value);

            if (maxVal < minVal) {
                maxRange.value = minVal;
                maxVal = minVal;
            }
            updateSlider();
        });

        // Initial call
        updateSlider();
    }

    setupVotesSlider() {
        // No longer needed - using dropdown instead of slider
    }

    setupRatingSlider() {
        const minRange = document.getElementById('ratingRangeMin');
        const maxRange = document.getElementById('ratingRangeMax');
        const trackFill = document.getElementById('ratingTrackFill');
        const display = document.getElementById('ratingValuesDisplay');

        if (!minRange || !maxRange || !trackFill || !display) return;

        const updateSlider = () => {
            let minVal = parseInt(minRange.value);
            let maxVal = parseInt(maxRange.value);

            // Prevent crossing
            if (minVal > maxVal) {
                if (minVal > maxVal) {
                    const temp = minVal;
                    minVal = maxVal;
                    maxVal = temp;
                }
            }

            // Percentage 0-100
            const minPercent = minVal;
            const maxPercent = maxVal;

            trackFill.style.left = `${minPercent}%`;
            trackFill.style.width = `${maxPercent - minPercent}%`;

            display.textContent = `${minVal} - ${maxVal}`;
        };

        minRange.addEventListener('input', () => {
            let minVal = parseInt(minRange.value);
            let maxVal = parseInt(maxRange.value);
            if (minVal > maxVal) {
                minRange.value = maxVal;
            }
            updateSlider();
        });

        maxRange.addEventListener('input', () => {
            let minVal = parseInt(minRange.value);
            let maxVal = parseInt(maxRange.value);
            if (maxVal < minVal) {
                maxRange.value = minVal;
            }
            updateSlider();
        });

        updateSlider();
    }
}

// Initialize app
let tracker;
document.addEventListener('DOMContentLoaded', () => {
    tracker = new MediaTracker();
    tracker.init();
    tracker.setupRuntimeSlider();
    tracker.setupVotesSlider();
    tracker.setupRatingSlider();
});

