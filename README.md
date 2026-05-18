# Backend per il Progetto Finale - Comparatore di Records

Questo repository contiene il backend pronto all'uso per il progetto finale del corso. Il backend è progettato per gestire una o più risorse definite dall'utente, fornendo API REST complete per operazioni CRUD.

## 🛠️ Setup

### Installazione

1. Clona il repository:
```bash
git clone https://github.com/boolean-it/progetto-finale-spec-frontend-back.git
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

Per ogni risorsa definita in `types.ts` (es. per il tipo `Product`), sono disponibili i seguenti endpoint API:

### Endpoints

| Metodo | Endpoint            | Descrizione                                | Query Parameters                  |
|--------|---------------------|--------------------------------------------|------------------------------------|
| GET    | `/{tipo}s`          | Lista di tutti i record                    | `search`, `category`               |
| GET    | `/{tipo}s/:id`      | Dettaglio di un singolo record             | -                                  |
| POST   | `/{tipo}s`          | Creazione di un nuovo record              | -                                  |
| PUT    | `/{tipo}s/:id`      | Aggiornamento di un record esistente       | -                                  |
| DELETE | `/{tipo}s/:id`      | Eliminazione di un record                  | -                                  |

### Esempio di uso delle query:
- `/products?search=iphone` - Cerca prodotti con "iphone" nel titolo
- `/products?category=tech` - Filtra prodotti nella categoria "tech"
- `/products?search=iphone&category=tech` - Combina ricerca e filtro

## 💾 Archiviazione dei Dati

I dati vengono salvati in file JSON nella cartella root del progetto. Per ogni tipo definito, viene creato un file corrispondente:

- Per il tipo `Product` → `product.json`
- Per il tipo `Game` → `game.json`
- E così via...

Puoi inserire dati iniziali:
1. Tramite le API (usando Postman, Insomnia o fetch)
2. Modificando direttamente i file JSON

**Importante**: Assicurati di popolare ogni risorsa con almeno 10 record validi per avere dati sufficienti per il frontend.

## 🔄 Generazione Automatica degli Schemi

Quando avvii il server, il file `schema.js` viene generato automaticamente basandosi sui tipi definiti in `types.ts`. Questo schema viene utilizzato per la validazione dei dati inviati alle API.

Non modificare direttamente il file `schema.js` in quanto verrà sovrascritto ad ogni avvio del server.

## 📝 Note Aggiuntive

- Il server utilizza CORS abilitato, quindi può ricevere richieste da qualsiasi origine
- Tutte le risposte sono in formato JSON
- Gli errori vengono restituiti con codici HTTP appropriati e messaggi descrittivi
