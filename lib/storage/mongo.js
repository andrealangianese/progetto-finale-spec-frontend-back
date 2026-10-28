import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { MongoClient } from "mongodb";
import { attachPoolOnVercel } from "./vercel.js";

/**
 * Storage su MongoDB (Atlas via integrazione Vercel, o qualsiasi MongoDB).
 *
 * Una collection per tipo (es. "travel"), un documento per record con `_id` = id numerico:
 * l'unicità dell'id la garantisce Mongo, senza indici aggiuntivi. Due creazioni concorrenti
 * con lo stesso id falliscono (duplicate key) invece di sovrascriversi.
 *
 * Seed al primo avvio da database/<type>.json, idempotente e senza lock:
 * insertMany non ordinato ignora gli _id già presenti, poi la collection `_seeds` ricorda
 * il seed (cancellare tutti i record non li fa ricomparire al riavvio).
 */
const DUPLICATE_KEY = 11000;

function databaseName(uri) {
    if (process.env.MONGODB_DB) return process.env.MONGODB_DB;
    // il nome può essere nel path dell'URI (mongodb+srv://.../langiaroad?...)
    const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/);
    return match ? decodeURIComponent(match[1]) : "langiaroad";
}

const toDocument = ({ id, ...rest }) => ({ _id: id, ...rest });
const fromDocument = ({ _id, ...rest }) => ({ id: _id, ...rest });

export function createMongoStore({ uri, seedDir, refreshTtlMs = 10_000 }) {
    // Pool piccolo: su serverless ogni istanza ne apre uno (il free tier M0 ha un limite di connessioni)
    const client = new MongoClient(uri, { maxPoolSize: 5, maxIdleTimeMS: 10_000 });
    attachPoolOnVercel(client);
    const db = client.db(databaseName(uri));

    async function seedIfNeeded(type) {
        if (await db.collection("_seeds").findOne({ _id: type })) return;

        const seedFile = path.join(seedDir, `${type}.json`);
        const items = existsSync(seedFile) ? JSON.parse(await fs.readFile(seedFile, "utf-8")) : [];
        if (items.length) {
            try {
                await db.collection(type).insertMany(items.map(toDocument), { ordered: false });
            } catch (error) {
                // un'altra istanza sta facendo lo stesso seed: i duplicati sono attesi
                const onlyDuplicates = error.writeErrors?.every(e => e.code === DUPLICATE_KEY);
                if (!onlyDuplicates) throw error;
            }
        }
        await db.collection("_seeds").updateOne(
            { _id: type },
            { $setOnInsert: { seededAt: new Date() } },
            { upsert: true }
        );
    }

    return {
        name: "mongodb",
        refreshTtlMs,

        async load(type) {
            await seedIfNeeded(type);
            const docs = await db.collection(type).find().sort({ _id: 1 }).toArray();
            return docs.map(fromDocument);
        },

        async persist(type, change) {
            const collection = db.collection(type);
            if (change.op === "insert") {
                await collection.insertOne(toDocument(change.item));
            } else if (change.op === "update") {
                await collection.replaceOne({ _id: change.item.id }, toDocument(change.item));
            } else if (change.op === "delete") {
                await collection.deleteOne({ _id: change.id });
            }
        },

        close: () => client.close(),
    };
}
