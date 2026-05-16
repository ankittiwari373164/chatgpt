/* ============================================================
   STATE
============================================================ */

let schedulerQueue = [];   // posts currently displayed in file-queue
let metaTargets    = [];   // pages fetched from /meta/pages
let selectedTargets = new Set();  // pageId strings selected
let alreadyAutomated = new Set(); // post.id we've already auto-pushed
let currentFreq = "custom";

/* ============================================================
   AUTOMATION LOG
============================================================ */

function addAutomationLog(message, type = "info") {

    const log = document.getElementById("automationLogs");

    if (!log) return;

    const colors = {
        info: "log-info",
        ok:   "log-ok",
        warn: "log-warn",
        err:  "log-err"
    };

    const time = new Date().toLocaleTimeString();

    const div = document.createElement("div");
    div.className = colors[type] || "log-info";
    div.textContent = `[${time}] ${message}`;

    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

function setAutoStatus(text, on = true) {

    document.getElementById("autoStatusText").textContent = text;

    const banner = document.getElementById("autoBanner");
    banner.classList.toggle("on",  on);
    banner.classList.toggle("off", !on);
}

/* ============================================================
   CLIENTS
============================================================ */

async function loadClients() {

    try {

        const response = await fetch("/clients");
        const clients  = await response.json();

        const select = document.getElementById("clients");
        if (!select) return;

        select.innerHTML = "";

        clients.forEach(client => {

            select.innerHTML +=
                `<option>${client.name}</option>`;
        });

        window.clientsData = clients;

    } catch (e) {

        console.log(e);
    }
}

async function saveClient() {

    const client = {
        name:     document.getElementById("name").value,
        industry: document.getElementById("industry").value,
        tone:     document.getElementById("tone").value,
        audience: document.getElementById("audience").value,
        services: document.getElementById("services").value,
        style:    document.getElementById("style").value,
        cta:      document.getElementById("cta").value
    };

    await fetch("/save-client", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(client)
    });

    loadClients();
}

/* ============================================================
   CALENDAR
============================================================ */

async function generateCalendar() {

    const name = document.getElementById("clients").value;

    const client = (window.clientsData || []).find(
        c => c.name === name.trim()
    );

    if (!client) {

        alert("Pick a client first");
        return;
    }

    const response = await fetch("/generate-calendar", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(client)
    });

    const calendar = await response.json();
    const box      = document.getElementById("calendar");
    if (!box) return;

    box.innerHTML = "";

    calendar.forEach(item => {

        const card = document.createElement("div");
        card.className = "calendar-item";

        card.innerHTML = `
          <h3>${item.topic || ""}</h3>
          <p>${item.date || ""}</p>
          <p>${item.event || ""}</p>
          <p>${item.goal || ""}</p>
        `;

        const btn = document.createElement("button");
        btn.textContent = "Generate Creative";
        btn.onclick = () => generateCreative(client, item);

        card.appendChild(btn);
        box.appendChild(card);
    });
}

async function generateCreative(client, item) {

    const response = await fetch("/generate-prompt", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ client, item })
    });

    const data = await response.json();

    await fetch("/save-prompt", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
            client: client.name,
            prompt: data.prompt
        })
    });

    addAutomationLog(
        "Prompt saved — Tampermonkey will pick it up shortly.",
        "ok"
    );

    localStorage.setItem("client", client.name);
    localStorage.setItem("prompt", data.prompt);
}

/* ============================================================
   META TARGETS
============================================================ */

async function loadMetaTargets() {

    try {

        const response = await fetch("/meta/pages");
        metaTargets    = await response.json();

        renderTargets();

    } catch (e) {

        console.log(e);
        document.getElementById("targetsHelp").textContent =
            "Could not load Meta pages — check META_ACCESS_TOKEN in .env";
    }
}

function renderTargets() {

    const grid = document.getElementById("targetsGrid");
    const help = document.getElementById("targetsHelp");
    if (!grid) return;

    grid.innerHTML = "";

    if (!metaTargets.length) {

        help.textContent =
            "No Meta pages found. Check META_ACCESS_TOKEN in .env.";
        return;
    }

    help.textContent =
        `Found ${metaTargets.length} page(s). Pages are auto-selected per post's client.`;

    metaTargets.forEach(page => {

        const isSelectedFb = selectedTargets.has(page.pageId);
        const isSelectedIg = selectedTargets.has(page.pageId + "_ig");

        const fbTile = document.createElement("div");
        fbTile.className =
            "target-tile" + (isSelectedFb ? " selected" : "");
        fbTile.dataset.pageId = page.pageId;
        fbTile.dataset.kind   = "facebook";
        fbTile.innerHTML = `
          <div class="target-icon">📘</div>
          <div class="target-name">${page.pageName}</div>
          <div class="target-sub">Facebook Page</div>
        `;
        fbTile.onclick = () => toggleTargetTile(fbTile, page.pageId);
        grid.appendChild(fbTile);

        if (page.instagramId) {

            const igTile = document.createElement("div");
            igTile.className =
                "target-tile ig" + (isSelectedIg ? " selected" : "");
            igTile.dataset.pageId = page.pageId;
            igTile.dataset.kind   = "instagram";
            igTile.innerHTML = `
              <div class="target-icon">📸</div>
              <div class="target-name">${page.pageName}</div>
              <div class="target-sub">Instagram Business</div>
            `;
            igTile.onclick = () => toggleTargetTile(igTile, page.pageId + "_ig");
            grid.appendChild(igTile);
        }
    });
}

/* ============================================================
   CLIENT → PAGE MATCHING
   Fuzzy-match a client name against Meta pages, e.g.
     "Manofox"          → "Manofox Pvt."
     "Sehatfull"        → "Sehatfull Foods"
     "Bon Shubharambh"  → "Bon Shubharambh Play School and Day Care"
============================================================ */

function normalizeName(s) {

    return (s || "")
        .toLowerCase()
        .replace(/\b(pvt|ltd|llp|inc|co|company)\.?\b/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function findPageForClient(clientName) {

    if (!clientName || !metaTargets.length) return null;

    const target = normalizeName(clientName);
    if (!target) return null;

    // 1. exact normalized match
    let hit = metaTargets.find(
        p => normalizeName(p.pageName) === target
    );
    if (hit) return hit;

    // 2. page name STARTS WITH client name  (Manofox → Manofox Pvt.)
    hit = metaTargets.find(p =>
        normalizeName(p.pageName).startsWith(target)
    );
    if (hit) return hit;

    // 3. client name STARTS WITH page name
    hit = metaTargets.find(p =>
        target.startsWith(normalizeName(p.pageName))
    );
    if (hit) return hit;

    // 4. token overlap — at least one word in common, score = #common tokens
    const cTokens = new Set(target.split(" ").filter(Boolean));

    let best = null;
    let bestScore = 0;

    for (const p of metaTargets) {

        const pTokens = normalizeName(p.pageName).split(" ").filter(Boolean);
        let score = 0;
        for (const t of pTokens) if (cTokens.has(t)) score++;
        if (score > bestScore) { bestScore = score; best = p; }
    }

    return bestScore > 0 ? best : null;
}

function toggleTargetTile(tile, key) {

    if (selectedTargets.has(key)) {
        selectedTargets.delete(key);
        tile.classList.remove("selected");
    } else {
        selectedTargets.add(key);
        tile.classList.add("selected");
    }
}

function getSelectedTargets() {

    // Build the array the backend expects
    const out = [];

    metaTargets.forEach(page => {

        const wantsFb = selectedTargets.has(page.pageId);
        const wantsIg = selectedTargets.has(page.pageId + "_ig");

        if (!wantsFb && !wantsIg) return;

        out.push({
            pageName:        page.pageName,
            pageId:          wantsFb ? page.pageId : null,
            pageAccessToken: page.pageAccessToken,
            instagramId:     wantsIg ? page.instagramId : null
        });
    });

    return out;
}

/* ============================================================
   FREQUENCY + DAYS
============================================================ */

function selectFreq(btn) {

    document.querySelectorAll(".freq-opt")
            .forEach(b => b.classList.remove("active"));

    btn.classList.add("active");
    currentFreq = btn.dataset.freq;

    document.getElementById("daysWrap").style.display =
        (currentFreq === "custom") ? "" : "none";
}

function toggleDay(el) {

    el.classList.toggle("selected");
}

function getSelectedDays() {

    return Array.from(
        document.querySelectorAll(".day-pill.selected")
    ).map(d => d.dataset.d);
}

function autoSelectTodayCustomDay() {

    // Switch frequency to "Custom Days"
    document.querySelectorAll(".freq-opt").forEach(b => {

        b.classList.toggle(
            "active",
            b.dataset.freq === "custom"
        );
    });

    currentFreq = "custom";
    document.getElementById("daysWrap").style.display = "";

    // Today's short name
    const todayName = [
        "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"
    ][new Date().getDay()];

    document.querySelectorAll(".day-pill").forEach(p => {

        p.classList.toggle(
            "selected",
            p.dataset.d === todayName
        );
    });

    addAutomationLog(
        `📅 Custom Day → ${todayName} (today)`,
        "info"
    );
}

function autoSelectNowDateTime() {

    const now = new Date();

    const yyyy = now.getFullYear();
    const mm   = String(now.getMonth() + 1).padStart(2, "0");
    const dd   = String(now.getDate()).padStart(2, "0");

    const hh = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");

    document.getElementById("schStartDate").value = `${yyyy}-${mm}-${dd}`;
    document.getElementById("schTime").value      = `${hh}:${mi}`;

    addAutomationLog(
        `⏰ Date ${yyyy}-${mm}-${dd}, Time ${hh}:${mi}`,
        "info"
    );
}

/* ============================================================
   FILE QUEUE RENDERING
============================================================ */

function renderSchedulerQueue() {

    const container = document.getElementById("fileQueue");
    if (!container) return;

    if (!schedulerQueue.length) {

        container.innerHTML =
            `<div class="empty-state">No generated images yet</div>`;
        return;
    }

    container.innerHTML = "";

    schedulerQueue.forEach(post => {

        const item = document.createElement("div");
        item.className = `file-item status-${post.status || "ready"}`;

        item.innerHTML = `
          <img
          src="${post.image}"
          class="file-thumb"
          >
          <div class="file-info">
            <div class="file-name">${post.title || post.client || "Post"}</div>
            <div class="file-meta">${post.caption ? post.caption.slice(0, 100) : (post.prompt || "").slice(0, 100)}…</div>
            <div class="file-tags">${post.hashtags || ""}</div>
          </div>
          <div class="fstatus ${post.status}">${post.status}</div>
        `;

        container.appendChild(item);
    });
}

/* ============================================================
   GROQ CAPTION
============================================================ */

async function generateGroqCaption(post) {

    try {

        addAutomationLog(
            `⚡ Generating caption with Groq for "${post.client}"…`,
            "info"
        );

        post.status = "generating";
        renderSchedulerQueue();

        const response = await fetch("/generate-caption", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
                id:     post.id,
                client: post.client,
                prompt: post.prompt
            })
        });

        const result = await response.json();

        post.caption  = result.caption  || "";
        post.hashtags = result.hashtags || "";
        post.title    = post.title || (post.client + " — new post");
        post.status   = "ready";

        renderSchedulerQueue();

        addAutomationLog(
            "✅ Groq caption generated",
            "ok"
        );

        return result;

    } catch (error) {

        console.log(error);

        addAutomationLog(
            "Groq error: " + error.message,
            "err"
        );

        post.status = "failed";
        renderSchedulerQueue();
    }
}

async function manualGenerateAllCaptions() {

    for (const post of schedulerQueue) {

        if (post.status !== "ready") {

            await generateGroqCaption(post);
        }
    }
}

/* ============================================================
   PUBLISH TO META
   Accepts an optional `targetPost` — if not given, defaults to the
   first post in the scheduler queue (manual-button behaviour).
============================================================ */

const currentlyScheduling = new Set(); // post.id values being sent
const fullyScheduled      = new Set(); // post.id values already done

async function publishToMeta(targetPost) {

    try {

        const post = targetPost || schedulerQueue[0];

        if (!post) {

            addAutomationLog("No queued post found", "err");
            return;
        }

        if (fullyScheduled.has(post.id)) {

            addAutomationLog(
                `⏭ Post for "${post.client}" was already scheduled — skipping.`,
                "warn"
            );
            return;
        }

        if (currentlyScheduling.has(post.id)) {

            addAutomationLog(
                `⏳ Post for "${post.client}" is still being scheduled — skipping duplicate.`,
                "warn"
            );
            return;
        }

        if (post.status !== "ready") {

            addAutomationLog(
                `Post for "${post.client}" not ready — generate caption first.`,
                "warn"
            );
            return;
        }

        const targets = getSelectedTargets();

        if (!targets.length) {

            addAutomationLog(
                "No targets selected — select FB / IG tiles.",
                "err"
            );
            return;
        }

        // Build schedule time from date + time inputs
        const dateVal = document.getElementById("schStartDate").value;
        const timeVal = document.getElementById("schTime").value;

        let scheduleTime;

        if (dateVal && timeVal) {

            scheduleTime = new Date(`${dateVal}T${timeVal}`);

        } else {

            scheduleTime = new Date();
        }

        // Facebook requires scheduled_publish_time to be ≥10 min in the
        // future. Bump to 11 min if user picked "now" or a past time.
        const minTime = new Date(Date.now() + 11 * 60 * 1000);

        if (isNaN(scheduleTime.getTime()) || scheduleTime < minTime) {

            scheduleTime = minTime;

            addAutomationLog(
                `⏰ Adjusted schedule time to ${scheduleTime.toLocaleString()} ` +
                `(Facebook requires ≥10 min in the future)`,
                "info"
            );
        }

        currentlyScheduling.add(post.id);

        addAutomationLog(
            `🚀 Scheduling "${post.client}" → ${targets.length} target(s) @ ${scheduleTime.toLocaleString()}`,
            "warn"
        );

        const response = await fetch("/schedule-post", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
                postId:       post.id,
                scheduleTime: scheduleTime.toISOString(),
                targets
            })
        });

        const data = await response.json();

        console.log("schedule response", data);

        currentlyScheduling.delete(post.id);

        if (data.success) {

            fullyScheduled.add(post.id);

            addAutomationLog(
                `✅ Post scheduled successfully on Meta (${targets.length} target${targets.length>1?'s':''})`,
                "ok"
            );

            // Remove this post from the queue so we don't double-schedule
            schedulerQueue = schedulerQueue.filter(
                p => p.id !== post.id
            );

            renderSchedulerQueue();

            loadPosts();

        } else {

            addAutomationLog(
                "Schedule failed: " +
                (typeof data.error === "string"
                    ? data.error
                    : JSON.stringify(data.error)),
                "err"
            );
        }

    } catch (error) {

        console.log(error);

        addAutomationLog(
            "Publish error: " + error.message,
            "err"
        );
    }
}

/* ============================================================
   AUTO PIPELINE
   Triggered by SSE every time a new image is generated.
   1. drop into upload queue
   2. ⚡ generate-with-groq
   3. select all FB+IG targets
   4. custom days → today, current date + time
   5. 🚀 schedule
============================================================ */

async function autoScheduleGeneratedPost(post) {

    if (alreadyAutomated.has(post.id)) {

        console.log("skipping already automated", post.id);
        return;
    }

    alreadyAutomated.add(post.id);

    try {

        addAutomationLog(
            `📥 New image from ChatGPT for "${post.client}"`,
            "ok"
        );

        /* ---------- 1. Place in file queue ---------- */

        post.title  = post.client + " — auto post";
        post.status = "uploaded";

        schedulerQueue.unshift(post);
        renderSchedulerQueue();

        addAutomationLog(
            "📂 Image placed in upload queue",
            "info"
        );

        /* ---------- 2. Generate caption with Groq ---------- */

        await generateGroqCaption(post);

        /* ---------- 3. Auto-select ONLY the matching client page ---------- */

        if (!metaTargets.length) {

            await loadMetaTargets();
        }

        const matchedPage = findPageForClient(post.client);

        if (!matchedPage) {

            addAutomationLog(
                `⚠ No Meta page matches client "${post.client}". ` +
                `Pages available: ${metaTargets.map(p=>p.pageName).join(", ")}`,
                "err"
            );

            alreadyAutomated.delete(post.id);  // allow retry
            return;
        }

        // Wipe previous selection, select ONLY this page
        selectedTargets = new Set();
        selectedTargets.add(matchedPage.pageId);

        if (matchedPage.instagramId) {

            selectedTargets.add(matchedPage.pageId + "_ig");
        }

        renderTargets();   // re-render tiles with correct .selected class

        addAutomationLog(
            `🎯 Selected page: "${matchedPage.pageName}"` +
            (matchedPage.instagramId ? "  (FB + Instagram)" : "  (FB only — no IG linked)"),
            "ok"
        );

        /* ---------- 4. Custom days → today + current date/time ---------- */

        autoSelectTodayCustomDay();
        autoSelectNowDateTime();

        /* ---------- 5. Fire the schedule for THIS post specifically ---------- */

        setTimeout(() => publishToMeta(post), 1500);

    } catch (error) {

        console.log(error);
        addAutomationLog(
            "Auto pipeline error: " + error.message,
            "err"
        );
    }
}

/* ============================================================
   SSE STREAM
============================================================ */

function connectSSE() {

    if (!window.EventSource) {

        setAutoStatus("Your browser does not support SSE", false);
        return;
    }

    const es = new EventSource("/events");

    es.addEventListener("connected", () => {

        setAutoStatus("🟢 Connected — waiting for new images…", true);

        addAutomationLog(
            "Connected to backend automation stream",
            "ok"
        );
    });

    es.addEventListener("new-post", evt => {

        try {

            const post = JSON.parse(evt.data);

            autoScheduleGeneratedPost(post);

        } catch (e) {

            console.log(e);
        }
    });

    es.addEventListener("post-scheduled", evt => {

        const { postId } = JSON.parse(evt.data);

        addAutomationLog(
            `Server confirmed scheduling for post ${postId}`,
            "ok"
        );
    });

    es.onerror = () => {

        setAutoStatus("🔴 Disconnected — retrying…", false);

        setTimeout(connectSSE, 3000);

        es.close();
    };
}

/* ============================================================
   POSTS LIST (read-only history at bottom of dashboard)
============================================================ */

async function loadPosts() {

    try {

        const response = await fetch("/posts");
        const posts    = await response.json();

        const box = document.getElementById("posts");
        if (!box) return;

        box.innerHTML = `<div class="grid"></div>`;
        const grid    = box.querySelector(".grid");

        posts.slice(0, 12).forEach(post => {

            const card = document.createElement("div");
            card.className = "card";

            card.innerHTML = `
              <img src="${post.image}">
              <h2>${post.client || "—"}</h2>
              <p>${post.caption || ""}</p>
              <p>${post.hashtags || ""}</p>
              <p class="status-line ${post.status}">${post.status}</p>
              <div class="schedule-box">
                <input
                type="datetime-local"
                id="time-${post.id}"
                class="schedule-input"
                >
                <button
                class="schedule-btn"
                onclick="schedulePost(${post.id})"
                >
                  Schedule Manually
                </button>
              </div>
            `;

            grid.appendChild(card);
        });

    } catch (e) {

        console.log(e);
    }
}

async function schedulePost(id) {

    const timeInput = document.getElementById(`time-${id}`);
    if (!timeInput) return alert("Time input missing");

    const time = timeInput.value;
    if (!time) return alert("Pick a schedule time first");

    const targets = getSelectedTargets();

    const res = await fetch("/schedule-post", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
            postId:       id,
            scheduleTime: new Date(time).toISOString(),
            targets
        })
    });

    const data = await res.json();

    if (data.success) {

        alert("Post scheduled ✓");
        loadPosts();

    } else {

        alert(
            "Failed: " +
            (typeof data.error === "string"
                ? data.error
                : JSON.stringify(data.error))
        );
    }
}

/* ============================================================
   INIT
============================================================ */

(async function init() {

    setAutoStatus("Connecting to automation stream…", true);

    await loadClients();
    await loadMetaTargets();

    autoSelectNowDateTime();
    autoSelectTodayCustomDay();

    loadPosts();
    setInterval(loadPosts, 8000);

    connectSSE();
})();
