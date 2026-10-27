import { test, before } from "node:test"
import assert from "node:assert/strict"
import request from "supertest"
import { API_KEY, loadApp, validTravel } from "./helpers.js"

let app
const auth = { Authorization: `Bearer ${API_KEY}` }
before(async () => { app = await loadApp() })

test("GET /travels restituisce solo i campi base (contratto della traccia)", async () => {
    const res = await request(app).get("/travels").expect(200)
    assert.equal(res.body.length, 14)
    assert.deepEqual(Object.keys(res.body[0]).sort(), ["category", "createdAt", "id", "title", "updatedAt"])
})

test("GET /travels?search= filtra per titolo (case insensitive)", async () => {
    const res = await request(app).get("/travels?search=SURF").expect(200)
    assert.deepEqual(res.body.map(t => t.id), [6])
})

test("GET /travels?category= filtra per categoria", async () => {
    const res = await request(app).get("/travels?category=trekking").expect(200)
    assert.ok(res.body.length > 0)
    assert.ok(res.body.every(t => t.category === "Trekking"))
})

test("GET /travels/:id restituisce il dettaglio completo", async () => {
    const res = await request(app).get("/travels/1").expect(200)
    assert.equal(res.body.success, true)
    assert.equal(res.body.travel.destination, "Nepal")
})

test("GET /travels/:id inesistente → 404", async () => {
    await request(app).get("/travels/9999").expect(404)
})

test("POST con dati non validi → 400 con dettagli per campo", async () => {
    const res = await request(app).post("/travels").set(auth).send({ title: "Solo titolo" }).expect(400)
    const campi = res.body.details.map(d => d.field)
    assert.ok(campi.includes("category"))
    assert.ok(campi.includes("price"))
})

test("POST rifiuta proprietà sconosciute (schema strict)", async () => {
    await request(app).post("/travels").set(auth).send({ ...validTravel, hacker: true }).expect(400)
})

test("POST rifiuta valori enum non ammessi con messaggio leggibile", async () => {
    const res = await request(app).post("/travels").set(auth).send({ ...validTravel, difficulty: "Impossibile" }).expect(400)
    assert.match(res.body.details[0].message, /difficulty/)
})

test("ciclo completo POST → PUT → DELETE", async () => {
    const created = await request(app).post("/travels").set(auth).send(validTravel).expect(201)
    const id = created.body.travel.id
    assert.equal(id, 15)

    const updated = await request(app).put(`/travels/${id}`).set(auth).send({ price: 350 }).expect(200)
    assert.equal(updated.body.travel.price, 350)

    await request(app).put(`/travels/${id}`).set(auth).send({ price: "gratis" }).expect(400)
    await request(app).delete(`/travels/${id}`).set(auth).expect(200)
    await request(app).get(`/travels/${id}`).expect(404)
})
