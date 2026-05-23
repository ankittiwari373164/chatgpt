/* ============================================================
   Google Gemini API — image generation (no card, free tier).

   Uses gemini-2.5-flash-image ("Nano Banana"). Free tier:
   ~500 image requests per day, no credit card required.
   Sign up at https://aistudio.google.com — click "Get API key".

   Set GEMINI_API_KEY in .env / Render env.
============================================================ */

const axios = require("axios");

const MODEL    = "gemini-2.5-flash-image";
const ENDPOINT =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/* ============================================================
   Generate one image. Returns a data URL (base64) — same shape
   as the Pollinations module so Cloudinary upload code keeps
   working without changes.
============================================================ */

async function generateViaGemini(prompt, opts = {}) {

    const key = process.env.GEMINI_API_KEY;

    if (!key) {

        throw new Error(
            "GEMINI_API_KEY is not set. Get one free at " +
            "https://aistudio.google.com (no credit card required)."
        );
    }

    if (!prompt || !prompt.trim()) {

        throw new Error("Empty prompt passed to Gemini.");
    }

    const body = {
        contents: [{
            role: "user",
            parts: [{
                text:
                    "Generate a single high-quality social media image for the " +
                    "following description. Return ONLY the image.\n\n" +
                    prompt.slice(0, 2500)
            }]
        }],
        generationConfig: {
            responseModalities: ["IMAGE"]
        }
    };

    let r;

    try {

        r = await axios.post(
            ENDPOINT + "?key=" + encodeURIComponent(key),
            body,
            {
                headers: { "Content-Type": "application/json" },
                timeout: 60000,
                validateStatus: () => true
            }
        );

    } catch (err) {

        throw new Error("Gemini network error: " + err.message);
    }

    if (r.status === 429) {

        throw new Error(
            "Gemini rate-limited (429) — daily free-tier quota reached. " +
            "Quota resets at midnight UTC."
        );
    }

    if (r.status === 403) {

        throw new Error(
            "Gemini 403 — API key invalid, or the Gemini API isn't enabled " +
            "for your region. Check at https://aistudio.google.com."
        );
    }

    if (r.status >= 400) {

        const msg = r.data?.error?.message ||
                    JSON.stringify(r.data).slice(0, 200);

        throw new Error(`Gemini HTTP ${r.status}: ${msg}`);
    }

    /* ---------- Find the image part in the response ---------- */

    const parts = r.data?.candidates?.[0]?.content?.parts || [];

    const imgPart = parts.find(
        p => p?.inlineData?.data && /image\//.test(p.inlineData.mimeType || "")
    );

    if (!imgPart) {

        // Sometimes the model refuses or returns only text — surface that
        const textOut = parts.find(p => p?.text)?.text || "";

        throw new Error(
            "Gemini returned no image. " +
            (textOut ? "Model said: " + textOut.slice(0, 200) : "")
        );
    }

    const mime = imgPart.inlineData.mimeType || "image/png";
    const b64  = imgPart.inlineData.data;

    console.log(
        `🍌 Gemini image OK: ${Math.round(b64.length * 0.75 / 1024)} KB, ${mime}`
    );

    return `data:${mime};base64,${b64}`;
}

module.exports = { generateViaGemini };