require("dotenv").config();
console.log("GROQ_API_KEY loaded:", !!process.env.GROQ_API_KEY);

const express    = require("express");
const cors       = require("cors");
const axios      = require("axios");
const cloudinary = require("cloudinary").v2;

const { connect } = require("./db/connect");

const {
    Client, Prompt, Post, Scheduled, Calendar,
    Session, MetaPage, RunLog
} = require("./db/models");

const {
    refreshMetaPages,
    getAllMetaPages,
    findPageForClient,
    scheduleOnePost,
    persistScheduleAttempt
} = require("./lib/meta");

const dailyCron      = require("./lib/dailyCron");
const puppeteerCG    = require("./lib/puppeteerChatGPT");
const { generateImage } = require("./lib/imageGen");

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();

app.use(cors());
app.use(express.json({ limit: "100mb" }));
app.use(express.static("public"));

/* ============================================================
   Mongo-required guard
============================================================ */

const { mongoose } = require("./db/connect");

function requireMongo(req, res, next) {

    if (mongoose.connection.readyState === 1) return next();

    res.status(503).json({
        error: "Database not connected. Check MONGODB_URI."
    });
}

/* ============================================================
   SSE
============================================================ */

const sseClients = new Set();

app.get("/events", (req, res) => {

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection",    "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    res.write(`event: connected\ndata: ${JSON.stringify({ok:true})}\n\n`);
    sseClients.add(res);

    const ping = setInterval(() => {
        try { res.write(`:ping\n\n`); } catch (_) {}
    }, 25000);

    req.on("close", () => {
        clearInterval(ping);
        sseClients.delete(res);
    });
});

function broadcast(eventName, payload) {

    const chunk =
        `event: ${eventName}\n` +
        `data: ${JSON.stringify(payload)}\n\n`;

    for (const res of sseClients) {
        try { res.write(chunk); } catch (_) {}
    }
}

/* ============================================================
   HEALTH
============================================================ */

app.get("/health", (req, res) => {

    res.json({
        ok:        true,
        uptime:    process.uptime(),
        mongo:     mongoose.connection.readyState === 1 ? "up" : "down",
        time:      new Date().toISOString()
    });
});

/* ============================================================
   CURRENT TASK (legacy Tampermonkey support)
============================================================ */

app.get("/current-task", requireMongo, async (req, res) => {

    try {

        const pending = await Prompt.findOne({ generated: false }).sort({ createdAt: 1 });

        if (!pending) return res.json(null);

        res.json({
            id:     pending._legacyId || pending._id,
            client: pending.client,
            prompt: pending.prompt
        });

    } catch (err) {

        console.log(err);
        res.json(null);
    }
});

app.post("/save-prompt", requireMongo, async (req, res) => {

    try {

        await Prompt.create({
            _legacyId: Date.now(),
            client:    req.body.client,
            prompt:    req.body.prompt,
            source:    req.body.source || "manual",
            generated: false
        });

        res.json({ success: true });

    } catch (err) {

        console.log(err);
        res.status(500).json({ success: false });
    }
});

/* ============================================================
   SAVE POST (Tampermonkey)
============================================================ */

async function handleSavePost(req, res) {

    try {

        const { image, prompt, client, source } = req.body;

        if (!image) {

            return res.status(400).json({
                success: false,
                error:   "image is required"
            });
        }

        let secureUrl = image;

        try {

            const upload = await cloudinary.uploader.upload(image, {
                folder: "ai-content"
            });
            secureUrl = upload.secure_url;
            console.log("Uploaded to Cloudinary:", secureUrl);

        } catch (uErr) {

            console.log("Cloudinary upload failed:", uErr.message);
        }

        const post = await Post.create({
            _legacyId:    Date.now(),
            client,
            prompt,
            image:        secureUrl,
            caption:      "",
            hashtags:     "",
            status:       "generated",
            scheduled:    false,
            source:       source || "tampermonkey"
        });

        await Prompt.updateMany(
            { client, prompt, generated: false },
            { $set: { generated: true, image: secureUrl } }
        );

        const payload = {
            id:        post._legacyId,
            client:    post.client,
            prompt:    post.prompt,
            image:     post.image,
            caption:   post.caption,
            hashtags:  post.hashtags,
            status:    post.status,
            createdAt: post.createdAt
        };

        broadcast("new-post", payload);

        console.log("✅ Image saved & broadcast:", secureUrl.slice(0, 80));

        res.json({ success: true, post: payload });

    } catch (err) {

        console.log(err);
        res.json({ success: false, error: err.message });
    }
}

app.post("/save-post",            requireMongo, handleSavePost);
app.post("/save-generated-image", requireMongo, handleSavePost);

/* ============================================================
   GENERATE CAPTION (dashboard)
============================================================ */

app.post("/generate-caption", requireMongo, async (req, res) => {

    try {

        const { prompt, client, id } = req.body;

        const groqPrompt = `
You are an expert luxury social media copywriter.

Brand:
${client || "—"}

Image prompt / description:
${prompt || "—"}

Return ONLY valid JSON:
{
 "caption":  "Catchy 2-3 sentence caption with 1-2 emojis and a clear CTA",
 "hashtags": "#tag1 #tag2 #tag3 #tag4 #tag5 #tag6 #tag7 #tag8"
}
`;

        const response = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                model: "llama-3.1-8b-instant",
                messages: [{ role: "user", content: groqPrompt }],
                temperature: 0.85,
                max_tokens: 600
            },
            {
                headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
            }
        );

        let raw   = response.data.choices[0].message.content;
        const s   = raw.indexOf("{");
        const e   = raw.lastIndexOf("}") + 1;

        if (s === -1 || e === 0) return res.json({ caption: "", hashtags: "" });

        raw = raw.substring(s, e).replace(/[\x00-\x1F\x7F]/g, " ").replace(/""/g, '"');

        let parsed;
        try { parsed = JSON.parse(raw); }
        catch {
            const cMatch = raw.match(/"caption"\s*:\s*"([^"]*)"/);
            const hMatch = raw.match(/"hashtags"\s*:\s*"([^"]*)"/);
            parsed = { caption: cMatch?.[1] || "", hashtags: hMatch?.[1] || "" };
        }

        if (id) {

            await Post.updateOne(
                { _legacyId: id },
                { $set: { caption: parsed.caption || "", hashtags: parsed.hashtags || "" } }
            );
        }

        res.json(parsed);

    } catch (err) {

        console.log("Caption error:", err.response?.data || err.message);
        res.json({ caption: "", hashtags: "" });
    }
});

/* ============================================================
   CLIENTS
============================================================ */

app.post("/save-client", requireMongo, async (req, res) => {

    try {

        await Client.create(req.body);
        res.json({ success: true });

    } catch (err) {

        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/clients", requireMongo, async (req, res) => {

    res.json(await Client.find().lean());
});

/* ============================================================
   GENERATE CALENDAR — resilient to Groq 429s + bad JSON
============================================================ */

app.post("/generate-calendar", requireMongo, async (req, res) => {

    try {

        const client = req.body;
        const today  = new Date().toISOString().split("T")[0];

        const prompt = `
Generate 30 day content calendar.

Brand:    ${client.name}
Industry: ${client.industry}
Tone:     ${client.tone}
Audience: ${client.audience}
Services: ${client.services}
Style:    ${client.style}
CTA:      ${client.cta}

Start from ${today}.

Return JSON Array ONLY. Do not add any commentary. Use this exact shape,
30 entries:

[ { "date":"YYYY-MM-DD", "event":"", "topic":"", "goal":"" } ]
`;

        let raw = null;
        let lastErr;

        for (let attempt = 1; attempt <= 4; attempt++) {

            try {

                const response = await axios.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    {
                        model:       "llama-3.1-8b-instant",
                        messages:    [{ role: "user", content: prompt }],
                        temperature: 0.7,
                        max_tokens:  3000
                    },
                    {
                        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
                        timeout: 60000
                    }
                );

                raw = response.data.choices[0].message.content || "";
                break;

            } catch (err) {

                lastErr = err;
                const status = err.response?.status;

                if (status === 429 && attempt < 4) {

                    const waitMs = 1500 * Math.pow(2, attempt);
                    console.log(`/generate-calendar: Groq 429, retrying in ${waitMs}ms`);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }

                break;
            }
        }

        if (!raw) {

            return res.status(503).json({
                error: "Groq rate-limited (429). Wait a minute and try again.",
                detail: lastErr?.response?.data || lastErr?.message
            });
        }

        const calendar = parseCalendarArray(raw);

        if (!calendar.length) {

            return res.status(502).json({
                error: "Groq returned an unparseable calendar. Try again."
            });
        }

        await Calendar.findOneAndUpdate(
            { client: client.name },
            { client: client.name, calendar },
            { upsert: true, new: true }
        );

        console.log(
            `📅 Saved calendar for "${client.name}" — ${calendar.length} items`
        );

        res.json(calendar);

    } catch (err) {

        console.log("/generate-calendar error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

function parseCalendarArray(raw) {

    let txt = String(raw).replace(/```json|```/g, "").trim();

    const start = txt.indexOf("[");
    const end   = txt.lastIndexOf("]") + 1;

    if (start >= 0 && end > 0) {

        const slice = txt.substring(start, end);

        try { return JSON.parse(slice); } catch (_) {}

        try {
            return JSON.parse(slice.replace(/[\x00-\x1F\x7F]/g, " "));
        } catch (_) {}
    }

    const out = [];
    const objRe = /\{[^{}]*\}/g;
    let m;
    while ((m = objRe.exec(txt)) !== null) {

        try {

            const obj = JSON.parse(
                m[0].replace(/[\x00-\x1F\x7F]/g, " ")
            );

            if (obj && (obj.date || obj.topic)) out.push(obj);

        } catch (_) {

            const o = {};
            const fieldRe = /"(\w+)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
            let f;
            while ((f = fieldRe.exec(m[0])) !== null) {
                o[f[1]] = f[2].replace(/\\n/g, "\n").replace(/\\"/g, '"');
            }

            if (o.date || o.topic) out.push(o);
        }
    }

    return out;
}

/* ============================================================
   PROMPT GENERATION (legacy)
============================================================ */

app.post("/generate-prompt", requireMongo, async (req, res) => {

    try {

        const { client, item } = req.body;

        const prompt = `
Create a luxury social media image generation prompt.

Brand:    ${client.name}
Industry: ${client.industry}
Tone:     ${client.tone}
Audience: ${client.audience}
Services: ${client.services}
Style:    ${client.style}
CTA:      ${client.cta}

Topic: ${item.topic}
Goal:  ${item.goal}
Event: ${item.event}

Return a highly detailed visual prompt for an AI image generator.
`;

        const response = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                model: "llama-3.1-8b-instant",
                messages: [{ role: "user", content: prompt }]
            },
            { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
        );

        res.json({ prompt: response.data.choices[0].message.content });

    } catch (err) {

        console.log(err.message);
        res.status(500).json({ error: true });
    }
});

/* ============================================================
   META PAGES
============================================================ */

app.get("/meta/pages", requireMongo, async (req, res) => {

    try {

        const pages = await getAllMetaPages();

        if (!pages.length) {

            try {

                const fresh = await refreshMetaPages();
                return res.json(fresh);

            } catch (refreshErr) {

                const m = refreshErr.response?.data?.error?.message ||
                          refreshErr.message;

                return res.json({
                    error: `META_ACCESS_TOKEN failed: ${m}. Refresh it from Graph API Explorer.`,
                    pages: []
                });
            }
        }

        res.json(pages);

    } catch (err) {

        console.log("/meta/pages error:", err.message);
        res.json({ error: err.message, pages: [] });
    }
});

app.post("/meta/refresh-pages", requireMongo, async (req, res) => {

    try {

        const pages = await refreshMetaPages();
        res.json({ success: true, count: pages.length });

    } catch (err) {

        res.json({ success: false, error: err.message });
    }
});

/* ============================================================
   POSTS
============================================================ */

app.get("/posts", requireMongo, async (req, res) => {

    const posts = await Post.find().sort({ createdAt: -1 }).limit(100).lean();

    res.json(posts.map(p => ({
        id:           p._legacyId || p._id.toString(),
        client:       p.client,
        prompt:       p.prompt,
        image:        p.image,
        caption:      p.caption,
        hashtags:     p.hashtags,
        status:       p.status,
        scheduled:    p.scheduled,
        scheduleTime: p.scheduleTime,
        source:       p.source,
        createdAt:    p.createdAt
    })));
});

app.get("/scheduled", requireMongo, async (req, res) => {

    res.json(await Scheduled.find().sort({ createdAt: -1 }).limit(200).lean());
});

/* ============================================================
   SCHEDULE-POST
============================================================ */

const inFlightPosts = new Set();

app.post("/schedule-post", requireMongo, async (req, res) => {

    try {

        let { postId, scheduleTime, targets } = req.body;

        console.log("\n📅 /schedule-post —", { postId, scheduleTime });

        if (!postId)       return res.json({ success: false, error: "postId required" });
        if (!scheduleTime) scheduleTime = new Date(Date.now() + 11 * 60 * 1000);

        if (inFlightPosts.has(String(postId))) {

            return res.json({
                success: false,
                error:   "Already scheduling this post — wait for it to finish."
            });
        }

        const post = await Post.findOne({ _legacyId: postId });

        if (!post)        return res.json({ success: false, error: "Post not found" });
        if (!post.image)  return res.json({ success: false, error: "Post has no image" });

        if (post.scheduled === true) {

            return res.json({
                success: false,
                error:   "Post is already scheduled."
            });
        }

        inFlightPosts.add(String(postId));

        let realTargets = [];

        if (Array.isArray(targets) && targets.length) {

            const isStringForm = targets.every(t => typeof t === "string");

            if (isStringForm) {

                const pages = await getAllMetaPages();
                realTargets = pages;

            } else {

                realTargets = targets.filter(t =>
                    t && t.pageAccessToken && (t.pageId || t.instagramId)
                );
            }
        }

        if (!realTargets.length) {

            inFlightPosts.delete(String(postId));

            return res.json({
                success: false,
                error: "No valid targets provided. Tick a page tile and retry."
            });
        }

        console.log("Resolved targets:", realTargets.map(t => t.pageName));

        const minSchedule = Math.floor((Date.now() + 11 * 60 * 1000) / 1000);
        let unixTime = Math.floor(new Date(scheduleTime).getTime() / 1000);
        if (!unixTime || isNaN(unixTime) || unixTime < minSchedule) {
            unixTime = minSchedule;
        }

        const results = [];

        for (const target of realTargets) {

            const result = await scheduleOnePost(post, target, unixTime);
            results.push(result);
            await persistScheduleAttempt(post, target, result, unixTime);
        }

        post.status       = "scheduled";
        post.scheduled    = true;
        post.scheduleTime = new Date(unixTime * 1000).toISOString();
        await post.save();

        broadcast("post-scheduled", { postId, results });

        inFlightPosts.delete(String(postId));

        const anyOK = results.some(r => r.fb || r.ig);

        res.json({
            success: anyOK,
            results,
            error: anyOK ? null : results.map(r => r.errors.join(" | ")).join(" || ")
        });

    } catch (error) {

        try { inFlightPosts.delete(String(req.body?.postId)); } catch (_) {}

        console.log("/schedule-post fatal:", error.response?.data || error.message);

        res.json({
            success: false,
            error:   error.response?.data || error.message
        });
    }
});

/* ============================================================
   COOKIES / DIAGNOSTICS / MANUAL CRON
============================================================ */

const COOKIE_AUTH = process.env.ADMIN_TOKEN || "change-me";

function requireAdmin(req, res, next) {

    const t = req.headers["x-admin-token"] || req.query.token;

    if (t !== COOKIE_AUTH) {

        return res.status(403).json({ error: "forbidden" });
    }

    next();
}

app.post("/chatgpt/cookies", requireMongo, requireAdmin, async (req, res) => {

    try {

        const { cookies } = req.body;

        if (!Array.isArray(cookies) || !cookies.length) {

            return res.json({ success: false, error: "cookies must be a non-empty array" });
        }

        await Session.findOneAndUpdate(
            { name: "chatgpt" },
            { cookies, updatedAt: new Date() },
            { upsert: true }
        );

        res.json({ success: true, count: cookies.length });

    } catch (err) {

        res.json({ success: false, error: err.message });
    }
});

app.get("/chatgpt/test", requireAdmin, async (req, res) => {

    try {

        const result = await puppeteerCG.testLogin();

        // New return shape: { loggedIn, detail } — pass through
        if (result && typeof result === "object" && "loggedIn" in result) {

            res.json({
                success:  true,
                loggedIn: result.loggedIn,
                detail:   result.detail
            });

        } else {

            // Old shape (just a boolean) — keep compat
            res.json({ success: true, loggedIn: !!result });
        }

    } catch (err) {

        res.json({ success: false, error: err.message });
    }
});

app.get("/chatgpt/diag", async (req, res) => {

    try {

        const d = await puppeteerCG.diagnose();
        res.json(d);

    } catch (err) {

        res.json({ error: err.message });
    }
});

app.get("/chatgpt/status", requireMongo, async (req, res) => {

    const sess = await Session.findOne({ name: "chatgpt" }).lean();

    res.json({
        cookiesStored: !!sess?.cookies?.length,
        cookieCount:   sess?.cookies?.length || 0,
        updatedAt:     sess?.updatedAt || null
    });
});

app.post("/cron/run-now", requireAdmin, async (req, res) => {

    res.json({ success: true, message: "Started in background." });
    dailyCron.runDailyJob().catch(e => console.log("manual cron fail:", e));
});

/* ============================================================
   /generate-and-schedule  — full pipeline for one client
============================================================ */

const runningJobs = new Set();

app.post("/generate-and-schedule", requireMongo, async (req, res) => {

    const { clientName, item } = req.body || {};

    if (!clientName) {

        return res.json({ success: false, error: "clientName required" });
    }

    if (runningJobs.has(clientName)) {

        return res.json({
            success: false,
            error:   "Already running a job for this client — wait for it to finish."
        });
    }

    runningJobs.add(clientName);

    try {

        const client = await Client.findOne({ name: clientName }).lean();

        if (!client) {

            return res.json({
                success: false,
                error: `Client "${clientName}" not found.`
            });
        }

        const pages = await getAllMetaPages();

        if (!pages.length) {

            return res.json({
                success: false,
                error:
                    "No Meta pages available. Check META_ACCESS_TOKEN " +
                    "(it may have expired — refresh from Graph API Explorer)."
            });
        }

        const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
                        .toISOString().slice(0, 10);

        const log = await dailyCron.runForClient(
            client, today, pages, { item }
        );

        broadcast("pipeline-done", log);

        res.json({
            success: log.status === "scheduled",
            log
        });

    } catch (err) {

        console.log("/generate-and-schedule error:", err.response?.data || err.message);
        res.json({ success: false, error: err.message });

    } finally {

        runningJobs.delete(clientName);
    }
});

/* ============================================================
   /generate-all-now
============================================================ */

let allRunInProgress = false;

app.post("/generate-all-now", requireMongo, async (req, res) => {

    if (allRunInProgress) {

        return res.json({
            success: false,
            error:   "An all-clients run is already in progress."
        });
    }

    allRunInProgress = true;

    res.json({ success: true, message: "Started in background. Watch the logs." });

    (async () => {

        try {

            await dailyCron.runDailyJob({
                onProgress: log => broadcast("pipeline-done", log)
            });

            broadcast("pipeline-done", {
                client: "—",
                status: "all-done",
                reason: "Morning run finished for all clients."
            });

        } catch (err) {

            console.log("generate-all-now error:", err.message);

        } finally {

            allRunInProgress = false;
        }
    })();
});

/* ============================================================
   /calendar/:client
============================================================ */

app.get("/calendar/:client", requireMongo, async (req, res) => {

    try {

        const cal = await Calendar.findOne({
            client: req.params.client
        }).lean();

        if (!cal) return res.json({ calendar: [] });

        res.json({ calendar: cal.calendar || [] });

    } catch (err) {

        res.json({ calendar: [], error: err.message });
    }
});

/* ============================================================
   /save (legacy)
============================================================ */

app.post("/save", requireMongo, handleSavePost);

/* ============================================================
   BOOT
============================================================ */

(async function boot() {

    try {

        await connect();
        dailyCron.start();

    } catch (err) {

        console.log("Boot warning:", err.message);
    }

    const PORT = process.env.PORT || 3000;

    app.listen(PORT, () => console.log(
        `\n🚀 Server running on http://localhost:${PORT}\n` +
        `   Dashboard:  http://localhost:${PORT}/dashboard.html\n` +
        `   SSE stream: http://localhost:${PORT}/events\n` +
        `   Health:     http://localhost:${PORT}/health\n`
    ));

})();

process.on("SIGTERM", async () => {

    console.log("SIGTERM — shutting down…");
    try { await puppeteerCG.shutdown(); } catch (_) {}
    process.exit(0);
});