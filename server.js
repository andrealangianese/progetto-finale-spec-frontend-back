import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import morgan from "morgan";
import { validators, readonlyProperties } from './schema.js';
import { createStore } from './lib/storage/index.js';
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
let ready;

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

// Aspetta che i dati siano caricati (e, con Postgres, aggiornati) prima di rispondere
app.use(async (req, res, next) => {
    try {
        await ready;
        await refreshIfStale();
        next();
    } catch (e) {
        next(e);
    }
});

// **Storage**: file JSON in locale, Postgres se è impostata DATABASE_URL
const store = createStore({ dataDir: DB_DIR, seedDir: SRC_DB_DIR });

// **CACHE in memoria** for each resource type
const cache = {};

// Helper to get plural form (basic pluralization rules)
function getPlural(singular) {
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
    cache[type] = [];
});

// Helper function to format validation errors in a readable way
function formatValidationErrors(errors) {
    let formattedMessage = "";
    const fieldErrors = {};

    // Group errors by field
    errors.forEach(error => {
        if (!fieldErrors[error.field]) {
            fieldErrors[error.field] = [];
        }
        fieldErrors[error.field].push(error.message);
    });

    // Format each field's errors
    for (const [field, messages] of Object.entries(fieldErrors)) {
        const fieldName = field || "Generale";
        formattedMessage += `\n   • ${fieldName}: ${messages.join(", ")}`;
    }

    return formattedMessage;
}

// **Caricare e validare i dati** (all'avvio e, con Postgres, quando la cache scade)
const loadData = async (type) => {
    const loadedData = await store.load(type);

    // Verifica che i dati caricati siano in formato array
    if (!Array.isArray(loadedData)) {
        throw new Error(`Errore di struttura nei dati di ${type}: deve essere un array.`);
    }

    // Valida ogni elemento nell'array usando il validator appropriato
    const validator = validators[type];
    const invalidItems = [];
    loadedData.forEach((item, i) => {
        const validationResult = validator(item);
        if (!validationResult.valid) {
            invalidItems.push({ index: i, id: item.id || 'sconosciuto', errors: validationResult.errors });
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

    cache[type] = loadedData;
};

// Con uno storage condiviso (Postgres) più istanze serverless hanno ognuna la propria cache:
// la ricarico al massimo ogni refreshTtlMs (consistenza eventuale). Una sola ricarica alla volta.
let lastLoadAt = Date.now();
let refreshing = null;
async function refreshIfStale() {
    if (!store.refreshTtlMs || Date.now() - lastLoadAt < store.refreshTtlMs) return;
    refreshing ??= Promise.all(resourceTypes.map(loadData))
        .then(() => { lastLoadAt = Date.now(); })
        .finally(() => { refreshing = null; });
    await refreshing;
}

// Dynamically create routes for each resource type
const loadPromises = resourceTypes.map(type => {
    const pluralType = getPlural(type);
    const validator = validators[type];

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
        const newItem = { ...validationResult.data };
        // Creazione ID univoco
        newItem.id = (cache[type].length > 0 ? Math.max(...cache[type].map((t) => parseInt(t.id) || 0)) + 1 : 1);
        const creationDate = new Date();
        newItem.createdAt = creationDate.toISOString();
        newItem.updatedAt = creationDate.toISOString();

        // Prima salvo, poi aggiorno la cache: se lo storage fallisce la cache resta coerente
        const nextItems = [...cache[type], newItem];
        await store.persist(type, { op: 'insert', item: newItem }, nextItems);
        cache[type] = nextItems;
        res.status(201).json({ success: true, [type]: newItem });
    }));

    // 📌 **GET /:resource/:id - Get a specific resource**
    app.get(`/${pluralType}/:id`, (req, res) => {
        const itemId = parseInt(req.params.id);
        const item = cache[type].find((p) => p.id === itemId);
        if (!item) {
            return res.status(404).json({ success: false, message: `${type} with id '${itemId}' not found.` });
        }
        res.json({ success: true, [type]: item });
    });

    // 📌 **PUT /:resource/:id - Update a resource**
    app.put(`/${pluralType}/:id`, limiters.write, requireApiKey, asyncHandler(async (req, res) => {
        const itemId = parseInt(req.params.id);
        const itemIndex = cache[type].findIndex((p) => p.id === itemId);
        if (itemIndex === -1) {
            return res.status(404).json({ success: false, message: `${type} with id '${itemId}' not found.` });
        }
        const oldItem = cache[type][itemIndex];

        // Create a copy of the request body without protected fields
        const updatedFields = { ...req.body };
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
        const fieldsToValidate = {};
        Object.keys(updatedFields).forEach(key => {
            fieldsToValidate[key] = updatedFields[key];
        });

        if (Object.keys(fieldsToValidate).length > 0) {
            const validationResult = validator({ ...oldItem, ...fieldsToValidate });
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

        const nextItems = cache[type].map((p, i) => (i === itemIndex ? updatedItem : p));
        await store.persist(type, { op: 'update', item: updatedItem }, nextItems);
        cache[type] = nextItems;
        res.json({ success: true, [type]: updatedItem });
    }));

    // 📌 **DELETE /:resource/:id - Delete a resource**
    app.delete(`/${pluralType}/:id`, limiters.write, requireApiKey, asyncHandler(async (req, res) => {
        const itemId = parseInt(req.params.id);
        const filteredItems = cache[type].filter((p) => p.id !== itemId);
        if (filteredItems.length === cache[type].length) {
            return res.status(404).json({ success: false, message: `${type} with id '${itemId}' not found.` });
        }

        await store.persist(type, { op: 'delete', id: itemId }, filteredItems);
        cache[type] = filteredItems;
        res.json({ success: true });
    }));

    // 📌 **GET /:resource - Get all resources**
    app.get(`/${pluralType}`, (req, res) => {
        const { search, category } = req.query;
        let filteredItems = [...cache[type]];

        // Filter by category if provided
        if (category) {
            filteredItems = filteredItems.filter(item =>
                item.category && item.category.toLowerCase() === category.toLowerCase()
            );
        }

        // Search in title if search parameter is provided
        if (search) {
            filteredItems = filteredItems.filter(item =>
                item.title && item.title.toLowerCase().includes(search.toLowerCase())
            );
        }

        res.json(filteredItems.map(
            ({ id, createdAt, updatedAt, title, category }) => ({ id, createdAt, updatedAt, title, category })
        ));
    });

    // Load data for this resource type
    return loadData(type);
});

ready = Promise.all(loadPromises);
ready.catch(() => {}); // evita unhandled rejection: l'errore viene gestito sotto / dal middleware

// Gestore errori (es. dati non validi al caricamento)
app.use(notFoundHandler);
app.use(errorHandler);

// Avvio solo se eseguito direttamente (node server.js), non quando importato (Vercel, test)
const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === __filename;

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
        .catch((error) => {
            console.error(`\n${error.message}`);
            console.error("\n⚠️ Il server non è stato avviato a causa degli errori sopra indicati.");
            process.exit(1);
        });
}

// Vercel usa l'app esportata come handler; i test attendono `ready` prima delle richieste
export { ready, store };
export default app;