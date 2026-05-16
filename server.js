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
   Mongo-required guard — for routes that need a live DB.
   /health and static files skip this so UptimeRobot can still
   ping us even if Atlas is sleeping.
============================================================ */

const { mongoose } = require("./db/connect");

function requireMongo(req, res, next) {

    if (mongoose.connection.readyState === 1) return next();

    res.status(503).json({
        error: "Database not connected. Check MONGODB_URI."
    });
}

/* ============================================================
   SSE — REAL-TIME PUSH TO DASHBOARD
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
   HEALTH — pinged by UptimeRobot every 14 min to keep
   the Render free instance from sleeping.
============================================================ */

app.get("/health", (req, res) => {

    const { mongoose } = require("./db/connect");

    res.json({
        ok:        true,
        uptime:    process.uptime(),
        mongo:     mongoose.connection.readyState === 1 ? "up" : "down",
        time:      new Date().toISOString()
    });
});

/* ============================================================
   CURRENT TASK  — Tampermonkey (local) still polls this
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

/* ============================================================
   SAVE PROMPT
============================================================ */

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
   SAVE POST — Tampermonkey OR Puppeteer-generated image
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

        /* ---------- Upload to Cloudinary ---------- */

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

        /* ---------- Save Post ---------- */

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

        /* ---------- Mark Prompt as done ---------- */

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

        console.log(
            "✅ Image saved & broadcast:",
            secureUrl.slice(0, 80)
        );

        res.json({ success: true, post: payload });

    } catch (err) {

        console.log(err);
        res.json({ success: false, error: err.message });
    }
}

app.post("/save-post",            requireMongo, handleSavePost);
app.post("/save-generated-image", requireMongo, handleSavePost);

/* ============================================================
   GENERATE CAPTION
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
   CONTENT CALENDAR
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

Return JSON Array ONLY:

[ { "date":"YYYY-MM-DD", "event":"", "topic":"", "goal":"" } ]
`;

        const response = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                model: "llama-3.1-8b-instant",
                messages: [{ role: "user", content: prompt }]
            },
            { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
        );

        let raw = response.data.choices[0].message.content;
        raw = raw.substring(raw.indexOf("["), raw.lastIndexOf("]") + 1);
        const calendar = JSON.parse(raw);

        await Calendar.findOneAndUpdate(
            { client: client.name },
            { client: client.name, calendar },
            { upsert: true, new: true }
        );

        res.json(calendar);

    } catch (err) {

        console.log(err.message);
        res.status(500).json({ error: true });
    }
});

/* ============================================================
   PROMPT GENERATION
============================================================ */

app.post("/generate-prompt", async (req, res) => {

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
   META PAGES — used by dashboard target tiles
============================================================ */

app.get("/meta/pages", requireMongo, async (req, res) => {

    try {

        const pages = await getAllMetaPages();
        res.json(pages);

    } catch (err) {

        console.log("/meta/pages error:", err.message);
        res.json([]);
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

/* ============================================================
   SCHEDULED
============================================================ */

app.get("/scheduled", requireMongo, async (req, res) => {

    res.json(await Scheduled.find().sort({ createdAt: -1 }).limit(200).lean());
});

/* ============================================================
   SCHEDULE-POST — main dashboard endpoint
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

        /* ---------- Resolve targets ---------- */

        let realTargets = [];

        if (Array.isArray(targets) && targets.length) {

            const isStringForm = targets.every(t => typeof t === "string");

            if (isStringForm) {

                const pages = await getAllMetaPages();
                realTargets = pages;
                // dashboard tile-string form would only happen for unscoped tests

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

        console.log(
            "Resolved targets:",
            realTargets.map(t => t.pageName)
        );

        /* ---------- Calculate schedule unix ---------- */

        const minSchedule = Math.floor((Date.now() + 11 * 60 * 1000) / 1000);

        let unixTime = Math.floor(new Date(scheduleTime).getTime() / 1000);

        if (!unixTime || isNaN(unixTime) || unixTime < minSchedule) {

            unixTime = minSchedule;
        }

        /* ---------- Loop ---------- */

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
   CHATGPT COOKIE MGMT  — upload, verify, view
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

        const ok = await puppeteerCG.testLogin();
        res.json({ success: true, loggedIn: ok });

    } catch (err) {

        res.json({ success: false, error: err.message });
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

/* ============================================================
   MANUAL CRON TRIGGER  — useful for testing
============================================================ */

app.post("/cron/run-now", requireAdmin, async (req, res) => {

    res.json({ success: true, message: "Started in background." });

    dailyCron.runDailyJob().catch(e => console.log("manual cron fail:", e));
});

/* ============================================================
   /save  — backward compatibility (Tampermonkey old version)
============================================================ */

app.post("/save", requireMongo, handleSavePost);

/* ============================================================
   BOOT  — connect Mongo, then start cron, then listen
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
