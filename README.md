# LangiaRoad — Backend

API REST di LangiaRoad, il comparatore di viaggi d'avventura. Nato dal template del progetto finale Boolean ed esteso con sicurezza, storage persistente, query avanzate e test.

Frontend: [progetto-finale-spec-frontend-front](https://github.com/andrealangianese/progetto-finale-spec-frontend-front).

## 🛠️ Setup

### Installazione

1. Clona il repository:
```bash
git clone https://github.com/andrealangianese/progetto-finale-spec-frontend-back.git
cd progetto-finale-spec-frontend-back
```

2. Installa le dipendenze:
```bash
npm install
```

## 🔧 Configurazione delle Risorse

Il backend si basa sulle risorse definite nel file `types.ts`. Per configurare le tue risorse:

1. Nella cartella principale del progetto, crea un file `types.ts` con la definizione dei tipi delle tue risorse

Esempio:
```typescript
export type Product = {
  title: string;
  category: string;
  // Aggiungi altre proprietà personalizzate...
};
```

**Note importanti:**
- Ogni risorsa DEVE includere almeno le proprietà base `title` e `category`
- Le proprietà `id`, `createdAt` e `updatedAt` vengono aggiunte in automatico dal server
- Puoi aggiungere tutte le proprietà aggiuntive che desideri
- Le proprietà `readonly` che definisci possono venire salvate solo in creazione, ma non in update
- Il nome del tipo (es. `Product`) determinerà il nome dell'endpoint API (es. `/products`)

## 🚀 Avvio del Server

Per avviare il server:

```bash
npm run start
```

Il server sarà disponibile all'indirizzo: **http://localhost:3001**

## 📊 API Disponibili

Per ogni risorsa definita in `types.ts` (qui `Travel` → `/travels`):

| Metodo | Endpoint | Descrizione | Auth |
|---|---|---|---|
| GET | `/travels` | Lista (id, title, category, date) | – |
| GET | `/travels/meta` | Categorie, range min/max dei campi numerici, campi disponibili | – |
| GET | `/travels/:id` | Dettaglio completo | – |
| GET | `/travels/:id/similar?limit=3` | Viaggi simili: stessa categoria, poi valori più vicini | – |
| POST | `/travels` | Creazione | 🔑 |
| PUT | `/travels/:id` | Aggiornamento parziale | 🔑 |
| DELETE | `/travels/:id` | Eliminazione | 🔑 |
| GET | `/health` | Stato, storage in uso, uptime, numero di record | – |

### Query su `GET /travels`

Senza parametri la risposta è quella originale della traccia. Tutti i parametri sono opzionali e combinabili:

| Parametro | Esempio | Effetto |
|---|---|---|
| `search` | `?search=surf` | Titolo contiene (case insensitive) |
| `category` | `?category=Trekking` | Categoria esatta (case insensitive) |
| `ids` | `?ids=1,6,13` | Solo questi record: un'unica chiamata per il comparatore |
| `fields` | `?fields=price,durationDay` · `?fields=*` | Aggiunge campi ai campi base, oppure li include tutti |
| `<campo>_gte` / `<campo>_lte` | `?price_lte=1500&durationDay_gte=5` | Filtri numerici |
| `sort`, `order` | `?sort=price&order=desc` | Ordinamento (numerico o alfabetico) |
| `page`, `limit` | `?page=2&limit=10` | Paginazione; totale nell'header `X-Total-Count` |

Parametri non validi → `400` con l'elenco dei valori ammessi.

## 🔐 Sicurezza

- **Scritture protette**: POST/PUT/DELETE richiedono `ADMIN_API_KEY`, inviata come `Authorization: Bearer <chiave>` o `X-API-Key: <chiave>`. Se la chiave non è configurata, in produzione le scritture rispondono `503`; in locale restano aperte, con un avviso nel log.
- **Rate limit** per IP: 300 letture/minuto e 30 scritture ogni 15 minuti. Il limite sulle scritture scatta prima dell'autenticazione, quindi frena anche chi prova a indovinare la chiave. Lo stato è in memoria, quindi il limite vale per singola istanza.
- **CORS**: whitelist tramite `ALLOWED_ORIGINS`; se non è impostata, chiunque può leggere ma senza credenziali.
- **Header di sicurezza** con helmet, body JSON massimo 100kb, errori interni senza dettagli in produzione.

## 💾 Archiviazione dei Dati

| Modalità | Quando | Note |
|---|---|---|
| File JSON | `DATABASE_URL` non impostata | `database/<tipo>.json`. Su Vercel finisce in `/tmp`, che si azzera a ogni cold start |
| Postgres | `DATABASE_URL` impostata | Persistente. Tabelle create e dati iniziali caricati automaticamente al primo avvio |

Con Postgres ogni istanza serverless ricarica la propria cache al massimo ogni `CACHE_TTL_MS` (default 10s). Funziona con qualsiasi Postgres: Neon, Supabase, Vercel Postgres.

## ⚙️ Configurazione

Copia `.env.example` e imposta le variabili. In produzione su Vercel vanno in *Project → Settings → Environment Variables*:

| Variabile | Obbligatoria | Descrizione |
|---|---|---|
| `ADMIN_API_KEY` | in produzione, per scrivere | Chiave per le scritture |
| `DATABASE_URL` | consigliata in produzione | Connessione Postgres |
| `ALLOWED_ORIGINS` | consigliata | Domini del frontend, separati da virgola |
| `CACHE_TTL_MS`, `RATE_LIMIT_READ`, `RATE_LIMIT_WRITE` | no | Tuning |

## 🧪 Test

```bash
npm test                                                             # storage su file
TEST_DATABASE_URL=postgresql://user@localhost:5432/postgres npm test # anche su Postgres reale
```

Test di integrazione con `node:test` e supertest su API, sicurezza, rate limit, query e storage. Con `TEST_DATABASE_URL` ogni file di test gira su un database creato al momento.

## 🔄 Generazione Automatica degli Schemi

Quando avvii il server, il file `schema.js` viene generato automaticamente basandosi sui tipi definiti in `types.ts`. Questo schema viene utilizzato per la validazione dei dati inviati alle API.

Non modificare direttamente il file `schema.js` in quanto verrà sovrascritto ad ogni avvio del server.

## 📝 Note Aggiuntive

- Tutte le risposte sono in formato JSON, errori compresi, con `success: false`
- Gli errori vengono restituiti con codici HTTP appropriati e messaggi descrittivi
