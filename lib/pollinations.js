/* ============================================================
   Pollinations.ai — free, no-key image generation.

   Used as automatic fallback when Puppeteer + ChatGPT fails.

   Disable with IMAGE_FALLBACK_ENABLED=false in .env.
============================================================ */

const axios = require("axios");

async function generateViaPollinations(prompt) {

    if (process.env.IMAGE_FALLBACK_ENABLED === "false") {

        throw new Error("Pollinations fallback is disabled.");
    }

    // Pollinations: image at /prompt/<encoded prompt>?width=1024&height=1024
    const url =
        "https://image.pollinations.ai/prompt/" +
        encodeURIComponent(prompt.slice(0, 1000)) +
        "?width=1024&height=1024&nologo=true&model=flux";

    console.log("🌻 Pollinations request:", url.slice(0, 110), "…");

    // We don't download the bytes — we just verify the URL responds
    // (Cloudinary can fetch it remotely).
    const r = await axios.head(url, { timeout: 90000 });

    if (r.status >= 400) {

        throw new Error("Pollinations returned HTTP " + r.status);
    }

    return url;
}

module.exports = { generateViaPollinations };
