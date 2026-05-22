/* ============================================================
   Meta scheduling — extracted so both the dashboard endpoint
   AND the daily cron can use the same code path.
============================================================ */

const axios = require("axios");

const { MetaPage, Post, Scheduled, Session } = require("../db/models");

/* ============================================================
   Fetch all Meta pages (with IG ids) for the connected user
   token. Cached in MongoDB so we don't hammer the Graph API
   every cron run.
============================================================ */

async function refreshMetaPages(overrideToken) {

    // Priority: explicit arg → env var → stored Session
    let token = overrideToken || process.env.META_ACCESS_TOKEN;

    if (!token) {
        try {
            const sess = await Session.findOne({ name: "meta_token" }).lean();
            token = sess?.cookies?.token || null;
        } catch (_) {}
    }

    if (!token) {
        const err = new Error("No Meta access token available.");
        err.code = "NO_TOKEN";
        throw err;
    }

    const response = await axios.get(
        "https://graph.facebook.com/v19.0/me/accounts",
        {
            params:  { access_token: token, limit: 100 },
            timeout: 30000
        }
    );

    const pages = response.data.data || [];
    const out   = [];

    for (const page of pages) {

        let instagramId = null;

        try {

            const ig = await axios.get(
                `https://graph.facebook.com/v19.0/${page.id}`,
                {
                    params: {
                        fields:       "instagram_business_account",
                        access_token: page.access_token
                    },
                    timeout: 15000
                }
            );

            instagramId =
                ig.data?.instagram_business_account?.id || null;

        } catch (_) {}

        const doc = {
            pageId:          page.id,
            pageName:        page.name,
            pageAccessToken: page.access_token,
            instagramId,
            refreshedAt:     new Date()
        };

        await MetaPage.findOneAndUpdate(
            { pageId: doc.pageId },
            doc,
            { upsert: true, new: true }
        );

        out.push(doc);
    }

    // If caller passed a new token successfully, persist it for next time
    if (overrideToken) {
        try {
            await Session.findOneAndUpdate(
                { name: "meta_token" },
                { cookies: { token: overrideToken }, updatedAt: new Date() },
                { upsert: true }
            );
        } catch (_) {}
    }

    return out;
}

async function getAllMetaPages() {

    const cached = await MetaPage.find().lean();

    // Refresh once an hour
    const stale = !cached.length ||
        (Date.now() - new Date(cached[0].refreshedAt).getTime() > 60*60*1000);

    if (stale) {

        try { return await refreshMetaPages(); }
        catch (e) {
            console.log("refreshMetaPages failed, using cache:", e.message);
        }
    }

    return cached;
}

/* ============================================================
   Fuzzy client-name → page matching (same algo the dashboard
   uses).
============================================================ */

function normalizeName(s) {

    return (s || "")
        .toLowerCase()
        .replace(/\b(pvt|ltd|llp|inc|co|company)\.?\b/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function findPageForClient(clientName, pages) {

    if (!clientName || !pages.length) return null;

    const target = normalizeName(clientName);
    if (!target) return null;

    let hit = pages.find(p => normalizeName(p.pageName) === target);
    if (hit) return hit;

    hit = pages.find(p => normalizeName(p.pageName).startsWith(target));
    if (hit) return hit;

    hit = pages.find(p => target.startsWith(normalizeName(p.pageName)));
    if (hit) return hit;

    const cTokens = new Set(target.split(" ").filter(Boolean));
    let best = null, bestScore = 0;

    for (const p of pages) {

        const pTokens = normalizeName(p.pageName)
            .split(" ").filter(Boolean);

        let score = 0;
        for (const t of pTokens) if (cTokens.has(t)) score++;
        if (score > bestScore) { bestScore = score; best = p; }
    }

    return bestScore > 0 ? best : null;
}

/* ============================================================
   IG container polling
============================================================ */

async function pollIgContainer(containerId, token, maxMs = 90000) {

    const start = Date.now();

    while (Date.now() - start < maxMs) {

        await new Promise(r => setTimeout(r, 3000));

        const r = await axios.get(
            `https://graph.facebook.com/v19.0/${containerId}`,
            { params: { fields: "status_code,status", access_token: token } }
        );

        if (r.data.status_code === "FINISHED") return true;

        if (r.data.status_code === "ERROR" ||
            r.data.status_code === "EXPIRED") {

            throw new Error(
                `IG container failed: ${r.data.status || r.data.status_code}`
            );
        }
    }

    throw new Error("IG container processing timed out");
}

/* ============================================================
   Schedule one post to one target (FB + IG if linked)
============================================================ */

async function scheduleOnePost(post, target, unixTime) {

    const fullCaption =
        (post.caption || "") +
        (post.hashtags
            ? "\n\n" + (
                Array.isArray(post.hashtags)
                    ? post.hashtags.join(" ")
                    : post.hashtags
              )
            : ""
        );

    const result = {
        pageName: target.pageName,
        fb:       null,
        ig:       null,
        errors:   []
    };

    /* ---------- FACEBOOK (via queue) ---------- */

    if (target.pageId) {

        try {

            const fbQueue = require("./fbQueue");

            const job = await fbQueue.enqueue({
                client:      post.client,
                postId:      post._legacyId,
                pageName:    target.pageName,
                accountName: target.pageName,
                pageId:      target.pageId,
                pageToken:   target.pageAccessToken,
                caption:     post.caption  || "",
                hashtags:    Array.isArray(post.hashtags)
                                ? post.hashtags.join(" ")
                                : (post.hashtags || ""),
                mediaUrl:    post.image,
                mediaType:   "image",
                scheduledAt: new Date(unixTime * 1000)
            });

            result.fb = job.jobId;
            console.log(
                `  📘 FB queued → ${target.pageName}: ${job.jobId} ` +
                `(fires ${new Date(unixTime * 1000).toLocaleString()})`
            );

        } catch (err) {

            const msg = err.response?.data?.error?.message || err.message;
            console.log(`  ✗ FB queue → ${target.pageName}: ${msg}`);
            result.errors.push("FB: " + msg);
        }
    }

    /* ---------- INSTAGRAM (via queue) ---------- */

    if (target.instagramId) {

        try {

            const igQueue = require("./igQueue");

            const job = await igQueue.enqueue({
                client:      post.client,
                postId:      post._legacyId,
                pageName:    target.pageName,
                accountName: target.pageName + " (IG)",
                igId:        target.instagramId,
                pageId:      target.pageId,
                fbToken:     target.pageAccessToken,
                caption:     post.caption || "",
                hashtags:    post.hashtags || "",
                mediaUrl:    post.image,
                mediaType:   "image",
                scheduledAt: new Date(unixTime * 1000)
            });

            result.ig = job.jobId;
            console.log(
                `  📸 IG queued → ${target.pageName}: ${job.jobId} ` +
                `(fires ${new Date(unixTime * 1000).toLocaleString()})`
            );

        } catch (err) {

            const msg = err.response?.data?.error?.message || err.message;
            console.log(`  ✗ IG queue → ${target.pageName}: ${msg}`);
            result.errors.push("IG: " + msg);
        }
    }

    return result;
}

/* ============================================================
   Save schedule attempt to the Scheduled collection
============================================================ */

async function persistScheduleAttempt(post, target, result, unixTime) {

    await Scheduled.create({
        _legacyId:    Date.now() + Math.floor(Math.random() * 1000),
        postId:       post._legacyId || post.id,
        client:       post.client,
        page:         target.pageName,
        image:        post.image,
        caption:      post.caption,
        hashtags:     post.hashtags,
        scheduleTime: new Date(unixTime * 1000).toISOString(),
        platform:     (result.fb ? "Facebook" : "") +
                      (result.fb && result.ig ? " + " : "") +
                      (result.ig ? "Instagram" : ""),
        fbPostId:     result.fb,
        igPostId:     result.ig,
        errors:       result.errors,
        status:       (result.fb || result.ig) ? "scheduled" : "failed"
    });
}

module.exports = {
    refreshMetaPages,
    getAllMetaPages,
    findPageForClient,
    normalizeName,
    scheduleOnePost,
    persistScheduleAttempt
};