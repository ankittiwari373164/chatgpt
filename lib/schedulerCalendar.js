// lib/schedulerCalendar.js
//
// Calendar topic generation runs on Groq; calendar STORAGE lives in this
// app's own MongoDB (the `Calendar` collection in db/models.js). The external
// scheduler app (SCHEDULER_URL / Supabase) is no longer used at all — this
// removes the dependency on that service and its storage quota.
//
// The `Calendar` collection stores ONE document per client:
//   { client: "Manofox", calendar: [ {date,event,topic,goal,done}, ... ] }
//
// This module maps that document to/from the flat {date,event,topic,goal,done}
// shape that server.js, dailyCron.js and weeklyBatch.js already expect, so
// those files don't need to change.

const { Calendar } = require("../db/models");

const GROQ_API_KEY  = process.env.GROQ_API_KEY;
const GROQ_API_BASE = "https://api.groq.com/openai/v1";

// Groq chat model used for generating topic/event/goal ideas. Override with
// GROQ_MODEL in .env if your account has access to a different one. Groq
// rotates models periodically; if you get a 404 "model does not exist / no
// access", check https://console.groq.com/docs/models and set GROQ_MODEL.
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

/* ============================================================
   GROQ — topic generation
============================================================ */

async function groqRequest(prompt, model = GROQ_MODEL) {
    if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured");

    const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
            max_tokens: 4000
        })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(`Groq API error (${res.status}): ${data.error?.message || "Unknown error"}`);
    }
    return data.choices?.[0]?.message?.content || "";
}

// Parse Groq's JSON array response, with a regex fallback for when the model
// returns slightly malformed JSON (unescaped quotes/newlines inside strings).
function parseGroqTopics(content) {
    let txt = String(content).replace(/```json|```/g, "").trim();

    const start = txt.indexOf("[");
    const end   = txt.lastIndexOf("]") + 1;

    if (start >= 0 && end > 0) {
        const slice = txt.substring(start, end);
        try { return JSON.parse(slice); } catch (_) {}
        try { return JSON.parse(slice.replace(/[\x00-\x1F\x7F]/g, " ")); } catch (_) {}
    }

    // Fallback: pull out each {…} object individually
    const out = [];
    const objRe = /\{[^{}]*\}/g;
    let m;
    while ((m = objRe.exec(txt)) !== null) {
        try {
            const obj = JSON.parse(m[0].replace(/[\x00-\x1F\x7F]/g, " "));
            if (obj && (obj.topic || obj.event)) out.push(obj);
        } catch (_) {
            const o = {};
            const fieldRe = /"(\w+)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
            let f;
            while ((f = fieldRe.exec(m[0])) !== null) {
                o[f[1]] = f[2].replace(/\\n/g, "\n").replace(/\\"/g, '"');
            }
            if (o.topic || o.event) out.push(o);
        }
    }
    return out;
}

// Generate `count` fresh topic/event/goal ideas via Groq. Returns raw items
// WITHOUT dates assigned yet — caller (server.js) applies its own postDays
// weekday logic and then calls `saveCalendar` with the final dated array.
async function generateTopics({ clientName, businessDetails, count, chatLink }) {
    const prompt = `
Generate a one-month social media content calendar as a JSON array.

Business details:
${businessDetails || "General business"}

Generate EXACTLY ${count} content items. Each item must be conceptual, bold, and
specific to this business — not generic stock-photo ideas.

Return a JSON ARRAY ONLY, no commentary, using this exact shape:
[ { "event": "", "topic": "", "goal": "" } ]

- "event": a short hook or occasion for the post
- "topic": the specific creative concept for the post
- "goal": the business objective this post serves
`.trim();

    const response = await groqRequest(prompt);
    const items = parseGroqTopics(response);

    if (!Array.isArray(items) || items.length === 0) {
        throw new Error("Groq returned an unparseable calendar. Click again to retry.");
    }

    return items.slice(0, count).map(r => ({
        event: String(r.event || "").trim(),
        topic: String(r.topic || "").trim(),
        goal:  String(r.goal  || "").trim(),
        isFestive: !!r.isFestive,
        prompt: r.prompt || ""
    }));
}

/* ============================================================
   MONGODB — calendar storage (Calendar collection)
============================================================ */

// Mirrors the old `Calendar.findOne({ client }).calendar` array.
// Returns [] if this client has no saved calendar yet.
async function getCalendar(clientName) {
    const doc = await Calendar.findOne({ client: clientName }).lean();
    if (!doc || !Array.isArray(doc.calendar)) return [];

    return doc.calendar.map(item => ({
        _id:   item._id,
        date:  item.date  || "",
        event: item.event || "",
        topic: item.topic || "",
        goal:  item.goal  || "",
        done:  !!item.done,
        prompt: item.prompt || "",
        isFestive: !!item.isFestive
    }));
}

// Persist the final {date,event,topic,goal} array (after local weekday
// scheduling has assigned real dates) — replaces this client's calendar.
async function saveCalendar(clientName, calendar) {
    const cleaned = (calendar || []).map(item => ({
        date:  item.date  || "",
        event: item.event || "",
        topic: item.topic || "",
        goal:  item.goal  || "",
        done:  !!item.done,
        prompt: item.prompt || "",
        isFestive: !!item.isFestive
    }));

    await Calendar.findOneAndUpdate(
        { client: clientName },
        { $set: { calendar: cleaned } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return getCalendar(clientName);
}

// Mark one item done (dailyCron progress tracking). itemId is the subdocument
// _id returned in getCalendar() as `_id`.
async function markDone(itemId) {
    return Calendar.updateOne(
        { "calendar._id": itemId },
        { $set: { "calendar.$.done": true } }
    );
}

async function deleteClientCalendar(clientName) {
    const r = await Calendar.deleteOne({ client: clientName });
    return r.deletedCount || 0;
}

module.exports = { getCalendar, generateTopics, saveCalendar, markDone, deleteClientCalendar };
