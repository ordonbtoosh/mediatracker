/**
 * GitHub Storage Module
 * Handles all GitHub API operations for MediaTracker data persistence
 */

const https = require("https");

// GitHub API base URL
const GITHUB_API_BASE = "api.github.com";

/**
 * Make an authenticated request to GitHub API
 * @param {string} method - HTTP method
 * @param {string} path - API path (without base URL)
 * @param {object} options - Additional options (token, body)
 * @returns {Promise<{statusCode: number, data: any, headers: object}>}
 */
function githubRequest(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const { token, body } = options;
    
    if (!token) {
      return reject(new Error("GitHub token is required"));
    }

    const requestOptions = {
      hostname: GITHUB_API_BASE,
      path: path,
      method: method,
      headers: {
        "User-Agent": "MediaTracker-App",
        "Accept": "application/vnd.github.v3+json",
        "Authorization": `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    };

    if (body) {
      const bodyStr = JSON.stringify(body);
      requestOptions.headers["Content-Type"] = "application/json";
      requestOptions.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(requestOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ statusCode: res.statusCode, data: parsed, headers: res.headers });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: data, headers: res.headers });
        }
      });
    });

    req.on("error", reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

/**
 * Get file content from a GitHub repository
 * @param {object} config - { owner, repo, token }
 * @param {string} filePath - Path to file in repository
 * @returns {Promise<{content: any, sha: string}|null>}
 */
async function getFileContent(config, filePath) {
  const { owner, repo, token } = config;
  const path = `/repos/${owner}/${repo}/contents/${filePath}`;
  
  try {
    const response = await githubRequest("GET", path, { token });
    
    if (response.statusCode === 404) {
      return null; // File doesn't exist
    }
    
    if (response.statusCode !== 200) {
      console.error(`GitHub API error (${response.statusCode}):`, response.data);
      throw new Error(`GitHub API error: ${response.statusCode}`);
    }
    
    const { content, sha } = response.data;
    
    if (!content) {
      return { content: null, sha };
    }
    
    // Decode base64 content
    const decoded = Buffer.from(content, "base64").toString("utf-8");
    
    // Try to parse as JSON
    try {
      return { content: JSON.parse(decoded), sha };
    } catch (e) {
      // Return raw content if not JSON
      return { content: decoded, sha };
    }
  } catch (error) {
    console.error(`Error getting file ${filePath}:`, error.message);
    throw error;
  }
}

/**
 * Create or update a file in a GitHub repository
 * @param {object} config - { owner, repo, token }
 * @param {string} filePath - Path to file in repository
 * @param {any} content - Content to write (will be JSON stringified if object)
 * @param {string} message - Commit message
 * @param {string|null} sha - SHA of existing file (required for updates)
 * @returns {Promise<{sha: string, commit: object}>}
 */
async function createOrUpdateFile(config, filePath, content, message, sha = null) {
  const { owner, repo, token } = config;
  const path = `/repos/${owner}/${repo}/contents/${filePath}`;
  
  // Convert content to string if needed
  const contentStr = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  
  // Encode content as base64
  const contentBase64 = Buffer.from(contentStr).toString("base64");
  
  const body = {
    message: message || `Update ${filePath}`,
    content: contentBase64
  };
  
  // If SHA provided, this is an update
  if (sha) {
    body.sha = sha;
  }
  
  try {
    const response = await githubRequest("PUT", path, { token, body });
    
    if (response.statusCode !== 200 && response.statusCode !== 201) {
      console.error(`GitHub API error (${response.statusCode}):`, response.data);
      throw new Error(`GitHub API error: ${response.statusCode} - ${response.data.message || "Unknown error"}`);
    }
    
    return {
      sha: response.data.content?.sha,
      commit: response.data.commit
    };
  } catch (error) {
    console.error(`Error creating/updating file ${filePath}:`, error.message);
    throw error;
  }
}

/**
 * Delete a file from a GitHub repository
 * @param {object} config - { owner, repo, token }
 * @param {string} filePath - Path to file in repository
 * @param {string} sha - SHA of the file to delete
 * @param {string} message - Commit message
 * @returns {Promise<boolean>}
 */
async function deleteFile(config, filePath, sha, message) {
  const { owner, repo, token } = config;
  const path = `/repos/${owner}/${repo}/contents/${filePath}`;
  
  const body = {
    message: message || `Delete ${filePath}`,
    sha: sha
  };
  
  try {
    const response = await githubRequest("DELETE", path, { token, body });
    
    if (response.statusCode !== 200) {
      console.error(`GitHub API error (${response.statusCode}):`, response.data);
      throw new Error(`GitHub API error: ${response.statusCode}`);
    }
    
    return true;
  } catch (error) {
    console.error(`Error deleting file ${filePath}:`, error.message);
    throw error;
  }
}

/**
 * Get repository size in bytes
 * @param {object} config - { owner, repo, token }
 * @returns {Promise<number>} - Size in bytes
 */
async function getRepoSize(config) {
  const { owner, repo, token } = config;
  const path = `/repos/${owner}/${repo}`;
  
  try {
    const response = await githubRequest("GET", path, { token });
    
    if (response.statusCode !== 200) {
      console.error(`GitHub API error (${response.statusCode}):`, response.data);
      throw new Error(`GitHub API error: ${response.statusCode}`);
    }
    
    // GitHub returns size in KB
    return (response.data.size || 0) * 1024;
  } catch (error) {
    console.error(`Error getting repo size:`, error.message);
    throw error;
  }
}

/**
 * Select the appropriate image repository based on size limits
 * Repos should be under 900MB to leave buffer room
 * @param {object} config - { owner, token }
 * @param {string[]} imageRepos - List of image repository names
 * @returns {Promise<string|null>} - Selected repository name or null if all full
 */
async function selectImageRepo(config, imageRepos) {
  const { owner, token } = config;
  const MAX_SIZE = 900 * 1024 * 1024; // 900MB in bytes
  
  for (const repo of imageRepos) {
    try {
      const size = await getRepoSize({ owner, repo, token });
      console.log(`Image repo ${repo} size: ${(size / 1024 / 1024).toFixed(2)}MB`);
      
      if (size < MAX_SIZE) {
        return repo;
      }
    } catch (error) {
      // If repo doesn't exist or error, try next one
      console.warn(`Could not check repo ${repo}:`, error.message);
      continue;
    }
  }
  
  // All repos are full or unavailable
  console.error("All image repositories are full or unavailable!");
  return null;
}

/**
 * Upload an image (binary file) to a GitHub repository
 * @param {object} config - { owner, repo, token }
 * @param {string} filePath - Path for the image file
 * @param {Buffer|string} imageData - Image data (Buffer or base64 string)
 * @param {string} message - Commit message
 * @param {string|null} sha - SHA of existing file (for updates)
 * @returns {Promise<{sha: string, downloadUrl: string}>}
 */
async function uploadImage(config, filePath, imageData, message, sha = null) {
  const { owner, repo, token } = config;
  const path = `/repos/${owner}/${repo}/contents/${filePath}`;
  
  // Convert to base64 if it's a Buffer
  let contentBase64;
  if (Buffer.isBuffer(imageData)) {
    contentBase64 = imageData.toString("base64");
  } else if (typeof imageData === "string") {
    // If it's a data URL, extract base64 part
    if (imageData.startsWith("data:")) {
      contentBase64 = imageData.split(",")[1];
    } else {
      // Assume it's already base64
      contentBase64 = imageData;
    }
  } else {
    throw new Error("Invalid image data type");
  }
  
  const body = {
    message: message || `Upload ${filePath}`,
    content: contentBase64
  };
  
  if (sha) {
    body.sha = sha;
  }
  
  try {
    const response = await githubRequest("PUT", path, { token, body });
    
    if (response.statusCode !== 200 && response.statusCode !== 201) {
      console.error(`GitHub API error (${response.statusCode}):`, response.data);
      throw new Error(`GitHub API error: ${response.statusCode}`);
    }
    
    // Construct raw download URL
    const downloadUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${filePath}`;
    
    return {
      sha: response.data.content?.sha,
      downloadUrl
    };
  } catch (error) {
    console.error(`Error uploading image ${filePath}:`, error.message);
    throw error;
  }
}

/**
 * Get directory listing from a GitHub repository
 * @param {object} config - { owner, repo, token }
 * @param {string} dirPath - Path to directory in repository
 * @returns {Promise<Array<{name: string, path: string, sha: string, type: string}>>}
 */
async function listDirectory(config, dirPath) {
  const { owner, repo, token } = config;
  const path = `/repos/${owner}/${repo}/contents/${dirPath}`;
  
  try {
    const response = await githubRequest("GET", path, { token });
    
    if (response.statusCode === 404) {
      return []; // Directory doesn't exist
    }
    
    if (response.statusCode !== 200) {
      console.error(`GitHub API error (${response.statusCode}):`, response.data);
      throw new Error(`GitHub API error: ${response.statusCode}`);
    }
    
    // Ensure we have an array response (directory listing)
    if (!Array.isArray(response.data)) {
      return []; // Might be a file, not a directory
    }
    
    return response.data.map(item => ({
      name: item.name,
      path: item.path,
      sha: item.sha,
      type: item.type // "file" or "dir"
    }));
  } catch (error) {
    console.error(`Error listing directory ${dirPath}:`, error.message);
    throw error;
  }
}

/**
 * Check if a repository exists and is accessible
 * @param {object} config - { owner, repo, token }
 * @returns {Promise<boolean>}
 */
async function repoExists(config) {
  const { owner, repo, token } = config;
  const path = `/repos/${owner}/${repo}`;
  
  try {
    const response = await githubRequest("GET", path, { token });
    return response.statusCode === 200;
  } catch (error) {
    return false;
  }
}

/**
 * Initialize repository structure if it doesn't exist
 * Creates necessary directories and index files
 * @param {object} config - { owner, repo, token }
 * @returns {Promise<boolean>}
 */
async function initializeDataRepo(config) {
  const { owner, repo, token } = config;
  
  try {
    // Check if repo exists
    if (!await repoExists(config)) {
      console.error(`Repository ${owner}/${repo} does not exist or is not accessible`);
      return false;
    }
    
    // Check if already initialized by looking for settings.json
    const settings = await getFileContent(config, "settings.json");
    if (settings) {
      console.log("Repository already initialized");
      return true;
    }
    
    // Create initial structure
    console.log("Initializing repository structure...");
    
    // Create empty settings.json
    await createOrUpdateFile(config, "settings.json", {}, "Initialize settings");
    
    // Create media index
    await createOrUpdateFile(config, "media/index.json", [], "Initialize media index");
    
    // Create collections index
    await createOrUpdateFile(config, "collections/index.json", [], "Initialize collections index");
    
    // Create empty category images
    await createOrUpdateFile(config, "category-images.json", {}, "Initialize category images");
    
    console.log("Repository structure initialized successfully");
    return true;
  } catch (error) {
    console.error("Error initializing repository:", error.message);
    throw error;
  }
}

module.exports = {
  getFileContent,
  createOrUpdateFile,
  deleteFile,
  getRepoSize,
  selectImageRepo,
  uploadImage,
  listDirectory,
  repoExists,
  initializeDataRepo,
  githubRequest
};
