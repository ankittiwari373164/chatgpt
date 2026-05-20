/* ============================================================
   composer.js — overlays a client's logo and footer image
   onto a generated image using sharp.

   - Output is always 1080x1080 PNG
   - Logo placed top-right (default), max 18% of width
   - Footer placed bottom, full width, max 12% of height
   - Falls back gracefully: if no logo and no footer, returns
     the original image untouched.
============================================================ */

const axios = require("axios");

let sharp;
try {
    sharp = require("sharp");
} catch (e) {
    console.log("⚠ sharp not available, image overlay disabled:", e.message);
    sharp = null;
}

const CANVAS = 1080;
const LOGO_MAX_W_RATIO   = 0.18;   // 18% of canvas width
const LOGO_PADDING       = 32;     // px from edge
const FOOTER_MAX_H_RATIO = 0.12;   // 12% of canvas height

/* ============================================================
   Fetch an image URL (or data URL) and return a Buffer
============================================================ */

async function fetchBytes(src) {

    if (!src) return null;

    if (src.startsWith("data:")) {

        const b64 = src.split(",")[1] || "";
        return Buffer.from(b64, "base64");
    }

    const r = await axios.get(src, {
        responseType: "arraybuffer",
        timeout:      30000,
        maxRedirects: 5
    });

    return Buffer.from(r.data);
}

/* ============================================================
   Main: compose logo + footer onto baseImage.

   baseImage can be:
     - a data URL ("data:image/png;base64,...")
     - a remote URL ("https://...")
     - a Buffer
   logoUrl / footerUrl — string URLs (or empty / null)

   Returns: a data URL (base64 PNG) suitable for the existing
   Cloudinary upload path in handleSavePost.
============================================================ */

async function composeBrandedImage({ baseImage, logoUrl, footerUrl }) {

    if (!sharp) {
        console.log("composer: sharp not loaded, returning original");
        return baseImage;
    }

    /* ---------- 1. Load + normalize the base ---------- */

    let baseBuf;

    try {
        baseBuf = Buffer.isBuffer(baseImage) ? baseImage : await fetchBytes(baseImage);
    } catch (e) {
        console.log("composer: could not load base image:", e.message);
        return baseImage; // give up gracefully — return original
    }

    if (!baseBuf || !baseBuf.length) {
        console.log("composer: base image empty");
        return baseImage;
    }

    let canvas;
    try {
        canvas = await sharp(baseBuf)
            .resize(CANVAS, CANVAS, { fit: "cover", position: "centre" })
            .toFormat("png");
    } catch (e) {
        console.log("composer: base image not decodable:", e.message);
        return baseImage;
    }

    /* ---------- 2. Build the overlay list ---------- */

    const overlays = [];

    /* LOGO — top right */

    if (logoUrl) {

        try {

            const logoBuf = await fetchBytes(logoUrl);

            const logoMaxW = Math.round(CANVAS * LOGO_MAX_W_RATIO);

            const resized = await sharp(logoBuf)
                .resize({
                    width:  logoMaxW,
                    height: logoMaxW,
                    fit:    "inside",
                    withoutEnlargement: false
                })
                .png()
                .toBuffer({ resolveWithObject: true });

            overlays.push({
                input: resized.data,
                left:  CANVAS - resized.info.width  - LOGO_PADDING,
                top:   LOGO_PADDING
            });

            console.log(
                `composer: logo ${resized.info.width}×${resized.info.height} placed top-right`
            );

        } catch (e) {

            console.log("composer: logo fetch/decode failed:", e.message);
        }
    }

    /* FOOTER — full width, anchored to bottom */

    if (footerUrl) {

        try {

            const footerBuf = await fetchBytes(footerUrl);

            const footerMaxH = Math.round(CANVAS * FOOTER_MAX_H_RATIO);

            const resized = await sharp(footerBuf)
                .resize({
                    width:  CANVAS,
                    height: footerMaxH,
                    fit:    "cover",     // fill the strip; crop if needed
                    position: "centre"
                })
                .png()
                .toBuffer({ resolveWithObject: true });

            overlays.push({
                input: resized.data,
                left:  0,
                top:   CANVAS - resized.info.height
            });

            console.log(
                `composer: footer ${resized.info.width}×${resized.info.height} placed bottom`
            );

        } catch (e) {

            console.log("composer: footer fetch/decode failed:", e.message);
        }
    }

    if (!overlays.length) {
        console.log("composer: no overlays applied, returning original");
        return baseImage;
    }

    /* ---------- 3. Composite + return as data URL ---------- */

    const outBuf = await canvas
        .composite(overlays)
        .png()
        .toBuffer();

    return "data:image/png;base64," + outBuf.toString("base64");
}

module.exports = { composeBrandedImage };