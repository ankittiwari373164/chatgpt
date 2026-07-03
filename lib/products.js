/* ============================================================
   products.js — shared product helpers.

   Responsibilities:
     - normalizeProducts()        clean/validate raw product objects
       (from scraper OR manual upload) into a consistent shape.
     - pickFeaturedProduct()      choose ONE product (that has a
       usable image) to feature in a given creative, rotating
       deterministically so posts don't repeat the same product.
     - featuredProductPromptBlock() build the HARD-RULE text that
       tells the image model the attached product image is the
       REAL product and must be shown faithfully.

   Product shape (canonical):
     { title, price, image, url, description, featured }
============================================================ */

"use strict";

const MAX_PRODUCTS = 50;

function cleanText(s, max = 300) {
    return String(s == null ? "" : s)
        .replace(/\s+/g, " ")
        .replace(/\u00a0/g, " ")
        .trim()
        .slice(0, max);
}

function isUsableImage(src) {
    if (!src || typeof src !== "string") return false;
    return /^https?:\/\//i.test(src) || src.startsWith("data:image/");
}

/* ------------------------------------------------------------
   Normalize an array of raw product objects into the canonical
   shape. Drops items with no title. De-dups by lowercased title.
------------------------------------------------------------ */
function normalizeProducts(rawItems) {

    if (!Array.isArray(rawItems)) return [];

    const seen = new Map();

    for (const raw of rawItems) {

        if (!raw || typeof raw !== "object") continue;

        const title = cleanText(raw.title || raw.name, 200);
        if (!title) continue;

        const key = title.toLowerCase();
        if (seen.has(key)) continue;

        seen.set(key, {
            title,
            price:       cleanText(raw.price, 40),
            image:       typeof raw.image === "string" ? raw.image.trim() : "",
            url:         typeof raw.url   === "string" ? raw.url.trim()   : "",
            description: cleanText(raw.description, 300),
            featured:    !!raw.featured
        });

        if (seen.size >= MAX_PRODUCTS) break;
    }

    return [...seen.values()];
}

/* ------------------------------------------------------------
   Choose one product to feature in a creative.

   Priority:
     1. Any product explicitly flagged featured:true (rotate
        among those if several).
     2. Otherwise rotate through all products that have a usable
        image.

   `seed` makes the choice deterministic-but-rotating. Pass
   something that changes per post (attempts count, day-of-year,
   calendar index…) so consecutive posts pick different products.

   Returns the product object or null if none has an image.
------------------------------------------------------------ */
function pickFeaturedProduct(client, seed = 0) {

    const items = client?.productsCache?.items;
    if (!Array.isArray(items) || !items.length) return null;

    const withImage = items.filter(p => isUsableImage(p?.image));
    if (!withImage.length) return null;

    const flagged = withImage.filter(p => p.featured);
    const pool    = flagged.length ? flagged : withImage;

    const idx = ((Number(seed) % pool.length) + pool.length) % pool.length;
    return pool[idx];
}

/* ------------------------------------------------------------
   HARD-RULE block telling the image model the attached product
   image is the real product. Only emit this when we actually
   attach the product image to the generation.
------------------------------------------------------------ */
function featuredProductPromptBlock(product) {

    if (!product || !product.title) return "";

    const bits = [
        "",
        "FEATURED PRODUCT — HARD RULE (overrides style/subject where they conflict):",
        `- The ATTACHED product image is the REAL product: "${product.title}"` +
            (product.price ? ` (${product.price})` : "") + ".",
        "- Feature THIS product as the hero of the composition. Show it prominently and attractively.",
        "- Reproduce the product FAITHFULLY from the attached image — same shape, colour, and packaging.",
        "  Do NOT redraw it as a different product, do NOT invent a fictional product, do NOT distort its branding.",
        "- You may add a complementary background, lighting, and props, but the product itself must match the attachment."
    ];

    if (product.description) {
        bits.push(`- Product detail: ${product.description.slice(0, 160)}`);
    }

    return bits.join("\n");
}

module.exports = {
    MAX_PRODUCTS,
    normalizeProducts,
    pickFeaturedProduct,
    featuredProductPromptBlock,
    isUsableImage
};
