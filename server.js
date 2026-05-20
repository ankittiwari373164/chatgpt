require("dotenv").config();
console.log("GROQ_API_KEY loaded:", !!process.env.GROQ_API_KEY);

const express    = require("express");
const cors       = require("cors");
const axios      = require("axios");
const cloudinary = require("cloudinary").v2;

const { connect } = require("./db/connect");

const {
    Client, Prompt, Post, Scheduled, Calendar,
    Session, MetaPage, RunLog, Log
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

const { composeBrandedImage } = require("./lib/composer");

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

async function requireMongo(req, res, next) {

    if (mongoose.connection.readyState === 1) return next();

    /* If Atlas dropped the connection while the server was idle,
       Mongoose's autoReconnect will bring it back within a few
       seconds. Wait for that instead of erroring out instantly. */

    const start = Date.now();
    const WAIT_MS = 8000;

    while (Date.now() - start < WAIT_MS) {

        await new Promise(r => setTimeout(r, 250));
        if (mongoose.connection.readyState === 1) return next();
    }

    res.status(503).json({
        error:      "Database not connected. Check MONGODB_URI.",
        readyState: mongoose.connection.readyState
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

    // Auto-persist meaningful events to the Log collection so they
    // survive page refreshes.
    if (eventName === "pipeline-done" && payload && mongoose.connection.readyState === 1) {

        const level =
            payload.status === "scheduled" ? "ok"
          : payload.status === "queued"    ? "info"
          : payload.status === "failed" ||
            payload.status === "error"     ? "err"
          : "warn";

        const parts = [
            (level === "ok"   ? "✅"
            : level === "info" ? "📨"
            : level === "err"  ? "❌"
            : "⏭"),
            payload.client || "system",
            "—",
            payload.status,
            payload.reason ? "— " + payload.reason : "",
            payload.page   ? "→ " + payload.page   : "",
            payload.imageSource ? "[" + payload.imageSource + "]" : ""
        ].filter(Boolean).join(" ");

        Log.create({ level, message: parts.slice(0, 4000), at: new Date() })
            .catch(() => {});
    }
}

/* ============================================================
   HEALTH — pinged by UptimeRobot every 14 min to keep
   the Render free instance from sleeping.
============================================================ */

app.get("/health", (req, res) => {

    const { mongoose, connect: dbConnect } = require("./db/connect");

    const states = {
        0: "disconnected",
        1: "connected",
        2: "connecting",
        3: "disconnecting",
        99: "uninitialized"
    };

    const state = mongoose.connection.readyState;
    const stateName = states[state] || "unknown";

    // If we're not connected, kick off a reconnect attempt
    if (state !== 1 && state !== 2) {

        dbConnect().catch(() => {});
    }

    res.json({
        ok:        true,
        uptime:    process.uptime(),
        mongo:     stateName,
        mongoCode: state,
        time:      new Date().toISOString()
    });
});

/* ============================================================
   CURRENT TASK  — Tampermonkey (local) still polls this
============================================================ */

app.get("/current-task", requireMongo, async (req, res) => {

    try {

        const LOCK_MS = 5 * 60 * 1000; // a Tampermonkey worker gets 5 min per task
        const expiry  = new Date(Date.now() - LOCK_MS);

        // Find one that's either never been claimed OR whose claim has expired,
        // AND atomically mark it claimed in the SAME query. This prevents two
        // pollers from picking up the same task.
        const claimed = await Prompt.findOneAndUpdate(
            {
                generated: false,
                $or: [
                    { claimedAt: null },
                    { claimedAt: { $lt: expiry } }
                ]
            },
            {
                $set: { claimedAt: new Date() },
                $inc: { attempts: 1 }
            },
            {
                sort: { createdAt: 1 },
                new:  true            // return the updated doc
            }
        );

        if (!claimed) return res.json(null);

        res.json({
            id:     claimed._legacyId || claimed._id,
            client: claimed.client,
            prompt: claimed.prompt
        });

    } catch (err) {

        console.log("/current-task error:", err.message);
        res.json(null);
    }
});

/* ============================================================
   /task/:id/fail  — Tampermonkey calls this if it can't
   complete the task, so the lock releases immediately instead
   of waiting for the 5-min timeout.
============================================================ */

app.post("/task/:id/fail", requireMongo, async (req, res) => {

    try {

        const id = Number(req.params.id) || req.params.id;

        await Prompt.updateOne(
            { _legacyId: id, generated: false },
            { $set: { claimedAt: null } }
        );

        res.json({ ok: true });

    } catch (err) {

        res.json({ ok: false, error: err.message });
    }
});

/* ============================================================
   /prompts/queued — list all not-yet-generated prompts
   /prompts/:id    — DELETE one queued prompt
============================================================ */

app.get("/prompts/queued", requireMongo, async (req, res) => {

    try {

        const items = await Prompt.find({ generated: false })
            .sort({ createdAt: 1 })
            .lean();

        res.json(items.map(p => {

            let cronInfo = null;
            if (p.error) {
                try {
                    const parsed = JSON.parse(p.error);
                    if (parsed.cronContext) {
                        cronInfo = {
                            page:  parsed.cronContext.pageName,
                            topic: parsed.cronContext.itemTopic,
                            date:  parsed.cronContext.itemDate
                        };
                    }
                } catch (_) {}
            }

            return {
                id:        p._legacyId || p._id,
                client:    p.client,
                prompt:    p.prompt,
                source:    p.source,
                attempts:  p.attempts || 0,
                claimedAt: p.claimedAt,
                createdAt: p.createdAt,
                cronInfo
            };
        }));

    } catch (err) {

        res.json([]);
    }
});

app.delete("/prompts/:id", requireMongo, async (req, res) => {

    try {

        const id = req.params.id;
        const numeric = Number(id);

        const result = await Prompt.deleteOne(
            Number.isFinite(numeric)
                ? { _legacyId: numeric }
                : { _id: id }
        );

        res.json({ success: true, deleted: result.deletedCount });

    } catch (err) {

        res.json({ success: false, error: err.message });
    }
});

app.post("/prompts/clear-all", requireMongo, async (req, res) => {

    try {

        const r = await Prompt.deleteMany({ generated: false });
        res.json({ success: true, deleted: r.deletedCount });

    } catch (err) {

        res.json({ success: false, error: err.message });
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

        /* ---------- Look up the client's brand assets ---------- */

        let logoUrl   = "";
        let footerUrl = "";

        if (client) {
            try {
                const c = await Client.findOne({ name: client }).lean();
                logoUrl   = c?.logoUrl   || "";
                footerUrl = c?.footerUrl || "";
            } catch (_) {}
        }

        /* ---------- Composite logo + footer onto the image ---------- */

        let imageToUpload = image;

        if (logoUrl || footerUrl) {

            try {

                console.log(
                    `🎨 Compositing brand assets onto image for "${client}" ` +
                    `(logo=${!!logoUrl}, footer=${!!footerUrl})`
                );

                imageToUpload = await composeBrandedImage({
                    baseImage: image,
                    logoUrl,
                    footerUrl
                });

            } catch (e) {

                console.log("Composite failed, using original image:", e.message);
                imageToUpload = image;
            }
        }

        /* ---------- Upload to Cloudinary ---------- */

        let secureUrl = imageToUpload;

        try {

            const upload = await cloudinary.uploader.upload(imageToUpload, {
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

        /* ---------- Mark Prompt as done + capture cron context ---------- */

        // Find a matching un-generated prompt and pull its cronContext (if any)
        // BEFORE marking it generated, so we know whether the cron triggered it.

        const queuedPrompt = await Prompt.findOne({
            client, prompt, generated: false
        }).lean();

        let cronContext = null;
        if (queuedPrompt?.error) {

            try {

                const parsed = JSON.parse(queuedPrompt.error);
                cronContext = parsed.cronContext || null;

            } catch (_) {}
        }

        await Prompt.updateMany(
            { client, prompt, generated: false },
            { $set: {
                generated: true,
                image:     secureUrl,
                // Clear the cronContext stash so we don't reprocess later
                error:     ""
            }}
        );

        const payload = {
            id:            post._legacyId,
            client:        post.client,
            prompt:        post.prompt,
            image:         post.image,
            caption:       post.caption,
            hashtags:      post.hashtags,
            status:        post.status,
            createdAt:     post.createdAt,
            // Tell the dashboard the server already owns the rest of the pipeline.
            // Dashboard SSE handler must check this and skip auto-scheduling.
            autoScheduled: !!cronContext
        };

        broadcast("new-post", payload);

        console.log(
            "✅ Image saved & broadcast:",
            secureUrl.slice(0, 80)
        );

        /* ---------- Cron-triggered? Auto-caption + auto-schedule ---------- */

        if (cronContext) {

            console.log(
                `🤖 Image came from cron-queued prompt — auto-running ` +
                `caption + Meta scheduling for ${client}…`
            );

            // Don't block the HTTP response on this — kick it off async.
            (async () => {

                try {

                    await autoCaptionAndSchedule(post, cronContext);

                } catch (e) {

                    console.log("auto-pipeline error:", e.message);
                    broadcast("pipeline-done", {
                        client,
                        status: "failed",
                        reason: "Auto caption/schedule failed: " + e.message
                    });
                }
            })();
        }

        res.json({ success: true, post: payload });

    } catch (err) {

        console.log(err);
        res.json({ success: false, error: err.message });
    }
}

/* ============================================================
   Auto-pipeline: when Tampermonkey delivers a cron-queued image,
   complete the rest of the cron job (caption + Meta scheduling).
============================================================ */

/* Module-level dedup: once a post has been auto-scheduled we never do it again */
const autoScheduledPostIds = new Set();

async function autoCaptionAndSchedule(post, ctx) {

    const postKey = String(post._legacyId || post._id);

    if (autoScheduledPostIds.has(postKey)) {
        console.log(`⏭ autoCaptionAndSchedule: already done for post ${postKey}`);
        return;
    }

    autoScheduledPostIds.add(postKey);

    // Also guard against double-firing across server restarts:
    // if the Post already has status "scheduled", bail.
    if (post.scheduled || post.status === "scheduled") {
        console.log(`⏭ autoCaptionAndSchedule: post ${postKey} already scheduled`);
        return;
    }

    /* 1. Get the client details */

    const client = await Client.findOne({ name: post.client }).lean();

    if (!client) {

        broadcast("pipeline-done", {
            client: post.client,
            status: "failed",
            reason: "Client not found in DB after image arrived."
        });
        return;
    }

    /* 2. Generate caption */

    let caption = "", hashtags = "";

    try {

        const cap = await dailyCron.buildCaption(
            client,
            { date: ctx.itemDate, topic: ctx.itemTopic },
            post.prompt
        );

        caption  = cap.caption  || "";
        hashtags = cap.hashtags || "";

        post.caption  = caption;
        post.hashtags = hashtags;
        await post.save();

    } catch (e) {

        console.log("caption generation failed:", e.message);
    }

    /* 3. Schedule to Meta */

    const target = {
        pageId:          ctx.pageId,
        pageName:        ctx.pageName,
        pageAccessToken: ctx.pageAccessToken,
        instagramId:     ctx.instagramId
    };

    const unixTime = Math.floor((Date.now() + 11 * 60 * 1000) / 1000);

    const result = await scheduleOnePost(post, target, unixTime);

    await persistScheduleAttempt(post, target, result, unixTime);

    if (result.fb || result.ig) {

        post.status       = "scheduled";
        post.scheduled    = true;
        post.scheduleTime = new Date(unixTime * 1000).toISOString();
        await post.save();

        /* Mark calendar item as done */

        const cal = await Calendar.findOne({ client: client.name });

        if (cal?.calendar?.length) {

            const item = cal.calendar.find(x =>
                x.topic === ctx.itemTopic &&
                (x.date || "").slice(0, 10) === (ctx.itemDate || "").slice(0, 10)
            );

            if (item) {
                item.done = true;
                cal.markModified("calendar");
                await cal.save();
            }
        }

        broadcast("pipeline-done", {
            client:      client.name,
            status:      "scheduled",
            page:        ctx.pageName,
            imageSource: "tampermonkey",
            fb:          result.fb,
            ig:          result.ig
        });

        console.log(
            `✅ ${client.name}: scheduled → ${ctx.pageName} [via tampermonkey]`
        );

    } else {

        broadcast("pipeline-done", {
            client:      client.name,
            status:      "failed",
            page:        ctx.pageName,
            imageSource: "tampermonkey",
            errors:      result.errors
        });
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

        const b = req.body || {};
        const name = (b.name || "").trim();

        if (!name) {
            return res.status(400).json({ success: false, error: "name required" });
        }

        /* ---------- Helper: upload a data URL to Cloudinary ---------- */

        async function uploadDataUrl(dataUrl, label) {

            if (!dataUrl || typeof dataUrl !== "string") return null;
            if (!dataUrl.startsWith("data:")) return null; // not an upload payload

            if (!process.env.CLOUDINARY_CLOUD_NAME) {
                throw new Error("Cloudinary is not configured on the server.");
            }

            const r = await cloudinary.uploader.upload(dataUrl, {
                folder:    "ai-content/clients/" + name.replace(/[^a-z0-9_-]/gi, "_"),
                public_id: label + "-" + Date.now(),
                overwrite: true
            });

            if (!r || !r.secure_url) {
                console.log(`Cloudinary returned no secure_url for ${label}:`, r);
                throw new Error("Cloudinary upload returned no URL");
            }

            console.log(`☁ ${label} uploaded → ${r.secure_url} (${r.width}x${r.height}, ${r.bytes} bytes)`);
            return r.secure_url;
        }

        /* ---------- Build the update document ---------- */

        const fields = {
            name,
            industry:  b.industry  || "",
            tone:      b.tone      || "",
            audience:  b.audience  || "",
            services:  b.services  || "",
            style:     b.style     || "",
            cta:       b.cta       || ""
        };

        /* Logo */

        if (b.logoDataUrl) {

            try {
                const url = await uploadDataUrl(b.logoDataUrl, "logo");
                if (url) fields.logoUrl = url;
            } catch (e) {
                return res.status(400).json({
                    success: false,
                    error:   "Logo upload failed: " + e.message
                });
            }

        } else if (typeof b.logoUrl === "string") {

            // Allow plain URL too (for backward compatibility or if user pastes one)
            fields.logoUrl = b.logoUrl.trim();
        }

        /* Footer */

        if (b.footerDataUrl) {

            try {
                const url = await uploadDataUrl(b.footerDataUrl, "footer");
                if (url) fields.footerUrl = url;
            } catch (e) {
                return res.status(400).json({
                    success: false,
                    error:   "Footer upload failed: " + e.message
                });
            }

        } else if (typeof b.footerUrl === "string") {

            fields.footerUrl = b.footerUrl.trim();
        }

        /* ---------- Special clears: "REMOVE" sentinel deletes the field ---------- */

        if (b.logoUrl === "__REMOVE__")   fields.logoUrl   = "";
        if (b.footerUrl === "__REMOVE__") fields.footerUrl = "";

        /* ---------- Upsert ---------- */

        const doc = await Client.findOneAndUpdate(
            { name },
            { $set: fields },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        res.json({ success: true, client: doc });

    } catch (err) {

        console.log("/save-client error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/clients", requireMongo, async (req, res) => {

    res.json(await Client.find().lean());
});

/* ============================================================
   DELETE a client (also cleans up its calendar)
============================================================ */

app.delete("/clients/:name", requireMongo, async (req, res) => {

    try {

        const name = req.params.name;

        const r1 = await Client.deleteOne({ name });
        const r2 = await Calendar.deleteMany({ client: name });

        broadcast("client-deleted", { name });

        res.json({
            success:        true,
            client:         r1.deletedCount,
            calendarsWiped: r2.deletedCount
        });

    } catch (err) {

        res.json({ success: false, error: err.message });
    }
});

/* ============================================================
   PERSISTENT DASHBOARD LOGS
   Logs survive page refreshes and Render restarts.
============================================================ */

app.get("/logs", requireMongo, async (req, res) => {

    try {

        const limit = Math.min(parseInt(req.query.limit) || 300, 1000);

        const logs = await Log.find()
            .sort({ at: -1 })
            .limit(limit)
            .lean();

        // Return chronologically (oldest first) so the dashboard
        // can append them in natural order.
        res.json(logs.reverse());

    } catch (err) {

        res.json([]);
    }
});

app.post("/logs", requireMongo, async (req, res) => {

    try {

        const { message, level } = req.body || {};
        if (!message) return res.json({ success: false, error: "message required" });

        const doc = await Log.create({
            level:   level || "info",
            message: String(message).slice(0, 4000),
            at:      new Date()
        });

        broadcast("log", {
            at:      doc.at,
            level:   doc.level,
            message: doc.message
        });

        res.json({ success: true });

    } catch (err) {

        res.json({ success: false, error: err.message });
    }
});

app.post("/logs/clear", requireMongo, async (req, res) => {

    try {

        const r = await Log.deleteMany({});
        res.json({ success: true, deleted: r.deletedCount });

    } catch (err) {

        res.json({ success: false, error: err.message });
    }
});

/* Helper that any server code can call to persist a log line */

async function persistLog(message, level = "info") {

    try {

        const doc = await Log.create({
            level,
            message: String(message).slice(0, 4000),
            at:      new Date()
        });

        broadcast("log", {
            at:      doc.at,
            level:   doc.level,
            message: doc.message
        });

    } catch (_) {}
}

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

Return JSON Array ONLY. Do not add any commentary. Use this exact shape,
30 entries:

[ { "date":"YYYY-MM-DD", "event":"", "topic":"", "goal":"" } ]
`;

        let raw = null;
        let lastErr;
        let lastStatus;

        for (let attempt = 1; attempt <= 6; attempt++) {

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

                lastErr    = err;
                lastStatus = err.response?.status;

                if (lastStatus === 429 && attempt < 6) {

                    // Honor Retry-After header from Groq if present;
                    // otherwise back off exponentially up to ~30 sec.
                    const headerRetry = parseFloat(err.response?.headers?.["retry-after"]) || 0;
                    const baseWait    = 2000 * Math.pow(2, attempt - 1);
                    const waitMs      = Math.min(
                        Math.max(headerRetry * 1000, baseWait),
                        30000
                    );

                    console.log(
                        `/generate-calendar: Groq 429, retrying in ${waitMs}ms (attempt ${attempt}/6)`
                    );
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }

                break;
            }
        }

        if (!raw) {

            // Surface Groq's actual error so the user knows it's not Mongo
            const groqMsg =
                lastErr?.response?.data?.error?.message ||
                lastErr?.message ||
                "Unknown Groq error";

            if (lastStatus === 429) {

                return res.status(429).json({
                    error: "Groq rate-limit reached. Wait 30-60 seconds and click again.",
                    detail: groqMsg,
                    source: "groq"
                });
            }

            if (lastStatus === 401 || lastStatus === 403) {

                return res.status(401).json({
                    error: "Groq API key is invalid or unauthorized. Check GROQ_API_KEY in Render env.",
                    detail: groqMsg,
                    source: "groq"
                });
            }

            return res.status(502).json({
                error: "Could not reach Groq: " + groqMsg,
                source: "groq"
            });
        }

        const calendar = parseCalendarArray(raw);

        if (!calendar.length) {

            return res.status(502).json({
                error: "Groq returned an unparseable calendar. Click again to retry."
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

/* ============================================================
   Resilient parser for the Groq calendar response.
   Falls back to extracting individual {…} objects by regex if
   the full JSON.parse fails (which it often does because Groq
   returns unescaped quotes/newlines in topic/goal strings).
============================================================ */

function parseCalendarArray(raw) {

    let txt = String(raw).replace(/```json|```/g, "").trim();

    // Strategy 1: locate the outer [ … ] block and parse
    const start = txt.indexOf("[");
    const end   = txt.lastIndexOf("]") + 1;

    if (start >= 0 && end > 0) {

        const slice = txt.substring(start, end);

        try { return JSON.parse(slice); } catch (_) {}

        try {
            return JSON.parse(slice.replace(/[\x00-\x1F\x7F]/g, " "));
        } catch (_) {}
    }

    // Strategy 2: pull out each {…} block individually
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

            // Strategy 3 for this single object: extract fields by regex
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

        // Also try a fresh fetch when cache is empty so we can surface
        // the real underlying error (expired token, etc.)
        if (!pages.length) {

            try {

                const fresh = await refreshMetaPages();
                return res.json(fresh);

            } catch (refreshErr) {

                const m = refreshErr.response?.data?.error?.message ||
                          refreshErr.message;

                return res.json({
                    error: `META_ACCESS_TOKEN failed: ${m}. ` +
                           `Refresh it from Graph API Explorer.`,
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

        // Accept a fresh token from the dashboard
        const token = (req.body && req.body.token) ? String(req.body.token).trim() : null;

        const pages = await refreshMetaPages(token);

        res.json({
            success: true,
            count:   pages.length,
            tokenSaved: !!token
        });

    } catch (err) {

        const msg = err.response?.data?.error?.message ||
                    err.response?.data?.error_description ||
                    err.message;

        const code = err.response?.data?.error?.code;

        res.status(400).json({
            success: false,
            error:   msg,
            code,
            hint:    code === 190 || /OAuth|expired|invalid/i.test(msg)
                       ? "Token is invalid or expired. Get a fresh one from Graph API Explorer."
                       : null
        });
    }
});

/* ============================================================
   /meta/delete-pages — clear all stored pages
============================================================ */

app.post("/meta/delete-pages", requireMongo, async (req, res) => {

    try {
        await MetaPage.deleteMany({});
        res.json({ success: true });
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

/* ============================================================
   MANUAL CRON TRIGGER  — useful for testing
============================================================ */

app.post("/cron/run-now", requireAdmin, async (req, res) => {

    res.json({ success: true, message: "Started in background." });

    dailyCron.runDailyJob().catch(e => console.log("manual cron fail:", e));
});

/* ============================================================
   /generate-and-schedule  — THE FULL PIPELINE IN ONE CALL.

   Used by:
     - The dashboard "Generate Creative" button on any calendar
       item
     - The "🌅 Generate & Schedule for ALL Clients" button
     - The daily 9 AM IST cron (via dailyCron.runForClient)

   Body: { clientName, item? }
     - If `item` is missing, the next undone calendar item for
       the client is used (same logic as the cron).

   Returns: full run log so the dashboard can show what
   happened (image URL, scheduled status, errors, etc.)
============================================================ */

const runningJobs = new Set(); // clientName values being processed

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

        // Broadcast to dashboard so it can refresh its UI
        broadcast("pipeline-done", log);

        res.json({
            success: log.status === "scheduled",
            log
        });

    } catch (err) {

        console.log("/generate-and-schedule error:",
            err.response?.data || err.message);

        res.json({ success: false, error: err.message });

    } finally {

        runningJobs.delete(clientName);
    }
});

/* ============================================================
   /generate-all-now  — fires the pipeline for every client,
   one after another, in the background.
   The dashboard's "🌅 Generate for All Clients" button.
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

    /* ---------- Run in background ---------- */

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
   /calendar/:client  — fetch a previously saved calendar.
   Called by the dashboard on page load so calendars survive
   refresh.
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
   /save  — backward compatibility (Tampermonkey old version)
============================================================ */

app.post("/save", requireMongo, handleSavePost);

/* ============================================================
   BOOT  — connect Mongo, run startup health checks, start cron
============================================================ */

(async function boot() {

    try {

        await connect();
        dailyCron.start();

        // ── Startup health checks (non-blocking) ──
        setTimeout(runStartupChecks, 3000);

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

/* ============================================================
   STARTUP HEALTH CHECKS
   1. Was yesterday's cron skipped? (PC was off / power cut)
   2. Are the ChatGPT cookies still valid?
============================================================ */

async function runStartupChecks() {

    if (mongoose.connection.readyState !== 1) return;

    console.log("\n🩺 Running startup health checks…");

    /* ---------- 1. Did we miss yesterday's cron? ---------- */

    try {

        const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
            .toISOString().slice(0, 10);

        const last = await RunLog.findOne({ type: "daily-cron" })
            .sort({ runAt: -1 }).lean();

        if (!last) {

            console.log("   ⓘ  No previous cron run on record yet.");

        } else {

            const lastRunIST = new Date(
                new Date(last.runAt).getTime() + 5.5 * 60 * 60 * 1000
            ).toISOString().slice(0, 10);

            const daysSince = Math.floor(
                (new Date(todayIST) - new Date(lastRunIST)) /
                (24 * 60 * 60 * 1000)
            );

            if (daysSince === 0) {

                console.log("   ✓ Today's cron already ran.");

            } else if (daysSince === 1) {

                console.log(
                    "   ⓘ  Last cron was yesterday — normal if it's before 9 AM."
                );

            } else {

                console.log(
                    `   ⚠  Last cron was ${daysSince} days ago — possible missed run(s).\n` +
                    "       Hit \"🌅 Generate & Schedule for ALL Clients\" on the\n" +
                    "       dashboard to catch up if needed."
                );

                broadcast("pipeline-done", {
                    client: "system",
                    status: "missed-days",
                    reason:
                        `${daysSince} day(s) since last cron run. ` +
                        "Click the morning button to catch up."
                });
            }
        }

    } catch (err) {

        console.log("   missed-day check failed:", err.message);
    }

    /* ---------- 2. Check ChatGPT cookies (engine=puppeteer) ---------- */

    if ((process.env.IMAGE_ENGINE || "").toLowerCase() !== "puppeteer") {

        console.log(
            `   ⓘ  IMAGE_ENGINE=${process.env.IMAGE_ENGINE || "(default)"} — ` +
            "skipping cookie check."
        );
        return;
    }

    try {

        const sess = await Session.findOne({ name: "chatgpt" }).lean();

        if (!sess?.cookies?.length) {

            console.log(
                "   ⚠  No ChatGPT cookies stored. Run:\n" +
                "       node tools/upload-cookies.js cookies.json"
            );
            return;
        }

        const ageDays = Math.floor(
            (Date.now() - new Date(sess.updatedAt).getTime()) /
            (24 * 60 * 60 * 1000)
        );

        if (ageDays >= 14) {

            console.log(
                `   ⚠  ChatGPT cookies are ${ageDays} days old — may expire soon.\n` +
                "       Re-export from Cookie-Editor + re-upload to be safe."
            );

        } else {

            console.log(
                `   ✓ ChatGPT cookies in DB (${sess.cookies.length} cookies, ${ageDays}d old).`
            );
        }

    } catch (err) {

        console.log("   cookie check failed:", err.message);
    }

    console.log("");
}

process.on("SIGTERM", async () => {

    console.log("SIGTERM — shutting down…");
    try { await puppeteerCG.shutdown(); } catch (_) {}
    process.exit(0);
});