# Deploy Runbook

## Frontend (Vercel)
- Auto-deploys on push to `main` branch
- Domain: bonbox.dk
- Build: `cd frontend && npm run build`
- Typically live in ~1-2 minutes

## Backend (Render)
- Auto-deploys on push to `main` branch
- URL: bonbox-api.onrender.com
- Build: `pip install -r requirements.txt`
- Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Deploys take 3-5 minutes on free tier
- **No shell access** — migrations auto-run on startup

## Database (Supabase)
- No deploy needed — always running
- New columns added via auto-migration in main.py

## Keep-alive
- cron-job.org pings `/api/health` every 2 minutes
- UptimeRobot monitors uptime (checks every 5 min)

## Troubleshooting
- **"Invalid email or password" everywhere**: Missing DB column — check main.py _migrations
- **White screen in Nepal**: Stale service worker — user needs hard refresh (Ctrl+Shift+R)
- **Render sleeping**: Check cron-job.org is active
- **Rate limit (429)**: Registration limit is 15/min per IP
