# Agenti e divisione del lavoro

Il lavoro su questo progetto è diviso fra tre modelli. Ognuno fa solo la sua parte.

| Ruolo | Modello | Agente | Cosa fa |
|---|---|---|---|
| Pianificazione e revisione | Opus | sessione principale | Capisce la richiesta, esplora il codice, scrive il piano, delega, rivede il risultato, risponde all'utente |
| Modifiche al codice | Sonnet | `sonnet-coder` | Implementa il piano: scrive e modifica codice, verifica i tipi e prova le modifiche |
| Operazioni semplici | Haiku | `haiku-ops` | Esegue comandi da terminale: typecheck, build, deploy Docker, log, stato dei servizi |

Le definizioni degli agenti sono in `.claude/agents/`.

## Flusso di lavoro

1. **Opus pianifica.** Legge il codice coinvolto e, se serve, verifica dati e API esterne. Poi scrive un piano che Sonnet possa eseguire senza rifare l'esplorazione:
   - file e funzioni da toccare;
   - comportamento atteso e casi limite;
   - come verificare.
2. **Sonnet implementa** il piano e lo verifica: `npm run typecheck`, e prove mirate su copie dei dati. Riporta i file modificati e l'esito delle prove.
3. **Opus rivede** le modifiche. Legge i file toccati e controlla correttezza, coerenza con lo stile del progetto e casi limite. Se trova problemi, li rimanda a Sonnet con istruzioni precise; correzioni di una riga può farle direttamente.
4. **Haiku esegue** le operazioni finali richieste: build, deploy, riavvio del container, lettura dei log. Riporta l'output senza interpretarlo né correggere errori.
5. **Opus risponde all'utente**: cosa è cambiato, cosa è stato verificato e cosa no.

Per domande, analisi o modifiche minime (una o due righe) Opus può lavorare da solo: delegare costa più del lavoro stesso.

## Regole comuni

- **I dati reali non si toccano nelle prove.** `data/` (indice, impostazioni) e `library/` (EPUB e `book.json` dell'utente) sono la libreria vera. Per i test si usa una copia in una cartella temporanea, avviando il server con `DATA_DIR` puntato alla copia e `libraryRoot` della copia puntato a una libreria di prova.
- **Il server dell'utente può essere già in esecuzione** sulla porta 8787 (`tsx watch`, si ricarica da solo) e Vite sulla 5173. Non vanno fermati: per le prove si usa un'altra porta (`PORT=88xx`).
- **Chiavi API**: la chiave Google Books è in `data/settings.json`. Non va mai stampata nei log né nelle risposte. Google Books ha una quota di 1000 richieste al giorno: niente test a raffica.
- **Lingua**: interfaccia, messaggi d'errore, commenti nel codice e risposte all'utente sono in italiano.
- **Revisione**: si parte da `git diff` e si leggono per intero i file modificati che Sonnet elenca.

## Comandi del progetto

| Operazione | Comando |
|---|---|
| Controllo tipi (server + web) | `npm run typecheck` |
| Build completa | `npm run build` |
| Build solo server | `npm run build --workspace server` |
| Sviluppo (server + web) | `npm run dev` |
| Server di prova su una copia dei dati | `cd server && DATA_DIR=<copia>/data PORT=8812 HOST=127.0.0.1 npx tsx src/index.ts` |
| Script TypeScript di prova | `npx --workspace server tsx <file>.mts` |
| Deploy Docker | `docker compose up -d --build` |
| Log del container | `docker compose logs --tail=100 libreria` |

## Struttura

- `server/src/`: API Fastify (`routes.ts`), libreria (`library.ts`), provider dei metadati (`providers/`), lettura dei file (`metadata/`), import EFP (`efp.ts`, `efpHtml.ts`).
- `web/src/`: interfaccia React + Zustand (`store.ts`, `components/`).
- `shared/types.ts`: tipi condivisi fra server e web.
