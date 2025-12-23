# Deploy MediaTracker to Render

## Prerequisites
1. GitHub account with your code pushed to a repository
2. GitHub Personal Access Token with `repo` scope
3. Created GitHub repositories for data storage:
   - `mediatracker-data` (for JSON data)
   - `mediatracker-images-1` (for images)

## Step 1: Create GitHub Repositories

1. Go to [github.com/new](https://github.com/new)
2. Create repository: `mediatracker-data` (can be private)
3. Create repository: `mediatracker-images-1` (can be private)

## Step 2: Generate GitHub Token

1. Go to [GitHub Settings → Developer Settings → Personal Access Tokens → Tokens (classic)](https://github.com/settings/tokens)
2. Click "Generate new token (classic)"
3. Name: `MediaTracker Storage`
4. Select scope: `repo` (full access)
5. Click "Generate token"
6. **Copy the token** (you won't see it again!)

## Step 3: Deploy to Render

1. Go to [render.com](https://render.com) and sign up/login
2. Click **New** → **Web Service**
3. Connect your GitHub repository
4. Render will auto-detect the `render.yaml` config
5. Add environment variables:
   - `GITHUB_TOKEN` = your token from Step 2
   - `GITHUB_OWNER` = your GitHub username
6. Click **Create Web Service**

## Step 4: Access Your Site

After deployment (2-3 minutes), your site will be live at:
```
https://mediatracker-xxxx.onrender.com
```

## Notes

- **Free tier spin-down**: Render free tier spins down after 15 min of inactivity. First request after that takes ~30 seconds.
- **Custom domain**: You can add a custom domain in Render dashboard.
- **Updates**: Push to GitHub and Render auto-deploys.
