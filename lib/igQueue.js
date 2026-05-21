/* ============================================================
   igQueue.js — server-side Instagram publishing queue.

   Pattern adapted from MetaFlow (browser-based) into a
   server-resident worker:

     1. enqueue(post, page, scheduledAt) → creates an IgQueue doc
        and arms a setTimeout to fire at the scheduled time.

     2. At fire time: create IG media container → poll until
        FINISHED → call media_publish. Update job doc.

     3. On server boot, rearm() finds all `pending` jobs and
        re-arms their setTimeout (so a Render restart doesn't
        lose schedules).

   Why setTimeout instead of cron? IG publishing is "now or never"
   — once we hit fire time we want to push within seconds. cron
   has minute granularity, setTimeout is precise.
============================================================ */

const axios = require("axios");
const { IgQueue } = require("../db/models");

const armed = new Map();   // jobId → timeoutHandle

/* ============================================================
   Helpers
============================================================ */

async function pollContainer(containerId, token, maxWaitMs = 120000) {

    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {

        await new Promise(r => setTimeout(r, 3000));

        const r = await axios.get(
            `https://graph.facebook.com/v19.0/${containerId}`,
            { params: { fields: "status_code,status", access_token: token } }
        );

        if (r.data?.status_code === "FINISHED") return true;
        if (r.data?.status_code === "ERROR" || r.data?.status_code === "EXPIRED") {
            throw new Error(`Container ${r.data.status_code}: ${r.data.status || ""}`);
        }
    }

    throw new Error("Container polling timed out after " + (maxWaitMs / 1000) + "s");
}

/* ============================================================
   Publish a single job (run at fire-time)
============================================================ */

async function publishJob(jobId) {

    const job = await IgQueue.findOne({ jobId });

    if (!job) {
        console.log(`[ig-queue] ${jobId}: job not found — already deleted?`);
        return;
    }

    if (job.status !== "pending") {
        console.log(`[ig-queue] ${jobId}: skipped (status=${job.status})`);
        return;
    }

    job.status   = "processing";
    job.attempts = (job.attempts || 0) + 1;
    await job.save();

    console.log(
        `[ig-queue] ▶ Publishing ${jobId} — ${job.accountName} ` +
        `(attempt ${job.attempts})`
    );

    try {

        /* 1. Create container */

        const isVideo = job.mediaType === "video";

        const containerParams = {
            access_token: job.fbToken,
            caption:      [job.caption, job.hashtags].filter(Boolean).join("\n\n")
        };

        if (isVideo) {
            containerParams.media_type   = "REELS";
            containerParams.video_url    = job.mediaUrl;
            containerParams.share_to_feed = "true";
        } else {
            containerParams.image_url = job.mediaUrl;
        }

        const containerRes = await axios.post(
            `https://graph.facebook.com/v19.0/${job.igId}/media`,
            null,
            { params: containerParams, timeout: 60000 }
        );

        const containerId = containerRes.data?.id;

        if (!containerId) {
            throw new Error("No container ID returned: " + JSON.stringify(containerRes.data));
        }

        /* 2. Poll until ready */

        if (isVideo) {
            await pollContainer(containerId, job.fbToken, 180000); // 3 min for video
        } else {
            // Images are usually ready in 2-3 sec, give it 30s ceiling
            await new Promise(r => setTimeout(r, 2500));
            try {
                await pollContainer(containerId, job.fbToken, 30000);
            } catch (e) {
                // image polling failure is non-fatal — try publish anyway
                console.log(`[ig-queue] ${jobId}: image poll warning — ${e.message}`);
            }
        }

        /* 3. Publish */

        const pubRes = await axios.post(
            `https://graph.facebook.com/v19.0/${job.igId}/media_publish`,
            null,
            {
                params: {
                    creation_id:  containerId,
                    access_token: job.fbToken
                },
                timeout: 60000
            }
        );

        const metaPostId = pubRes.data?.id || containerId;

        job.status     = "done";
        job.metaPostId = metaPostId;
        job.error      = "";
        await job.save();

        console.log(`[ig-queue] ✅ ${jobId} published → ${metaPostId}`);

        // Notify SSE subscribers if available
        try {
            const sse = global.__sseBroadcast;
            if (sse) sse({ type: "ig-published", jobId, metaPostId, client: job.client });
        } catch (_) {}

    } catch (err) {

        const msg = err.response?.data?.error?.message || err.message;

        job.status = "failed";
        job.error  = msg.slice(0, 500);
        await job.save();

        console.log(`[ig-queue] ❌ ${jobId} failed — ${msg}`);

        try {
            const sse = global.__sseBroadcast;
            if (sse) sse({ type: "ig-failed", jobId, error: msg, client: job.client });
        } catch (_) {}
    } finally {

        armed.delete(jobId);
    }
}

/* ============================================================
   Arm a single setTimeout for a job
============================================================ */

function armTimer(job) {

    if (armed.has(job.jobId)) {
        clearTimeout(armed.get(job.jobId));
    }

    const msUntil = new Date(job.scheduledAt).getTime() - Date.now();

    if (msUntil <= 0) {

        // Already due (server restarted after the scheduled time, or
        // a "publish now" enqueue). Fire on next tick.
        const h = setTimeout(() => publishJob(job.jobId), 100);
        armed.set(job.jobId, h);
        return;
    }

    // setTimeout in Node supports up to ~24.8 days. If schedule is
    // further out, set a "wakeup" timer 24h before and re-arm then.
    const MAX = 2_000_000_000; // ≈23 days, safe margin

    if (msUntil > MAX) {

        const h = setTimeout(() => {

            armed.delete(job.jobId);

            IgQueue.findOne({ jobId: job.jobId }).then(fresh => {
                if (fresh && fresh.status === "pending") armTimer(fresh);
            });

        }, MAX);

        armed.set(job.jobId, h);
        return;
    }

    const h = setTimeout(() => publishJob(job.jobId), msUntil);
    armed.set(job.jobId, h);

    const mins = Math.round(msUntil / 60000);
    console.log(
        `[ig-queue] armed ${job.jobId} for ${job.accountName} ` +
        `in ${mins}m (${new Date(job.scheduledAt).toLocaleString()})`
    );
}

/* ============================================================
   Public API
============================================================ */

async function enqueue(payload) {

    /* payload: { client, postId, pageName, accountName, igId, pageId,
                  fbToken, caption, hashtags, mediaUrl, mediaType,
                  scheduledAt } */

    const jobId =
        "ig_" + Date.now().toString(36) +
        "_" + Math.random().toString(36).slice(2, 8);

    // Enforce a small minimum delay (1 minute) so the dashboard can
    // see "queued" status briefly before publish fires.
    const minDate = new Date(Date.now() + 60 * 1000);
    const scheduledAt =
        new Date(payload.scheduledAt) < minDate ? minDate
                                                : new Date(payload.scheduledAt);

    const job = await IgQueue.create({
        jobId,
        client:      payload.client,
        postId:      payload.postId,
        pageName:    payload.pageName,
        accountName: payload.accountName || payload.pageName,
        igId:        payload.igId,
        pageId:      payload.pageId,
        fbToken:     payload.fbToken,
        caption:     payload.caption || "",
        hashtags:    payload.hashtags || "",
        mediaUrl:    payload.mediaUrl,
        mediaType:   payload.mediaType || "image",
        scheduledAt
    });

    armTimer(job);

    return job;
}

async function cancel(jobId) {

    if (armed.has(jobId)) {
        clearTimeout(armed.get(jobId));
        armed.delete(jobId);
    }

    const job = await IgQueue.findOne({ jobId });
    if (!job) return null;

    if (job.status === "pending" || job.status === "processing") {
        job.status = "canceled";
        await job.save();
    }

    return job;
}

async function listPending() {

    return IgQueue
        .find({ status: { $in: ["pending", "processing"] } })
        .sort({ scheduledAt: 1 })
        .lean();
}

async function listAll(limit = 100) {

    return IgQueue
        .find()
        .sort({ scheduledAt: -1 })
        .limit(limit)
        .lean();
}

async function rearm() {

    const pending = await IgQueue.find({ status: "pending" }).lean();

    console.log(`[ig-queue] Rearming ${pending.length} pending job(s)…`);

    for (const job of pending) {
        armTimer(job);
    }
}

module.exports = { enqueue, cancel, listPending, listAll, rearm, publishJob };