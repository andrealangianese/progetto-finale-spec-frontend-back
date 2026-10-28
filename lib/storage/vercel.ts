import { attachDatabasePool } from "@vercel/functions";

type DbPool = Parameters<typeof attachDatabasePool>[0];

// Su Vercel (Fluid compute) mantiene viva l'istanza finché le connessioni inattive
// non vengono chiuse, evitando connessioni "orfane" quando la funzione si sospende.
export function attachPoolOnVercel(pool: DbPool): void {
    if (process.env.VERCEL) attachDatabasePool(pool);
}
