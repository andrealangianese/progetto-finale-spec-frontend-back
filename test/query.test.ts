import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import request from "supertest"
import type { Express } from "express"

type Row = Record<string, unknown>
import { closeApp, loadApp } from "./helpers.js"

let app: Express
after(closeApp)
before(async () => { app = await loadApp() })

test("senza parametri nuovi la risposta è identica al contratto originale", async () => {
    const res = await request(app).get("/travels").expect(200)
    assert.equal(res.headers["x-total-count"], "14")
    assert.ok((res.body as Row[]).every(t => Object.keys(t).length === 5 && !("price" in t)))
})

test("?ids= restituisce solo i record richiesti (una chiamata invece di N)", async () => {
    const res = await request(app).get("/travels?ids=1,6,13&fields=price,durationDay").expect(200)
    assert.deepEqual((res.body as Row[]).map(t => t.id), [1, 6, 13])
    assert.deepEqual((res.body as Row[]).map(t => t.price), [2450, 980, 850])
    assert.ok(!("description" in res.body[0]))
})

test("?fields=* restituisce i record completi", async () => {
    const res = await request(app).get("/travels?ids=1&fields=*").expect(200)
    assert.equal(res.body[0].destination, "Nepal")
})

test("filtri numerici _gte/_lte combinabili", async () => {
    const res = await request(app).get("/travels?price_lte=1000&adrenalineLevel_gte=4&fields=price,adrenalineLevel").expect(200)
    assert.ok(res.body.length > 0)
    assert.ok((res.body as { price: number; adrenalineLevel: number }[]).every(t => t.price <= 1000 && t.adrenalineLevel >= 4))
})

test("ordinamento numerico e testuale", async () => {
    const byPrice = await request(app).get("/travels?sort=price&order=desc&fields=price").expect(200)
    const prices = (byPrice.body as { price: number }[]).map(t => t.price)
    assert.deepEqual(prices, [...prices].sort((a, b) => b - a))

    const byTitle = await request(app).get("/travels?sort=title").expect(200)
    const titles = (byTitle.body as { title: string }[]).map(t => t.title)
    assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b, "it")))
})

test("paginazione opt-in con X-Total-Count", async () => {
    const p1 = await request(app).get("/travels?sort=price&page=1&limit=5").expect(200)
    const p3 = await request(app).get("/travels?sort=price&page=3&limit=5").expect(200)
    assert.equal(p1.body.length, 5)
    assert.equal(p3.body.length, 4)
    assert.equal(p3.headers["x-total-count"], "14")
})

test("parametri non validi → 400 con messaggio che spiega cosa è ammesso", async () => {
    const cases = ["/travels?ids=1,abc", "/travels?fields=password", "/travels?sort=nope", "/travels?order=up&sort=price",
        "/travels?price_lte=tanto", "/travels?title_gte=3", "/travels?limit=1000"]
    for (const url of cases) {
        const res = await request(app).get(url)
        assert.equal(res.status, 400, url)
        assert.equal(res.body.success, false, url)
    }
})

test("GET /travels/meta: categorie e range per costruire i filtri", async () => {
    const res = await request(app).get("/travels/meta").expect(200)
    const { meta } = res.body
    assert.equal(meta.count, 14)
    assert.ok(meta.categories.includes("Trekking"))
    assert.deepEqual(meta.ranges.price, { min: 450, max: 3200 })
    assert.deepEqual(meta.ranges.adrenalineLevel, { min: 1, max: 5 })
})

test("GET /travels/:id/similar: stessa categoria prima, escluso se stesso", async () => {
    const res = await request(app).get("/travels/1/similar?limit=3").expect(200)
    assert.equal(res.body.length, 3)
    assert.ok(!(res.body as Row[]).some(t => t.id === 1))
    assert.equal(res.body[0].category, "Trekking")
    await request(app).get("/travels/999/similar").expect(404)
})

test("GET /health", async () => {
    const res = await request(app).get("/health").expect(200)
    assert.equal(res.body.status, "ok")
    assert.equal(res.body.storage, process.env.MONGODB_URI ? "mongodb" : process.env.DATABASE_URL ? "postgres" : "file")
    assert.equal(res.body.resources.travels, 14)
})
