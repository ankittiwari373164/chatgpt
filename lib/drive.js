/* ============================================================
   drive.js — Google Drive integration.

   Two auth modes, in priority order:

   1. OAUTH (preferred, esp. for personal Gmail accounts)
      - User clicks /oauth/google/start in browser
      - Approves access on Google's consent screen
      - Server stores refresh_token in Session collection
      - All uploads use access tokens minted from that refresh token
      - Files are owned by the user → use the user's 15 GB quota
      - No folder sharing needed (the user is the owner)

   2. SERVICE ACCOUNT (legacy fallback, works only with
                       Workspace Shared Drives)
      - User pastes SA JSON into Settings panel
      - Server signs JWTs with the SA's private key
      - Works only when the folder is a Shared Drive
        (personal Gmail accounts can't use this for free)

   Mode selection: if a refresh_token exists in the DB, OAuth
   is used. Otherwise the SA JSON is used.
============================================================ */

const crypto = require("crypto");
const axios  = require("axios");

const { Session } = require("../db/models");

/* ============================================================
   STATE — in-memory caches
============================================================ */

let cachedSA       = null;    // parsed SA JSON
let cachedSAToken  = null;    // { access_token, expires_at_ms }

let cachedOAuthCreds = null;  // { refresh_token, scope, email }
let cachedOAuthToken = null;  // { access_token, expires_at_ms }

const OAUTH_SCOPE = "https://www.googleapis.com/auth/drive.file";

/* ============================================================
   OAUTH — credentials storage
============================================================ */

async function loadOAuthCreds() {

    if (cachedOAuthCreds) return cachedOAuthCreds;

    const doc = await Session.findOne({ name: "google-oauth" }).lean();
    if (!doc?.cookies?.refresh_token) return null;

    cachedOAuthCreds = doc.cookies;
    return cachedOAuthCreds;
}

async function saveOAuthCreds(creds) {

    await Session.findOneAndUpdate(
        { name: "google-oauth" },
        { $set: { name: "google-oauth", cookies: creds, updatedAt: new Date() } },
        { upsert: true }
    );

    cachedOAuthCreds = creds;
    cachedOAuthToken = null;  // force re-mint on next request
}

async function clearOAuthCreds() {

    await Session.deleteOne({ name: "google-oauth" });
    cachedOAuthCreds = null;
    cachedOAuthToken = null;
}

/* ============================================================
   OAUTH — exchange auth code for refresh token (one-time, run
   during the /oauth/google/callback request)
============================================================ */

async function exchangeCodeForTokens(code, redirectUri) {

    const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set in env");
    }

    const r = await axios.post(
        "https://oauth2.googleapis.com/token",
        new URLSearchParams({
            code,
            client_id:     clientId,
            client_secret: clientSecret,
            redirect_uri:  redirectUri,
            grant_type:    "authorization_code"
        }).toString(),
        {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 30_000
        }
    );

    return r.data;  // { access_token, refresh_token, expires_in, scope, token_type }
}

/* OAuth consent URL. Always asks for offline + consent so we
   reliably get a refresh_token. */

function buildAuthUrl(redirectUri, state) {

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    if (!clientId) throw new Error("GOOGLE_OAUTH_CLIENT_ID not set in env");

    const params = new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  redirectUri,
        response_type: "code",
        scope:         OAUTH_SCOPE,
        access_type:   "offline",
        prompt:        "consent",
        include_granted_scopes: "true"
    });

    if (state) params.set("state", state);

    return "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString();
}

/* ============================================================
   OAUTH — mint a fresh access token from the stored refresh
   token. Cached for 50 minutes (Google tokens last 60).
============================================================ */

async function mintOAuthAccessToken() {

    if (cachedOAuthToken && cachedOAuthToken.expires_at_ms > Date.now() + 60_000) {
        return cachedOAuthToken.access_token;
    }

    const creds = await loadOAuthCreds();
    if (!creds) throw new Error("OAuth not configured");

    const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

    const r = await axios.post(
        "https://oauth2.googleapis.com/token",
        new URLSearchParams({
            client_id:     clientId,
            client_secret: clientSecret,
            refresh_token: creds.refresh_token,
            grant_type:    "refresh_token"
        }).toString(),
        {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 30_000
        }
    );

    cachedOAuthToken = {
        access_token: r.data.access_token,
        expires_at_ms: Date.now() + (r.data.expires_in - 30) * 1000
    };

    return cachedOAuthToken.access_token;
}

/* ============================================================
   SERVICE ACCOUNT — legacy, used only if OAuth is not set up
============================================================ */

async function loadServiceAccount() {

    if (cachedSA) return cachedSA;

    const doc = await Session.findOne({ name: "google-sa" }).lean();
    const json = doc?.cookies;

    if (!json || typeof json !== "object") {
        throw new Error("No Google Service Account configured.");
    }

    if (!json.client_email || !json.private_key) {
        throw new Error("Service account JSON missing client_email or private_key");
    }

    cachedSA = json;
    return cachedSA;
}

async function saveServiceAccount(jsonObj) {

    if (!jsonObj?.client_email || !jsonObj?.private_key) {
        throw new Error("JSON must include client_email and private_key");
    }

    await Session.findOneAndUpdate(
        { name: "google-sa" },
        { $set: { name: "google-sa", cookies: jsonObj, updatedAt: new Date() } },
        { upsert: true }
    );

    cachedSA = jsonObj;
    cachedSAToken = null;
}

async function clearServiceAccount() {
    await Session.deleteOne({ name: "google-sa" });
    cachedSA = null;
    cachedSAToken = null;
}

function b64url(buf) {
    return Buffer.from(buf).toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function signJwt(payload, privateKey) {

    const header = { alg: "RS256", typ: "JWT" };
    const headerB64  = b64url(JSON.stringify(header));
    const payloadB64 = b64url(JSON.stringify(payload));
    const signingInput = headerB64 + "." + payloadB64;

    const signer = crypto.createSign("RSA-SHA256");
    signer.update(signingInput);
    const signature = signer.sign(privateKey);

    return signingInput + "." + b64url(signature);
}

async function mintSAAccessToken() {

    if (cachedSAToken && cachedSAToken.expires_at_ms > Date.now() + 60_000) {
        return cachedSAToken.access_token;
    }

    const sa = await loadServiceAccount();

    const now = Math.floor(Date.now() / 1000);

    const payload = {
        iss:   sa.client_email,
        scope: "https://www.googleapis.com/auth/drive",
        aud:   "https://oauth2.googleapis.com/token",
        iat:   now,
        exp:   now + 3600
    };

    const jwt = signJwt(payload, sa.private_key);

    const r = await axios.post(
        "https://oauth2.googleapis.com/token",
        new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion:  jwt
        }).toString(),
        {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 30_000
        }
    );

    cachedSAToken = {
        access_token:  r.data.access_token,
        expires_at_ms: Date.now() + (r.data.expires_in - 30) * 1000
    };

    return cachedSAToken.access_token;
}

/* ============================================================
   getAccessToken — picks the right auth mode automatically.
   OAuth wins if it's set up.
============================================================ */

async function getAccessToken() {

    const oauth = await loadOAuthCreds();
    if (oauth) return mintOAuthAccessToken();

    return mintSAAccessToken();
}

/* ============================================================
   Drive folder URL → folder ID
============================================================ */

function extractFolderId(url) {

    if (!url || typeof url !== "string") return null;
    const u = url.trim();

    // https://drive.google.com/drive/folders/<ID>
    let m = u.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];

    // https://drive.google.com/drive/u/0/folders/<ID>
    m = u.match(/\/u\/\d+\/folders\/([a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];

    // ?id=<ID>
    m = u.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];

    // bare folder id (alphanumeric, dash, underscore, ≥ 10 chars)
    if (/^[a-zA-Z0-9_-]{10,}$/.test(u)) return u;

    return null;
}

/* ============================================================
   FILE OPERATIONS
============================================================ */

async function uploadFile({ folderId, name, mimeType, buffer, description }) {

    const token = await getAccessToken();

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

    try {

        const r = await axios.post(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,description",
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

    } catch (err) {

        const status   = err.response?.status;
        const apiError = err.response?.data?.error;
        const reason   = apiError?.errors?.[0]?.reason;
        const message  = apiError?.message;

        console.log(`[drive] UPLOAD FAILED — status=${status}, reason=${reason}, message=${message}`);
        console.log(`[drive] full response:`, JSON.stringify(err.response?.data, null, 2));

        const cleanMsg = message
            ? `${message} (reason: ${reason || "unknown"})`
            : (err.message || "Unknown upload error");

        const e = new Error(cleanMsg);
        e.status   = status;
        e.reason   = reason;
        e.apiError = apiError;
        throw e;
    }
}

async function listFiles(folderId) {

    const token = await getAccessToken();

    const all = [];
    let pageToken = null;

    do {

        const params = new URLSearchParams({
            q: `'${folderId}' in parents and trashed = false`,
            fields: "files(id,name,mimeType,modifiedTime,description,webViewLink),nextPageToken",
            pageSize: "100",
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true"
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
        `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`,
        {
            headers: { Authorization: "Bearer " + token },
            timeout: 30000
        }
    );
}

async function getFile(fileId) {

    const token = await getAccessToken();

    const r = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${fileId}` +
        "?fields=id,name,mimeType,modifiedTime,description,webViewLink&supportsAllDrives=true",
        {
            headers: { Authorization: "Bearer " + token },
            timeout: 30000
        }
    );

    return r.data;
}

async function downloadFile(fileId) {

    const token = await getAccessToken();

    const r = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
        {
            headers:      { Authorization: "Bearer " + token },
            responseType: "arraybuffer",
            timeout:      60_000
        }
    );

    return Buffer.from(r.data);
}

async function updateFileMetadata(fileId, metadata) {

    const token = await getAccessToken();

    const r = await axios.patch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true&fields=id,name,description`,
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
   UTILITIES
============================================================ */

function sanitizeFileName(s) {
    return String(s || "post")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180) || "post";
}

async function isConfigured() {

    const oauth = await loadOAuthCreds();
    if (oauth) return true;

    try {
        await loadServiceAccount();
        return true;
    } catch (_) {
        return false;
    }
}

/* What auth mode is currently active? Used by /settings UI to
   show "OAuth: user@gmail.com" vs "Service Account: sa@..." */

async function getAuthInfo() {

    const oauth = await loadOAuthCreds();
    if (oauth) {
        return {
            mode:  "oauth",
            email: oauth.email || "(unknown user)"
        };
    }

    try {
        const sa = await loadServiceAccount();
        return {
            mode:  "service-account",
            email: sa.client_email
        };
    } catch (_) {
        return { mode: "none", email: null };
    }
}

module.exports = {
    // file ops
    uploadFile,
    listFiles,
    getFile,
    deleteFile,
    downloadFile,
    updateFileMetadata,

    // utilities
    extractFolderId,
    sanitizeFileName,
    isConfigured,
    getAuthInfo,

    // OAuth flow (used by server.js routes)
    buildAuthUrl,
    exchangeCodeForTokens,
    loadOAuthCreds,
    saveOAuthCreds,
    clearOAuthCreds,

    // Service Account legacy
    loadServiceAccount,
    saveServiceAccount,
    clearServiceAccount
};