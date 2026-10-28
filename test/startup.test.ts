import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Solo storage su file: il caso riguarda la validazione dei dati caricati, non il database
const skip = (process.env.TEST_DATABASE_URL || process.env.TEST_MONGODB_URI) && "verificato in modalità file"

test("all'avvio un record senza id/date assegnati dal server blocca il caricamento", { skip }, async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "langiaroad-bad-"))
    const { id: _id, ...senzaId } = {
        id: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        title: "Senza id", category: "Trekking", destination: "Italia", durationDay: 3, price: 300,
        difficulty: "Facile", adrenalineLevel: 2, image: "x", description: "x", requiredEquipment: [],
    }
    writeFileSync(path.join(dataDir, "travel.json"), JSON.stringify([senzaId]))

    process.env.NODE_ENV = "test"
    process.env.DATA_DIR = dataDir
    const { ready } = await import("../server.js")
    await assert.rejects(ready, /campi assegnati dal server mancanti/)
})
