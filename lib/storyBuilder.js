/* ============================================================
   storyBuilder.js — turn a post image + optional song into a
   9:16 MP4 suitable for Instagram Stories, using Cloudinary's
   video transformation pipeline. No ffmpeg needed on our server.

   How it works:
     1. Re-upload the source image to Cloudinary as resource_type=video
        so we can apply video transformations to it. This produces a
        short still-image video.
     2. Resize/crop to 1080x1920 (9:16). For 1:1 source images we
        scale-to-fit on a black background. For 9:16 source we just resize.
     3. Set duration to ~15 sec (Instagram Story max is 60 sec).
     4. If the client has a song uploaded, overlay it as audio (l_video
        with audio-only) using the song's public_id.
     5. Return the final MP4 URL.

   Output URLs look like:
     https://res.cloudinary.com/<cloud>/video/upload/
       w_1080,h_1920,c_pad,b_black,du_15/
       l_video:ai-content:clients:Manofox:song-12345/fl_layer_apply/
       <story_image_public_id>.mp4
============================================================ */

const cloudinary = require("cloudinary").v2;
const axios = require("axios");

const STORY_DURATION_SEC = 15;
const STORY_WIDTH  = 1080;
const STORY_HEIGHT = 1920;

/* ============================================================
   Upload an image URL to Cloudinary as resource_type=video so
   we can apply video transformations. Caches by source URL —
   re-uses if we've already done it for this exact image.
============================================================ */

async function uploadImageAsVideo(imageUrl, client) {

    if (!process.env.CLOUDINARY_CLOUD_NAME) {
        throw new Error("Cloudinary not configured");
    }

    const safeName = (client?.name || "unknown")
        .replace(/[^a-z0-9_-]/gi, "_");

    const publicId =
        "story-img-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);

    const r = await cloudinary.uploader.upload(imageUrl, {
        folder:        "ai-content/stories/" + safeName,
        public_id:     publicId,
        resource_type: "video",   // critical: lets us apply video transforms
        overwrite:     true
    });

    if (!r?.public_id) {
        throw new Error("Cloudinary did not return a public_id for the story image");
    }

    return r.public_id;
}

/* ============================================================
   Build the Cloudinary transformation URL for a 9:16 MP4 with
   optional audio. Returns the final delivery URL.
============================================================ */

function buildStoryUrl(imagePublicId, songPublicId, sourcePostSize) {

    const cloud = process.env.CLOUDINARY_CLOUD_NAME;

    // Build the chained transformation
    const transformations = [];

    // 1. Size + duration
    //    - If source is 9:16 we use c_fill (covers full canvas)
    //    - If source is 4:5 or 1:1 we use c_pad with black bars
    const cropMode = sourcePostSize === "9:16" ? "fill" : "pad";

    transformations.push(
        [
            `w_${STORY_WIDTH}`,
            `h_${STORY_HEIGHT}`,
            `c_${cropMode}`,
            "b_black",         // black background for c_pad
            `du_${STORY_DURATION_SEC}`,
            "vc_h264",         // codec Instagram likes
            "ac_aac"           // audio codec
        ].join(",")
    );

    // 2. Audio overlay — l_video with the audio's public_id.
    //    The audio public_id needs to be Cloudinary-encoded:
    //    folders use ":" as separator in the URL.
    if (songPublicId) {

        const encodedSongId = songPublicId.replace(/\//g, ":");

        transformations.push(`l_video:${encodedSongId},so_0/fl_layer_apply`);
    }

    return (
        `https://res.cloudinary.com/${cloud}/video/upload/` +
        transformations.join("/") + "/" +
        imagePublicId + ".mp4"
    );
}

/* ============================================================
   HEAD-check that the URL returns a working MP4. Cloudinary
   builds the transformation lazily on first request, so the
   first call can take 5-30 sec. We retry a few times.
============================================================ */

async function ensureMp4Ready(url, maxAttempts = 8) {

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {

        try {

            // Use GET with a small Range header to trigger the build
            // without downloading the whole file
            const r = await axios.get(url, {
                headers: { Range: "bytes=0-1023" },
                timeout: 30000,
                validateStatus: () => true,
                maxRedirects: 5,
                responseType: "arraybuffer"
            });

            if (r.status >= 200 && r.status < 300) {

                const ct = r.headers["content-type"] || "";
                if (ct.includes("video") || ct.includes("mp4")) {
                    console.log(
                        `[story] ✓ MP4 ready after ${attempt} attempt(s): ${url}`
                    );
                    return true;
                }
            }

            console.log(
                `[story] attempt ${attempt}: status=${r.status} ` +
                `content-type=${r.headers["content-type"]}`
            );

        } catch (e) {

            console.log(`[story] attempt ${attempt} threw: ${e.message}`);
        }

        // Backoff: 3s, 5s, 8s, 13s, 21s, 34s, 55s
        const wait = Math.min(3000 * Math.pow(1.6, attempt - 1), 60000);
        await new Promise(r => setTimeout(r, wait));
    }

    throw new Error("Story MP4 never became ready after " + maxAttempts + " attempts");
}

/* ============================================================
   Public API: build a story MP4 URL for a post + client
============================================================ */

async function buildStoryVideo({ imageUrl, client }) {

    if (!imageUrl) throw new Error("imageUrl is required");
    if (!client)   throw new Error("client is required");

    if (!client.songPublicId && !client.songUrl) {
        console.log(`[story] ${client.name}: no song — building silent story`);
    }

    // 1. Upload the source image as a video asset
    const imagePublicId = await uploadImageAsVideo(imageUrl, client);

    // 2. Build the transformation URL
    const storyUrl = buildStoryUrl(
        imagePublicId,
        client.songPublicId || null,
        client.postSize || "1:1"
    );

    console.log(`[story] built URL → ${storyUrl}`);

    // 3. Force Cloudinary to actually generate the MP4 before we hand
    //    the URL to Instagram (otherwise IG hits a 404 or wrong MIME)
    await ensureMp4Ready(storyUrl);

    return storyUrl;
}

module.exports = { buildStoryVideo, buildStoryUrl, uploadImageAsVideo };