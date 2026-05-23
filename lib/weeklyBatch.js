/* ============================================================
   weeklyBatch.js — the new core flow.

   Two operations:

   1. generateWeek(clientName)
      - Reads next 7 days of calendar for the client
      - Filters to client's postDays
      - For each entry: creates a DriveAsset with status=queued
                       + a Prompt for Tampermonkey with weeklyContext
      - Tampermonkey processes them serially

   2. approveAndSchedule(clientName)
      - Lists the client's Drive folder NOW (live state, not snapshot)
      - For each file in the folder:
          - Match to an existing DriveAsset by fileName
          - If filename is new/changed → regenerate caption via Groq
          - Build FB+IG queue jobs at the right calendar times
      - Mark assets as scheduled
      - Files that were removed from Drive are NOT scheduled
============================================================ */

const crypto = require("crypto");
const axios  = require("axios");

const {
    Client, Calendar, Prompt, DriveAsset, IgQueue, FbQueue
} = require("../db/models");

const drive = require("./drive");
const dailyCron = require("./dailyCron");  // for buildImagePrompt, buildCaption, augmentPrompt
const { findPageForClient, scheduleOnePost, getAllMetaPages } = require("./meta");

/* ============================================================
   Date helpers (IST)
============================================================ */

function todayIST() {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
}

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
    // Monday of the current ISO week (or today if today is Monday)
    const d = new Date();
    const day = d.getDay();           // 0=Sun, 1=Mon
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

/* ============================================================
   GENERATE WEEK — queue Tampermonkey prompts for the next 7
   posting days for this client.
============================================================ */

async function generateWeek(clientName) {

    const client = await Client.findOne({ name: clientName }).lean();
    if (!client) throw new Error("Client not found: " + clientName);

    // 1. Validate Drive folder
    const folderId = drive.extractFolderId(client.driveFolderUrl || "");
    if (!folderId) {
        throw new Error("Client has no Drive folder URL set. Edit the client and paste a Drive folder link.");
    }

    if (!await drive.isConfigured()) {
        throw new Error("Google Service Account not configured. Go to Settings.");
    }

    // 2. Load calendar
    const cal = await Calendar.findOne({ client: clientName }).lean();
    if (!cal?.calendar?.length) {
        throw new Error("Client has no calendar. Generate a calendar first.");
    }

    // 3. Resolve allowed weekdays from postDays
    const allowedDays = {
        mwf:    new Set([1, 3, 5]),
        mtwtfs: new Set([1, 2, 3, 4, 5, 6]),
        daily:  new Set([0, 1, 2, 3, 4, 5, 6])
    };
    const allowed = allowedDays[client.postDays || "mwf"];

    // 4. Pick the upcoming dates we want to fill
    const next7 = nextNDaysFromToday(14); // look 14 days ahead, take first 7 matching
    const targetDates = next7.filter(dateStr => {
        const d = new Date(dateStr + "T00:00:00Z");
        return allowed.has(d.getUTCDay());
    }).slice(0, 7);

    if (!targetDates.length) {
        throw new Error("No posting days found in next 14 days for this client");
    }

    // 5. For each date, find/create a calendar item, then queue
    const ws = weekStartFromToday();
    const queued = [];

    for (const dateStr of targetDates) {

        // Find calendar item by date, or fall back to nearest unfinished
        let item = cal.calendar.find(x =>
            (x.date || "").slice(0, 10) === dateStr
        );

        if (!item) {
            // Create a placeholder calendar item for that date
            item = {
                date:  dateStr,
                topic: `Post for ${dateStr}`,
                goal:  "",
                event: ""
            };
        }

        // De-dupe: if a DriveAsset already exists for this client/date that
        // hasn't been published yet, skip (avoids re-queueing on re-runs)
        const existing = await DriveAsset.findOne({
            client:       clientName,
            calendarDate: dateStr,
            status:       { $nin: ["published", "failed"] }
        });

        if (existing) {
            queued.push({ date: dateStr, status: "already-queued", topic: item.topic });
            continue;
        }

        // Build the prompt
        let basePrompt = await dailyCron.buildImagePrompt(client, item);
        if (!basePrompt || !basePrompt.trim()) {
            queued.push({ date: dateStr, status: "skipped", reason: "Groq failed" });
            continue;
        }
        const fullPrompt = dailyCron.augmentPrompt(basePrompt, client);

        // Create the Prompt for Tampermonkey
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

        // Create the DriveAsset stub
        const sanitizedName = drive.sanitizeFileName(item.topic || dateStr) + ".png";
        const asset = await DriveAsset.create({
            client:       clientName,
            weekStart:    ws,
            calendarDate: dateStr,
            topic:        item.topic,
            fileName:     sanitizedName,
            captionSignature: captionSig(clientName, sanitizedName),
            status:       "queued",
            promptId:     prompt._legacyId
        });

        queued.push({
            date:   dateStr,
            status: "queued",
            topic:  item.topic,
            assetId: asset._id.toString()
        });

        // Stagger Prompt timestamps slightly so Tampermonkey processes
        // them in date order
        await new Promise(r => setTimeout(r, 5));
    }

    return {
        client:    clientName,
        weekStart: ws,
        queued
    };
}

/* ============================================================
   onImageGeneratedForWeekly — called from handleSavePost when
   the Tampermonkey result has weeklyContext. Uploads the image
   to the client's Drive folder + writes caption to file
   description.
============================================================ */

async function onImageGeneratedForWeekly({
    client: clientName,
    image,                        // base64 data URL OR Cloudinary URL
    cloudinaryUrl,                // post-upload URL if available
    weeklyContext
}) {

    const client = await Client.findOne({ name: clientName }).lean();
    if (!client) throw new Error("Client not found: " + clientName);

    const folderId = drive.extractFolderId(client.driveFolderUrl || "");
    if (!folderId) throw new Error("Client has no Drive folder URL");

    const { calendarDate, topic, weekStart } = weeklyContext;

    // Find or create the matching DriveAsset
    let asset = await DriveAsset.findOne({
        client:       clientName,
        calendarDate,
        status:       { $in: ["queued", "generating", "failed"] }
    });

    if (!asset) {
        asset = await DriveAsset.create({
            client:       clientName,
            weekStart:    weekStart || weekStartFromToday(),
            calendarDate,
            topic,
            fileName:     drive.sanitizeFileName(topic || calendarDate) + ".png",
            captionSignature: captionSig(clientName, drive.sanitizeFileName(topic || calendarDate) + ".png"),
            status:       "generating"
        });
    }

    asset.status = "generating";
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

        // 2. Generate caption upfront so it can be stored in Drive description
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

        // 3. Build the Drive file description
        const desc =
            (cap.caption || "") +
            "\n\n" +
            (cap.hashtags || "") +
            "\n\n---\n" +
            `[topic] ${topic || ""}\n` +
            `[date] ${calendarDate}\n` +
            `[client] ${clientName}\n` +
            `[signature] ${asset.captionSignature}`;

        // 4. Upload to Drive
        const file = await drive.uploadFile({
            folderId,
            name:        asset.fileName,
            mimeType:    "image/png",
            buffer:      imageBuffer,
            description: desc
        });

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
   APPROVE AND SCHEDULE
============================================================ */

async function approveAndSchedule(clientName) {

    const client = await Client.findOne({ name: clientName }).lean();
    if (!client) throw new Error("Client not found: " + clientName);

    const folderId = drive.extractFolderId(client.driveFolderUrl || "");
    if (!folderId) throw new Error("Client has no Drive folder URL");

    const pages = await getAllMetaPages();
    const page  = findPageForClient(clientName, pages);
    if (!page) throw new Error("No matching Meta page for client");

    // 1. List Drive folder NOW (live state, not stored snapshot)
    const driveFiles = await drive.listFiles(folderId);

    if (!driveFiles.length) {
        return { client: clientName, scheduled: 0, items: [], reason: "Drive folder is empty" };
    }

    // 2. Get all DriveAssets for this client that are in-drive
    const existingAssets = await DriveAsset.find({
        client: clientName,
        status: { $in: ["in-drive", "approved"] }
    }).lean();

    const assetByFileName = new Map();
    existingAssets.forEach(a => assetByFileName.set(a.fileName, a));

    // 3. Compute schedule dates (next N posting days from today)
    const allowedDays = {
        mwf:    new Set([1, 3, 5]),
        mtwtfs: new Set([1, 2, 3, 4, 5, 6]),
        daily:  new Set([0, 1, 2, 3, 4, 5, 6])
    };
    const allowed = allowedDays[client.postDays || "mwf"];

    const next14 = nextNDaysFromToday(14);
    const targetDates = next14.filter(dateStr => {
        const d = new Date(dateStr + "T00:00:00Z");
        return allowed.has(d.getUTCDay());
    }).slice(0, driveFiles.length);

    // 4. Schedule each Drive file to the next available calendar date
    const scheduled = [];

    for (let i = 0; i < driveFiles.length; i++) {

        const file     = driveFiles[i];
        const dateStr  = targetDates[i];

        if (!dateStr) {
            scheduled.push({ name: file.name, status: "skipped", reason: "ran out of posting days" });
            continue;
        }

        // Find or upsert asset
        let asset = assetByFileName.get(file.name);
        if (!asset) {
            // This file was added to Drive after the batch — create a fresh asset
            asset = {
                client:       clientName,
                weekStart:    weekStartFromToday(),
                calendarDate: dateStr,
                topic:        file.name.replace(/\.[^.]+$/, ""),
                fileName:     file.name,
                driveFileId:  file.id,
                driveFileLink: file.webViewLink || "",
                captionSignature: ""  // empty → forces regenerate
            };
        }

        // Decide if we need to regenerate the caption
        const newSig = captionSig(clientName, file.name);
        const needsCaptionRegen = asset.captionSignature !== newSig
                                 || !asset.caption;

        let caption  = asset.caption  || "";
        let hashtags = asset.hashtags || "";

        if (needsCaptionRegen) {

            try {
                const newTopic = file.name.replace(/\.[^.]+$/, "");
                const cap = await dailyCron.buildCaption(
                    client,
                    { date: dateStr, topic: newTopic, goal: "", event: "" },
                    ""
                );
                caption  = cap.caption  || "";
                hashtags = cap.hashtags || "";

                // Update Drive file description so it stays in sync
                try {
                    const desc =
                        caption + "\n\n" + hashtags + "\n\n---\n" +
                        `[topic] ${newTopic}\n[date] ${dateStr}\n[client] ${clientName}\n[signature] ${newSig}`;
                    await drive.updateFileMetadata(file.id, { description: desc });
                } catch (_) {
                    // Drive metadata update is non-critical
                }

                console.log(`[approve] regenerated caption for ${file.name}`);

            } catch (e) {
                console.log(`[approve] caption regen failed for ${file.name}: ${e.message}`);
            }
        }

        // Download the file from Drive → re-upload to Cloudinary (Meta needs
        // a stable public URL). Skip if we already have a cloudinaryUrl.
        let mediaUrl = asset.cloudinaryUrl;

        if (!mediaUrl) {

            try {
                const buf = await drive.downloadFile(file.id);
                const cloudinary = require("cloudinary").v2;
                const dataUrl = "data:image/png;base64," + buf.toString("base64");
                const up = await cloudinary.uploader.upload(dataUrl, {
                    folder: "ai-content/approved/" + clientName.replace(/[^a-z0-9_-]/gi, "_")
                });
                mediaUrl = up.secure_url;
            } catch (e) {
                scheduled.push({ name: file.name, status: "failed", reason: "Cloudinary re-upload failed: " + e.message });
                continue;
            }
        }

        // Build a synthetic Post object compatible with scheduleOnePost
        const postLike = {
            _legacyId: Date.now() + i,
            client:    clientName,
            image:     mediaUrl,
            caption:   caption,
            hashtags:  hashtags
        };

        // Schedule at 9 AM IST on the target date
        const schedDate = new Date(dateStr + "T09:00:00+05:30");
        const unixTime  = Math.floor(schedDate.getTime() / 1000);

        const result = await scheduleOnePost(postLike, page, unixTime);

        // Persist asset state
        const update = {
            client:        clientName,
            calendarDate:  dateStr,
            topic:         file.name.replace(/\.[^.]+$/, ""),
            fileName:      file.name,
            driveFileId:   file.id,
            driveFileLink: file.webViewLink || "",
            captionSignature: newSig,
            caption,
            hashtags,
            cloudinaryUrl: mediaUrl,
            status:        (result.fb || result.ig) ? "scheduled" : "failed",
            fbJobId:       result.fb || "",
            igJobId:       result.ig || "",
            igStoryJobId:  result.igStory || "",
            error:         (result.errors || []).join("; ").slice(0, 500)
        };

        if (asset._id) {
            await DriveAsset.updateOne({ _id: asset._id }, { $set: update });
        } else {
            await DriveAsset.create(update);
        }

        scheduled.push({
            name:   file.name,
            date:   dateStr,
            status: update.status,
            fb:     result.fb,
            ig:     result.ig
        });
    }

    return {
        client:    clientName,
        scheduled: scheduled.filter(s => s.status === "scheduled").length,
        items:     scheduled
    };
}

module.exports = {
    generateWeek,
    onImageGeneratedForWeekly,
    approveAndSchedule
};