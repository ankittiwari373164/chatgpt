/* ============================================================
   drive.js — Google Drive integration via Service Account JSON.

   - Mints OAuth2 tokens by signing a JWT with the service
     account's private key. No expiring user tokens.
   - Uses Drive REST API v3 for:
       uploadFile(folderId, name, mimeType, buffer)
       listFiles(folderId)
       getFile(fileId)
       deleteFile(fileId)
       updateFileMetadata(fileId, metadata)

   Token caching: in-memory; minted on first use, refreshed
   when ≤ 60 sec from expiry.

   Setup:
     - Create Service Account in Google Cloud Console
     - Download the JSON key
     - In dashboard Settings, paste the entire JSON
     - Share each Drive folder with the SA email (Editor)
============================================================ */

const crypto = require("crypto");
const axios  = require("axios");

const { Session } = require("../db/models");

let cachedSA      = null;        // parsed JSON, lazy
let cachedToken   = null;        // { access_token, expires_at_ms }

/* ============================================================
   Service Account loading + caching
============================================================ */

async function loadServiceAccount() {

    if (cachedSA) return cachedSA;

    // Stored in Session collection under name="google-sa".cookies (we
    // reuse the field rather than add a schema).
    const doc = await Session.findOne({ name: "google-sa" }).lean();

    const json = doc?.cookies;

    if (!json || typeof json !== "object") {
        throw new Error("No Google Service Account configured. Go to Settings.");
    }

    if (!json.client_email || !json.private_key) {
        throw new Error("Service account JSON missing client_email or private_key");
    }

    cachedSA = json;
    return cachedSA;
}

async function saveServiceAccount(jsonObj) {

    if (typeof jsonObj !== "object" || !jsonObj.client_email || !jsonObj.private_key) {
        throw new Error("Invalid service account JSON");
    }

    await Session.findOneAndUpdate(
        { name: "google-sa" },
        { name: "google-sa", cookies: jsonObj, storage: {}, updatedAt: new Date() },
        { upsert: true, new: true }
    );

    // Reset cache so next call uses the new SA
    cachedSA = null;
    cachedToken = null;

    return { client_email: jsonObj.client_email };
}

async function clearServiceAccount() {

    await Session.deleteOne({ name: "google-sa" });
    cachedSA = null;
    cachedToken = null;
}

/* ============================================================
   JWT signing for Google OAuth2 (RS256)
============================================================ */

function b64url(buf) {
    return Buffer.from(buf)
        .toString("base64")
        .replace(/=+$/, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}

function signJwt(payload, privateKey) {

    const header = { alg: "RS256", typ: "JWT" };

    const headerB64  = b64url(JSON.stringify(header));
    const payloadB64 = b64url(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;

    const sig = crypto
        .createSign("RSA-SHA256")
        .update(signingInput)
        .sign(privateKey);

    return `${signingInput}.${b64url(sig)}`;
}

/* ============================================================
   Get a valid Google access token (cached + auto-refreshed)
============================================================ */

async function getAccessToken() {

    if (cachedToken && cachedToken.expires_at_ms > Date.now() + 60_000) {
        return cachedToken.access_token;
    }

    const sa  = await loadServiceAccount();
    const now = Math.floor(Date.now() / 1000);

    const jwt = signJwt({
        iss:   sa.client_email,
        scope: "https://www.googleapis.com/auth/drive",
        aud:   "https://oauth2.googleapis.com/token",
        iat:   now,
        exp:   now + 3600
    }, sa.private_key);

    const r = await axios.post(
        "https://oauth2.googleapis.com/token",
        new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion:  jwt
        }).toString(),
        {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 30000
        }
    );

    if (!r.data?.access_token) {
        throw new Error("Token mint failed: " + JSON.stringify(r.data));
    }

    cachedToken = {
        access_token:  r.data.access_token,
        expires_at_ms: Date.now() + (r.data.expires_in || 3600) * 1000
    };

    console.log(
        `[drive] minted token for ${sa.client_email} ` +
        `(expires in ${r.data.expires_in}s)`
    );

    return cachedToken.access_token;
}

/* ============================================================
   Folder ID extraction from Drive URL
============================================================ */

function extractFolderId(url) {

    if (!url) return null;

    // https://drive.google.com/drive/folders/<id>
    let m = url.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];

    // https://drive.google.com/drive/u/0/folders/<id>
    m = url.match(/folders\/([a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];

    // Open?id=<id>
    m = url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];

    // Bare ID
    if (/^[a-zA-Z0-9_-]{10,}$/.test(url.trim())) return url.trim();

    return null;
}

/* ============================================================
   Drive API operations
============================================================ */

/* Upload a file to a folder.
   buffer: a Buffer with the file contents
   Returns the Drive file resource. */

async function uploadFile({ folderId, name, mimeType, buffer, description }) {

    const token = await getAccessToken();

    // Use multipart upload (one request, includes metadata + content)
    const boundary = "anth_" + Math.random().toString(36).slice(2);

    const metadata = {
        name,
        parents:     [folderId],
        description: description || ""
    };

    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\n`),
        Buffer.from(`Content-Type: application/json; charset=UTF-8\r\n\r\n`),
        Buffer.from(JSON.stringify(metadata)),
        Buffer.from(`\r\n--${boundary}\r\n`),
        Buffer.from(`Content-Type: ${mimeType}\r\n\r\n`),
        buffer,
        Buffer.from(`\r\n--${boundary}--`)
    ]);

    const r = await axios.post(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,description",
        body,
        {
            headers: {
                Authorization:  "Bearer " + token,
                "Content-Type": `multipart/related; boundary=${boundary}`
            },
            timeout: 120_000,
            maxContentLength: Infinity,
            maxBodyLength:    Infinity
        }
    );

    return r.data;
}

/* List all non-trashed files in a folder.
   Returns array of {id, name, mimeType, modifiedTime, description}. */

async function listFiles(folderId) {

    const token = await getAccessToken();

    const all = [];
    let pageToken = null;

    do {

        const params = new URLSearchParams({
            q: `'${folderId}' in parents and trashed = false`,
            fields: "files(id,name,mimeType,modifiedTime,description,webViewLink),nextPageToken",
            pageSize: "100"
        });

        if (pageToken) params.set("pageToken", pageToken);

        const r = await axios.get(
            "https://www.googleapis.com/drive/v3/files?" + params,
            {
                headers: { Authorization: "Bearer " + token },
                timeout: 30000
            }
        );

        all.push(...(r.data.files || []));
        pageToken = r.data.nextPageToken;

    } while (pageToken);

    return all;
}

async function deleteFile(fileId) {

    const token = await getAccessToken();

    await axios.delete(
        `https://www.googleapis.com/drive/v3/files/${fileId}`,
        {
            headers: { Authorization: "Bearer " + token },
            timeout: 30000
        }
    );
}

/* Get file metadata (used to check description, modifiedTime, etc) */

async function getFile(fileId) {

    const token = await getAccessToken();

    const r = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${fileId}` +
        "?fields=id,name,mimeType,modifiedTime,description,webViewLink",
        {
            headers: { Authorization: "Bearer " + token },
            timeout: 30000
        }
    );

    return r.data;
}

/* Download a file's bytes */

async function downloadFile(fileId) {

    const token = await getAccessToken();

    const r = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        {
            headers:      { Authorization: "Bearer " + token },
            responseType: "arraybuffer",
            timeout:      60_000
        }
    );

    return Buffer.from(r.data);
}

/* Update file metadata (e.g. description = updated caption) */

async function updateFileMetadata(fileId, metadata) {

    const token = await getAccessToken();

    const r = await axios.patch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,description`,
        metadata,
        {
            headers: {
                Authorization:  "Bearer " + token,
                "Content-Type": "application/json"
            },
            timeout: 30000
        }
    );

    return r.data;
}

/* ============================================================
   Sanity helpers
============================================================ */

function sanitizeFileName(s) {

    return String(s || "untitled")
        .replace(/[\/\\:*?"<>|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
}

async function isConfigured() {

    try {
        await loadServiceAccount();
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    saveServiceAccount,
    clearServiceAccount,
    isConfigured,
    extractFolderId,
    sanitizeFileName,
    getAccessToken,
    uploadFile,
    listFiles,
    deleteFile,
    getFile,
    downloadFile,
    updateFileMetadata
};