import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import request from "supertest"
import pg from "pg"
import { API_KEY, closeApp, createTestDatabase, loadApp, validTravel } from "./helpers.js"
import { createPostgresStore } from "../lib/storage/postgres.js"

// Eseguito solo con TEST_DATABASE_URL (es. postgresql://user@localhost:5432/postgres)
const skip = !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL non impostata"
const seedDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "database")
const auth = { "X-API-Key": API_KEY }

let app, db
before(async () => {
    if (skip) return
    app = await loadApp({ CACHE_TTL_MS: "200" })
    db = new pg.Pool({ connectionString: process.env.DATABASE_URL })
})
after(async () => {
    if (skip) return
    await db.end()
    await closeApp()
})

test("seed iniziale dal JSON, una sola volta", { skip }, async () => {
    const { rows } = await db.query("SELECT count(*)::int AS n FROM records WHERE type = 'travel'")
    assert.equal(rows[0].n, 14)
    const res = await request(app).get("/travels").expect(200)
    assert.equal(res.body.length, 14)
})

test("le scritture finiscono su Postgres", { skip }, async () => {
    const created = await request(app).post("/travels").set(auth).send(validTravel).expect(201)
    const id = created.body.travel.id
    const { rows } = await db.query("SELECT data FROM records WHERE type = 'travel' AND id = $1", [id])
    assert.equal(rows[0].data.title, "Test Trip")

    await request(app).put(`/travels/${id}`).set(auth).send({ price: 999 }).expect(200)
    const upd = await db.query("SELECT data->>'price' AS price FROM records WHERE id = $1", [id])
    assert.equal(upd.rows[0].price, "999")

    await request(app).delete(`/travels/${id}`).set(auth).expect(200)
    const del = await db.query("SELECT 1 FROM records WHERE id = $1", [id])
    assert.equal(del.rowCount, 0)
})

test("modifiche fatte da un'altra istanza arrivano entro il TTL della cache", { skip }, async () => {
    await db.query(`UPDATE records SET data = jsonb_set(data, '{title}', '"Modificato altrove"') WHERE type = 'travel' AND id = 2`)
    await new Promise(r => setTimeout(r, 250))
    const res = await request(app).get("/travels/2").expect(200)
    assert.equal(res.body.travel.title, "Modificato altrove")
})

test("errore di storage → 500 e cache invariata (niente successo finto)", { skip }, async () => {
    const before = (await request(app).get("/travels")).body.length
    await db.query("ALTER TABLE records RENAME TO records_offline")
    try {
        const res = await request(app).post("/travels").set(auth).send(validTravel).expect(500)
        assert.equal(res.body.success, false)
    } finally {
        await db.query("ALTER TABLE records_offline RENAME TO records")
    }
    assert.equal((await request(app).get("/travels")).body.length, before)
})

test("cancellare tutto non fa ricomparire il seed al riavvio", { skip }, async () => {
    const url = await createTestDatabase()
    const first = createPostgresStore({ connectionString: url, seedDir })
    assert.equal((await first.load("travel")).length, 14)
    for (let id = 1; id <= 14; id++) await first.persist("travel", { op: "delete", id })
    await first.close()

    const restarted = createPostgresStore({ connectionString: url, seedDir })
    assert.equal((await restarted.load("travel")).length, 0)
    await restarted.close()
})

test("due istanze che partono insieme fanno il seed una volta sola", { skip }, async () => {
    const url = await createTestDatabase()
    const a = createPostgresStore({ connectionString: url, seedDir })
    const b = createPostgresStore({ connectionString: url, seedDir })
    const [ra, rb] = await Promise.all([a.load("travel"), b.load("travel")])
    assert.equal(ra.length, 14)
    assert.equal(rb.length, 14)
    await Promise.all([a.close(), b.close()])
})
