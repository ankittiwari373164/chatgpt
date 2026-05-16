/* ============================================================
   ChatGPT driver via headless Chrome (puppeteer-core).

   On Render / Linux servers we use @sparticuz/chromium which
   ships a Chromium binary bundle suitable for serverless /
   slim containers.

   On Windows / Mac (local dev) we fall back to whatever Chrome
   is installed on the machine.

   Session cookies live in MongoDB (collection: sessions, name
   "chatgpt"). You log in once locally → run the helper that
   stores the cookies → server can reuse them indefinitely
   until ChatGPT logs them out.
============================================================ */

const fs = require("fs");
const os = require("os");
const path = require("path");

let puppeteer;
let chromium;

try { puppeteer = require("puppeteer-core"); } catch (_) {}
try { chromium  = require("@sparticuz/chromium"); } catch (_) {}

const { Session } = require("../db/models");

/* ============================================================
   Resolve a Chromium binary path that actually exists.
============================================================ */

async function resolveExecutable() {

    /* 1. Explicit override */
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {

        return process.env.CHROME_PATH;
    }

    /* 2. Bundled @sparticuz/chromium (Linux serverless) */
    if (chromium) {

        try {

            const p = await chromium.executablePath();
            if (p && fs.existsSync(p)) return p;

        } catch (_) {}
    }

    /* 3. Common Windows location (local dev) */
    const win = [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ];

    for (const p of win) if (fs.existsSync(p)) return p;

    /* 4. Common macOS / Linux */
    const unix = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium"
    ];

    for (const p of unix) if (fs.existsSync(p)) return p;

    return null;
}

/* ============================================================
   BROWSER POOL — one shared browser instance, reused across
   prompts so we don't pay the cold-start cost every time.
============================================================ */

let browser  = null;
let busy     = false;

async function launchBrowser() {

    if (browser && browser.connected) return browser;

    const executablePath = await resolveExecutable();

    if (!executablePath) {

        throw new Error(
            "No Chromium binary found. On Render, @sparticuz/chromium " +
            "is bundled automatically. Locally, install Chrome or set " +
            "CHROME_PATH in .env."
        );
    }

    const args = chromium
        ? chromium.args
        : ["--no-sandbox", "--disable-setuid-sandbox"];

    console.log("🌐 Launching headless Chrome…");

    browser = await puppeteer.launch({
        executablePath,
        args:     [...args, "--disable-blink-features=AutomationControlled"],
        headless: chromium ? chromium.headless : "new",
        defaultViewport: { width: 1280, height: 800 }
    });

    browser.on("disconnected", () => {
        console.log("🔌 Chrome disconnected.");
        browser = null;
    });

    return browser;
}

/* ============================================================
   COOKIE MGMT — pull from MongoDB Session collection
============================================================ */

async function loadChatGPTCookies() {

    const sess = await Session.findOne({ name: "chatgpt" });

    if (!sess?.cookies || !Array.isArray(sess.cookies)) {

        throw new Error(
            "No ChatGPT cookies stored. Run the cookie-uploader " +
            "script (see README: 'Updating ChatGPT cookies')."
        );
    }

    return sess.cookies;
}

/* ============================================================
   MAIN  — send a prompt, wait for an image, return its URL
============================================================ */

async function generateViaChatGPT(prompt, opts = {}) {

    const TIMEOUT_MS = opts.timeoutMs || 4 * 60 * 1000; // 4 min

    if (busy) {

        throw new Error("Browser is busy with another prompt.");
    }

    busy = true;

    let page;

    try {

        const cookies = await loadChatGPTCookies();
        const b       = await launchBrowser();

        page = await b.newPage();

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
        );

        /* ---------- Inject cookies BEFORE the first navigation ---------- */

        await page.setCookie(...cookies);

        /* ---------- Go to ChatGPT ---------- */

        await page.goto("https://chatgpt.com/", {
            waitUntil: "domcontentloaded",
            timeout:   60000
        });

        // Give the SPA time to hydrate
        await page.waitForTimeout(4000);

        /* ---------- Quick sanity check: are we logged in? ---------- */

        const loggedIn = await page.evaluate(() => {

            const txt = document.body?.innerText?.toLowerCase() || "";

            return (
                document.querySelector('#prompt-textarea') ||
                document.querySelector('[contenteditable="true"]')
            ) && !txt.includes("log in") && !txt.includes("sign up");
        });

        if (!loggedIn) {

            throw new Error(
                "ChatGPT session expired or blocked. Re-upload fresh cookies."
            );
        }

        /* ---------- Track existing images so we know what's new ---------- */

        const seenSrcs = new Set(
            await page.$$eval("img", imgs => imgs.map(i => i.src))
        );

        /* ---------- Type the prompt ---------- */

        await page.focus('#prompt-textarea, [contenteditable="true"]');

        await page.evaluate((p) => {

            const el =
                document.querySelector('#prompt-textarea') ||
                document.querySelector('[contenteditable="true"]');

            if (!el) return;

            el.innerHTML = `<p></p>`;
            el.firstChild.textContent = p;

            el.dispatchEvent(new InputEvent('input', { bubbles: true }));

        }, prompt);

        await page.waitForTimeout(800);

        /* ---------- Send (Enter key) ---------- */

        await page.keyboard.press("Enter");

        console.log("📝 Prompt sent. Waiting for image…");

        /* ---------- Poll for a new big image ---------- */

        const started = Date.now();
        let imgUrl    = null;

        while (Date.now() - started < TIMEOUT_MS) {

            await page.waitForTimeout(4000);

            const candidate = await page.$$eval("img", (imgs, seen) => {

                for (let i = imgs.length - 1; i >= 0; i--) {

                    const img = imgs[i];
                    const src = img.src;

                    if (!src) continue;
                    if (seen.includes(src)) continue;
                    if (src.startsWith("blob:")) continue;
                    if (src.includes("avatar"))  continue;
                    if (src.includes("logo"))    continue;

                    const r = img.getBoundingClientRect();
                    if (r.width < 300 || r.height < 300) continue;

                    return src;
                }

                return null;

            }, [...seenSrcs]);

            if (candidate) {

                imgUrl = candidate;
                break;
            }
        }

        if (!imgUrl) {

            throw new Error("Timed out waiting for ChatGPT image.");
        }

        console.log("🖼  ChatGPT image:", imgUrl.slice(0, 90));

        /* ---------- Persist any refreshed cookies ---------- */

        try {

            const fresh = await page.cookies(
                "https://chatgpt.com", "https://chat.openai.com"
            );

            if (fresh.length) {

                await Session.findOneAndUpdate(
                    { name: "chatgpt" },
                    { cookies: fresh, updatedAt: new Date() },
                    { upsert: true }
                );
            }

        } catch (_) {}

        return imgUrl;

    } finally {

        try { if (page) await page.close(); } catch (_) {}
        busy = false;
    }
}

/* ============================================================
   PUBLIC API
============================================================ */

module.exports = {

    generateViaChatGPT,

    /* called once after upload of fresh cookies, to verify */
    async testLogin() {

        const cookies = await loadChatGPTCookies();
        const b       = await launchBrowser();

        const page = await b.newPage();

        try {

            await page.setUserAgent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
            );

            await page.setCookie(...cookies);

            await page.goto("https://chatgpt.com/", {
                waitUntil: "domcontentloaded",
                timeout:   60000
            });

            await page.waitForTimeout(3000);

            const ok = await page.evaluate(() => !!(
                document.querySelector('#prompt-textarea') ||
                document.querySelector('[contenteditable="true"]')
            ));

            return ok;

        } finally {

            try { await page.close(); } catch (_) {}
        }
    },

    async shutdown() {

        if (browser) {

            try { await browser.close(); } catch (_) {}
            browser = null;
        }
    }
};
