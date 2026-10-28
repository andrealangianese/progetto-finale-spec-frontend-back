// Query di lettura generiche (funzioni pure): filtri, ordinamento, proiezione, paginazione.
// Tutto è opt-in: senza parametri la lista resta quella della traccia (id, title, category, date).

export const BASE_FIELDS = ["id", "createdAt", "updatedAt", "title", "category"];

export class QueryError extends Error {
    constructor(message) {
        super(message);
        this.status = 400;
    }
}

const numericFields = (items) =>
    [...new Set(items.flatMap(item => Object.keys(item).filter(k => typeof item[k] === "number" && k !== "id")))];

const allFields = (items) => [...new Set(items.flatMap(Object.keys))];

function parseIds(raw) {
    const ids = String(raw).split(",").map(s => s.trim()).filter(Boolean);
    if (!ids.every(id => /^\d+$/.test(id))) throw new QueryError("ids deve essere una lista di interi separati da virgola, es. ids=1,6,13");
    return ids.map(Number);
}

function parseFields(raw, items) {
    if (raw === "*") return null; // tutti i campi
    const available = allFields(items);
    const requested = String(raw).split(",").map(s => s.trim()).filter(Boolean);
    const unknown = requested.filter(f => !available.includes(f));
    if (unknown.length) throw new QueryError(`Campi sconosciuti: ${unknown.join(", ")}. Disponibili: ${available.join(", ")}`);
    return [...new Set([...BASE_FIELDS, ...requested])];
}

const pick = (item, fields) => fields ? Object.fromEntries(fields.filter(f => f in item).map(f => [f, item[f]])) : { ...item };

/**
 * @param {object[]} items  record completi
 * @param {object} query    req.query
 * @returns {{ items: object[], total: number }}
 */
export function queryList(items, query) {
    const { search, category, ids, fields, sort, order = "asc", page, limit } = query;
    let result = [...items];

    if (ids !== undefined) {
        const wanted = new Set(parseIds(ids));
        result = result.filter(item => wanted.has(item.id));
    }
    if (category) {
        result = result.filter(item => item.category && item.category.toLowerCase() === String(category).toLowerCase());
    }
    if (search) {
        result = result.filter(item => item.title && item.title.toLowerCase().includes(String(search).toLowerCase()));
    }

    // Filtri numerici: <campo>_gte / <campo>_lte (es. price_lte=1500&durationDay_gte=5)
    const numeric = numericFields(items);
    for (const [key, raw] of Object.entries(query)) {
        const match = key.match(/^(.+)_(gte|lte)$/);
        if (!match) continue;
        const [, field, op] = match;
        if (!numeric.includes(field)) throw new QueryError(`Filtro non valido: ${key}. Campi numerici: ${numeric.join(", ")}`);
        const value = Number(raw);
        if (Number.isNaN(value)) throw new QueryError(`${key} deve essere un numero`);
        result = result.filter(item => op === "gte" ? item[field] >= value : item[field] <= value);
    }

    if (sort !== undefined) {
        const available = allFields(items);
        if (!available.includes(sort)) throw new QueryError(`Ordinamento non valido: ${sort}. Disponibili: ${available.join(", ")}`);
        if (!["asc", "desc"].includes(order)) throw new QueryError("order deve essere asc o desc");
        const dir = order === "desc" ? -1 : 1;
        result.sort((a, b) => {
            const va = a[sort], vb = b[sort];
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
export function describe(items) {
    const ranges = Object.fromEntries(numericFields(items).map(field => {
        const values = items.map(i => i[field]).filter(v => typeof v === "number");
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
export function similar(items, target, limit = 3) {
    const { ranges } = describe(items);
    const distance = (item) => Object.entries(ranges).reduce((acc, [field, { min, max }]) => {
        const span = max - min || 1;
        return acc + Math.abs((item[field] ?? 0) - (target[field] ?? 0)) / span;
    }, 0);

    return items
        .filter(item => item.id !== target.id)
        .map(item => ({ item, sameCategory: item.category === target.category, distance: distance(item) }))
        .sort((a, b) => (b.sameCategory - a.sameCategory) || (a.distance - b.distance))
        .slice(0, limit)
        .map(({ item }) => item);
}
