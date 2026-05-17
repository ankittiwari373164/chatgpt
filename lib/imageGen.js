/* ============================================================
   imageGen — image generation router.

   IMAGE_ENGINE values:
     "tampermonkey"  → queue a Prompt for the Tampermonkey
                       script on your PC to pick up.
     "gemini"        → call Gemini API directly (free)
     "puppeteer"     → headless Chrome on the server (legacy)
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

    if (ENGINE === "tampermonkey") {
        return { url: null, source: "queued" };
    }

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
        try {
            const dataUrl  = await generateViaGemini(prompt, opts);
            const uploaded = await uploadToCloudinary(dataUrl);
            return { url: uploaded, source: "gemini" };
        } catch (err) {
            primaryErr = err;
            console.log("⚠ Gemini failed:", err.message);
        }
    }

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
        const r = await cloudinary.uploader.upload(srcUrl, { folder: "ai-content" });
        return r.secure_url;
    } catch (err) {
        console.log("Cloudinary upload failed, using raw URL:", err.message);
        return srcUrl;
    }
}

module.exports = { generateImage, ENGINE };