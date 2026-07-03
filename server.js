require("dotenv").config();
console.log("GROQ_API_KEY loaded:", !!process.env.GROQ_API_KEY);

const express    = require("express");
const cors       = require("cors");
const axios      = require("axios");
const cloudinary = require("cloudinary").v2;
const cron       = require("node-cron");

const { connect } = require("./db/connect");

const {
    Client, Prompt, Post, Scheduled, Calendar,
    Session, MetaPage, RunLog, Log, DriveAsset
} = require("./db/models");

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

        // Look up the client to enrich the task with brand assets
        let logoUrl = "", footerUrl = "", chatLink = "", samplePosts = [];
        let productImageUrl = "", productTitle = "", prompt = claimed.prompt;

        try {
            const c = await Client.findOne({ name: claimed.client }).lean();
            logoUrl     = c?.logoUrl   || "";
            footerUrl   = c?.footerUrl || "";
            chatLink    = c?.chatLink  || "";
            samplePosts = Array.isArray(c?.samplePosts) ? c.samplePosts : [];

            /* ----- Pick a real product to feature in this creative ----- */
            const { pickFeaturedProduct, featuredProductPromptBlock } = require("./lib/products");

            // Rotate by attempts + day so consecutive posts vary the product.
            const seed    = (claimed.attempts || 0) + Math.floor(Date.now() / 86400000);
            const product = pickFeaturedProduct(c || {}, seed);

            if (product) {
                productImageUrl = product.image || "";
                productTitle    = product.title || "";
                // Append the HARD RULE so the model treats the attachment as the real product.
                prompt = `${prompt}\n${featuredProductPromptBlock(product)}`;
            }
        } catch (e) {
            console.log("/current-task product enrich failed:", e.message);
        }

        res.json({
            id:              claimed._legacyId || claimed._id,
            client:          claimed.client,
            prompt,
            logoUrl,
            footerUrl,
            chatLink,
            samplePosts,
            productImageUrl,
            productTitle
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

            let weeklyInfo = null;
            if (p.error) {
                try {
                    const parsed = JSON.parse(p.error);
                    if (parsed.weeklyContext) {
                        weeklyInfo = {
                            topic: parsed.weeklyContext.topic,
                            date:  parsed.weeklyContext.calendarDate
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
                weeklyInfo
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

        /* ---------- Composite logo + footer onto the image ----------
           Only fires if OVERLAY_BRAND_ASSETS=true. Default OFF because
           Tampermonkey v16+ attaches the actual files into ChatGPT,
           so the model produces a branded image directly. Set this to
           "true" if you want belt-and-braces stamping on top. */

        let imageToUpload = image;

        const wantOverlay =
            String(process.env.OVERLAY_BRAND_ASSETS || "false").toLowerCase() === "true";

        if (wantOverlay && (logoUrl || footerUrl)) {

            try {

                console.log(
                    `🎨 Server-side overlay for "${client}" (OVERLAY_BRAND_ASSETS=true)`
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

        /* ---------- Mark Prompt as done + capture weekly context ---------- */

        const queuedPrompt = await Prompt.findOne({
            client, prompt, generated: false
        }).lean();

        let weeklyContext = null;

        if (queuedPrompt?.error) {
            try {
                const parsed = JSON.parse(queuedPrompt.error);
                weeklyContext = parsed.weeklyContext || null;
            } catch (_) {}
        }

        await Prompt.updateMany(
            { client, prompt, generated: false },
            { $set: {
                generated: true,
                image:     secureUrl,
                error:     ""
            }}
        );

        const payload = {
            id:          post._legacyId,
            client:      post.client,
            prompt:      post.prompt,
            image:       post.image,
            caption:     post.caption,
            hashtags:    post.hashtags,
            status:      post.status,
            createdAt:   post.createdAt,
            weeklyBatch: !!weeklyContext
        };

        broadcast("new-post", payload);

        console.log(
            "✅ Image saved & broadcast:",
            secureUrl.slice(0, 80)
        );

        /* ---------- Weekly batch? Upload to Drive instead of scheduling ---------- */

        if (weeklyContext) {

            console.log(
                `📁 Image came from weekly batch — uploading to Drive for ${client}…`
            );

            (async () => {

                try {

                    const weeklyBatch = require("./lib/weeklyBatch");

                    const r = await weeklyBatch.onImageGeneratedForWeekly({
                        client,
                        image:         imageToUpload,
                        cloudinaryUrl: secureUrl,
                        weeklyContext
                    });

                    broadcast("weekly-uploaded", {
                        client,
                        status:    "in-drive",
                        topic:     weeklyContext.topic,
                        date:      weeklyContext.calendarDate,
                        driveLink: r.asset?.driveFileLink || ""
                    });

                } catch (e) {

                    console.log("weekly upload error:", e.message);
                    broadcast("weekly-uploaded", {
                        client,
                        status: "failed",
                        topic:  weeklyContext.topic,
                        date:   weeklyContext.calendarDate,
                        reason: e.message
                    });
                }
            })();

            return res.json({ success: true, post: payload });
        }

        /* Manual save (no weeklyContext) — image is just stored. */

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

        const b = req.body || {};
        const name = (b.name || "").trim();

        if (!name) {
            return res.status(400).json({ success: false, error: "name required" });
        }

        /* ---------- Helper: upload a data URL to Cloudinary ----------
           Auto-detects audio (Cloudinary treats audio as resource_type=video). */

        async function uploadDataUrl(dataUrl, label) {

            if (!dataUrl || typeof dataUrl !== "string") return null;
            if (!dataUrl.startsWith("data:")) return null;

            if (!process.env.CLOUDINARY_CLOUD_NAME) {
                throw new Error("Cloudinary is not configured on the server.");
            }

            const isAudio = /^data:audio\//i.test(dataUrl);

            const opts = {
                folder:    "ai-content/clients/" + name.replace(/[^a-z0-9_-]/gi, "_"),
                public_id: label + "-" + Date.now(),
                overwrite: true
            };

            if (isAudio) opts.resource_type = "video";

            const r = await cloudinary.uploader.upload(dataUrl, opts);

            if (!r || !r.secure_url) {
                console.log(`Cloudinary returned no secure_url for ${label}:`, r);
                throw new Error("Cloudinary upload returned no URL");
            }

            console.log(
                `☁ ${label} uploaded → ${r.secure_url} ` +
                `(${r.width || "?"}x${r.height || "?"}, ${r.bytes} bytes, ${isAudio ? "audio" : "image"})`
            );

            // Return both URL and public_id; callers that just want
            // the URL can do `.secure_url`.
            return { secure_url: r.secure_url, public_id: r.public_id };
        }

        /* ---------- Build the update document ---------- */

        const fields = {
            name,
            industry:    b.industry    || "",
            tone:        b.tone        || "",
            audience:    b.audience    || "",
            services:    b.services    || "",
            style:       b.style       || "",
            cta:         b.cta         || "",
            description: b.description || "",
            website:     (b.website     || "").trim(),
            phone:       (b.phone       || "").trim(),
            email:       (b.email       || "").trim(),
            postSize:    b.postSize    || "1:1",
            postDays:    b.postDays    || "mwf",
            chatLink:    (b.chatLink   || "").trim(),
            driveFolderUrl: (b.driveFolderUrl || "").trim()
        };

        // Derive the folder ID for convenience
        if (fields.driveFolderUrl) {
            const drive = require("./lib/drive");
            const id = drive.extractFolderId(fields.driveFolderUrl);
            fields.driveFolderId = id || "";
        } else {
            fields.driveFolderId = "";
        }

        // Only overwrite booleans if the caller actually sent them
        if (typeof b.contactInCaption === "boolean") fields.contactInCaption = b.contactInCaption;

        /* Logo */

        if (b.logoDataUrl) {

            try {
                const u = await uploadDataUrl(b.logoDataUrl, "logo");
                if (u) fields.logoUrl = u.secure_url;
            } catch (e) {
                return res.status(400).json({
                    success: false,
                    error:   "Logo upload failed: " + e.message
                });
            }

        } else if (typeof b.logoUrl === "string") {

            fields.logoUrl = b.logoUrl.trim();
        }

        /* Footer */

        if (b.footerDataUrl) {

            try {
                const u = await uploadDataUrl(b.footerDataUrl, "footer");
                if (u) fields.footerUrl = u.secure_url;
            } catch (e) {
                return res.status(400).json({
                    success: false,
                    error:   "Footer upload failed: " + e.message
                });
            }

        } else if (typeof b.footerUrl === "string") {

            fields.footerUrl = b.footerUrl.trim();
        }

        /* Sample posts */

        if (Array.isArray(b.samplePostsDataUrls) && b.samplePostsDataUrls.length) {

            const existing = (await Client.findOne({ name }).lean())?.samplePosts || [];
            const newUrls  = [];

            for (let i = 0; i < b.samplePostsDataUrls.length; i++) {
                try {
                    const u = await uploadDataUrl(
                        b.samplePostsDataUrls[i],
                        "sample-" + i
                    );
                    if (u) newUrls.push(u.secure_url);
                } catch (e) {
                    console.log(`Sample ${i} upload failed: ${e.message}`);
                }
            }

            fields.samplePosts = [...existing, ...newUrls];

        } else if (Array.isArray(b.samplePostsUrls)) {

            fields.samplePosts = b.samplePostsUrls.filter(Boolean);
        }

        /* Special clears */

        if (b.logoUrl === "__REMOVE__")    fields.logoUrl   = "";
        if (b.footerUrl === "__REMOVE__")  fields.footerUrl = "";
        if (b.samplePosts === "__REMOVE_SAMPLES__") fields.samplePosts = [];

        // Explicit shop-page URLs (only overwrite if the caller sent an array)
        if (Array.isArray(b.shopPages)) {
            fields.shopPages = b.shopPages
                .map(u => String(u || "").trim())
                .filter(Boolean);
        }

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
   GET a single client by name (used by dashboard Edit button)
============================================================ */

app.get("/clients/:name", requireMongo, async (req, res) => {

    try {
        const c = await Client.findOne({ name: req.params.name }).lean();
        if (!c) return res.status(404).json({ error: "Client not found" });
        res.json(c);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ============================================================
   POST /clients/:name/scrape-products  — manually refresh
   the website product cache. Returns the scraped items.
============================================================ */

app.post("/clients/:name/scrape-products", requireMongo, async (req, res) => {

    try {

        const { getProductsForClient } = require("./lib/scraper");

        const client = await Client.findOne({ name: req.params.name });
        if (!client) return res.status(404).json({ error: "Client not found" });

        // Optional: explicit shop-page URLs sent from the dashboard.
        // Persist them on the client so future scrapes reuse them.
        if (Array.isArray(req.body?.pages)) {
            client.shopPages = req.body.pages
                .map(u => String(u || "").trim())
                .filter(u => /^https?:\/\//i.test(u));
        }

        const hasPages = Array.isArray(client.shopPages) && client.shopPages.length;
        if (!client.website && !hasPages) {
            return res.status(400).json({ error: "Client has no website URL or shop pages set" });
        }

        const result = await getProductsForClient(client, { force: true });

        client.productsCache = {
            items:     result.items,
            scrapedAt: new Date(),
            source:    result.source
        };
        await client.save();

        res.json({
            success: true,
            count:   result.items.length,
            source:  result.source,
            items:   result.items
        });

    } catch (err) {

        console.log("/clients/:name/scrape-products error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ============================================================
   PATCH /clients/:name/shop-pages — save explicit shop-page
   URLs (used by the Products manager). Body: { pages: [ ... ] }
============================================================ */

app.patch("/clients/:name/shop-pages", requireMongo, async (req, res) => {

    try {
        const client = await Client.findOne({ name: req.params.name });
        if (!client) return res.status(404).json({ error: "Client not found" });

        client.shopPages = (Array.isArray(req.body?.pages) ? req.body.pages : [])
            .map(u => String(u || "").trim())
            .filter(u => /^https?:\/\//i.test(u));

        await client.save();
        res.json({ success: true, shopPages: client.shopPages });

    } catch (err) {
        console.log("/clients/:name/shop-pages error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ============================================================
   PUT /clients/:name/products  — manually set/upload products.

   Body: { items: [ {title, price, image?, imageDataUrl?, url?,
                     description?, featured?} ], mode?: "replace"|"merge" }

   - imageDataUrl (base64) is uploaded to Cloudinary and becomes
     the product image. A plain http(s) `image` URL is kept as-is.
   - mode "replace" (default) overwrites the catalog; "merge"
     appends/updates by title.
   Returns the stored catalog.
============================================================ */

app.put("/clients/:name/products", requireMongo, async (req, res) => {

    try {

        const { normalizeProducts } = require("./lib/products");

        const name   = req.params.name;
        const client = await Client.findOne({ name });
        if (!client) return res.status(404).json({ error: "Client not found" });

        const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
        const mode     = req.body?.mode === "merge" ? "merge" : "replace";

        /* Upload any inline base64 images to Cloudinary */
        const safeName = name.replace(/[^a-z0-9_-]/gi, "_");

        for (let i = 0; i < rawItems.length; i++) {
            const it = rawItems[i];
            if (it && typeof it.imageDataUrl === "string" && it.imageDataUrl.startsWith("data:")) {
                if (!process.env.CLOUDINARY_CLOUD_NAME) {
                    return res.status(400).json({ error: "Cloudinary is not configured on the server." });
                }
                try {
                    const up = await cloudinary.uploader.upload(it.imageDataUrl, {
                        folder:    "ai-content/clients/" + safeName + "/products",
                        public_id: "product-" + Date.now() + "-" + i,
                        overwrite: true
                    });
                    it.image = up.secure_url;
                } catch (e) {
                    console.log(`product image ${i} upload failed: ${e.message}`);
                }
                delete it.imageDataUrl;
            }
        }

        let items = normalizeProducts(rawItems);

        if (mode === "merge") {
            const existing = normalizeProducts(client.productsCache?.items || []);
            const byKey = new Map(existing.map(p => [p.title.toLowerCase(), p]));
            for (const p of items) byKey.set(p.title.toLowerCase(), p);
            items = [...byKey.values()];
        }

        client.productsCache = {
            items,
            scrapedAt: new Date(),
            source:    "manual"
        };
        await client.save();

        res.json({ success: true, count: items.length, source: "manual", items });

    } catch (err) {
        console.log("/clients/:name/products (PUT) error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ============================================================
   PATCH /clients/:name/products/featured — toggle which
   products are featured (by title). Body: { titles: [ ... ] }
============================================================ */

app.patch("/clients/:name/products/featured", requireMongo, async (req, res) => {

    try {

        const client = await Client.findOne({ name: req.params.name });
        if (!client) return res.status(404).json({ error: "Client not found" });

        const titles = new Set(
            (Array.isArray(req.body?.titles) ? req.body.titles : [])
                .map(t => String(t).toLowerCase())
        );

        const items = (client.productsCache?.items || []).map(p => ({
            ...(p.toObject ? p.toObject() : p),
            featured: titles.has(String(p.title).toLowerCase())
        }));

        client.productsCache = {
            items,
            scrapedAt: client.productsCache?.scrapedAt || new Date(),
            source:    client.productsCache?.source || "manual"
        };
        await client.save();

        res.json({ success: true, items });

    } catch (err) {
        console.log("/clients/:name/products/featured error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ============================================================
   DELETE /clients/:name/products — clear the product catalog
============================================================ */

app.delete("/clients/:name/products", requireMongo, async (req, res) => {

    try {
        const client = await Client.findOne({ name: req.params.name });
        if (!client) return res.status(404).json({ error: "Client not found" });

        client.productsCache = { items: [], scrapedAt: new Date(), source: "cleared" };
        await client.save();

        res.json({ success: true, count: 0 });

    } catch (err) {
        console.log("/clients/:name/products (DELETE) error:", err.message);
        res.status(500).json({ error: err.message });
    }
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

        /* ----- Resolve postDays into a description Groq understands ----- */

        const postDays = client.postDays || "mwf";

        const DAY_LABELS = {
            "mwf":    { count: 12, label: "every Monday, Wednesday, and Friday (3 posts per week)" },
            "mtwtfs": { count: 24, label: "Monday through Saturday (6 posts per week, skip Sunday)" },
            "daily":  { count: 30, label: "every day of the week (7 posts per week)" }
        };

        const cfg = DAY_LABELS[postDays] || DAY_LABELS.mwf;

        /* ----- If client has products cached, feed top items to Groq ---- */

        const productList = client.productsCache?.items?.length
            ? "\n\nFeatured products (use one per ~3-4 posts):\n" +
              client.productsCache.items.slice(0, 10).map((p, i) =>
                  `${i+1}. ${p.title}${p.price ? " — " + p.price : ""}`
              ).join("\n")
            : "";

        const prompt = `
Generate a one-month content calendar for a social media brand.

Brand:        ${client.name}
Industry:     ${client.industry || ""}
Tone:         ${client.tone || ""}
Audience:     ${client.audience || ""}
Services:     ${client.services || ""}
Style:        ${client.style || ""}
CTA:          ${client.cta || ""}
Website:      ${client.website || ""}
Description:  ${client.description || ""}
${productList}

POSTING SCHEDULE: Post on ${cfg.label}.
Generate EXACTLY ${cfg.count} entries — one for each posting day in the next ~30 days, starting from ${today}.
Do NOT include dates that fall outside the posting schedule.

Each topic should be conceptual, bold, and specific — not generic stock-photo ideas.

Return JSON Array ONLY. Do not add any commentary. Use this exact shape:

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

        const calendarRaw = parseCalendarArray(raw);

        if (!calendarRaw.length) {

            return res.status(502).json({
                error: "Groq returned an unparseable calendar. Click again to retry."
            });
        }

        /* ============================================================
           Generate the CORRECT schedule of dates ourselves based on
           postDays, then assign Groq's topics in order. This way the
           schedule is guaranteed to match the configured day pattern
           regardless of what dates Groq returns.

           Strategy:
             - Start from today (or tomorrow if today isn't a posting day)
             - Walk forward day-by-day, collecting dates whose weekday
               is in the allowed set
             - Stop when we have cfg.count dates
             - Assign Groq topics in order to those dates
        ============================================================ */

        const allowedDayIdx = {
            "mwf":    new Set([1, 3, 5]),            // Mon, Wed, Fri
            "mtwtfs": new Set([1, 2, 3, 4, 5, 6]),   // Mon-Sat
            "daily":  new Set([0, 1, 2, 3, 4, 5, 6]) // Sun-Sat
        };

        const allowed = allowedDayIdx[postDays] || allowedDayIdx.mwf;

        function fmtYMD(d) {
            const y  = d.getUTCFullYear();
            const m  = String(d.getUTCMonth() + 1).padStart(2, "0");
            const dd = String(d.getUTCDate()).padStart(2, "0");
            return `${y}-${m}-${dd}`;
        }

        const scheduledDates = [];
        const start = new Date();
        // Normalize to UTC midnight so getUTCDay is stable
        const cursor = new Date(Date.UTC(
            start.getUTCFullYear(),
            start.getUTCMonth(),
            start.getUTCDate()
        ));

        const HARD_CAP_DAYS = 60; // safety limit so we never loop forever
        let walked = 0;

        while (scheduledDates.length < cfg.count && walked < HARD_CAP_DAYS) {

            if (allowed.has(cursor.getUTCDay())) {
                scheduledDates.push(fmtYMD(cursor));
            }
            cursor.setUTCDate(cursor.getUTCDate() + 1);
            walked++;
        }

        /* Assign Groq's topics to our calculated dates in order.
           If Groq returned fewer topics than dates, the extras are
           assigned generic topics. If more, the extras are dropped. */

        const calendar = scheduledDates.map((date, i) => {

            const src = calendarRaw[i] || {};

            return {
                date,
                event: String(src.event || "").trim(),
                topic: String(src.topic || `Post ${i + 1}`).trim(),
                goal:  String(src.goal  || "").trim()
            };
        });

        if (!calendar.length) {
            return res.status(502).json({
                error: "Could not build a calendar — internal error"
            });
        }

        await Calendar.findOneAndUpdate(
            { client: client.name },
            { client: client.name, calendar },
            { upsert: true, new: true }
        );

        console.log(
            `📅 Saved calendar for "${client.name}" — ${calendar.length} items ` +
            `(rebuilt dates: ${postDays}, ${cfg.count} per month)`
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
   /meta/delete-pages — legacy cleanup endpoint (clears any stored
   MetaPage records left over from before MetaFlow took over).
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

    const filter = {};
    if (req.query.client) {
        filter.client = String(req.query.client).trim();
    }

    const posts = await Post.find(filter).sort({ createdAt: -1 }).limit(100).lean();

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
   SCHEDULE-POST — REMOVED. Scheduling is now handled by MetaFlow
   reading from each client's Drive folder. This endpoint stays
   as a clear 410 Gone so any stale UI calls get an obvious error.
============================================================ */

app.post("/schedule-post", requireMongo, async (req, res) => {
    res.status(410).json({
        success: false,
        error:   "Scheduling has moved to MetaFlow. This dashboard now only generates images and uploads them to each client's Drive folder."
    });
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
   Deprecated endpoints. Image generation now happens via the
   weekly batch flow (`POST /weekly-gen/:client`); scheduling
   happens in MetaFlow.
============================================================ */

app.post("/cron/run-now", requireAdmin, (req, res) => {
    res.status(410).json({
        success: false,
        error: "Daily cron is deprecated. Use POST /weekly-gen/:client to start the weekly image batch."
    });
});

/* POST /generate-and-schedule — single-post generation.
   Kept at the same path so the existing dashboard button works.
   Queues ONE prompt (with weeklyContext) for the given calendar
   item. When the image arrives it's uploaded to Drive, REPLACING
   any existing file of the same date. */

app.post("/generate-and-schedule", requireMongo, async (req, res) => {

    try {

        const clientName = req.body?.clientName || req.body?.client;
        const item       = req.body?.item;

        if (!clientName || !item) {
            return res.status(400).json({
                success: false,
                error:   "Send { clientName, item }"
            });
        }

        const weeklyBatch = require("./lib/weeklyBatch");
        const result = await weeklyBatch.generateOne(clientName, item);

        broadcast("pipeline-done", {
            client: clientName,
            status: "queued",
            reason: `single post "${item.topic || result.date}" queued for Tampermonkey`
        });

        res.json({ success: true, log: { status: "queued", ...result }, ...result });

    } catch (err) {
        console.log("/generate-and-schedule error:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

/* Alias for clarity — same behaviour. */
app.post("/generate-one/:client", requireMongo, async (req, res) => {

    try {
        const weeklyBatch = require("./lib/weeklyBatch");
        const result = await weeklyBatch.generateOne(req.params.client, req.body?.item);
        broadcast("pipeline-done", {
            client: req.params.client,
            status: "queued",
            reason: `single post "${result.topic || result.date}" queued`
        });
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

app.post("/generate-all-now", requireMongo, (req, res) => {
    res.status(410).json({
        success: false,
        error: "/generate-all-now is deprecated. Generation now runs per-client via POST /weekly-gen/:client."
    });
});

/* ============================================================
   /calendar/:client  — fetch a previously saved calendar.
   Called by the dashboard on page load so calendars survive
   refresh.
============================================================ */

/* ============================================================
   INSTAGRAM PUBLISH QUEUE — list + cancel
============================================================ */

/* ============================================================
   SETTINGS: Google Service Account JSON
============================================================ */

app.get("/settings/google-sa", requireMongo, async (req, res) => {

    try {

        const drive = require("./lib/drive");
        const info  = await drive.getAuthInfo();

        // Backward-compat shape for the existing dashboard JS
        res.json({
            configured:   info.mode !== "none",
            mode:         info.mode,                       // "oauth" | "service-account" | "none"
            client_email: info.email,                       // works for both modes
            email:        info.email
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/settings/google-sa", requireMongo, async (req, res) => {

    try {

        const json = req.body?.json;
        if (!json || typeof json !== "object") {
            return res.status(400).json({ error: "Send {json: <service account object>}" });
        }

        const drive = require("./lib/drive");
        await drive.saveServiceAccount(json);

        res.json({ success: true, client_email: json.client_email });

    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete("/settings/google-sa", requireMongo, async (req, res) => {

    try {
        const drive = require("./lib/drive");
        await drive.clearServiceAccount();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ============================================================
   GOOGLE OAUTH — 3 routes:

     GET  /oauth/google/start     → redirects user to Google consent
     GET  /oauth/google/callback  → Google redirects here with ?code=…
     DELETE /oauth/google         → disconnects (forgets refresh token)
============================================================ */

function buildOAuthRedirectUri(req) {
    // Use HTTPS if the request came in via HTTPS, otherwise HTTP for local dev
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host  = req.headers["x-forwarded-host"]  || req.headers.host;
    return `${proto}://${host}/oauth/google/callback`;
}

app.get("/oauth/google/start", (req, res) => {

    try {
        const drive       = require("./lib/drive");
        const redirectUri = buildOAuthRedirectUri(req);
        const url         = drive.buildAuthUrl(redirectUri);

        console.log("[oauth] starting flow, redirect_uri =", redirectUri);

        res.redirect(url);

    } catch (err) {
        console.log("[oauth] start error:", err.message);
        res.status(500).send(`
            <h2>OAuth setup error</h2>
            <p>${err.message}</p>
            <p>Make sure GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are set in env.</p>
        `);
    }
});

app.get("/oauth/google/callback", requireMongo, async (req, res) => {

    try {

        const { code, error } = req.query;

        if (error) {
            return res.status(400).send(`
                <h2>OAuth canceled</h2>
                <p>Google returned: <code>${error}</code></p>
                <p><a href="/dashboard.html">← back to dashboard</a></p>
            `);
        }

        if (!code) {
            return res.status(400).send(`
                <h2>Missing ?code in callback</h2>
                <p><a href="/dashboard.html">← back to dashboard</a></p>
            `);
        }

        const drive       = require("./lib/drive");
        const redirectUri = buildOAuthRedirectUri(req);
        const tokens      = await drive.exchangeCodeForTokens(code, redirectUri);

        if (!tokens.refresh_token) {
            return res.status(400).send(`
                <h2>No refresh_token returned by Google</h2>
                <p>This usually means you've previously authorized this app. Go to
                   <a href="https://myaccount.google.com/permissions" target="_blank">
                   myaccount.google.com/permissions</a>, remove the app, then try again.</p>
                <p><a href="/dashboard.html">← back to dashboard</a></p>
            `);
        }

        // Get the user's email so we can show it in the dashboard
        let email = "(unknown)";
        try {
            const userInfo = await axios.get(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                {
                    headers: { Authorization: "Bearer " + tokens.access_token },
                    timeout: 15_000
                }
            );
            email = userInfo.data?.email || email;
        } catch (e) {
            console.log("[oauth] could not fetch user email:", e.message);
        }

        await drive.saveOAuthCreds({
            refresh_token: tokens.refresh_token,
            scope:         tokens.scope,
            email:         email,
            connected_at:  new Date().toISOString()
        });

        console.log(`[oauth] connected ${email}`);

        broadcast("log", {
            level:   "ok",
            message: `Google Drive OAuth connected: ${email}`,
            at:      new Date().toISOString()
        });

        res.send(`
            <html>
            <head><title>Connected</title></head>
            <body style="font-family: system-ui; padding: 40px; max-width: 600px;
                         background: #0a0a0a; color: #eee;">
                <h2 style="color: #7eff7e;">✅ Google Drive connected</h2>
                <p>Signed in as <strong>${email}</strong></p>
                <p>All Drive uploads will now go to your account using your storage quota.</p>
                <p style="margin-top: 30px;">
                    <a href="/dashboard.html" style="color: #7eaaff; text-decoration: none;
                       padding: 10px 20px; background: #1d2435; border: 1px solid #2c3a52;
                       border-radius: 6px;">← Back to dashboard</a>
                </p>
            </body>
            </html>
        `);

    } catch (err) {
        const detail = err.response?.data || err.message;
        console.log("[oauth] callback error:", detail);
        res.status(500).send(`
            <h2>OAuth callback error</h2>
            <pre>${JSON.stringify(detail, null, 2)}</pre>
            <p><a href="/dashboard.html">← back to dashboard</a></p>
        `);
    }
});

app.delete("/oauth/google", requireMongo, async (req, res) => {

    try {
        const drive = require("./lib/drive");
        await drive.clearOAuthCreds();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ============================================================
   WEEKLY BATCH — generate + approve
============================================================ */

app.post("/weekly-gen/:client", requireMongo, async (req, res) => {

    try {

        const weeklyBatch = require("./lib/weeklyBatch");
        const result = await weeklyBatch.generateWeek(req.params.client);

        broadcast("weekly-gen-started", {
            client: req.params.client,
            count:  result.queued.filter(q => q.status === "queued").length
        });

        res.json({ success: true, ...result });

    } catch (err) {
        console.log("/weekly-gen error:", err.message);
        res.status(400).json({ error: err.message });
    }
});

/* POST /regenerate-asset/:assetId — re-queue a single Drive
   asset. When the new image arrives, the old Drive file is
   deleted and replaced with the new one (same filename). */

app.post("/regenerate-asset/:assetId", requireMongo, async (req, res) => {

    try {

        const weeklyBatch = require("./lib/weeklyBatch");
        const result = await weeklyBatch.regenerateAsset(req.params.assetId);

        broadcast("weekly-regenerate-queued", {
            assetId: req.params.assetId
        });

        res.json({ success: true, ...result });

    } catch (err) {
        console.log("/regenerate-asset error:", err.message);
        res.status(400).json({ error: err.message });
    }
});

/* POST /push-to-drive/:assetId — re-upload an asset that already
   has a generated image (cloudinaryUrl) but isn't in Drive yet.
   Used for failed uploads and for queued items whose image already
   exists. No regeneration — pushes the existing bytes straight up. */

app.post("/push-to-drive/:assetId", requireMongo, async (req, res) => {

    try {

        const weeklyBatch = require("./lib/weeklyBatch");
        const result = await weeklyBatch.pushToDrive(req.params.assetId);

        broadcast("weekly-uploaded", {
            client:    result.client || "",
            status:    "in-drive",
            driveLink: result.driveLink || ""
        });

        res.json({ success: true, ...result });

    } catch (err) {
        console.log("/push-to-drive error:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

/* POST /cron/weekly-all — admin-guarded (curl / CLI use). */

app.post("/cron/weekly-all", requireAdmin, requireMongo, async (req, res) => {

    try {
        const summary = await runWeeklyAllBatch("manual");
        res.json({ success: true, ...summary });
    } catch (err) {
        console.log("/cron/weekly-all error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* POST /weekly-gen-all — same batch, public (matches the existing
   public /weekly-gen/:client). Used by the dashboard button. */

app.post("/weekly-gen-all", requireMongo, async (req, res) => {

    try {
        const summary = await runWeeklyAllBatch("manual-dashboard");
        res.json({ success: true, ...summary });
    } catch (err) {
        console.log("/weekly-gen-all error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* DELETE /weekly-gen/:client — clear the queue for one client.
   Removes:
     - All ungenerated Prompts for this client (Tampermonkey won't pick up)
     - All DriveAssets with status "queued" or "failed"
   Drive files already uploaded ("in-drive" status) are NOT touched.
*/

app.delete("/weekly-gen/:client", requireMongo, async (req, res) => {

    try {

        const clientName = req.params.client;

        // 1. Find DriveAssets to delete (queued + failed)
        const assets = await DriveAsset.find({
            client: clientName,
            status: { $in: ["queued", "failed"] }
        }).lean();

        const promptIds = assets.map(a => a.promptId).filter(Boolean);

        // 2. Delete the matching Prompt records (un-generated ones)
        let promptsDeleted = 0;
        if (promptIds.length) {
            const r = await Prompt.deleteMany({
                _legacyId: { $in: promptIds },
                generated: false
            });
            promptsDeleted = r.deletedCount || 0;
        }

        // 3. Also catch any orphan prompts from weekly-batch (no matching asset)
        const r2 = await Prompt.deleteMany({
            client: clientName,
            source: { $in: ["weekly-batch", "weekly-batch-regenerate"] },
            generated: false
        });
        promptsDeleted += r2.deletedCount || 0;

        // 4. Delete the DriveAsset records
        const r3 = await DriveAsset.deleteMany({
            client: clientName,
            status: { $in: ["queued", "failed"] }
        });

        const assetsDeleted = r3.deletedCount || 0;

        console.log(
            `[clear-week] ${clientName}: removed ${promptsDeleted} prompt(s) ` +
            `+ ${assetsDeleted} asset(s)`
        );

        broadcast("weekly-cleared", {
            client:          clientName,
            promptsDeleted,
            assetsDeleted
        });

        res.json({
            success:        true,
            promptsDeleted,
            assetsDeleted
        });

    } catch (err) {
        console.log("/weekly-gen DELETE error:", err.message);
        res.status(400).json({ error: err.message });
    }
});

app.get("/drive-assets/:client", requireMongo, async (req, res) => {

    try {

        const { DriveAsset } = require("./db/models");
        const items = await DriveAsset.find({ client: req.params.client })
            .sort({ calendarDate: 1 })
            .limit(50)
            .lean();
        res.json({ items });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* GET /drive-folder/:client — list the LIVE state of the client's Drive
   folder so the dashboard can show what's currently in there. */

app.get("/drive-folder/:client", requireMongo, async (req, res) => {

    try {

        const { Client } = require("./db/models");
        const drive = require("./lib/drive");

        const client = await Client.findOne({ name: req.params.client }).lean();
        if (!client) return res.status(404).json({ error: "Client not found" });

        const folderId = drive.extractFolderId(client.driveFolderUrl || "");
        if (!folderId) return res.json({ folderId: null, files: [] });

        if (!await drive.isConfigured()) {
            return res.status(400).json({ error: "Google Service Account not configured" });
        }

        const files = await drive.listFiles(folderId);
        res.json({ folderId, files });

    } catch (err) {
        console.log("/drive-folder error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

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
   GET /calendar/:client/export.xlsx
   Stream an .xlsx file with the calendar so the user can edit
   it in Excel. Columns: Date · Day · Event · Topic · Goal · Done.
============================================================ */

app.get("/calendar/:client/export.xlsx", requireMongo, async (req, res) => {

    try {

        const ExcelJS = require("exceljs");

        const client = req.params.client;

        const cal = await Calendar.findOne({ client }).lean();

        const rows = cal?.calendar || [];

        const wb = new ExcelJS.Workbook();
        wb.creator = "AI Content Automation";
        wb.created = new Date();

        const ws = wb.addWorksheet(client.slice(0, 30) || "Calendar");

        ws.columns = [
            { header: "Date",  key: "date",  width: 14 },
            { header: "Day",   key: "day",   width: 12 },
            { header: "Event", key: "event", width: 24 },
            { header: "Topic", key: "topic", width: 48 },
            { header: "Goal",  key: "goal",  width: 36 },
            { header: "Done",  key: "done",  width: 8 }
        ];

        // Style the header row
        ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        ws.getRow(1).fill = {
            type:    "pattern",
            pattern: "solid",
            fgColor: { argb: "FF1f2937" }
        };
        ws.getRow(1).alignment = { vertical: "middle" };
        ws.views = [{ state: "frozen", ySplit: 1 }];

        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

        rows.forEach(item => {

            let dayName = "";
            if (item.date) {
                const d = new Date(item.date + "T00:00:00");
                if (!isNaN(d)) dayName = days[d.getDay()];
            }

            ws.addRow({
                date:  item.date  || "",
                day:   dayName,
                event: item.event || "",
                topic: item.topic || "",
                goal:  item.goal  || "",
                done:  item.done  ? "yes" : ""
            });
        });

        // Set content disposition headers
        const safeName = client.replace(/[^a-z0-9_-]/gi, "_");
        const filename = `calendar-${safeName}-${new Date().toISOString().slice(0,10)}.xlsx`;

        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${filename}"`
        );

        await wb.xlsx.write(res);
        res.end();

    } catch (err) {

        console.log("/calendar export error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ============================================================
   POST /calendar/:client/import
   Body: multipart form-data with field "file" = .xlsx
   Parses the workbook (first sheet), validates rows, replaces
   the saved calendar for that client.
============================================================ */

const multer = require("multer");
const xlsxUpload = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 10 * 1024 * 1024 }   // 10 MB
});

app.post("/calendar/:client/import",
    requireMongo,
    xlsxUpload.single("file"),
    async (req, res) => {

        try {

            const ExcelJS = require("exceljs");

            const client = req.params.client;

            if (!req.file?.buffer) {
                return res.status(400).json({ error: "No file uploaded" });
            }

            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(req.file.buffer);

            const ws = wb.worksheets[0];
            if (!ws) return res.status(400).json({ error: "Workbook has no sheets" });

            /* Find the header row + column indices so users can
               reorder columns or rename them slightly. We accept
               case-insensitive matches. */

            const headerRow = ws.getRow(1);
            const colByName = {};

            headerRow.eachCell((cell, colNumber) => {
                const v = String(cell.value || "").trim().toLowerCase();
                if (v) colByName[v] = colNumber;
            });

            const colDate  = colByName["date"];
            const colEvent = colByName["event"];
            const colTopic = colByName["topic"];
            const colGoal  = colByName["goal"];
            const colDone  = colByName["done"];

            if (!colDate || !colTopic) {
                return res.status(400).json({
                    error: "Sheet must have at least 'Date' and 'Topic' columns " +
                           "(case-insensitive header row 1)."
                });
            }

            const calendar = [];
            const issues   = [];

            ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {

                if (rowNumber === 1) return; // skip header

                /* Extract date — Excel may give us a Date object or
                   a string. Normalize to YYYY-MM-DD. */

                let rawDate = row.getCell(colDate).value;
                let dateStr = "";

                if (rawDate instanceof Date) {
                    // Use local components to avoid TZ shift surprises
                    const y  = rawDate.getFullYear();
                    const m  = String(rawDate.getMonth() + 1).padStart(2, "0");
                    const dd = String(rawDate.getDate()).padStart(2, "0");
                    dateStr = `${y}-${m}-${dd}`;
                } else if (typeof rawDate === "string") {
                    const trimmed = rawDate.trim();
                    // Accept YYYY-MM-DD or D/M/YYYY or M/D/YYYY
                    const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
                    if (iso) {
                        dateStr = `${iso[1]}-${iso[2].padStart(2,"0")}-${iso[3].padStart(2,"0")}`;
                    } else {
                        const parsed = new Date(trimmed);
                        if (!isNaN(parsed)) {
                            const y  = parsed.getFullYear();
                            const m  = String(parsed.getMonth() + 1).padStart(2, "0");
                            const dd = String(parsed.getDate()).padStart(2, "0");
                            dateStr = `${y}-${m}-${dd}`;
                        }
                    }
                } else if (rawDate && typeof rawDate === "object" && rawDate.text) {
                    // Hyperlink/formula cell
                    dateStr = String(rawDate.text).trim();
                }

                const topic = String(row.getCell(colTopic).value || "").trim();

                if (!dateStr || !topic) {
                    issues.push(`Row ${rowNumber}: skipped (missing date or topic)`);
                    return;
                }

                const event = colEvent ? String(row.getCell(colEvent).value || "").trim() : "";
                const goal  = colGoal  ? String(row.getCell(colGoal ).value || "").trim() : "";

                let done = false;
                if (colDone) {
                    const d = String(row.getCell(colDone).value || "").trim().toLowerCase();
                    done = ["yes","y","true","1","done","✓"].includes(d);
                }

                calendar.push({ date: dateStr, event, topic, goal, done });
            });

            if (!calendar.length) {
                return res.status(400).json({
                    error: "No valid rows found. Make sure rows have a Date and a Topic.",
                    issues
                });
            }

            await Calendar.findOneAndUpdate(
                { client },
                { client, calendar },
                { upsert: true, new: true }
            );

            console.log(
                `📥 Imported calendar for "${client}" — ${calendar.length} rows ` +
                `(${issues.length} skipped)`
            );

            res.json({
                success: true,
                imported: calendar.length,
                skipped:  issues.length,
                issues:   issues.slice(0, 20)
            });

        } catch (err) {

            console.log("/calendar import error:", err.message);
            res.status(500).json({ error: err.message });
        }
    }
);

/* ============================================================
   /save  — backward compatibility (Tampermonkey old version)
============================================================ */

app.post("/save", requireMongo, handleSavePost);

/* ============================================================
   WEEKLY-ALL BATCH RUNNER + SATURDAY SCHEDULER

   runWeeklyAllBatch(trigger) loops every client and queues their
   upcoming week, logs a RunLog, and broadcasts progress to the
   dashboard. It's called by:
     - the Saturday cron (automatic)
     - POST /cron/weekly-all (manual, admin)
     - the boot catch-up check (if a Saturday was missed)

   A RunLog of type "weekly-all" records the last run so the
   catch-up logic knows whether this week's batch already ran.
============================================================ */

let weeklyAllRunning = false;

async function runWeeklyAllBatch(trigger = "cron") {

    if (weeklyAllRunning) {
        console.log("[weekly-all] already running — skipping duplicate trigger");
        return { skipped: true, reason: "already-running" };
    }

    weeklyAllRunning = true;

    try {

        console.log(`\n📦 [weekly-all] starting (trigger=${trigger})…`);

        broadcast("pipeline-done", {
            client: "system",
            status: "queued",
            reason: `Weekly auto-batch started for ALL clients (${trigger})`
        });

        const weeklyBatch = require("./lib/weeklyBatch");
        const summary = await weeklyBatch.generateAllClients();

        const totalQueued = summary.clients.reduce(
            (n, c) => n + (c.queued || 0), 0
        );
        const errored = summary.clients.filter(c => c.status === "error");

        await RunLog.create({
            type:    "weekly-all",
            summary: `Queued ${totalQueued} post(s) across ${summary.clients.length} client(s) (${trigger})`,
            detail:  summary
        });

        broadcast("pipeline-done", {
            client: "system",
            status: errored.length ? "failed" : "scheduled",
            reason:
                `Weekly auto-batch done: ${totalQueued} post(s) queued for ` +
                `${summary.clients.length} client(s)` +
                (errored.length ? `, ${errored.length} client(s) errored` : "")
        });

        broadcast("weekly-all-done", summary);

        console.log(
            `✓ [weekly-all] done — ${totalQueued} post(s) across ` +
            `${summary.clients.length} client(s)\n`
        );

        return summary;

    } finally {
        weeklyAllRunning = false;
    }
}

/* Has this week's Saturday batch already run? Compares the last
   "weekly-all" RunLog against the current week start (Monday). */

async function weeklyAllRanThisWeek() {

    const last = await RunLog.findOne({ type: "weekly-all" })
        .sort({ runAt: -1 }).lean();

    if (!last) return false;

    // Week start (Monday 00:00) in server-local time
    const now = new Date();
    const day = now.getDay();                 // 0 Sun … 6 Sat
    const diff = day === 0 ? -6 : 1 - day;    // back to Monday
    const monday = new Date(now);
    monday.setDate(now.getDate() + diff);
    monday.setHours(0, 0, 0, 0);

    return new Date(last.runAt) >= monday;
}

/* Start the Saturday cron + a boot-time catch-up.

   - Schedule: env WEEKLY_CRON (node-cron syntax) or default
     "30 3 * * 6" = Saturday 03:30 UTC = Saturday 09:00 IST.
   - Timezone: env CRON_TZ or default "Asia/Kolkata".
   - Catch-up: on boot, if today is Saturday (or later in the week)
     and this week's batch hasn't run yet, run it ~1 min after boot.
     This covers Render's free tier sleeping through the cron fire. */

function startWeeklyScheduler() {

    const schedule = process.env.WEEKLY_CRON || "30 3 * * 6";  // Sat 09:00 IST
    const tz       = process.env.CRON_TZ     || "Asia/Kolkata";

    if (!cron.validate(schedule)) {
        console.log(`[scheduler] invalid WEEKLY_CRON "${schedule}" — auto-batch disabled.`);
        return;
    }

    cron.schedule(schedule, () => {
        runWeeklyAllBatch("saturday-cron").catch(e =>
            console.log("[scheduler] weekly-all error:", e.message)
        );
    }, { timezone: tz });

    console.log(`🗓  Weekly auto-batch scheduled: "${schedule}" (${tz}).`);

    // ── Catch-up: if we're already at/after Saturday this week and the
    //    batch hasn't run, fire it shortly after boot. ──
    setTimeout(async () => {
        try {
            if (mongoose.connection.readyState !== 1) return;

            const day = new Date().getDay(); // 0 Sun … 6 Sat
            const atOrAfterSaturday = day === 6 || day === 0;

            if (atOrAfterSaturday && !(await weeklyAllRanThisWeek())) {
                console.log("[scheduler] catch-up: weekly batch missed this week — running now.");
                await runWeeklyAllBatch("saturday-catchup");
            }
        } catch (e) {
            console.log("[scheduler] catch-up check failed:", e.message);
        }
    }, 60_000);
}



(async function boot() {

    try {

        await connect();
        console.log("ℹ Image generation only — scheduling handled by MetaFlow.");

        // ── Startup health checks (non-blocking) ──
        setTimeout(runStartupChecks, 3000);

        // ── Weekly auto-batch scheduler (Saturday) ──
        startWeeklyScheduler();

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
