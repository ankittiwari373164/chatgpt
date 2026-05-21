/* ============================================================
   Daily Cron — runs every day at 9:00 AM IST.

   For every client that has a calendar in Mongo:
     1. Look at today's calendar item (date matches YYYY-MM-DD).
     2. Skip if already done (item.done === true).
     3. Generate an image-generation prompt with Groq from the
        item's topic / goal / event.
     4. Generate the image (Puppeteer → ChatGPT, Pollinations
        fallback if needed) and upload to Cloudinary.
     5. Generate caption + hashtags with Groq.
     6. Find the matching Meta page for the client.
     7. Schedule the post to FB + IG, ≥11 minutes from now.
     8. Mark calendar item.done = true.
     9. Save everything to MongoDB + log result.
============================================================ */

const cron = require("node-cron");
const axios = require("axios");

const {
    Client, Calendar, Prompt, Post, RunLog
} = require("../db/models");

const { generateImage } = require("./imageGen");

const {
    getAllMetaPages,
    findPageForClient,
    scheduleOnePost,
    persistScheduleAttempt
} = require("./meta");

const CRON_EXPR = "0 9 * * *";      // 09:00 every day
const TZ        = "Asia/Kolkata";   // IST

/* ============================================================
   Helpers
============================================================ */

function todayISO() {

    // YYYY-MM-DD in IST
    const d = new Date(
        Date.now() + 5.5 * 60 * 60 * 1000
    );

    return d.toISOString().slice(0, 10);
}

async function groqJSON(prompt, opts = {}) {

    const maxAttempts = opts.maxAttempts || 4;

    let lastErr;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {

        try {

            const r = await axios.post(
                "https://api.groq.com/openai/v1/chat/completions",
                {
                    model:       "llama-3.1-8b-instant",
                    messages:    [{ role: "user", content: prompt }],
                    temperature: 0.85,
                    max_tokens:  900
                },
                {
                    headers: {
                        Authorization:
                        `Bearer ${process.env.GROQ_API_KEY}`
                    },
                    timeout: 60000
                }
            );

            const raw = r.data.choices[0].message.content || "";

            const parsed = parseGroqJSON(raw);
            if (parsed) return parsed;

            // Couldn't parse but no exception — try once more with
            // a hint to the model to return cleaner JSON.
            lastErr = new Error("Unparseable JSON from Groq");

        } catch (err) {

            lastErr = err;

            const status = err.response?.status;

            // 429 = rate-limited; back off and try again
            if (status === 429 && attempt < maxAttempts) {

                const waitMs = 1000 * Math.pow(2, attempt);
                console.log(
                    `  Groq 429 — backing off ${waitMs}ms (attempt ${attempt}/${maxAttempts})`
                );
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }

            // Network glitch — retry once
            if (!status && attempt < maxAttempts) {

                await new Promise(r => setTimeout(r, 1500));
                continue;
            }

            // Other errors: stop
            break;
        }

        // Unparseable JSON path — retry once more
        if (attempt < maxAttempts) {

            await new Promise(r => setTimeout(r, 800));
        }
    }

    console.log("groqJSON failed:", lastErr?.message);
    return null;
}

/* ============================================================
   PARSE GROQ JSON — multiple strategies to handle the model's
   tendency to return JSON with unescaped newlines/quotes in
   string values.
============================================================ */

function parseGroqJSON(raw) {

    if (!raw || typeof raw !== "string") return null;

    let txt = raw.replace(/```json|```/g, "").trim();

    const s = txt.indexOf("{");
    const e = txt.lastIndexOf("}") + 1;
    if (s === -1 || e === 0) return null;

    txt = txt.substring(s, e);

    /* Strategy 1: direct parse */
    try { return JSON.parse(txt); } catch (_) {}

    /* Strategy 2: strip control chars (newlines, tabs, BOM, etc.) */
    try {
        return JSON.parse(txt.replace(/[\x00-\x1F\x7F]/g, " "));
    } catch (_) {}

    /* Strategy 3: pull out fields with regex (last resort).
       Works as long as Groq used the field names we asked for. */
    const result = {};

    const fieldRe = /"(\w+)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let m;
    while ((m = fieldRe.exec(txt)) !== null) {
        result[m[1]] = m[2]
            .replace(/\\n/g, "\n")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
    }

    return Object.keys(result).length ? result : null;
}

async function buildImagePrompt(client, item) {

    const productsHint = client.productsCache?.items?.length
        ? "\nProducts available:\n" + client.productsCache.items.slice(0, 5)
              .map((p, i) => `${i+1}. ${p.title}${p.price ? " ("+p.price+")" : ""}`)
              .join("\n")
        : "";

    const text = `
Create a single highly detailed image-generation prompt for a luxury,
conceptual (not normal) social media creative.

Brand:        ${client.name}
Industry:     ${client.industry || ""}
Tone:         ${client.tone || ""}
Audience:     ${client.audience || ""}
Services:     ${client.services || ""}
Style:        ${client.style || ""}
CTA:          ${client.cta || ""}
Website:      ${client.website || ""}
Description:  ${client.description || ""}
${productsHint}

Topic: ${item.topic || ""}
Goal:  ${item.goal  || ""}
Event: ${item.event || ""}

Return ONLY a JSON object: {"prompt":"<your image prompt here>"}
The prompt should be conceptual and bold — not a generic stock photo.
`;

    const out = await groqJSON(text);

    if (out?.prompt && typeof out.prompt === "string" && out.prompt.trim()) {
        return out.prompt.trim();
    }

    const parts = [
        item.topic,
        item.goal,
        client.name && ("for brand " + client.name),
        client.industry && ("in the " + client.industry + " industry"),
        client.description && ("about " + client.description.slice(0, 120)),
        client.style && ("style: " + client.style),
        client.tone && ("tone: " + client.tone)
    ].filter(Boolean);

    return parts.join(", ") || (client.name + " social media post");
}

async function buildCaption(client, item, finalPrompt) {

    const text = `
You are an expert social media copywriter.

Brand:
${client.name} — ${client.industry || ""}

Image generation prompt:
${finalPrompt}

Calendar item:
- Date:  ${item.date}
- Topic: ${item.topic}
- Goal:  ${item.goal}
- Event: ${item.event || "—"}

Return ONLY valid JSON:
{
 "caption":  "2-3 sentences with 1-2 emojis and a clear CTA",
 "hashtags": "#tag1 #tag2 #tag3 #tag4 #tag5 #tag6"
}
`;

    return await groqJSON(text) || { caption: "", hashtags: "" };
}

/* ============================================================
   Per-client run
============================================================ */

async function runForClient(client, today, pages, opts = {}) {

    const log = { client: client.name, status: "skipped", reason: "" };

    /* ---------- 1. Find today's calendar item ---------- */

    const cal = await Calendar.findOne({ client: client.name });

    if (!cal?.calendar?.length) {

        log.reason = "no calendar — generate one for this client first";
        return log;
    }

    let item;

    if (opts.item) {

        // Caller passed the exact item they want — find it in the calendar
        // by topic+date so we can still mark it done afterwards.
        item = cal.calendar.find(x =>
            (x.topic === opts.item.topic) &&
            ((x.date || "").slice(0, 10) ===
             (opts.item.date || "").slice(0, 10))
        );

        if (!item) item = opts.item; // not found in DB → use as-is

    } else {

        // Match by exact date for today
        item = cal.calendar.find(
            x => (x.date || "").slice(0, 10) === today && !x.done
        );

        if (!item) {

            // Today has no scheduled post for this client (non-posting day,
            // or the slot was already done). Skip cleanly — don't post the
            // wrong item.
            log.status = "skipped";
            log.reason = "no calendar item scheduled for today (" + today + ")";
            return log;
        }
    }

    log.item = item.topic;

    /* ---------- 2. Find Meta page ---------- */

    const page = findPageForClient(client.name, pages);

    if (!page) {

        log.reason = "no matching Meta page for client";
        return log;
    }

    log.page = page.pageName;

    /* ---------- 3. Build image prompt with Groq ---------- */

    let imagePrompt = await buildImagePrompt(client, item);

    if (!imagePrompt || !imagePrompt.trim()) {

        log.status = "failed";
        log.reason = "Groq failed to produce an image prompt " +
                     "(rate-limited or malformed response)";
        return log;
    }

    log.imagePrompt = imagePrompt.slice(0, 120);

    /* Augment the prompt with brand assets + Instagram 1:1 spec */
    imagePrompt = augmentPrompt(imagePrompt, client);

    /* ---------- 4. Generate image (direct OR queue) ---------- */

    const engine =
        (process.env.IMAGE_ENGINE || "tampermonkey").toLowerCase();

    if (engine === "tampermonkey") {

        const queued = await Prompt.create({
            _legacyId: Date.now(),
            client:    client.name,
            prompt:    imagePrompt,
            source:    "cron",
            generated: false,
            error:     JSON.stringify({
                cronContext: {
                    pageId:          page.pageId,
                    pageName:        page.pageName,
                    pageAccessToken: page.pageAccessToken,
                    instagramId:     page.instagramId,
                    itemDate:        item.date,
                    itemTopic:       item.topic
                }
            })
        });

        log.status         = "queued";
        log.reason         = "Waiting for Tampermonkey on your PC to generate the image.";
        log.queuedPromptId = queued._legacyId;
        log.imageSource    = "queued";

        return log;
    }

    /* ---------- Direct generation path (gemini / puppeteer) ---------- */

    let imageUrl, source;

    try {

        const r = await generateImage(imagePrompt, {
            timeoutMs: 4 * 60 * 1000
        });
        imageUrl = r.url;
        source   = r.source;

    } catch (imgErr) {

        log.status = "failed";
        log.reason = "Image generation failed: " + imgErr.message;
        return log;
    }

    if (!imageUrl) {

        log.status = "failed";
        log.reason = "Image generator returned no URL";
        return log;
    }

    log.imageSource = source;
    log.image       = imageUrl;

    /* ---------- 5. Build caption ---------- */

    const cap = await buildCaption(client, item, imagePrompt);

    /* ---------- 6. Save Post ---------- */

    const post = await Post.create({
        _legacyId:    Date.now(),
        client:       client.name,
        prompt:       imagePrompt,
        image:        imageUrl,
        caption:      cap.caption || "",
        hashtags:     cap.hashtags || "",
        status:       "generated",
        scheduled:    false,
        source:       "cron"
    });

    /* ---------- 7. Schedule to FB + IG ---------- */

    const unixTime = Math.floor((Date.now() + 11 * 60 * 1000) / 1000);

    const result = await scheduleOnePost(post, page, unixTime);

    await persistScheduleAttempt(post, page, result, unixTime);

    if (result.fb || result.ig) {

        post.status       = "scheduled";
        post.scheduled    = true;
        post.scheduleTime = new Date(unixTime * 1000).toISOString();
        await post.save();

        // Mark calendar item done
        item.done = true;
        cal.markModified("calendar");
        await cal.save();

        log.status  = "scheduled";
        log.fb      = result.fb;
        log.ig      = result.ig;

    } else {

        log.status = "failed";
        log.errors = result.errors;
    }

    return log;
}

/* ============================================================
   Master run
============================================================ */

async function runDailyJob(opts = {}) {

    const onProgress = opts.onProgress || (() => {});

    const startedAt = new Date();

    console.log(
        `\n⏰ Daily cron starting at ${startedAt.toLocaleString("en-IN", { timeZone: TZ })}`
    );

    const today   = todayISO();
    const clients = await Client.find().lean();

    if (!clients.length) {

        console.log("  No clients in database — nothing to do.");
        return;
    }

    const pages = await getAllMetaPages();

    if (!pages.length) {

        console.log("  ⚠ No Meta pages cached — check META_ACCESS_TOKEN.");
        onProgress({
            status: "error",
            reason: "No Meta pages cached. META_ACCESS_TOKEN may have expired."
        });
        return;
    }

    const summary = [];

    for (const c of clients) {

        try {

            const log = await runForClient(c, today, pages);
            summary.push(log);

            console.log(
                `  ${log.status === "scheduled" ? "✅" : "⏭ "} ` +
                `${c.name}: ${log.status}` +
                (log.reason ? ` (${log.reason})` : "") +
                (log.imageSource ? ` [${log.imageSource}]` : "")
            );

            try { onProgress(log); } catch (_) {}

        } catch (err) {

            console.log(`  ❌ ${c.name}: ${err.message}`);
            const failLog = { client: c.name, status: "error", reason: err.message };
            summary.push(failLog);
            try { onProgress(failLog); } catch (_) {}
        }

        // Be gentle on the headless browser
        await new Promise(r => setTimeout(r, 5000));
    }

    /* ---------- Persist run log ---------- */

    await RunLog.create({
        runAt:   startedAt,
        type:    "daily-cron",
        summary: `Processed ${summary.length} client(s) on ${today}`,
        detail:  summary
    });

    const okCount = summary.filter(s => s.status === "scheduled").length;

    console.log(
        `🏁 Daily cron done — ${okCount}/${summary.length} scheduled.\n`
    );
}

/* ============================================================
   Schedule + manual trigger
============================================================ */

let scheduled = null;

function start() {

    if (scheduled) return;

    if (!cron.validate(CRON_EXPR)) {

        console.log("Invalid CRON_EXPR:", CRON_EXPR);
        return;
    }

    scheduled = cron.schedule(CRON_EXPR, runDailyJob, { timezone: TZ });

    console.log(
        `🕘 Daily cron scheduled: "${CRON_EXPR}" (${TZ}) → 09:00 IST every day`
    );
}

function stop() {

    if (scheduled) { scheduled.stop(); scheduled = null; }
}

/* ============================================================
   Compose the user-visible image prompt with:
   - size requirement based on client.postSize
   - all brand context fields
   - attached reference images note (if logo/footer present)
   - conceptual-not-normal instruction
   - product list if e-commerce + cache populated
============================================================ */

function sizeBlock(postSize) {

    const map = {
        "1:1":  { aspect: "1:1",  px: "1080 x 1080", platforms: "Instagram feed + Facebook feed" },
        "4:5":  { aspect: "4:5",  px: "1080 x 1350", platforms: "Instagram portrait feed" },
        "9:16": { aspect: "9:16", px: "1080 x 1920", platforms: "Instagram Story / Reel cover" }
    };

    const s = map[postSize] || map["1:1"];

    return [
        "",
        "IMPORTANT FORMAT REQUIREMENTS:",
        `- Generate exactly a ${s.aspect} aspect ratio image (${s.px} pixels).`,
        `- This image is for ${s.platforms}.`,
        "- Do NOT add any watermark, signature, or AI-generation badge."
    ].join("\n");
}

function brandContextBlock(client) {

    const fields = [
        ["Brand",        client.name],
        ["Industry",     client.industry],
        ["Tone",         client.tone],
        ["Audience",     client.audience],
        ["Services",     client.services],
        ["Style",        client.style],
        ["CTA",          client.cta],
        ["Website",      client.website],
        ["Description",  client.description]
    ].filter(([, v]) => v && String(v).trim());

    if (!fields.length) return "";

    return [
        "",
        "BRAND CONTEXT:",
        ...fields.map(([k, v]) => `- ${k}: ${String(v).trim()}`)
    ].join("\n");
}

function productsBlock(client) {

    const items = client.productsCache?.items;
    if (!items || !items.length) return "";

    // Send up to 5 products so the prompt stays manageable.
    const top = items.slice(0, 5);

    return [
        "",
        "PRODUCT CATALOG (from website):",
        ...top.map((p, i) =>
            `${i + 1}. ${p.title}` +
            (p.price       ? ` — ${p.price}`        : "") +
            (p.description ? ` — ${p.description.slice(0, 120)}` : "")
        ),
        "Feature one or more of these products if it fits the topic."
    ].join("\n");
}

function attachedAssetsBlock(client) {

    const logo   = (client?.logoUrl   || "").trim();
    const footer = (client?.footerUrl || "").trim();

    if (logo && footer) {
        return [
            "",
            "ATTACHED REFERENCE IMAGES (already in this chat):",
            "  1. The brand logo",
            "  2. The brand footer/banner",
            "- Use the EXACT attached logo in the top-right corner.",
            "- Use the EXACT attached footer across the bottom strip.",
            "- Do not invent or restyle them."
        ].join("\n");
    }

    if (logo) {
        return [
            "",
            "ATTACHED REFERENCE IMAGE (already in this chat):",
            "  1. The brand logo",
            "- Use the EXACT attached logo in the top-right corner.",
            "- Do not invent or restyle it."
        ].join("\n");
    }

    if (footer) {
        return [
            "",
            "ATTACHED REFERENCE IMAGE (already in this chat):",
            "  1. The brand footer/banner",
            "- Use the EXACT attached footer across the bottom strip.",
            "- Do not invent or restyle it."
        ].join("\n");
    }

    return "";
}

function augmentPrompt(basePrompt, client) {

    const parts = [String(basePrompt || "").trim()];

    parts.push(sizeBlock(client?.postSize));
    parts.push(brandContextBlock(client || {}));
    parts.push(productsBlock(client || {}));
    parts.push(attachedAssetsBlock(client || {}));

    parts.push("");
    parts.push("STYLE DIRECTIVE:");
    parts.push("- The post should be CONCEPTUAL not normal — bold, creative, idea-driven, not a generic stock photo.");

    return parts.filter(Boolean).join("\n");
}

module.exports = {
    start,
    stop,
    runDailyJob,
    runForClient,
    buildImagePrompt,
    buildCaption,
    augmentPrompt
};