/* ============================================================
   fbQueue.js — server-side Facebook publishing queue.
   Mirror of igQueue.js. Holds FB posts in MongoDB, fires
   setTimeout-armed publish at the scheduled time.

     1. enqueue(payload) → creates FbQueue doc + armTimer()
     2. At fire-time: fetch media → upload to FB as photo
        (unpublished) → publish via /feed POST
     3. On boot: rearm() re-schedules all pending jobs

   Why a separate queue from FB's scheduled_publish_time?
   - Identical UX to IG (cancellable, visible in dashboard)
   - We control timing precisely; no Meta-side quirks
   - Posts can be canceled without an API call to Meta
============================================================ */

const axios = require("axios");
const { FbQueue } = require("../db/models");

const armed = new Map();

/* ============================================================
   Publish a single FB job (run at fire-time)
============================================================ */

async function publishJob(jobId) {

    const job = await FbQueue.findOne({ jobId });

    if (!job) {
        console.log(`[fb-queue] ${jobId}: not found`);
        return;
    }

    if (job.status !== "pending") {
        console.log(`[fb-queue] ${jobId}: skipped (status=${job.status})`);
        return;
    }

    job.status   = "processing";
    job.attempts = (job.attempts || 0) + 1;
    await job.save();

    console.log(
        `[fb-queue] ▶ Publishing ${jobId} — ${job.accountName} ` +
        `(attempt ${job.attempts})`
    );

    try {

        const fullCaption =
            [job.caption, job.hashtags].filter(Boolean).join("\n\n");

        const isVideo = job.mediaType === "video";

        let metaPostId;

        /* ---------- VIDEO ---------- */

        if (isVideo) {

            // Use file_url so FB fetches the media itself — no multipart needed
            const r = await axios.post(
                `https://graph.facebook.com/v19.0/${job.pageId}/videos`,
                null,
                {
                    params: {
                        file_url:     job.mediaUrl,
                        description:  fullCaption,
                        access_token: job.pageToken
                    },
                    timeout: 180000
                }
            );

            metaPostId = r.data?.id;

            if (!metaPostId) {
                throw new Error("FB video upload returned no ID: " + JSON.stringify(r.data));
            }

        } else {

            /* ---------- PHOTO ----------
               Two-step: upload unpublished photo → publish via /feed
               with attached_media. Same flow we used for FB scheduled
               posts, minus the scheduled_publish_time parameter. */

            const uploadRes = await axios.post(
                `https://graph.facebook.com/v19.0/${job.pageId}/photos`,
                null,
                {
                    params: {
                        url:          job.mediaUrl,
                        published:    "false",
                        access_token: job.pageToken
                    },
                    timeout: 90000
                }
            );

            const photoId = uploadRes.data?.id;

            if (!photoId) {
                throw new Error("FB photo upload returned no ID: " + JSON.stringify(uploadRes.data));
            }

            const feedRes = await axios.post(
                `https://graph.facebook.com/v19.0/${job.pageId}/feed`,
                null,
                {
                    params: {
                        message:          fullCaption,
                        attached_media:   JSON.stringify([{ media_fbid: photoId }]),
                        access_token:     job.pageToken
                    },
                    timeout: 60000
                }
            );

            metaPostId = feedRes.data?.id || feedRes.data?.post_id || photoId;
        }

        job.status     = "done";
        job.metaPostId = metaPostId;
        job.error      = "";
        await job.save();

        console.log(`[fb-queue] ✅ ${jobId} published → ${metaPostId}`);

        try {
            const sse = global.__sseBroadcast;
            if (sse) sse({ type: "fb-published", jobId, metaPostId, client: job.client });
        } catch (_) {}

    } catch (err) {

        const msg = err.response?.data?.error?.message || err.message;

        job.status = "failed";
        job.error  = msg.slice(0, 500);
        await job.save();

        console.log(`[fb-queue] ❌ ${jobId} failed — ${msg}`);

        try {
            const sse = global.__sseBroadcast;
            if (sse) sse({ type: "fb-failed", jobId, error: msg, client: job.client });
        } catch (_) {}

    } finally {

        armed.delete(jobId);
    }
}

/* ============================================================
   Arm a single setTimeout for a job (same pattern as igQueue)
============================================================ */

function armTimer(job) {

    if (armed.has(job.jobId)) {
        clearTimeout(armed.get(job.jobId));
    }

    const msUntil = new Date(job.scheduledAt).getTime() - Date.now();

    if (msUntil <= 0) {

        const h = setTimeout(() => publishJob(job.jobId), 100);
        armed.set(job.jobId, h);
        return;
    }

    const MAX = 2_000_000_000; // ~23 days

    if (msUntil > MAX) {

        const h = setTimeout(() => {

            armed.delete(job.jobId);

            FbQueue.findOne({ jobId: job.jobId }).then(fresh => {
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
        `[fb-queue] armed ${job.jobId} for ${job.accountName} ` +
        `in ${mins}m (${new Date(job.scheduledAt).toLocaleString()})`
    );
}

/* ============================================================
   Public API
============================================================ */

async function enqueue(payload) {

    const jobId =
        "fb_" + Date.now().toString(36) +
        "_" + Math.random().toString(36).slice(2, 8);

    const minDate = new Date(Date.now() + 60 * 1000);
    const scheduledAt =
        new Date(payload.scheduledAt) < minDate ? minDate
                                                : new Date(payload.scheduledAt);

    const job = await FbQueue.create({
        jobId,
        client:      payload.client,
        postId:      payload.postId,
        pageName:    payload.pageName,
        accountName: payload.accountName || payload.pageName,
        pageId:      payload.pageId,
        pageToken:   payload.pageToken,
        caption:     payload.caption  || "",
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

    const job = await FbQueue.findOne({ jobId });
    if (!job) return null;

    if (job.status === "pending" || job.status === "processing") {
        job.status = "canceled";
        await job.save();
    }

    return job;
}

async function listPending() {

    return FbQueue
        .find({ status: { $in: ["pending", "processing"] } })
        .sort({ scheduledAt: 1 })
        .lean();
}

async function listAll(limit = 100) {

    return FbQueue
        .find()
        .sort({ scheduledAt: -1 })
        .limit(limit)
        .lean();
}

async function rearm() {

    const pending = await FbQueue.find({ status: "pending" }).lean();

    console.log(`[fb-queue] Rearming ${pending.length} pending job(s)…`);

    for (const job of pending) {
        armTimer(job);
    }
}

module.exports = { enqueue, cancel, listPending, listAll, rearm, publishJob };