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

async function groqJSON(prompt) {

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

    let raw = r.data.choices[0].message.content;
    raw = raw.replace(/```json|```/g, "").trim();

    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}") + 1;

    if (s === -1 || e === 0) return null;

    try {

        return JSON.parse(
            raw.substring(s, e).replace(/[\x00-\x1F\x7F]/g, " ")
        );

    } catch (_) { return null; }
}

async function buildImagePrompt(client, item) {

    const text = `
Create a single highly detailed image-generation prompt for a luxury
social media creative.

Brand:    ${client.name}
Industry: ${client.industry || ""}
Tone:     ${client.tone || ""}
Audience: ${client.audience || ""}
Services: ${client.services || ""}
Style:    ${client.style || ""}
CTA:      ${client.cta || ""}

Topic: ${item.topic || ""}
Goal:  ${item.goal  || ""}
Event: ${item.event || ""}

Return ONLY a JSON object: {"prompt":"<your image prompt here>"}
`;

    const out = await groqJSON(text);
    return out?.prompt || `${item.topic || ""} for ${client.name}`;
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

async function runForClient(client, today, pages) {

    const log = { client: client.name, status: "skipped", reason: "" };

    /* ---------- 1. Find today's calendar item ---------- */

    const cal = await Calendar.findOne({ client: client.name });

    if (!cal?.calendar?.length) {

        log.reason = "no calendar";
        return log;
    }

    // Match by exact date OR fall back to the next unfinished item
    let item = cal.calendar.find(
        x => (x.date || "").slice(0, 10) === today && !x.done
    );

    if (!item) {

        item = cal.calendar.find(x => !x.done);

        if (!item) {

            log.reason = "calendar exhausted";
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

    const imagePrompt = await buildImagePrompt(client, item);

    /* ---------- 4. Generate image ---------- */

    const { url: imageUrl, source } =
        await generateImage(imagePrompt, { timeoutMs: 4 * 60 * 1000 });

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
        caption:      cap.caption,
        hashtags:     cap.hashtags,
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

async function runDailyJob() {

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

        } catch (err) {

            console.log(`  ❌ ${c.name}: ${err.message}`);
            summary.push({ client: c.name, status: "error", reason: err.message });
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

module.exports = {
    start,
    stop,
    runDailyJob
};
