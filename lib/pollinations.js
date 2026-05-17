/* ============================================================
   Pollinations.ai — free, no-key image generation.

   Used as automatic fallback when Puppeteer + ChatGPT fails.

   Disable with IMAGE_FALLBACK_ENABLED=false in .env.

   Note: Pollinations sometimes returns an empty body when
   first hit. We retry with a small delay, then with a slightly
   different cache-busting param to force fresh generation.
============================================================ */

const axios = require("axios");

const POLL_BASE = "https://image.pollinations.ai/prompt/";

async function generateViaPollinations(prompt) {

    if (process.env.IMAGE_FALLBACK_ENABLED === "false") {

        throw new Error("Pollinations fallback is disabled.");
    }

    const safePrompt = encodeURIComponent(prompt.slice(0, 1000));
    const base = POLL_BASE + safePrompt;

    // Try a few times — Pollinations is flaky on cold requests
    let lastErr;

    for (let attempt = 1; attempt <= 4; attempt++) {

        const seed = Date.now() + attempt;
        const url  = `${base}?width=1024&height=1024&nologo=true&model=flux&seed=${seed}`;

        console.log(`🌻 Pollinations attempt ${attempt}:`, url.slice(0, 110), "…");

        try {

            const r = await axios.get(url, {
                responseType: "arraybuffer",
                timeout:      120000,
                validateStatus: () => true
            });

            // Did we actually get image bytes?
            if (r.status === 200 &&
                r.data &&
                r.data.byteLength > 1000 &&     // bigger than a 1×1 transparent png
                /image\//.test(r.headers["content-type"] || "")) {

                console.log(`🌻 Pollinations OK: ${r.data.byteLength} bytes`);

                // Return as data URL so Cloudinary can upload it
                const b64 = Buffer.from(r.data).toString("base64");
                const mt  = r.headers["content-type"] || "image/jpeg";
                return `data:${mt};base64,${b64}`;
            }

            lastErr = new Error(
                `Pollinations returned ${r.status} / ${r.data?.byteLength || 0} bytes / ${r.headers["content-type"]}`
            );

        } catch (err) {

            lastErr = err;
        }

        // Backoff before next attempt
        await new Promise(r => setTimeout(r, 3000 * attempt));
    }

    throw new Error(
        "Pollinations failed after 4 attempts: " + (lastErr?.message || "unknown error")
    );
}

module.exports = { generateViaPollinations };