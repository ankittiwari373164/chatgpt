/* ============================================================
   Mongoose schemas. Mirrors the structure of the old JSON
   files so all existing code paths keep working.

   The `_legacyId` field stores the original numeric id from
   the JSON file (Date.now() values) so old front-end code that
   references posts by their numeric id keeps working.
============================================================ */

const { mongoose } = require("./connect");
const { Schema }   = mongoose;

/* ---------- CLIENT ---------- */

const ClientSchema = new Schema({
    name:        { type: String, required: true, index: true },
    industry:    String,
    tone:        String,
    audience:    String,
    services:    String,
    style:       String,
    cta:         String,
    description: String,
    website:     String,
    postSize:    { type: String, default: "1:1" },
    postDays:    { type: String, default: "mwf" },
    logoUrl:     String,
    footerUrl:   String,
    samplePosts: [String],           // array of Cloudinary URLs for style references
    chatLink:    String,             // permanent ChatGPT chat URL (https://chatgpt.com/c/<id>)
    productsCache: {
        items:     [Schema.Types.Mixed],
        scrapedAt: Date,
        source:    String
    },
    createdAt:   { type: Date, default: Date.now }
}, { timestamps: true });

/* ---------- PROMPT (queue) ---------- */

const PromptSchema = new Schema({
    _legacyId:  { type: Number, index: true },
    client:     { type: String, required: true },
    prompt:     { type: String, required: true },
    generated:  { type: Boolean, default: false, index: true },
    source:     { type: String, default: "manual" }, // "manual" | "cron" | "calendar"
    image:      String,
    error:      String,
    claimedAt:  { type: Date, default: null }, // null = available; Date = locked by Tampermonkey
    attempts:   { type: Number, default: 0 },
    createdAt:  { type: Date, default: Date.now }
}, { timestamps: true });

/* ---------- POST (generated image + caption) ---------- */

const PostSchema = new Schema({
    _legacyId:    { type: Number, index: true },
    client:       { type: String, index: true },
    prompt:       String,
    image:        String,            // Cloudinary URL
    caption:      String,
    hashtags:     String,
    status:       { type: String, default: "generated" },
    scheduled:    { type: Boolean, default: false, index: true },
    scheduleTime: String,
    source:       { type: String, default: "tampermonkey" },
                  // "tampermonkey" | "puppeteer" | "pollinations" | "cron"
    createdAt:    { type: Date, default: Date.now }
}, { timestamps: true });

/* ---------- SCHEDULED (per-page schedule attempts) ---------- */

const ScheduledSchema = new Schema({
    _legacyId:    Number,
    postId:       Number,
    client:       { type: String, index: true },
    page:         String,
    image:        String,
    caption:      String,
    hashtags:     String,
    scheduleTime: String,
    platform:     String,
    fbPostId:     String,
    igPostId:     String,
    errors:       [String],
    status:       String
}, { timestamps: true, suppressReservedKeysWarning: true });

/* ---------- CALENDAR (per-client month plan) ---------- */

const CalendarSchema = new Schema({
    client:   { type: String, required: true, index: true },
    calendar: [{
        date:  String,
        event: String,
        topic: String,
        goal:  String,
        done:  { type: Boolean, default: false } // tracks daily-cron progress
    }]
}, { timestamps: true });

/* ---------- SESSION (Puppeteer cookies) ---------- */

const SessionSchema = new Schema({
    name:     { type: String, unique: true }, // e.g. "chatgpt"
    cookies:  Schema.Types.Mixed,             // raw cookie array
    storage:  Schema.Types.Mixed,             // localStorage dump
    updatedAt:{ type: Date, default: Date.now }
});

/* ---------- META PAGE CACHE ---------- */

const MetaPageSchema = new Schema({
    pageId:          { type: String, unique: true },
    pageName:        String,
    pageAccessToken: String,
    instagramId:     String,
    refreshedAt:     { type: Date, default: Date.now }
});

/* ---------- DAILY-RUN LOG ---------- */

const RunLogSchema = new Schema({
    runAt:   { type: Date, default: Date.now, index: true },
    type:    String, // "daily-cron" | "manual"
    summary: String,
    detail:  Schema.Types.Mixed
});

/* ---------- DASHBOARD ACTIVITY LOG ---------- */

const LogSchema = new Schema({
    at:      { type: Date, default: Date.now, index: true },
    level:   { type: String, default: "info" }, // "ok" | "info" | "warn" | "err"
    message: String
});

LogSchema.index({ at: -1 });

/* ---------- INSTAGRAM PUBLISH QUEUE ---------- */
/* Each pending IG post: jobId, scheduled time, media URL + caption,
   the IG account ID + page token to call media_publish with. The
   server holds a setTimeout per pending job and fires it at the
   right moment. Server restart → rearmIgQueue() re-schedules them. */

const IgQueueSchema = new Schema({
    jobId:       { type: String, required: true, unique: true, index: true },
    client:      { type: String, index: true },
    postId:      Number,                // _legacyId of the Post that created this
    pageName:    String,                // human-readable for dashboard
    accountName: String,                // e.g. "@brandhandle" for dashboard
    igId:        String,                // IG Business Account ID
    pageId:      String,                // FB Page ID (parent)
    fbToken:     String,                // page token for IG publishing
    caption:     String,
    hashtags:    String,
    mediaUrl:    String,                // publicly accessible URL (Cloudinary)
    mediaType:   { type: String, default: "image" },  // "image" | "video"
    scheduledAt: { type: Date, required: true, index: true },
    status:      { type: String, default: "pending", index: true },
                 // "pending" | "processing" | "done" | "failed" | "canceled"
    metaPostId:  String,                // populated on success
    error:       String,                // populated on failure
    attempts:    { type: Number, default: 0 },
    createdAt:   { type: Date, default: Date.now }
});

module.exports = {
    Client:    mongoose.model("Client",    ClientSchema),
    Prompt:    mongoose.model("Prompt",    PromptSchema),
    Post:      mongoose.model("Post",      PostSchema),
    Scheduled: mongoose.model("Scheduled", ScheduledSchema),
    Calendar:  mongoose.model("Calendar",  CalendarSchema),
    Session:   mongoose.model("Session",   SessionSchema),
    MetaPage:  mongoose.model("MetaPage",  MetaPageSchema),
    RunLog:    mongoose.model("RunLog",    RunLogSchema),
    Log:       mongoose.model("Log",       LogSchema),
    IgQueue:   mongoose.model("IgQueue",   IgQueueSchema)
};