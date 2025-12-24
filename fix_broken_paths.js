/**
 * Script to fix broken posterPath/bannerPath in media items
 * Run this locally with: node fix_broken_paths.js
 */

const https = require('https');

// Configuration - update these values
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'YOUR_TOKEN_HERE';
const GITHUB_OWNER = 'ordonbtoosh';
const DATA_REPO = 'mediatracker-data';
const IMAGE_REPOS = ['mediatracker-images-1', 'mediatracker-images-2', 'mediatracker-images-3'];

function githubRequest(method, path, options = {}) {
    return new Promise((resolve, reject) => {
        const reqOptions = {
            hostname: 'api.github.com',
            path: path,
            method: method,
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'User-Agent': 'MediaTracker-Fix-Script',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
                } catch {
                    resolve({ statusCode: res.statusCode, data });
                }
            });
        });

        req.on('error', reject);

        if (options.body) {
            req.write(JSON.stringify(options.body));
        }
        req.end();
    });
}

async function getFileContent(path) {
    const response = await githubRequest('GET', `/repos/${GITHUB_OWNER}/${DATA_REPO}/contents/${path}`);
    if (response.statusCode !== 200) {
        throw new Error(`Failed to get ${path}: ${response.statusCode}`);
    }
    const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
    return { content: JSON.parse(content), sha: response.data.sha };
}

async function updateFile(path, content, sha, message) {
    const response = await githubRequest('PUT', `/repos/${GITHUB_OWNER}/${DATA_REPO}/contents/${path}`, {
        body: {
            message,
            content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
            sha
        }
    });
    return response;
}

async function checkImageExists(repo, filename) {
    const response = await githubRequest('GET', `/repos/${GITHUB_OWNER}/${repo}/contents/${filename}`);
    return response.statusCode === 200;
}

async function findImageRepo(filename) {
    for (const repo of IMAGE_REPOS) {
        if (await checkImageExists(repo, filename)) {
            return repo;
        }
    }
    return null;
}

async function fixMediaItem(id) {
    console.log(`\n🔍 Checking item ${id}...`);

    try {
        const { content: item, sha } = await getFileContent(`media/${id}.json`);
        let updated = false;

        // Check posterPath
        if (item.posterPath && item.posterPath.startsWith('assets/img/')) {
            const filename = item.posterPath.replace('assets/img/', '');
            console.log(`  📷 Found broken posterPath: ${item.posterPath}`);

            const repo = await findImageRepo(filename);
            if (repo) {
                item.posterPath = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${repo}/main/${filename}`;
                item.posterImageRepo = repo;
                console.log(`  ✅ Fixed posterPath: ${item.posterPath}`);
                updated = true;
            } else {
                console.log(`  ⚠️ Image file not found in any repo: ${filename}`);
            }
        }

        // Check bannerPath
        if (item.bannerPath && item.bannerPath.startsWith('assets/img/')) {
            const filename = item.bannerPath.replace('assets/img/', '');
            console.log(`  📷 Found broken bannerPath: ${item.bannerPath}`);

            const repo = await findImageRepo(filename);
            if (repo) {
                item.bannerPath = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${repo}/main/${filename}`;
                item.bannerImageRepo = repo;
                console.log(`  ✅ Fixed bannerPath: ${item.bannerPath}`);
                updated = true;
            } else {
                console.log(`  ⚠️ Image file not found in any repo: ${filename}`);
            }
        }

        if (updated) {
            const result = await updateFile(`media/${id}.json`, item, sha, `Fix broken image paths for ${id}`);
            if (result.statusCode === 200) {
                console.log(`  💾 Saved changes for ${id}`);
            } else {
                console.log(`  ❌ Failed to save: ${result.statusCode}`);
            }
        } else {
            console.log(`  ✓ No broken paths found`);
        }
    } catch (error) {
        console.error(`  ❌ Error: ${error.message}`);
    }
}

async function main() {
    console.log('🔧 Fixing broken image paths in mediatracker-data...\n');

    // Get all media items
    const { content: index } = await getFileContent('media/index.json');
    console.log(`Found ${index.length} items to check.`);

    for (const id of index) {
        await fixMediaItem(id);
    }

    console.log('\n✅ Done!');
}

main().catch(console.error);
