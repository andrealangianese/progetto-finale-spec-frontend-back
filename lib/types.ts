// Tipi condivisi dal server e dagli adapter di storage.

/** Record di una risorsa (es. un viaggio): campi base garantiti + campi specifici del tipo. */
export type Resource = {
    id: number;
    createdAt: string;
    updatedAt: string;
    title: string;
    category: string;
    [field: string]: unknown;
};

/** Modifica da persistere: gli adapter a righe/documenti la usano, il file store riscrive l'array. */
export type Change =
    | { op: "insert"; item: Resource }
    | { op: "update"; item: Resource }
    | { op: "delete"; id: number };

export interface Store {
    readonly name: "file" | "postgres" | "mongodb";
    /** Ogni quanto ricaricare la cache (0 = mai: la cache in memoria è la verità). */
    readonly refreshTtlMs: number;
    /** Dati grezzi: la validazione la fa il server. */
    load(type: string): Promise<unknown>;
    persist(type: string, change: Change, items: Resource[]): Promise<void>;
    close?(): Promise<void>;
}

/** Store con connessioni da chiudere (database): close è garantito. */
export type ClosableStore = Store & { close(): Promise<void> };
