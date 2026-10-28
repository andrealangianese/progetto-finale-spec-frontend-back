import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { MongoBulkWriteError, MongoClient } from "mongodb";
import { attachPoolOnVercel } from "./vercel.js";
import type { ClosableStore, Resource } from "../types.js";

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

type ResourceDocument = Omit<Resource, "id"> & { _id: number };
type SeedDocument = { _id: string; seededAt: Date };

function databaseName(uri: string): string {
    if (process.env.MONGODB_DB) return process.env.MONGODB_DB;
    // il nome può essere nel path dell'URI (mongodb+srv://.../langiaroad?...)
    const name = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/)?.[1];
    return name ? decodeURIComponent(name) : "langiaroad";
}

const toDocument = ({ id, ...rest }: Resource): ResourceDocument => ({ _id: id, ...rest });
const fromDocument = ({ _id, ...rest }: ResourceDocument): Record<string, unknown> => ({ id: _id, ...rest });

export function createMongoStore({ uri, seedDir, refreshTtlMs = 10_000 }: {
    uri: string;
    seedDir: string;
    refreshTtlMs?: number;
}): ClosableStore {
    // Pool piccolo: su serverless ogni istanza ne apre uno (il free tier M0 ha un limite di connessioni)
    const client = new MongoClient(uri, { maxPoolSize: 5, maxIdleTimeMS: 10_000 });
    attachPoolOnVercel(client);
    const db = client.db(databaseName(uri));
    const records = (type: string) => db.collection<ResourceDocument>(type);

    async function seedIfNeeded(type: string): Promise<void> {
        const seeds = db.collection<SeedDocument>("_seeds");
        if (await seeds.findOne({ _id: type })) return;

        const seedFile = path.join(seedDir, `${type}.json`);
        const items = existsSync(seedFile) ? JSON.parse(await fs.readFile(seedFile, "utf-8")) as Resource[] : [];
        if (items.length) {
            try {
                await records(type).insertMany(items.map(toDocument), { ordered: false });
            } catch (error) {
                // un'altra istanza sta facendo lo stesso seed: i duplicati sono attesi
                const writeErrors = error instanceof MongoBulkWriteError ? error.writeErrors : null;
                const list = Array.isArray(writeErrors) ? writeErrors : writeErrors ? [writeErrors] : null;
                const onlyDuplicates = list?.every(e => e.code === DUPLICATE_KEY) ?? false;
                if (!onlyDuplicates) throw error;
            }
        }
        await seeds.updateOne(
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
            const docs = await records(type).find().sort({ _id: 1 }).toArray();
            return docs.map(fromDocument);
        },

        async persist(type, change) {
            const collection = records(type);
            switch (change.op) {
                case "insert":
                    await collection.insertOne(toDocument(change.item));
                    break;
                case "update":
                    await collection.replaceOne({ _id: change.item.id }, toDocument(change.item));
                    break;
                case "delete":
                    await collection.deleteOne({ _id: change.id });
                    break;
            }
        },

        close: () => client.close(),
    };
}
