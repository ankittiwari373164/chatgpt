/* ============================================================
   ChatGPT driver via headless Chrome — HARDENED STEALTH BUILD
   + diagnostic testLogin that returns details
============================================================ */

const fs = require("fs");

let puppeteer  = null;
let chromium   = null;
let loadErrors = [];

try { puppeteer = require("puppeteer-core"); }
catch (e) { loadErrors.push("puppeteer-core: " + e.message); }

try { chromium = require("@sparticuz/chromium"); }
catch (e) { loadErrors.push("@sparticuz/chromium: " + e.message); }

const { Session } = require("../db/models");

const REAL_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const ACCEPT_LANG = "en-IN,en-GB;q=0.9,en;q=0.8,hi;q=0.7";

async function resolveExecutable() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
        return process.env.CHROME_PATH;
    }
    if (chromium) {
        try {
            const p = await chromium.executablePath();
            if (p && fs.existsSync(p)) return p;
        } catch (e) {
            loadErrors.push("chromium.executablePath: " + e.message);
        }
    }
    const win = [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ];
    for (const p of win) if (fs.existsSync(p)) return p;
    const unix = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium"
    ];
    for (const p of unix) if (fs.existsSync(p)) return p;
    return null;
}

let browser = null;
let busy    = false;

async function launchBrowser() {
    if (!puppeteer) {
        throw new Error("puppeteer-core not loaded. Errors: " +
            (loadErrors.join(" | ") || "none recorded"));
    }
    if (browser && browser.connected) return browser;

    const executablePath = await resolveExecutable();
    if (!executablePath) {
        throw new Error("No Chromium binary found. Load errors: " +
            (loadErrors.join(" | ") || "none recorded"));
    }

    const baseArgs = chromium ? chromium.args : [];

    const stealthArgs = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process,AutomationControlled",
        "--disable-site-isolation-trials",
        "--disable-web-security",
        "--disable-features=BlockInsecurePrivateNetworkRequests",
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "--use-mock-keychain",
        "--lang=en-IN",
        "--accept-lang=en-IN,en;q=0.9",
        "--window-size=1280,800",
        "--user-agent=" + REAL_UA
    ];

    const skip = new Set(["--headless", "--headless=new", "--headless=old"]);

    const merged = Array.from(new Set([
        ...baseArgs.filter(a => !skip.has(a)),
        ...stealthArgs
    ]));

    console.log("🌐 Launching headless Chrome from:", executablePath);

    try {
        browser = await puppeteer.launch({
            executablePath,
            args:     merged,
            headless: "new",
            ignoreDefaultArgs: ["--enable-automation"],
            defaultViewport: {
                width:  1280, height: 800, deviceScaleFactor: 1,
                hasTouch: false, isLandscape: true, isMobile: false
            }
        });
    } catch (err) {
        throw new Error("Chrome failed to launch. Underlying: " + err.message);
    }

    browser.on("disconnected", () => {
        console.log("🔌 Chrome disconnected.");
        browser = null;
    });
    return browser;
}

async function applyStealth(page) {
    await page.setExtraHTTPHeaders({
        "Accept-Language": ACCEPT_LANG,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9," +
                  "image/avif,image/webp,image/apng,*/*;q=0.8",
        "Sec-Ch-Ua": '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
        "Sec-Ch-Ua-Mobile":   "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Upgrade-Insecure-Requests": "1"
    });

    await page.setUserAgent(REAL_UA);

    try {
        const client = await page.target().createCDPSession();
        await client.send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Kolkata" });
        await client.send("Emulation.setLocaleOverride", { locale: "en-IN" });
    } catch (_) {}

    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });

        Object.defineProperty(navigator, "plugins", {
            get: () => [
                { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format" }
            ]
        });

        Object.defineProperty(navigator, "languages", {
            get: () => ["en-IN", "en-GB", "en", "hi"]
        });

        Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
        Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });

        if (!window.chrome) window.chrome = {};
        window.chrome.app     = { isInstalled: false };
        window.chrome.runtime = window.chrome.runtime || {};

        const getParam = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (p) {
            if (p === 37445) return "Google Inc. (Intel)";
            if (p === 37446) return "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, OpenGL 4.5)";
            return getParam.call(this, p);
        };

        const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
        if (origQuery) {
            window.navigator.permissions.query = (parameters) =>
                parameters.name === "notifications"
                    ? Promise.resolve({ state: Notification.permission })
                    : origQuery(parameters);
        }

        try {
            const proto = HTMLIFrameElement.prototype;
            const orig  = Object.getOwnPropertyDescriptor(proto, "contentWindow");
            Object.defineProperty(proto, "contentWindow", {
                get() {
                    const w = orig.get.call(this);
                    try { if (w && !w.chrome) w.chrome = { app: {}, runtime: {} }; } catch (_) {}
                    return w;
                }
            });
        } catch (_) {}
    });
}

async function loadChatGPTCookies() {
    const sess = await Session.findOne({ name: "chatgpt" });
    if (!sess?.cookies || !Array.isArray(sess.cookies)) {
        throw new Error("No ChatGPT cookies stored. Upload via tools/upload-cookies.js.");
    }
    return sess.cookies;
}

async function warmUp(page) {
    try {
        await page.goto("about:blank");
        await sleep(800 + Math.random() * 600);

        await page.goto("https://chatgpt.com/", {
            waitUntil: "domcontentloaded",
            timeout:   60000
        });

        await sleep(2500 + Math.random() * 1500);
        await page.evaluate(() => window.scrollBy(0, 100));
        await sleep(800 + Math.random() * 500);
        await page.mouse.move(640, 400, { steps: 12 });
        await sleep(600);
    } catch (e) {
        console.log("warm-up step failed (non-fatal):", e.message);
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function generateViaChatGPT(prompt, opts = {}) {

    const TIMEOUT_MS = opts.timeoutMs || 4 * 60 * 1000;
    if (busy) throw new Error("Browser is busy with another prompt.");
    busy = true;

    let page;

    try {
        const cookies = await loadChatGPTCookies();
        const b       = await launchBrowser();
        page = await b.newPage();
        await applyStealth(page);

        const cdp = await page.target().createCDPSession();
        await cdp.send("Network.enable");
        for (const c of cookies) {
            try {
                await cdp.send("Network.setCookie", {
                    name: c.name, value: c.value, domain: c.domain,
                    path: c.path || "/",
                    secure: c.secure !== false,
                    httpOnly: !!c.httpOnly,
                    sameSite: c.sameSite || "Lax",
                    expires: c.expires || c.expirationDate
                });
            } catch (_) {}
        }

        await warmUp(page);

        const status = await page.evaluate(() => {
            const txt = (document.body?.innerText || "").toLowerCase();
            return {
                hasComposer: !!(
                    document.querySelector("#prompt-textarea") ||
                    document.querySelector('[contenteditable="true"]')
                ),
                hasChallenge: txt.includes("verify you are human") ||
                              txt.includes("checking your browser") ||
                              txt.includes("just a moment"),
                needsLogin: txt.includes("log in") && txt.includes("sign up"),
                bodySample: (document.body?.innerText || "").slice(0, 200)
            };
        });

        if (status.hasChallenge) {
            throw new Error("Cloudflare challenge detected — datacenter IP is being challenged.");
        }

        if (!status.hasComposer || status.needsLogin) {
            throw new Error("ChatGPT session expired or blocked. Page sample: " + status.bodySample.slice(0, 120));
        }

        const seenSrcs = new Set(
            await page.$$eval("img", imgs => imgs.map(i => i.src))
        );

        await page.mouse.move(500 + Math.random() * 200, 400 + Math.random() * 100, { steps: 8 });
        await sleep(300);
        await page.focus('#prompt-textarea, [contenteditable="true"]');

        await page.evaluate((p) => {
            const el = document.querySelector("#prompt-textarea") ||
                       document.querySelector('[contenteditable="true"]');
            if (!el) return;
            el.innerHTML = "<p></p>";
            el.firstChild.textContent = p;
            el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        }, prompt);

        await sleep(900 + Math.random() * 400);
        await page.keyboard.press("Enter");

        console.log("📝 Prompt sent. Waiting for image…");

        const started = Date.now();
        let imgUrl = null;

        while (Date.now() - started < TIMEOUT_MS) {
            await sleep(4000);
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

            if (candidate) { imgUrl = candidate; break; }
        }

        if (!imgUrl) throw new Error("Timed out waiting for ChatGPT image.");

        console.log("🖼  ChatGPT image:", imgUrl.slice(0, 90));

        try {
            const fresh = await page.cookies("https://chatgpt.com", "https://chat.openai.com");
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

module.exports = {

    generateViaChatGPT,

    async testLogin() {

        const cookies = await loadChatGPTCookies();
        const b       = await launchBrowser();
        const page = await b.newPage();

        try {
            await applyStealth(page);

            const cdp = await page.target().createCDPSession();
            await cdp.send("Network.enable");
            for (const c of cookies) {
                try {
                    await cdp.send("Network.setCookie", {
                        name: c.name, value: c.value, domain: c.domain,
                        path: c.path || "/",
                        secure: c.secure !== false,
                        httpOnly: !!c.httpOnly,
                        sameSite: c.sameSite || "Lax",
                        expires: c.expires || c.expirationDate
                    });
                } catch (_) {}
            }

            await warmUp(page);

            // Detailed page inspection so we know WHAT we're looking at
            const detail = await page.evaluate(() => {
                const txt = (document.body?.innerText || "");
                const low = txt.toLowerCase();
                return {
                    url:           location.href,
                    title:         document.title,
                    bodyLen:       txt.length,
                    bodySample:    txt.slice(0, 400),
                    hasComposer:   !!(
                        document.querySelector("#prompt-textarea") ||
                        document.querySelector('[contenteditable="true"]')
                    ),
                    hasChallenge:  low.includes("verify you are human") ||
                                   low.includes("checking your browser") ||
                                   low.includes("just a moment") ||
                                   low.includes("attention required"),
                    hasLoginForm:  !!document.querySelector('input[name="username"], input[type="email"]'),
                    has403:        low.includes("forbidden") || low.includes("access denied"),
                    needsLogin:    low.includes("log in") && low.includes("sign up"),
                    cookies:       document.cookie.length,
                    nav: {
                        webdriver: navigator.webdriver,
                        languages: navigator.languages,
                        plugins:   navigator.plugins.length,
                        ua:        navigator.userAgent.slice(0, 80)
                    }
                };
            });

            return {
                loggedIn: !!(detail.hasComposer && !detail.hasChallenge),
                detail
            };

        } finally {
            try { await page.close(); } catch (_) {}
        }
    },

    async shutdown() {
        if (browser) {
            try { await browser.close(); } catch (_) {}
            browser = null;
        }
    },

    async diagnose() {
        const out = {
            puppeteerLoaded:  !!puppeteer,
            chromiumLoaded:   !!chromium,
            loadErrors,
            executablePath:   null,
            executableExists: false
        };
        try {
            const p = await resolveExecutable();
            out.executablePath   = p;
            out.executableExists = !!(p && fs.existsSync(p));
        } catch (e) {
            out.resolveError = e.message;
        }
        return out;
    }
};