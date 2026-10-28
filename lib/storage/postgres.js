import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import pg from "pg";
import { attachPoolOnVercel } from "./vercel.js";

/**
 * Storage su Postgres (produzione: Neon, Supabase, Vercel Postgres...).
 *
 * Schema: una riga per record, payload in jsonb, chiave (type, id).
 * Due creazioni concorrenti con lo stesso id falliscono (violazione di chiave)
 * invece di sovrascriversi in silenzio.
 *
 * Al primo avvio ogni tipo viene popolato dal JSON in database/; la tabella
 * `seeds` ricorda il seed, così cancellare tutti i record non li fa ricomparire.
 */
export function createPostgresStore({ connectionString, seedDir, refreshTtlMs = 10_000 }) {
    const pool = new pg.Pool({
        connectionString,
        max: 3,
        // i provider gestiti richiedono TLS; in locale (localhost) no
        ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: true },
    });
    attachPoolOnVercel(pool);

    // Esegue fn in una transazione sotto advisory lock: serializza tra istanze diverse
    async function withLock(key, fn) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
            const result = await fn(client);
            await client.query("COMMIT");
            return result;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    // CREATE TABLE IF NOT EXISTS non è sicuro in concorrenza (due cold start insieme
    // collidono sul catalogo di Postgres): lo serializzo con un lock
    let schemaReady;
    const ensureSchema = () => (schemaReady ??= withLock("langiaroad:schema", client => client.query(`
        CREATE TABLE IF NOT EXISTS records (
            type text NOT NULL,
            id integer NOT NULL,
            data jsonb NOT NULL,
            PRIMARY KEY (type, id)
        );
        CREATE TABLE IF NOT EXISTS seeds (
            type text PRIMARY KEY,
            seeded_at timestamptz NOT NULL DEFAULT now()
        );
    `)).catch(error => { schemaReady = null; throw error; }));

    // Chiamata sotto lock per tipo: due istanze che partono insieme non fanno il seed due volte
    async function seedIfNeeded(client, type) {
        const { rowCount } = await client.query("SELECT 1 FROM seeds WHERE type = $1", [type]);
        if (rowCount) return;

        const seedFile = path.join(seedDir, `${type}.json`);
        const items = existsSync(seedFile) ? JSON.parse(await fs.readFile(seedFile, "utf-8")) : [];
        for (const item of items) {
            await client.query(
                "INSERT INTO records (type, id, data) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
                [type, item.id, item]
            );
        }
        await client.query("INSERT INTO seeds (type) VALUES ($1)", [type]);
    }

    return {
        name: "postgres",
        refreshTtlMs,

        async load(type) {
            await ensureSchema();
            await withLock(`langiaroad:seed:${type}`, client => seedIfNeeded(client, type));
            const { rows } = await pool.query("SELECT data FROM records WHERE type = $1 ORDER BY id", [type]);
            return rows.map(r => r.data);
        },

        async persist(type, change) {
            if (change.op === "insert") {
                await pool.query("INSERT INTO records (type, id, data) VALUES ($1, $2, $3)", [type, change.item.id, change.item]);
            } else if (change.op === "update") {
                await pool.query("UPDATE records SET data = $3 WHERE type = $1 AND id = $2", [type, change.item.id, change.item]);
            } else if (change.op === "delete") {
                await pool.query("DELETE FROM records WHERE type = $1 AND id = $2", [type, change.id]);
            }
        },

        close: () => pool.end(),
    };
}
