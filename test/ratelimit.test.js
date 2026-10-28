import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import request from "supertest"
import { closeApp, loadApp, validTravel } from "./helpers.js"

let app
after(closeApp)
before(async () => { app = await loadApp({ RATE_LIMIT_READ: "5", RATE_LIMIT_WRITE: "2" }) })

test("oltre il limite di letture → 429", async () => {
    for (let i = 0; i < 5; i++) await request(app).get("/travels").expect(200)
    const res = await request(app).get("/travels").expect(429)
    assert.equal(res.body.success, false)
})

test("le scritture hanno un limite proprio, applicato prima dell'auth (anti brute force della chiave)", async () => {
    await request(app).post("/travels").send(validTravel).expect(401)
    await request(app).post("/travels").send(validTravel).expect(401)
    await request(app).post("/travels").send(validTravel).expect(429)
})
