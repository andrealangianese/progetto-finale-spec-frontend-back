import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Avvia l'app su una copia temporanea dei dati: i test di scrittura non toccano database/
export const API_KEY = "test-key-123"

export async function loadApp(env = {}) {
    process.env.NODE_ENV = "test"
    process.env.ADMIN_API_KEY = API_KEY
    process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "langiaroad-"))
    Object.assign(process.env, env)
    const { default: app, ready } = await import("../server.js")
    await ready
    return app
}

export const validTravel = {
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
