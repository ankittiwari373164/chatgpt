// lib/schedulerCalendar.js
// chatgpt-main no longer owns a Mongo `Calendar` collection. Topic/event/goal
// generation and storage happen in the scheduler app (MetaFlow), in the same
// Supabase `calendar_items` table used by the omni_flow program. This module
// calls that API and maps rows back into the {date,event,topic,goal,done}
// shape dailyCron.js / weeklyBatch.js already expect, so those files don't
// need to change.
//
// Requires SCHEDULER_URL in .env, e.g. https://your-scheduler.vercel.app

const BASE = (process.env.SCHEDULER_URL || "").replace(/\/$/, "");
const PROGRAM = "chatgpt";

function assertConfigured() {
    if (!BASE) throw new Error("SCHEDULER_URL env var is not set — cannot reach the scheduler's calendar API");
}

async function req(path, opts = {}) {
    assertConfigured();
    const res = await fetch(`${BASE}${path}`, {
        ...opts,
        headers: { "Content-Type": "application/json", ...(opts.headers || {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `scheduler request failed (${res.status})`);
    return data;
}

function toLegacyShape(row) {
    return {
        _id:   row.id,           // Supabase uuid, replaces the old Mongo subdocument identity
        date:  row.scheduled_date,
        event: row.event || "",
        topic: row.topic || "",
        goal:  row.goal || "",
        done:  !!row.done,
        prompt: row.prompt || "",                       // pre-built festive image prompt, if any
        isFestive: !!(row.meta && row.meta.isFestive)
    };
}

// Mirrors the old `Calendar.findOne({ client }).calendar` array.
async function getCalendar(clientName) {
    const rows = await req(`/api/calendar?program=${PROGRAM}&clientId=${encodeURIComponent(clientName)}`);
    return rows.map(toLegacyShape);
}

// Generate `count` fresh topic/event/goal ideas via the scheduler (same Groq
// routine used for the omni program). Returns raw items WITHOUT dates
// assigned yet — caller (server.js) applies its own postDays weekday logic
// and then calls `saveCalendar` with the final dated array.
async function generateTopics({ clientName, businessDetails, count, chatLink }) {
    const rows = await req(`/api/calendar/generate`, {
        method: "POST",
        body: JSON.stringify({
            program: PROGRAM, clientId: clientName, clientName,
            businessDetails, days: count, chatLink
        })
    });
    return rows.map(r => ({
        event: r.event || "",
        topic: r.topic || "",
        goal: r.goal || "",
        isFestive: !!(r.meta && r.meta.isFestive),
        prompt: r.prompt || ""      // pre-built festive image prompt, empty on normal days
    }));
}

// Persist the final {date,event,topic,goal} array (after local weekday
// scheduling has assigned real dates) — replaces this client's calendar.
async function saveCalendar(clientName, calendar) {
    // Clear whatever the generate() call above stored (it used placeholder
    // consecutive dates) and re-insert with the correct scheduled dates.
    const existing = await req(`/api/calendar?program=${PROGRAM}&clientId=${encodeURIComponent(clientName)}`);
    for (const row of existing) {
        await req(`/api/calendar/${row.id}`, { method: "DELETE" }).catch(() => {});
    }
    for (const item of calendar) {
        await req(`/api/calendar`, {
            method: "POST",
            body: JSON.stringify({
                program: PROGRAM, clientId: clientName, clientName,
                scheduled_date: item.date, topic: item.topic,
                event: item.event, goal: item.goal, status: "planned",
                prompt: item.prompt || null,
                meta: item.isFestive !== undefined ? { isFestive: !!item.isFestive } : undefined
            })
        });
    }
    return getCalendar(clientName);
}

// Mark one item done (dailyCron progress tracking).
async function markDone(itemId) {
    return req(`/api/calendar/${itemId}`, { method: "PATCH", body: JSON.stringify({ done: true, status: "done" }) });
}

async function deleteClientCalendar(clientName) {
    const existing = await req(`/api/calendar?program=${PROGRAM}&clientId=${encodeURIComponent(clientName)}`).catch(() => []);
    for (const row of existing) {
        await req(`/api/calendar/${row.id}`, { method: "DELETE" }).catch(() => {});
    }
    return existing.length;
}

module.exports = { getCalendar, generateTopics, saveCalendar, markDone, deleteClientCalendar };
