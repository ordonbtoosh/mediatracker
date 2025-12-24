const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");

// GitHub Storage Module (replaces DuckDB)
const githubStorage = require("./github-storage.cjs");

const ROOT_DIR = path.join(__dirname, "../");
const IMG_DIR = path.join(__dirname, "assets", "img");

// GitHub configuration cache
let githubConfig = null;
let githubConfigSha = {}; // Track file SHAs for updates

// Load GitHub configuration from environment or local file
function loadGitHubConfig() {
  // Check environment variables first
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER) {
    githubConfig = {
      token: process.env.GITHUB_TOKEN,
      owner: process.env.GITHUB_OWNER,
      dataRepo: process.env.GITHUB_DATA_REPO || "mediatracker-data",
      imageRepos: (process.env.GITHUB_IMAGE_REPOS || "mediatracker-images-1").split(",").map(s => s.trim())
    };
    console.log("[GitHub] Config loaded from environment variables");
    return githubConfig;
  }

  // Fall back to local config file
  const configPath = path.join(__dirname, "github-config.json");
  if (fs.existsSync(configPath)) {
    try {
      const configData = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      githubConfig = {
        token: configData.githubToken || "",
        owner: configData.githubOwner || "",
        dataRepo: configData.githubDataRepo || "mediatracker-data",
        imageRepos: Array.isArray(configData.githubImageRepos)
          ? configData.githubImageRepos
          : (configData.githubImageRepos || "mediatracker-images-1").split(",").map(s => s.trim())
      };
      console.log("[GitHub] Config loaded from github-config.json");
      return githubConfig;
    } catch (e) {
      console.error("[GitHub] Error loading config file:", e.message);
    }
  }

  console.warn("[GitHub] No configuration found. Please set environment variables or create github-config.json");
  return null;
}

// Get current GitHub config (with lazy loading)
function getGitHubConfig() {
  if (!githubConfig) {
    loadGitHubConfig();
  }
  return githubConfig;
}

// Update GitHub config (called when settings are saved)
function updateGitHubConfig(config) {
  githubConfig = config;
  // Save to local file for persistence
  const configPath = path.join(__dirname, "github-config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify({
      githubToken: config.token,
      githubOwner: config.owner,
      githubDataRepo: config.dataRepo,
      githubImageRepos: config.imageRepos
    }, null, 2));
    console.log("[GitHub] Config saved to github-config.json");
  } catch (e) {
    console.error("[GitHub] Error saving config:", e.message);
  }
}

// Check if GitHub storage is configured
function isGitHubConfigured() {
  const config = getGitHubConfig();
  return config && config.token && config.owner && config.dataRepo;
}

// Helper to get data repo config
function getDataRepoConfig() {
  const config = getGitHubConfig();
  if (!config) return null;
  return {
    owner: config.owner,
    repo: config.dataRepo,
    token: config.token
  };
}

// ===============================
// 🔄 MOCK DB OBJECT - Redirects legacy db.all calls to GitHub
// ===============================
// This mock `db` object intercepts callback-based db.all() calls that were
// used with DuckDB and redirects them to our GitHub storage.
// This allows us to keep the 26+ callback-based endpoints working without
// extensive refactoring.

// Note: settingsCache and settingsCacheTime are defined later near getSettingsRow()
// The mock db object calls getSettingsRow() which uses those cache variables

const db = {
  // Handle db.all() calls - the main query method used by endpoints
  all: function (query, ...args) {
    // Extract callback (last argument if it's a function)
    let callback = args[args.length - 1];
    if (typeof callback !== 'function') {
      console.error("db.all mock: No callback provided");
      return;
    }

    // Check if this is a settings query
    if (query.includes("SELECT * FROM settings")) {
      // Return cached settings asynchronously via callback
      (async () => {
        try {
          // Use getSettingsRow which is defined later
          if (typeof getSettingsRow === 'function') {
            const settings = await getSettingsRow();
            callback(null, [settings]);
          } else {
            callback(null, [{}]);
          }
        } catch (e) {
          console.error("db.all mock error:", e.message);
          callback(null, [{}]);
        }
      })();
    } else {
      // For any other queries, return empty (shouldn't happen with GitHub migration)
      console.warn("db.all mock: Unknown query:", query);
      callback(null, []);
    }
  },

  // Handle db.run() calls - used for INSERT/UPDATE/DELETE
  run: function (query, ...args) {
    let callback = args[args.length - 1];
    if (typeof callback === 'function') {
      // For run commands, just call callback with success
      // Actual writes now go through GitHub API directly
      console.warn("db.run mock called (legacy code path):", query.substring(0, 50));
      callback(null);
    }
  },

  // Handle db.connect() calls - used for connection-based queries
  connect: function () {
    return {
      all: db.all,
      run: db.run,
      close: function () { /* no-op */ }
    };
  }
};

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ extended: false }));

const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || "ordon";
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || "2424";
const AUTH_COOKIE_NAME = "mediaTrackerAuth";
const AUTH_COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 30; // 30 days
const AUTH_TOKEN = crypto
  .createHash("sha256")
  .update(`${BASIC_AUTH_USER}:${BASIC_AUTH_PASS}`)
  .digest("hex");

function escapeHtml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getCookies(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce((acc, part) => {
    const [key, ...rest] = part.trim().split("=");
    if (!key) return acc;
    const value = rest.join("="); // in case value contains '='
    acc[decodeURIComponent(key)] = decodeURIComponent(value || "");
    return acc;
  }, {});
}

function hasValidAuthCookie(req) {
  const cookies = getCookies(req);
  return cookies[AUTH_COOKIE_NAME] === AUTH_TOKEN;
}

function sanitizeRedirect(target) {
  if (!target || typeof target !== "string") return "/";
  try {
    const decoded = decodeURIComponent(target);
    if (decoded.startsWith("/") && !decoded.startsWith("//")) {
      return decoded;
    }
  } catch (e) { }
  return "/";
}

function renderLoginPage(errorMessage = "", rememberChecked = false, nextPath = "/") {
  const errorMarkup = errorMessage
    ? `<div class="login-error">${escapeHtml(errorMessage)}</div>`
    : "";
  const rememberAttr = rememberChecked ? "checked" : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MediaTracker Login</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0e0e0e;
      font-family: Arial, sans-serif;
      color: #f5f5f5;
    }
    .login-card {
      background: rgba(20, 20, 20, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      padding: 2.5rem 2rem;
      width: min(360px, 90vw);
    }
    .login-title {
      font-size: 1.75rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
      color: #ffffff;
    }
    .login-subtitle {
      margin-bottom: 2rem;
      color: #aaaaaa;
      font-size: 0.95rem;
    }
    .login-form {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    label {
      display: block;
      margin-bottom: 0.35rem;
      font-size: 0.9rem;
    }
    input[type="text"],
    input[type="password"] {
      width: 100%;
      padding: 0.75rem;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(0, 0, 0, 0.4);
      color: #f5f5f5;
      font-size: 1rem;
    }
    input[type="text"]:focus,
    input[type="password"]:focus {
      outline: none;
      border-color: #ff4242;
      box-shadow: 0 0 0 2px rgba(255, 66, 66, 0.3);
    }
    .remember-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.85rem;
      color: #bbbbbb;
    }
    .remember-row label {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin: 0;
    }
    .remember-row input[type="checkbox"] {
      width: 16px;
      height: 16px;
    }
    .login-button {
      width: 100%;
      padding: 0.85rem;
      border-radius: 8px;
      border: none;
      background: linear-gradient(135deg, #ff4242, #ff1f7a);
      color: white;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .login-button:hover {
      transform: translateY(-1px);
      box-shadow: 0 10px 25px rgba(255, 66, 66, 0.35);
    }
    .login-error {
      padding: 0.75rem 1rem;
      background: rgba(255, 66, 66, 0.1);
      border: 1px solid rgba(255, 66, 66, 0.4);
      border-radius: 8px;
      color: #ff9b9b;
      font-size: 0.9rem;
      margin-bottom: 1.25rem;
    }
    .login-footer {
      margin-top: 2rem;
      text-align: center;
      font-size: 0.8rem;
      color: #777777;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <h1 class="login-title">Meta Rank</h1>
    <p class="login-subtitle">Please sign in to continue</p>
    ${errorMarkup}
    <form class="login-form" method="POST" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
      <div>
        <label for="username">Username</label>
        <input id="username" name="username" type="text" autocomplete="username" required />
      </div>
      <div>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
      </div>
      <div class="remember-row">
        <label>
          <input type="checkbox" name="remember" ${rememberAttr} />
          Keep me signed in
        </label>
      </div>
      <button class="login-button" type="submit">Sign In</button>
    </form>
    <div class="login-footer">
      Access restricted to authorized users.
    </div>
  </div>
</body>
</html>`;
}

function handleSuccessfulLogin(res, remember, redirectTarget) {
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict"
  };
  if (remember) {
    cookieOptions.maxAge = AUTH_COOKIE_MAX_AGE;
  }
  res.cookie(AUTH_COOKIE_NAME, AUTH_TOKEN, cookieOptions);
  res.redirect(redirectTarget);
}

function basicCredentialsValid(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return false;
  }
  const credentials = Buffer.from(authHeader.split(" ")[1], "base64").toString();
  const separatorIndex = credentials.indexOf(":");
  if (separatorIndex === -1) return false;
  const username = credentials.slice(0, separatorIndex);
  const password = credentials.slice(separatorIndex + 1);
  return username === BASIC_AUTH_USER && password === BASIC_AUTH_PASS;
}

app.get("/login", (req, res) => {
  if (hasValidAuthCookie(req)) {
    return res.redirect(sanitizeRedirect(req.query.next));
  }
  res.set("Cache-Control", "no-store");
  res.send(renderLoginPage("", false, sanitizeRedirect(req.query.next)));
});

app.post("/login", (req, res) => {
  const { username, password, remember, next: nextPath } = req.body || {};
  const redirectTarget = sanitizeRedirect(nextPath);

  const isValid =
    username === BASIC_AUTH_USER && password === BASIC_AUTH_PASS;

  if (!isValid) {
    res.status(401).send(
      renderLoginPage(
        "Invalid username or password. Please try again.",
        remember === "on",
        redirectTarget
      )
    );
    return;
  }

  handleSuccessfulLogin(res, remember === "on", redirectTarget);
});

app.post("/logout", (req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, { httpOnly: true, sameSite: "strict" });
  res.redirect("/login");
});

function authMiddleware(req, res, next) {
  if (hasValidAuthCookie(req)) {
    return next();
  }

  if (basicCredentialsValid(req)) {
    // Honor "remember" flag via query parameter for basic-auth clients; defaults to session cookie.
    const remember =
      req.query && (req.query.remember === "true" || req.query.remember === "1");
    const cookieOptions = {
      httpOnly: true,
      sameSite: "strict"
    };
    if (remember) {
      cookieOptions.maxAge = AUTH_COOKIE_MAX_AGE;
    }
    res.cookie(AUTH_COOKIE_NAME, AUTH_TOKEN, cookieOptions);
    return next();
  }

  const acceptsHtml =
    req.headers.accept && req.headers.accept.includes("text/html");

  // Allow unauthenticated access to login/logout endpoints
  if (req.path === "/login" || req.path === "/logout") {
    return next();
  }

  if (!acceptsHtml) {
    return res.status(401).json({ error: "Authentication required." });
  }

  const redirectTarget = encodeURIComponent(req.originalUrl || "/");
  return res.redirect(`/login?next=${redirectTarget}`);
}

app.use(authMiddleware);

// Initialize GitHub config on startup
loadGitHubConfig();

// Cache for IMDb chart IDs (cache for 1 hour to speed up requests)
const imdbChartCache = {
  movies: { ids: null, timestamp: null },
  tv: { ids: null, timestamp: null }
};
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds

function log(...args) {
  console.log("[MediaServer]", ...args);
}

// ===============================
// ⚙️ Settings endpoints (GitHub Storage)
// ===============================
app.get('/settings', async (req, res) => {
  try {
    if (!isGitHubConfigured()) {
      // Return default settings if GitHub not configured
      log("GitHub not configured, returning default settings");
      return res.json({});
    }

    const config = getDataRepoConfig();
    const result = await githubStorage.getFileContent(config, "settings.json");

    if (!result || !result.content) {
      return res.json({});
    }

    // Store SHA for later updates
    githubConfigSha.settings = result.sha;

    const s = result.content;
    // Parse tabBackgrounds if it's a string
    if (s && s.tabBackgrounds && typeof s.tabBackgrounds === 'string') {
      try {
        s.tabBackgrounds = JSON.parse(s.tabBackgrounds);
      } catch (e) {
        // leave as string if parse fails
      }
    }

    res.json(s);
  } catch (error) {
    console.error('❌ Error reading settings:', error.message);
    // Return empty settings on error to allow app to function
    res.json({});
  }
});

app.post('/settings', async (req, res) => {
  try {
    const s = req.body || {};

    // Handle GitHub configuration if provided
    if (s.githubToken || s.githubOwner || s.githubDataRepo || s.githubImageRepos) {
      const newConfig = {
        token: s.githubToken || (githubConfig?.token || ""),
        owner: s.githubOwner || (githubConfig?.owner || ""),
        dataRepo: s.githubDataRepo || (githubConfig?.dataRepo || "mediatracker-data"),
        imageRepos: s.githubImageRepos
          ? (Array.isArray(s.githubImageRepos) ? s.githubImageRepos : s.githubImageRepos.split(",").map(r => r.trim()))
          : (githubConfig?.imageRepos || ["mediatracker-images-1"])
      };
      updateGitHubConfig(newConfig);

      // Remove GitHub config from settings object (stored separately)
      delete s.githubToken;
      delete s.githubOwner;
      delete s.githubDataRepo;
      delete s.githubImageRepos;
    }

    if (!isGitHubConfigured()) {
      console.warn("GitHub not configured, cannot save settings to GitHub");
      return res.json({ ok: true, warning: "GitHub storage not configured" });
    }

    const config = getDataRepoConfig();

    // Get current settings to preserve SHA
    let currentSha = githubConfigSha.settings || null;
    if (!currentSha) {
      try {
        const current = await githubStorage.getFileContent(config, "settings.json");
        if (current) {
          currentSha = current.sha;
        }
      } catch (e) {
        // File might not exist yet
      }
    }

    // Prepare settings object
    const settingsToSave = {
      themeBackgroundColor: s.themeBackgroundColor || null,
      themeHoverColor: s.themeHoverColor || null,
      themeTitleColor: s.themeTitleColor || null,
      themeTextColor: s.themeTextColor || null,
      themeFontFamily: s.themeFontFamily || null,
      themeDropdownColor: s.themeDropdownColor || null,
      tmdbApiKey: s.tmdbApiKey || null,
      malApiKey: s.malApiKey || null,
      steamApiKey: s.steamApiKey || null,
      steamgriddbApiKey: s.steamgriddbApiKey || null,
      fanarttvApiKey: s.fanarttvApiKey || null,
      omdbApiKey: s.omdbApiKey || null,
      spotifyClientId: s.spotifyClientId || null,
      spotifyClientSecret: s.spotifyClientSecret || null,
      youtubeApiKey: s.youtubeApiKey || null,
      bioMaxChars: Number.isFinite(Number(s.bioMaxChars)) ? Number(s.bioMaxChars) : null,
      tabBackgrounds: s.tabBackgrounds || null
    };

    log("⚙️ Saving settings to GitHub...");

    const result = await githubStorage.createOrUpdateFile(
      config,
      "settings.json",
      settingsToSave,
      "Update settings",
      currentSha
    );

    githubConfigSha.settings = result.sha;

    // Invalidate settings cache so next request gets fresh data
    invalidateSettingsCache();

    log("✅ Settings saved to GitHub");

    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Error saving settings:', error.message);
    res.status(500).json({ error: error.message });
  }
});



// Steam API caching
let steamAppsCache = null;
let steamAppsCacheTime = 0;
const STEAM_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
const STEAM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://store.steampowered.com/",
  "Origin": "https://store.steampowered.com"
};

async function getSteamApps() {
  const now = Date.now();
  if (steamAppsCache && (now - steamAppsCacheTime) < STEAM_CACHE_DURATION) {
    return steamAppsCache;
  }

  try {
    const url = "https://api.steampowered.com/ISteamApps/GetAppList/v0002/";
    const response = await makeRequest(url);
    if (response.statusCode === 200) {
      const data = JSON.parse(response.data);
      steamAppsCache = data.applist?.apps || [];
      steamAppsCacheTime = now;
      log("✅ Cached Steam apps list:", steamAppsCache.length, "games");
      return steamAppsCache;
    }
  } catch (error) {
    console.error("❌ Error fetching Steam apps:", error);
    if (steamAppsCache) return steamAppsCache; // Return stale cache if available
  }

  return [];
}

async function fetchSteamGameDetails(appid, fallback = {}) {
  try {
    const [detailsResponse, reviewsResponse] = await Promise.all([
      makeRequest(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`, { headers: STEAM_HEADERS }),
      makeRequest(`https://store.steampowered.com/appreviews/${appid}?json=1`, { headers: STEAM_HEADERS }).catch(() => ({ statusCode: 500, data: '{}' }))
    ]);

    let userScore = 0;
    if (reviewsResponse.statusCode === 200) {
      try {
        const reviewsData = JSON.parse(reviewsResponse.data);
        if (reviewsData.query_summary && reviewsData.query_summary.total_reviews > 0) {
          const { total_positive, total_reviews } = reviewsData.query_summary;
          userScore = Math.round((total_positive / total_reviews) * 100);
        }
      } catch (e) {
        // Ignore review parsing errors
      }
    }

    if (detailsResponse.statusCode === 200) {
      const data = JSON.parse(detailsResponse.data);
      const appData = data[appid];
      if (appData && appData.success && appData.data) {
        const gameData = appData.data;

        // Extract top 3 categories (user-defined tags from Steam)
        const topCategories = gameData.categories
          ? gameData.categories.slice(0, 3).map(c => c.description || c.name || c)
          : [];

        return {
          id: gameData.steam_appid || appid,
          title: gameData.name || fallback.title || fallback.name || "",
          poster_path: gameData.header_image || fallback.tiny_image || "",
          release_date: gameData.release_date?.date || fallback.release_date || fallback.released || "",
          overview: gameData.short_description || gameData.detailed_description || fallback.short_description || "",
          vote_average: userScore,
          genres: gameData.genres || [],
          developers: gameData.developers || [],
          categories: gameData.categories || [],
          topCategories: topCategories
        };
      }
    }
  } catch (error) {
    console.warn(`⚠️ Steam game detail fetch failed for ${appid}:`, error.message);
  }

  return {
    id: fallback.id || appid,
    title: fallback.title || fallback.name || "",
    poster_path: fallback.tiny_image || "",
    release_date: fallback.release_date || fallback.released || "",
    overview: fallback.short_description || "",
    vote_average: 0,
    genres: [],
    developers: []
  };
}

async function searchSteamStoreGames(query, limit = 15) {
  const searchUrl = `https://store.steampowered.com/api/storesearch?term=${encodeURIComponent(query)}&l=en&cc=us&category1=998`;
  const response = await makeRequest(searchUrl, { headers: STEAM_HEADERS });
  if (response.statusCode !== 200) {
    throw new Error(`Steam search failed (${response.statusCode})`);
  }
  const data = JSON.parse(response.data);
  const items = data.items || [];
  if (!items.length) return [];

  const limited = items.slice(0, limit);
  const games = await Promise.all(limited.map(item => fetchSteamGameDetails(item.id, item)));
  return games.filter(Boolean);
}

// Helper function to make HTTP/HTTPS requests
function makeRequest(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const protocol = url.protocol === "https:" ? https : http;

    const reqOptions = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "GET",
      headers: {},
      ...options
    };

    // Merge any provided headers
    if (options.headers) {
      Object.assign(reqOptions.headers, options.headers);
    }

    const req = protocol.request(reqOptions, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve({ data, statusCode: res.statusCode });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);

    // If a body is provided, write it for POST/PUT requests
    if (options.body) {
      try {
        // Ensure Content-Length header is set
        if (!reqOptions.headers['Content-Length'] && !reqOptions.headers['content-length']) {
          req.setHeader('Content-Length', Buffer.byteLength(options.body));
        }
      } catch (e) {
        // ignore header set errors
      }
      req.write(options.body);
    }

    req.end();
  });
}

// Cache for settings to reduce GitHub API calls
let settingsCache = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Get settings from GitHub (with caching) - replaces DuckDB getSettingsRow
async function getSettingsRow() {
  // Return cached settings if still valid
  if (settingsCache && (Date.now() - settingsCacheTime) < SETTINGS_CACHE_DURATION) {
    return settingsCache;
  }

  try {
    if (!isGitHubConfigured()) {
      return {};
    }

    const config = getDataRepoConfig();
    const result = await githubStorage.getFileContent(config, "settings.json");
    settingsCache = result?.content || {};
    settingsCacheTime = Date.now();
    githubConfigSha.settings = result?.sha;
    return settingsCache;
  } catch (e) {
    console.warn("Could not load settings from GitHub:", e.message);
    return settingsCache || {};
  }
}

// Invalidate settings cache (call after saving settings)
function invalidateSettingsCache() {
  settingsCache = null;
  settingsCacheTime = 0;
}

// ===============================
// 📤 Add / Update item (GitHub Storage)
// ===============================
app.post("/add", async (req, res) => {
  try {
    if (!isGitHubConfigured()) {
      return res.status(500).send("GitHub storage not configured");
    }

    const it = req.body || {};
    console.log("📥 Received item to save:", JSON.stringify(it, null, 2).substring(0, 500));
    const {
      id, title, category, rating, year, genre,
      description, myRank, posterBase64, bannerBase64,
      gender, birthday, placeOfBirth, socialMedia, biography, linkedMovies, externalApiId,
      studio, developer, directorCreator, runtime, episodes, episodeRuntime, timeToBeat, source
    } = it;

    if (!id || !title || !category)
      return res.status(400).send("Missing required fields");

    // For movies and TV series, fetch IMDb rating if externalApiId exists
    let finalRating = rating ?? 0;
    if ((category === 'movies' || category === 'tv') && externalApiId) {
      try {
        // Get API keys from settings
        const config = getDataRepoConfig();
        const settingsResult = await githubStorage.getFileContent(config, "settings.json");
        const settings = settingsResult?.content || {};
        const tmdbApiKey = settings.tmdbApiKey;
        const omdbApiKey = settings.omdbApiKey;

        if (tmdbApiKey && omdbApiKey) {
          try {
            const mediaType = category === 'movies' ? 'movie' : 'tv';
            const tmdbUrl = `https://api.themoviedb.org/3/${mediaType}/${externalApiId}?api_key=${tmdbApiKey}&append_to_response=external_ids`;

            console.log(`🔗 Fetching IMDb rating for ${category} ID: ${externalApiId}`);
            const tmdbResponse = await makeRequest(tmdbUrl);

            if (tmdbResponse.statusCode === 200) {
              const tmdbData = JSON.parse(tmdbResponse.data);
              const imdbId = tmdbData.external_ids?.imdb_id;

              if (imdbId) {
                console.log(`✅ Found IMDb ID: ${imdbId}`);
                const omdbUrl = `https://www.omdbapi.com/?i=${imdbId}&apikey=${omdbApiKey}`;
                const omdbResponse = await makeRequest(omdbUrl);

                if (omdbResponse.statusCode === 200) {
                  const omdbData = JSON.parse(omdbResponse.data);
                  if (omdbData.Response === 'True' && omdbData.imdbRating && omdbData.imdbRating !== 'N/A') {
                    const ratingMatch = omdbData.imdbRating.match(/^([\d.]+)/);
                    if (ratingMatch) {
                      const imdbRating = parseFloat(ratingMatch[1]);
                      finalRating = Math.round(imdbRating * 10);
                      console.log(`✅ Using IMDb rating: ${imdbRating}/10 (${finalRating}%)`);
                    }
                  }
                }
              }
            }
          } catch (imdbError) {
            console.warn("⚠️ Error fetching IMDb rating:", imdbError.message);
          }
        }
      } catch (e) {
        console.warn("⚠️ Error in IMDb rating fetch:", e.message);
      }
    }

    const config = getDataRepoConfig();
    const ghConfig = getGitHubConfig();

    // Get current item if exists (to preserve SHA and image paths)
    let currentItem = null;
    let currentSha = null;
    try {
      const existing = await githubStorage.getFileContent(config, `media/${id}.json`);
      if (existing) {
        currentItem = existing.content;
        currentSha = existing.sha;
      }
    } catch (e) {
      // Item doesn't exist yet
    }

    // Handle poster and banner image uploads to GitHub
    let posterPath = it.posterPath || currentItem?.posterPath || "";
    let posterImageRepo = currentItem?.posterImageRepo || null;
    let bannerPath = it.bannerPath || currentItem?.bannerPath || "";
    let bannerImageRepo = currentItem?.bannerImageRepo || null;

    const needsPosterUpload = posterBase64?.startsWith("data:image");
    const needsBannerUpload = bannerBase64?.startsWith("data:image");

    if (needsPosterUpload || needsBannerUpload) {
      try {
        // Select image repository ONCE for both uploads
        const selectedRepo = await githubStorage.selectImageRepo(
          { owner: ghConfig.owner, token: ghConfig.token },
          ghConfig.imageRepos
        );

        if (selectedRepo) {
          const imgConfig = { owner: ghConfig.owner, repo: selectedRepo, token: ghConfig.token };

          // Upload both images in parallel
          const uploadPromises = [];

          if (needsPosterUpload) {
            uploadPromises.push(
              githubStorage.uploadImage(imgConfig, `${id}_poster.webp`, posterBase64, `Upload poster for ${id}`)
                .then(result => {
                  posterPath = result.downloadUrl;
                  posterImageRepo = selectedRepo;
                  log(`✅ Uploaded poster to ${selectedRepo}: ${posterPath}`);
                })
                .catch(err => {
                  console.error("❌ Error uploading poster to GitHub:", err.message);
                })
            );
          }

          if (needsBannerUpload) {
            uploadPromises.push(
              githubStorage.uploadImage(imgConfig, `${id}_banner.webp`, bannerBase64, `Upload banner for ${id}`)
                .then(result => {
                  bannerPath = result.downloadUrl;
                  bannerImageRepo = selectedRepo;
                  log(`✅ Uploaded banner to ${selectedRepo}: ${bannerPath}`);
                })
                .catch(err => {
                  console.error("❌ Error uploading banner to GitHub:", err.message);
                })
            );
          }

          await Promise.all(uploadPromises);
        } else {
          console.error("❌ No GitHub image repo available. Images will not be saved!");
        }
      } catch (imgError) {
        console.error("❌ Error during image upload:", imgError.message);
      }
    }

    // Create media item object
    const mediaItem = {
      id,
      title: title || "",
      category: category || "",
      rating: finalRating,
      year: year || "",
      genre: genre || "",
      description: description || "",
      myRank: myRank ?? 0,
      posterPath: posterPath || "",
      bannerPath: bannerPath || "",
      posterImageRepo,
      bannerImageRepo,
      gender: gender || "",
      birthday: birthday || "",
      placeOfBirth: placeOfBirth || "",
      socialMedia: socialMedia || "",
      biography: biography || "",
      linkedMovies: linkedMovies || "",
      externalApiId: externalApiId || "",
      studio: studio || "",
      developer: developer || "",
      directorCreator: directorCreator || "",
      runtime: runtime || "",
      episodes: episodes || "",
      episodeRuntime: episodeRuntime || "",
      timeToBeat: timeToBeat || "",
      source: source || ""
    };

    // Save media item to GitHub
    await githubStorage.createOrUpdateFile(
      config,
      `media/${id}.json`,
      mediaItem,
      `${currentSha ? 'Update' : 'Add'} ${title}`,
      currentSha
    );

    // Update media index if new item
    if (!currentSha) {
      try {
        const indexResult = await githubStorage.getFileContent(config, "media/index.json");
        let index = indexResult?.content || [];
        if (!index.includes(id)) {
          index.push(id);
          await githubStorage.createOrUpdateFile(
            config,
            "media/index.json",
            index,
            `Add ${id} to index`,
            indexResult?.sha
          );
        }
      } catch (e) {
        // Create index if doesn't exist
        await githubStorage.createOrUpdateFile(config, "media/index.json", [id], "Initialize media index");
      }
    }

    log("✅ Saved item:", title);
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ /add error:", e.message);
    console.error("❌ /add error stack:", e.stack);
    res.status(500).send(e.message);
  }
});

// ===============================
// 📥 List items (GitHub Storage)
// ===============================
app.get("/list", async (req, res) => {
  try {
    if (!isGitHubConfigured()) {
      return res.json([]);
    }

    const config = getDataRepoConfig();

    // Get media index
    const indexResult = await githubStorage.getFileContent(config, "media/index.json");
    const index = indexResult?.content || [];

    if (index.length === 0) {
      return res.json([]);
    }

    // Fetch all media items
    const items = [];
    for (const id of index) {
      try {
        const itemResult = await githubStorage.getFileContent(config, `media/${id}.json`);
        if (itemResult?.content) {
          items.push(itemResult.content);
        }
      } catch (e) {
        console.warn(`Could not fetch media item ${id}:`, e.message);
      }
    }

    // Sort by title
    items.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

    res.json(items);
  } catch (error) {
    console.error("❌ /list error:", error.message);
    res.json([]);
  }
});

// ===============================
// 🗑️ Delete items (GitHub Storage)
// ===============================
app.post("/delete", async (req, res) => {
  try {
    if (!isGitHubConfigured()) {
      return res.status(500).send("GitHub storage not configured");
    }

    const { ids } = req.body || {};
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).send("Missing or invalid ids array");
    }

    const config = getDataRepoConfig();
    const ghConfig = getGitHubConfig();

    // Helper to extract repo from GitHub URL
    const extractRepoFromUrl = (url) => {
      if (!url || !url.includes('raw.githubusercontent.com')) return null;
      const match = url.match(/raw\.githubusercontent\.com\/[^\/]+\/([^\/]+)/);
      return match ? match[1] : null;
    };

    // Helper to delete image from a specific repo
    const deleteImageFromRepo = async (repo, filename) => {
      try {
        const imgConfig = { owner: ghConfig.owner, repo, token: ghConfig.token };
        const file = await githubStorage.getFileContent(imgConfig, filename);
        if (file) {
          await githubStorage.deleteFile(imgConfig, filename, file.sha, `Delete ${filename}`);
          return true;
        }
      } catch (e) {
        // File might not exist in this repo
      }
      return false;
    };

    // Helper to delete image (try specified repo first, then search all repos)
    const deleteImage = async (id, type, specifiedRepo, urlPath) => {
      const filename = `${id}_${type}.webp`;

      // Try to extract repo from URL if available
      let repoFromUrl = extractRepoFromUrl(urlPath);

      // Try specified repo first
      if (specifiedRepo) {
        if (await deleteImageFromRepo(specifiedRepo, filename)) return true;
      }

      // Try repo from URL
      if (repoFromUrl && repoFromUrl !== specifiedRepo) {
        if (await deleteImageFromRepo(repoFromUrl, filename)) return true;
      }

      // Search all image repos as fallback
      for (const repo of ghConfig.imageRepos) {
        if (repo !== specifiedRepo && repo !== repoFromUrl) {
          if (await deleteImageFromRepo(repo, filename)) return true;
        }
      }

      return false;
    };

    // Delete all items in parallel
    const deletePromises = ids.map(async (id) => {
      try {
        // Get item to find image repos
        const itemResult = await githubStorage.getFileContent(config, `media/${id}.json`);
        if (itemResult) {
          const item = itemResult.content;

          // Delete poster and banner in parallel
          await Promise.all([
            deleteImage(id, 'poster', item.posterImageRepo, item.posterPath),
            deleteImage(id, 'banner', item.bannerImageRepo, item.bannerPath)
          ]);

          // Delete item JSON
          await githubStorage.deleteFile(config, `media/${id}.json`, itemResult.sha, `Delete ${id}`);
        }
      } catch (e) {
        console.warn(`Could not delete item ${id}:`, e.message);
      }

      // Also delete local images if they exist
      try {
        const posterPath = path.join(IMG_DIR, `${id}_poster.webp`);
        const bannerPath = path.join(IMG_DIR, `${id}_banner.webp`);
        if (fs.existsSync(posterPath)) fs.unlinkSync(posterPath);
        if (fs.existsSync(bannerPath)) fs.unlinkSync(bannerPath);
      } catch (e) {
        // Ignore local delete errors
      }
    });

    await Promise.all(deletePromises);

    // Update index
    try {
      const indexResult = await githubStorage.getFileContent(config, "media/index.json");
      if (indexResult) {
        const index = indexResult.content.filter(id => !ids.includes(id));
        await githubStorage.createOrUpdateFile(
          config,
          "media/index.json",
          index,
          `Remove ${ids.length} items from index`,
          indexResult.sha
        );
      }
    } catch (e) {
      console.warn("Could not update index:", e.message);
    }

    log("🗑️ Deleted items:", ids.length);
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ /delete error:", e.message);
    res.status(500).send(e.message);
  }
});

// ===============================
// 🔄 Update rating only (GitHub Storage)
// ===============================
app.patch("/rating", async (req, res) => {
  try {
    if (!isGitHubConfigured()) {
      return res.status(500).send("GitHub storage not configured");
    }

    const { id, myRank } = req.body || {};
    if (!id) return res.status(400).send("Missing id");

    const config = getDataRepoConfig();

    // Get current item
    const itemResult = await githubStorage.getFileContent(config, `media/${id}.json`);
    if (!itemResult) {
      return res.status(404).send("Item not found");
    }

    // Update rating
    const item = itemResult.content;
    item.myRank = myRank ?? 0;

    await githubStorage.createOrUpdateFile(
      config,
      `media/${id}.json`,
      item,
      `Update rating for ${id}`,
      itemResult.sha
    );

    log("⭐ Updated rating:", id);
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ /rating error:", e.message);
    res.status(500).send(e.message);
  }
});

// ===============================
// 🔄 Update item fields (GitHub Storage)
// ===============================
app.patch("/update", async (req, res) => {
  try {
    if (!isGitHubConfigured()) {
      return res.status(500).send("GitHub storage not configured");
    }

    const { id, studio, developer, directorCreator, runtime, episodes, episodeRuntime, timeToBeat } = req.body || {};
    if (!id) return res.status(400).send("Missing id");

    const config = getDataRepoConfig();

    // Get current item
    const itemResult = await githubStorage.getFileContent(config, `media/${id}.json`);
    if (!itemResult) {
      return res.status(404).send("Item not found");
    }

    // Update fields
    const item = itemResult.content;
    if (studio !== undefined) item.studio = studio || "";
    if (developer !== undefined) item.developer = developer || "";
    if (directorCreator !== undefined) item.directorCreator = directorCreator || "";
    if (runtime !== undefined) item.runtime = String(runtime || "");
    if (episodes !== undefined) item.episodes = String(episodes || "");
    if (episodeRuntime !== undefined) item.episodeRuntime = String(episodeRuntime || "");
    if (timeToBeat !== undefined) {
      item.timeToBeat = typeof timeToBeat === 'string' ? timeToBeat : JSON.stringify(timeToBeat || {});
    }

    await githubStorage.createOrUpdateFile(
      config,
      `media/${id}.json`,
      item,
      `Update fields for ${id}`,
      itemResult.sha
    );

    log("✅ Updated item:", id);
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ /update error:", e.message);
    res.status(500).send(e.message);
  }
});

// ===============================
// 🔗 Update linked movies for an actor (GitHub Storage)
// ===============================
app.patch("/actor-linked-movies", async (req, res) => {
  try {
    if (!isGitHubConfigured()) {
      return res.status(500).send("GitHub storage not configured");
    }

    const { id, linkedMovies } = req.body || {};
    if (!id) return res.status(400).send("Missing id");

    const config = getDataRepoConfig();

    // Get current item
    const itemResult = await githubStorage.getFileContent(config, `media/${id}.json`);
    if (!itemResult) {
      return res.status(404).send("Item not found");
    }

    // Update linked movies
    const item = itemResult.content;
    item.linkedMovies = linkedMovies || "";

    await githubStorage.createOrUpdateFile(
      config,
      `media/${id}.json`,
      item,
      `Update linked movies for ${id}`,
      itemResult.sha
    );

    log("🔗 Updated linked movies for actor:", id);
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ /actor-linked-movies error:", e.message);
    res.status(500).send(e.message);
  }
});


// ===============================
// 🖼️ GitHub Image Proxy
// ===============================
app.get('/api/github-image', async (req, res) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl) {
      return res.status(400).send('Missing url parameter');
    }

    // Security check: only allow GitHub URLs
    if (!imageUrl.includes('githubusercontent.com') && !imageUrl.includes('github.com')) {
      return res.status(403).send('Invalid domain');
    }

    if (!isGitHubConfigured()) {
      return res.status(500).send("GitHub storage not configured");
    }

    const config = getDataRepoConfig();

    // Handle raw.githubusercontent.com URLs - use standard HTTPS with auth
    if (imageUrl.includes('raw.githubusercontent.com')) {
      const https = require('https');
      const options = {
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'User-Agent': 'MediaTracker-App'
        }
      };

      https.get(imageUrl, options, (proxyRes) => {
        if (proxyRes.statusCode !== 200) {
          console.error(`GitHub image proxy failed: ${proxyRes.statusCode} for ${imageUrl}`);
          return res.status(proxyRes.statusCode).send('Failed to fetch image');
        }

        // Forward content type
        if (proxyRes.headers['content-type']) {
          res.setHeader('Content-Type', proxyRes.headers['content-type']);
        }

        // Add cache headers for better performance
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day

        // Pipe data
        proxyRes.pipe(res);
      }).on('error', (e) => {
        console.error("Proxy request failed:", e);
        res.status(500).send("Proxy request failed");
      });
      return;
    }

    // Fallback for other GitHub URLs (not expected for current use case)
    res.status(400).send("Only raw GitHub URLs supported currently");

  } catch (e) {
    console.error("❌ /api/github-image error:", e.message);
    res.status(500).send(e.message);
  }
});

// ===============================
// 🔐 Spotify proxy (server-side)
// ===============================
async function getServerSpotifyToken() {
  try {
    // Get settings from GitHub
    let settings = {};
    if (isGitHubConfigured()) {
      try {
        const config = getDataRepoConfig();
        const result = await githubStorage.getFileContent(config, "settings.json");
        settings = result?.content || {};
      } catch (e) {
        console.warn("Could not load settings from GitHub:", e.message);
      }
    }

    const clientId = settings.spotifyClientId || process.env.SPOTIFY_CLIENT_ID || '';
    const clientSecret = settings.spotifyClientSecret || process.env.SPOTIFY_CLIENT_SECRET || '';
    if (!clientId || !clientSecret) {
      throw new Error('Spotify Client ID/Secret not configured on server');
    }

    const tokenResponse = await makeRequest('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64')
      },
      body: 'grant_type=client_credentials'
    });

    if (tokenResponse.statusCode !== 200) {
      throw new Error('Failed to obtain Spotify token');
    }

    const tokenData = JSON.parse(tokenResponse.data || '{}');
    return tokenData.access_token;
  } catch (e) {
    console.error('❌ getServerSpotifyToken error:', e.message);
    throw e;
  }
}

// Return top-tracks for an artist via server proxy
app.get('/spotify/artist/:id/top-tracks', async (req, res) => {
  try {
    const artistId = req.params.id;
    const market = req.query.market || 'US';
    if (!artistId) return res.status(400).json({ error: 'Missing artist id' });

    const accessToken = await getServerSpotifyToken();
    const url = `https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}/top-tracks?market=${encodeURIComponent(market)}`;
    const resp = await makeRequest(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
    if (resp.statusCode !== 200) {
      return res.status(502).json({ error: 'Spotify API error', status: resp.statusCode, data: resp.data });
    }
    const payload = JSON.parse(resp.data || '{}');
    return res.json(payload);
  } catch (e) {
    console.error('❌ /spotify/artist/top-tracks error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ===============================
// 📚 Collections endpoints (GitHub Storage)
// ===============================
// Test route to verify routing works
app.get("/collections-test", (req, res) => {
  log("📚 GET /collections-test called");
  res.json({ test: "collections route is working" });
});

app.get("/collections", async (req, res) => {
  log("📚 GET /collections called");
  res.setHeader('Content-Type', 'application/json');

  try {
    if (!isGitHubConfigured()) {
      return res.json([]);
    }

    const config = getDataRepoConfig();

    // Get collections index
    const indexResult = await githubStorage.getFileContent(config, "collections/index.json");
    const index = indexResult?.content || [];

    if (index.length === 0) {
      return res.json([]);
    }

    // Fetch all collections
    const collections = [];
    for (const id of index) {
      try {
        const collResult = await githubStorage.getFileContent(config, `collections/${id}.json`);
        if (collResult?.content) {
          const coll = collResult.content;
          // Ensure itemIds is an array
          if (typeof coll.itemIds === 'string') {
            try {
              coll.itemIds = JSON.parse(coll.itemIds);
            } catch (e) {
              coll.itemIds = [];
            }
          }
          collections.push(coll);
        }
      } catch (e) {
        console.warn(`Could not fetch collection ${id}:`, e.message);
      }
    }

    // Sort by createdAt DESC
    collections.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    log("✅ Returning collections:", collections.length);
    res.json(collections);
  } catch (error) {
    console.error("❌ /collections GET error:", error.message);
    res.json([]);
  }
});

app.post("/collections", async (req, res) => {
  try {
    if (!isGitHubConfigured()) {
      return res.status(500).send("GitHub storage not configured");
    }

    const collection = req.body || {};
    const { id, name, itemIds, createdAt, posterBase64, bannerBase64, posterPath, bannerPath } = collection;

    if (!id || !name) {
      return res.status(400).send("Missing required fields: id and name");
    }

    const config = getDataRepoConfig();
    const ghConfig = getGitHubConfig();

    // Get current collection if exists
    let currentColl = null;
    let currentSha = null;
    try {
      const existing = await githubStorage.getFileContent(config, `collections/${id}.json`);
      if (existing) {
        currentColl = existing.content;
        currentSha = existing.sha;
      }
    } catch (e) {
      // Collection doesn't exist yet
    }

    let finalPosterPath = posterPath || currentColl?.posterPath || "";
    let finalBannerPath = bannerPath || currentColl?.bannerPath || "";
    let posterImageRepo = currentColl?.posterImageRepo || null;
    let bannerImageRepo = currentColl?.bannerImageRepo || null;

    // Handle poster image upload
    if (posterBase64?.startsWith("data:image")) {
      try {
        const selectedRepo = await githubStorage.selectImageRepo(
          { owner: ghConfig.owner, token: ghConfig.token },
          ghConfig.imageRepos
        );

        if (selectedRepo) {
          const imgConfig = { owner: ghConfig.owner, repo: selectedRepo, token: ghConfig.token };
          const imgResult = await githubStorage.uploadImage(
            imgConfig,
            `collection_${id}_poster.webp`,
            posterBase64,
            `Upload collection poster for ${id}`
          );
          finalPosterPath = imgResult.downloadUrl;
          posterImageRepo = selectedRepo;
        } else {
          finalPosterPath = `assets/img/collection_${id}_poster.webp`;
          fs.writeFileSync(path.join(IMG_DIR, `collection_${id}_poster.webp`),
            Buffer.from(posterBase64.split(",")[1], "base64"));
        }
      } catch (imgError) {
        console.warn("⚠️ Error uploading collection poster:", imgError.message);
        finalPosterPath = `assets/img/collection_${id}_poster.webp`;
        fs.writeFileSync(path.join(IMG_DIR, `collection_${id}_poster.webp`),
          Buffer.from(posterBase64.split(",")[1], "base64"));
      }
    }

    // Handle banner image upload
    if (bannerBase64?.startsWith("data:image")) {
      try {
        const selectedRepo = await githubStorage.selectImageRepo(
          { owner: ghConfig.owner, token: ghConfig.token },
          ghConfig.imageRepos
        );

        if (selectedRepo) {
          const imgConfig = { owner: ghConfig.owner, repo: selectedRepo, token: ghConfig.token };
          const imgResult = await githubStorage.uploadImage(
            imgConfig,
            `collection_${id}_banner.webp`,
            bannerBase64,
            `Upload collection banner for ${id}`
          );
          finalBannerPath = imgResult.downloadUrl;
          bannerImageRepo = selectedRepo;
        } else {
          finalBannerPath = `assets/img/collection_${id}_banner.webp`;
          fs.writeFileSync(path.join(IMG_DIR, `collection_${id}_banner.webp`),
            Buffer.from(bannerBase64.split(",")[1], "base64"));
        }
      } catch (imgError) {
        console.warn("⚠️ Error uploading collection banner:", imgError.message);
        finalBannerPath = `assets/img/collection_${id}_banner.webp`;
        fs.writeFileSync(path.join(IMG_DIR, `collection_${id}_banner.webp`),
          Buffer.from(bannerBase64.split(",")[1], "base64"));
      }
    }

    // Create collection object
    const collectionData = {
      id,
      name: name || "",
      itemIds: itemIds || [],
      createdAt: createdAt || new Date().toISOString(),
      posterPath: finalPosterPath,
      bannerPath: finalBannerPath,
      posterImageRepo,
      bannerImageRepo
    };

    // Save collection to GitHub
    await githubStorage.createOrUpdateFile(
      config,
      `collections/${id}.json`,
      collectionData,
      `${currentSha ? 'Update' : 'Add'} collection ${name}`,
      currentSha
    );

    // Update collections index if new
    if (!currentSha) {
      try {
        const indexResult = await githubStorage.getFileContent(config, "collections/index.json");
        let index = indexResult?.content || [];
        if (!index.includes(id)) {
          index.push(id);
          await githubStorage.createOrUpdateFile(
            config,
            "collections/index.json",
            index,
            `Add ${id} to collections index`,
            indexResult?.sha
          );
        }
      } catch (e) {
        await githubStorage.createOrUpdateFile(config, "collections/index.json", [id], "Initialize collections index");
      }
    }

    log("✅ Saved collection:", name);
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ /collections POST error:", e.message);
    res.status(500).send(e.message);
  }
});

app.patch("/collections/:id", async (req, res) => {
  try {
    if (!isGitHubConfigured()) {
      return res.status(500).send("GitHub storage not configured");
    }

    const { id } = req.params;
    const updates = req.body || {};

    if (!id) {
      return res.status(400).send("Missing collection id");
    }

    const config = getDataRepoConfig();
    const ghConfig = getGitHubConfig();

    // Get current collection
    const collResult = await githubStorage.getFileContent(config, `collections/${id}.json`);
    if (!collResult) {
      return res.status(404).send("Collection not found");
    }

    const collection = collResult.content;

    // Handle poster image upload
    if (updates.posterBase64) {
      let base64Data = updates.posterBase64;
      if (updates.posterBase64.startsWith("data:image")) {
        base64Data = updates.posterBase64.split(",")[1];
      }

      try {
        const selectedRepo = await githubStorage.selectImageRepo(
          { owner: ghConfig.owner, token: ghConfig.token },
          ghConfig.imageRepos
        );

        if (selectedRepo) {
          const imgConfig = { owner: ghConfig.owner, repo: selectedRepo, token: ghConfig.token };
          const imgResult = await githubStorage.uploadImage(
            imgConfig,
            `collection_${id}_poster.webp`,
            base64Data,
            `Update collection poster for ${id}`
          );
          collection.posterPath = imgResult.downloadUrl;
          collection.posterImageRepo = selectedRepo;
        } else {
          const posterPath = `assets/img/collection_${id}_poster.webp`;
          fs.writeFileSync(path.join(IMG_DIR, `collection_${id}_poster.webp`),
            Buffer.from(base64Data, "base64"));
          collection.posterPath = posterPath;
        }
      } catch (e) {
        console.error("❌ Error saving poster image:", e.message);
      }
    }

    // Handle banner image upload
    if (updates.bannerBase64) {
      let base64Data = updates.bannerBase64;
      if (updates.bannerBase64.startsWith("data:image")) {
        base64Data = updates.bannerBase64.split(",")[1];
      }

      try {
        const selectedRepo = await githubStorage.selectImageRepo(
          { owner: ghConfig.owner, token: ghConfig.token },
          ghConfig.imageRepos
        );

        if (selectedRepo) {
          const imgConfig = { owner: ghConfig.owner, repo: selectedRepo, token: ghConfig.token };
          const imgResult = await githubStorage.uploadImage(
            imgConfig,
            `collection_${id}_banner.webp`,
            base64Data,
            `Update collection banner for ${id}`
          );
          collection.bannerPath = imgResult.downloadUrl;
          collection.bannerImageRepo = selectedRepo;
        } else {
          const bannerPath = `assets/img/collection_${id}_banner.webp`;
          fs.writeFileSync(path.join(IMG_DIR, `collection_${id}_banner.webp`),
            Buffer.from(base64Data, "base64"));
          collection.bannerPath = bannerPath;
        }
      } catch (e) {
        console.error("❌ Error saving banner image:", e.message);
      }
    }

    // Apply other updates
    if (updates.name !== undefined) collection.name = updates.name || "";
    if (updates.itemIds !== undefined) collection.itemIds = updates.itemIds || [];
    if (updates.posterPath !== undefined && !updates.posterBase64) collection.posterPath = updates.posterPath || "";
    if (updates.bannerPath !== undefined && !updates.bannerBase64) collection.bannerPath = updates.bannerPath || "";

    // Save updated collection
    await githubStorage.createOrUpdateFile(
      config,
      `collections/${id}.json`,
      collection,
      `Update collection ${id}`,
      collResult.sha
    );

    log("✅ Updated collection:", id);
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ /collections/:id PATCH error:", e.message);
    res.status(500).send(e.message);
  }
});

app.delete("/collections/:id", async (req, res) => {
  try {
    if (!isGitHubConfigured()) {
      return res.status(500).send("GitHub storage not configured");
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).send("Missing collection id");
    }

    const config = getDataRepoConfig();
    const ghConfig = getGitHubConfig();

    // Get collection to find image repos
    try {
      const collResult = await githubStorage.getFileContent(config, `collections/${id}.json`);
      if (collResult) {
        const collection = collResult.content;

        // Delete images from GitHub if they exist
        if (collection.posterImageRepo && collection.posterPath) {
          try {
            const imgConfig = { owner: ghConfig.owner, repo: collection.posterImageRepo, token: ghConfig.token };
            const posterFile = await githubStorage.getFileContent(imgConfig, `collection_${id}_poster.webp`);
            if (posterFile) {
              await githubStorage.deleteFile(imgConfig, `collection_${id}_poster.webp`, posterFile.sha, `Delete collection poster for ${id}`);
            }
          } catch (e) {
            console.warn(`Could not delete poster for collection ${id}:`, e.message);
          }
        }

        if (collection.bannerImageRepo && collection.bannerPath) {
          try {
            const imgConfig = { owner: ghConfig.owner, repo: collection.bannerImageRepo, token: ghConfig.token };
            const bannerFile = await githubStorage.getFileContent(imgConfig, `collection_${id}_banner.webp`);
            if (bannerFile) {
              await githubStorage.deleteFile(imgConfig, `collection_${id}_banner.webp`, bannerFile.sha, `Delete collection banner for ${id}`);
            }
          } catch (e) {
            console.warn(`Could not delete banner for collection ${id}:`, e.message);
          }
        }

        // Delete collection JSON
        await githubStorage.deleteFile(config, `collections/${id}.json`, collResult.sha, `Delete collection ${id}`);
      }
    } catch (e) {
      console.warn(`Could not delete collection ${id}:`, e.message);
    }

    // Delete local images if they exist
    try {
      const posterPath = path.join(IMG_DIR, `collection_${id}_poster.webp`);
      const bannerPath = path.join(IMG_DIR, `collection_${id}_banner.webp`);
      if (fs.existsSync(posterPath)) fs.unlinkSync(posterPath);
      if (fs.existsSync(bannerPath)) fs.unlinkSync(bannerPath);
    } catch (e) {
      console.warn(`Could not delete local images for collection ${id}:`, e.message);
    }

    // Update index
    try {
      const indexResult = await githubStorage.getFileContent(config, "collections/index.json");
      if (indexResult) {
        const index = indexResult.content.filter(cid => cid !== id);
        await githubStorage.createOrUpdateFile(
          config,
          "collections/index.json",
          index,
          `Remove ${id} from collections index`,
          indexResult.sha
        );
      }
    } catch (e) {
      console.warn("Could not update collections index:", e.message);
    }

    log("🗑️ Deleted collection:", id);
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ /collections/:id DELETE error:", e.message);
    res.status(500).send(e.message);
  }
});

// ===============================
// 🔍 API Proxy endpoints
// ===============================
app.get("/api/search", async (req, res) => {
  try {
    const { query, category, service } = req.query;
    if (!query || !category || !service) {
      return res.status(400).send("Missing required parameters");
    }

    // Genre Mapping (Simple) - Duplicated here to ensure it's available for search results
    const genreMap = {
      'action': 28, 'adventure': 12, 'animation': 16, 'comedy': 35,
      'crime': 80, 'documentary': 99, 'drama': 18, 'family': 10751,
      'fantasy': 14, 'history': 36, 'horror': 27, 'music': 10402,
      'mystery': 9648, 'romance': 10749, 'science fiction': 878, 'sci-fi': 878,
      'tv movie': 10770, 'thriller': 53, 'war': 10752, 'western': 37,
      'action & adventure': 10759, 'kids': 10762, 'news': 10763,
      'reality': 10764, 'sci-fi & fantasy': 10765, 'soap': 10766,
      'talk': 10767, 'war & politics': 10768
    };

    // Reverse Map for response
    const idToGenreMap = Object.entries(genreMap).reduce((acc, [name, id]) => {
      acc[id] = name.charAt(0).toUpperCase() + name.slice(1);
      if (name === 'sci-fi') acc[id] = 'Science Fiction';
      if (name === 'tv movie') acc[id] = 'TV Movie';
      if (name === 'science fiction') acc[id] = 'Science Fiction';
      return acc;
    }, {});

    // Get API key from settings
    db.all("SELECT * FROM settings WHERE id=1", (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};

      let apiKey, url;

      if (service === "tmdb") {
        apiKey = settings.tmdbApiKey;
        if (!apiKey) return res.status(400).json({ error: "TMDB API key not configured" });

        // Accept both singular and plural category values (e.g. "movie" and "movies")
        let endpoint = "https://api.themoviedb.org/3/search/";
        const cat = (category || "").toString().toLowerCase();
        if (cat === "movies" || cat === "movie") endpoint += "movie";
        else if (cat === "tv" || cat === "series") endpoint += "tv";
        else if (cat === "actors" || cat === "actor" || cat === "people") endpoint += "person";
        else endpoint += "movie"; // default to movie search when unknown

        url = `${endpoint}?api_key=${apiKey}&query=${encodeURIComponent(query)}`;
      } else if (service === "mal") {
        apiKey = settings.malApiKey;
        if (!apiKey) return res.status(400).json({ error: "MyAnimeList API key not configured" });

        url = `https://api.myanimelist.net/v2/anime?q=${encodeURIComponent(query)}&limit=20&fields=id,title,main_picture,start_date,synopsis,mean,genres,num_episodes,average_episode_duration`;
      } else if (service === "rawg") {
        searchSteamStoreGames(query)
          .then(results => res.json({ results }))
          .catch(error => {
            console.error("Steam search error:", error);
            res.status(500).json({ error: error.message });
          });
        return;
      } else {
        return res.status(400).json({ error: "Unknown service" });
      }

      // Fetch from external API using helper function
      let options = {};
      if (service === "mal") {
        options.headers = { "X-MAL-CLIENT-ID": apiKey };
      }

      makeRequest(url, options)
        .then(response => {
          if (response.statusCode !== 200) {
            throw new Error(`API returned status ${response.statusCode}: ${response.data}`);
          }

          const data = JSON.parse(response.data);

          if (service === "tmdb") {
            // Convert TMDB scores from 0-10 scale to 0-100 scale
            if (data.results) {
              data.results = data.results.map(item => ({
                ...item,
                vote_average: item.vote_average ? Math.round(item.vote_average * 10) : 0,
                // Map genre_ids to string names for frontend filtering
                genre: (item.genre_ids || []).map(id => idToGenreMap[id]).filter(Boolean).join(', ')
              }));
            }
            res.json(data);
          } else if (service === "mal") {
            // Format MAL data to be consistent with TMDB
            const formatted = (data.data || []).map(item => {
              const node = item.node || item;
              const averageDurationSeconds = Number.isFinite(node.average_episode_duration) ? node.average_episode_duration : null;
              const averageDurationMinutes = averageDurationSeconds != null ? parseFloat((averageDurationSeconds / 60).toFixed(1)) : null;
              return {
                id: node.id,
                title: node.title,
                poster_path: node.main_picture?.large || "",
                release_date: node.start_date || "",
                overview: node.synopsis || "",
                vote_average: node.mean ? Math.round(node.mean * 10) : 0,
                genres: node.genres || [],
                // Add flat genre string for uniformity
                genre: (node.genres || []).map(g => g.name).join(', '),
                num_episodes: Number.isFinite(node.num_episodes) ? node.num_episodes : null,
                average_episode_duration_seconds: averageDurationSeconds,
                average_episode_duration_minutes: averageDurationMinutes
              };
            });
            res.json({ results: formatted });
          }
        })
        .catch(error => {
          console.error("❌ API fetch error:", error);
          res.status(500).json({ error: error.message });
        });
    });
  } catch (e) {
    console.error("❌ /api/search error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 👤 Get TMDB Person Details endpoint
// ===============================
app.get("/api/person/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).send("Missing person ID parameter");
    }

    // Get API keys from settings
    db.all("SELECT * FROM settings WHERE id=1", (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};

      const apiKey = settings.tmdbApiKey;
      if (!apiKey) {
        return res.status(400).json({ error: "TMDB API key not configured" });
      }

      // Fetch person details including external_ids
      const url = `https://api.themoviedb.org/3/person/${id}?api_key=${apiKey}&append_to_response=external_ids`;

      makeRequest(url)
        .then(response => {
          if (response.statusCode !== 200) {
            throw new Error(`API returned status ${response.statusCode}: ${response.data}`);
          }

          const data = JSON.parse(response.data);
          res.json(data);
        })
        .catch(error => {
          console.error("❌ TMDB person fetch error:", error);
          res.status(500).json({ error: error.message });
        });
    });
  } catch (e) {
    console.error("❌ /api/person/:id error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get IMDb rating from OMDb API using TMDb ID
app.get("/api/imdb-rating/:tmdbId/:type", async (req, res) => {
  try {
    const { tmdbId, type } = req.params;
    if (!tmdbId || !type) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    // Get API keys from settings
    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};

      const tmdbApiKey = settings.tmdbApiKey;
      const omdbApiKey = settings.omdbApiKey;

      if (!tmdbApiKey) {
        return res.status(400).json({ error: "TMDB API key not configured" });
      }

      if (!omdbApiKey) {
        return res.status(400).json({ error: "OMDb API key not configured" });
      }

      try {
        // Step 1: Get IMDb ID from TMDb external_ids
        const mediaType = type === 'movies' ? 'movie' : 'tv';
        const tmdbUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${tmdbApiKey}&append_to_response=external_ids`;

        console.log(`🔗 Fetching TMDb external_ids for ${mediaType} ID: ${tmdbId}`);
        const tmdbResponse = await makeRequest(tmdbUrl);

        if (tmdbResponse.statusCode !== 200) {
          throw new Error(`TMDb API returned status ${tmdbResponse.statusCode}`);
        }

        const tmdbData = JSON.parse(tmdbResponse.data);
        const imdbId = tmdbData.external_ids?.imdb_id;

        if (!imdbId) {
          console.warn(`⚠️ No IMDb ID found for TMDb ${mediaType} ID: ${tmdbId}`);
          return res.json({ imdbRating: null, error: "IMDb ID not found" });
        }

        console.log(`✅ Found IMDb ID: ${imdbId}`);

        // Step 2: Get IMDb rating from OMDb
        const omdbUrl = `https://www.omdbapi.com/?i=${imdbId}&apikey=${omdbApiKey}`;
        const omdbResponse = await makeRequest(omdbUrl);

        if (omdbResponse.statusCode !== 200) {
          throw new Error(`OMDb API returned status ${omdbResponse.statusCode}`);
        }

        const omdbData = JSON.parse(omdbResponse.data);

        if (omdbData.Response === 'False') {
          console.warn(`⚠️ OMDb API error: ${omdbData.Error}`);
          return res.json({ imdbRating: null, error: omdbData.Error });
        }

        // Parse IMDb rating (format: "X.X/10" or "N/A")
        let imdbRating = null;
        if (omdbData.imdbRating && omdbData.imdbRating !== 'N/A') {
          const ratingMatch = omdbData.imdbRating.match(/^([\d.]+)/);
          if (ratingMatch) {
            imdbRating = parseFloat(ratingMatch[1]);
          }
        }

        console.log(`✅ IMDb rating fetched: ${imdbRating}`);
        res.json({ imdbRating, imdbId });
      } catch (error) {
        console.error("❌ Error fetching IMDb rating:", error);
        res.status(500).json({ error: error.message, imdbRating: null });
      }
    });
  } catch (e) {
    console.error("❌ /api/imdb-rating error:", e.message);
    res.status(500).json({ error: e.message, imdbRating: null });
  }
});

// ===============================
// 👥 Get TMDB Cast endpoint (for movies/TV)
// ===============================
app.get("/api/cast", async (req, res) => {
  try {
    const { category, id } = req.query;
    if (!category || !id) {
      return res.status(400).send("Missing required parameters");
    }

    // Get API keys from settings
    db.all("SELECT * FROM settings WHERE id=1", (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};

      const apiKey = settings.tmdbApiKey;
      if (!apiKey) {
        return res.status(400).json({ error: "TMDB API key not configured" });
      }

      // For movies use 'movie', for TV use 'tv'
      const endpoint = category === 'tv' ? 'tv' : 'movie';
      const url = `https://api.themoviedb.org/3/${endpoint}/${id}/credits?api_key=${apiKey}`;

      makeRequest(url)
        .then(response => {
          if (response.statusCode !== 200) {
            throw new Error(`API returned status ${response.statusCode}: ${response.data}`);
          }

          const data = JSON.parse(response.data);
          // Return cast members (actors) and crew (directors, etc.)
          res.json({
            cast: data.cast || [],
            crew: data.crew || []
          });
        })
        .catch(error => {
          console.error("❌ TMDB cast fetch error:", error);
          res.status(500).json({ error: error.message });
        });
    });
  } catch (e) {
    console.error("❌ /api/cast error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 🎥 Get Videos/Trailers endpoint
// ===============================
app.get("/api/videos", async (req, res) => {
  try {
    const { category, id } = req.query;
    if (!category || !id) {
      return res.status(400).send("Missing required parameters");
    }

    db.all("SELECT * FROM settings WHERE id=1", (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};
      const apiKey = settings.tmdbApiKey;

      if (!apiKey) {
        return res.status(400).json({ error: "TMDB API key not configured" });
      }

      const endpoint = category === 'tv' ? 'tv' : 'movie';
      const url = `https://api.themoviedb.org/3/${endpoint}/${id}/videos?api_key=${apiKey}`;

      makeRequest(url)
        .then(response => {
          if (response.statusCode !== 200) {
            throw new Error(`API returned status ${response.statusCode}`);
          }
          const data = JSON.parse(response.data);
          res.json(data);
        })
        .catch(error => {
          console.error("❌ TMDB videos fetch error:", error);
          res.status(500).json({ error: error.message });
        });
    });
  } catch (e) {
    console.error("❌ /api/videos error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 🎯 Get Recommendations endpoint
// ===============================
app.get("/api/recommendations", async (req, res) => {
  try {
    const { category, id } = req.query;
    if (!category || !id) {
      return res.status(400).send("Missing required parameters");
    }

    db.all("SELECT * FROM settings WHERE id=1", (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};
      const apiKey = settings.tmdbApiKey;

      if (!apiKey) {
        return res.status(400).json({ error: "TMDB API key not configured" });
      }

      const endpoint = category === 'tv' ? 'tv' : 'movie';
      const url = `https://api.themoviedb.org/3/${endpoint}/${id}/recommendations?api_key=${apiKey}`;

      makeRequest(url)
        .then(response => {
          if (response.statusCode !== 200) {
            throw new Error(`API returned status ${response.statusCode}`);
          }
          const data = JSON.parse(response.data);
          res.json(data);
        })
        .catch(error => {
          console.error("❌ TMDB recommendations fetch error:", error);
          res.status(500).json({ error: error.message });
        });
    });
  } catch (e) {
    console.error("❌ /api/recommendations error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 📝 Get Reviews endpoint
// ===============================
app.get("/api/reviews", async (req, res) => {
  try {
    const { category, id } = req.query;
    if (!category || !id) {
      return res.status(400).send("Missing required parameters");
    }

    db.all("SELECT * FROM settings WHERE id=1", (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};
      const apiKey = settings.tmdbApiKey;

      if (!apiKey) {
        return res.status(400).json({ error: "TMDB API key not configured" });
      }

      const endpoint = category === 'tv' ? 'tv' : 'movie';
      const url = `https://api.themoviedb.org/3/${endpoint}/${id}/reviews?api_key=${apiKey}`;

      makeRequest(url)
        .then(response => {
          if (response.statusCode !== 200) {
            throw new Error(`API returned status ${response.statusCode}`);
          }
          const data = JSON.parse(response.data);
          res.json(data);
        })
        .catch(error => {
          console.error("❌ TMDB reviews fetch error:", error);
          res.status(500).json({ error: error.message });
        });
    });
  } catch (e) {
    console.error("❌ /api/reviews error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 🎮 Get Steam Game Details endpoint
// ===============================
app.get("/api/steam-game/:appid", async (req, res) => {
  try {
    const { appid } = req.params;
    if (!appid) {
      return res.status(400).send("Missing app ID");
    }

    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english&cc=us`;

    // Fetch both API data and store page HTML to get user tags
    const [apiResponse, storePageResponse] = await Promise.all([
      makeRequest(url),
      makeRequest(`https://store.steampowered.com/app/${appid}`, { headers: STEAM_HEADERS }).catch(() => ({ statusCode: 500, data: '' }))
    ]);

    if (apiResponse.statusCode !== 200) {
      throw new Error(`API returned status ${apiResponse.statusCode}`);
    }

    const data = JSON.parse(apiResponse.data);
    const gameData = data[appid];

    if (gameData && gameData.success) {
      const result = gameData.data;

      // Extract user-defined tags from InitAppTagModal JSON in the HTML
      if (storePageResponse.statusCode === 200) {
        const html = storePageResponse.data;

        // Look for InitAppTagModal function - it contains tag data as JSON array
        // Pattern: InitAppTagModal( appid, [tags array], ...
        const tagModalRegex = /InitAppTagModal\s*\(\s*\d+\s*,\s*(\[[\s\S]*?\])\s*,/;
        const match = html.match(tagModalRegex);

        if (match && match[1]) {
          try {
            // Clean up the JSON string (remove extra whitespace/newlines)
            const jsonStr = match[1].replace(/\s+/g, ' ');
            const tagData = JSON.parse(jsonStr);

            // Extract tag names, already sorted by popularity (count)
            result.userTags = tagData.map(tag => tag.name);
            console.log(`✅ Extracted ${result.userTags.length} user tags for appid ${appid}`);
          } catch (parseErr) {
            console.warn(`⚠️ Failed to parse tag data for appid ${appid}:`, parseErr.message);
            result.userTags = [];
          }
        } else {
          console.warn(`⚠️ No InitAppTagModal found for appid ${appid}`);
          result.userTags = [];
        }
      }

      res.json(result);
    } else {
      res.status(404).json({ error: "Game not found" });
    }
  } catch (e) {
    console.error("❌ /api/steam-game error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 🎮 Get Game Relations (DLC, Similar Games) endpoint
// ===============================
app.get("/api/game-relations/:appid", async (req, res) => {
  try {
    const { appid } = req.params;
    if (!appid) {
      return res.status(400).send("Missing app ID");
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const steamCookie = `steamCountry=US%7C${currentTimestamp}; timezoneOffset=0,0;`;
    const steamHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": `https://store.steampowered.com/app/${appid}/`,
      "X-Requested-With": "XMLHttpRequest",
      "Origin": "https://store.steampowered.com",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "Cookie": steamCookie
    };

    // Fetch game details with DLC and packages
    const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en&filters=basic,dlc,packages`;
    const response = await makeRequest(detailsUrl, { headers: steamHeaders });

    if (response.statusCode !== 200) {
      throw new Error(`API returned status ${response.statusCode}`);
    }

    const data = JSON.parse(response.data);
    const appData = data[appid];

    if (!appData || !appData.success || !appData.data) {
      return res.json({ dlc: [], similar_games: [] });
    }

    const gameData = appData.data;

    // Extract DLC
    const dlcList = [];
    if (gameData.dlc && Array.isArray(gameData.dlc)) {
      for (const dlcId of gameData.dlc) {
        try {
          const dlcUrl = `https://store.steampowered.com/api/appdetails?appids=${dlcId}&l=english`;
          const dlcResponse = await makeRequest(dlcUrl);
          if (dlcResponse.statusCode === 200) {
            const dlcData = JSON.parse(dlcResponse.data);
            const dlcAppData = dlcData[dlcId];
            if (dlcAppData && dlcAppData.success && dlcAppData.data) {
              dlcList.push({
                appid: dlcAppData.data.steam_appid,
                id: dlcAppData.data.steam_appid,
                name: dlcAppData.data.name,
                header_image: dlcAppData.data.header_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${dlcId}/header.jpg`
              });
            }
          }
        } catch (dlcError) {
          console.warn(`⚠️ Failed to fetch DLC ${dlcId}:`, dlcError.message);
        }
        // Limit to 10 DLC items
        if (dlcList.length >= 10) break;
      }
    }

    // Extract similar games (from recommendations endpoint)
    let similarGames = [];
    try {
      const similarUrl = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en&filters=basic,similar_games`;
      const similarResponse = await makeRequest(similarUrl, { headers: steamHeaders });
      if (similarResponse.statusCode === 200) {
        const similarData = JSON.parse(similarResponse.data);
        const similarAppData = similarData[appid];
        if (similarAppData && similarAppData.success && similarAppData.data) {
          const similarGamesData = Array.isArray(similarAppData.data.similar_games)
            ? similarAppData.data.similar_games
            : [];
          similarGames = similarGamesData
            .slice(0, 10) // Limit to 10 similar games
            .map(item => ({
              appid: item.id || item.appid,
              id: item.id || item.appid,
              name: item.name,
              header_image: item.capsule_image || item.header_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.id || item.appid}/header.jpg`
            }))
            .filter(item => item.appid && item.name && String(item.appid) !== String(appid)); // Exclude self
        }
      }
    } catch (similarError) {
      console.warn(`⚠️ Failed to fetch similar games:`, similarError.message);
    }

    res.json({
      dlc: dlcList,
      similar_games: similarGames
    });
  } catch (e) {
    console.error("❌ /api/game-relations error:", e.message);
    res.json({ dlc: [], similar_games: [] });
  }
});

// ===============================
// 📺 Get TMDB Full Details endpoint
// ===============================
app.get("/api/tmdb-details", async (req, res) => {
  try {
    const { category, id } = req.query;
    if (!category || !id) {
      return res.status(400).send("Missing required parameters");
    }

    db.all("SELECT * FROM settings WHERE id=1", (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};
      const apiKey = settings.tmdbApiKey;

      if (!apiKey) {
        return res.status(400).json({ error: "TMDB API key not configured" });
      }

      const endpoint = category === 'tv' ? 'tv' : 'movie';
      const url = `https://api.themoviedb.org/3/${endpoint}/${id}?api_key=${apiKey}`;

      makeRequest(url)
        .then(response => {
          if (response.statusCode !== 200) {
            throw new Error(`API returned status ${response.statusCode}`);
          }
          const data = JSON.parse(response.data);
          res.json(data);
        })
        .catch(error => {
          console.error("❌ TMDB details fetch error:", error);
          res.status(500).json({ error: error.message });
        });
    });
  } catch (e) {
    console.error("❌ /api/tmdb-details error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 🎯 Get Steam Recommendations endpoint
// ===============================
app.get("/api/steam-recommendations/:appid", async (req, res) => {
  try {
    const { appid } = req.params;
    if (!appid) {
      return res.status(400).send("Missing app ID");
    }

    // Get the game details to extract genres and categories
    const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en`;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const steamCookie = `steamCountry=US%7C${currentTimestamp}; timezoneOffset=0,0;`;
    const steamHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": `https://store.steampowered.com/app/${appid}/`,
      "X-Requested-With": "XMLHttpRequest",
      "Origin": "https://store.steampowered.com",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "Cookie": steamCookie
    };

    makeRequest(detailsUrl, { headers: steamHeaders })
      .then(async (response) => {
        if (response.statusCode !== 200) {
          throw new Error(`API returned status ${response.statusCode}`);
        }

        const data = JSON.parse(response.data);
        const gameData = data[appid];

        if (!gameData || !gameData.success) {
          return res.json({ recommendations: [] });
        }

        const game = gameData.data;
        const gameName = game.name || '';

        console.log(`🎮 Fetching recommendations for "${gameName}" (appid: ${appid})`);

        let officialSimilar = [];

        // Fetch user tags from store page to get the most accurate primary genre
        let primaryTag = null;
        try {
          const storePageResponse = await makeRequest(`https://store.steampowered.com/app/${appid}`, { headers: steamHeaders });
          if (storePageResponse.statusCode === 200) {
            const html = storePageResponse.data;
            const tagModalRegex = /InitAppTagModal\s*\(\s*\d+\s*,\s*(\[[\s\S]*?\])\s*,/;
            const match = html.match(tagModalRegex);

            if (match && match[1]) {
              try {
                const jsonStr = match[1].replace(/\s+/g, ' ');
                const tagData = JSON.parse(jsonStr);

                if (tagData.length > 0) {
                  // Just use the very first tag - it's the most popular one
                  primaryTag = tagData[0].name;
                  console.log(`🏷️ Using first tag for recommendations: "${primaryTag}"`);
                }
              } catch (parseErr) {
                console.warn('⚠️ Failed to parse user tags');
              }
            }
          }
        } catch (err) {
          console.warn('⚠️ Failed to fetch user tags from store page');
        }

        // Use the primary user tag for recommendations (fallback to first official genre)
        console.log(`🔍 Searching for similar games...`);

        if (!officialSimilar.length) {
          // Use the primary tag (first user tag or first official genre)
          let searchTag = primaryTag;

          if (!searchTag && game.genres && Array.isArray(game.genres) && game.genres.length > 0) {
            searchTag = game.genres[0].description || game.genres[0].name || game.genres[0];
            console.log(`🏷️ Using fallback genre: "${searchTag}"`);
          }

          if (searchTag) {
            console.log(`🔍 Searching Steam for: "${searchTag}"`);
            const searchUrl = `https://store.steampowered.com/search/results/?term=${encodeURIComponent(searchTag)}&category1=998&ndl=1&json=1`;

            try {
              const searchResponse = await makeRequest(searchUrl, { headers: steamHeaders });
              if (searchResponse.statusCode === 200) {
                const searchData = JSON.parse(searchResponse.data);
                if (searchData.items && Array.isArray(searchData.items) && searchData.items.length > 0) {
                  console.log(`🔍 Found ${searchData.items.length} games for "${searchTag}"`);
                  console.log(`🔍 Found ${searchData.items.length} games via tag search: "${searchTag}"`);

                  officialSimilar = searchData.items
                    .map(item => {
                      // Extract app ID from logo URL: .../apps/1335200/...
                      const logoUrl = item.logo || item.tiny_image || '';
                      const appidMatch = logoUrl.match(/\/apps\/(\d+)\//);
                      const itemId = appidMatch ? parseInt(appidMatch[1], 10) : (parseInt(item.id || item.appid) || null);
                      const itemName = item.name || item.title || '';

                      if (!itemId || isNaN(itemId) || itemId === parseInt(appid) || !itemName) {
                        return null;
                      }

                      const headerImage = logoUrl
                        ? logoUrl.replace('capsule_sm_120', 'header').replace('/sm_120', '')
                        : `https://cdn.cloudflare.steamstatic.com/steam/apps/${itemId}/header.jpg`;

                      return {
                        appid: itemId,
                        id: itemId,
                        name: itemName,
                        header_image: headerImage
                      };
                    })
                    .filter(item => item !== null)
                    .slice(0, 6);

                  console.log(`✅ Using ${officialSimilar.length} tag-based recommendations`);
                }
              }
            } catch (searchErr) {
              console.warn(`Tag search failed for "${searchTag}":`, searchErr.message);
            }
          }

          // If still no results, return empty
          if (!officialSimilar.length) {
            console.log(`ℹ️ No recommendations available for ${appid}`);
            return res.json({ recommendations: [] });
          }
        }

        const recommendations = [];
        const seenAppIds = new Set([String(appid)]);
        for (const similar of officialSimilar) {
          const simAppId = similar?.appid || similar?.id;
          const simName = similar?.name;
          if (!simAppId || !simName) continue;
          const key = String(simAppId);
          if (seenAppIds.has(key)) continue;
          seenAppIds.add(key);
          recommendations.push({
            appid: simAppId,
            id: simAppId,
            name: simName,
            header_image: similar.header_image || null
          });
          if (recommendations.length >= 6) break;
        }

        const finalRecommendations = recommendations.slice(0, 6);
        console.log(`Returning ${finalRecommendations.length} official Steam recommendations for ${appid}`);
        res.json({ recommendations: finalRecommendations });
      })
      .catch(error => {
        console.error("❌ Steam recommendations fetch error:", error);
        res.json({ recommendations: [] });
      });
  } catch (e) {
    console.error("❌ /api/steam-recommendations error:", e.message);
    res.json({ recommendations: [] });
  }
});

function decodeHtmlEntities(str = "") {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

// ===============================
// 💬 Get Steam Reviews endpoint
// ===============================
app.get("/api/steam-reviews/:appid", async (req, res) => {
  try {
    const { appid } = req.params;
    if (!appid) {
      return res.status(400).send("Missing app ID");
    }

    // Use Steam's official reviews API - filter for English only
    const url = `https://store.steampowered.com/appreviews/${appid}?json=1&num_per_page=20&filter=recent&language=english&purchase_type=all`;

    makeRequest(url)
      .then(response => {
        if (response.statusCode !== 200) {
          throw new Error(`API returned status ${response.statusCode}`);
        }

        const data = JSON.parse(response.data);
        const reviews = (data.reviews || []).map(review => ({
          author: review.author?.steamid || 'Steam User',
          review: review.review || '',
          voted_up: review.voted_up,
          votes_up: review.votes_up,
          weighted_vote_score: review.weighted_vote_score
        }));

        res.json({ reviews });
      })
      .catch(error => {
        console.error("❌ Steam reviews fetch error:", error);
        res.json({ reviews: [] });
      });
  } catch (e) {
    console.error("❌ /api/steam-reviews error:", e.message);
    res.json({ reviews: [] });
  }
});

// ===============================
// 🔍 YouTube Search endpoint (for anime trailers)
// ===============================
app.get("/api/youtube-search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).send("Missing search query");
    }

    // Use YouTube's oEmbed API (no API key required) or invidious
    // Alternative: Use a simple search that returns the first result
    const searchQuery = encodeURIComponent(q);

    // Try using Invidious API (open source YouTube frontend)
    const invidiousUrl = `https://inv.tux.pizza/api/v1/search?q=${searchQuery}&type=video`;

    makeRequest(invidiousUrl)
      .then(response => {
        if (response.statusCode !== 200) {
          // Fallback to returning empty
          return res.json({ videoId: null });
        }

        const data = JSON.parse(response.data);
        if (data && data.length > 0) {
          // Return the first video result
          const firstVideo = data[0];
          res.json({
            videoId: firstVideo.videoId,
            title: firstVideo.title,
            thumbnail: firstVideo.videoThumbnails?.[0]?.url
          });
        } else {
          res.json({ videoId: null });
        }
      })
      .catch(error => {
        console.error("❌ YouTube search error:", error);
        res.json({ videoId: null });
      });
  } catch (e) {
    console.error("❌ /api/youtube-search error:", e.message);
    res.json({ videoId: null });
  }
});

// ===============================
// 🎬 Get TMDB Filmography endpoint (for actors)
// ===============================
app.get("/api/filmography", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).send("Missing id parameter");
    }

    // Get API keys from settings
    db.all("SELECT * FROM settings WHERE id=1", (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};

      const apiKey = settings.tmdbApiKey;
      if (!apiKey) {
        return res.status(400).json({ error: "TMDB API key not configured" });
      }

      // Fetch person's combined credits (both movies and TV)
      const url = `https://api.themoviedb.org/3/person/${id}/combined_credits?api_key=${apiKey}`;

      makeRequest(url)
        .then(response => {
          if (response.statusCode !== 200) {
            throw new Error(`API returned status ${response.statusCode}: ${response.data}`);
          }

          const data = JSON.parse(response.data);
          // Return both movies and TV shows
          res.json({
            movies: data.cast?.filter(item => item.media_type === 'movie') || [],
            tv: data.cast?.filter(item => item.media_type === 'tv') || []
          });
        })
        .catch(error => {
          console.error("❌ TMDB filmography fetch error:", error);
          res.status(500).json({ error: error.message });
        });
    });
  } catch (e) {
    console.error("❌ /api/filmography error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 🖼️ Get TMDB Images endpoint
// ===============================
app.get("/api/images", async (req, res) => {
  try {
    const { category, id } = req.query;
    if (!category || !id) {
      return res.status(400).send("Missing required parameters");
    }

    // Get API keys from settings
    db.all("SELECT * FROM settings WHERE id=1", (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};

      // Handle different image sources based on category
      if (category === 'tv' || category === 'movie') {
        // TMDB images
        const apiKey = settings.tmdbApiKey;
        if (!apiKey) {
          return res.status(400).json({ error: "TMDB API key not configured" });
        }

        const url = `https://api.themoviedb.org/3/${category}/${id}/images?api_key=${apiKey}`;

        makeRequest(url)
          .then(response => {
            if (response.statusCode !== 200) {
              throw new Error(`API returned status ${response.statusCode}: ${response.data}`);
            }

            const data = JSON.parse(response.data);
            res.json({
              posters: data.posters || [],
              backdrops: data.backdrops || []
            });
          })
          .catch(error => {
            console.error("❌ TMDB images fetch error:", error);
            res.status(500).json({ error: error.message });
          });
      } else if (category === 'person') {
        // TMDB person images
        const apiKey = settings.tmdbApiKey;
        if (!apiKey) {
          return res.status(400).json({ error: "TMDB API key not configured" });
        }

        const url = `https://api.themoviedb.org/3/person/${id}/images?api_key=${apiKey}`;

        makeRequest(url)
          .then(response => {
            if (response.statusCode !== 200) {
              throw new Error(`API returned status ${response.statusCode}: ${response.data}`);
            }

            const data = JSON.parse(response.data);
            // For people, profiles are posters, and posters are backdrops
            res.json({
              posters: data.profiles || [],
              backdrops: data.profiles || []
            });
          })
          .catch(error => {
            console.error("❌ TMDB person images fetch error:", error);
            res.status(500).json({ error: error.message });
          });
      } else {
        // For now, return empty for unsupported categories
        res.json({ posters: [], backdrops: [] });
      }
    });
  } catch (e) {
    console.error("❌ /api/images error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 🖼️ Proxy TMDB Images endpoint (for CORS)
// ===============================
app.get("/api/tmdb-image", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).send("Missing url parameter");
    }

    // Validate that it's a TMDB image URL
    if (!url.startsWith('https://image.tmdb.org/')) {
      return res.status(400).send("Invalid URL");
    }

    // Use a separate handler for binary image data
    const imageUrl = new URL(url);
    const protocol = imageUrl.protocol === "https:" ? https : http;

    const options = {
      hostname: imageUrl.hostname,
      path: imageUrl.pathname + imageUrl.search,
      method: "GET"
    };

    protocol.get(options, (imageRes) => {
      if (imageRes.statusCode !== 200) {
        res.status(500).send(`Failed to fetch image: ${imageRes.statusCode}`);
        return;
      }

      // Set proper headers for image
      res.set({
        'Content-Type': imageRes.headers['content-type'],
        'Cache-Control': 'public, max-age=31536000'
      });

      // Pipe the image data directly to response
      imageRes.pipe(res);

      imageRes.on('error', (error) => {
        console.error("❌ TMDB image proxy error:", error);
        res.status(500).send(error.message);
      });
    }).on('error', (error) => {
      console.error("❌ TMDB image proxy request error:", error);
      res.status(500).send(error.message);
    });
  } catch (e) {
    console.error("❌ /api/tmdb-image error:", e.message);
    res.status(500).send(e.message);
  }
});

// ===============================
// 🖼️ Proxy Steam Images endpoint (for CORS)
// ===============================
app.get("/api/steam-image", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).send("Missing url parameter");
    }

    // Validate that it's a Steam image URL
    if (!url.startsWith('https://cdn.akamai.steamstatic.com/') && !url.startsWith('http://media.steampowered.com/')) {
      return res.status(400).send("Invalid URL");
    }

    // Use a separate handler for binary image data
    const imageUrl = new URL(url);
    const protocol = imageUrl.protocol === "https:" ? https : http;

    const options = {
      hostname: imageUrl.hostname,
      path: imageUrl.pathname + imageUrl.search,
      method: "GET"
    };

    protocol.get(options, (imageRes) => {
      if (imageRes.statusCode !== 200) {
        res.status(500).send(`Failed to fetch image: ${imageRes.statusCode}`);
        return;
      }

      // Set proper headers for image
      res.set({
        'Content-Type': imageRes.headers['content-type'],
        'Cache-Control': 'public, max-age=31536000'
      });

      // Pipe the image data directly to response
      imageRes.pipe(res);

      imageRes.on('error', (error) => {
        console.error("❌ Steam image proxy error:", error);
        res.status(500).send(error.message);
      });
    }).on('error', (error) => {
      console.error("❌ Steam image proxy request error:", error);
      res.status(500).send(error.message);
    });
  } catch (e) {
    console.error("❌ /api/steam-image error:", e.message);
    res.status(500).send(e.message);
  }
});

// ===============================
// 🔍 Detailed metadata endpoint
// ===============================
app.get("/api/details", async (req, res) => {
  try {
    const { category, id } = req.query;
    if (!category || !id) {
      return res.status(400).send("Missing required parameters");
    }

    const settings = await getSettingsRow();
    const tmdbApiKey = settings.tmdbApiKey;
    const malApiKey = settings.malApiKey;
    const omdbApiKey = settings.omdbApiKey;

    if (category === "games") {
      try {
        const url = `https://store.steampowered.com/api/appdetails?appids=${id}&l=english`;
        const response = await makeRequest(url);

        if (response.statusCode !== 200) {
          throw new Error(`API returned status ${response.statusCode}: ${response.data}`);
        }

        const data = JSON.parse(response.data);
        const appData = data[id];

        if (!appData || !appData.success || !appData.data) {
          throw new Error("Game not found on Steam");
        }

        const gameData = appData.data;

        let timeToBeat = null;
        try {
          const steamSpyResponse = await makeRequest(`https://steamspy.com/api.php?request=appdetails&appid=${id}`);
          if (steamSpyResponse.statusCode === 200) {
            const steamSpyData = JSON.parse(steamSpyResponse.data);
            const averageMinutes = parseInt(steamSpyData.average_forever, 10);
            const medianMinutes = parseInt(steamSpyData.median_forever, 10);
            if (Number.isFinite(averageMinutes) || Number.isFinite(medianMinutes)) {
              timeToBeat = {
                average_minutes: Number.isFinite(averageMinutes) ? averageMinutes : null,
                average_hours: Number.isFinite(averageMinutes) ? parseFloat((averageMinutes / 60).toFixed(1)) : null,
                median_minutes: Number.isFinite(medianMinutes) ? medianMinutes : null,
                median_hours: Number.isFinite(medianMinutes) ? parseFloat((medianMinutes / 60).toFixed(1)) : null,
                source: "steamspy.com"
              };
            }
          }
        } catch (timeError) {
          console.warn("⚠️ Failed to fetch SteamSpy data for time to beat:", timeError.message);
        }

        const responseData = {
          id: gameData.steam_appid,
          name: gameData.name,
          developers: gameData.developers || [],
          publishers: gameData.publishers || [],
          release_date: gameData.release_date?.date || "",
          genres: gameData.genres || [],
          short_description: gameData.short_description || "",
          detailed_description: gameData.detailed_description || "",
          header_image: gameData.header_image || "",
          time_to_beat: timeToBeat
        };

        console.log("✅ Returning game details payload");
        return res.json(responseData);
      } catch (error) {
        console.error("❌ Steam details fetch error:", error);
        return res.status(500).json({ error: error.message });
      }
    }

    if (category === "movies") {
      if (!tmdbApiKey) {
        return res.status(400).json({ error: "TMDB API key not configured" });
      }
      const url = `https://api.themoviedb.org/3/movie/${id}?api_key=${tmdbApiKey}&append_to_response=external_ids`;
      const response = await makeRequest(url);

      if (response.statusCode !== 200) {
        throw new Error(`TMDB returned status ${response.statusCode}: ${response.data}`);
      }

      const movie = JSON.parse(response.data);
      const runtimeMinutes = Number.isFinite(movie.runtime) ? movie.runtime : null;

      return res.json({
        id: movie.id,
        title: movie.title || movie.name,
        runtime_minutes: runtimeMinutes,
        runtime_formatted: runtimeMinutes != null ? `${runtimeMinutes} min` : null,
        release_date: movie.release_date || null,
        overview: movie.overview || "",
        genres: movie.genres || [],
        status: movie.status || null,
        poster_path: movie.poster_path || null,
        backdrop_path: movie.backdrop_path || null,
        imdb_id: movie.imdb_id || null
      });
    }

    if (category === "tv") {
      if (!tmdbApiKey) {
        return res.status(400).json({ error: "TMDB API key not configured" });
      }
      const url = `https://api.themoviedb.org/3/tv/${id}?api_key=${tmdbApiKey}&append_to_response=external_ids`;
      const response = await makeRequest(url);

      if (response.statusCode !== 200) {
        throw new Error(`TMDB returned status ${response.statusCode}: ${response.data}`);
      }

      const series = JSON.parse(response.data);
      const episodeRunTimes = Array.isArray(series.episode_run_time) ? series.episode_run_time : [];
      let averageRuntime = episodeRunTimes.length
        ? Math.round(episodeRunTimes.reduce((acc, val) => acc + val, 0) / episodeRunTimes.length)
        : null;

      let omdbEpisodeRuntime = null;
      if (omdbApiKey && series.external_ids?.imdb_id) {
        try {
          const omdbUrl = `https://www.omdbapi.com/?i=${series.external_ids.imdb_id}&apikey=${omdbApiKey}&plot=short`;
          const omdbResponse = await makeRequest(omdbUrl);
          if (omdbResponse.statusCode === 200) {
            const omdbData = JSON.parse(omdbResponse.data);
            if (omdbData.Response === 'True' && omdbData.Runtime && omdbData.Runtime !== 'N/A') {
              const runtimeMatch = omdbData.Runtime.match(/(\d+)/);
              if (runtimeMatch) {
                omdbEpisodeRuntime = parseInt(runtimeMatch[1], 10);
                if (Number.isFinite(omdbEpisodeRuntime)) {
                  averageRuntime = averageRuntime || omdbEpisodeRuntime;
                }
              }
            }
          }
        } catch (omdbError) {
          console.warn("⚠️ OMDb runtime lookup failed:", omdbError.message);
        }
      }

      return res.json({
        id: series.id,
        name: series.name,
        episode_count: Number.isFinite(series.number_of_episodes) ? series.number_of_episodes : null,
        season_count: Number.isFinite(series.number_of_seasons) ? series.number_of_seasons : null,
        average_episode_runtime_minutes: averageRuntime,
        episode_runtime_minutes: episodeRunTimes,
        omdb_episode_runtime_minutes: omdbEpisodeRuntime,
        first_air_date: series.first_air_date || null,
        last_air_date: series.last_air_date || null,
        status: series.status || null,
        overview: series.overview || "",
        genres: series.genres || [],
        poster_path: series.poster_path || null,
        backdrop_path: series.backdrop_path || null,
        imdb_id: series.external_ids?.imdb_id || null
      });
    }

    if (category === "anime") {
      if (!malApiKey) {
        return res.status(400).json({ error: "MyAnimeList API key not configured" });
      }

      const url = `https://api.myanimelist.net/v2/anime/${id}?fields=id,title,num_episodes,average_episode_duration,start_date,end_date,status,synopsis,mean`;
      const headers = { "X-MAL-CLIENT-ID": malApiKey };
      const response = await makeRequest(url, { headers });

      if (response.statusCode !== 200) {
        throw new Error(`MyAnimeList returned status ${response.statusCode}: ${response.data}`);
      }

      const anime = JSON.parse(response.data);
      const averageEpisodeDurationSeconds = Number.isFinite(anime.average_episode_duration) ? anime.average_episode_duration : null;
      const averageEpisodeDurationMinutes = averageEpisodeDurationSeconds != null
        ? parseFloat((averageEpisodeDurationSeconds / 60).toFixed(1))
        : null;

      return res.json({
        id: anime.id,
        title: anime.title,
        num_episodes: Number.isFinite(anime.num_episodes) ? anime.num_episodes : null,
        average_episode_duration_seconds: averageEpisodeDurationSeconds,
        average_episode_duration_minutes: averageEpisodeDurationMinutes,
        status: anime.status || null,
        synopsis: anime.synopsis || "",
        mean_score: Number.isFinite(anime.mean) ? anime.mean : null,
        start_date: anime.start_date || null,
        end_date: anime.end_date || null
      });
    }

    return res.status(400).json({ error: "Unsupported category for /api/details" });
  } catch (e) {
    console.error("❌ /api/details error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 🎮 Get Steam Game Images endpoint
// ===============================
app.get("/api/steam-images", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).send("Missing id parameter");
    }

    // Fetch game details from Steam (always use English)
    const url = `https://store.steampowered.com/api/appdetails?appids=${id}&l=english`;

    makeRequest(url)
      .then(response => {
        if (response.statusCode !== 200) {
          throw new Error(`API returned status ${response.statusCode}: ${response.data}`);
        }

        const data = JSON.parse(response.data);
        const appData = data[id];

        if (!appData || !appData.success || !appData.data) {
          throw new Error("Game not found on Steam");
        }

        const gameData = appData.data;

        // Extract screenshots - Steam provides paths in path_thumbnail and path_full
        const screenshots = (gameData.screenshots || []).map(screenshot => ({
          path: screenshot.path_full || screenshot.path_thumbnail || ""
        }));

        res.json({
          screenshots: screenshots,
          backdrops: [] // Steam doesn't have separate banners
        });
      })
      .catch(error => {
        console.error("❌ Steam images fetch error:", error);
        res.status(500).json({ error: error.message });
      });
  } catch (e) {
    console.error("❌ /api/steam-images error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 🖼️ Proxy SteamGridDB Images endpoint (for CORS)
// ===============================
app.get("/api/steamgriddb-image", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).send("Missing url parameter");
    }

    // Validate that it's a SteamGridDB image URL
    if (!url.includes('steamgriddb.com')) {
      return res.status(400).send("Invalid URL");
    }

    // Use a separate handler for binary image data
    const imageUrl = new URL(url);
    const protocol = imageUrl.protocol === "https:" ? https : http;

    const options = {
      hostname: imageUrl.hostname,
      path: imageUrl.pathname + imageUrl.search,
      method: "GET"
    };

    protocol.get(options, (imageRes) => {
      if (imageRes.statusCode !== 200) {
        res.status(500).send(`Failed to fetch image: ${imageRes.statusCode}`);
        return;
      }

      // Set proper headers for image
      res.set({
        'Content-Type': imageRes.headers['content-type'],
        'Cache-Control': 'public, max-age=31536000'
      });

      // Pipe the image data directly to response
      imageRes.pipe(res);

      imageRes.on('error', (error) => {
        console.error("❌ SteamGridDB image proxy error:", error);
        res.status(500).send(error.message);
      });
    }).on('error', (error) => {
      console.error("❌ SteamGridDB image proxy request error:", error);
      res.status(500).send(error.message);
    });
  } catch (e) {
    console.error("❌ /api/steamgriddb-image error:", e.message);
    res.status(500).send(e.message);
  }
});

// 🖼️ Proxy Fanart.tv Images endpoint (for CORS)
// ===============================
app.get("/api/fanarttv-image", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).send("Missing url parameter");
    }

    // Validate that it's a fanart.tv image URL
    if (!url.includes('fanart.tv') && !url.includes('assets.fanart.tv')) {
      return res.status(400).send("Invalid URL");
    }

    // Use a separate handler for binary image data
    const imageUrl = new URL(url);
    const protocol = imageUrl.protocol === "https:" ? https : http;

    const options = {
      hostname: imageUrl.hostname,
      path: imageUrl.pathname + imageUrl.search,
      method: "GET"
    };

    protocol.get(options, (imageRes) => {
      if (imageRes.statusCode !== 200) {
        res.status(500).send(`Failed to fetch image: ${imageRes.statusCode}`);
        return;
      }

      // Set proper headers for image
      res.set({
        'Content-Type': imageRes.headers['content-type'],
        'Cache-Control': 'public, max-age=31536000'
      });

      // Pipe the image data directly to response
      imageRes.pipe(res);

      imageRes.on('error', (error) => {
        console.error("❌ Fanart.tv image proxy error:", error);
        res.status(500).send(error.message);
      });
    }).on('error', (error) => {
      console.error("❌ Fanart.tv image proxy request error:", error);
      res.status(500).send(error.message);
    });
  } catch (e) {
    console.error("❌ /api/fanarttv-image error:", e.message);
    res.status(500).send(e.message);
  }
});

// ===============================
// 🎮 Get SteamGridDB Game Images endpoint
// ===============================
app.get("/api/steamgriddb-images", async (req, res) => {
  try {
    const { appid } = req.query;
    if (!appid) {
      return res.status(400).send("Missing appid parameter");
    }

    // Get SteamGridDB API key from settings
    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) {
        console.error("❌ Error fetching settings:", err.message);
        return res.status(500).send(err.message);
      }

      const settings = rows?.[0] || {};
      const apiKey = settings.steamgriddbApiKey;

      if (!apiKey) {
        return res.status(400).json({ error: "SteamGridDB API key not configured" });
      }

      // Fetch game images from SteamGridDB API v2
      // Try to fetch grids (posters) and heroes (banners) separately
      const gridsUrl = `https://www.steamgriddb.com/api/v2/grids/steam/${appid}`;
      const heroesUrl = `https://www.steamgriddb.com/api/v2/heroes/steam/${appid}`;

      const headers = {
        'Authorization': `Bearer ${apiKey}`
      };

      const [gridsResponse, heroesResponse] = await Promise.all([
        makeRequest(gridsUrl, { headers }).catch(() => ({ statusCode: 500, data: '{"data":[]}' })),
        makeRequest(heroesUrl, { headers }).catch(() => ({ statusCode: 500, data: '{"data":[]}' }))
      ]);

      let grids = [];
      let heroes = [];

      if (gridsResponse.statusCode === 200) {
        try {
          const data = JSON.parse(gridsResponse.data);
          grids = (data.data || []).map(item => ({
            url: item.url || "",
            width: item.width || 0,
            height: item.height || 0
          }));
        } catch (e) {
          console.error("Error parsing grids:", e);
        }
      }

      if (heroesResponse.statusCode === 200) {
        try {
          const data = JSON.parse(heroesResponse.data);
          heroes = (data.data || []).map(item => ({
            url: item.url || "",
            width: item.width || 0,
            height: item.height || 0
          }));
        } catch (e) {
          console.error("Error parsing heroes:", e);
        }
      }

      res.json({
        grids: grids,
        heroes: heroes
      });
    });
  } catch (e) {
    console.error("❌ /api/steamgriddb-images error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// Proxy Steam API endpoints (for CORS)
// ===============================
app.get("/api/steam/applist", async (req, res) => {
  try {
    console.log("Steam applist proxy called");
    const url = 'https://api.steampowered.com/ISteamApps/GetAppList/v2/';
    https.get(url, (steamRes) => {
      // Check if response is successful
      if (steamRes.statusCode !== 200) {
        console.error(`Steam applist returned status ${steamRes.statusCode}`);
        return res.status(steamRes.statusCode).json({ error: `Steam API returned status ${steamRes.statusCode}` });
      }

      let data = '';
      steamRes.on('data', (chunk) => {
        data += chunk;
      });
      steamRes.on('end', () => {
        try {
          // Verify it's valid JSON before sending
          JSON.parse(data);
          res.setHeader('Content-Type', 'application/json');
          res.send(data);
        } catch (parseError) {
          console.error("Steam applist response is not valid JSON:", parseError);
          console.error("Response preview:", data.substring(0, 200));
          res.status(500).json({ error: "Invalid JSON response from Steam API", details: data.substring(0, 200) });
        }
      });
      steamRes.on('error', (error) => {
        console.error("Steam applist proxy error:", error);
        res.status(500).json({ error: error.message });
      });
    }).on('error', (error) => {
      console.error("Steam applist request error:", error);
      res.status(500).json({ error: error.message });
    });
  } catch (e) {
    console.error("/api/steam/applist error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/steam/appdetails", async (req, res) => {
  try {
    console.log("Steam appdetails proxy called with appids:", req.query.appids);
    const { appids } = req.query;
    if (!appids) {
      return res.status(400).json({ error: "Missing appids parameter" });
    }

    const url = `https://store.steampowered.com/api/appdetails?appids=${appids}&l=en`;
    https.get(url, (steamRes) => {
      // Check if response is successful
      if (steamRes.statusCode !== 200) {
        console.error(`Steam appdetails returned status ${steamRes.statusCode}`);
        return res.status(steamRes.statusCode).json({ error: `Steam API returned status ${steamRes.statusCode}` });
      }

      let data = '';
      steamRes.on('data', (chunk) => {
        data += chunk;
      });
      steamRes.on('end', () => {
        try {
          // Verify it's valid JSON before sending
          JSON.parse(data);
          res.setHeader('Content-Type', 'application/json');
          res.send(data);
        } catch (parseError) {
          console.error("Steam appdetails response is not valid JSON:", parseError);
          console.error("Response preview:", data.substring(0, 200));
          res.status(500).json({ error: "Invalid JSON response from Steam API", details: data.substring(0, 200) });
        }
      });
      steamRes.on('error', (error) => {
        console.error("Steam appdetails proxy error:", error);
        res.status(500).json({ error: error.message });
      });
    }).on('error', (error) => {
      console.error("Steam appdetails request error:", error);
      res.status(500).json({ error: error.message });
    });
  } catch (e) {
    console.error("/api/steam/appdetails error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 🎬 Fanart.tv API endpoint for movies/TV banners
// ===============================
app.get("/api/fanarttv", async (req, res) => {
  try {
    const { type, id } = req.query; // type: 'movie' or 'tv', id: TMDB ID
    if (!type || !id) {
      return res.status(400).send("Missing required parameters: type and id");
    }

    // Get API key from settings
    db.all("SELECT * FROM settings WHERE id=1", (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};

      const apiKey = settings.fanarttvApiKey;
      if (!apiKey) {
        return res.status(400).json({ error: "Fanart.tv API key not configured" });
      }

      // Fanart.tv API endpoint
      const endpoint = type === 'movie' ? 'movies' : 'tv';
      const url = `https://webservice.fanart.tv/v3/${endpoint}/${id}?api_key=${apiKey}`;

      makeRequest(url)
        .then(response => {
          if (response.statusCode !== 200) {
            throw new Error(`API returned status ${response.statusCode}: ${response.data}`);
          }

          const data = JSON.parse(response.data);
          // Return moviebanner for movies, showbackground for TV
          const banners = type === 'movie'
            ? (data.moviebanner || []).map(b => ({ url: b.url, lang: b.lang || 'en' }))
            : (data.showbackground || []).map(b => ({ url: b.url, lang: b.lang || 'en' }));

          res.json({ banners: banners });
        })
        .catch(error => {
          console.error("❌ Fanart.tv fetch error:", error);
          res.status(500).json({ error: error.message });
        });
    });
  } catch (e) {
    console.error("❌ /api/fanarttv error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 🏠 Home Page API endpoints
// ===============================

// TMDB Trending
app.get("/api/home/trending", async (req, res) => {
  try {
    const { timeWindow } = req.query;
    if (!timeWindow || !['day', 'week'].includes(timeWindow)) {
      return res.status(400).json({ error: "Invalid timeWindow. Use 'day' or 'week'" });
    }

    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};

      const apiKey = settings.tmdbApiKey;
      if (!apiKey) {
        return res.status(400).json({ error: "TMDB API key not configured" });
      }

      const url = `https://api.themoviedb.org/3/trending/all/${timeWindow}?api_key=${apiKey}`;

      makeRequest(url)
        .then(response => {
          if (response.statusCode !== 200) {
            throw new Error(`API returned status ${response.statusCode}: ${response.data}`);
          }

          const data = JSON.parse(response.data);
          // Convert TMDB scores from 0-10 scale to 0-100 scale
          if (data.results) {
            data.results = data.results.map(item => ({
              ...item,
              vote_average: item.vote_average ? Math.round(item.vote_average * 10) : 0
            }));
          }
          res.json(data);
        })
        .catch(error => {
          console.error("❌ TMDB trending fetch error:", error);
          res.status(500).json({ error: error.message });
        });
    });
  } catch (e) {
    console.error("❌ /api/home/trending error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Helper function to make HTTP request with redirect following
function makeRequestWithRedirects(urlString, maxRedirects = 5, redirectCount = 0) {
  if (redirectCount > maxRedirects) {
    return Promise.reject(new Error(`Too many redirects (${maxRedirects})`));
  }

  const url = new URL(urlString);
  const protocol = url.protocol === "https:" ? https : http;

  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: "GET",
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity', // Don't request compression - Node doesn't auto-decompress
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Referer': 'https://www.imdb.com/',
      'Cache-Control': 'no-cache'
    }
  };

  return new Promise((resolve, reject) => {
    const req = protocol.request(options, (res) => {
      // Handle redirects BEFORE reading any data
      if (res.statusCode >= 300 && res.statusCode < 400) {
        const location = res.headers.location;
        console.log(`🔄 Redirect ${res.statusCode} detected, Location: ${location}`);

        // Drain the response and close
        res.resume();
        req.destroy();

        if (location) {
          // Calculate new URL
          let newUrl;
          if (location.startsWith('http://') || location.startsWith('https://')) {
            newUrl = location;
          } else if (location.startsWith('//')) {
            newUrl = `${url.protocol}${location}`;
          } else if (location.startsWith('/')) {
            newUrl = `${url.protocol}//${url.hostname}${location}`;
          } else {
            newUrl = `${url.protocol}//${url.hostname}/${location}`;
          }

          console.log(`🔄 Following redirect (${redirectCount + 1}/${maxRedirects}) to: ${newUrl}`);
          // Recursively follow redirect
          makeRequestWithRedirects(newUrl, maxRedirects, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        } else {
          console.warn(`⚠️ Redirect ${res.statusCode} but no Location header found`);
          return reject(new Error(`Redirect ${res.statusCode} without Location header`));
        }
      }

      // Not a redirect, read the data
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          data: data,
          headers: res.headers
        });
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.end();
  });
}

// Helper function to get IMDb IDs from IMDb chart page (moviemeter/tvmeter)
async function getIMDbChartIDs(chartType) {
  try {
    // Check cache first (cache for 1 hour to avoid repeated scraping)
    const cache = imdbChartCache[chartType];
    const now = Date.now();
    if (cache.ids && cache.timestamp && (now - cache.timestamp) < CACHE_DURATION) {
      console.log(`✅ Using cached IMDb ${chartType} chart IDs (${cache.ids.length} items)`);
      return cache.ids;
    }

    // IMDb chart URLs - using the exact URLs from the search results
    const chartUrl = chartType === 'movies'
      ? 'https://www.imdb.com/chart/moviemeter/?ref_=hm_nv_menu'
      : 'https://www.imdb.com/chart/tvmeter/?ref_=hm_nv_menu';

    console.log(`🔗 Fetching IMDb chart: ${chartUrl}`);

    // Make request with redirect following
    let response;
    try {
      response = await makeRequestWithRedirects(chartUrl);
    } catch (error) {
      // If redirect handling failed, try using cached data if available
      if (cache.ids) {
        console.log(`⚠️ Failed to fetch IMDb chart, using stale cache`);
        return cache.ids;
      }
      throw error;
    }

    if (!response || response.statusCode !== 200) {
      // Try using cached data if available
      if (cache.ids) {
        console.log(`⚠️ Failed to fetch IMDb chart (${response?.statusCode}), using stale cache`);
        return cache.ids;
      }
      throw new Error(`Failed to fetch IMDb chart: ${response?.statusCode || 'unknown'}`);
    }

    // Parse HTML to extract IMDb IDs from the chart
    const html = response.data;
    const ids = [];

    // Pattern 1: Look for title links in the chart (most common)
    // Format: <a href="/title/tt1234567/"> or data-testid="title-link" href="/title/tt1234567/"
    const titleLinkRegex = /href=["']\/title\/(tt\d+)\/[^"']*["']/gi;
    let match;

    while ((match = titleLinkRegex.exec(html)) !== null && ids.length < 100) {
      const imdbId = match[1];
      if (!ids.includes(imdbId)) {
        ids.push(imdbId);
      }
    }

    // Pattern 2: Look for data-testid="title-link" pattern (newer IMDb pages)
    if (ids.length < 20) {
      const dataTestIdRegex = /data-testid=["']title-link["'][^>]*href=["']\/title\/(tt\d+)\//gi;
      while ((match = dataTestIdRegex.exec(html)) !== null && ids.length < 100) {
        const imdbId = match[1];
        if (!ids.includes(imdbId)) {
          ids.push(imdbId);
        }
      }
    }

    // Pattern 3: Look for IPrimary class (chart items)
    if (ids.length < 20) {
      const iprimaryRegex = /class="[^"]*iprimary[^"]*"[^>]*href=["']\/title\/(tt\d+)\//gi;
      while ((match = iprimaryRegex.exec(html)) !== null && ids.length < 100) {
        const imdbId = match[1];
        if (!ids.includes(imdbId)) {
          ids.push(imdbId);
        }
      }
    }

    // Pattern 4: Simple /title/tt pattern anywhere (last resort)
    if (ids.length < 20) {
      const simpleRegex = /\/title\/(tt\d{7,})\//g;
      while ((match = simpleRegex.exec(html)) !== null && ids.length < 100) {
        const imdbId = match[1];
        if (!ids.includes(imdbId)) {
          ids.push(imdbId);
        }
      }
    }

    // Filter to only keep IDs that appear in chart context (not in sidebar/footer)
    // Take first 50 unique IDs found in order (they should be ranked)
    const chartIds = ids.slice(0, 50);

    if (chartIds.length === 0) {
      // Try using cached data if available
      if (cache.ids) {
        console.log(`⚠️ No IMDb IDs found, using stale cache`);
        return cache.ids;
      }
      throw new Error("No IMDb IDs found in chart page");
    }

    // Update cache
    imdbChartCache[chartType] = {
      ids: chartIds,
      timestamp: now
    };

    console.log(`✅ Found ${chartIds.length} IMDb IDs from ${chartType} chart (cached)`);
    return chartIds;
  } catch (error) {
    console.error("❌ Error fetching IMDb chart:", error);
    // Try using cached data if available
    const cache = imdbChartCache[chartType];
    if (cache.ids) {
      console.log(`🔄 Using stale cached IMDb IDs`);
      return cache.ids;
    }
    console.log("🔄 Using fallback IMDb IDs list");
    // Fallback to a curated list of popular IMDb IDs if scraping fails
    return getFallbackIMDbIDs(chartType);
  }
}

// Fallback list of popular IMDb IDs if scraping fails
function getFallbackIMDbIDs(chartType) {
  if (chartType === 'movies') {
    return [
      'tt1375666', 'tt0816692', 'tt0468569', 'tt0111161', 'tt0068646',
      'tt0071562', 'tt0167260', 'tt0050083', 'tt0108052', 'tt0120737',
      'tt0060196', 'tt0109830', 'tt0133093', 'tt0167261', 'tt0080684',
      'tt1375666', 'tt0816692', 'tt0468569', 'tt0111161', 'tt0068646'
    ];
  } else {
    return [
      'tt0944947', 'tt0903747', 'tt0795176', 'tt0141842', 'tt1475582',
      'tt0306414', 'tt0386676', 'tt0455275', 'tt0944947', 'tt0903747',
      'tt0795176', 'tt0141842', 'tt1475582', 'tt0306414', 'tt0386676'
    ];
  }
}

// OMDb Popular Movies (using IMDb moviemeter chart)
app.get("/api/home/movies/popular", async (req, res) => {
  console.log("📥 GET /api/home/movies/popular - Request received");
  try {
    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) {
        console.error("❌ Database error in /api/home/movies/popular:", err);
        return res.status(500).send(err.message);
      }
      const settings = rows?.[0] || {};

      const apiKey = settings.omdbApiKey;
      if (!apiKey) {
        console.warn("⚠️ OMDb API key not configured");
        return res.status(400).json({ error: "OMDb API key not configured" });
      }

      try {
        // Get IMDb IDs from chart
        console.log("🔗 Fetching IMDb moviemeter chart...");
        const imdbIds = await getIMDbChartIDs('movies');

        // Fetch details from OMDb for each ID (limit to 10 for faster loading)
        const movies = [];
        const idsToFetch = imdbIds.slice(0, 10);

        console.log(`🔗 Fetching details from OMDb for ${idsToFetch.length} movies in parallel...`);

        // Fetch ALL in parallel for maximum speed (no batching delays)
        const moviePromises = idsToFetch.map(async (imdbId) => {
          try {
            const omdbUrl = `https://www.omdbapi.com/?i=${imdbId}&apikey=${apiKey}&plot=short`;
            const omdbResponse = await makeRequest(omdbUrl);

            if (omdbResponse.statusCode === 200) {
              const movieData = JSON.parse(omdbResponse.data);
              if (movieData.Response === 'True' && !movieData.Error) {
                // Format data to match expected structure
                return {
                  imdbID: movieData.imdbID,
                  title: movieData.Title,
                  year: movieData.Year,
                  poster_path: movieData.Poster !== 'N/A' ? movieData.Poster : '',
                  vote_average: movieData.imdbRating !== 'N/A' ? Math.round(parseFloat(movieData.imdbRating) * 10) : 0,
                  overview: movieData.Plot !== 'N/A' ? movieData.Plot : '',
                  release_date: movieData.Released !== 'N/A' ? movieData.Released : movieData.Year,
                  genre: movieData.Genre !== 'N/A' ? movieData.Genre : '',
                  director: movieData.Director !== 'N/A' ? movieData.Director : '',
                  imdbRating: movieData.imdbRating !== 'N/A' ? movieData.imdbRating : 'N/A',
                  imdbVotes: movieData.imdbVotes !== 'N/A' ? movieData.imdbVotes : 'N/A'
                };
              }
            }
            return null;
          } catch (err) {
            console.warn(`Failed to fetch OMDb data for ${imdbId}:`, err.message);
            return null;
          }
        });

        const results = await Promise.all(moviePromises);
        movies.push(...results.filter(m => m !== null));

        console.log(`✅ Popular movies fetched successfully, count: ${movies.length}`);
        res.json({ results: movies });
      } catch (error) {
        console.error("❌ OMDb popular movies fetch error:", error);
        res.status(500).json({ error: error.message });
      }
    });
  } catch (e) {
    console.error("❌ /api/home/movies/popular error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Poster proxy endpoint to fix CORS issues
app.get("/api/poster", async (req, res) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl) {
      return res.status(400).send('Missing url parameter');
    }

    const parsedUrl = new URL(imageUrl);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': parsedUrl.origin
      }
    };

    protocol.get(options, (imageRes) => {
      if (imageRes.statusCode === 200) {
        res.setHeader('Content-Type', imageRes.headers['content-type'] || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.setHeader('Access-Control-Allow-Origin', '*');
        imageRes.pipe(res);
      } else if (imageRes.statusCode >= 300 && imageRes.statusCode < 400 && imageRes.headers.location) {
        // Handle redirects
        res.redirect(imageRes.headers.location);
      } else {
        console.warn(`Poster proxy: Remote returned ${imageRes.statusCode} for ${imageUrl}`);
        res.status(404).send('Image not found');
      }
    }).on('error', (err) => {
      console.error('Error proxying poster:', err.message);
      res.status(500).send('Error loading image');
    });
  } catch (error) {
    console.error('Poster proxy error:', error.message);
    res.status(500).send('Invalid image URL');
  }
});

// Combined Movies endpoint (Popular + Trailers)
app.get("/api/home/movies/combined", async (req, res) => {
  console.log("📥 GET /api/home/movies/combined - Request received");
  try {
    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) {
        console.error("❌ Database error in /api/home/movies/combined:", err);
        return res.status(500).send(err.message);
      }
      const settings = rows?.[0] || {};

      const omdbApiKey = settings.omdbApiKey;
      if (!omdbApiKey) {
        console.warn("⚠️ OMDb API key not configured");
        return res.status(400).json({ error: "OMDb API key not configured" });
      }

      try {
        // Get IMDb IDs from chart (fetch once, use for both)
        console.log("🔗 Fetching IMDb moviemeter chart...");
        const imdbIds = await getIMDbChartIDs('movies');

        // Fetch details from OMDb for each ID (limit to 10 for faster loading)
        const movies = [];
        const idsToFetch = imdbIds.slice(0, 10);

        console.log(`🔗 Fetching details from OMDb for ${idsToFetch.length} movies in parallel...`);

        // Get TMDB key for poster fallback
        const tmdbApiKey = settings.tmdbApiKey;

        // Fetch ALL in parallel for maximum speed (no batching delays)
        const moviePromises = idsToFetch.map(async (imdbId) => {
          try {
            const omdbUrl = `https://www.omdbapi.com/?i=${imdbId}&apikey=${omdbApiKey}&plot=short`;
            const omdbResponse = await makeRequest(omdbUrl);

            if (omdbResponse.statusCode === 200) {
              const movieData = JSON.parse(omdbResponse.data);
              if (movieData.Response === 'True' && !movieData.Error) {
                // Format data immediately (don't wait for YouTube search - it's too slow)
                let posterPath = movieData.Poster !== 'N/A' ? movieData.Poster : '';

                // If OMDb doesn't have a poster, try to get it from TMDB via IMDb ID
                if (!posterPath && tmdbApiKey && movieData.imdbID) {
                  try {
                    const tmdbFindUrl = `https://api.themoviedb.org/3/find/${movieData.imdbID}?api_key=${tmdbApiKey}&external_source=imdb_id`;
                    const tmdbFindResp = await makeRequest(tmdbFindUrl);
                    if (tmdbFindResp && tmdbFindResp.statusCode === 200) {
                      const tmdbFindData = JSON.parse(tmdbFindResp.data);
                      // Check movie_results first, then tv_results
                      const tmdbMatch = (tmdbFindData.movie_results && tmdbFindData.movie_results[0]) ||
                        (tmdbFindData.tv_results && tmdbFindData.tv_results[0]);
                      if (tmdbMatch && tmdbMatch.poster_path) {
                        posterPath = `https://image.tmdb.org/t/p/w300${tmdbMatch.poster_path}`;
                        console.log(`✅ Got TMDB poster fallback for ${movieData.Title}`);
                      }
                    }
                  } catch (e) {
                    // Ignore TMDB fallback errors - just use no poster
                  }
                }

                const movie = {
                  imdbID: movieData.imdbID,
                  title: movieData.Title,
                  year: movieData.Year,
                  poster_path: posterPath,
                  vote_average: movieData.imdbRating !== 'N/A' ? Math.round(parseFloat(movieData.imdbRating) * 10) : 0,
                  overview: movieData.Plot !== 'N/A' ? movieData.Plot : '',
                  release_date: movieData.Released !== 'N/A' ? movieData.Released : movieData.Year,
                  genre: movieData.Genre !== 'N/A' ? movieData.Genre : '',
                  director: movieData.Director !== 'N/A' ? movieData.Director : '',
                  imdbRating: movieData.imdbRating !== 'N/A' ? movieData.imdbRating : 'N/A',
                  imdbVotes: movieData.imdbVotes !== 'N/A' ? movieData.imdbVotes : 'N/A'
                };

                // Create YouTube search URL immediately (don't wait for slow API call)
                const searchQuery = encodeURIComponent(`${movieData.Title} ${movieData.Year} official trailer`);
                movie.trailer_search_url = `https://www.youtube.com/results?search_query=${searchQuery}`;

                return movie;
              }
            }
            return null;
          } catch (err) {
            console.warn(`Failed to fetch OMDb data for ${imdbId}:`, err.message);
            return null;
          }
        });

        const results = await Promise.all(moviePromises);
        movies.push(...results.filter(m => m !== null));

        // If OMDb returned no valid movies (possible API/key/rate-limit issues),
        // fall back to TMDB trending if a TMDB API key is configured.
        if (movies.length === 0) {
          const tmdbKey = settings.tmdbApiKey;
          if (tmdbKey) {
            try {
              console.log('⚠️ No combined movies from OMDb, falling back to TMDB trending');
              const tmdbUrl = `https://api.themoviedb.org/3/trending/all/week?api_key=${tmdbKey}`;
              const tmdbResp = await makeRequest(tmdbUrl);
              if (tmdbResp && tmdbResp.statusCode === 200) {
                const tmdbData = JSON.parse(tmdbResp.data);
                const tmdbResults = (tmdbData.results || []).map(item => ({
                  id: item.id,
                  title: item.title || item.name || '',
                  poster_path: item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : '',
                  vote_average: item.vote_average ? Math.round(item.vote_average * 10) : 0,
                  overview: item.overview || '',
                  release_date: item.release_date || item.first_air_date || ''
                }));
                console.log(`✅ TMDB fallback returned ${tmdbResults.length} items`);
                return res.json({ results: tmdbResults });
              }
            } catch (e) {
              console.error('❌ TMDB fallback for combined movies failed:', e.message || e);
            }
          }
        }

        console.log(`✅ Combined movies fetched successfully, count: ${movies.length}`);
        res.json({ results: movies });
      } catch (error) {
        console.error("❌ OMDb combined movies fetch error:", error);
        res.status(500).json({ error: error.message });
      }
    });
  } catch (e) {
    console.error("❌ /api/home/movies/combined error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Latest Trailers endpoint (Popular movies with trailers from TMDB)
app.get("/api/home/movies/latest-trailers", async (req, res) => {
  console.log("📥 GET /api/home/movies/latest-trailers - Request received");
  try {
    db.all("SELECT * FROM settings WHERE id=1", (err, rows) => {
      if (err) {
        console.error("❌ Database error in /api/home/movies/latest-trailers:", err);
        return res.status(500).json({ error: err.message });
      }
      const settings = rows?.[0] || {};

      const tmdbApiKey = settings.tmdbApiKey;
      if (!tmdbApiKey) {
        console.warn("⚠️ TMDB API key not configured");
        return res.status(400).json({ error: "TMDB API key not configured" });
      }

      // Fetch popular movies from TMDB
      console.log("🔗 Fetching popular movies from TMDB...");
      const popularUrl = `https://api.themoviedb.org/3/movie/popular?api_key=${tmdbApiKey}&page=1`;

      makeRequest(popularUrl)
        .then(popularResponse => {
          if (popularResponse.statusCode !== 200) {
            throw new Error(`TMDB API returned status ${popularResponse.statusCode}`);
          }

          const popularData = JSON.parse(popularResponse.data);
          const movies = popularData.results || [];

          console.log(`🔗 Found ${movies.length} popular movies, checking for trailers...`);

          // Fetch videos for each movie and filter for ones with trailers
          // Limit to first 15 movies to balance speed and results
          const moviePromises = movies.slice(0, 15).map(movie => {
            // Fetch videos for this movie
            const videosUrl = `https://api.themoviedb.org/3/movie/${movie.id}/videos?api_key=${tmdbApiKey}`;

            return makeRequest(videosUrl)
              .then(videosResponse => {
                if (videosResponse.statusCode !== 200) {
                  return null;
                }

                const videosData = JSON.parse(videosResponse.data);
                const videos = videosData.results || [];

                // Find official trailer (prefer official, then any trailer)
                const trailer = videos.find(v =>
                  v.type === 'Trailer' &&
                  v.official === true
                ) || videos.find(v =>
                  v.type === 'Trailer' &&
                  v.name.toLowerCase().includes('trailer')
                ) || videos.find(v => v.type === 'Trailer');

                if (trailer) {
                  // Format movie data with trailer info
                  // Include full TMDB URLs for images as fallback for YouTube thumbnails
                  return {
                    id: movie.id,
                    title: movie.title,
                    name: movie.title,
                    overview: movie.overview || '',
                    poster_path: movie.poster_path ? `https://image.tmdb.org/t/p/w780${movie.poster_path}` : '',
                    backdrop_path: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : '',
                    release_date: movie.release_date || '',
                    vote_average: movie.vote_average ? Math.round(movie.vote_average * 10) : 0,
                    genre_ids: movie.genre_ids || [],
                    // Trailer info
                    trailer_key: trailer.key,
                    trailer_name: trailer.name,
                    trailer_site: trailer.site,
                    trailer_type: trailer.type,
                    trailer_url: trailer.site === 'YouTube'
                      ? `https://www.youtube.com/watch?v=${trailer.key}`
                      : null
                  };
                }
                return null;
              })
              .catch(err => {
                console.warn(`Failed to fetch videos for movie ${movie.id}:`, err.message);
                return null;
              });
          });

          return Promise.all(moviePromises);
        })
        .then(results => {
          const moviesWithTrailers = results.filter(m => m !== null);

          // Limit to first 10 for performance
          const limitedResults = moviesWithTrailers.slice(0, 10);

          console.log(`✅ Latest trailers fetched successfully, count: ${limitedResults.length}`);
          res.json({ results: limitedResults });
        })
        .catch(error => {
          console.error("❌ TMDB latest trailers fetch error:", error);
          res.status(500).json({ error: error.message });
        });
    });
  } catch (e) {
    console.error("❌ /api/home/movies/latest-trailers error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Combined TV Series endpoint (Popular + Trailers)
app.get("/api/home/tv/combined", async (req, res) => {
  console.log("📥 GET /api/home/tv/combined - Request received");
  try {
    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) {
        console.error("❌ Database error in /api/home/tv/combined:", err);
        return res.status(500).send(err.message);
      }
      const settings = rows?.[0] || {};

      const omdbApiKey = settings.omdbApiKey;
      if (!omdbApiKey) {
        console.warn("⚠️ OMDb API key not configured");
        return res.status(400).json({ error: "OMDb API key not configured" });
      }

      try {
        // Get IMDb IDs from chart
        console.log("🔗 Fetching IMDb tvmeter chart...");
        const imdbIds = await getIMDbChartIDs('tv');

        // Fetch details from OMDb for each ID (limit to 10 for faster loading)
        const tvShows = [];
        const idsToFetch = imdbIds.slice(0, 10);

        console.log(`🔗 Fetching details from OMDb for ${idsToFetch.length} TV shows in parallel...`);

        // Get TMDB key for poster fallback
        const tmdbApiKey = settings.tmdbApiKey;

        // Fetch ALL in parallel for maximum speed (no batching delays)
        const tvPromises = idsToFetch.map(async (imdbId) => {
          try {
            const omdbUrl = `https://www.omdbapi.com/?i=${imdbId}&apikey=${omdbApiKey}&plot=short`;
            const omdbResponse = await makeRequest(omdbUrl);

            if (omdbResponse.statusCode === 200) {
              const tvData = JSON.parse(omdbResponse.data);
              if (tvData.Response === 'True' && !tvData.Error) {
                // Format data immediately (don't wait for YouTube search - it's too slow)
                let posterPath = tvData.Poster !== 'N/A' ? tvData.Poster : '';

                // If OMDb doesn't have a poster, try to get it from TMDB via IMDb ID
                if (!posterPath && tmdbApiKey && tvData.imdbID) {
                  try {
                    const tmdbFindUrl = `https://api.themoviedb.org/3/find/${tvData.imdbID}?api_key=${tmdbApiKey}&external_source=imdb_id`;
                    const tmdbFindResp = await makeRequest(tmdbFindUrl);
                    if (tmdbFindResp && tmdbFindResp.statusCode === 200) {
                      const tmdbFindData = JSON.parse(tmdbFindResp.data);
                      // Check tv_results first for TV shows, then movie_results
                      const tmdbMatch = (tmdbFindData.tv_results && tmdbFindData.tv_results[0]) ||
                        (tmdbFindData.movie_results && tmdbFindData.movie_results[0]);
                      if (tmdbMatch && tmdbMatch.poster_path) {
                        posterPath = `https://image.tmdb.org/t/p/w300${tmdbMatch.poster_path}`;
                        console.log(`✅ Got TMDB poster fallback for ${tvData.Title}`);
                      }
                    }
                  } catch (e) {
                    // Ignore TMDB fallback errors - just use no poster
                  }
                }

                const tvShow = {
                  imdbID: tvData.imdbID,
                  name: tvData.Title,
                  title: tvData.Title,
                  year: tvData.Year,
                  poster_path: posterPath,
                  vote_average: tvData.imdbRating !== 'N/A' ? Math.round(parseFloat(tvData.imdbRating) * 10) : 0,
                  overview: tvData.Plot !== 'N/A' ? tvData.Plot : '',
                  first_air_date: tvData.Released !== 'N/A' ? tvData.Released : tvData.Year,
                  release_date: tvData.Released !== 'N/A' ? tvData.Released : tvData.Year,
                  genre: tvData.Genre !== 'N/A' ? tvData.Genre : '',
                  director: tvData.Director !== 'N/A' ? tvData.Director : '',
                  imdbRating: tvData.imdbRating !== 'N/A' ? tvData.imdbRating : 'N/A',
                  imdbVotes: tvData.imdbVotes !== 'N/A' ? tvData.imdbVotes : 'N/A'
                };

                // Create YouTube search URL immediately (don't wait for slow API call)
                const searchQuery = encodeURIComponent(`${tvData.Title} ${tvData.Year} official trailer`);
                tvShow.trailer_search_url = `https://www.youtube.com/results?search_query=${searchQuery}`;

                return tvShow;
              }
            }
            return null;
          } catch (err) {
            console.warn(`Failed to fetch OMDb data for ${imdbId}:`, err.message);
            return null;
          }
        });

        const results = await Promise.all(tvPromises);
        tvShows.push(...results.filter(tv => tv !== null));

        // If OMDb returned no valid TV shows, fall back to TMDB trending if available
        if (tvShows.length === 0) {
          const tmdbKey = settings.tmdbApiKey;
          if (tmdbKey) {
            try {
              console.log('⚠️ No combined TV shows from OMDb, falling back to TMDB trending');
              const tmdbUrl = `https://api.themoviedb.org/3/trending/tv/week?api_key=${tmdbKey}`;
              const tmdbResp = await makeRequest(tmdbUrl);
              if (tmdbResp && tmdbResp.statusCode === 200) {
                const tmdbData = JSON.parse(tmdbResp.data);
                const tmdbResults = (tmdbData.results || []).map(item => ({
                  id: item.id,
                  title: item.title || item.name || '',
                  poster_path: item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : '',
                  vote_average: item.vote_average ? Math.round(item.vote_average * 10) : 0,
                  overview: item.overview || '',
                  first_air_date: item.first_air_date || item.release_date || ''
                }));
                console.log(`✅ TMDB fallback returned ${tmdbResults.length} items for TV`);
                return res.json({ results: tmdbResults });
              }
            } catch (e) {
              console.error('❌ TMDB fallback for combined TV failed:', e.message || e);
            }
          }
        }

        console.log(`✅ Combined TV series fetched successfully, count: ${tvShows.length}`);
        res.json({ results: tvShows });
      } catch (error) {
        console.error("❌ OMDb combined TV fetch error:", error);
        res.status(500).json({ error: error.message });
      }
    });
  } catch (e) {
    console.error("❌ /api/home/tv/combined error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// OMDb Popular TV Series (using IMDb tvmeter chart)
app.get("/api/home/tv/popular", async (req, res) => {
  console.log("📥 GET /api/home/tv/popular - Request received");
  try {
    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) {
        console.error("❌ Database error in /api/home/tv/popular:", err);
        return res.status(500).send(err.message);
      }
      const settings = rows?.[0] || {};

      const apiKey = settings.omdbApiKey;
      if (!apiKey) {
        console.warn("⚠️ OMDb API key not configured");
        return res.status(400).json({ error: "OMDb API key not configured" });
      }

      try {
        // Get IMDb IDs from chart
        console.log("🔗 Fetching IMDb tvmeter chart...");
        const imdbIds = await getIMDbChartIDs('tv');

        // Fetch details from OMDb for each ID (limit to 10 for faster loading)
        const tvShows = [];
        const idsToFetch = imdbIds.slice(0, 10);

        console.log(`🔗 Fetching details from OMDb for ${idsToFetch.length} TV shows in parallel...`);

        // Fetch ALL in parallel for maximum speed (no batching delays)
        const tvPromises = idsToFetch.map(async (imdbId) => {
          try {
            const omdbUrl = `https://www.omdbapi.com/?i=${imdbId}&apikey=${apiKey}&plot=short`;
            const omdbResponse = await makeRequest(omdbUrl);

            if (omdbResponse.statusCode === 200) {
              const tvData = JSON.parse(omdbResponse.data);
              if (tvData.Response === 'True' && !tvData.Error) {
                // Format data to match expected structure
                return {
                  imdbID: tvData.imdbID,
                  name: tvData.Title, // TV shows use 'name' in frontend
                  title: tvData.Title,
                  year: tvData.Year,
                  poster_path: tvData.Poster !== 'N/A' ? tvData.Poster : '',
                  vote_average: tvData.imdbRating !== 'N/A' ? Math.round(parseFloat(tvData.imdbRating) * 10) : 0,
                  overview: tvData.Plot !== 'N/A' ? tvData.Plot : '',
                  first_air_date: tvData.Released !== 'N/A' ? tvData.Released : tvData.Year,
                  release_date: tvData.Released !== 'N/A' ? tvData.Released : tvData.Year,
                  genre: tvData.Genre !== 'N/A' ? tvData.Genre : '',
                  director: tvData.Director !== 'N/A' ? tvData.Director : '',
                  imdbRating: tvData.imdbRating !== 'N/A' ? tvData.imdbRating : 'N/A',
                  imdbVotes: tvData.imdbVotes !== 'N/A' ? tvData.imdbVotes : 'N/A'
                };
              }
            }
            return null;
          } catch (err) {
            console.warn(`Failed to fetch OMDb data for ${imdbId}:`, err.message);
            return null;
          }
        });

        const results = await Promise.all(tvPromises);
        tvShows.push(...results.filter(tv => tv !== null));

        console.log(`✅ Popular TV series fetched successfully, count: ${tvShows.length}`);
        res.json({ results: tvShows });
      } catch (error) {
        console.error("❌ OMDb popular TV fetch error:", error);
        res.status(500).json({ error: error.message });
      }
    });
  } catch (e) {
    console.error("❌ /api/home/tv/popular error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Helper function to search YouTube for trailer (using YouTube Data API or fallback)
async function searchYouTubeTrailer(title, year, apiKey) {
  try {
    // If YouTube API key is provided, use it
    if (apiKey) {
      const searchQuery = encodeURIComponent(`${title} ${year} official trailer`);
      const youtubeUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${searchQuery}&type=video&key=${apiKey}&maxResults=1`;
      const response = await makeRequest(youtubeUrl);
      if (response.statusCode === 200) {
        const data = JSON.parse(response.data);
        if (data.items && data.items.length > 0) {
          return data.items[0].id.videoId;
        }
      }
    }
    // Fallback: Return null, frontend will construct YouTube search URL
    return null;
  } catch (error) {
    console.warn(`Failed to search YouTube for ${title}:`, error.message);
    return null;
  }
}

// OMDb Popular Movies with Trailers (using IMDb moviemeter chart)
app.get("/api/home/movies/trailers", async (req, res) => {
  console.log("📥 GET /api/home/movies/trailers - Request received");
  try {
    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) {
        console.error("❌ Database error in /api/home/movies/trailers:", err);
        return res.status(500).send(err.message);
      }
      const settings = rows?.[0] || {};

      const omdbApiKey = settings.omdbApiKey;
      if (!omdbApiKey) {
        console.warn("⚠️ OMDb API key not configured");
        return res.status(400).json({ error: "OMDb API key not configured" });
      }

      try {
        // Get IMDb IDs from chart
        console.log("🔗 Fetching IMDb moviemeter chart...");
        const imdbIds = await getIMDbChartIDs('movies');

        // Fetch details from OMDb for each ID (limit to 10 for faster loading)
        const moviesWithTrailers = [];
        const idsToFetch = imdbIds.slice(0, 10);

        console.log(`🔗 Fetching details from OMDb for ${idsToFetch.length} movies in parallel...`);

        // Fetch ALL in parallel for maximum speed (no batching delays, no YouTube API waits)
        const moviePromises = idsToFetch.map(async (imdbId) => {
          try {
            const omdbUrl = `https://www.omdbapi.com/?i=${imdbId}&apikey=${omdbApiKey}&plot=short`;
            const omdbResponse = await makeRequest(omdbUrl);

            if (omdbResponse.statusCode === 200) {
              const movieData = JSON.parse(omdbResponse.data);
              if (movieData.Response === 'True' && !movieData.Error) {
                // Format data to match expected structure
                const movie = {
                  imdbID: movieData.imdbID,
                  title: movieData.Title,
                  year: movieData.Year,
                  poster_path: movieData.Poster !== 'N/A' ? movieData.Poster : '',
                  vote_average: movieData.imdbRating !== 'N/A' ? Math.round(parseFloat(movieData.imdbRating) * 10) : 0,
                  overview: movieData.Plot !== 'N/A' ? movieData.Plot : '',
                  release_date: movieData.Released !== 'N/A' ? movieData.Released : movieData.Year,
                  genre: movieData.Genre !== 'N/A' ? movieData.Genre : '',
                  director: movieData.Director !== 'N/A' ? movieData.Director : '',
                  imdbRating: movieData.imdbRating !== 'N/A' ? movieData.imdbRating : 'N/A',
                  imdbVotes: movieData.imdbVotes !== 'N/A' ? movieData.imdbVotes : 'N/A'
                };

                // Create YouTube search URL immediately (skip slow API call)
                const searchQuery = encodeURIComponent(`${movieData.Title} ${movieData.Year} official trailer`);
                movie.trailer_search_url = `https://www.youtube.com/results?search_query=${searchQuery}`;

                return movie;
              }
            }
            return null;
          } catch (err) {
            console.warn(`Failed to fetch OMDb data for ${imdbId}:`, err.message);
            return null;
          }
        });

        const results = await Promise.all(moviePromises);
        moviesWithTrailers.push(...results.filter(m => m !== null));

        console.log(`✅ Movies with trailers fetched successfully, count: ${moviesWithTrailers.length}`);
        res.json({ results: moviesWithTrailers });
      } catch (error) {
        console.error("❌ OMDb movies trailers fetch error:", error);
        res.status(500).json({ error: error.message });
      }
    });
  } catch (e) {
    console.error("❌ /api/home/movies/trailers error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// OMDb Popular TV Series with Trailers (using IMDb tvmeter chart)
app.get("/api/home/tv/trailers", async (req, res) => {
  console.log("📥 GET /api/home/tv/trailers - Request received");
  try {
    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) {
        console.error("❌ Database error in /api/home/tv/trailers:", err);
        return res.status(500).send(err.message);
      }
      const settings = rows?.[0] || {};

      const omdbApiKey = settings.omdbApiKey;
      if (!omdbApiKey) {
        console.warn("⚠️ OMDb API key not configured");
        return res.status(400).json({ error: "OMDb API key not configured" });
      }

      try {
        // Get IMDb IDs from chart
        console.log("🔗 Fetching IMDb tvmeter chart...");
        const imdbIds = await getIMDbChartIDs('tv');

        // Fetch details from OMDb for each ID (limit to 10 for faster loading)
        const tvWithTrailers = [];
        const idsToFetch = imdbIds.slice(0, 10);

        console.log(`🔗 Fetching details from OMDb for ${idsToFetch.length} TV shows in parallel...`);

        // Fetch ALL in parallel for maximum speed (no batching delays, no YouTube API waits)
        const tvPromises = idsToFetch.map(async (imdbId) => {
          try {
            const omdbUrl = `https://www.omdbapi.com/?i=${imdbId}&apikey=${omdbApiKey}&plot=short`;
            const omdbResponse = await makeRequest(omdbUrl);

            if (omdbResponse.statusCode === 200) {
              const tvData = JSON.parse(omdbResponse.data);
              if (tvData.Response === 'True' && !tvData.Error) {
                // Format data to match expected structure
                const tvShow = {
                  imdbID: tvData.imdbID,
                  name: tvData.Title, // TV shows use 'name' in frontend
                  title: tvData.Title,
                  year: tvData.Year,
                  poster_path: tvData.Poster !== 'N/A' ? tvData.Poster : '',
                  vote_average: tvData.imdbRating !== 'N/A' ? Math.round(parseFloat(tvData.imdbRating) * 10) : 0,
                  overview: tvData.Plot !== 'N/A' ? tvData.Plot : '',
                  first_air_date: tvData.Released !== 'N/A' ? tvData.Released : tvData.Year,
                  release_date: tvData.Released !== 'N/A' ? tvData.Released : tvData.Year,
                  genre: tvData.Genre !== 'N/A' ? tvData.Genre : '',
                  director: tvData.Director !== 'N/A' ? tvData.Director : '',
                  imdbRating: tvData.imdbRating !== 'N/A' ? tvData.imdbRating : 'N/A',
                  imdbVotes: tvData.imdbVotes !== 'N/A' ? tvData.imdbVotes : 'N/A'
                };

                // Create YouTube search URL immediately (skip slow API call)
                const searchQuery = encodeURIComponent(`${tvData.Title} ${tvData.Year} official trailer`);
                tvShow.trailer_search_url = `https://www.youtube.com/results?search_query=${searchQuery}`;

                return tvShow;
              }
            }
            return null;
          } catch (err) {
            console.warn(`Failed to fetch OMDb data for ${imdbId}:`, err.message);
            return null;
          }
        });

        const results = await Promise.all(tvPromises);
        tvWithTrailers.push(...results.filter(tv => tv !== null));

        console.log(`✅ TV with trailers fetched successfully, count: ${tvWithTrailers.length}`);
        res.json({ results: tvWithTrailers });
      } catch (error) {
        console.error("❌ OMDb TV trailers fetch error:", error);
        res.status(500).json({ error: error.message });
      }
    });
  } catch (e) {
    console.error("❌ /api/home/tv/trailers error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// TMDB Latest Trailers (using discover endpoint with filters)
app.get("/api/home/trailers", async (req, res) => {
  try {
    const { filter } = req.query;
    if (!filter) {
      return res.status(400).json({ error: "Missing filter parameter" });
    }

    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};

      const apiKey = settings.tmdbApiKey;
      if (!apiKey) {
        return res.status(400).json({ error: "TMDB API key not configured" });
      }

      // Build URL based on filter
      let url = '';
      if (filter === 'popular') {
        url = `https://api.themoviedb.org/3/discover/movie?api_key=${apiKey}&sort_by=popularity.desc&with_release_type=3|2&page=1`;
      } else if (filter === 'streaming') {
        url = `https://api.themoviedb.org/3/discover/movie?api_key=${apiKey}&sort_by=popularity.desc&watch_region=US&with_watch_providers=8|9|337|350&watch_region=US&page=1`;
      } else if (filter === 'on_tv') {
        url = `https://api.themoviedb.org/3/discover/tv?api_key=${apiKey}&sort_by=popularity.desc&first_air_date.gte=${new Date().toISOString().split('T')[0]}&page=1`;
      } else if (filter === 'for_rent') {
        url = `https://api.themoviedb.org/3/discover/movie?api_key=${apiKey}&sort_by=popularity.desc&with_release_type=4|5&page=1`;
      } else if (filter === 'in_theaters') {
        const today = new Date().toISOString().split('T')[0];
        url = `https://api.themoviedb.org/3/discover/movie?api_key=${apiKey}&sort_by=popularity.desc&primary_release_date.gte=${today}&with_release_type=3&page=1`;
      } else {
        return res.status(400).json({ error: "Invalid filter" });
      }

      makeRequest(url)
        .then(response => {
          if (response.statusCode !== 200) {
            throw new Error(`API returned status ${response.statusCode}: ${response.data}`);
          }

          const data = JSON.parse(response.data);
          // Convert TMDB scores from 0-10 scale to 0-100 scale
          if (data.results) {
            data.results = data.results.map(item => ({
              ...item,
              vote_average: item.vote_average ? Math.round(item.vote_average * 10) : 0
            }));
          }
          res.json(data);
        })
        .catch(error => {
          console.error("❌ TMDB trailers fetch error:", error);
          res.status(500).json({ error: error.message });
        });
    });
  } catch (e) {
    console.error("❌ /api/home/trailers error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// MyAnimeList Top Airing Anime
app.get("/api/home/anime/airing", async (req, res) => {
  try {
    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};

      const apiKey = settings.malApiKey;
      if (!apiKey) {
        return res.status(400).json({ error: "MyAnimeList API key not configured" });
      }

      try {
        const url = `https://api.myanimelist.net/v2/anime/ranking?ranking_type=airing&limit=20&fields=id,title,main_picture,start_date,synopsis,mean,genres,num_episodes,num_list_users`;
        const headers = { "X-MAL-CLIENT-ID": apiKey };

        console.log("🔗 Fetching top airing anime from MAL...");
        const response = await makeRequest(url, { headers });

        if (response.statusCode !== 200) {
          throw new Error(`API returned status ${response.statusCode}: ${response.data}`);
        }

        const data = JSON.parse(response.data);
        const animes = data.data || [];

        // Add trailer search URLs for each anime
        const animesWithTrailers = animes.map(anime => {
          const node = anime.node || anime;
          // Add trailer search URL for each anime
          const searchQuery = encodeURIComponent(`${node.title} anime trailer PV`);
          node.trailer_search_url = `https://www.youtube.com/results?search_query=${searchQuery}`;
          return anime;
        });

        console.log(`✅ Top airing anime fetched successfully, count: ${animesWithTrailers.length}`);
        res.json({ data: animesWithTrailers });
      } catch (error) {
        console.error("❌ MAL top airing fetch error:", error);
        res.status(500).json({ error: error.message });
      }
    });
  } catch (e) {
    console.error("❌ /api/home/anime/airing error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// MyAnimeList Just Added Anime Trailers (recently aired anime with trailers)
app.get("/api/home/anime/trailers", async (req, res) => {
  try {
    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};

      const apiKey = settings.malApiKey;
      if (!apiKey) {
        return res.status(400).json({ error: "MyAnimeList API key not configured" });
      }

      try {
        // Get recently aired anime (started in the last 6 months)
        const currentDate = new Date();
        const sixMonthsAgo = new Date(currentDate);
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const startDate = sixMonthsAgo.toISOString().split('T')[0];
        const endDate = currentDate.toISOString().split('T')[0];

        // Fetch anime that started airing recently (use seasonal or recently aired)
        // MyAnimeList doesn't have a direct "just added" endpoint, so we'll use "airing" 
        // and filter/sort by start_date, or use "all" ranking and filter
        const url = `https://api.myanimelist.net/v2/anime/ranking?ranking_type=airing&limit=25&fields=id,title,main_picture,start_date,synopsis,mean,genres,num_episodes,num_list_users`;
        const headers = { "X-MAL-CLIENT-ID": apiKey };

        console.log("🔗 Fetching just added anime trailers from MAL...");
        const response = await makeRequest(url, { headers });

        if (response.statusCode !== 200) {
          throw new Error(`API returned status ${response.statusCode}: ${response.data}`);
        }

        const data = JSON.parse(response.data);
        const animes = data.data || [];

        // Filter to get recently started anime (within last 6 months) and add trailer URLs
        const recentAnimes = animes
          .filter(anime => {
            const node = anime.node || anime;
            if (node.start_date) {
              const startDateObj = new Date(node.start_date);
              return startDateObj >= sixMonthsAgo && startDateObj <= currentDate;
            }
            // If no start_date, include it anyway (might be currently airing)
            return true;
          })
          .slice(0, 15) // Limit to 15 for performance
          .map(anime => {
            const node = anime.node || anime;
            // Add trailer search URL for each anime
            const searchQuery = encodeURIComponent(`${node.title} anime trailer PV`);
            node.trailer_search_url = `https://www.youtube.com/results?search_query=${searchQuery}`;
            return anime;
          });

        // Sort by start_date descending (newest first)
        recentAnimes.sort((a, b) => {
          const dateA = a.node?.start_date ? new Date(a.node.start_date) : new Date(0);
          const dateB = b.node?.start_date ? new Date(b.node.start_date) : new Date(0);
          return dateB - dateA;
        });

        console.log(`✅ Just added anime trailers fetched successfully, count: ${recentAnimes.length}`);
        res.json({ data: recentAnimes });
      } catch (error) {
        console.error("❌ MAL just added anime trailers fetch error:", error);
        res.status(500).json({ error: error.message });
      }
    });
  } catch (e) {
    console.error("❌ /api/home/anime/trailers error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// MyAnimeList Top Upcoming Anime (keeping for backward compatibility)
app.get("/api/home/anime/upcoming", async (req, res) => {
  try {
    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const settings = rows?.[0] || {};

      const apiKey = settings.malApiKey;
      if (!apiKey) {
        return res.status(400).json({ error: "MyAnimeList API key not configured" });
      }

      const url = `https://api.myanimelist.net/v2/anime/ranking?ranking_type=upcoming&limit=20&fields=id,title,main_picture,start_date,synopsis,mean,genres,num_episodes,num_list_users`;
      const headers = { "X-MAL-CLIENT-ID": apiKey };

      makeRequest(url, { headers })
        .then(response => {
          if (response.statusCode !== 200) {
            throw new Error(`API returned status ${response.statusCode}: ${response.data}`);
          }

          const data = JSON.parse(response.data);
          res.json(data);
        })
        .catch(error => {
          console.error("❌ MAL top upcoming fetch error:", error);
          res.status(500).json({ error: error.message });
        });
    });
  } catch (e) {
    console.error("❌ /api/home/anime/upcoming error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Games Trending (Steam - popular/recent games)
app.get("/api/home/games/trending", async (req, res) => {
  try {
    console.log("🔗 Fetching trending games from Steam Store Featured...");

    // Use Steam's Featured Categories endpoint to get currently popular/trending games
    // This endpoint returns games that are currently featured, on sale, or popular
    // Add browser-like headers to avoid 403 errors
    const featuredResponse = await makeRequest("https://store.steampowered.com/api/featuredcategories/?l=english", {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://store.steampowered.com/',
        'Origin': 'https://store.steampowered.com'
      }
    });

    if (featuredResponse.statusCode !== 200) {
      throw new Error(`Steam Featured API returned status ${featuredResponse.statusCode}`);
    }

    const featuredData = JSON.parse(featuredResponse.data);
    const appIds = new Set();

    // Collect app IDs from trending/popular sections (prioritize top sellers and new releases)
    // These represent currently popular and trending games
    if (featuredData.top_sellers && featuredData.top_sellers.items) {
      featuredData.top_sellers.items.forEach(item => appIds.add(item.id));
    }
    if (featuredData.new_releases && featuredData.new_releases.items) {
      featuredData.new_releases.items.forEach(item => appIds.add(item.id));
    }
    // Add specials (games on sale) as they're often trending too
    if (featuredData.specials && featuredData.specials.items) {
      featuredData.specials.items.slice(0, 10).forEach(item => appIds.add(item.id));
    }

    // Convert to array and take first 20 for trending (prioritize top sellers and new releases)
    const trendingAppIds = Array.from(appIds).slice(0, 20);

    if (trendingAppIds.length === 0) {
      console.warn("⚠️ No trending games found in featured categories");
      res.json({ results: [], error: "No trending games found. Please try again later." });
      return;
    }

    console.log(`📋 Found ${trendingAppIds.length} trending game IDs from featured categories`);

    // Fetch details for these apps in parallel
    const gamePromises = trendingAppIds.map(async (appid) => {
      try {
        const [detailsResponse, reviewsResponse] = await Promise.all([
          makeRequest(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`, { headers: STEAM_HEADERS }),
          makeRequest(`https://store.steampowered.com/appreviews/${appid}?json=1`, { headers: STEAM_HEADERS }).catch(() => ({ statusCode: 500, data: '{}' }))
        ]);

        if (detailsResponse.statusCode === 200) {
          const data = JSON.parse(detailsResponse.data);
          const appData = data[appid];
          if (appData && appData.success && appData.data) {
            const gameData = appData.data;

            // Skip if it's coming soon
            if (gameData.release_date?.coming_soon) {
              return null;
            }

            // Get user score from reviews
            let userScore = 0;
            if (reviewsResponse.statusCode === 200) {
              try {
                const reviewsData = JSON.parse(reviewsResponse.data);
                if (reviewsData.query_summary && reviewsData.query_summary.total_reviews > 0) {
                  const { total_positive, total_reviews } = reviewsData.query_summary;
                  userScore = Math.round((total_positive / total_reviews) * 100);
                }
              } catch (e) {
                // Ignore review parsing errors
              }
            }

            return {
              id: gameData.steam_appid,
              name: gameData.name,
              header_image: gameData.header_image || '',
              release_date: { date: gameData.release_date?.date || '' },
              vote_average: userScore
            };
          }
        }
        return null;
      } catch (e) {
        console.warn(`⚠️ Failed to fetch details for app ${appid}:`, e.message);
        return null;
      }
    });

    const results = (await Promise.all(gamePromises)).filter(game => game !== null);

    if (results.length === 0) {
      console.warn("⚠️ No trending games found - Steam API may be slow or unavailable");
      res.json({ results: [], error: "No trending games found. Please try again later." });
    } else {
      console.log(`✅ Trending games fetched successfully, count: ${results.length}`);
      res.json({ results });
    }
  } catch (e) {
    console.error("❌ /api/home/games/trending error:", e.message);

    // If Steam API is blocked, return empty results with a helpful message
    // The frontend will handle this gracefully
    if (e.message.includes('403') || e.message.includes('403')) {
      console.warn("⚠️ Steam API is blocking requests (403). This may be temporary.");
      res.json({
        results: [],
        error: "Steam API is temporarily unavailable. Please try again later or check your internet connection."
      });
    } else {
      res.status(500).json({ error: e.message, results: [] });
    }
  }
});

// TMDB Popular People/Celebrities
app.get("/api/home/people/popular", async (req, res) => {
  console.log("📥 GET /api/home/people/popular - Request received");
  try {
    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) {
        console.error("❌ Database error in /api/home/people/popular:", err);
        return res.status(500).send(err.message);
      }
      const settings = rows?.[0] || {};

      const apiKey = settings.tmdbApiKey;
      if (!apiKey) {
        console.warn("⚠️ TMDB API key not configured");
        return res.status(400).json({ error: "TMDB API key not configured" });
      }

      try {
        // Fetch popular people from TMDB
        console.log("🔗 Fetching popular people from TMDB...");
        const url = `https://api.themoviedb.org/3/person/popular?api_key=${apiKey}&page=1`;

        const response = await makeRequest(url);

        if (response.statusCode !== 200) {
          throw new Error(`TMDB API returned status ${response.statusCode}`);
        }

        const data = JSON.parse(response.data);
        const people = data.results || [];

        // Format the data for frontend
        const formattedPeople = people.slice(0, 15).map(person => ({
          id: person.id,
          name: person.name,
          profile_path: person.profile_path
            ? `https://image.tmdb.org/t/p/w300${person.profile_path}`
            : '',
          poster_path: person.profile_path
            ? `https://image.tmdb.org/t/p/w300${person.profile_path}`
            : '',
          known_for_department: person.known_for_department || 'Acting',
          popularity: person.popularity || 0,
          // Include known_for titles
          known_for: (person.known_for || []).slice(0, 3).map(item => ({
            id: item.id,
            title: item.title || item.name,
            media_type: item.media_type
          })),
          type: 'actors'
        }));

        console.log(`✅ Popular people fetched successfully, count: ${formattedPeople.length}`);
        res.json({ results: formattedPeople });
      } catch (error) {
        console.error("❌ TMDB popular people fetch error:", error);
        res.status(500).json({ error: error.message });
      }
    });
  } catch (e) {
    console.error("❌ /api/home/people/popular error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Games Upcoming (Steam - upcoming releases)
app.get("/api/home/games/upcoming", async (req, res) => {
  try {
    // Get upcoming games by searching for games marked as coming_soon
    const apps = await getSteamApps();

    // Check first 100 apps for upcoming releases
    const upcomingAppIds = apps.slice(0, 100).map(app => app.appid);
    const results = [];

    // Fetch details in batches
    for (const appid of upcomingAppIds) {
      try {
        const detailsResponse = await makeRequest(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`);
        if (detailsResponse.statusCode === 200) {
          const data = JSON.parse(detailsResponse.data);
          const appData = data[appid];
          if (appData && appData.success && appData.data) {
            const gameData = appData.data;
            const releaseDate = gameData.release_date;

            // Check if it's coming soon or has a future release date
            if (releaseDate && releaseDate.coming_soon) {
              results.push({
                id: gameData.steam_appid,
                name: gameData.name,
                header_image: gameData.header_image || '',
                release_date: { date: releaseDate.date || 'Coming Soon' },
                vote_average: 0 // Upcoming games don't have ratings yet
              });

              if (results.length >= 20) break;
            }
          }
        }
      } catch (e) {
        // Continue to next game
        continue;
      }
    }

    res.json({ results });
  } catch (e) {
    console.error("❌ /api/home/games/upcoming error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 🔍 Discover Endpoint
// ===============================
app.get("/api/discover", async (req, res) => {
  console.log("📥 GET /api/discover - Request received", req.query);
  try {
    const {
      type = 'movies',
      genre,
      sort,
      min_rating,
      min_votes
    } = req.query;

    db.all("SELECT * FROM settings WHERE id=1", async (err, rows) => {
      if (err) {
        console.error("❌ Database error in /api/discover:", err);
        return res.status(500).json({ error: err.message });
      }
      const settings = rows?.[0] || {};
      const tmdbApiKey = settings.tmdbApiKey;

      if (!tmdbApiKey) {
        return res.status(400).json({ error: "TMDB API key required for discovery" });
      }

      // Genre Mapping (Simple)
      const genreMap = {
        'action': 28, 'adventure': 12, 'animation': 16, 'comedy': 35,
        'crime': 80, 'documentary': 99, 'drama': 18, 'family': 10751,
        'fantasy': 14, 'history': 36, 'horror': 27, 'music': 10402,
        'mystery': 9648, 'romance': 10749, 'science fiction': 878, 'sci-fi': 878,
        'tv movie': 10770, 'thriller': 53, 'war': 10752, 'western': 37,
        'action & adventure': 10759, 'kids': 10762, 'news': 10763,
        'reality': 10764, 'sci-fi & fantasy': 10765, 'soap': 10766,
        'talk': 10767, 'war & politics': 10768
      };

      // Reverse Map for response
      const idToGenreMap = Object.entries(genreMap).reduce((acc, [name, id]) => {
        acc[id] = name.charAt(0).toUpperCase() + name.slice(1);
        if (name === 'sci-fi') acc[id] = 'Science Fiction';
        if (name === 'tv movie') acc[id] = 'TV Movie';
        return acc;
      }, {});

      // Construct Params
      let endpoint = type === 'tv' ? 'discover/tv' : 'discover/movie';
      let params = `api_key=${tmdbApiKey}&language=en-US&page=1&include_adult=false&include_video=false`;

      // Sort
      const sortMap = {
        'popularity.desc': 'popularity.desc',
        'popularity.asc': 'popularity.asc',
        'rating.desc': 'vote_average.desc',
        'rating.asc': 'vote_average.asc',
        'date.desc': type === 'tv' ? 'first_air_date.desc' : 'primary_release_date.desc',
        'date.asc': type === 'tv' ? 'first_air_date.asc' : 'primary_release_date.asc',
        'title.asc': type === 'tv' ? 'name.asc' : 'title.asc',
        'title.desc': type === 'tv' ? 'name.desc' : 'title.desc'
      };
      // Default to popularity
      params += `&sort_by=${sortMap[sort] || 'popularity.desc'}`;

      // Genre
      if (genre) {
        const genreIds = genre.split(',').map(g => genreMap[g.trim().toLowerCase()]).filter(g => g).join(',');
        if (genreIds) params += `&with_genres=${genreIds}`;
      }

      // Votes (User Votes)
      if (min_votes) {
        params += `&vote_count.gte=${min_votes}`;
      }

      // Rating (vote count filter is crucial to avoid trash)
      if (min_rating) {
        // Only apply default vote count limit if min_votes is not already set
        const voteLimit = min_votes ? '' : '&vote_count.gte=50';
        params += `&vote_average.gte=${min_rating}${voteLimit}`;
      }

      const url = `https://api.themoviedb.org/3/${endpoint}?${params}`;
      console.log(`🔗 Discover URL: ${url.replace(tmdbApiKey, 'HIDDEN')}`);

      try {
        const tmdbResp = await makeRequest(url);
        if (tmdbResp.statusCode === 200) {
          const data = JSON.parse(tmdbResp.data);
          const results = (data.results || []).map(item => ({
            id: item.id,
            title: item.title || item.name,
            poster_path: item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : '',
            vote_average: item.vote_average ? Math.round(item.vote_average * 10) : 0,
            vote_count: item.vote_count || 0,
            overview: item.overview,
            release_date: item.release_date || item.first_air_date,
            year: (item.release_date || item.first_air_date || '').split('-')[0],
            media_type: type === 'tv' ? 'tv' : 'movie',
            genre: (item.genre_ids || []).map(id => idToGenreMap[id]).filter(Boolean).join(', ')
          }));
          res.json({ results });
        } else {
          // If 404/500 from TMDB, return empty
          console.warn(`TMDB Discover returned status ${tmdbResp.statusCode}`);
          res.json({ results: [] });
        }
      } catch (e) {
        console.error('TMDB Discover failed:', e);
        res.status(500).json({ error: e.message });
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 🖼️ Category Images
// ===============================
// 🖼️ Category Images (GitHub Storage)
// ===============================

// Get all category images
app.get("/category-images", async (req, res) => {
  log("🖼️ GET /category-images called");
  try {
    if (!isGitHubConfigured()) {
      log("⚠️ GitHub not configured, returning empty array");
      return res.json([]);
    }

    const config = getDataRepoConfig();
    log("🔍 Fetching category-images.json from GitHub...");
    const result = await githubStorage.getFileContent(config, "category-images.json");

    if (!result || !result.content) {
      log("📭 No category images found");
      return res.json([]);
    }

    // Convert from object to array format for compatibility
    const catImages = result.content;
    const rows = Object.entries(catImages).map(([category, image]) => ({
      category,
      image: image.substring(0, 50) + "..." // Log truncated preview
    }));
    log(`✅ Found ${rows.length} category images:`, rows.map(r => r.category));

    // Return full images, not truncated
    const fullRows = Object.entries(catImages).map(([category, image]) => ({ category, image }));
    res.json(fullRows);
  } catch (error) {
    console.error("❌ /category-images GET error:", error.message);
    console.error("❌ /category-images GET error stack:", error.stack);
    res.json([]);
  }
});

// Save/update category image
app.post("/category-images", async (req, res) => {
  log("🖼️ POST /category-images called");
  try {
    if (!isGitHubConfigured()) {
      log("⚠️ GitHub not configured, cannot save");
      return res.status(500).send("GitHub storage not configured");
    }

    const { category, image } = req.body || {};
    log(`📝 Category: ${category}, Image size: ${image ? image.length : 0} chars`);

    if (!category || !image) {
      log("❌ Missing category or image");
      return res.status(400).send("Missing category or image");
    }

    const config = getDataRepoConfig();
    log("📂 Using data repo config:", { owner: config.owner, repo: config.repo });

    // Get current category images
    let catImages = {};
    let currentSha = null;
    try {
      log("🔍 Getting existing category-images.json...");
      const result = await githubStorage.getFileContent(config, "category-images.json");
      if (result) {
        catImages = result.content || {};
        currentSha = result.sha;
        log(`✅ Found existing file with ${Object.keys(catImages).length} categories, SHA: ${currentSha}`);
      } else {
        log("📭 No existing file found, will create new");
      }
    } catch (e) {
      log(`⚠️ Error getting file (might not exist): ${e.message}`);
      // File doesn't exist yet
    }

    // Update the category
    catImages[category] = image;
    log(`📝 Updated category '${category}', now have ${Object.keys(catImages).length} categories`);

    // Save to GitHub
    log("💾 Saving to GitHub...");
    const saveResult = await githubStorage.createOrUpdateFile(
      config,
      "category-images.json",
      catImages,
      `Update category image for ${category}`,
      currentSha
    );

    log(`✅ Saved category image for: ${category}, new SHA: ${saveResult?.sha}`);
    res.json({ ok: true, sha: saveResult?.sha });
  } catch (e) {
    console.error("❌ /category-images POST error:", e.message);
    console.error("❌ /category-images POST error stack:", e.stack);
    res.status(500).send(e.message);
  }
});


// Static file serving - after all API routes
app.use("/assets", express.static(path.join(__dirname, "assets")));

// Serve static files (JS, CSS, etc.) - must be before catch-all route
app.use(express.static(ROOT_DIR, {
  // Don't serve index.html for static file requests
  index: false
}));

// ===============================
// 🧭 Fallback route - only for non-file requests
// ===============================
app.use((req, res) => {
  // Only serve index.html if it's not a file request
  const ext = path.extname(req.path);
  if (ext && ext !== '.html') {
    // It's a file request that wasn't found, return 404
    return res.status(404).send('File not found');
  }
  // Otherwise serve index.html for SPA routing
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

// ===============================
// 🚀 Start server
// ===============================
app.listen(3000, "0.0.0.0", () => log("Server running at http://0.0.0.0:3000 (accessible on local network)"));
