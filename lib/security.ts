import { timingSafeEqual } from "crypto";
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import type { CorsOptions } from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const isProduction = (): boolean => !!process.env.VERCEL || process.env.NODE_ENV === "production";

// ── CORS ───────────────────────────────────────────────────────────────
// ALLOWED_ORIGINS="https://app.vercel.app,http://localhost:5173" → whitelist.
// Non impostata → API pubblica in lettura ('*'), mai con credenziali.
export function corsOptions(): CorsOptions {
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
export const securityHeaders: RequestHandler = helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
});

// ── Rate limiting ──────────────────────────────────────────────────────
// Nota: in memoria, quindi per istanza. Su serverless è una difesa di base,
// non un limite globale (per quello serve uno store condiviso, es. Redis).
export function rateLimiters(): { read: RequestHandler; write: RequestHandler } {
    const common = { standardHeaders: "draft-7", legacyHeaders: false } as const;
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
function extractKey(req: Request): string {
    const auth = req.get("authorization") || "";
    if (auth.startsWith("Bearer ")) return auth.slice(7);
    return req.get("x-api-key") || "";
}

function safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

let warned = false;

// POST/PUT/DELETE richiedono ADMIN_API_KEY.
// Senza chiave configurata: in produzione le scritture sono disabilitate (fail closed),
// in locale restano aperte per comodità di sviluppo, con un avviso.
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
    const expected = process.env.ADMIN_API_KEY;

    if (!expected) {
        if (isProduction()) {
            res.status(503).json({
                success: false,
                error: "Scritture disabilitate: ADMIN_API_KEY non configurata sul server.",
            });
            return;
        }
        if (!warned) {
            console.warn("⚠️  ADMIN_API_KEY non impostata: scritture aperte (solo sviluppo locale).");
            warned = true;
        }
        next();
        return;
    }

    if (!safeEqual(extractKey(req), expected)) {
        res.set("WWW-Authenticate", 'Bearer realm="langiaroad"');
        res.status(401).json({ success: false, error: "API key mancante o non valida." });
        return;
    }
    next();
}

// ── Errori ─────────────────────────────────────────────────────────────
// Express 4 non intercetta le promise rifiutate: senza questo wrapper un errore
// in un handler async lascia la richiesta appesa fino al timeout del client.
export const asyncHandler = (
    fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

export const notFoundHandler: RequestHandler = (req, res) => {
    res.status(404).json({ success: false, error: `Rotta non trovata: ${req.method} ${req.path}` });
};

/** Status HTTP portato dall'errore (body-parser usa `status`, altre librerie `statusCode`). */
function statusOf(err: unknown): number {
    if (typeof err === "object" && err !== null) {
        const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
        if (typeof status === "number") return status;
        if (typeof statusCode === "number") return statusCode;
    }
    return 500;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    // Errori del client (JSON malformato, body troppo grande...) mantengono il loro status
    const status = statusOf(err);
    if (status >= 500) console.error(err);
    const message = status >= 500 && isProduction()
        ? "Errore interno del server"
        : err instanceof Error ? err.message : String(err);
    res.status(status).json({ success: false, error: message });
};
