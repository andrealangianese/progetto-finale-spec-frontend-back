import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import pg from "pg"
import type { Express } from "express"

// Avvia l'app su una copia temporanea dei dati: i test di scrittura non toccano database/
export const API_KEY = "test-key-123"

export async function loadApp(env: Record<string, string> = {}): Promise<Express> {
    process.env.NODE_ENV = "test"
    process.env.ADMIN_API_KEY = API_KEY
    process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "langiaroad-"))
    // TEST_DATABASE_URL impostata → stessa suite su Postgres, con un database nuovo per file di test
    if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = await createTestDatabase()
    // TEST_MONGODB_URI impostata → stessa suite su MongoDB, con un database nuovo per file di test
    if (process.env.TEST_MONGODB_URI) {
        process.env.MONGODB_URI = process.env.TEST_MONGODB_URI
        process.env.MONGODB_DB = testMongoDbName()
    }
    Object.assign(process.env, env)
    const { default: app, ready } = await import("../server.js")
    await ready
    return app
}

export const validTravel: Record<string, unknown> = {
    title: "Test Trip",
    category: "Trekking",
    destination: "Italia",
    durationDay: 3,
    price: 300,
    difficulty: "Facile",
    adrenalineLevel: 2,
    image: "https://example.com/img.jpg",
    description: "Viaggio di test",
    requiredEquipment: ["Zaino"],
}

// Crea un database usa-e-getta sul server indicato da TEST_DATABASE_URL
export async function createTestDatabase(): Promise<string> {
    const adminUrl = process.env.TEST_DATABASE_URL
    if (!adminUrl) throw new Error("TEST_DATABASE_URL non impostata")
    const admin = new pg.Client({ connectionString: adminUrl })
    await admin.connect()
    const name = `langiaroad_test_${randomBytes(4).toString("hex")}`
    await admin.query(`CREATE DATABASE ${name}`)
    await admin.end()
    const url = new URL(adminUrl)
    url.pathname = `/${name}`
    return url.toString()
}

// Chiude le connessioni dello storage (Postgres): altrimenti il processo di test non termina
export async function closeApp(): Promise<void> {
    const { store } = await import("../server.js")
    await store.close?.()
}

export const testMongoDbName = (): string => `langiaroad_test_${randomBytes(4).toString("hex")}`
