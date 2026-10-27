import { createFileStore } from "./file.js";
import { createPostgresStore } from "./postgres.js";

// DATABASE_URL impostata → Postgres; altrimenti file JSON
export function createStore({ dataDir, seedDir }) {
    const connectionString = process.env.DATABASE_URL;
    if (connectionString) {
        return createPostgresStore({
            connectionString,
            seedDir,
            refreshTtlMs: Number(process.env.CACHE_TTL_MS ?? 10_000),
        });
    }
    return createFileStore({ dataDir, seedDir });
}
