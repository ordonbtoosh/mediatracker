/**
 * Cloudinary Storage Module
 * Handles all Cloudinary API operations for MediaTracker data persistence
 * Replaces GitHub storage for images and uses Cloudinary's metadata for JSON data
 */

const cloudinary = require('cloudinary').v2;

// Configuration cache
let cloudinaryConfig = null;

/**
 * Configure Cloudinary with credentials
 * @param {object} config - { cloudName, apiKey, apiSecret }
 */
function configure(config) {
    if (!config || !config.cloudName || !config.apiKey || !config.apiSecret) {
        console.warn('[Cloudinary] Missing configuration');
        return false;
    }

    cloudinaryConfig = config;

    cloudinary.config({
        cloud_name: config.cloudName,
        api_key: config.apiKey,
        api_secret: config.apiSecret,
        secure: true
    });

    console.log('[Cloudinary] Configured successfully for cloud:', config.cloudName);
    return true;
}

/**
 * Check if Cloudinary is configured
 */
function isConfigured() {
    return cloudinaryConfig !== null &&
        cloudinaryConfig.cloudName &&
        cloudinaryConfig.apiKey &&
        cloudinaryConfig.apiSecret;
}

/**
 * Upload an image to Cloudinary
 * @param {string} imageData - Base64 data URI or URL
 * @param {string} publicId - Public ID for the image (path-like identifier)
 * @param {string} folder - Folder to store the image in
 * @returns {Promise<{url: string, publicId: string, secure_url: string}>}
 */
async function uploadImage(imageData, publicId, folder = 'mediatracker') {
    if (!isConfigured()) {
        throw new Error('Cloudinary not configured');
    }

    try {
        const options = {
            folder: folder,
            public_id: publicId,
            overwrite: true,
            resource_type: 'image'
        };

        // If it's a URL, use url upload
        if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
            const result = await cloudinary.uploader.upload(imageData, options);
            return {
                url: result.secure_url,
                publicId: result.public_id,
                secure_url: result.secure_url
            };
        }

        // If it's base64, upload directly
        if (imageData.startsWith('data:image')) {
            const result = await cloudinary.uploader.upload(imageData, options);
            return {
                url: result.secure_url,
                publicId: result.public_id,
                secure_url: result.secure_url
            };
        }

        throw new Error('Invalid image data format. Expected URL or base64 data URI.');
    } catch (error) {
        console.error('[Cloudinary] Upload error:', error.message);
        throw error;
    }
}

/**
 * Delete an image from Cloudinary
 * @param {string} publicId - Public ID of the image to delete
 * @returns {Promise<boolean>}
 */
async function deleteImage(publicId) {
    if (!isConfigured()) {
        throw new Error('Cloudinary not configured');
    }

    try {
        const result = await cloudinary.uploader.destroy(publicId);
        return result.result === 'ok';
    } catch (error) {
        console.error('[Cloudinary] Delete error:', error.message);
        throw error;
    }
}

/**
 * Get image URL by public ID
 * @param {string} publicId - Public ID of the image
 * @param {object} transformations - Optional transformations
 * @returns {string}
 */
function getImageUrl(publicId, transformations = {}) {
    if (!isConfigured()) {
        throw new Error('Cloudinary not configured');
    }

    return cloudinary.url(publicId, {
        secure: true,
        ...transformations
    });
}

/**
 * Upload JSON data as a raw file (for settings, items, collections)
 * @param {object} data - JSON data to store
 * @param {string} publicId - Public ID for the file
 * @param {string} folder - Folder to store the file in
 * @returns {Promise<{url: string, publicId: string}>}
 */
async function uploadJsonData(data, publicId, folder = 'mediatracker/data') {
    console.log(`[Cloudinary] uploadJsonData called: publicId=${publicId}, folder=${folder}`);

    if (!isConfigured()) {
        console.error('[Cloudinary] uploadJsonData failed: not configured');
        throw new Error('Cloudinary not configured');
    }

    try {
        // Convert JSON to base64 data URI
        const jsonString = JSON.stringify(data, null, 2);
        const base64 = Buffer.from(jsonString).toString('base64');
        const dataUri = `data:application/json;base64,${base64}`;

        console.log(`[Cloudinary] Uploading JSON (${jsonString.length} bytes) to folder: ${folder}, publicId: ${publicId}`);

        const result = await cloudinary.uploader.upload(dataUri, {
            folder: folder,
            public_id: publicId,
            overwrite: true,
            resource_type: 'raw'
        });

        console.log(`[Cloudinary] ✅ Upload success! URL: ${result.secure_url}`);
        console.log(`[Cloudinary] Full public_id: ${result.public_id}`);

        return {
            url: result.secure_url,
            publicId: result.public_id
        };
    } catch (error) {
        console.error('[Cloudinary] ❌ JSON upload error:', error.message);
        console.error('[Cloudinary] Error details:', error);
        throw error;
    }
}

/**
 * Get JSON data from Cloudinary
 * @param {string} publicId - Public ID of the JSON file (with folder path)
 * @returns {Promise<object|null>}
 */
async function getJsonData(publicId) {
    if (!isConfigured()) {
        throw new Error('Cloudinary not configured');
    }

    try {
        // Get the raw file URL with cache-busting timestamp
        const timestamp = Date.now();
        const baseUrl = cloudinary.url(publicId, {
            resource_type: 'raw',
            secure: true
        });

        // Add cache-busting query parameter
        const url = `${baseUrl}?t=${timestamp}`;

        // Fetch the content
        const https = require('https');
        const http = require('http');

        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https') ? https : http;

            protocol.get(url, (res) => {
                if (res.statusCode === 404) {
                    console.log(`[Cloudinary] JSON not found: ${publicId}`);
                    resolve(null);
                    return;
                }

                if (res.statusCode !== 200) {
                    console.error(`[Cloudinary] Failed to fetch JSON: ${res.statusCode} for ${publicId}`);
                    reject(new Error(`Failed to fetch JSON: ${res.statusCode}`));
                    return;
                }

                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        console.log(`[Cloudinary] Successfully loaded: ${publicId}`);
                        resolve(parsed);
                    } catch (e) {
                        reject(new Error('Failed to parse JSON: ' + e.message));
                    }
                });
            }).on('error', (err) => {
                console.error(`[Cloudinary] Request error for ${publicId}:`, err.message);
                reject(err);
            });
        });
    } catch (error) {
        console.error('[Cloudinary] JSON fetch error:', error.message);
        // Return null for not found or errors (to allow fresh start)
        if (error.message.includes('404') || error.message.includes('not found')) {
            return null;
        }
        throw error;
    }
}

/**
 * Delete JSON data from Cloudinary
 * @param {string} publicId - Public ID of the JSON file
 * @returns {Promise<boolean>}
 */
async function deleteJsonData(publicId) {
    if (!isConfigured()) {
        throw new Error('Cloudinary not configured');
    }

    try {
        const result = await cloudinary.uploader.destroy(publicId, {
            resource_type: 'raw'
        });
        return result.result === 'ok';
    } catch (error) {
        console.error('[Cloudinary] JSON delete error:', error.message);
        throw error;
    }
}

/**
 * List all resources in a folder
 * @param {string} folder - Folder path
 * @param {string} resourceType - 'image' or 'raw'
 * @returns {Promise<Array>}
 */
async function listFolder(folder, resourceType = 'image') {
    if (!isConfigured()) {
        throw new Error('Cloudinary not configured');
    }

    try {
        const result = await cloudinary.api.resources({
            type: 'upload',
            prefix: folder,
            resource_type: resourceType,
            max_results: 500
        });

        return result.resources || [];
    } catch (error) {
        console.error('[Cloudinary] List folder error:', error.message);
        return [];
    }
}

/**
 * Get storage usage information
 * @returns {Promise<{used: number, limit: number}>}
 */
async function getUsage() {
    if (!isConfigured()) {
        throw new Error('Cloudinary not configured');
    }

    try {
        const result = await cloudinary.api.usage();
        return {
            used: result.storage?.used_bytes || 0,
            limit: result.storage?.limit_bytes || 0
        };
    } catch (error) {
        console.error('[Cloudinary] Usage error:', error.message);
        return { used: 0, limit: 0 };
    }
}

module.exports = {
    configure,
    isConfigured,
    uploadImage,
    deleteImage,
    getImageUrl,
    uploadJsonData,
    getJsonData,
    deleteJsonData,
    listFolder,
    getUsage
};
