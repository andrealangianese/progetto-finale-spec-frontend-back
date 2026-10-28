import { timingSafeEqual } from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const isProduction = () => !!process.env.VERCEL || process.env.NODE_ENV === "production";

// ── CORS ───────────────────────────────────────────────────────────────
// ALLOWED_ORIGINS="https://app.vercel.app,http://localhost:5173" → whitelist.
// Non impostata → API pubblica in lettura ('*'), mai con credenziali.
export function corsOptions() {
    const allowed = (process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map(o => o.trim())
        .filter(Boolean);

    return {
        origin: allowed.length ? allowed : "*",
        methods: ["GET", "POST", "PUT", "DELETE"],
        allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
        exposedHeaders: ["X-Total-Count"],
    };
}

// ── Header di sicurezza ────────────────────────────────────────────────
// API JSON pubblica: le risorse devono poter essere lette cross-origin
export const securityHeaders = helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
});

// ── Rate limiting ──────────────────────────────────────────────────────
// Nota: in memoria, quindi per istanza. Su serverless è una difesa di base,
// non un limite globale (per quello serve uno store condiviso, es. Redis).
export function rateLimiters() {
    const common = { standardHeaders: "draft-7", legacyHeaders: false };
    return {
        read: rateLimit({
            ...common,
            windowMs: 60 * 1000,
            limit: Number(process.env.RATE_LIMIT_READ) || 300,
            // le scritture hanno il loro limiter, più stretto
            skip: (req) => !["GET", "HEAD"].includes(req.method),
            message: { success: false, error: "Troppe richieste, riprova tra poco." },
        }),
        write: rateLimit({
            ...common,
            windowMs: 15 * 60 * 1000,
            limit: Number(process.env.RATE_LIMIT_WRITE) || 30,
            message: { success: false, error: "Troppe operazioni di scrittura, riprova più tardi." },
        }),
    };
}

// ── Autenticazione scritture ───────────────────────────────────────────
function extractKey(req) {
    const auth = req.get("authorization") || "";
    if (auth.startsWith("Bearer ")) return auth.slice(7);
    return req.get("x-api-key") || "";
}

function safeEqual(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

let warned = false;

// POST/PUT/DELETE richiedono ADMIN_API_KEY.
// Senza chiave configurata: in produzione le scritture sono disabilitate (fail closed),
// in locale restano aperte per comodità di sviluppo, con un avviso.
export function requireApiKey(req, res, next) {
    const expected = process.env.ADMIN_API_KEY;

    if (!expected) {
        if (isProduction()) {
            return res.status(503).json({
                success: false,
                error: "Scritture disabilitate: ADMIN_API_KEY non configurata sul server.",
            });
        }
        if (!warned) {
            console.warn("⚠️  ADMIN_API_KEY non impostata: scritture aperte (solo sviluppo locale).");
            warned = true;
        }
        return next();
    }

    if (!safeEqual(extractKey(req), expected)) {
        res.set("WWW-Authenticate", 'Bearer realm="langiaroad"');
        return res.status(401).json({ success: false, error: "API key mancante o non valida." });
    }
    next();
}

// ── Errori ─────────────────────────────────────────────────────────────
// Express 4 non intercetta le promise rifiutate: senza questo wrapper un errore
// in un handler async lascia la richiesta appesa fino al timeout del client.
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function notFoundHandler(req, res) {
    res.status(404).json({ success: false, error: `Rotta non trovata: ${req.method} ${req.path}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
    // Errori del client (JSON malformato, body troppo grande...) mantengono il loro status
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const message = status >= 500 && isProduction() ? "Errore interno del server" : err.message;
    res.status(status).json({ success: false, error: message });
}
