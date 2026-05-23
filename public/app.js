/* ============================================================
   STATE
============================================================ */

let schedulerQueue = [];   // posts currently displayed in file-queue

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
        contactInCaption: !!$("contactInCaption")?.checked
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
        // undefined = treat as ON (default for existing clients without the field)
        if (cic) cic.checked = c.contactInCaption === undefined ? true : !!c.contactInCaption;

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
    if (cic) cic.checked = true;    // default ON for new clients

    resetLogoFooterUI();

    // Reset samples
    window.__pendingSamplesDataUrls = null;
    window.__currentSampleUrls = [];
    renderSamplePreviews();
    const sf = document.getElementById("sampleFiles");
    if (sf) sf.value = "";

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
   GOOGLE DRIVE — OAuth + Service Account
============================================================ */

async function refreshGsaStatus() {
    const el        = document.getElementById("gsaStatus");
    const clearBtn  = document.getElementById("gsaClearBtn");
    const connBtn   = document.getElementById("oauthConnectBtn");
    const disconBtn = document.getElementById("oauthDisconnectBtn");
    if (!el) return;

    try {
        const r = await fetch("/settings/google-sa");
        const d = await r.json();

        if (d.configured && d.mode === "oauth") {
            el.innerHTML = `<span style="color:#7eff7e;">✓ OAuth: ${escapeHTML(d.email || "connected")}</span>`;
            if (clearBtn)  clearBtn.style.display = "none";
            if (connBtn) {
                connBtn.style.display    = "none";
                connBtn.textContent      = "🔗 Connect Google";
            }
            if (disconBtn) disconBtn.style.display = "inline-block";

        } else if (d.configured && d.mode === "service-account") {
            el.innerHTML = `<span style="color:#ffd97e;">⚠ Service Account: ${escapeHTML(d.client_email)} <span style="color:#888;">(may hit quota errors on personal Gmail)</span></span>`;
            if (clearBtn)  clearBtn.style.display = "inline-block";
            if (connBtn) {
                connBtn.style.display    = "inline-block";
                connBtn.textContent      = "🔗 Connect Google (recommended)";
            }
            if (disconBtn) disconBtn.style.display = "none";

        } else {
            el.innerHTML = `<span style="color:#ffd97e;">⚠ not connected</span>`;
            if (clearBtn)  clearBtn.style.display = "none";
            if (connBtn) {
                connBtn.style.display    = "inline-block";
                connBtn.textContent      = "🔗 Connect Google";
            }
            if (disconBtn) disconBtn.style.display = "none";
        }
    } catch (e) {
        el.innerHTML = `<span style="color:#ff7e7e;">err: ${escapeHTML(e.message)}</span>`;
    }
}

async function disconnectOAuth() {
    if (!confirm(
        "Disconnect Google Drive?\n\n" +
        "The weekly batch will stop uploading until you reconnect."
    )) return;
    try {
        await fetch("/oauth/google", { method: "DELETE" });
        addAutomationLog("Google OAuth disconnected", "info");
        refreshGsaStatus();
    } catch (e) {
        alert("Disconnect failed: " + e.message);
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
    if (!confirm("Remove the saved service account?")) return;
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

/* Re-queue a single Drive asset for image regeneration.
   When the new image arrives, the old Drive file is deleted
   and replaced. */

async function regenerateAsset(assetId, topic) {

    if (!confirm(
        `Regenerate "${topic || "this image"}"?\n\n` +
        `A fresh prompt will be queued. When Tampermonkey delivers ` +
        `the new image, the old file in Drive will be replaced.`
    )) return;

    addAutomationLog(`🔄 Regenerating "${topic}"…`, "info");

    try {
        const r = await fetch("/regenerate-asset/" + encodeURIComponent(assetId), {
            method:  "POST"
        });
        const d = await r.json();

        if (r.ok && d.success) {
            addAutomationLog(`✓ Re-queued — waiting for Tampermonkey…`, "ok");
            refreshDriveAssets();
            refreshQueuedPrompts();
        } else {
            addAutomationLog(`❌ Regenerate failed: ${d.error || "unknown"}`, "err");
            alert("Failed: " + (d.error || "unknown"));
        }
    } catch (e) {
        addAutomationLog(`❌ Regenerate failed: ${e.message}`, "err");
    }
}

/* Clear all queued + failed DriveAssets and their pending Prompts
   for the selected client. Drive files already uploaded are kept. */

async function clearWeekForClient() {

    const name = document.getElementById("clients")?.value?.trim();
    if (!name) return alert("Pick a client first");

    if (!confirm(
        `Clear queued + failed batch for "${name}"?\n\n` +
        `This will remove:\n` +
        `  • All Tampermonkey prompts waiting for this client\n` +
        `  • All Drive-asset records with status "queued" or "failed"\n\n` +
        `Drive files already uploaded (in-drive) are KEPT.\n` +
        `You can then click ▶ Generate Week to start fresh.`
    )) return;

    addAutomationLog(`🗑 Clearing queue for "${name}"…`, "info");

    try {
        const r = await fetch("/weekly-gen/" + encodeURIComponent(name), {
            method: "DELETE"
        });
        const d = await r.json();

        if (r.ok && d.success) {
            addAutomationLog(
                `✓ Cleared — ${d.promptsDeleted} prompt(s), ${d.assetsDeleted} asset(s) removed`,
                "ok"
            );
            refreshDriveAssets();
            refreshQueuedPrompts();
        } else {
            addAutomationLog(`❌ Clear failed: ${d.error || "unknown"}`, "err");
            alert("Failed: " + (d.error || "unknown"));
        }
    } catch (e) {
        addAutomationLog(`❌ Clear failed: ${e.message}`, "err");
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
                const statusColor =
                    status === "in-drive" ? "#7eff7e"
                  : status === "queued"   ? "#ffd97e"
                  : "#888";

                // Asset ID needed for regenerate. If no asset row, button is disabled.
                const assetId = asset?._id || "";
                const escTopic = escapeHTML((asset?.topic || f.name.replace(/\.[^.]+$/, "")).replace(/'/g, "\\'"));

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
                    ${assetId
                        ? `<button onclick="regenerateAsset('${assetId}','${escTopic}')"
                            style="background:#2e1a3a; border:1px solid #4a2c5e;
                                   color:#d8a4f0; padding:5px 10px; border-radius:5px;
                                   cursor:pointer; font-size:11px; white-space:nowrap;">
                            🔄 Regenerate
                          </button>`
                        : `<span style="color:#666; font-size:10px; padding:5px 10px;">no asset</span>`}
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

            // Server is uploading this image to Drive (weekly batch). Nothing
            // to do on the dashboard except refresh views.
            if (post.weeklyBatch) {
                addAutomationLog(
                    `📷 New image: ${post.client} — uploading to Drive`,
                    "info"
                );
                loadPosts();
                refreshDriveAssets();
                return;
            }

            // Manual one-off post (no weekly context): just refresh the
            // generated-posts list. No scheduling — MetaFlow handles that.
            addAutomationLog(
                `📷 New image saved: ${post.client}`,
                "ok"
            );
            loadPosts();

        } catch (e) {

            console.log(e);
        }
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

    es.addEventListener("weekly-regenerate-queued", evt => {
        try {
            const d = JSON.parse(evt.data);
            addAutomationLog(`🔄 Regenerate queued for asset ${d.assetId}`, "info");
            refreshDriveAssets();
        } catch (_) {}
    });

    es.addEventListener("weekly-cleared", evt => {
        try {
            const d = JSON.parse(evt.data);
            addAutomationLog(
                `🗑 Queue cleared for ${d.client} — ${d.promptsDeleted} prompt(s), ${d.assetsDeleted} asset(s)`,
                "info"
            );
            refreshDriveAssets();
            refreshQueuedPrompts();
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

            card.innerHTML = `
              <img src="${escapeHTML(post.image)}">
              <h2>${escapeHTML(post.client || "—")}</h2>
              <p>${escapeHTML(post.caption || "")}</p>
              <p>${escapeHTML(post.hashtags || "")}</p>
              <p class="status-line ${post.status}">${post.status}</p>
            `;

            grid.appendChild(card);
        });

    } catch (e) {

        console.log(e);
    }
}

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
    await loadPersistedLogs();
    await refreshQueuedPrompts();

    loadPosts();
    refreshGsaStatus();
    setInterval(loadPosts, 8000);
    setInterval(refreshQueuedPrompts, 10000);

    connectSSE();
})();