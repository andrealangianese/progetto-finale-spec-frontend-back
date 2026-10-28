import express from "express";
import type { Request } from "express";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import morgan from "morgan";
import { validators, readonlyProperties } from './schema.js';
import type { ValidationError, Validator } from './schema.js';
import type { Resource } from './lib/types.js';
import { createStore } from './lib/storage/index.js';
import { describe, queryList, similar } from './lib/query.js';
import {
    asyncHandler, corsOptions, errorHandler, notFoundHandler,
    rateLimiters, requireApiKey, securityHeaders,
} from './lib/security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Su Vercel il filesystem di /var/task è di sola lettura: si scrive solo in /tmp
const IS_VERCEL = !!process.env.VERCEL;
const SRC_DB_DIR = path.join(__dirname, 'database');        // file iniziali (sola lettura su Vercel)
// DATA_DIR permette di puntare a una cartella diversa (es. una copia temporanea nei test)
const DB_DIR = process.env.DATA_DIR || (IS_VERCEL ? '/tmp/database' : SRC_DB_DIR);    // cartella scrivibile

const app = express();
const PORT = 3001;

// Promise di caricamento dati (assegnata dopo la definizione delle route)
let ready: Promise<unknown>;

// Su Vercel le richieste passano da un proxy: serve per leggere l'IP reale (rate limit)
if (IS_VERCEL) app.set('trust proxy', 1);

const limiters = rateLimiters();

// Middleware
app.use(securityHeaders);
app.use(
    morgan('dev', {
        skip: (req) => req.method === 'OPTIONS' || process.env.NODE_ENV === 'test',
    })
);
app.use(cors(corsOptions()));
app.use(limiters.read);
// Limite sul body: protegge da payload enormi (body-parser recente rifiuta 'Infinity')
app.use(express.json({ limit: '100kb' }));

// Aspetta che i dati siano caricati (e, con un database, aggiornati) prima di rispondere
app.use(async (_req, _res, next) => {
    try {
        await ready;
        await refreshIfStale();
        next();
    } catch (e) {
        next(e);
    }
});

// **Storage**: file JSON in locale, MongoDB con MONGODB_URI, Postgres con DATABASE_URL
const store = createStore({ dataDir: DB_DIR, seedDir: SRC_DB_DIR });

// **CACHE in memoria** for each resource type
const cache = new Map<string, Resource[]>();
const itemsOf = (type: string): Resource[] => cache.get(type) ?? [];

/** Type guard: un record ha i campi base che il server dà per scontati. */
function isResource(value: unknown): value is Resource {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return typeof record.id === 'number'
        && typeof record.createdAt === 'string'
        && typeof record.updatedAt === 'string'
        && typeof record.title === 'string'
        && typeof record.category === 'string';
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Id numerico dalla route; valori non validi → NaN, che non corrisponde a nessun record (404). */
const parseId = (raw: string | undefined): number => Number.parseInt(raw ?? '', 10);

// Helper to get plural form (basic pluralization rules)
function getPlural(singular: string): string {
    if (singular.endsWith('y')) {
        return singular.slice(0, -1) + 'ies';
    } else if (singular.endsWith('s') || singular.endsWith('x') || singular.endsWith('z') || singular.endsWith('ch') || singular.endsWith('sh')) {
        return singular + 'es';
    } else {
        return singular + 's';
    }
}

// Extract resource types from validators
const resourceTypes = Object.keys(validators);

// Initialize cache for each resource type
resourceTypes.forEach(type => {
    cache.set(type, []);
});

function validatorFor(type: string): Validator {
    const validator = validators[type];
    if (!validator) throw new Error(`Nessun validator per il tipo ${type}`);
    return validator;
}

// Helper function to format validation errors in a readable way
function formatValidationErrors(errors: ValidationError[]): string {
    let formattedMessage = "";
    const fieldErrors = new Map<string, string[]>();

    // Group errors by field
    errors.forEach(error => {
        fieldErrors.set(error.field, [...(fieldErrors.get(error.field) ?? []), error.message]);
    });

    // Format each field's errors
    for (const [field, messages] of fieldErrors) {
        const fieldName = field || "Generale";
        formattedMessage += `\n   • ${fieldName}: ${messages.join(", ")}`;
    }

    return formattedMessage;
}

// **Caricare e validare i dati** (all'avvio e, con Postgres, quando la cache scade)
const loadData = async (type: string): Promise<void> => {
    const loadedData = await store.load(type);

    // Verifica che i dati caricati siano in formato array
    if (!Array.isArray(loadedData)) {
        throw new Error(`Errore di struttura nei dati di ${type}: deve essere un array.`);
    }

    // Valida ogni elemento nell'array usando il validator appropriato
    const validator = validatorFor(type);
    const invalidItems: { index: number; id: unknown; errors: ValidationError[] }[] = [];
    const validItems: Resource[] = [];
    loadedData.forEach((item: unknown, i) => {
        const id = isPlainObject(item) && item.id !== undefined ? item.id : 'sconosciuto';
        const validationResult = validator(item);
        if (!validationResult.valid) {
            invalidItems.push({ index: i, id, errors: validationResult.errors });
        } else if (!isResource(item)) {
            // lo schema li considera opzionali (li assegna il server), ma un record salvato deve averli
            invalidItems.push({ index: i, id, errors: [{ field: "id/createdAt/updatedAt", message: "campi assegnati dal server mancanti o non validi" }] });
        } else {
            validItems.push(item);
        }
    });

    if (invalidItems.length > 0) {
        let errorMessage = `\n⛔ Errori di validazione nei dati di ${type}. Il server non può partire.\n`;
        invalidItems.forEach(item => {
            errorMessage += `\n🚫 Elemento #${item.index + 1} (ID: ${item.id}) non valido:`;
            errorMessage += formatValidationErrors(item.errors);
            errorMessage += "\n";
        });
        errorMessage += `\nCorreggi questi errori nei dati di ${type} per avviare il server.`;
        throw new Error(errorMessage);
    }

    cache.set(type, validItems);
};

// Con uno storage condiviso (MongoDB, Postgres) più istanze serverless hanno ognuna la propria cache:
// la ricarico al massimo ogni refreshTtlMs (consistenza eventuale). Una sola ricarica alla volta.
let lastLoadAt = Date.now();
let refreshing: Promise<void> | null = null;
async function refreshIfStale(): Promise<void> {
    if (!store.refreshTtlMs || Date.now() - lastLoadAt < store.refreshTtlMs) return;
    refreshing ??= Promise.all(resourceTypes.map(loadData))
        .then(() => { lastLoadAt = Date.now(); })
        .finally(() => { refreshing = null; });
    await refreshing;
}

// Dynamically create routes for each resource type
const loadPromises = resourceTypes.map(type => {
    const pluralType = getPlural(type);
    const validator = validatorFor(type);

    // 📌 **POST /:resource - Create a new resource**
    app.post(`/${pluralType}`, limiters.write, requireApiKey, asyncHandler(async (req, res) => {
        const validationResult = validator(req.body);
        if (!validationResult.valid) {
            return res.status(400).json({
                error: `Invalid ${type} data`,
                details: validationResult.errors
            });
        }

        // Uso i dati validati dallo schema, non il body grezzo
        const items = itemsOf(type);
        const creationDate = new Date().toISOString();
        const newItem = {
            ...validationResult.data,
            // Creazione ID univoco
            id: items.length > 0 ? Math.max(...items.map((t) => t.id)) + 1 : 1,
            createdAt: creationDate,
            updatedAt: creationDate,
        };
        if (!isResource(newItem)) throw new Error(`Record ${type} non valido dopo la validazione`);

        // Prima salvo, poi aggiorno la cache: se lo storage fallisce la cache resta coerente
        const nextItems = [...items, newItem];
        await store.persist(type, { op: 'insert', item: newItem }, nextItems);
        cache.set(type, nextItems);
        return res.status(201).json({ success: true, [type]: newItem });
    }));

    // 📌 **GET /:resource/meta - Categorie, range numerici e campi disponibili**
    // (registrata prima di /:id, altrimenti "meta" verrebbe letto come id)
    app.get(`/${pluralType}/meta`, (_req, res) => {
        res.json({ success: true, meta: describe(itemsOf(type)) });
    });

    // 📌 **GET /:resource/:id/similar - Record simili (stessa categoria, valori vicini)**
    app.get(`/${pluralType}/:id/similar`, (req, res) => {
        const items = itemsOf(type);
        const target = items.find((p) => p.id === parseId(req.params.id));
        if (!target) {
            res.status(404).json({ success: false, message: `${type} with id '${req.params.id}' not found.` });
            return;
        }
        const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit), 10) || 3, 1), 20);
        res.json(similar(items, target, limit));
    });

    // 📌 **GET /:resource/:id - Get a specific resource**
    app.get(`/${pluralType}/:id`, (req, res) => {
        const itemId = parseId(req.params.id);
        const item = itemsOf(type).find((p) => p.id === itemId);
        if (!item) {
            res.status(404).json({ success: false, message: `${type} with id '${itemId}' not found.` });
            return;
        }
        res.json({ success: true, [type]: item });
    });

    // 📌 **PUT /:resource/:id - Update a resource**
    app.put(`/${pluralType}/:id`, limiters.write, requireApiKey, asyncHandler(async (req, res) => {
        const itemId = parseId(req.params.id);
        const items = itemsOf(type);
        const itemIndex = items.findIndex((p) => p.id === itemId);
        const oldItem = items[itemIndex];
        if (!oldItem) {
            return res.status(404).json({ success: false, message: `${type} with id '${itemId}' not found.` });
        }

        const body: unknown = req.body;
        if (!isPlainObject(body)) {
            return res.status(400).json({ success: false, error: `Il body deve essere un oggetto JSON con i campi da aggiornare` });
        }

        // Create a copy of the request body without protected fields
        const updatedFields: Record<string, unknown> = { ...body };
        // Remove protected fields if present
        delete updatedFields.id;
        delete updatedFields.createdAt;
        delete updatedFields.updatedAt;

        // Check if any readonly properties are being updated
        const typeReadonlyProps = readonlyProperties[type] || [];
        const readonlyAttemptsToUpdate = Object.keys(updatedFields).filter(key =>
            typeReadonlyProps.includes(key)
        );

        if (readonlyAttemptsToUpdate.length > 0) {
            return res.status(400).json({
                success: false,
                error: `Cannot update readonly properties`,
                details: {
                    readonly: readonlyAttemptsToUpdate,
                    message: `The following properties are readonly and cannot be updated: ${readonlyAttemptsToUpdate.join(', ')}`
                }
            });
        }

        // Validate only the fields being updated
        if (Object.keys(updatedFields).length > 0) {
            const validationResult = validator({ ...oldItem, ...updatedFields });
            if (!validationResult.valid) {
                return res.status(400).json({
                    error: `Invalid ${type} data`,
                    details: validationResult.errors
                });
            }
        }

        // Update timestamp and merge changes with existing item
        const now = new Date().toISOString();
        const updatedItem = { ...oldItem, ...updatedFields, updatedAt: now };
        if (!isResource(updatedItem)) throw new Error(`Record ${type} non valido dopo la validazione`);

        const nextItems = items.map((p, i) => (i === itemIndex ? updatedItem : p));
        await store.persist(type, { op: 'update', item: updatedItem }, nextItems);
        cache.set(type, nextItems);
        return res.json({ success: true, [type]: updatedItem });
    }));

    // 📌 **DELETE /:resource/:id - Delete a resource**
    app.delete(`/${pluralType}/:id`, limiters.write, requireApiKey, asyncHandler(async (req, res) => {
        const itemId = parseId(req.params.id);
        const items = itemsOf(type);
        const filteredItems = items.filter((p) => p.id !== itemId);
        if (filteredItems.length === items.length) {
            return res.status(404).json({ success: false, message: `${type} with id '${itemId}' not found.` });
        }

        await store.persist(type, { op: 'delete', id: itemId }, filteredItems);
        cache.set(type, filteredItems);
        return res.json({ success: true });
    }));

    // 📌 **GET /:resource - Get all resources**
    // Contratto originale invariato (search, category → id/title/category/date).
    // Opzionali: ids, fields, <campo>_gte/_lte, sort/order, page/limit (totale in X-Total-Count)
    app.get(`/${pluralType}`, (req: Request, res) => {
        const { items, total } = queryList(itemsOf(type), req.query);
        res.set('X-Total-Count', String(total));
        res.json(items);
    });

    // Load data for this resource type
    return loadData(type);
});

ready = Promise.all(loadPromises);
ready.catch(() => {}); // evita unhandled rejection: l'errore viene gestito sotto / dal middleware

// 📌 **GET /health - Stato del servizio** (per monitoraggio e uptime check)
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        storage: store.name,
        uptime: Math.round(process.uptime()),
        resources: Object.fromEntries(resourceTypes.map(type => [getPlural(type), itemsOf(type).length])),
    });
});

app.use(notFoundHandler);
app.use(errorHandler);

// Avvio solo se eseguito direttamente (tsx server.ts), non quando importato (Vercel, test)
const isEntryPoint = !!process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (!IS_VERCEL && isEntryPoint) {
    // Avvio locale
    ready
        .then(() => {
            app.listen(PORT, () => {
                console.log(`🔌 API Disponibili:`);
                resourceTypes.forEach(type => {
                    console.log(`   - /${getPlural(type)} (risorsa ${type})`);
                });
                console.log(`✅ Server in ascolto su http://localhost:${PORT}`);
            });
        })
        .catch((error: unknown) => {
            console.error(`\n${error instanceof Error ? error.message : String(error)}`);
            console.error("\n⚠️ Il server non è stato avviato a causa degli errori sopra indicati.");
            process.exit(1);
        });
}

// Vercel usa l'app esportata come handler; i test attendono `ready` prima delle richieste
export { ready, store };
export default app;