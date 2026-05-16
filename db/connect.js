/* ============================================================
   MongoDB connector — single shared connection, retries on
   transient failures so a sleepy Atlas M0 cluster doesn't
   crash the server.
============================================================ */

const mongoose = require("mongoose");

mongoose.set("strictQuery", false);
mongoose.set("bufferCommands", false);  // fail fast if no connection
mongoose.set("bufferTimeoutMS", 5000);

let connecting = null;

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
        retryWrites:              true

    }).then(conn => {

        console.log("✅ MongoDB connected:", conn.connection.host);
        connecting = null;
        return conn;

    }).catch(err => {

        connecting = null;
        console.log("❌ MongoDB connection error:", err.message);
        throw err;
    });

    return connecting;
}

/* Connection events for visibility */

mongoose.connection.on("disconnected", () => {

    console.log("⚠ MongoDB disconnected. Will reconnect on next query.");
});

mongoose.connection.on("error", err => {

    console.log("⚠ MongoDB error:", err.message);
});

module.exports = { connect, mongoose };
