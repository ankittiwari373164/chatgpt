// lib/schedulerCalendar.js
// Enhanced version with direct Groq integration for calendar generation
// Uses Groq API for topic/event/goal generation instead of relying on external scheduler API

const BASE = (process.env.SCHEDULER_URL || "").replace(/\/$/, "");
const PROGRAM = "chatgpt";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_BASE = "https://api.groq.com/openai/v1";

function assertConfigured() {
    if (!BASE && !process.env.GROQ_ENABLED) {
        throw new Error("SCHEDULER_URL env var is not set or GROQ_ENABLED is false — cannot reach calendar API");
    }
    if (process.env.GROQ_ENABLED && !GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY env var is not set — required for calendar generation");
    }
}

async function req(path, opts = {}) {
    if (!BASE) throw new Error("SCHEDULER_URL env var is not set — cannot reach the scheduler's calendar API");
    const res = await fetch(`${BASE}${path}`, {
        ...opts,
        headers: { "Content-Type": "application/json", ...(opts.headers || {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `scheduler request failed (${res.status})`);
    return data;
}

async function groqRequest(prompt, model = "mixtral-8x7b-32768") {
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
            max_tokens: 2000
        })
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(`Groq API error (${res.status}): ${data.error?.message || "Unknown error"}`);
    }
    return data.choices[0]?.message?.content || "";
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

// Parse JSON response from Groq with fallback to structured text parsing
function parseGroqCalendarResponse(content) {
    try {
        // Try to extract JSON from the response
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    } catch (e) {
        console.warn("Failed to parse JSON from Groq response, attempting text parsing");
    }

    // Fallback: parse structured text response
    const items = [];
    const eventMatches = content.match(/Event:\s*(.+?)(?=Topic:|$)/gi);
    const topicMatches = content.match(/Topic:\s*(.+?)(?=Goal:|$)/gi);
    const goalMatches = content.match(/Goal:\s*(.+?)(?=Event:|Prompt:|$)/gi);
    const promptMatches = content.match(/Prompt:\s*(.+?)(?=Event:|$)/gi);

    if (eventMatches && topicMatches && goalMatches) {
        const count = Math.min(eventMatches.length, topicMatches.length, goalMatches.length);
        for (let i = 0; i < count; i++) {
            items.push({
                event: (eventMatches[i] || "").replace(/Event:\s*/i, "").trim(),
                topic: (topicMatches[i] || "").replace(/Topic:\s*/i, "").trim(),
                goal: (goalMatches[i] || "").replace(/Goal:\s*/i, "").trim(),
                prompt: promptMatches && promptMatches[i] ? 
                    promptMatches[i].replace(/Prompt:\s*/i, "").trim() : ""
            });
        }
    }

    return items.length > 0 ? items : [{ event: "", topic: "", goal: "", prompt: "" }];
}

// Generate `count` fresh topic/event/goal ideas via Groq
// Returns raw items WITHOUT dates assigned yet — caller (server.js) applies 
// its own postDays weekday logic and then calls `saveCalendar` with the final dated array.
async function generateTopics({ clientName, businessDetails, count, chatLink }) {
    // Check if Groq is enabled
    if (!process.env.GROQ_ENABLED || !GROQ_API_KEY) {
        // Fall back to scheduler API if available
        if (BASE) {
            return await generateTopicsFromScheduler({ clientName, businessDetails, count, chatLink });
        }
        throw new Error("Groq is not enabled and no fallback scheduler URL is configured");
    }

    const prompt = `You are a content calendar generator for a business. Generate ${count} unique, engaging calendar items for the following business:

Business Details: ${businessDetails || "General business"}
Client Name: ${clientName}
Chat Link: ${chatLink || "N/A"}

For each item, provide:
1. Event: A specific event or content piece
2. Topic: The main topic or theme
3. Goal: The business objective for this content
4. Prompt: (Optional) A detailed image generation prompt if this is visual content

Format your response as a JSON array with exactly ${count} objects, or if you prefer text format, clearly label each item with Event:, Topic:, Goal:, and Prompt:.

Example JSON format:
[
  {
    "event": "Summer Sale Kickoff",
    "topic": "Seasonal Marketing",
    "goal": "Drive sales and brand awareness",
    "isFestive": false,
    "prompt": ""
  }
]

Generate diverse, relevant content ideas that would resonate with the business and drive engagement.`;

    const response = await groqRequest(prompt);
    const items = parseGroqCalendarResponse(response);

    return items.map(r => ({
        event: r.event || "",
        topic: r.topic || "",
        goal: r.goal || "",
        isFestive: !!(r.isFestive),
        prompt: r.prompt || ""      // pre-built festive image prompt, empty on normal days
    })).slice(0, count);  // Ensure we only return the requested count
}

// Fallback to scheduler API if available
async function generateTopicsFromScheduler({ clientName, businessDetails, count, chatLink }) {
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
        prompt: r.prompt || ""
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
