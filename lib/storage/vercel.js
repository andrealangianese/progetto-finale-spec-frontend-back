import { attachDatabasePool } from "@vercel/functions";

// Su Vercel (Fluid compute) mantiene viva l'istanza finché le connessioni inattive
// non vengono chiuse, evitando connessioni "orfane" quando la funzione si sospende.
export function attachPoolOnVercel(pool) {
    if (process.env.VERCEL) attachDatabasePool(pool);
}
