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

const { Client, Prompt, DriveAsset } = require("../db/models");

const drive     = require("./drive");
const dailyCron = require("./dailyCron");
const schedulerCalendar = require("./schedulerCalendar");

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

    const calendarItems = await schedulerCalendar.getCalendar(clientName);
    if (!calendarItems.length) {
        throw new Error("Client has no calendar. Generate a calendar first.");
    }
    const cal = { calendar: calendarItems };

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

        // Festive days already have a ready-made prompt from calendar generation —
        // skip the extra ChatGPT round-trip and use it directly.
        let basePrompt = (item.isFestive && item.prompt && item.prompt.trim())
            ? item.prompt.trim()
            : await dailyCron.buildImagePrompt(client, item);
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

    // Capture for regenerate/replace flow — if already in Drive, delete after
    // the new upload succeeds.
    let oldDriveFileId = asset.driveFileId;

    // If the asset row itself doesn't know about an existing Drive file (e.g. a
    // brand-new single-post regeneration, or the row was recreated), look in the
    // Drive folder for a file with the SAME name and treat it as the one to
    // replace. This guarantees "generate one post" overwrites the existing post
    // of that date instead of leaving a duplicate.
    if (!oldDriveFileId) {
        try {
            const existingFiles = await drive.listFiles(folderId);
            const match = existingFiles.find(f => f.name === asset.fileName);
            if (match) {
                oldDriveFileId = match.id;
                console.log(
                    `[weekly] found existing Drive file "${asset.fileName}" ` +
                    `(${match.id}) — will replace it`
                );
            }
        } catch (e) {
            console.log(`[weekly] could not list Drive folder to dedupe: ${e.message}`);
        }
    }

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

    // Festive days already have a ready-made prompt from calendar generation —
    // skip the extra ChatGPT round-trip and use it directly.
    let basePrompt = (item.isFestive && item.prompt && item.prompt.trim())
        ? item.prompt.trim()
        : await dailyCron.buildImagePrompt(client, item);
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

/* ============================================================
   GENERATE ONE — queue a single post for one calendar item.

   Used by the dashboard's per-day "Generate Creative" button.
   It behaves exactly like one slice of generateWeek: a Prompt
   with weeklyContext is queued for Tampermonkey, and a DriveAsset
   row tracks it. When the image arrives, onImageGeneratedForWeekly
   uploads it to Drive — REPLACING any existing file of the same
   date/filename (handled by the same-filename lookup above).
============================================================ */

async function generateOne(clientName, item) {

    const client = await Client.findOne({ name: clientName }).lean();
    if (!client) throw new Error("Client not found: " + clientName);

    const folderId = drive.extractFolderId(client.driveFolderUrl || "");
    if (!folderId) {
        throw new Error("Client has no Drive folder URL. Edit the client and paste a Drive folder link.");
    }

    if (!await drive.isConfigured()) {
        throw new Error("Google Drive not configured. Go to Settings.");
    }

    if (!item || !(item.topic || item.date)) {
        throw new Error("No calendar item provided");
    }

    const dateStr = (item.date || "").slice(0, 10) || fmtYMD(new Date());
    const ws = weekStartFromToday();

    // Build the prompt for this single item
    // Festive days already have a ready-made prompt from calendar generation —
    // skip the extra ChatGPT round-trip and use it directly.
    let basePrompt = (item.isFestive && item.prompt && item.prompt.trim())
        ? item.prompt.trim()
        : await dailyCron.buildImagePrompt(client, item);
    if (!basePrompt || !basePrompt.trim()) {
        throw new Error("Could not generate image prompt (Groq failed). Try again.");
    }
    const fullPrompt = dailyCron.augmentPrompt(basePrompt, client);

    // Re-queue: if an asset for this date already exists, reuse the row so the
    // SAME filename is kept and the Drive file is replaced rather than duplicated.
    let asset = await DriveAsset.findOne({ client: clientName, calendarDate: dateStr });

    const sanitizedName = drive.sanitizeFileName(item.topic || dateStr) + ".png";

    // Cancel any leftover un-generated prompt this asset was holding
    if (asset?.promptId) {
        await Prompt.deleteMany({ _legacyId: asset.promptId, generated: false });
    }

    const prompt = await Prompt.create({
        _legacyId: Date.now() + Math.floor(Math.random() * 1000),
        client:    clientName,
        prompt:    fullPrompt,
        source:    "single-post",
        generated: false,
        error:     JSON.stringify({
            weeklyContext: {
                weekStart:    asset?.weekStart || ws,
                calendarDate: dateStr,
                topic:        item.topic,
                goal:         item.goal,
                event:        item.event
            }
        })
    });

    if (asset) {
        // Keep driveFileId so the existing Drive file is replaced on upload.
        asset.topic    = item.topic || asset.topic;
        asset.fileName = asset.fileName || sanitizedName;
        asset.status   = "queued";
        asset.promptId = prompt._legacyId;
        asset.error    = "";
        await asset.save();
    } else {
        asset = await DriveAsset.create({
            client:           clientName,
            weekStart:        ws,
            calendarDate:     dateStr,
            topic:            item.topic,
            fileName:         sanitizedName,
            captionSignature: captionSig(clientName, sanitizedName),
            status:           "queued",
            promptId:         prompt._legacyId
        });
    }

    return {
        client:   clientName,
        date:     dateStr,
        topic:    item.topic,
        status:   "queued",
        assetId:  asset._id.toString(),
        promptId: prompt._legacyId
    };
}

/* ============================================================
   PUSH TO DRIVE — re-upload an asset that already has an image
   (cloudinaryUrl) but never made it into Drive.

   Covers two cases the dashboard exposes:
     - status "failed"     → the Drive upload itself failed
     - status "queued"/"generating" with a cloudinaryUrl present
       (image was generated but the upload step was interrupted)

   No regeneration / no Tampermonkey round-trip — we just push the
   bytes we already have straight to Drive.
============================================================ */

async function pushToDrive(assetId) {

    const asset = await DriveAsset.findById(assetId);
    if (!asset) throw new Error("Asset not found");

    if (asset.status === "in-drive" && asset.driveFileId) {
        return { success: true, alreadyInDrive: true, assetId: asset._id.toString() };
    }

    if (!asset.cloudinaryUrl) {
        throw new Error(
            "This asset has no generated image to push. Use 🔄 Regenerate to create one first."
        );
    }

    const r = await onImageGeneratedForWeekly({
        client:        asset.client,
        image:         null,
        cloudinaryUrl: asset.cloudinaryUrl,
        weeklyContext: {
            weekStart:    asset.weekStart,
            calendarDate: asset.calendarDate,
            topic:        asset.topic,
            goal:         "",
            event:        ""
        }
    });

    return {
        success:   true,
        assetId:   asset._id.toString(),
        driveLink: r.asset?.driveFileLink || ""
    };
}

/* ============================================================
   GENERATE ALL CLIENTS — the Saturday automation.

   Loops every client and calls generateWeek() for each, so the
   whole upcoming week is queued for every client in one shot.
   Returns a per-client summary. Errors on one client never stop
   the others.
============================================================ */

async function generateAllClients() {

    const clients = await Client.find({}).lean();
    const results = [];

    for (const c of clients) {

        try {
            const r = await generateWeek(c.name);
            const queuedCount = r.queued.filter(q => q.status === "queued").length;
            results.push({
                client: c.name,
                status: "ok",
                queued: queuedCount,
                detail: r.queued
            });
            console.log(`[saturday] ${c.name}: queued ${queuedCount} post(s)`);
        } catch (e) {
            results.push({ client: c.name, status: "error", error: e.message });
            console.log(`[saturday] ${c.name}: ERROR ${e.message}`);
        }

        // Small gap so we don't hammer Groq's rate limit across clients
        await new Promise(r => setTimeout(r, 400));
    }

    return { ranAt: new Date().toISOString(), clients: results };
}

module.exports = {
    generateWeek,
    generateOne,
    pushToDrive,
    generateAllClients,
    onImageGeneratedForWeekly,
    regenerateAsset
};
