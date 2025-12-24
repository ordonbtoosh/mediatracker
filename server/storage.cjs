/**
 * Storage Abstraction Layer
 * Provides a unified interface for data/image storage
 * Supports both GitHub and Cloudinary backends
 */

const githubStorage = require('./github-storage.cjs');
const cloudinaryStorage = require('./cloudinary-storage.cjs');

// Current storage provider
let storageProvider = 'github'; // 'github' or 'cloudinary'

// Configuration caches
let githubConfig = null;
let cloudinaryConfig = null;

/**
 * Set the storage provider
 * @param {'github' | 'cloudinary'} provider
 */
function setProvider(provider) {
    if (provider !== 'github' && provider !== 'cloudinary') {
        throw new Error('Invalid storage provider. Must be "github" or "cloudinary"');
    }
    storageProvider = provider;
    console.log(`[Storage] Provider set to: ${provider}`);
}

/**
 * Get current provider
 */
function getProvider() {
    return storageProvider;
}

/**
 * Configure GitHub storage
 * @param {object} config - { token, owner, dataRepo, imageRepos }
 */
function configureGitHub(config) {
    githubConfig = config;
}

/**
 * Configure Cloudinary storage
 * @param {object} config - { cloudName, apiKey, apiSecret }
 */
function configureCloudinary(config) {
    cloudinaryConfig = config;
    return cloudinaryStorage.configure(config);
}

/**
 * Check if storage is configured
 */
function isConfigured() {
    if (storageProvider === 'cloudinary') {
        return cloudinaryStorage.isConfigured();
    }
    return githubConfig && githubConfig.token && githubConfig.owner && githubConfig.dataRepo;
}

/**
 * Get GitHub config (for backward compatibility)
 */
function getGitHubConfig() {
    return githubConfig;
}

/**
 * Get data repository config (GitHub specific)
 */
function getDataRepoConfig() {
    if (!githubConfig) return null;
    return {
        owner: githubConfig.owner,
        repo: githubConfig.dataRepo,
        token: githubConfig.token
    };
}

// ===============================
// JSON Data Operations
// ===============================

/**
 * Get JSON file content
 * @param {string} filePath - Path to file (e.g., 'settings.json', 'media/index.json')
 * @returns {Promise<{content: object, sha?: string} | null>}
 */
async function getFileContent(filePath) {
    if (storageProvider === 'cloudinary') {
        const publicId = `mediatracker/data/${filePath.replace('.json', '')}`;
        const content = await cloudinaryStorage.getJsonData(publicId);
        return content ? { content, sha: null } : null;
    }

    // GitHub
    const config = getDataRepoConfig();
    if (!config) return null;
    return await githubStorage.getFileContent(config, filePath);
}

/**
 * Create or update a file
 * @param {string} filePath - Path to file
 * @param {object} content - JSON content
 * @param {string} message - Commit message (GitHub only)
 * @param {string|null} sha - SHA for update (GitHub only)
 * @returns {Promise<{sha?: string, url?: string}>}
 */
async function createOrUpdateFile(filePath, content, message = 'Update file', sha = null) {
    if (storageProvider === 'cloudinary') {
        const publicId = filePath.replace('.json', '').replace(/\//g, '_');
        const result = await cloudinaryStorage.uploadJsonData(content, publicId);
        return { url: result.url };
    }

    // GitHub
    const config = getDataRepoConfig();
    if (!config) throw new Error('GitHub not configured');
    return await githubStorage.createOrUpdateFile(config, filePath, content, message, sha);
}

/**
 * Delete a file
 * @param {string} filePath - Path to file
 * @param {string} sha - SHA (GitHub only)
 * @param {string} message - Commit message (GitHub only)
 * @returns {Promise<boolean>}
 */
async function deleteFile(filePath, sha = null, message = 'Delete file') {
    if (storageProvider === 'cloudinary') {
        const publicId = `mediatracker/data/${filePath.replace('.json', '')}`;
        return await cloudinaryStorage.deleteJsonData(publicId);
    }

    // GitHub
    const config = getDataRepoConfig();
    if (!config) throw new Error('GitHub not configured');
    return await githubStorage.deleteFile(config, filePath, sha, message);
}

// ===============================
// Image Operations
// ===============================

/**
 * Upload an image
 * @param {string} imageData - Base64 data URI or URL
 * @param {string} filePath - Path for the image
 * @param {string} message - Commit message (GitHub only)
 * @returns {Promise<{url: string, sha?: string}>}
 */
async function uploadImage(imageData, filePath, message = 'Upload image') {
    if (storageProvider === 'cloudinary') {
        // Extract public ID from file path
        const publicId = filePath.replace(/\.[^.]+$/, '').replace(/\//g, '_');
        const result = await cloudinaryStorage.uploadImage(imageData, publicId, 'mediatracker/images');
        return { url: result.secure_url, publicId: result.publicId };
    }

    // GitHub - select appropriate image repo
    const config = getGitHubConfig();
    if (!config) throw new Error('GitHub not configured');

    const selectedRepo = await githubStorage.selectImageRepo(
        { owner: config.owner, token: config.token },
        config.imageRepos
    );

    if (!selectedRepo) {
        throw new Error('All image repositories are full');
    }

    const imageConfig = {
        owner: config.owner,
        repo: selectedRepo,
        token: config.token
    };

    const result = await githubStorage.uploadImage(imageConfig, filePath, imageData, message);
    return { url: result.downloadUrl, sha: result.sha };
}

/**
 * Delete an image
 * @param {string} identifier - Public ID (Cloudinary) or file path (GitHub)
 * @param {string} sha - SHA (GitHub only)
 * @returns {Promise<boolean>}
 */
async function deleteImage(identifier, sha = null) {
    if (storageProvider === 'cloudinary') {
        return await cloudinaryStorage.deleteImage(identifier);
    }

    // GitHub - need to know which repo the image is in
    // This is more complex for GitHub, would need to track this
    console.warn('[Storage] Image deletion for GitHub requires knowing the repo');
    return false;
}

/**
 * Get image URL
 * @param {string} identifier - Public ID or path
 * @param {object} options - Transform options (Cloudinary only)
 * @returns {string}
 */
function getImageUrl(identifier, options = {}) {
    if (storageProvider === 'cloudinary') {
        return cloudinaryStorage.getImageUrl(identifier, options);
    }

    // For GitHub, the URL is already stored with the item
    return identifier;
}

// ===============================
// Utility Operations
// ===============================

/**
 * List contents of a directory/folder
 * @param {string} path - Directory path
 * @returns {Promise<Array>}
 */
async function listDirectory(path) {
    if (storageProvider === 'cloudinary') {
        return await cloudinaryStorage.listFolder(path);
    }

    // GitHub
    const config = getDataRepoConfig();
    if (!config) return [];
    return await githubStorage.listDirectory(config, path);
}

/**
 * Check if storage repo/account exists and is accessible
 * @returns {Promise<boolean>}
 */
async function checkAccess() {
    if (storageProvider === 'cloudinary') {
        try {
            await cloudinaryStorage.getUsage();
            return true;
        } catch (e) {
            return false;
        }
    }

    // GitHub
    const config = getDataRepoConfig();
    if (!config) return false;
    return await githubStorage.repoExists(config);
}

/**
 * Get storage usage information
 * @returns {Promise<{used: number, limit: number}>}
 */
async function getUsage() {
    if (storageProvider === 'cloudinary') {
        return await cloudinaryStorage.getUsage();
    }

    // GitHub - aggregate across repos
    const config = getGitHubConfig();
    if (!config) return { used: 0, limit: 0 };

    let totalUsed = 0;

    // Check data repo
    const dataConfig = getDataRepoConfig();
    if (dataConfig) {
        totalUsed += await githubStorage.getRepoSize(dataConfig);
    }

    // Check image repos
    for (const repoName of (config.imageRepos || [])) {
        const imgConfig = { owner: config.owner, repo: repoName, token: config.token };
        totalUsed += await githubStorage.getRepoSize(imgConfig);
    }

    return { used: totalUsed, limit: 1024 * 1024 * 1024 * 5 }; // 5GB total estimate
}

/**
 * Initialize storage (create necessary structures)
 * @returns {Promise<boolean>}
 */
async function initialize() {
    if (storageProvider === 'cloudinary') {
        // Cloudinary doesn't need initialization
        return cloudinaryStorage.isConfigured();
    }

    // GitHub
    const config = getDataRepoConfig();
    if (!config) return false;
    return await githubStorage.initializeDataRepo(config);
}

// Export functions
module.exports = {
    // Configuration
    setProvider,
    getProvider,
    configureGitHub,
    configureCloudinary,
    isConfigured,
    getGitHubConfig,
    getDataRepoConfig,

    // JSON Data
    getFileContent,
    createOrUpdateFile,
    deleteFile,

    // Images
    uploadImage,
    deleteImage,
    getImageUrl,

    // Utility
    listDirectory,
    checkAccess,
    getUsage,
    initialize,

    // Direct access to underlying modules (for advanced use)
    github: githubStorage,
    cloudinary: cloudinaryStorage
};
