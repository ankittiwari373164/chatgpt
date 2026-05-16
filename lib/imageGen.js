/* ============================================================
   imageGen — primary path tries ChatGPT via Puppeteer, falls
   back to Pollinations.ai if it fails.

   Returns: { url, source }
     url    — public URL of the generated image
     source — "puppeteer" | "pollinations"
============================================================ */

const cloudinary = require("cloudinary").v2;

const { generateViaChatGPT }     = require("./puppeteerChatGPT");
const { generateViaPollinations } = require("./pollinations");

let consecutivePuppeteerFailures = 0;
const FAILURE_CIRCUIT_THRESHOLD = 2;
// After 2 consecutive failures, skip Puppeteer for an hour
let circuitOpenUntil = 0;

async function generateImage(prompt, opts = {}) {

    const preferred = (opts.preferred || "puppeteer").toLowerCase();

    /* ---------- Decide primary engine ---------- */

    let useFallbackOnly = preferred === "pollinations";

    if (Date.now() < circuitOpenUntil) {

        console.log("⚡ Puppeteer circuit OPEN — using fallback only.");
        useFallbackOnly = true;
    }

    /* ---------- Try Puppeteer ---------- */

    if (!useFallbackOnly) {

        try {

            const url = await generateViaChatGPT(prompt, opts);

            consecutivePuppeteerFailures = 0;

            const uploaded = await uploadToCloudinary(url);

            return { url: uploaded, source: "puppeteer" };

        } catch (err) {

            consecutivePuppeteerFailures++;

            console.log(
                `⚠ Puppeteer failed (${consecutivePuppeteerFailures}/${FAILURE_CIRCUIT_THRESHOLD}):`,
                err.message
            );

            if (consecutivePuppeteerFailures >= FAILURE_CIRCUIT_THRESHOLD) {

                circuitOpenUntil = Date.now() + 60 * 60 * 1000;

                console.log(
                    "🚦 Circuit breaker opened for 1 hour — Puppeteer suspended."
                );
            }
        }
    }

    /* ---------- Fallback ---------- */

    if (process.env.IMAGE_FALLBACK_ENABLED === "false") {

        throw new Error(
            "Puppeteer failed and fallback is disabled (IMAGE_FALLBACK_ENABLED=false)."
        );
    }

    const fallbackUrl = await generateViaPollinations(prompt);
    const uploaded    = await uploadToCloudinary(fallbackUrl);

    return { url: uploaded, source: "pollinations" };
}

/* ============================================================
   CLOUDINARY UPLOAD HELPER
============================================================ */

async function uploadToCloudinary(srcUrl) {

    if (!process.env.CLOUDINARY_CLOUD_NAME) return srcUrl;

    try {

        const r = await cloudinary.uploader.upload(srcUrl, {
            folder: "ai-content"
        });

        return r.secure_url;

    } catch (err) {

        console.log("Cloudinary upload failed, using raw URL:", err.message);
        return srcUrl;
    }
}

module.exports = { generateImage };
