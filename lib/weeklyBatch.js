/* ============================================================
   weeklyBatch.js — image generation pipeline.

   Two operations:

   1. generateWeek(clientName)
      - Reads next N posting days for the client (3 for MWF, 6
        for Mon→Sat, 7 for daily)
      - For each: creates a DriveAsset + a Prompt with weeklyContext
      - Tampermonkey picks them up one at a time
      - On each result, onImageGeneratedForWeekly() uploads to Drive

   2. regenerateAsset(assetId)
      - Marks the asset back to "queued"
      - Creates a fresh Prompt for Tampermonkey
      - When the new image arrives, the old Drive file is deleted
        and the new one takes its place (same filename)
============================================================ */

const crypto = require("crypto");
const axios  = require("axios");

const { Client, Calendar, Prompt, DriveAsset } = require("../db/models");

const drive     = require("./drive");
const dailyCron = require("./dailyCron");

/* ============================================================
   Date helpers
============================================================ */

function fmtYMD(d) {
    const y  = d.getUTCFullYear();
    const m  = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
}

function nextNDaysFromToday(n) {
    const out = [];
    const start = new Date();
    const cursor = new Date(Date.UTC(
        start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()
    ));
    for (let i = 0; i < n; i++) {
        out.push(fmtYMD(cursor));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return out;
}

function weekStartFromToday() {
    const d = new Date();
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return fmtYMD(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())));
}

function captionSig(client, fileName) {
    return crypto.createHash("sha1")
        .update(String(client || ""))
        .update("|")
        .update(String(fileName || ""))
        .digest("hex")
        .slice(0, 16);
}

function postsPerWeek(postDays) {
    return postDays === "daily" ? 7
         : postDays === "mtwtfs" ? 6
         : 3;
}

/* ============================================================
   GENERATE WEEK
============================================================ */

async function generateWeek(clientName) {

    const client = await Client.findOne({ name: clientName }).lean();
    if (!client) throw new Error("Client not found: " + clientName);

    const folderId = drive.extractFolderId(client.driveFolderUrl || "");
    if (!folderId) {
        throw new Error("Client has no Drive folder URL. Edit the client and paste a Drive folder link.");
    }

    if (!await drive.isConfigured()) {
        throw new Error("Google Service Account not configured. Go to Settings.");
    }

    const cal = await Calendar.findOne({ client: clientName }).lean();
    if (!cal?.calendar?.length) {
        throw new Error("Client has no calendar. Generate a calendar first.");
    }

    const allowedDays = {
        mwf:    new Set([1, 3, 5]),
        mtwtfs: new Set([1, 2, 3, 4, 5, 6]),
        daily:  new Set([0, 1, 2, 3, 4, 5, 6])
    };
    const allowed = allowedDays[client.postDays || "mwf"];
    const targetCount = postsPerWeek(client.postDays || "mwf");

    const next14 = nextNDaysFromToday(14);
    const targetDates = next14.filter(dateStr => {
        const d = new Date(dateStr + "T00:00:00Z");
        return allowed.has(d.getUTCDay());
    }).slice(0, targetCount);

    if (!targetDates.length) {
        throw new Error("No posting days found in next 14 days for this client");
    }

    const ws = weekStartFromToday();
    const queued = [];

    for (const dateStr of targetDates) {

        let item = cal.calendar.find(x =>
            (x.date || "").slice(0, 10) === dateStr
        );

        if (!item) {
            item = {
                date:  dateStr,
                topic: `Post for ${dateStr}`,
                goal:  "",
                event: ""
            };
        }

        // Skip if already in progress for this date
        const existing = await DriveAsset.findOne({
            client:       clientName,
            calendarDate: dateStr,
            status:       { $nin: ["failed"] }
        });

        if (existing) {
            queued.push({ date: dateStr, status: "already-queued", topic: item.topic });
            continue;
        }

        let basePrompt = await dailyCron.buildImagePrompt(client, item);
        if (!basePrompt || !basePrompt.trim()) {
            queued.push({ date: dateStr, status: "skipped", reason: "Groq failed" });
            continue;
        }
        const fullPrompt = dailyCron.augmentPrompt(basePrompt, client);

        const prompt = await Prompt.create({
            _legacyId: Date.now() + Math.floor(Math.random() * 1000),
            client:    clientName,
            prompt:    fullPrompt,
            source:    "weekly-batch",
            generated: false,
            error:     JSON.stringify({
                weeklyContext: {
                    weekStart:    ws,
                    calendarDate: dateStr,
                    topic:        item.topic,
                    goal:         item.goal,
                    event:        item.event
                }
            })
        });

        const sanitizedName = drive.sanitizeFileName(item.topic || dateStr) + ".png";
        const asset = await DriveAsset.create({
            client:           clientName,
            weekStart:        ws,
            calendarDate:     dateStr,
            topic:            item.topic,
            fileName:         sanitizedName,
            captionSignature: captionSig(clientName, sanitizedName),
            status:           "queued",
            promptId:         prompt._legacyId
        });

        queued.push({
            date:    dateStr,
            status:  "queued",
            topic:   item.topic,
            assetId: asset._id.toString()
        });

        await new Promise(r => setTimeout(r, 5));
    }

    return {
        client:    clientName,
        weekStart: ws,
        queued
    };
}

/* ============================================================
   ON IMAGE GENERATED — called by handleSavePost when an
   incoming Prompt has weeklyContext.

   If the existing DriveAsset already has a driveFileId, this
   is a REGENERATE — delete the old file before uploading.
============================================================ */

async function onImageGeneratedForWeekly({
    client: clientName,
    image,
    cloudinaryUrl,
    weeklyContext
}) {

    const client = await Client.findOne({ name: clientName }).lean();
    if (!client) throw new Error("Client not found: " + clientName);

    const folderId = drive.extractFolderId(client.driveFolderUrl || "");
    if (!folderId) throw new Error("Client has no Drive folder URL");

    const { calendarDate, topic, weekStart } = weeklyContext;

    let asset = await DriveAsset.findOne({
        client:       clientName,
        calendarDate,
        status:       { $in: ["queued", "generating", "failed", "in-drive"] }
    });

    if (!asset) {
        asset = await DriveAsset.create({
            client:           clientName,
            weekStart:        weekStart || weekStartFromToday(),
            calendarDate,
            topic,
            fileName:         drive.sanitizeFileName(topic || calendarDate) + ".png",
            captionSignature: captionSig(clientName, drive.sanitizeFileName(topic || calendarDate) + ".png"),
            status:           "generating"
        });
    }

    // Capture for regenerate flow — if already in Drive, delete after new upload succeeds
    const oldDriveFileId = asset.driveFileId;

    asset.status        = "generating";
    asset.cloudinaryUrl = cloudinaryUrl || asset.cloudinaryUrl;
    await asset.save();

    try {

        // 1. Get image bytes
        let imageBuffer;

        if (cloudinaryUrl && /^https?:\/\//.test(cloudinaryUrl)) {
            const r = await axios.get(cloudinaryUrl, {
                responseType: "arraybuffer",
                timeout:      60_000
            });
            imageBuffer = Buffer.from(r.data);
        } else if (image && image.startsWith("data:")) {
            const b64 = image.split(",")[1] || "";
            imageBuffer = Buffer.from(b64, "base64");
        } else {
            throw new Error("Neither cloudinaryUrl nor base64 image available");
        }

        // 2. Generate caption
        let cap = { caption: "", hashtags: "" };
        try {
            cap = await dailyCron.buildCaption(
                client,
                { date: calendarDate, topic, goal: weeklyContext.goal, event: weeklyContext.event },
                ""
            );
        } catch (e) {
            console.log("[weekly] caption gen failed:", e.message);
        }

        // 3. Build Drive file description (so MetaFlow can read caption + hashtags)
        const desc =
            (cap.caption || "") +
            "\n\n" +
            (cap.hashtags || "") +
            "\n\n---\n" +
            `[topic] ${topic || ""}\n` +
            `[date] ${calendarDate}\n` +
            `[client] ${clientName}\n` +
            `[signature] ${asset.captionSignature}`;

        // 4. Upload new file first
        const file = await drive.uploadFile({
            folderId,
            name:        asset.fileName,
            mimeType:    "image/png",
            buffer:      imageBuffer,
            description: desc
        });

        // 5. Delete the old file ONLY after the new one is safely in Drive
        if (oldDriveFileId && oldDriveFileId !== file.id) {
            try {
                await drive.deleteFile(oldDriveFileId);
                console.log(`[weekly] deleted old Drive file ${oldDriveFileId} (regenerate)`);
            } catch (e) {
                console.log(`[weekly] could not delete old Drive file: ${e.message}`);
            }
        }

        asset.driveFileId   = file.id;
        asset.driveFileLink = file.webViewLink || "";
        asset.caption       = cap.caption || "";
        asset.hashtags      = cap.hashtags || "";
        asset.status        = "in-drive";
        asset.error         = "";
        await asset.save();

        console.log(
            `[weekly] ✓ uploaded "${asset.fileName}" to Drive for ${clientName} ` +
            `(file ${file.id})`
        );

        return { success: true, asset };

    } catch (err) {

        const msg = err.response?.data?.error?.message || err.message;
        asset.status = "failed";
        asset.error  = msg.slice(0, 500);
        await asset.save();
        console.log(`[weekly] ✗ Drive upload failed for ${clientName}/${calendarDate}: ${msg}`);
        throw err;
    }
}

/* ============================================================
   REGENERATE ASSET
   - Build a fresh Prompt
   - Mark asset back to "queued"
   - keep driveFileId so onImageGeneratedForWeekly knows to
     delete it after the new upload succeeds
============================================================ */

async function regenerateAsset(assetId) {

    const asset = await DriveAsset.findById(assetId);
    if (!asset) throw new Error("Asset not found");

    const client = await Client.findOne({ name: asset.client }).lean();
    if (!client) throw new Error("Client not found");

    // Cancel any un-generated prompt this asset already has
    if (asset.promptId) {
        await Prompt.deleteMany({ _legacyId: asset.promptId, generated: false });
    }

    const item = {
        date:  asset.calendarDate,
        topic: asset.topic,
        goal:  "",
        event: ""
    };

    let basePrompt = await dailyCron.buildImagePrompt(client, item);
    if (!basePrompt || !basePrompt.trim()) {
        throw new Error("Could not generate prompt (Groq failed)");
    }
    const fullPrompt = dailyCron.augmentPrompt(basePrompt, client);

    const prompt = await Prompt.create({
        _legacyId: Date.now() + Math.floor(Math.random() * 1000),
        client:    asset.client,
        prompt:    fullPrompt,
        source:    "weekly-batch-regenerate",
        generated: false,
        error:     JSON.stringify({
            weeklyContext: {
                weekStart:    asset.weekStart,
                calendarDate: asset.calendarDate,
                topic:        asset.topic,
                goal:         "",
                event:        ""
            }
        })
    });

    asset.status   = "queued";
    asset.promptId = prompt._legacyId;
    asset.error    = "";
    // Keep asset.driveFileId — it'll be replaced on next upload
    await asset.save();

    return { success: true, assetId: asset._id.toString(), promptId: prompt._legacyId };
}

module.exports = {
    generateWeek,
    onImageGeneratedForWeekly,
    regenerateAsset
};