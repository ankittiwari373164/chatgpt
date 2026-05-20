/* ============================================================
   MongoDB connector — single shared connection with automatic
   reconnect logic. Atlas M0 free cluster occasionally drops
   idle connections; this brings them back without crashing.
============================================================ */

const mongoose = require("mongoose");

mongoose.set("strictQuery", false);
mongoose.set("bufferCommands", false);    // fail fast if no connection
mongoose.set("bufferTimeoutMS", 5000);

let connecting = null;
let reconnectTimer = null;

async function connect() {

    if (mongoose.connection.readyState === 1) return mongoose;
    if (connecting) return connecting;

    const uri = process.env.MONGODB_URI;

    if (!uri) {

        throw new Error(
            "MONGODB_URI is not set. Get one from " +
            "https://cloud.mongodb.com (free M0 cluster) and " +
            "add it to your .env file."
        );
    }

    console.log("📦 Connecting to MongoDB Atlas…");

    connecting = mongoose.connect(uri, {

        serverSelectionTimeoutMS: 15000,
        socketTimeoutMS:          45000,
        retryWrites:              true,
        maxPoolSize:              5,
        minPoolSize:              1,
        heartbeatFrequencyMS:     10000

    }).then(conn => {

        console.log("✅ MongoDB connected:", conn.connection.host);
        connecting = null;
        return conn;

    }).catch(err => {

        connecting = null;
        console.log("❌ MongoDB connection error:", err.message);
        scheduleReconnect();
        throw err;
    });

    return connecting;
}

function scheduleReconnect() {

    if (reconnectTimer) return;

    reconnectTimer = setTimeout(() => {

        reconnectTimer = null;
        console.log("🔄 Attempting MongoDB reconnect…");
        connect().catch(() => {
            // scheduleReconnect was already called in the catch above
        });

    }, 5000);
}

/* Connection events for visibility + auto-reconnect */

mongoose.connection.on("disconnected", () => {

    console.log("⚠ MongoDB disconnected. Scheduling reconnect…");
    scheduleReconnect();
});

mongoose.connection.on("error", err => {

    console.log("⚠ MongoDB error:", err.message);
    scheduleReconnect();
});

mongoose.connection.on("connected", () => {

    console.log("✓ MongoDB connected event fired");
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
});

module.exports = { connect, mongoose };