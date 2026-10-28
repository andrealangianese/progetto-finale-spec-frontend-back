import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import request from "supertest"
import type { Express } from "express"
import { MongoClient } from "mongodb"
import type { Db } from "mongodb"
import { API_KEY, closeApp, loadApp, testMongoDbName, validTravel } from "./helpers.js"
import { createMongoStore } from "../lib/storage/mongo.js"
import type { Store } from "../lib/types.js"

type TravelDocument = { _id: number } & Record<string, unknown>

// Eseguito solo con TEST_MONGODB_URI (es. mongodb://localhost:27017)
const MONGO_URI = process.env.TEST_MONGODB_URI ?? ""
const skip = !MONGO_URI && "TEST_MONGODB_URI non impostata"
const seedDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "database")
const auth = { "X-API-Key": API_KEY }

let app: Express
let client: MongoClient
let db: Db
before(async () => {
    if (skip) return
    app = await loadApp({ CACHE_TTL_MS: "200" })
    client = new MongoClient(MONGO_URI)
    db = client.db(process.env.MONGODB_DB)
})
after(async () => {
    if (skip) return
    await client.close()
    await closeApp()
})

// store indipendente su un database nuovo (simula un'altra istanza o un riavvio)
const freshStore = (dbName: string) => {
    process.env.MONGODB_DB = dbName
    return createMongoStore({ uri: MONGO_URI, seedDir })
}

const travels = () => db.collection<TravelDocument>("travel")
const countLoaded = async (store: Store): Promise<number> => (await store.load("travel") as unknown[]).length

test("seed iniziale dal JSON: un documento per viaggio con _id numerico", { skip }, async () => {
    assert.equal(await travels().countDocuments(), 14)
    const doc = await travels().findOne({ _id: 1 })
    assert.ok(doc)
    assert.equal(doc.destination, "Nepal")
    assert.equal(doc.id, undefined) // l'id vive in _id, non duplicato
    const res = await request(app).get("/travels/1").expect(200)
    assert.equal(res.body.travel.id, 1)
})

test("le scritture finiscono su MongoDB", { skip }, async () => {
    const created = await request(app).post("/travels").set(auth).send(validTravel).expect(201)
    const id = created.body.travel.id
    assert.equal((await travels().findOne({ _id: id }))?.title, "Test Trip")

    await request(app).put(`/travels/${id}`).set(auth).send({ price: 999 }).expect(200)
    assert.equal((await travels().findOne({ _id: id }))?.price, 999)

    await request(app).delete(`/travels/${id}`).set(auth).expect(200)
    assert.equal(await travels().countDocuments({ _id: id }), 0)
})

test("modifiche fatte da un'altra istanza arrivano entro il TTL della cache", { skip }, async () => {
    await travels().updateOne({ _id: 2 }, { $set: { title: "Modificato altrove" } })
    await new Promise(r => setTimeout(r, 250))
    const res = await request(app).get("/travels/2").expect(200)
    assert.equal(res.body.travel.title, "Modificato altrove")
})

test("errore di storage → 500 e cache invariata (niente successo finto)", { skip }, async () => {
    const before = (await request(app).get("/travels")).body.length
    // validator che rifiuta qualsiasi insert: simula un guasto di scrittura deterministico
    await db.command({ collMod: "travel", validator: { $jsonSchema: { required: ["campoInesistente"] } } })
    try {
        const res = await request(app).post("/travels").set(auth).send(validTravel).expect(500)
        assert.equal(res.body.success, false)
    } finally {
        await db.command({ collMod: "travel", validator: {} })
    }
    assert.equal((await request(app).get("/travels")).body.length, before)
})

test("cancellare tutto non fa ricomparire il seed al riavvio", { skip }, async () => {
    const name = testMongoDbName()
    const first = freshStore(name)
    assert.equal(await countLoaded(first), 14)
    for (let id = 1; id <= 14; id++) await first.persist("travel", { op: "delete", id }, [])
    await first.close()

    const restarted = freshStore(name)
    assert.equal(await countLoaded(restarted), 0)
    await restarted.close()
})

test("tre istanze che partono insieme: seed idempotente, nessun duplicato", { skip }, async () => {
    const name = testMongoDbName()
    const stores = [freshStore(name), freshStore(name), freshStore(name)]
    const counts = await Promise.all(stores.map(countLoaded))
    assert.ok(counts.every(n => n === 14))
    const check = new MongoClient(MONGO_URI)
    assert.equal(await check.db(name).collection("travel").countDocuments(), 14)
    await check.close()
    await Promise.all(stores.map(s => s.close()))
})

test("MONGODB_URI e DATABASE_URL insieme → errore di configurazione esplicito", async () => {
    const { createStore } = await import("../lib/storage/index.js")
    const prev = { m: process.env.MONGODB_URI, d: process.env.DATABASE_URL }
    process.env.MONGODB_URI = "mongodb://x"
    process.env.DATABASE_URL = "postgresql://x"
    try {
        assert.throws(() => createStore({ dataDir: "/tmp", seedDir }), /Configurazione ambigua/)
    } finally {
        if (prev.m === undefined) delete process.env.MONGODB_URI; else process.env.MONGODB_URI = prev.m
        if (prev.d === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prev.d
    }
})
