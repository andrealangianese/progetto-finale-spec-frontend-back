// Query di lettura generiche (funzioni pure): filtri, ordinamento, proiezione, paginazione.
// Tutto è opt-in: senza parametri la lista resta quella della traccia (id, title, category, date).
import type { Resource } from "./types.js";

export const BASE_FIELDS = ["id", "createdAt", "updatedAt", "title", "category"] as const;

/** Parametri come li produce Express (stringhe, array o oggetti annidati). */
export type QueryParams = Record<string, unknown>;

export class QueryError extends Error {
    readonly status = 400;
}

export type NumericRange = { min: number; max: number };

export type ResourceMeta = {
    count: number;
    categories: string[];
    ranges: Record<string, NumericRange>;
    fields: string[];
};

/** `?ids=1&ids=2` arriva come array: lo trattiamo come "1,2" (stesso comportamento di String()). */
const asText = (value: unknown): string => (Array.isArray(value) ? value.join(",") : String(value));

const numericFields = (items: Resource[]): string[] =>
    [...new Set(items.flatMap(item => Object.keys(item).filter(k => typeof item[k] === "number" && k !== "id")))];

const allFields = (items: Resource[]): string[] => [...new Set(items.flatMap(item => Object.keys(item)))];

function parseIds(raw: unknown): number[] {
    const ids = asText(raw).split(",").map(s => s.trim()).filter(Boolean);
    if (!ids.every(id => /^\d+$/.test(id))) throw new QueryError("ids deve essere una lista di interi separati da virgola, es. ids=1,6,13");
    return ids.map(Number);
}

/** null = tutti i campi */
function parseFields(raw: unknown, items: Resource[]): string[] | null {
    const text = asText(raw);
    if (text === "*") return null;
    const available = allFields(items);
    const requested = text.split(",").map(s => s.trim()).filter(Boolean);
    const unknown = requested.filter(f => !available.includes(f));
    if (unknown.length) throw new QueryError(`Campi sconosciuti: ${unknown.join(", ")}. Disponibili: ${available.join(", ")}`);
    return [...new Set([...BASE_FIELDS, ...requested])];
}

const pick = (item: Resource, fields: readonly string[] | null): Record<string, unknown> =>
    fields ? Object.fromEntries(fields.filter(f => f in item).map(f => [f, item[f]])) : { ...item };

export function queryList(items: Resource[], query: QueryParams): { items: Record<string, unknown>[]; total: number } {
    const { search, category, ids, fields, sort, order = "asc", page, limit } = query;
    let result = [...items];

    if (ids !== undefined) {
        const wanted = new Set(parseIds(ids));
        result = result.filter(item => wanted.has(item.id));
    }
    if (category) {
        const wanted = asText(category).toLowerCase();
        result = result.filter(item => item.category && item.category.toLowerCase() === wanted);
    }
    if (search) {
        const needle = asText(search).toLowerCase();
        result = result.filter(item => item.title && item.title.toLowerCase().includes(needle));
    }

    // Filtri numerici: <campo>_gte / <campo>_lte (es. price_lte=1500&durationDay_gte=5)
    const numeric = numericFields(items);
    for (const [key, raw] of Object.entries(query)) {
        const match = key.match(/^(.+)_(gte|lte)$/);
        if (!match) continue;
        const [, field = "", op] = match;
        if (!numeric.includes(field)) throw new QueryError(`Filtro non valido: ${key}. Campi numerici: ${numeric.join(", ")}`);
        const value = Number(raw);
        if (Number.isNaN(value)) throw new QueryError(`${key} deve essere un numero`);
        result = result.filter(item => {
            const fieldValue = item[field];
            if (typeof fieldValue !== "number") return false;
            return op === "gte" ? fieldValue >= value : fieldValue <= value;
        });
    }

    if (sort !== undefined) {
        const sortField = asText(sort);
        const available = allFields(items);
        if (!available.includes(sortField)) throw new QueryError(`Ordinamento non valido: ${sortField}. Disponibili: ${available.join(", ")}`);
        if (order !== "asc" && order !== "desc") throw new QueryError("order deve essere asc o desc");
        const dir = order === "desc" ? -1 : 1;
        result.sort((a, b) => {
            const va = a[sortField], vb = b[sortField];
            if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
            return String(va ?? "").localeCompare(String(vb ?? ""), "it") * dir;
        });
    }

    const total = result.length;

    if (page !== undefined || limit !== undefined) {
        const size = Number(limit ?? 10);
        const current = Number(page ?? 1);
        if (!Number.isInteger(size) || size < 1 || size > 100) throw new QueryError("limit deve essere un intero tra 1 e 100");
        if (!Number.isInteger(current) || current < 1) throw new QueryError("page deve essere un intero ≥ 1");
        result = result.slice((current - 1) * size, current * size);
    }

    const projection = fields !== undefined ? parseFields(fields, items) : BASE_FIELDS;
    return { items: result.map(item => pick(item, projection)), total };
}

/** Metadati per costruire filtri e slider senza scaricare tutti i record. */
export function describe(items: Resource[]): ResourceMeta {
    const ranges = Object.fromEntries(numericFields(items).map(field => {
        const values = items.map(i => i[field]).filter((v): v is number => typeof v === "number");
        return [field, { min: Math.min(...values), max: Math.max(...values) }];
    }));
    return {
        count: items.length,
        categories: [...new Set(items.map(i => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "it")),
        ranges,
        fields: allFields(items),
    };
}

/**
 * Record simili: stessa categoria prima, poi i più vicini sui campi numerici
 * (distanza normalizzata sul range di ogni campo, quindi prezzo e giorni pesano uguale).
 */
export function similar(items: Resource[], target: Resource, limit = 3): Resource[] {
    const { ranges } = describe(items);
    const numberOf = (record: Resource, field: string): number => {
        const value = record[field];
        return typeof value === "number" ? value : 0;
    };
    const distance = (item: Resource): number => Object.entries(ranges).reduce((acc, [field, { min, max }]) => {
        const span = max - min || 1;
        return acc + Math.abs(numberOf(item, field) - numberOf(target, field)) / span;
    }, 0);

    return items
        .filter(item => item.id !== target.id)
        .map(item => ({ item, sameCategory: item.category === target.category, distance: distance(item) }))
        .sort((a, b) => (Number(b.sameCategory) - Number(a.sameCategory)) || (a.distance - b.distance))
        .slice(0, limit)
        .map(({ item }) => item);
}
