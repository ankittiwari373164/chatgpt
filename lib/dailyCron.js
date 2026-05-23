/* ============================================================
   dailyCron.js — KEPT FOR ITS HELPERS ONLY.

   Originally this ran the full daily cron (generate image →
   caption → schedule to Meta). After the pivot to MetaFlow,
   scheduling is gone; this file now exists solely to expose
   the prompt / caption builders that weeklyBatch.js needs:

     buildImagePrompt(client, item)
     buildCaption(client, item, finalPrompt)
     augmentPrompt(basePrompt, client)
============================================================ */

const axios = require("axios");

/* ============================================================
   GROQ JSON HELPER
============================================================ */

async function groqJSON(prompt, opts = {}) {

    const maxAttempts = opts.maxAttempts || 4;

    let lastErr;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {

        try {

            const r = await axios.post(
                "https://api.groq.com/openai/v1/chat/completions",
                {
                    model:       "llama-3.1-8b-instant",
                    messages:    [{ role: "user", content: prompt }],
                    temperature: 0.85,
                    max_tokens:  900
                },
                {
                    headers: {
                        Authorization:
                        `Bearer ${process.env.GROQ_API_KEY}`
                    },
                    timeout: 60000
                }
            );

            const raw = r.data.choices[0].message.content || "";

            const parsed = parseGroqJSON(raw);
            if (parsed) return parsed;

            lastErr = new Error("Unparseable JSON from Groq");

        } catch (err) {

            lastErr = err;

            const status = err.response?.status;

            if (status === 429 && attempt < maxAttempts) {
                const waitMs = 1000 * Math.pow(2, attempt);
                console.log(
                    `  Groq 429 — backing off ${waitMs}ms (attempt ${attempt}/${maxAttempts})`
                );
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }

            if (!status && attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, 1500));
                continue;
            }

            break;
        }

        if (attempt < maxAttempts) {
            await new Promise(r => setTimeout(r, 800));
        }
    }

    console.log("groqJSON failed:", lastErr?.message);
    return null;
}

function parseGroqJSON(raw) {

    if (!raw || typeof raw !== "string") return null;

    let txt = raw.replace(/```json|```/g, "").trim();

    const s = txt.indexOf("{");
    const e = txt.lastIndexOf("}") + 1;
    if (s === -1 || e === 0) return null;

    txt = txt.substring(s, e);

    try { return JSON.parse(txt); } catch (_) {}

    try {
        return JSON.parse(txt.replace(/[\x00-\x1F\x7F]/g, " "));
    } catch (_) {}

    const result = {};
    const fieldRe = /"(\w+)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let m;
    while ((m = fieldRe.exec(txt)) !== null) {
        result[m[1]] = m[2]
            .replace(/\\n/g, "\n")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
    }

    return Object.keys(result).length ? result : null;
}

/* ============================================================
   buildImagePrompt — Groq turns a calendar item into a
   short, anchored image-generation prompt.
============================================================ */

async function buildImagePrompt(client, item) {

    const productsHint = client.productsCache?.items?.length
        ? "\nProducts available:\n" + client.productsCache.items.slice(0, 5)
              .map((p, i) => `${i+1}. ${p.title}${p.price ? " ("+p.price+")" : ""}`)
              .join("\n")
        : "";

    const hasSamples = Array.isArray(client.samplePosts) && client.samplePosts.length > 0;

    const styleGuard = hasSamples
        ? `STYLE — ABSOLUTE RULE:
This client has sample posts attached to ChatGPT showing their EXACT visual style.
Your generated prompt MUST instruct the image model to imitate the SAMPLE'S style:
  - Same color palette as the samples
  - Same composition and layout as the samples
  - Same typography style as the samples
  - Same level of realism vs illustration as the samples
Do NOT invent a new style. Do NOT use words like "futuristic", "cyberpunk", "glowing orbs",
"hologram", "neon city", "3D render" unless the samples literally show those.
If the samples are flat 2D illustrations, prompt for flat 2D illustration.
If the samples are photographs, prompt for photographs.
The samples are the source of truth for style.
`
        : `STYLE — use the brand's declared style: "${client.style || "clean, professional"}".
Do NOT default to "futuristic" or "cyberpunk" unless the brand explicitly asks for it.`;

    const text = `
You are writing a prompt for an image generator (DALL-E / GPT Image)
to make a single social media post for this brand.

${styleGuard}

BRAND:
- Name:        ${client.name}
- Industry:    ${client.industry || ""}
- Tone:        ${client.tone || ""}
- Audience:    ${client.audience || ""}
- Services:    ${client.services || ""}
- Style:       ${client.style || ""}
- CTA:         ${client.cta || ""}
- Description: ${client.description || ""}
${productsHint}

TODAY'S POST:
- Topic: ${item.topic || ""}
- Goal:  ${item.goal  || ""}
- Event: ${item.event || ""}

Write ONE concise image-generation prompt (3-5 sentences max).
The prompt should describe the subject and composition clearly.
The prompt MUST NOT specify a style that contradicts the brand or the samples.
Do not write "futuristic cityscape", "glowing orb", "neon hologram" or similar
generic creative-AI tropes. Stick to what fits THIS brand.

Return ONLY a JSON object: {"prompt":"<your image prompt here>"}
`;

    const out = await groqJSON(text);

    if (out?.prompt && typeof out.prompt === "string" && out.prompt.trim()) {
        return out.prompt.trim();
    }

    // Fallback if Groq fails
    const parts = [
        item.topic,
        item.goal,
        client.name && ("for brand " + client.name),
        client.industry && ("in the " + client.industry + " industry"),
        client.description && ("about " + client.description.slice(0, 120)),
        client.style && ("style: " + client.style),
        client.tone && ("tone: " + client.tone)
    ].filter(Boolean);

    return parts.join(", ") || (client.name + " social media post");
}

/* ============================================================
   buildCaption — Groq returns {caption, hashtags}. The contact
   block is appended by default for every client.
============================================================ */

async function buildCaption(client, item, finalPrompt) {

    const text = `
You are an expert social media copywriter.

Brand:
${client.name} — ${client.industry || ""}

Image generation prompt:
${finalPrompt}

Calendar item:
- Date:  ${item.date}
- Topic: ${item.topic}
- Goal:  ${item.goal}
- Event: ${item.event || "—"}

Return ONLY valid JSON:
{
 "caption":  "2-3 sentences with 1-2 emojis and a clear CTA",
 "hashtags": "#tag1 #tag2 #tag3 #tag4 #tag5 #tag6"
}
`;

    const result = await groqJSON(text) || { caption: "", hashtags: "" };

    // Contact details ON by default; only suppress if explicitly disabled
    const include = client?.contactInCaption === undefined
        ? true
        : !!client.contactInCaption;

    if (include) {

        const contactBlock = buildContactBlock(client);

        if (contactBlock) {
            const sep = result.caption && !result.caption.endsWith("\n") ? "\n\n" : "";
            result.caption = (result.caption || "") + sep + contactBlock;
        }
    }

    return result;
}

function buildContactBlock(client) {

    const lines = [];

    const phone = (client?.phone || "").trim();
    const email = (client?.email || "").trim();
    const site  = (client?.website || "").trim();

    if (phone) lines.push("📞 " + phone);
    if (email) lines.push("✉️ " + email);
    if (site)  lines.push("🌐 " + site);

    return lines.length ? "—\n" + lines.join("\n") : "";
}

/* ============================================================
   PROMPT-AUGMENTATION HELPERS
   These appear in front of the Groq-built creative prompt to
   give the image model hard, anchored rules.
============================================================ */

function sizeBlock(postSize) {

    const map = {
        "1:1":  { aspect: "1:1",  px: "1080 x 1080", platforms: "Instagram feed + Facebook feed" },
        "4:5":  { aspect: "4:5",  px: "1080 x 1350", platforms: "Instagram portrait feed" },
        "9:16": { aspect: "9:16", px: "1080 x 1920", platforms: "Instagram Story / Reel cover" }
    };

    const s = map[postSize] || map["1:1"];

    return [
        "",
        "IMPORTANT FORMAT REQUIREMENTS:",
        `- Generate exactly a ${s.aspect} aspect ratio image (${s.px} pixels).`,
        `- This image is for ${s.platforms}.`,
        "- Do NOT add any watermark, signature, or AI-generation badge."
    ].join("\n");
}

function brandContextBlock(client) {

    const fields = [
        ["Brand",        client.name],
        ["Industry",     client.industry],
        ["Tone",         client.tone],
        ["Audience",     client.audience],
        ["Services",     client.services],
        ["Style",        client.style],
        ["CTA",          client.cta],
        ["Website",      client.website],
        ["Description",  client.description]
    ].filter(([, v]) => v && String(v).trim());

    if (!fields.length) return "";

    return [
        "",
        "BRAND CONTEXT:",
        ...fields.map(([k, v]) => `- ${k}: ${String(v).trim()}`)
    ].join("\n");
}

function productsBlock(client) {

    const items = client.productsCache?.items;
    if (!items || !items.length) return "";

    const top = items.slice(0, 5);

    return [
        "",
        "PRODUCT CATALOG (from website):",
        ...top.map((p, i) =>
            `${i + 1}. ${p.title}` +
            (p.price       ? ` — ${p.price}`        : "") +
            (p.description ? ` — ${p.description.slice(0, 120)}` : "")
        ),
        "Feature one or more of these products if it fits the topic."
    ].join("\n");
}

function attachedAssetsBlock(client) {

    const logo    = (client?.logoUrl   || "").trim();
    const footer  = (client?.footerUrl || "").trim();
    const samples = Array.isArray(client?.samplePosts) ? client.samplePosts.filter(Boolean) : [];

    if (!logo && !footer && !samples.length) return "";

    const lines = ["", "ATTACHED REFERENCE IMAGES (already in this chat — listed in upload order):"];
    let idx = 1;

    if (logo) {
        lines.push(`  ${idx}. The brand LOGO — use it EXACTLY in the top-right corner. Do not redraw or restyle.`);
        idx++;
    }

    if (footer) {
        lines.push(`  ${idx}. The brand FOOTER/banner — use it EXACTLY as a strip across the bottom. Full width.`);
        idx++;
    }

    if (samples.length) {
        const start = idx;
        const end   = idx + samples.length - 1;
        const range = start === end ? `${start}` : `${start}-${end}`;
        lines.push(
            `  ${range}. ${samples.length} SAMPLE POST(S) showing the visual style this client uses.`,
            `     - Match the overall mood, color palette, composition, typography, and visual language of these samples.`,
            `     - The samples are STYLE REFERENCES — do not copy their content exactly, but the new image should feel like it belongs in the same set.`
        );
    }

    lines.push("- Do not invent a different logo or footer than the ones attached.");

    return lines.join("\n");
}

function augmentPrompt(basePrompt, client) {

    const hasSamples = Array.isArray(client?.samplePosts) && client.samplePosts.length > 0;
    const hasLogo    = !!(client?.logoUrl && client.logoUrl.trim());
    const hasFooter  = !!(client?.footerUrl && client.footerUrl.trim());

    /* Order matters: image models weight earliest tokens hardest.
       So HARD RULES come first, then SUBJECT, then context. */

    const parts = [];

    /* ---- 1. HARD RULES ---- */

    parts.push("HARD RULES — these override everything else in this prompt:");

    if (hasLogo) {
        parts.push(
            "- USE THE ATTACHED LOGO IMAGE EXACTLY as it appears. " +
            "Place it in the top-left or top-right corner at small size. " +
            "Do NOT redraw, recolor, restyle, abstract, or replace the logo. " +
            "Do NOT write the brand name as separate text — the logo already contains it."
        );
    }

    if (hasFooter) {
        parts.push(
            "- USE THE ATTACHED FOOTER IMAGE EXACTLY across the bottom as a thin strip, full width."
        );
    }

    if (hasSamples) {
        parts.push(
            "- MATCH THE STYLE of the attached SAMPLE POST(S) precisely: same color palette, " +
            "same level of realism vs illustration, same typography style, same overall mood."
        );
        parts.push(
            "- DO NOT use any of these styles unless the samples literally show them: " +
            "futuristic, cyberpunk, sci-fi, neon city, hologram, glowing orb, 3D render, " +
            "isometric infographic, cinematic landscape. " +
            "If the samples are flat illustrations, the output MUST be a flat illustration. " +
            "If the samples are photographs, the output MUST be photographic."
        );
    }

    parts.push(
        "- NO watermarks, NO AI-generation badges, NO signature, NO 'made by AI' marks.",
        ""
    );

    /* ---- 2. SUBJECT (Groq-built creative prompt) ---- */

    parts.push("SUBJECT (what to depict, within the rules above):");
    parts.push(String(basePrompt || "").trim());
    parts.push("");

    /* ---- 3. Brand context ---- */

    parts.push(brandContextBlock(client || {}));
    parts.push(productsBlock(client || {}));

    /* ---- 4. What's attached ---- */

    parts.push(attachedAssetsBlock(client || {}));

    /* ---- 5. Size + platform requirements ---- */

    parts.push(sizeBlock(client?.postSize));

    return parts.filter(Boolean).join("\n");
}

module.exports = {
    buildImagePrompt,
    buildCaption,
    augmentPrompt
};