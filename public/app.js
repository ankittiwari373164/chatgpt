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

function addAutomationLog(message, type = "info", when = null) {

    const log = document.getElementById("automationLogs");

    if (!log) return;

    // First call clears any placeholder text
    if (log.querySelector(".empty-state") || log.textContent.trim() === "Loading…") {
        log.innerHTML = "";
    }

    const colors = {
        info: "log-info",
        ok:   "log-ok",
        warn: "log-warn",
        err:  "log-err"
    };

    const t = (when instanceof Date && !isNaN(when.getTime())) ? when : new Date();
    const time = t.toLocaleTimeString();

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

        select.onchange = loadSavedCalendar;
        if (clients.length) loadSavedCalendar();

        renderClientsList(clients);

    } catch (e) {

        console.log(e);
    }
}

function renderClientsList(clients) {

    let box = document.getElementById("clientsListBox");

    if (!box) {

        // Inject the list container right after the Create-Client section
        const allSections = document.querySelectorAll(".section");
        let target = null;
        for (const s of allSections) {
            if (s.querySelector('input#name')) { target = s; break; }
        }
        if (!target) return;

        const wrapper = document.createElement("div");
        wrapper.className = "section";
        wrapper.innerHTML = `
            <h2>📋 Your Clients</h2>
            <p class="subtext">All saved brands. Click 🗑 to remove (the calendar is also deleted, but past posts stay).</p>
            <div id="clientsListBox"></div>
        `;
        target.parentNode.insertBefore(wrapper, target.nextSibling);
        box = document.getElementById("clientsListBox");
    }

    if (!clients.length) {
        box.innerHTML = '<div class="empty-state">No clients yet — add one above.</div>';
        return;
    }

    box.innerHTML = clients.map(c => `
        <div style="display:flex; justify-content:space-between; align-items:center;
                    padding:10px 14px; background:#161616; border:1px solid #2a2a2a;
                    border-radius:8px; margin-bottom:6px; gap:10px;">
            <div style="flex:1; min-width:0;">
                <div style="font-weight:600;">${escapeHTML(c.name)}</div>
                <div style="font-size:12px; color:#888; display:flex; gap:8px; flex-wrap:wrap; margin-top:2px; align-items:center;">
                    ${c.industry ? `<span>${escapeHTML(c.industry)}</span>` : ''}
                    ${c.tone ? `<span>· ${escapeHTML(c.tone)}</span>` : ''}
                </div>
            </div>
            <div style="display:flex; gap:6px; align-items:center;">
                ${c.logoUrl
                    ? `<a href="${escapeHTML(c.logoUrl)}" target="_blank" title="Logo">
                         <img src="${escapeHTML(c.logoUrl)}" style="width:36px; height:36px; object-fit:cover;
                              border-radius:6px; border:1px solid #2a2a2a; background:#0a0a0a;">
                       </a>`
                    : '<span style="font-size:10px; color:#555; padding:0 4px;">no logo</span>'
                }
                ${c.footerUrl
                    ? `<a href="${escapeHTML(c.footerUrl)}" target="_blank" title="Footer">
                         <img src="${escapeHTML(c.footerUrl)}" style="width:36px; height:36px; object-fit:cover;
                              border-radius:6px; border:1px solid #2a2a2a; background:#0a0a0a;">
                       </a>`
                    : '<span style="font-size:10px; color:#555; padding:0 4px;">no footer</span>'
                }
                <button
                    onclick="deleteClient('${encodeURIComponent(c.name).replace(/'/g, "\\'")}')"
                    style="background:#3a1010; border:1px solid #5a2020; color:#ffaaaa;
                           padding:6px 10px; border-radius:6px; cursor:pointer;
                           white-space:nowrap;">
                    🗑 Delete
                </button>
            </div>
        </div>
    `).join("");
}

function escapeHTML(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function deleteClient(encodedName) {

    const name = decodeURIComponent(encodedName);

    if (!confirm(`Delete client "${name}"?\n\nThe brand and its content calendar will be removed.\nPast scheduled posts stay intact.`)) {
        return;
    }

    try {
        const r = await fetch("/clients/" + encodeURIComponent(name), {
            method: "DELETE"
        });
        const d = await r.json();

        if (d.success) {
            addAutomationLog(`🗑 Deleted client "${name}"`, "warn");
            loadClients();
        } else {
            addAutomationLog(`❌ Delete failed: ${d.error}`, "err");
        }
    } catch (e) {
        addAutomationLog(`❌ Delete failed: ${e.message}`, "err");
    }
}

/* ============================================================
   CLIENT LOGO + FOOTER FILE PICKERS
============================================================ */

// Holds the pending base64 data URL for the next save.
// null  = no change (keep existing on edit)
// "__REMOVE__" = user clicked Remove, wipe the field
// "data:..." = user picked a new file
window.__pendingLogoData   = null;
window.__pendingFooterData = null;

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload  = () => resolve(r.result);
        r.onerror = () => reject(new Error("File read failed"));
        r.readAsDataURL(file);
    });
}

async function onLogoChosen(input) {

    const f = input.files && input.files[0];
    if (!f) return;

    if (f.size > 8 * 1024 * 1024) {
        alert("Logo is too large (max 8 MB). Pick a smaller file.");
        input.value = "";
        return;
    }

    try {
        const dataUrl = await readFileAsDataUrl(f);
        window.__pendingLogoData = dataUrl;

        const status  = document.getElementById("logoStatus");
        const preview = document.getElementById("logoPreview");
        if (status)  status.textContent  = `✓ ${f.name} (${Math.round(f.size/1024)} KB) — will upload on save`;
        if (preview) preview.innerHTML = `<img src="${dataUrl}" style="max-height:140px; max-width:100%; object-fit:contain;">`;
    } catch (e) {
        alert("Could not read file: " + e.message);
    }
}

async function onFooterChosen(input) {

    const f = input.files && input.files[0];
    if (!f) return;

    if (f.size > 8 * 1024 * 1024) {
        alert("Footer is too large (max 8 MB). Pick a smaller file.");
        input.value = "";
        return;
    }

    try {
        const dataUrl = await readFileAsDataUrl(f);
        window.__pendingFooterData = dataUrl;

        const status  = document.getElementById("footerStatus");
        const preview = document.getElementById("footerPreview");
        if (status)  status.textContent  = `✓ ${f.name} (${Math.round(f.size/1024)} KB) — will upload on save`;
        if (preview) preview.innerHTML = `<img src="${dataUrl}" style="max-height:140px; max-width:100%; object-fit:contain;">`;
    } catch (e) {
        alert("Could not read file: " + e.message);
    }
}

function clearLogoChoice() {
    window.__pendingLogoData = "__REMOVE__";
    const input   = document.getElementById("logoFile");
    const status  = document.getElementById("logoStatus");
    const preview = document.getElementById("logoPreview");
    if (input)   input.value = "";
    if (status)  status.textContent  = "Will be removed on save";
    if (preview) preview.innerHTML = '<span style="color:#a44;">— logo will be deleted on save —</span>';
}

function clearFooterChoice() {
    window.__pendingFooterData = "__REMOVE__";
    const input   = document.getElementById("footerFile");
    const status  = document.getElementById("footerStatus");
    const preview = document.getElementById("footerPreview");
    if (input)   input.value = "";
    if (status)  status.textContent  = "Will be removed on save";
    if (preview) preview.innerHTML = '<span style="color:#a44;">— footer will be deleted on save —</span>';
}

function resetLogoFooterUI() {
    window.__pendingLogoData   = null;
    window.__pendingFooterData = null;

    const logoInput    = document.getElementById("logoFile");
    const footerInput  = document.getElementById("footerFile");
    if (logoInput)   logoInput.value   = "";
    if (footerInput) footerInput.value = "";

    const ls = document.getElementById("logoStatus");
    const fs = document.getElementById("footerStatus");
    if (ls) ls.textContent = "No file chosen";
    if (fs) fs.textContent = "No file chosen";

    const lp = document.getElementById("logoPreview");
    const fp = document.getElementById("footerPreview");
    if (lp) lp.innerHTML = "No logo yet";
    if (fp) fp.innerHTML = "No footer yet";
}

async function saveClient() {

    const $ = id => document.getElementById(id);

    const payload = {
        name:     $("name").value.trim(),
        industry: $("industry").value.trim(),
        tone:     $("tone").value.trim(),
        audience: $("audience").value.trim(),
        services: $("services").value.trim(),
        style:    $("style").value.trim(),
        cta:      $("cta").value.trim()
    };

    if (!payload.name) {
        alert("Brand Name is required");
        return;
    }

    // Logo state
    if (window.__pendingLogoData === "__REMOVE__") {
        payload.logoUrl = "__REMOVE__";
    } else if (window.__pendingLogoData) {
        payload.logoDataUrl = window.__pendingLogoData;
    } // else: leave unchanged

    // Footer state
    if (window.__pendingFooterData === "__REMOVE__") {
        payload.footerUrl = "__REMOVE__";
    } else if (window.__pendingFooterData) {
        payload.footerDataUrl = window.__pendingFooterData;
    }

    const btn = document.querySelector('[onclick="saveClient()"]');
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Saving + uploading…"; }

    try {

        const r = await fetch("/save-client", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(payload)
        });

        const d = await r.json();

        if (d.success) {
            addAutomationLog(`💾 Saved client "${payload.name}"`, "ok");

            // Clear text fields and file pickers
            ["name","industry","tone","audience","services","style","cta"]
                .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
            resetLogoFooterUI();

            loadClients();
        } else {
            addAutomationLog(`❌ Save failed: ${d.error || "unknown"}`, "err");
            alert("Save failed: " + (d.error || "unknown"));
        }

    } catch (e) {
        addAutomationLog(`❌ Save failed: ${e.message}`, "err");
        alert("Save failed: " + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Save Client"; }
    }
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

    addAutomationLog(
        `📅 Generating 30-day calendar for "${client.name}"…`,
        "info"
    );

    try {

        const response = await fetch("/generate-calendar", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(client)
        });

        const data = await response.json();

        // Server may return either a calendar array OR {error: "..."}
        if (!response.ok || !Array.isArray(data)) {

            const msg = data?.error || ("HTTP " + response.status);

            addAutomationLog(
                "Calendar generation failed: " + msg +
                " — try again in a minute (Groq rate limit).",
                "err"
            );

            // Still try to load any previously saved calendar so
            // the user sees something instead of an empty screen.
            await loadSavedCalendar();
            return;
        }

        renderCalendar(client, data);

        addAutomationLog(
            `✓ Calendar saved (${data.length} items).`,
            "ok"
        );

    } catch (err) {

        addAutomationLog("Calendar failed: " + err.message, "err");
    }
}

/* ============================================================
   Re-render a calendar (used both after generateCalendar()
   and on page-load when fetching a saved calendar)
============================================================ */

function renderCalendar(client, calendar) {

    const box = document.getElementById("calendar");
    if (!box) return;

    box.innerHTML = "";

    if (!Array.isArray(calendar) || !calendar.length) {

        box.innerHTML =
            '<div class="empty-state" style="margin-top:10px">' +
            'No calendar saved for this client yet. ' +
            'Click <strong>Generate Calendar</strong>.</div>';
        return;
    }

    calendar.forEach(item => {

        const card = document.createElement("div");
        card.className = "calendar-item";

        const doneTag = item.done
            ? '<span style="color:#22c55e;font-size:11px">✓ done</span>'
            : '';

        card.innerHTML = `
          <h3>${item.topic || ""} ${doneTag}</h3>
          <p>${item.date || ""}</p>
          <p>${item.event || ""}</p>
          <p>${item.goal || ""}</p>
        `;

        const btn = document.createElement("button");
        btn.textContent = "Generate Creative";
        btn.onclick = () => generateCreative(client, item, btn);

        card.appendChild(btn);
        box.appendChild(card);
    });
}

/* ============================================================
   Load a previously saved calendar from the server
============================================================ */

async function loadSavedCalendar() {

    const name = document.getElementById("clients")?.value;
    if (!name) return;

    const client = (window.clientsData || []).find(
        c => c.name === name.trim()
    );
    if (!client) return;

    try {

        const r = await fetch(
            "/calendar/" + encodeURIComponent(client.name)
        );
        const d = await r.json();

        renderCalendar(client, d.calendar || []);

    } catch (e) {

        console.log("loadSavedCalendar error", e);
    }
}

async function generateCreative(client, item, btn) {

    if (btn) { btn.disabled = true; btn.textContent = "⏳ Running…"; }

    addAutomationLog(
        `🚀 Starting full pipeline for "${client.name}" → "${item.topic}"…`,
        "info"
    );

    try {

        const response = await fetch("/generate-and-schedule", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
                clientName: client.name,
                item
            })
        });

        const data = await response.json();

        const status = data.log?.status;

        if (status === "scheduled") {

            addAutomationLog(
                `✅ ${client.name}: scheduled to ${data.log.page} ` +
                `[image via ${data.log.imageSource}]`,
                "ok"
            );

            loadPosts();

        } else if (status === "queued") {

            addAutomationLog(
                `📨 ${client.name}: queued for Tampermonkey. ` +
                `Open chatgpt.com to let it pick up the prompt.`,
                "info"
            );

        } else {

            addAutomationLog(
                `❌ ${client.name}: ${data.error || data.log?.reason || "unknown error"}`,
                "err"
            );
        }

    } catch (e) {

        addAutomationLog("Pipeline error: " + e.message, "err");

    } finally {

        if (btn) {
            btn.disabled = false;
            btn.textContent = "Generate Creative";
        }
    }
}

/* ============================================================
   GENERATE FOR ALL CLIENTS (manual morning button)
============================================================ */

async function generateForAllClients() {

    if (!confirm(
        "Run the full pipeline (generate image → caption → schedule to Meta) " +
        "for EVERY client right now?\n\n" +
        "This will take a few minutes."
    )) return;

    const btn = document.getElementById("runAllBtn");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Running…"; }

    addAutomationLog("🌅 Triggering pipeline for ALL clients…", "warn");

    try {

        const r = await fetch("/generate-all-now", { method: "POST" });
        const d = await r.json();

        if (d.success) {

            addAutomationLog(
                "✅ Background run started. Check the logs below as each " +
                "client completes.",
                "ok"
            );

        } else {

            addAutomationLog("❌ " + (d.error || "failed to start"), "err");
        }

    } catch (e) {

        addAutomationLog("Network error: " + e.message, "err");

    } finally {

        // Keep button disabled for 60s — background run takes a while
        setTimeout(() => {

            if (btn) {
                btn.disabled = false;
                btn.textContent = "🌅 Generate & Schedule for ALL Clients";
            }

        }, 60000);
    }
}

/* ============================================================
   META TARGETS
============================================================ */

async function loadMetaTargets() {

    try {

        const response = await fetch("/meta/pages");
        const data     = await response.json();

        // Server returns either an array OR {error, pages: []}
        if (Array.isArray(data)) {

            metaTargets = data;

        } else {

            metaTargets = data.pages || [];

            if (data.error) {

                document.getElementById("targetsHelp").textContent =
                    "⚠ " + data.error;

                addAutomationLog(data.error, "err");
                return;
            }
        }

        renderTargets();

    } catch (e) {

        console.log(e);
        document.getElementById("targetsHelp").textContent =
            "Could not load Meta pages — " + e.message;
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

    es.addEventListener("log", evt => {

        try {
            const log = JSON.parse(evt.data);
            // Only add if it's a NEW message (skip ones already in history)
            if (!window.__seenLogIds) window.__seenLogIds = new Set();
            const key = (log.at || "") + "|" + (log.message || "");
            if (window.__seenLogIds.has(key)) return;
            window.__seenLogIds.add(key);
            addAutomationLog(log.message, log.level || "info");
        } catch (e) {}
    });

    es.addEventListener("client-deleted", evt => {
        try {
            const d = JSON.parse(evt.data);
            addAutomationLog(`Client "${d.name}" was deleted`, "warn");
            loadClients();
        } catch (_) {}
    });

    es.addEventListener("new-post", evt => {

        try {

            const post = JSON.parse(evt.data);

            // The corresponding queued prompt was just marked done — refresh list
            refreshQueuedPrompts();

            // Server-owned pipeline (cron-queued image): skip dashboard auto-schedule
            if (post.autoScheduled) {
                addAutomationLog(
                    `📷 New image: ${post.client} — server is handling caption + scheduling`,
                    "info"
                );
                loadPosts();
                return;
            }

            // De-duplicate: dashboard may see the same post twice if SSE
            // reconnects mid-flow. Track which post IDs we've already pushed.
            if (!window.__scheduledPostIds) window.__scheduledPostIds = new Set();
            if (window.__scheduledPostIds.has(post.id)) {
                console.log("[dashboard] skipping duplicate new-post for id", post.id);
                return;
            }
            window.__scheduledPostIds.add(post.id);

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

    es.addEventListener("pipeline-done", evt => {

        try {

            const log = JSON.parse(evt.data);

            let icon = "⏭ ";
            let level = "warn";

            if (log.status === "scheduled") {
                icon  = "✅";
                level = "ok";
            } else if (log.status === "queued") {
                icon  = "📨";
                level = "info";
            } else if (log.status === "failed" || log.status === "error") {
                icon  = "❌";
                level = "err";
            } else if (log.status === "missed-days") {
                icon  = "⚠";
                level = "warn";
            }

            addAutomationLog(
                `${icon} ${log.client}: ${log.status}` +
                (log.reason ? ` — ${log.reason}` : "") +
                (log.page   ? ` → ${log.page}`   : "") +
                (log.imageSource ? ` [${log.imageSource}]` : ""),
                level
            );

            if (log.status === "scheduled") loadPosts();

        } catch (e) { console.log(e); }
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

/* ============================================================
   QUEUED PROMPTS — what Tampermonkey will pick up next
============================================================ */

async function refreshQueuedPrompts() {

    const list = document.getElementById("queuedPromptsList");
    const cnt  = document.getElementById("queuedCount");
    if (!list) return;

    try {

        const r = await fetch("/prompts/queued");
        const items = await r.json();

        if (cnt) cnt.textContent = items.length ? `(${items.length})` : "(0)";

        if (!items.length) {
            list.innerHTML = '<div class="empty-state">No prompts waiting</div>';
            return;
        }

        list.innerHTML = items.map(p => {

            const ageS = Math.round((Date.now() - new Date(p.createdAt).getTime()) / 1000);
            const ageLabel = ageS < 60 ? `${ageS}s` :
                             ageS < 3600 ? `${Math.round(ageS/60)}m` :
                             `${Math.round(ageS/3600)}h`;

            const claimed = p.claimedAt
                ? `<span style="color:#f5b342;">🔒 in progress</span>`
                : `<span style="color:#888;">waiting</span>`;

            const sourceTag =
                p.source === "cron"     ? '<span style="color:#7eaaff;">⏰ cron</span>' :
                p.source === "calendar" ? '<span style="color:#a594ff;">📅 calendar</span>' :
                                          '<span style="color:#aaa;">📝 manual</span>';

            const cronLine = p.cronInfo
                ? `<div style="font-size:11px; color:#888; margin-top:4px;">→ ${escapeHTML(p.cronInfo.page || "")} · ${escapeHTML(p.cronInfo.topic || "")}</div>`
                : "";

            return `
                <div style="padding:11px 14px; background:#161616; border:1px solid #2a2a2a;
                            border-radius:8px; margin-bottom:6px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
                        <div style="flex:1; min-width:0;">
                            <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:12px; margin-bottom:4px;">
                                <span style="font-weight:600; color:#fff;">${escapeHTML(p.client)}</span>
                                ${sourceTag}
                                ${claimed}
                                <span style="color:#666;">· ${ageLabel} ago</span>
                                ${p.attempts ? `<span style="color:#f5b342;">· ${p.attempts} attempts</span>` : ""}
                            </div>
                            <div style="font-size:12px; color:#bbb; line-height:1.5;
                                        max-height:60px; overflow:hidden;
                                        white-space:pre-wrap; word-break:break-word;">
                                ${escapeHTML((p.prompt || "").slice(0, 280))}${p.prompt && p.prompt.length > 280 ? "…" : ""}
                            </div>
                            ${cronLine}
                        </div>
                        <button
                            onclick="deletePrompt('${encodeURIComponent(String(p.id))}')"
                            style="background:#3a1010; border:1px solid #5a2020; color:#ffaaaa;
                                   padding:6px 10px; border-radius:6px; cursor:pointer;
                                   font-size:12px; white-space:nowrap;">
                            🗑 Delete
                        </button>
                    </div>
                </div>
            `;
        }).join("");

    } catch (e) {
        list.innerHTML = `<div class="empty-state">Failed to load: ${escapeHTML(e.message)}</div>`;
    }
}

async function deletePrompt(encodedId) {

    const id = decodeURIComponent(encodedId);
    if (!confirm("Delete this queued prompt? It will not be sent to ChatGPT.")) return;

    try {
        const r = await fetch("/prompts/" + encodeURIComponent(id), { method: "DELETE" });
        const d = await r.json();

        if (d.success) {
            addAutomationLog(`🗑 Deleted queued prompt ${id}`, "warn");
            refreshQueuedPrompts();
        } else {
            addAutomationLog(`❌ Delete failed: ${d.error || "unknown"}`, "err");
        }
    } catch (e) {
        addAutomationLog(`❌ Delete failed: ${e.message}`, "err");
    }
}

async function clearAllPrompts() {

    if (!confirm("Delete ALL queued prompts? This stops every pending automation. This cannot be undone.")) return;

    try {
        const r = await fetch("/prompts/clear-all", { method: "POST" });
        const d = await r.json();

        if (d.success) {
            addAutomationLog(`🗑 Cleared ${d.deleted} queued prompts`, "warn");
            refreshQueuedPrompts();
        } else {
            addAutomationLog(`❌ Clear failed: ${d.error || "unknown"}`, "err");
        }
    } catch (e) {
        addAutomationLog(`❌ Clear failed: ${e.message}`, "err");
    }
}

/* ============================================================
   META TOKEN HELPERS
============================================================ */

async function fetchMetaPages() {

    const input = document.getElementById("metaTokenInput");
    const status = document.getElementById("metaPagesStatus");
    const token = (input?.value || "").trim();

    if (!token) {
        status.innerHTML = '<span style="color:#ff9999;">Please paste a token first.</span>';
        return;
    }

    status.innerHTML = '⏳ Fetching pages from Meta…';

    try {

        const r = await fetch("/meta/refresh-pages", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ token })
        });

        const d = await r.json();

        if (d.success) {

            status.innerHTML =
                `<span style="color:#7eff7e;">✅ ${d.count} pages linked` +
                (d.tokenSaved ? " · token saved" : "") +
                "</span>";

            input.value = "";  // hide token after success
            addAutomationLog(`✅ Meta: ${d.count} pages fetched and saved`, "ok");
            loadMetaTargets();

        } else {

            const msg = d.error || "Unknown error";
            const hint = d.hint ? ` — ${d.hint}` : "";
            status.innerHTML =
                `<span style="color:#ff9999;">❌ ${escapeHTML(msg)}${escapeHTML(hint)}</span>`;
            addAutomationLog(`❌ Meta fetch failed: ${msg}`, "err");
        }

    } catch (e) {

        status.innerHTML =
            `<span style="color:#ff9999;">❌ Network error: ${escapeHTML(e.message)}</span>`;
    }
}

/* ============================================================
   LOG PERSISTENCE
============================================================ */

async function loadPersistedLogs() {

    try {

        const r = await fetch("/logs?limit=300");
        const logs = await r.json();

        const box = document.getElementById("automationLogs");
        if (!box) return;

        if (!logs.length) {
            box.innerHTML = '<div class="empty-state">No logs yet</div>';
            return;
        }

        box.innerHTML = "";
        if (!window.__seenLogIds) window.__seenLogIds = new Set();

        for (const log of logs) {
            const key = (log.at || "") + "|" + (log.message || "");
            window.__seenLogIds.add(key);
            addAutomationLog(log.message, log.level || "info", new Date(log.at));
        }

    } catch (e) {
        console.log("loadPersistedLogs error", e);
    }
}

async function clearLogs() {

    if (!confirm("Clear all stored logs? This cannot be undone.")) return;

    try {

        await fetch("/logs/clear", { method: "POST" });

        const box = document.getElementById("automationLogs");
        if (box) box.innerHTML = '<div class="empty-state">Logs cleared</div>';
        window.__seenLogIds = new Set();

    } catch (e) {
        console.log("clearLogs error", e);
    }
}

/* ============================================================
   INIT
============================================================ */

(async function init() {

    setAutoStatus("Connecting to automation stream…", true);

    await loadClients();
    await loadMetaTargets();
    await loadPersistedLogs();
    await refreshQueuedPrompts();

    autoSelectNowDateTime();
    autoSelectTodayCustomDay();

    loadPosts();
    setInterval(loadPosts, 8000);
    setInterval(refreshQueuedPrompts, 10000); // refresh queued list every 10s

    connectSSE();
})();