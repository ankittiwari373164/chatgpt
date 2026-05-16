/* ============================================================
   upload-cookies.js — copy ChatGPT cookies from your local
   browser to the deployed server.

   How to use:
     1. Log into chatgpt.com normally in Chrome / Edge / Firefox.
     2. Install the "EditThisCookie" or "Cookie-Editor" browser
        extension.
     3. Export cookies for chatgpt.com as JSON. Save to a file
        like cookies.json next to this script.
     4. Run:  node tools/upload-cookies.js cookies.json

   Env vars used:
     SERVER_URL    e.g. https://your-app.onrender.com
     ADMIN_TOKEN   same value as on the server
============================================================ */

const fs    = require("fs");
const path  = require("path");
const axios = require("axios");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

(async () => {

    const file = process.argv[2];

    if (!file) {

        console.log("Usage: node tools/upload-cookies.js <cookies.json>");
        process.exit(1);
    }

    if (!fs.existsSync(file)) {

        console.log("File not found:", file);
        process.exit(1);
    }

    let cookies;

    try {

        cookies = JSON.parse(fs.readFileSync(file, "utf8"));

    } catch (e) {

        console.log("File is not valid JSON:", e.message);
        process.exit(1);
    }

    if (!Array.isArray(cookies)) {

        console.log("Expected an array of cookie objects.");
        process.exit(1);
    }

    /* Some extensions export cookies with sameSite values that
       Puppeteer doesn't accept ("unspecified"). Normalize. */

    cookies = cookies.map(c => ({
        name:     c.name,
        value:    c.value,
        domain:   c.domain,
        path:     c.path || "/",
        expires:  c.expires || c.expirationDate || undefined,
        httpOnly: !!c.httpOnly,
        secure:   !!c.secure,
        sameSite: (() => {
            const s = (c.sameSite || "").toLowerCase();
            if (s === "no_restriction" || s === "none") return "None";
            if (s === "lax")    return "Lax";
            if (s === "strict") return "Strict";
            return undefined;
        })()
    }));

    const url   = process.env.SERVER_URL || "http://localhost:3000";
    const token = process.env.ADMIN_TOKEN || "change-me";

    console.log(`📤 Uploading ${cookies.length} cookies to ${url} …`);

    try {

        const r = await axios.post(
            url + "/chatgpt/cookies",
            { cookies },
            { headers: { "x-admin-token": token } }
        );

        console.log("Server replied:", r.data);

        console.log("\n🔍 Testing login on the server…");

        const t = await axios.get(
            url + "/chatgpt/test",
            { headers: { "x-admin-token": token }, timeout: 90000 }
        );

        console.log("Login test result:", t.data);

    } catch (err) {

        console.log("Upload failed:", err.response?.data || err.message);
        process.exit(1);
    }
})();
