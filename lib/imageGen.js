/* ============================================================
   imageGen — ChatGPT (Puppeteer) is the ONLY image source.

   The Pollinations fallback is OFF by default. Set
   IMAGE_FALLBACK_ENABLED=true in .env to re-enable it.

   Returns: { url, source }
     url    — public URL of the generated image (Cloudinary)
     source — "puppeteer" | "pollinations"
============================================================ */

const cloudinary = require("cloudinary").v2;

const { generateViaChatGPT }      = require("./puppeteerChatGPT");
const { generateViaPollinations } = require("./pollinations");

const FALLBACK_ENABLED =
    String(process.env.IMAGE_FALLBACK_ENABLED || "").toLowerCase() === "true";

async function generateImage(prompt, opts = {}) {

    /* ---------- Try ChatGPT via Puppeteer ---------- */

    let chatgptErr = null;

    try {

        const url      = await generateViaChatGPT(prompt, opts);
        const uploaded = await uploadToCloudinary(url);

        return { url: uploaded, source: "puppeteer" };

    } catch (err) {

        chatgptErr = err;

        console.log("⚠ ChatGPT image generation failed:", err.message);
    }

    /* ---------- Optional fallback (OFF by default) ---------- */

    if (!FALLBACK_ENABLED) {

        // Surface the ChatGPT failure so the caller knows exactly
        // what went wrong (cookies expired, captcha, etc.)
        throw new Error(
            "ChatGPT image generation failed: " + chatgptErr.message +
            "  (Pollinations fallback is OFF — set IMAGE_FALLBACK_ENABLED=true to enable.)"
        );
    }

    console.log("🌻 Trying Pollinations fallback…");

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