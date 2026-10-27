import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import request from "supertest"
import { API_KEY, loadApp, validTravel } from "./helpers.js"
import { asyncHandler } from "../lib/security.js"

let app
before(async () => { app = await loadApp({ ALLOWED_ORIGINS: "https://langiaroad.app" }) })
after(() => { delete process.env.VERCEL })

test("scrittura senza chiave → 401 con WWW-Authenticate", async () => {
    const res = await request(app).post("/travels").send(validTravel).expect(401)
    assert.match(res.headers["www-authenticate"], /Bearer/)
})

test("chiave errata → 401 (anche su PUT e DELETE)", async () => {
    await request(app).put("/travels/1").set("Authorization", "Bearer sbagliata").send({ price: 1 }).expect(401)
    await request(app).delete("/travels/1").set("X-API-Key", "sbagliata").expect(401)
    await request(app).get("/travels/1").expect(200) // nulla è stato cancellato
})

test("chiave valida via header X-API-Key → scrittura consentita", async () => {
    await request(app).put("/travels/1").set("X-API-Key", API_KEY).send({ price: 2400 }).expect(200)
})

test("in produzione senza ADMIN_API_KEY le scritture sono disabilitate (fail closed)", async () => {
    const key = process.env.ADMIN_API_KEY
    delete process.env.ADMIN_API_KEY
    process.env.VERCEL = "1"
    try {
        await request(app).delete("/travels/1").expect(503)
    } finally {
        process.env.ADMIN_API_KEY = key
        delete process.env.VERCEL
    }
})

test("le letture restano pubbliche", async () => {
    await request(app).get("/travels").expect(200)
})

test("JSON malformato → 400, non 500", async () => {
    const res = await request(app).post("/travels").set("X-API-Key", API_KEY)
        .set("Content-Type", "application/json").send('{"title": ').expect(400)
    assert.equal(res.body.success, false)
})

test("body oltre 100kb → 413", async () => {
    await request(app).post("/travels").set("X-API-Key", API_KEY)
        .send({ ...validTravel, description: "x".repeat(150_000) }).expect(413)
})

test("CORS: origine in whitelist ammessa, altre no", async () => {
    const ok = await request(app).get("/travels").set("Origin", "https://langiaroad.app")
    assert.equal(ok.headers["access-control-allow-origin"], "https://langiaroad.app")
    assert.equal(ok.headers["access-control-allow-credentials"], undefined)
    const ko = await request(app).get("/travels").set("Origin", "https://evil.example")
    assert.equal(ko.headers["access-control-allow-origin"], undefined)
})

test("header di sicurezza presenti, X-Powered-By assente", async () => {
    const res = await request(app).get("/travels")
    assert.equal(res.headers["x-content-type-options"], "nosniff")
    assert.equal(res.headers["x-powered-by"], undefined)
    assert.ok(res.headers["ratelimit-policy"])
})

test("rotta sconosciuta → 404 JSON", async () => {
    const res = await request(app).get("/admin").expect(404)
    assert.equal(res.body.success, false)
})

test("asyncHandler inoltra gli errori invece di lasciare la richiesta appesa", async () => {
    const boom = new Error("boom")
    let forwarded
    await asyncHandler(async () => { throw boom })({}, {}, (err) => { forwarded = err })
    assert.equal(forwarded, boom)
})
