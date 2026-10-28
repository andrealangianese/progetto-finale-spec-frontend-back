import { createFileStore } from "./file.js";
import { createMongoStore } from "./mongo.js";
import { createPostgresStore } from "./postgres.js";

// MONGODB_URI → MongoDB (es. Atlas via integrazione Vercel)
// DATABASE_URL → Postgres
// nessuna delle due → file JSON
export function createStore({ dataDir, seedDir }) {
    const mongoUri = process.env.MONGODB_URI;
    const postgresUrl = process.env.DATABASE_URL;
    const refreshTtlMs = Number(process.env.CACHE_TTL_MS ?? 10_000);

    if (mongoUri && postgresUrl) {
        // meglio fallire subito che scrivere in silenzio sul database sbagliato
        throw new Error("Configurazione ambigua: sono impostate sia MONGODB_URI sia DATABASE_URL. Tienine una sola.");
    }
    if (mongoUri) return createMongoStore({ uri: mongoUri, seedDir, refreshTtlMs });
    if (postgresUrl) return createPostgresStore({ connectionString: postgresUrl, seedDir, refreshTtlMs });
    return createFileStore({ dataDir, seedDir });
}
