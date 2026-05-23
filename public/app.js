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

        select.onchange = () => {
            loadSavedCalendar();
            loadPosts();
            refreshDriveAssets();
        };
        if (clients.length) {
            loadSavedCalendar();
            loadPosts();
            refreshDriveAssets();
        }

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

    box.innerHTML = clients.map(c => {

        const pillCount = c.productsCache?.items?.length || 0;
        const sampleCount = Array.isArray(c.samplePosts) ? c.samplePosts.length : 0;
        const sz = c.postSize || "1:1";
        const dd = c.postDays || "mwf";
        const ddLabel = dd === "mwf" ? "MWF" : dd === "mtwtfs" ? "Mon→Sat" : "Daily";

        return `
        <div style="display:flex; justify-content:space-between; align-items:center;
                    padding:10px 14px; background:#161616; border:1px solid #2a2a2a;
                    border-radius:8px; margin-bottom:6px; gap:10px;">
            <div style="flex:1; min-width:0;">
                <div style="font-weight:600;">${escapeHTML(c.name)}</div>
                <div style="font-size:12px; color:#888; display:flex; gap:8px; flex-wrap:wrap; margin-top:2px; align-items:center;">
                    ${c.industry ? `<span>${escapeHTML(c.industry)}</span>` : ''}
                    ${c.tone ? `<span>· ${escapeHTML(c.tone)}</span>` : ''}
                    <span style="color:#7eaaff;">· ${escapeHTML(sz)}</span>
                    <span style="color:#7eaaff;">· ${escapeHTML(ddLabel)}</span>
                    ${pillCount ? `<span style="color:#7eff7e;">· ${pillCount} products</span>` : ''}
                    ${sampleCount ? `<span style="color:#ffd97e;">· ${sampleCount} sample${sampleCount > 1 ? "s" : ""}</span>` : ''}
                    ${c.contactInCaption === false ? `<span style="color:#f88;">· 🚫 no contact in caption</span>` : ''}
                    ${c.storyEnabled ? `<span style="color:#ff97e7;">· 📱 story${c.songUrl ? " 🎵" : ""}</span>` : ''}
                    ${c.driveFolderUrl ? `<span style="color:#7eaaff;">· 📁 <a href="${escapeHTML(c.driveFolderUrl)}" target="_blank" style="color:#7eaaff;">drive</a></span>` : '<span style="color:#f88;">· ⚠ no Drive folder</span>'}
                    ${c.chatLink ? `<span style="color:#888;">· <a href="${escapeHTML(c.chatLink)}" target="_blank" style="color:#7eaaff;">chat</a></span>` : ''}
                    ${c.website ? `<span style="color:#666;">· <a href="${escapeHTML(c.website)}" target="_blank" style="color:#7eaaff;">site</a></span>` : ''}
                </div>
            </div>
            <div style="display:flex; gap:6px; align-items:center; flex-wrap:nowrap;">
                ${c.logoUrl
                    ? `<a href="${escapeHTML(c.logoUrl)}" target="_blank" title="Logo: ${escapeHTML(c.logoUrl)}">
                         <img src="${escapeHTML(c.logoUrl)}"
                              onerror="this.outerHTML='<span style=&quot;font-size:10px;color:#f88;padding:0 4px;&quot;>logo broken</span>';"
                              style="width:36px; height:36px; object-fit:cover;
                                     border-radius:6px; border:1px solid #2a2a2a; background:#0a0a0a;">
                       </a>`
                    : '<span style="font-size:10px; color:#555; padding:0 4px;">no logo</span>'
                }
                ${c.footerUrl
                    ? `<a href="${escapeHTML(c.footerUrl)}" target="_blank" title="Footer: ${escapeHTML(c.footerUrl)}">
                         <img src="${escapeHTML(c.footerUrl)}"
                              onerror="this.outerHTML='<span style=&quot;font-size:10px;color:#f88;padding:0 4px;&quot;>footer broken</span>';"
                              style="width:36px; height:36px; object-fit:cover;
                                     border-radius:6px; border:1px solid #2a2a2a; background:#0a0a0a;">
                       </a>`
                    : '<span style="font-size:10px; color:#555; padding:0 4px;">no footer</span>'
                }
                <button
                    onclick="editClient('${encodeURIComponent(c.name).replace(/'/g, "\\'")}')"
                    style="background:#1d2435; border:1px solid #2c3a52; color:#aac;
                           padding:6px 10px; border-radius:6px; cursor:pointer;
                           white-space:nowrap; font-size:12px;">
                    ✏ Edit
                </button>
                ${c.website
                    ? `<button
                        onclick="refreshProducts('${encodeURIComponent(c.name).replace(/'/g, "\\'")}')"
                        style="background:#1d3a2a; border:1px solid #2c5a3a; color:#aef;
                               padding:6px 10px; border-radius:6px; cursor:pointer;
                               white-space:nowrap; font-size:12px;">
                        🔍 Scrape
                    </button>`
                    : ''
                }
                <button
                    onclick="deleteClient('${encodeURIComponent(c.name).replace(/'/g, "\\'")}')"
                    style="background:#3a1010; border:1px solid #5a2020; color:#ffaaaa;
                           padding:6px 10px; border-radius:6px; cursor:pointer;
                           white-space:nowrap; font-size:12px;">
                    🗑
                </button>
            </div>
        </div>`;
    }).join("");
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
    const getRadio = name =>
        document.querySelector(`input[name="${name}"]:checked`)?.value || "";

    const payload = {
        name:        $("name").value.trim(),
        industry:    $("industry").value.trim(),
        tone:        $("tone").value.trim(),
        audience:    $("audience").value.trim(),
        services:    $("services").value.trim(),
        style:       $("style").value.trim(),
        cta:         $("cta").value.trim(),
        website:     $("website")?.value.trim()     || "",
        phone:       $("phone")?.value.trim()       || "",
        email:       $("email")?.value.trim()       || "",
        description: $("description")?.value.trim() || "",
        chatLink:    $("chatLink")?.value.trim()    || "",
        driveFolderUrl: $("driveFolderUrl")?.value.trim() || "",
        postSize:    getRadio("postSize") || "1:1",
        postDays:    getRadio("postDays") || "mwf",
        contactInCaption: !!$("contactInCaption")?.checked,
        storyEnabled:     !!$("storyEnabled")?.checked
    };

    if (!payload.name) {
        alert("Brand Name is required");
        return;
    }

    if (window.__pendingLogoData === "__REMOVE__") {
        payload.logoUrl = "__REMOVE__";
    } else if (window.__pendingLogoData) {
        payload.logoDataUrl = window.__pendingLogoData;
    }

    if (window.__pendingFooterData === "__REMOVE__") {
        payload.footerUrl = "__REMOVE__";
    } else if (window.__pendingFooterData) {
        payload.footerDataUrl = window.__pendingFooterData;
    }

    // Sample posts:
    //   - window.__pendingSamplesDataUrls = [base64s] → upload + append
    //   - window.__currentSampleUrls (set on edit) = [URLs] → preserved/edited list
    if (Array.isArray(window.__pendingSamplesDataUrls) && window.__pendingSamplesDataUrls.length) {
        payload.samplePostsDataUrls = window.__pendingSamplesDataUrls;
    }
    if (Array.isArray(window.__currentSampleUrls)) {
        // User may have removed some via remove buttons → send the final list as replacement
        payload.samplePostsUrls = window.__currentSampleUrls;
    }

    // Song (audio file for stories)
    if (window.__pendingSongData === "__REMOVE__") {
        payload.songUrl = "__REMOVE__";
    } else if (window.__pendingSongData) {
        payload.songDataUrl = window.__pendingSongData;
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
            cancelEdit(); // resets form + previews
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
   EDIT EXISTING CLIENT — pre-fills the form
============================================================ */

async function editClient(encodedName) {

    const name = decodeURIComponent(encodedName);

    try {

        const r = await fetch("/clients/" + encodeURIComponent(name));
        if (!r.ok) throw new Error("Client not found");
        const c = await r.json();

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ""; };

        set("name",        c.name);
        set("industry",    c.industry);
        set("tone",        c.tone);
        set("audience",    c.audience);
        set("services",    c.services);
        set("style",       c.style);
        set("cta",         c.cta);
        set("website",     c.website);
        set("phone",       c.phone);
        set("email",       c.email);
        set("description", c.description);
        set("chatLink",    c.chatLink);
        set("driveFolderUrl", c.driveFolderUrl);

        const cic = document.getElementById("contactInCaption");
        const sen = document.getElementById("storyEnabled");
        // undefined = treat as ON (default for existing clients without the field)
        if (cic) cic.checked = c.contactInCaption === undefined ? true : !!c.contactInCaption;
        if (sen) sen.checked = !!c.storyEnabled;
        toggleStoryPanel();

        // Song
        window.__pendingSongData = null;
        window.__currentSongUrl = c.songUrl || "";
        renderSongPreview();

        const nameEl = document.getElementById("name");
        if (nameEl) nameEl.disabled = true;

        const sz = c.postSize || "1:1";
        const dd = c.postDays || "mwf";
        const szR = document.querySelector(`input[name="postSize"][value="${sz}"]`);
        const ddR = document.querySelector(`input[name="postDays"][value="${dd}"]`);
        if (szR) szR.checked = true;
        if (ddR) ddR.checked = true;

        window.__pendingLogoData = null;
        window.__pendingFooterData = null;
        window.__pendingSamplesDataUrls = null;
        window.__currentSampleUrls = Array.isArray(c.samplePosts) ? [...c.samplePosts] : [];

        const lp = document.getElementById("logoPreview");
        const fp = document.getElementById("footerPreview");
        const ls = document.getElementById("logoStatus");
        const fs = document.getElementById("footerStatus");
        if (c.logoUrl) {
            if (lp) lp.innerHTML = `<img src="${escapeHTML(c.logoUrl)}" style="max-height:140px; max-width:100%; object-fit:contain;">`;
            if (ls) ls.textContent = "Existing logo (upload new to replace)";
        } else {
            if (lp) lp.innerHTML = "No logo yet";
            if (ls) ls.textContent = "No file chosen";
        }
        if (c.footerUrl) {
            if (fp) fp.innerHTML = `<img src="${escapeHTML(c.footerUrl)}" style="max-height:140px; max-width:100%; object-fit:contain;">`;
            if (fs) fs.textContent = "Existing footer (upload new to replace)";
        } else {
            if (fp) fp.innerHTML = "No footer yet";
            if (fs) fs.textContent = "No file chosen";
        }

        renderSamplePreviews();

        const eb = document.getElementById("editingBadge");
        const cb = document.getElementById("cancelEditBtn");
        if (eb) eb.style.display = "inline";
        if (cb) cb.style.display = "inline-block";

        addAutomationLog(`✏ Editing "${name}" — scroll up to the form`, "info");
        window.scrollTo({ top: 0, behavior: "smooth" });

    } catch (e) {
        addAutomationLog(`❌ Could not load client: ${e.message}`, "err");
        alert("Failed to load client: " + e.message);
    }
}

function cancelEdit() {

    ["name","industry","tone","audience","services","style","cta","website","phone","email","description","chatLink","driveFolderUrl"]
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });

    const nameEl = document.getElementById("name");
    if (nameEl) nameEl.disabled = false;

    const szR = document.querySelector('input[name="postSize"][value="1:1"]');
    const ddR = document.querySelector('input[name="postDays"][value="mwf"]');
    if (szR) szR.checked = true;
    if (ddR) ddR.checked = true;

    const cic = document.getElementById("contactInCaption");
    const sen = document.getElementById("storyEnabled");
    if (cic) cic.checked = true;    // default ON for new clients
    if (sen) sen.checked = false;
    toggleStoryPanel();

    resetLogoFooterUI();

    // Reset samples
    window.__pendingSamplesDataUrls = null;
    window.__currentSampleUrls = [];
    renderSamplePreviews();
    const sf = document.getElementById("sampleFiles");
    if (sf) sf.value = "";

    // Reset song
    window.__pendingSongData = null;
    window.__currentSongUrl = "";
    const sng = document.getElementById("songFile");
    if (sng) sng.value = "";
    renderSongPreview();

    const eb = document.getElementById("editingBadge");
    const cb = document.getElementById("cancelEditBtn");
    if (eb) eb.style.display = "none";
    if (cb) cb.style.display = "none";
}

/* ============================================================
   REFRESH PRODUCTS — scrape website on demand
============================================================ */

async function refreshProducts(encodedName) {

    const name = decodeURIComponent(encodedName);

    if (!confirm(`Scrape "${name}" website now? This will read products from their site and may take 10-20 seconds.`)) return;

    addAutomationLog(`🔍 Scraping products for "${name}"…`, "info");

    try {

        const r = await fetch("/clients/" + encodeURIComponent(name) + "/scrape-products", {
            method: "POST"
        });

        const d = await r.json();

        if (d.success) {
            addAutomationLog(`✓ Found ${d.count} product(s) for "${name}" (source: ${d.source})`, "ok");
            if (d.count === 0) {
                addAutomationLog(`⚠ The site may use JavaScript rendering or block scraping. Add details in the Description field instead.`, "warn");
            }
            loadClients();
        } else {
            addAutomationLog(`❌ Scrape failed: ${d.error || "unknown"}`, "err");
        }

    } catch (e) {
        addAutomationLog(`❌ Scrape failed: ${e.message}`, "err");
    }
}

/* ============================================================
   SAMPLE POSTS — handlers
============================================================ */

window.__pendingSamplesDataUrls = null;
window.__currentSampleUrls = [];

function onSamplesChosen(input) {

    const files = Array.from(input.files || []);
    if (!files.length) return;

    const dataUrls = [];
    let pending = files.length;

    files.forEach(f => {
        const reader = new FileReader();
        reader.onload = () => {
            dataUrls.push(reader.result);
            if (--pending === 0) {
                window.__pendingSamplesDataUrls =
                    (window.__pendingSamplesDataUrls || []).concat(dataUrls);
                renderSamplePreviews();
            }
        };
        reader.onerror = () => {
            if (--pending === 0) renderSamplePreviews();
        };
        reader.readAsDataURL(f);
    });
}

function renderSamplePreviews() {

    const box = document.getElementById("samplePreviews");
    const status = document.getElementById("sampleStatus");
    const placeholder = document.getElementById("samplePlaceholder");
    if (!box) return;

    const existing = window.__currentSampleUrls || [];
    const pending  = window.__pendingSamplesDataUrls || [];
    const total = existing.length + pending.length;

    if (status) status.textContent = total + " sample" + (total === 1 ? "" : "s");

    if (!total) {
        box.innerHTML = '<span id="samplePlaceholder" style="color:#444; font-size:11px; align-self:center; margin:0 auto;">No samples yet</span>';
        return;
    }

    let html = "";

    existing.forEach((url, i) => {
        html += `
        <div style="position:relative; width:80px; height:80px;">
            <img src="${escapeHTML(url)}"
                style="width:80px; height:80px; object-fit:cover; border-radius:6px; border:1px solid #2a2a2a;">
            <button
                onclick="removeExistingSample(${i})"
                style="position:absolute; top:-6px; right:-6px; width:20px; height:20px;
                       background:#3a1010; border:1px solid #5a2020;
                       color:#ffaaaa; border-radius:50%; cursor:pointer;
                       font-size:11px; line-height:1; padding:0;"
                title="Remove">×</button>
        </div>`;
    });

    pending.forEach((dataUrl, i) => {
        html += `
        <div style="position:relative; width:80px; height:80px;">
            <img src="${dataUrl}"
                style="width:80px; height:80px; object-fit:cover; border-radius:6px;
                       border:1px solid #3a3a1a; opacity:0.85;"
                title="Pending upload">
            <span style="position:absolute; bottom:2px; left:2px; right:2px;
                         font-size:9px; color:#fc7; background:rgba(0,0,0,0.7);
                         padding:1px 3px; border-radius:3px; text-align:center;">
                pending
            </span>
            <button
                onclick="removePendingSample(${i})"
                style="position:absolute; top:-6px; right:-6px; width:20px; height:20px;
                       background:#3a1010; border:1px solid #5a2020;
                       color:#ffaaaa; border-radius:50%; cursor:pointer;
                       font-size:11px; line-height:1; padding:0;"
                title="Cancel">×</button>
        </div>`;
    });

    box.innerHTML = html;
}

function removeExistingSample(i) {
    window.__currentSampleUrls.splice(i, 1);
    renderSamplePreviews();
}

function removePendingSample(i) {
    window.__pendingSamplesDataUrls.splice(i, 1);
    renderSamplePreviews();
}

/* ============================================================
   SONG (audio file for stories)
============================================================ */

window.__pendingSongData = null;
window.__currentSongUrl = "";

function toggleStoryPanel() {
    const enabled = !!document.getElementById("storyEnabled")?.checked;
    const panel = document.getElementById("songPanel");
    if (panel) panel.style.display = enabled ? "block" : "none";
}

function onSongChosen(input) {

    const file = input.files && input.files[0];
    if (!file) return;

    // Soft size check — 30 MB IG max
    if (file.size > 30 * 1024 * 1024) {
        alert("Song is too large. Instagram limits audio to ~30 MB.");
        input.value = "";
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        window.__pendingSongData = reader.result;
        renderSongPreview(file.name);
    };
    reader.onerror = () => alert("Could not read the audio file.");
    reader.readAsDataURL(file);
}

function renderSongPreview(pendingName) {

    const box = document.getElementById("songPreview");
    if (!box) return;

    if (window.__pendingSongData === "__REMOVE__") {
        box.innerHTML = '<span style="color:#f88;">Song will be removed on save</span>';
        return;
    }

    if (window.__pendingSongData) {
        const name = pendingName || "new song";
        box.innerHTML = `
            <span style="color:#7eff7e;">🎵 ${escapeHTML(name)}</span>
            <span style="color:#666; margin-left:6px; font-size:11px;">(pending upload)</span>`;
        return;
    }

    if (window.__currentSongUrl) {
        const fileName = window.__currentSongUrl.split("/").pop() || "song.mp3";
        box.innerHTML = `
            <audio src="${escapeHTML(window.__currentSongUrl)}" controls
                style="width:100%; height:32px; margin-bottom:6px;"></audio>
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                <span style="color:#888; font-size:11px;">${escapeHTML(fileName)}</span>
                <button onclick="removeSong()"
                    style="background:#3a1010; border:1px solid #5a2020;
                           color:#ffaaaa; padding:4px 10px; border-radius:5px;
                           cursor:pointer; font-size:11px;">
                    × Remove
                </button>
            </div>`;
        return;
    }

    box.innerHTML = 'No song set';
}

function removeSong() {
    window.__pendingSongData = "__REMOVE__";
    window.__currentSongUrl = "";
    const sf = document.getElementById("songFile");
    if (sf) sf.value = "";
    renderSongPreview();
}

/* ============================================================
   INSTAGRAM PUBLISH QUEUE
============================================================ */

/* ============================================================
   GOOGLE SERVICE ACCOUNT
============================================================ */

async function refreshGsaStatus() {
    const el = document.getElementById("gsaStatus");
    const clear = document.getElementById("gsaClearBtn");
    if (!el) return;
    try {
        const r = await fetch("/settings/google-sa");
        const d = await r.json();
        if (d.configured) {
            el.innerHTML = `<span style="color:#7eff7e;">✓ ${escapeHTML(d.client_email)}</span>`;
            if (clear) clear.style.display = "inline-block";
        } else {
            el.innerHTML = `<span style="color:#ffd97e;">⚠ not configured</span>`;
            if (clear) clear.style.display = "none";
        }
    } catch (e) {
        el.innerHTML = `<span style="color:#ff7e7e;">err: ${escapeHTML(e.message)}</span>`;
    }
}

async function saveGoogleSa() {
    const raw = document.getElementById("gsaJson")?.value?.trim();
    if (!raw) return alert("Paste the service account JSON first");
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { return alert("Invalid JSON: " + e.message); }

    if (parsed.type !== "service_account") {
        return alert("This doesn't look like a Service Account JSON. Make sure you downloaded the SA key, not OAuth credentials.");
    }
    if (!parsed.client_email || !parsed.private_key) {
        return alert("Missing client_email or private_key. Re-download the key.");
    }

    try {
        const r = await fetch("/settings/google-sa", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ json: parsed })
        });
        const d = await r.json();
        if (d.success) {
            addAutomationLog(`✓ Service account saved: ${d.client_email}`, "ok");
            alert("Saved. Now share each client's Drive folder with this email:\n\n" + d.client_email);
            document.getElementById("gsaJson").value = "";
            refreshGsaStatus();
        } else {
            alert("Save failed: " + (d.error || "unknown"));
        }
    } catch (e) {
        alert("Save failed: " + e.message);
    }
}

async function clearGoogleSa() {
    if (!confirm("Remove the saved service account? The weekly batch will stop working.")) return;
    await fetch("/settings/google-sa", { method: "DELETE" });
    addAutomationLog("Service account removed", "info");
    refreshGsaStatus();
}

/* ============================================================
   WEEKLY BATCH
============================================================ */

async function generateWeekForClient() {
    const name = document.getElementById("clients")?.value?.trim();
    if (!name) return alert("Pick a client first");

    if (!confirm(
        `Generate next week's posts for "${name}"?\n\n` +
        `This will queue prompts for Tampermonkey to process.\n` +
        `Make sure Tampermonkey is running on the right ChatGPT tab.`
    )) return;

    addAutomationLog(`📦 Starting weekly batch for "${name}"…`, "info");

    try {
        const r = await fetch("/weekly-gen/" + encodeURIComponent(name), { method: "POST" });
        const d = await r.json();
        if (r.ok && d.success) {
            const queued = (d.queued || []).filter(q => q.status === "queued").length;
            const already = (d.queued || []).filter(q => q.status === "already-queued").length;
            addAutomationLog(
                `✓ Weekly batch: ${queued} new prompt(s) queued, ${already} already queued`,
                "ok"
            );
            refreshDriveAssets();
            refreshQueuedPrompts();
        } else {
            addAutomationLog(`❌ Weekly batch failed: ${d.error || "unknown"}`, "err");
            alert("Failed: " + (d.error || "unknown"));
        }
    } catch (e) {
        addAutomationLog(`❌ Weekly batch failed: ${e.message}`, "err");
    }
}

async function approveWeekForClient() {
    const name = document.getElementById("clients")?.value?.trim();
    if (!name) return alert("Pick a client first");

    if (!confirm(
        `Approve and schedule "${name}"?\n\n` +
        `The server will read the live Drive folder and schedule everything ` +
        `that's in it to FB + Instagram for the next 7 posting days.`
    )) return;

    addAutomationLog(`✓ Approving "${name}"…`, "info");

    try {
        const r = await fetch("/approve-week/" + encodeURIComponent(name), { method: "POST" });
        const d = await r.json();
        if (r.ok && d.success) {
            addAutomationLog(
                `✓ "${name}" approved — ${d.scheduled} scheduled` +
                (d.items?.filter(i=>i.status==="failed").length ? ` (${d.items.filter(i=>i.status==="failed").length} failed)` : ""),
                "ok"
            );
            refreshDriveAssets();
            refreshAllQueues();
        } else {
            addAutomationLog(`❌ Approve failed: ${d.error || "unknown"}`, "err");
            alert("Failed: " + (d.error || "unknown"));
        }
    } catch (e) {
        addAutomationLog(`❌ Approve failed: ${e.message}`, "err");
    }
}

async function openDriveFolder() {
    const name = document.getElementById("clients")?.value?.trim();
    if (!name) return alert("Pick a client first");
    const r = await fetch("/clients/" + encodeURIComponent(name));
    const c = await r.json();
    if (c.driveFolderUrl) {
        window.open(c.driveFolderUrl, "_blank");
    } else {
        alert("This client has no Drive folder URL set. Edit the client to add one.");
    }
}

async function refreshDriveAssets() {

    const name = document.getElementById("clients")?.value?.trim() || "";
    const lbl = document.getElementById("weeklyClientLabel");
    if (lbl) lbl.textContent = name || "— pick a client above —";

    const list = document.getElementById("driveAssetsList");
    if (!list) return;

    if (!name) {
        list.innerHTML = `
            <div style="background:#161616; border:1px dashed #2a2a2a; border-radius:8px;
                        padding:18px; text-align:center; color:#666;">
                Select a client above to see their weekly batch assets.
            </div>`;
        return;
    }

    try {

        // Fetch both DB assets AND live Drive folder in parallel
        const [assetsRes, driveRes] = await Promise.all([
            fetch("/drive-assets/" + encodeURIComponent(name)),
            fetch("/drive-folder/" + encodeURIComponent(name))
        ]);

        const assets    = (await assetsRes.json()).items || [];
        const driveData = await driveRes.json();
        const driveFiles = driveData.files || [];

        // Build a "live" view: each Drive file + match to asset by filename
        const assetByFileName = new Map();
        assets.forEach(a => assetByFileName.set(a.fileName, a));

        let html = `<div style="margin-bottom:8px; font-size:12px; color:#888;">
            Drive: ${driveFiles.length} file(s) · DB tracking: ${assets.length} asset(s)
        </div>`;

        // Show queued-but-not-yet-in-Drive assets first (still processing)
        const inProgress = assets.filter(a =>
            ["queued", "generating", "failed"].includes(a.status) &&
            !driveFiles.find(f => f.name === a.fileName)
        );

        if (inProgress.length) {
            html += `<div style="margin-bottom:10px;">
                <div style="font-size:12px; color:#ffd97e; margin-bottom:6px;">⏳ Generating:</div>`;
            inProgress.forEach(a => {
                const statusColor =
                    a.status === "generating" ? "#ffd97e"
                  : a.status === "failed"     ? "#ff7e7e"
                  : "#888";
                html += `
                <div style="background:#161616; border:1px solid #2a2a2a; border-radius:6px;
                            padding:8px 12px; margin-bottom:4px; display:flex; gap:10px;
                            align-items:center; font-size:12px;">
                    <span style="color:${statusColor};">● ${a.status}</span>
                    <span style="flex:1;">${escapeHTML(a.fileName || "?")}</span>
                    <span style="color:#666;">${escapeHTML(a.calendarDate || "")}</span>
                    ${a.error ? `<span style="color:#ff7e7e; font-size:10px;">${escapeHTML(a.error.slice(0, 60))}</span>` : ""}
                </div>`;
            });
            html += "</div>";
        }

        // Show files currently in Drive
        if (driveFiles.length) {
            html += `<div style="font-size:12px; color:#7eff7e; margin-bottom:6px;">📁 In Drive (live):</div>`;
            driveFiles.forEach(f => {
                const asset = assetByFileName.get(f.name);
                const status = asset?.status || "in-drive";
                const isScheduled = status === "scheduled" || status === "published";
                const statusColor =
                    status === "scheduled" ? "#7eaaff"
                  : status === "published" ? "#7eff7e"
                  : "#888";

                html += `
                <div style="background:#161616; border:1px solid #2a2a2a; border-radius:6px;
                            padding:10px 12px; margin-bottom:4px; display:flex; gap:10px;
                            align-items:center; font-size:12px;">
                    <span style="color:${statusColor};">●</span>
                    <a href="${escapeHTML(f.webViewLink || "#")}" target="_blank"
                       style="flex:1; color:#aac; text-decoration:none; overflow:hidden;
                              text-overflow:ellipsis; white-space:nowrap;">
                        ${escapeHTML(f.name)}
                    </a>
                    <span style="color:#666; font-size:11px;">${escapeHTML(status)}</span>
                    ${asset?.calendarDate
                        ? `<span style="color:#666; font-size:11px;">→ ${escapeHTML(asset.calendarDate)}</span>`
                        : ""}
                </div>`;
            });
        } else if (!inProgress.length) {
            html += `
            <div style="background:#161616; border:1px dashed #2a2a2a; border-radius:8px;
                        padding:18px; text-align:center; color:#666; font-size:12px;">
                Drive folder is empty. Click <strong>▶ Generate Week</strong> to make a fresh batch.
            </div>`;
        }

        list.innerHTML = html;

    } catch (e) {
        list.innerHTML = `<div style="color:#ff7e7e; padding:8px; font-size:12px;">
            ${escapeHTML(e.message)}
        </div>`;
    }
}

async function refreshQueue(platform) {

    const endpoint  = platform === "fb" ? "/fb-queue" : "/ig-queue";
    const listId    = platform === "fb" ? "fbQueueList"  : "igQueueList";
    const countId   = platform === "fb" ? "fbQueueCount" : "igQueueCount";
    const platformName = platform === "fb" ? "Facebook" : "Instagram";

    try {

        const r = await fetch(endpoint);
        const d = await r.json();

        const list = document.getElementById(listId);
        const countEl = document.getElementById(countId);

        const items = d.items || [];
        if (countEl) countEl.textContent = items.length;

        if (!list) return;

        if (!items.length) {
            list.innerHTML = `
                <div style="background:#161616; border:1px dashed #2a2a2a; border-radius:8px;
                            padding:24px; text-align:center; color:#666;">
                    No ${platformName} posts queued.
                    <div style="font-size:11px; color:#444; margin-top:4px;">
                        Posts appear here while waiting to publish.
                    </div>
                </div>`;
            return;
        }

        const now = Date.now();

        list.innerHTML = items.map(job => {

            const due = new Date(job.scheduledAt);
            const msUntil = due.getTime() - now;
            const status = job.status;

            const statusColor =
                status === "processing" ? "#7eaaff"
              : status === "pending"    ? "#ffd97e"
              : status === "done"       ? "#7eff7e"
              : status === "failed"     ? "#ff7e7e"
              : status === "canceled"   ? "#888"
              :                            "#888";

            const countdownText =
                status === "processing" ? "publishing now…"
              : msUntil < 0             ? "due — firing"
              : msUntil < 60000         ? "< 1 min"
              : msUntil < 3600000       ? Math.floor(msUntil / 60000) + " min"
              : msUntil < 86400000      ? Math.floor(msUntil / 3600000) + " hr"
              :                            Math.floor(msUntil / 86400000) + " days";

            return `
            <div style="background:#161616; border:1px solid #2a2a2a; border-radius:8px;
                        padding:12px 14px; margin-bottom:6px; display:flex; gap:12px; align-items:center;">
                ${job.mediaUrl
                    ? `<img src="${escapeHTML(job.mediaUrl)}" style="width:48px; height:48px;
                        object-fit:cover; border-radius:6px; border:1px solid #2a2a2a; flex-shrink:0;">`
                    : ''}
                <div style="flex:1; min-width:0;">
                    <div style="font-weight:600; font-size:13px;">
                        ${escapeHTML(job.accountName || job.pageName || job.client || "?")}
                        ${job.mediaType === "story"
                            ? '<span style="font-size:10px; background:#ff97e7; color:#400022; padding:1px 6px; border-radius:8px; margin-left:6px; font-weight:600;">STORY</span>'
                            : ''}
                        <span style="font-size:10px; color:#666; font-weight:normal; margin-left:6px;">
                            ${job.client && job.client !== job.accountName ? '· ' + escapeHTML(job.client) : ''}
                        </span>
                    </div>
                    <div style="font-size:11px; color:#888; margin-top:2px; overflow:hidden;
                                text-overflow:ellipsis; white-space:nowrap; max-width:420px;">
                        ${job.mediaType === "story"
                            ? '<em>Instagram Story (24h)' + (job.mediaUrl?.endsWith('.mp4') ? ' · with audio' : '') + '</em>'
                            : escapeHTML(String(job.caption || "").slice(0, 80))}
                    </div>
                    <div style="font-size:11px; margin-top:4px;">
                        <span style="color:${statusColor};">● ${status}</span>
                        <span style="color:#666; margin-left:8px;">→ ${due.toLocaleString()}</span>
                        ${status === "pending" || status === "processing"
                            ? `<span style="color:#7eaaff; margin-left:8px;">(${countdownText})</span>`
                            : ''}
                    </div>
                    ${job.error
                        ? `<div style="font-size:11px; color:#ff7e7e; margin-top:2px;">${escapeHTML(job.error.slice(0, 200))}</div>`
                        : ''}
                </div>
                ${(status === "pending" || status === "processing")
                    ? `<button
                        onclick="cancelQueueJob('${platform}', '${job.jobId}')"
                        style="background:#3a1010; border:1px solid #5a2020;
                               color:#ffaaaa; padding:7px 12px; border-radius:6px;
                               cursor:pointer; font-size:12px; flex-shrink:0;">
                        🗑 Cancel
                    </button>`
                    : ''}
            </div>`;
        }).join("");

    } catch (e) {

        const list = document.getElementById(listId);
        if (list) list.innerHTML = `<div style="color:#ff7e7e; padding:10px;">Failed to load: ${escapeHTML(e.message)}</div>`;
    }
}

async function cancelQueueJob(platform, jobId) {

    const platformName = platform === "fb" ? "Facebook" : "Instagram";

    if (!confirm(`Cancel this ${platformName} post? It will not be published.`)) return;

    const endpoint = platform === "fb" ? "/fb-queue/" : "/ig-queue/";

    try {

        const r = await fetch(endpoint + encodeURIComponent(jobId), { method: "DELETE" });
        const d = await r.json();

        if (d.success) {
            addAutomationLog(`✓ Canceled ${platformName} post ${jobId}`, "ok");
            refreshQueue(platform);
        } else {
            addAutomationLog(`❌ Cancel failed: ${d.error || "unknown"}`, "err");
        }

    } catch (e) {
        addAutomationLog(`❌ Cancel failed: ${e.message}`, "err");
    }
}

// Backwards-compat wrappers
function refreshIgQueue() { return refreshQueue("ig"); }
function refreshFbQueue() { return refreshQueue("fb"); }
function refreshAllQueues() {
    refreshFbQueue();
    refreshIgQueue();
}

let __activeQueueTab = "fb";

function switchQueueTab(tab) {

    __activeQueueTab = tab;

    const fbList = document.getElementById("fbQueueList");
    const igList = document.getElementById("igQueueList");
    const fbTab = document.getElementById("qTab_fb");
    const igTab = document.getElementById("qTab_ig");

    if (tab === "fb") {
        if (fbList) fbList.style.display = "block";
        if (igList) igList.style.display = "none";
        if (fbTab) {
            fbTab.style.background = "#0f1a2e";
            fbTab.style.borderColor = "#1d3654";
            fbTab.style.color = "#7eaaff";
            fbTab.style.borderBottom = "none";
        }
        if (igTab) {
            igTab.style.background = "#161616";
            igTab.style.borderColor = "#2a2a2a";
            igTab.style.color = "#888";
            igTab.style.borderBottom = "1px solid #2a2a2a";
        }
    } else {
        if (fbList) fbList.style.display = "none";
        if (igList) igList.style.display = "block";
        if (igTab) {
            igTab.style.background = "#2e0f1a";
            igTab.style.borderColor = "#541d36";
            igTab.style.color = "#ff7eaa";
            igTab.style.borderBottom = "none";
        }
        if (fbTab) {
            fbTab.style.background = "#161616";
            fbTab.style.borderColor = "#2a2a2a";
            fbTab.style.color = "#888";
            fbTab.style.borderBottom = "1px solid #2a2a2a";
        }
    }
}

// Auto-refresh BOTH queues every 30 sec
setInterval(() => {
    if (document.getElementById("fbQueueList")) refreshFbQueue();
    if (document.getElementById("igQueueList")) refreshIgQueue();
}, 30000);

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

    const btn = document.getElementById("generateCalendarBtn");
    if (btn && btn.disabled) {
        // already in flight — guard against rapid double-clicks
        return;
    }
    if (btn) {
        btn.disabled = true;
        btn.textContent = "⏳ Generating… (up to 30 sec)";
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

        if (!response.ok || !Array.isArray(data)) {

            const msg = data?.error || ("HTTP " + response.status);
            const detail = data?.detail ? ` (${data.detail})` : "";

            // Tailor the message based on what failed
            let helpText;
            if (response.status === 429 || data?.source === "groq") {
                helpText = "Wait 30-60 seconds before clicking again — Groq's free tier has a request-per-minute limit.";
            } else if (response.status === 503) {
                helpText = "Database is reconnecting. Try again in 10 seconds.";
            } else if (response.status === 401) {
                helpText = "Groq API key needs to be fixed in Render env.";
            } else {
                helpText = "Click again to retry.";
            }

            addAutomationLog(
                "Calendar generation failed: " + msg + detail + " — " + helpText,
                "err"
            );

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

    } finally {

        if (btn) {
            btn.disabled = false;
            btn.textContent = "Generate Calendar";
        }
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

/* ============================================================
   EXPORT calendar as .xlsx
============================================================ */

function exportCalendarXlsx() {

    const name = document.getElementById("clients")?.value?.trim();
    if (!name) {
        alert("Pick a client first");
        return;
    }

    addAutomationLog(`📤 Exporting calendar for "${name}" to Excel…`, "info");

    // Simple navigation triggers the file download with the right headers
    const url = "/calendar/" + encodeURIComponent(name) + "/export.xlsx";
    window.location.href = url;
}

/* ============================================================
   IMPORT calendar from .xlsx — file picker triggers this
============================================================ */

async function importCalendarXlsx(input) {

    const file = input.files && input.files[0];
    input.value = ""; // reset picker so the same file can be re-imported

    if (!file) return;

    const name = document.getElementById("clients")?.value?.trim();
    if (!name) {
        alert("Pick a client first, then import their calendar.");
        return;
    }

    if (!confirm(
        `Replace the saved calendar for "${name}" with the contents of "${file.name}"?\n\n` +
        `This will overwrite the existing calendar. The current "done" markers will be lost ` +
        `unless they're in the Excel "Done" column.`
    )) return;

    addAutomationLog(`📥 Importing "${file.name}" into "${name}"…`, "info");

    try {

        const fd = new FormData();
        fd.append("file", file);

        const r = await fetch(
            "/calendar/" + encodeURIComponent(name) + "/import",
            { method: "POST", body: fd }
        );

        const d = await r.json();

        if (r.ok && d.success) {

            addAutomationLog(
                `✓ Imported ${d.imported} row(s) into "${name}"` +
                (d.skipped ? ` (${d.skipped} skipped)` : ""),
                "ok"
            );

            if (d.issues?.length) {
                d.issues.forEach(i => addAutomationLog(`   ${i}`, "warn"));
            }

            // Refresh the calendar view
            await loadSavedCalendar();

        } else {

            const msg = d.error || "Import failed";
            addAutomationLog(`❌ Import failed: ${msg}`, "err");
            if (d.issues?.length) {
                d.issues.forEach(i => addAutomationLog(`   ${i}`, "warn"));
            }
            alert("Import failed: " + msg);
        }

    } catch (e) {

        addAutomationLog(`❌ Import failed: ${e.message}`, "err");
        alert("Import failed: " + e.message);
    }
}

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

    /* ===== IG queue events ===== */

    es.addEventListener("ig-published", evt => {
        try {
            const d = JSON.parse(evt.data);
            addAutomationLog(`✅ Instagram published — ${d.client} (${d.metaPostId})`, "ok");
            refreshIgQueue();
        } catch (_) {}
    });

    es.addEventListener("ig-failed", evt => {
        try {
            const d = JSON.parse(evt.data);
            addAutomationLog(`❌ Instagram publish failed — ${d.client}: ${d.error}`, "err");
            refreshIgQueue();
        } catch (_) {}
    });

    es.addEventListener("ig-canceled", evt => {
        try {
            const d = JSON.parse(evt.data);
            addAutomationLog(`✓ Instagram post canceled — ${d.client}`, "info");
            refreshIgQueue();
        } catch (_) {}
    });

    /* ===== Weekly batch events ===== */

    es.addEventListener("weekly-uploaded", evt => {
        try {
            const d = JSON.parse(evt.data);
            if (d.status === "in-drive") {
                addAutomationLog(`📁 Drive: "${d.topic}" → ${d.client}`, "ok");
            } else {
                addAutomationLog(`❌ Drive upload failed (${d.client} / ${d.topic}): ${d.reason}`, "err");
            }
            refreshDriveAssets();
        } catch (_) {}
    });

    es.addEventListener("weekly-gen-started", evt => {
        try {
            const d = JSON.parse(evt.data);
            addAutomationLog(`📦 Weekly batch started: ${d.client} (${d.count} prompts)`, "info");
        } catch (_) {}
    });

    es.addEventListener("weekly-approved", evt => {
        try {
            const d = JSON.parse(evt.data);
            addAutomationLog(`✓ Weekly approved: ${d.client} — ${d.scheduled} scheduled`, "ok");
            refreshAllQueues();
        } catch (_) {}
    });

    /* ===== FB queue events ===== */

    es.addEventListener("fb-published", evt => {
        try {
            const d = JSON.parse(evt.data);
            addAutomationLog(`✅ Facebook published — ${d.client} (${d.metaPostId})`, "ok");
            refreshFbQueue();
        } catch (_) {}
    });

    es.addEventListener("fb-failed", evt => {
        try {
            const d = JSON.parse(evt.data);
            addAutomationLog(`❌ Facebook publish failed — ${d.client}: ${d.error}`, "err");
            refreshFbQueue();
        } catch (_) {}
    });

    es.addEventListener("fb-canceled", evt => {
        try {
            const d = JSON.parse(evt.data);
            addAutomationLog(`✓ Facebook post canceled — ${d.client}`, "info");
            refreshFbQueue();
        } catch (_) {}
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

        const selectedClient =
            document.getElementById("clients")?.value?.trim() || "";

        const label = document.getElementById("postsClientLabel");
        if (label) {
            label.textContent = selectedClient || "— pick a client above —";
        }

        const box = document.getElementById("posts");
        if (!box) return;

        if (!selectedClient) {
            box.innerHTML = `
                <div style="background:#161616; border:1px dashed #2a2a2a; border-radius:8px;
                            padding:24px; text-align:center; color:#666;">
                    Select a client in the Content Calendar section above to see their generated posts.
                </div>`;
            return;
        }

        const response = await fetch(
            "/posts?client=" + encodeURIComponent(selectedClient)
        );
        const posts    = await response.json();

        if (!Array.isArray(posts) || !posts.length) {
            box.innerHTML = `
                <div style="background:#161616; border:1px dashed #2a2a2a; border-radius:8px;
                            padding:24px; text-align:center; color:#666;">
                    No generated posts yet for <strong>${escapeHTML(selectedClient)}</strong>.
                    <div style="font-size:11px; color:#444; margin-top:4px;">
                        Trigger a generation and they'll appear here.
                    </div>
                </div>`;
            return;
        }

        box.innerHTML = `<div class="grid"></div>`;
        const grid    = box.querySelector(".grid");

        posts.slice(0, 12).forEach(post => {

            const card = document.createElement("div");
            card.className = "card";

            const isScheduled = post.scheduled === true || post.status === "scheduled";

            const scheduledLine = isScheduled && post.scheduleTime
                ? `<p class="status-line scheduled" style="font-size:11px; color:#7eaaff;">
                     📅 Scheduled for ${new Date(post.scheduleTime).toLocaleString()}
                   </p>`
                : '';

            const buttonLabel = isScheduled
                ? "🔄 Re-Schedule"
                : "Schedule Manually";

            const buttonStyle = isScheduled
                ? 'style="background:#1d2435; border:1px solid #2c3a52; color:#aac;"'
                : '';

            const onclickCall = isScheduled
                ? `confirmReschedule(${post.id})`
                : `schedulePost(${post.id})`;

            card.innerHTML = `
              <img src="${escapeHTML(post.image)}">
              <h2>${escapeHTML(post.client || "—")}</h2>
              <p>${escapeHTML(post.caption || "")}</p>
              <p>${escapeHTML(post.hashtags || "")}</p>
              <p class="status-line ${post.status}">${post.status}</p>
              ${scheduledLine}
              <div class="schedule-box">
                <input
                type="datetime-local"
                id="time-${post.id}"
                class="schedule-input"
                >
                <button
                class="schedule-btn"
                ${buttonStyle}
                onclick="${onclickCall}"
                >
                  ${buttonLabel}
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
        refreshAllQueues();

    } else {

        alert(
            "Failed: " +
            (typeof data.error === "string"
                ? data.error
                : JSON.stringify(data.error))
        );
    }
}

/* Wrapper for re-scheduling an already-scheduled post.
   Confirms with the user first since this cancels existing queue jobs. */

function confirmReschedule(id) {

    const timeInput = document.getElementById(`time-${id}`);
    if (!timeInput || !timeInput.value) {
        return alert("Pick a new schedule time first");
    }

    const newTime = new Date(timeInput.value).toLocaleString();

    const ok = confirm(
        `Re-schedule this post for ${newTime}?\n\n` +
        `Any pending FB / Instagram queued jobs for this post will be canceled ` +
        `and replaced with new ones at the new time.`
    );

    if (!ok) return;

    schedulePost(id);
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
    refreshAllQueues();
    refreshGsaStatus();
    setInterval(loadPosts, 8000);
    setInterval(refreshQueuedPrompts, 10000); // refresh queued list every 10s

    connectSSE();
})();