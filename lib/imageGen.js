/* ============================================================
   imageGen — image generation router.

   IMAGE_ENGINE values:

     "tampermonkey"  → queue a Prompt for the Tampermonkey
                       script on your PC to pick up. Returns
                       { url: null, source: "queued" } —
                       the pipeline waits asynchronously for
                       Tampermonkey to deliver the image.

     "gemini"        → call Gemini API directly (free, no card)

     "puppeteer"     → headless Chrome on the server (legacy)

   For Render-hosted setup with Tampermonkey on your PC, use
   "tampermonkey" as the primary engine.

   Returns: { url, source } — or for tampermonkey mode,
            { url: null, source: "queued", queuedPromptId }
============================================================ */

const cloudinary = require("cloudinary").v2;

const { generateViaGemini }       = require("./gemini");
const { generateViaPollinations } = require("./pollinations");
const { generateViaChatGPT }      = require("./puppeteerChatGPT");

const ENGINE =
    (process.env.IMAGE_ENGINE || "tampermonkey").toLowerCase();

const FALLBACK_ENABLED =
    String(process.env.IMAGE_FALLBACK_ENABLED || "true").toLowerCase() !== "false";

async function generateImage(prompt, opts = {}) {

    /* ---------- tampermonkey: queue, don't generate inline ---------- */

    if (ENGINE === "tampermonkey") {

        // Caller (dailyCron) is responsible for actually creating
        // the queued Prompt record. We just signal "go that path".
        return { url: null, source: "queued" };
    }

    /* ---------- direct engines ---------- */

    let primaryErr = null;

    if (ENGINE === "puppeteer") {

        try {

            const url      = await generateViaChatGPT(prompt, opts);
            const uploaded = await uploadToCloudinary(url);
            return { url: uploaded, source: "puppeteer" };

        } catch (err) {

            primaryErr = err;
            console.log("⚠ Puppeteer/ChatGPT failed:", err.message);
        }

    } else {

        // gemini (default for direct generation)
        try {

            const dataUrl  = await generateViaGemini(prompt, opts);
            const uploaded = await uploadToCloudinary(dataUrl);
            return { url: uploaded, source: "gemini" };

        } catch (err) {

            primaryErr = err;
            console.log("⚠ Gemini failed:", err.message);
        }
    }

    /* ---------- Pollinations fallback ---------- */

    if (!FALLBACK_ENABLED) {

        throw new Error(
            `Primary engine (${ENGINE}) failed and fallback is disabled. ` +
            `Underlying: ${primaryErr?.message}`
        );
    }

    console.log("🌻 Falling back to Pollinations…");

    try {

        const fallbackUrl = await generateViaPollinations(prompt);
        const uploaded    = await uploadToCloudinary(fallbackUrl);
        return { url: uploaded, source: "pollinations" };

    } catch (fbErr) {

        throw new Error(
            `Both primary (${ENGINE}) and fallback (pollinations) failed. ` +
            `Primary: ${primaryErr?.message}. Fallback: ${fbErr.message}`
        );
    }
}

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

module.exports = { generateImage, ENGINE };