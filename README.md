# AI Content Automation — Cloud (24/7)

Fully cloud-hosted, runs 24/7 without your PC being on.

| Component                | Service                  | Free? |
|--------------------------|--------------------------|:-----:|
| Node server              | Render free web service  | ✅ |
| Database                 | MongoDB Atlas M0         | ✅ |
| Image generation (primary)| Puppeteer → ChatGPT      | ✅ |
| Image generation (fallback)| Pollinations.ai         | ✅ |
| Captions                 | Groq (Llama 3.1)         | ✅ |
| Image hosting for Meta   | Cloudinary               | ✅ |
| Keep-alive               | UptimeRobot              | ✅ |
| **Total cost**           |                          | **₹0** |

## How the daily automation works

Every day at **9:00 AM IST**, the server runs `dailyCron.runDailyJob()`:

1. Reads every client from MongoDB.
2. For each client → finds today's calendar entry (or the next unfinished one).
3. Asks **Groq** to write an image-generation prompt from the entry's topic / goal / event.
4. Sends that prompt to **ChatGPT via headless Chrome** (Puppeteer). If that fails (cookie expired, captcha, etc.) it automatically falls back to **Pollinations.ai**.
5. Uploads the image to **Cloudinary**.
6. Asks Groq for caption + hashtags.
7. Matches the client name to their Meta page (`Manofox → Manofox Pvt.`, fuzzy match).
8. Schedules to Facebook + Instagram, 11 minutes in the future.
9. Marks the calendar entry as `done: true` and writes a `RunLog` entry.

You can also fire the cron manually:

```bash
curl -X POST https://your-app.onrender.com/cron/run-now \
     -H "x-admin-token: YOUR_ADMIN_TOKEN"
```

## Deployment guide

### Step 1 — MongoDB Atlas (5 min)

1. Sign up at <https://cloud.mongodb.com> (free, no card).
2. Create an **M0 (free forever)** cluster.
3. **Database Access** → add a user with password. Save the user/pass.
4. **Network Access** → allow `0.0.0.0/0` (so Render can reach it).
5. **Connect → Drivers → Node.js** → copy the connection string. It looks like:
   `mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/?retryWrites=true`
6. Append a database name: `…mongodb.net/aicontent?retryWrites=true`

### Step 2 — Push code to GitHub

```bash
cd project
git init
git add .
git commit -m "initial"
gh repo create ai-content-automation --public --source=. --push
# or: create the repo manually on github.com and `git remote add origin … && git push -u origin main`
```

### Step 3 — Render

1. Sign up at <https://render.com>.
2. **New + → Blueprint** → connect your GitHub repo.
3. Render reads `render.yaml` and creates the service automatically.
4. When asked, paste these env vars (Settings → Environment):
   - `ADMIN_TOKEN` — long random string, e.g. from `openssl rand -hex 32`
   - `MONGODB_URI` — from Step 1
   - `GROQ_API_KEY` — from <https://console.groq.com/keys>
   - `CLOUDINARY_*` — from <https://cloudinary.com> (3 values)
   - `META_ACCESS_TOKEN` — long-lived user token from Graph API Explorer
   - `IMAGE_FALLBACK_ENABLED=true`
5. Hit **Manual Deploy → Deploy latest commit**. Wait ~3 min.
6. Note the URL it gives you, e.g. `https://ai-content-automation.onrender.com`.

### Step 4 — Migrate your local data (optional)

If you already have local `clients.json`, `posts.json`, etc., set `MONGODB_URI` in your local `.env` then:

```bash
npm install
npm run migrate
```

### Step 5 — Upload your ChatGPT cookies

The server needs to log into chatgpt.com **as you**. Cookies do this.

1. Log into <https://chatgpt.com> on your normal browser.
2. Install **Cookie-Editor** extension:
   - Chrome: <https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm>
3. On chatgpt.com → click the extension → **Export → Export as JSON**.
4. Paste the JSON into a file called `cookies.json` inside the project folder.
5. Set in your local `.env`:
   ```
   SERVER_URL=https://your-app.onrender.com
   ADMIN_TOKEN=same-token-you-set-on-render
   ```
6. Upload:
   ```bash
   node tools/upload-cookies.js cookies.json
   ```
7. The tool will upload the cookies, then trigger a live test on the server. If it prints `loggedIn: true` you're done.

**You'll need to repeat Step 5 roughly every 1–3 weeks** when ChatGPT logs the server out. The Pollinations fallback covers that gap until you do.

### Step 6 — Keep-alive (so Render doesn't sleep)

1. Sign up at <https://uptimerobot.com> (free).
2. **+ Add New Monitor → HTTP(S)**.
3. URL: `https://your-app.onrender.com/health`
4. Interval: 5 minutes.
5. Save.

Render's free tier sleeps after 15 min of inactivity. UptimeRobot's ping every 5 min keeps it awake.

## Local development

```bash
cp .env.example .env
# fill in MONGODB_URI, GROQ_API_KEY, CLOUDINARY_*, META_ACCESS_TOKEN, ADMIN_TOKEN
npm install
npm run migrate   # only if you have old .json files to import
npm start
```

Then open <http://localhost:3000/dashboard.html>.

## REST API (admin)

All admin endpoints require header `x-admin-token: $ADMIN_TOKEN`.

| Method | Path                       | Purpose                                  |
| ------ | -------------------------- | ---------------------------------------- |
| POST   | `/chatgpt/cookies`         | Replace stored ChatGPT cookies           |
| GET    | `/chatgpt/test`            | Test if cookies still work               |
| GET    | `/chatgpt/status`          | Cookie count + last-updated timestamp    |
| POST   | `/cron/run-now`            | Trigger the daily cron immediately       |
| POST   | `/meta/refresh-pages`      | Force re-fetch all FB pages + IG IDs     |

Public:

| Method | Path                       | Purpose                                  |
| ------ | -------------------------- | ---------------------------------------- |
| GET    | `/health`                  | UptimeRobot ping target                  |
| GET    | `/events`                  | SSE stream (dashboard listens here)      |
| GET    | `/posts`, `/scheduled`, `/clients`, `/meta/pages` | Read-only views |
| POST   | `/save-prompt`, `/save-post`, `/generate-caption`, `/schedule-post` | Existing dashboard endpoints |

## Architecture

```
                         ┌──────────────────────────┐
                         │   node-cron, 09:00 IST   │
                         └────────────┬─────────────┘
                                      │ runDailyJob()
                                      ▼
       ┌──────────────────────────────────────────────────┐
       │  for each Client in MongoDB:                     │
       │    today's Calendar item  →  Groq image prompt   │
       │                            →  generateImage()    │
       │                                ├── Puppeteer ──► ChatGPT
       │                                └── Pollinations (fallback)
       │                            →  Cloudinary        │
       │                            →  Groq caption       │
       │                            →  findPageForClient()│
       │                            →  scheduleOnePost()  │
       │                                    │             │
       └────────────────────────────────────┼─────────────┘
                                            ▼
                          Facebook Page  +  Instagram Business
```

Dashboard at `/dashboard.html` is unchanged — it can still queue prompts, watch new posts via SSE, and trigger schedules manually. The Tampermonkey script continues to work too if you keep using your local machine.

## Troubleshooting

- **`/health` returns `"mongo": "down"`** — your `MONGODB_URI` is wrong, or Atlas IP allowlist doesn't include `0.0.0.0/0`.
- **Daily cron runs but every client says "no matching Meta page"** — the fuzzy matcher couldn't link the client name to a FB page. Check `/meta/pages` and rename clients so they share words with the page name.
- **Puppeteer keeps failing** — most likely cause is cookie expiry. Run `node tools/upload-cookies.js cookies.json` again. The Pollinations fallback runs in the meantime.
- **Render free instance OOM killed** — Puppeteer + Chromium is heavy. The server retries, and if Puppeteer fails twice it auto-switches to Pollinations-only for an hour (circuit breaker).
- **No image generated at all (both engines fail)** — check the RunLog collection in MongoDB Atlas → Browse Collections → `runlogs` for the per-client error.
