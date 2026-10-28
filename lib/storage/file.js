import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";

/**
 * Storage su file JSON (default, sviluppo locale).
 * Un file per tipo: <dataDir>/<type>.json. Le scritture sono serializzate per tipo.
 * Se dataDir non è la cartella sorgente (Vercel /tmp, test) parte da una copia dei dati iniziali.
 */
export function createFileStore({ dataDir, seedDir }) {
    const queues = new Map(); // type → Promise dell'ultima scrittura

    const fileFor = (dir, type) => path.join(dir, `${type}.json`);

    return {
        name: "file",
        refreshTtlMs: 0, // processo singolo: la cache in memoria è sempre la verità

        async load(type) {
            await fs.mkdir(dataDir, { recursive: true });
            const dataFile = fileFor(dataDir, type);
            const seedFile = fileFor(seedDir, type);

            if (dataDir !== seedDir && !existsSync(dataFile) && existsSync(seedFile)) {
                await fs.copyFile(seedFile, dataFile);
            }
            if (!existsSync(dataFile)) {
                await fs.writeFile(dataFile, "[]", "utf-8");
                return [];
            }

            const raw = await fs.readFile(dataFile, "utf-8");
            if (!raw.trim()) return [];
            try {
                return JSON.parse(raw);
            } catch (parseError) {
                throw new Error(`Errore di sintassi JSON nel file ${type}.json:\n${parseError.message}\nControlla la sintassi del file e assicurati che sia un JSON valido.`);
            }
        },

        // Riscrive l'intero array; `change` non serve al file store
        persist(type, _change, items) {
            const previous = queues.get(type) ?? Promise.resolve();
            const next = previous
                .catch(() => { }) // un errore precedente non blocca le scritture successive
                .then(() => fs.writeFile(fileFor(dataDir, type), JSON.stringify(items, null, 2), "utf-8"));
            queues.set(type, next);
            return next; // gli errori arrivano al chiamante (→ 500), non vengono inghiottiti
        },
    };
}
