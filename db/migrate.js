/* ============================================================
   One-time migration: copy local .json files into MongoDB Atlas

   Usage:
     npm run migrate

   Safe to run multiple times — uses _legacyId as idempotency key
   so re-running won't duplicate records.
============================================================ */

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { connect } = require("./connect");

const {
    Client, Prompt, Post, Scheduled, Calendar
} = require("./models");

const ROOT = path.resolve(__dirname, "..");

function loadJSON(file) {

    const full = path.join(ROOT, file);

    if (!fs.existsSync(full)) {

        console.log(`  skip ${file} (not found)`);
        return null;
    }

    try {

        return JSON.parse(fs.readFileSync(full, "utf8"));

    } catch (err) {

        console.log(`  skip ${file} (bad JSON)`);
        return null;
    }
}

async function migrate() {

    console.log("\n🚚  Starting migration…\n");

    await connect();

    /* ---------- CLIENTS ---------- */

    const clients = loadJSON("clients.json");

    if (Array.isArray(clients)) {

        let added = 0;

        for (const c of clients) {

            if (!c?.name) continue;

            const exists = await Client.findOne({ name: c.name });

            if (!exists) {

                await Client.create(c);
                added++;
            }
        }

        console.log(`  ✓ clients:    ${added} new (of ${clients.length})`);
    }

    /* ---------- PROMPTS ---------- */

    const prompts = loadJSON("prompts.json");

    if (Array.isArray(prompts)) {

        let added = 0;

        for (const p of prompts) {

            if (!p?.client || !p?.prompt) continue;

            const exists = await Prompt.findOne({ _legacyId: p.id });

            if (!exists) {

                await Prompt.create({
                    _legacyId: p.id,
                    client:    p.client,
                    prompt:    p.prompt,
                    generated: !!p.generated,
                    source:    "manual",
                    createdAt: p.createdAt || new Date()
                });
                added++;
            }
        }

        console.log(`  ✓ prompts:    ${added} new (of ${prompts.length})`);
    }

    /* ---------- POSTS ---------- */

    const posts = loadJSON("posts.json");

    if (Array.isArray(posts)) {

        let added = 0;

        for (const p of posts) {

            if (!p?.id) continue;

            const exists = await Post.findOne({ _legacyId: p.id });

            if (!exists) {

                await Post.create({
                    _legacyId:    p.id,
                    client:       p.client,
                    prompt:       p.prompt,
                    image:        p.image,
                    caption:      p.caption,
                    hashtags:     p.hashtags,
                    status:       p.status || "generated",
                    scheduled:    !!p.scheduled,
                    scheduleTime: p.scheduleTime || "",
                    source:       p.source || "tampermonkey",
                    createdAt:    p.createdAt || new Date()
                });
                added++;
            }
        }

        console.log(`  ✓ posts:      ${added} new (of ${posts.length})`);
    }

    /* ---------- SCHEDULED ---------- */

    const sched = loadJSON("scheduled.json");

    if (Array.isArray(sched)) {

        let added = 0;

        for (const s of sched) {

            if (!s?.id) continue;

            const exists = await Scheduled.findOne({ _legacyId: s.id });

            if (!exists) {

                await Scheduled.create({
                    _legacyId:    s.id,
                    postId:       s.postId,
                    client:       s.client,
                    page:         s.page,
                    image:        s.image,
                    caption:      s.caption,
                    hashtags:     s.hashtags,
                    scheduleTime: s.scheduleTime,
                    platform:     s.platform,
                    fbPostId:     s.fbPostId,
                    igPostId:     s.igPostId,
                    errors:       s.errors,
                    status:       s.status
                });
                added++;
            }
        }

        console.log(`  ✓ scheduled:  ${added} new (of ${sched.length})`);
    }

    /* ---------- CALENDARS ---------- */

    const cals = loadJSON("calendar.json");

    if (Array.isArray(cals)) {

        let added = 0;

        for (const c of cals) {

            if (!c?.client) continue;

            const exists = await Calendar.findOne({ client: c.client });

            if (!exists) {

                await Calendar.create({
                    client:   c.client,
                    calendar: c.calendar || []
                });
                added++;
            }
        }

        console.log(`  ✓ calendars:  ${added} new (of ${cals.length})`);
    }

    console.log("\n✅  Migration complete.\n");

    process.exit(0);
}

migrate().catch(err => {

    console.log("❌ Migration failed:", err);
    process.exit(1);
});
