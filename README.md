# Libreria — ebook & fanfiction

Applicazione web per gestire una libreria personale di **ebook** e **fanfiction**:
legge i metadati direttamente dai file, ti permette di correggerli a mano, cerca
le informazioni mancanti online, gestisce le copertine e organizza tutto con
ricerca, filtri e ordinamento.

Funziona in locale sul computer e si installa sul tuo server senza modifiche
(è una web app: frontend React + backend Node, un unico processo).

---

## Funzionalità

| | |
|---|---|
| **Metadati automatici** | Titolo, sottotitolo, autore/i, serie, editore, data, lingua, ISBN, descrizione, copertina, numero di parole, capitoli e pagine vengono letti dal file EPUB/PDF/DOCX/TXT. |
| **Formati supportati** | EPUB, PDF, DOCX, TXT, MD e RTF si importano così come sono. MOBI, PRC, AZW, AZW3, FB2 e DJVU vengono **convertiti da soli** all'import: in EPUB con Calibre (`ebook-convert`), mentre un DJVU di sole scansioni diventa un PDF (djvulibre, `ddjvu`). Il file originale resta nella cartella del libro e si scarica dal menu di download (per esempio «MOBI originale»). Un file con DRM non si converte. Calibre e djvulibre sono nell'immagine Docker; fuori da Docker vanno installati (`ebook-convert` viene trovato anche nell'app calibre del Mac). Variabile `CONVERT_TIMEOUT_SEC` (default 600). |
| **Metadati online** | Ricerca su Google Books e Open Library, con anteprima delle differenze e conferma esplicita prima di applicare. Puoi anche incollare il link di una specifica edizione Google Books per caricarne i dati esatti (utile se la ricerca non la trova o manca la descrizione). Per le fanfic con link in chiaro viene letta anche la pagina originale (AO3 / FanFiction.net); puoi incollare il link AO3 anche a mano. Se AO3 non risponde, restano validi i metadati letti dall'EPUB. |
| **Compilazione automatica** | Opzione «Compila in automatico»: all'importazione i campi vuoti vengono completati online da soli, solo se il risultato combacia chiaramente con titolo e autore. |
| **Fanfic** | Riconosce automaticamente il tipo di opera e ne estrae fandom, ship, personaggi, rating, stato, capitoli, parole, tag e serie dalle tabelle «Info» tipiche degli epub. Con il link AO3, la finestra **Serie** elenca anche le opere mancanti della serie. |
| **EFP Fanfiction** | Incolla il link di una storia di `efpfanfic.net`: scarica tutti i capitoli e la importa come EPUB + ODT, con titolo, autore, fandom, tag, personaggi, rating, stato, capitoli e parole. Reimportare la stessa storia aggiorna la scheda esistente. |
| **Nuovi capitoli** | Ogni notte l'app controlla su AO3 ed EFP se le fanfiction in corso hanno nuovi capitoli o sono state completate (anche a mano, da Impostazioni → Fanfiction). Avvisa soltanto: la card mostra «+N cap.» o «Completata», la sidebar il filtro «Aggiornamenti», e dalla scheda «Aggiorna storia» scarica di nuovo la storia (voto, stato di lettura e sottolineature restano; l'EPUB AO3 precedente va in `.backup/`). FanFiction.net è escluso. |
| **Jellyfin** | Jellyfin legge la stessa cartella dei libri; l'app gli invia titolo, autori, descrizione, generi, tag, serie e copertina di ogni scheda e nasconde i file secondari. Vedi la sezione «Jellyfin». |
| **Sottolineature Apple Books** | Importa evidenziazioni e note dal database locale di Libri (macOS), le abbina ai libri per titolo/autore e le mostra nella scheda **Sottolineature**, con ricerca ed export Markdown. |
| **Lettore integrato** | Il pulsante **Leggi** nella scheda apre EPUB e PDF a tutto schermo, dal sito (anche su iPhone) e dall'app Mac. EPUB: pagine, indice, dimensione del testo e temi chiaro/seppia/scuro; PDF: zoom e salto a una pagina. La posizione si salva sul server e si riprende da qualunque dispositivo, e l'avanzamento aggiorna la barra nella scheda; con Apple Books vince l'aggiornamento più recente. Gli script contenuti negli EPUB non vengono mai eseguiti. |
| **Copertine** | Estrazione automatica dall'epub, caricamento (drag & drop), download da URL, rimozione. |
| **Editor Penguin** | Generatore di copertine in stile Penguin Classics per le fanfiction: quattro impaginazioni, palette, caratteri, marchio, anteprima dal vivo ed export PNG/JPG ad alta risoluzione. |
| **Ordinamento** | Per titolo, autore, serie, lunghezza (parole/pagine), voto, fandom, data di aggiunta, pubblicazione, ultima lettura — in aumento o diminuzione. |
| **Filtri e ricerca** | Testo libero su tutto (titolo, autore, fandom, tag, descrizione…) più facet per tipo, formato, autore, serie, fandom, tag e stato di lettura. |
| **Vista griglia / elenco** | Con copertina, voto personale, preferiti e indicatori di stato. |
| **Note personali** | Voto, preferito, stato di lettura, tag e note libere per ogni opera. |

---

## Avvio rapido con Docker

Il modo piu' semplice per provare l'app o usarla su un server.

**Requisiti**: Docker con il plugin Compose (`docker compose version`).

```bash
git clone https://github.com/beartice/books-editor.git
cd books-editor
cp .env.example .env
mkdir -p data library
```

**Solo su Linux**: il container gira come utente con uid 1000. Se le cartelle
non esistono Docker le crea come root e l'app non riesce a scriverci, quindi
assegnale a quell'utente. Su Docker Desktop (Mac/Windows) non serve.

```bash
sudo chown -R 1000:1000 data library
```

Poi costruisci e avvia:

```bash
docker compose up -d --build
```

1. **Primo accesso.** Apri <http://localhost:8787>: al primo avvio compare la
   pagina «Crea il tuo account». Con Docker il **codice di configurazione**
   serve sempre, anche dalla stessa macchina, perche' le richieste arrivano
   dalla rete interna di Docker e non da `127.0.0.1`. Lo trovi nei log, nel
   riquadro «CONFIGURAZIONE INIZIALE»:

   ```bash
   docker compose logs libreria | grep -i "codice"
   # oppure (su Linux con sudo: il file e' dell'uid 1000)
   cat data/.setup-code
   ```

2. **Cartelle.** In Docker la libreria e' fissa: `/app/library` nel container
   (per questo il campo della cartella nella pagina di creazione dell'account
   e' in sola lettura). Sull'host la scegli con `LIBRARY_PATH` nel `.env`
   (default `./library`); `DATA_PATH` (default `./data`) sposta indice e
   impostazioni. Le cartelle scelte devono appartenere all'uid 1000.

3. **Accesso da altri dispositivi.** Di default l'app ascolta solo su
   `127.0.0.1` (`BIND_ADDRESS`). Per raggiungerla dalla rete locale imposta nel
   `.env` `BIND_ADDRESS=0.0.0.0` (oppure l'IP del server) e riavvia con
   `docker compose up -d`. Per l'accesso da internet usa un reverse proxy con
   HTTPS: vedi [Pubblicazione su server](#pubblicazione-su-server-docker--nginx)
   e l'esempio [`deploy/nginx/books-editor.conf.example`](deploy/nginx/books-editor.conf.example).

4. **Aggiornare.** I dati in `data/` e `library/` restano.

   ```bash
   git pull && docker compose up -d --build
   ```

5. **Comandi utili.**

   ```bash
   docker compose logs --tail=100 libreria   # log
   docker compose down                       # ferma l'app (non cancella i dati)
   tar czf backup-libreria.tgz data library  # backup delle due cartelle
   ```

---

## Avvio locale per sviluppo

```bash
npm install          # installa server + web
npm run dev          # server su :8787, interfaccia su :5173
```

Apri <http://localhost:5173>.

Per l'uso quotidiano in locale conviene compilare e servire tutto da un solo processo:

```bash
npm run build
npm start            # http://localhost:8787
```

La libreria si trova in `./library` (configurabile) e l'indice in `./data`.

### Dati di prova

```bash
node scripts/make-samples.mjs library   # genera 2 epub di esempio
```

---

## Come è organizzata la libreria

Una cartella per opera, con i metadati in `book.json` accanto al file:

```
library/
└── Elena Ferri - La notte dei cento gatti/
    ├── La notte dei cento gatti.epub
    ├── book.json        ← metadati (titolo, autori, fandom, coverFile, …)
    └── cover.png        ← copertina (se presente)
```

`book.json` è la **fonte di verità**: l'indice in `data/index.json` è solo una cache
e può essere ricostruito in qualsiasi momento con «Scansiona» (o cancellando
`data/index.json` e riavviando il server).

Punti di forza di questo formato:

- i file restano leggibili con qualsiasi altro programma;
- puoi sincronizzare la libreria con Syncthing, rsync, git, Dropbox…;
- per spostare un libro basta spostare la cartella;
- i metadati editati a mano non vengono sovrascritti dalle scansioni.

### Importazione

- **Da browser**: trascina il file nella finestra «Importa» (il file viene caricato
  sul server e messo nella sua cartella).
- **Da EFP Fanfiction**: incolla il link di una storia `efpfanfic.net` nella
  finestra «Importa» e premi **Importa nella libreria**; **Scarica ODT** salva
  soltanto il documento OpenDocument sul computer.
- **Da percorso**: incolla il percorso assoluto **sul server** (utile per il deployment).
- **Dalla cartella**: metti i file sciolti dentro `library/` e premi «Scansiona»:
  vengono spostati automaticamente nella cartella dell'opera.
- **Cartelle pronte**: se crei tu `library/Autore - Titolo/opera.epub`, la scansione
  la rileva e la cataloga.

### Librerie multiple

Nello stesso account puoi tenere piu' librerie separate (per esempio «Libri» e
«Fanfiction»), ognuna con i suoi libri, l'indice, la cache delle serie, le
statistiche e il nome. Si creano dalla barra laterale («Nuova libreria»), dove
si possono anche rinominare ed eliminare (solo se vuote). Restano in comune
l'account, le chiavi API (Google Books), Jellyfin e le altre impostazioni.

- La **libreria principale** e' quella di sempre (`LIBRARY_ROOT`, `data/index.json`):
  nessuna migrazione.
- Le **librerie aggiuntive** stanno ognuna in una sottocartella di `LIBRARIES_ROOT`
  (default `librerie/`); indice e cache in `data/libraries/<id>/`. L'elenco e'
  in `data/libraries.json`.
- La libreria aperta e' per scheda o dispositivo: sta nell'URL (`?lib=<id>`) e
  in `localStorage` come ultima usata.
- Dalla scheda di un libro, **Sposta in…** lo sposta (non lo copia) in
  un'altra libreria. Fra volumi diversi (come in Docker) la cartella viene
  copiata, verificata (file, dimensioni, sha256) e solo dopo cancellata dall'origine.
- `LIBRARIES_ROOT` non deve coincidere con `LIBRARY_ROOT` o `DATA_DIR`, ne'
  contenerli o stare al loro interno.

Con Docker la cartella sull'host si sceglie con `LIBRARIES_PATH` nel `.env`
(default `./librerie`, montata in `/app/libraries`); come le altre, deve
appartenere all'uid 1000. Includila anche nel backup.

### Jellyfin

Jellyfin e books-editor condividono **una sola cartella**: Jellyfin legge
direttamente le cartelle delle librerie (tutte, fanfiction comprese), books-editor
e' l'unico a scrivere i file e **invia a Jellyfin i metadati arricchiti**. Non c'e'
piu' un import da Jellyfin che copia i file.

1. In Jellyfin crea (o punta) una libreria di tipo **Libri** sulla cartella che
   contiene le librerie di books-editor (`LIBRARY_PATH` e `LIBRARIES_PATH`; con
   Docker, i due volumi sull'host). Montala in **sola lettura** per Jellyfin e, nelle
   opzioni della libreria, lascia spenti il salvataggio dei metadati e delle immagini
   nelle cartelle dei media: scrive books-editor, non Jellyfin.
2. In **Impostazioni → Jellyfin** inserisci indirizzo e chiave API (Jellyfin:
   Dashboard → Chiavi API, con i permessi di amministratore), salva, poi scegli la
   **Libreria Jellyfin dei libri**.
3. Se Jellyfin vede la cartella con un percorso diverso da quello dell'app (sempre
   cosi' con Docker), imposta `JELLYFIN_PATH_MAP`: coppie
   `percorso visto da Jellyfin=percorso dell'app` separate da `;`, il prefisso piu'
   lungo vince. Per esempio, con le cartelle sull'host in `/srv/books-editor`:

   ```
   JELLYFIN_PATH_MAP="/srv/books-editor/library=/app/library;/srv/books-editor/librerie=/app/libraries"
   ```

   Senza mappatura i percorsi devono coincidere. Gli elementi di Jellyfin che non
   corrispondono a nessuna scheda (per esempio vecchi file fuori dalla cartella) si
   vedono nell'elenco «Elementi Jellyfin senza scheda» delle Impostazioni.

**Abbinamento.** Ogni elemento di Jellyfin ha il percorso del suo file: con la
mappatura diventa il file di una scheda (principale o edizione in un'altra lingua),
in qualunque libreria. L'id Jellyfin si salva nella scheda (`identifiers.jellyfin`,
piu' id separati da virgola) con lo stato dell'ultimo invio (`jellyfinSync`).

**Cosa si invia** (`GET /Items/{id}` per leggere l'elemento, poi `POST /Items/{id}`):
titolo, descrizione in testo, autori
(tipo `Author`), generi (quelli normalizzati dai tag), tag (per le fanfiction anche
«Fanfiction» e il fandom), data di uscita, serie e numero del volume (solo numeri
interi) e, con `POST /Items/{id}/Images/Primary`, la copertina, rimandata solo se
cambia. Gli elementi vengono bloccati (`LockData`): «Aggiorna metadati» di Jellyfin non
li sovrascrive. Un campo vuoto nella scheda lascia quello che Jellyfin ha gia'. Verso
Jellyfin non si cancella mai nulla.

**Quando.** Pochi secondi dopo ogni modifica di una scheda (modifica a mano, metadati
online, copertina, import); per i libri nuovi, che Jellyfin vede solo dopo una sua
scansione, qualche minuto dopo l'import l'app chiede a Jellyfin di aggiornare **solo**
la libreria scelta (al massimo ogni 10 minuti, senza sostituire metadati) e poi
riprova l'abbinamento; ogni `JELLYFIN_SYNC_MINUTES` minuti (default 30; `0` = spento)
abbina i nuovi elementi e invia le schede modificate. **Impostazioni → Aggiorna
Jellyfin ora** fa lo stesso subito su tutte le schede (**Reinvia tutto** anche sulle
invariate); dalla scheda di un libro, **Invia a Jellyfin** lo fa per quel libro. Con
«Invia automaticamente i metadati» spento l'invio parte solo a mano.

**File secondari nascosti.** Jellyfin tratta come libri solo `.epub`, `.pdf`, `.mobi`,
`.azw`, `.azw3` e i fumetti `.cbz`/`.cbr`/`.cb7`/`.cbt`: ODT, DOCX, TXT e simili non
compaiono. Gli altri file che compaiono (l'originale MOBI/AZW3 di un libro convertito
e i file extra) li nasconde un file `.ignore` che l'app scrive nella cartella del libro,
con i soli nomi di quei file, e che aggiorna quando la scheda cambia (si cancella se
non serve). Il file principale e i file delle altre lingue non sono mai esclusi: le
edizioni in un'altra lingua restano visibili in Jellyfin, ciascuna col proprio
titolo. Un `.ignore` scritto a mano (senza la riga «Generato da books-editor») non si
tocca. Le cartelle `.backup/` sono nascoste da Jellyfin perche' iniziano con un punto.

---

## Deployment sul tuo server

Il progetto include un `Dockerfile` e un `docker-compose.yml`. Per una
pubblicazione completa con HTTPS vedi la sezione successiva.

```bash
cp .env.example .env      # facoltativo: SESSION_SECRET (l'account si crea dall'interfaccia)
docker compose up -d --build
```

La libreria resta in `./library` (montata in `/app/library`), l'indice in `./data`.
Il container ascolta solo su `127.0.0.1:8787`: serve un reverse proxy per l'accesso
dall'esterno.

### Senza Docker

```bash
npm ci
npm run build
NODE_ENV=production LIBRARY_ROOT=/srv/libreria DATA_DIR=/srv/libreria-data npm start
```

Al primo avvio apri l'app nel browser e crea l'account (vedi «Autenticazione»).

### Autenticazione

L'app usa un login con sessione (cookie `HttpOnly`, `SameSite=Strict`, `Secure`
su HTTPS). **Non servono variabili d'ambiente**: al primo avvio, finche' non
esiste un account, l'interfaccia mostra la pagina «Crea il tuo account» e tutte
le API (tranne `/api/health` e quelle di accesso) rispondono 403. L'app non e'
mai aperta senza account.

- **Codice di configurazione.** All'avvio senza account il server genera un
  codice (`XXXX-XXXX-XXXX`), lo stampa nei log in un riquadro e lo salva in
  `data/.setup-code` (permessi 600). Chi apre l'app da `localhost`, senza proxy,
  non lo deve inserire; da qualunque altra rete (o dietro nginx) la pagina lo
  chiede, cosi' nessuno puo' registrarsi al posto tuo su un server appena
  pubblicato. Lo trovi con `docker compose logs libreria` oppure
  `cat data/.setup-code`. Dopo la creazione dell'account il file viene cancellato.
- **Dove sono le credenziali.** In `data/auth.json` (permessi 600): solo il nome
  utente e l'hash scrypt della password. Da **Impostazioni → Account** puoi
  cambiare la password: le altre sessioni vengono chiuse.
- **Alternativa facoltativa: variabili d'ambiente.** Con `AUTH_USER` e
  `AUTH_PASS_HASH` (hash generato con `hash-password`) le credenziali sono
  fissate dal server, hanno la precedenza su `auth.json` e non si cambiano
  dall'interfaccia. `AUTH_PASS` in chiaro e' deprecata. `AUTH_DISABLED=1`
  (sconsigliato) avvia l'app aperta, ma solo se non c'e' nessun account.
- **Password dimenticata.** Ferma l'app, cancella `data/auth.json` (nel container:
  `rm data/auth.json` sul volume) e riavviala: torna la modalita' di
  configurazione, con un codice nuovo nei log. La libreria non viene toccata.

---

## Pubblicazione su server (Docker + nginx)

Guida passo passo per pubblicare l'app su `https://books.example.com`
(sostituisci il dominio con il tuo) con Docker Compose (app) e nginx sull'host
(reverse proxy + TLS con certbot).

### 1. Requisiti

- Server Linux con Docker e **Docker Compose v2**, **nginx** e **certbot**
  (`python3-certbot-nginx`).
- Porte **80 e 443** aperte sul server o inoltrate dal router verso di esso.
- Un dominio che punti all'IP pubblico del server. Se l'IP cambia (connessione
  domestica), l'aggiornamento va automatizzato con un servizio di DNS dinamico
  (cron o container dedicato, secondo il provider).

### 2. Copia del progetto sul server

```bash
git clone <repo> /opt/books-editor      # oppure: rsync -av --exclude node_modules --exclude data --exclude library ./ server:/opt/books-editor/
cd /opt/books-editor
```

### 3. Migrazione di una libreria esistente

Se hai gia' una libreria (per esempio un'installazione locale), dalla macchina
di origine, nella cartella del progetto:

```bash
rsync -av data/    utente@server:/opt/books-editor/data/
rsync -av library/ utente@server:/opt/books-editor/library/
```

Poi sul server, perche' l'utente del container (uid 1000) possa scriverci:

```bash
sudo chown -R 1000:1000 /opt/books-editor/data /opt/books-editor/library
```

Il `libraryRoot` salvato in `data/settings.json` e' il percorso della macchina di origine: nel
container viene **ignorato** grazie a `LIBRARY_ROOT=/app/library`. La chiave
Google Books e quella di Jellyfin restano in `data/settings.json` e
continuano a funzionare. Dopo la migrazione, se qualcosa non torna, riesegui la
scansione della libreria dall'interfaccia.

### 4. File `.env`

```bash
cp .env.example .env && chmod 600 .env
openssl rand -hex 32     # valore per SESSION_SECRET (facoltativo)
```

Imposta in `.env` (facoltativo, altrimenti il segreto e' generato in `data/.session-secret`):

```bash
SESSION_SECRET=<output di openssl rand -hex 32>
```

L'**account non si imposta nel `.env`**: lo crei dall'interfaccia al primo
avvio (passo 5). Se preferisci gestire le credenziali da variabili d'ambiente,
e' possibile: genera un hash e impostalo con `AUTH_USER` e `AUTH_PASS_HASH`.

```bash
printf '%s' 'la-tua-password' | docker compose run --rm -T libreria \
  node server/dist/server/src/tools/hash-password.js     # stampa AUTH_PASS_HASH=...
# in .env:  AUTH_USER=tuo-utente
#           AUTH_PASS_HASH='scrypt$16384$8$1$...$...'
```

**Attenzione ai `$` (solo per `AUTH_PASS_HASH`)**: l'hash ne contiene molti e Docker Compose li interpreta
come variabili. Verificato con Compose v2: sia nel `.env` sia in un `env_file`
l'interpolazione avviene (un `$salt` non quotato diventa una stringa vuota).
La soluzione e' racchiudere il valore tra **apici singoli**, che lo rendono
letterale; in alternativa raddoppia ogni `$` (`$$`) senza apici. Per controllare:
`docker compose config | grep AUTH_PASS_HASH` mostra il valore con i `$`
raddoppiati (e' solo la visualizzazione di `config`: nel container arriva con
un `$` singolo).

### 5. Avvio dell'app

```bash
docker compose up -d --build
docker compose logs --tail=100 libreria
curl -s http://127.0.0.1:8787/api/health
```

**Primo accesso**: cerca nei log il riquadro «CONFIGURAZIONE INIZIALE» (oppure
`cat data/.setup-code`), apri l'indirizzo pubblico e crea l'account inserendo il
codice. Se imposti le credenziali da env, questo passo non serve.

Prima di pubblicare puoi provare l'immagine con `deploy/smoke-test.sh
/tmp/prova-libreria` (usa dati temporanei sulla porta 18787).

### 6. nginx

```bash
sudo cp deploy/nginx/books-editor-ratelimit.conf /etc/nginx/conf.d/
sudo cp deploy/nginx/books-editor.conf.example /etc/nginx/conf.d/books-editor.conf    # oppure sites-available + link in sites-enabled
# poi sostituisci books.example.com con il tuo dominio nel file copiato
sudo mkdir -p /var/www/certbot
```

Il vhost HTTPS richiede i certificati, che alla prima installazione non
esistono ancora: `nginx -t` fallirebbe. Ottieni quindi prima il certificato
(passo 7) e solo dopo carica il vhost completo. Poi:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 7. Certificato Let's Encrypt

La configurazione e' pensata per il metodo **webroot** (`/var/www/certbot`).
Alla prima emissione tieni attivo solo il blocco della porta 80 (commenta
temporaneamente il blocco `listen 443`), poi:

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d books.example.com
```

Ripristina il blocco 443 e ricarica nginx (`nginx -t && systemctl reload nginx`).
Il rinnovo automatico (timer di certbot) usa lo stesso webroot; prova con
`sudo certbot renew --dry-run`, e aggiungi un hook di reload se serve:
`--deploy-hook "systemctl reload nginx"`.

Alternativa: `sudo certbot --nginx -d books.example.com` con un vhost
minimo sulla porta 80; certbot modifica la configurazione da solo, ma poi
confronta il risultato con `deploy/nginx/books-editor.conf.example`.

### 8. Firewall

Apri solo 80 e 443; la 8787 e' gia' legata a `127.0.0.1` (default) e non va esposta.

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
```

Nota: Docker pubblica le porte aggirando `ufw`; per questo il compose usa
`127.0.0.1:8787`.

### Dietro un reverse proxy esistente su un'altra macchina

Se nginx gira su un'altra macchina (ad esempio un container proxy dedicato) e
inoltra a questo server, imposta nel `.env`:

- `BIND_ADDRESS`: l'IP LAN del server dell'app (es. `192.168.1.10`), invece del
  default `127.0.0.1`, cosi' il proxy puo' raggiungere la porta 8787. Proteggi
  la porta con il firewall se la LAN non e' fidata: l'app e' comunque protetta
  dal login.
- `TRUST_PROXY`: l'IP del proxy (es. `192.168.1.20`). Non usare `uniquelocal`:
  qualunque dispositivo della LAN potrebbe falsificare `X-Forwarded-For` e
  aggirare il limite ai tentativi di login.
- `LIBRARY_PATH` (e, se serve, `DATA_PATH`): cartelle dei volumi, ad esempio un
  disco dedicato (es. `/mnt/dati/books-editor/library`); devono appartenere
  all'uid 1000.

Il sito nginx da installare sul proxy e' `deploy/nginx/books-editor.conf.example`,
nella variante «app su un'altra macchina» descritta nel commento in testa al
file (con `books-editor-ratelimit.conf` in `conf.d/`).

### 9. Aggiornamenti

```bash
cd /opt/books-editor
git pull          # oppure copia i nuovi file con rsync
docker compose up -d --build
docker image prune -f
```

### 10. Backup

Salva `data/`, `library/` e `librerie/` (vedi la sezione Backup piu' sotto), per esempio con
un `rsync` o `tar` periodico in cron verso un altro disco o un altro host. Il
file `.env` va conservato a parte (contiene l'hash e il segreto di sessione).

### 11. Sicurezza

Cosa fa l'app: login con sessione firmata e cookie `HttpOnly`/`SameSite=Strict`/
`Secure`; limite dei tentativi di login per IP (applicativo, e in nginx con
`limit_req`); controllo CSRF su Origin/Host; Content-Security-Policy e altre
intestazioni di sicurezza; protezione SSRF sulle richieste verso URL esterni;
«Importa da percorso» disattivato salvo `IMPORT_ROOTS`, e limitato a quelle
cartelle. Il container gira come utente non root, con file system in sola
lettura, senza capability.

Cosa resta a te: una password robusta, gli aggiornamenti di sistema, di Docker
e dell'immagine (`docker compose up -d --build` ricostruisce da `node:22-trixie-slim`),
il rinnovo del certificato e, facoltativamente, **fail2ban** sui log di nginx.

Jellyfin: dal server deve essere raggiungibile all'indirizzo salvato nelle
impostazioni (per esempio l'IP di rete locale, non `localhost` del computer da cui lo apri).
Dal container, `localhost` e' il container stesso.

---

### Reverse proxy: altri esempi

Il vhost nginx completo e' in `deploy/nginx/books-editor.conf.example`. Con Caddy basta:

```caddy
libreria.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Imposta comunque `TRUST_PROXY` (per esempio `loopback,uniquelocal`), altrimenti
l'app non vede l'IP reale ne' l'HTTPS.

### Variabili d'ambiente

| Variabile | Default | Descrizione |
|---|---|---|
| `NODE_ENV` | — | `production`: CSP attiva, avvio rifiutato senza autenticazione, import da percorso disattivato senza `IMPORT_ROOTS` |
| `PORT` | `8787` | Porta del server |
| `HOST` | `0.0.0.0` | Interfaccia di ascolto |
| `LIBRARY_ROOT` | `./library` | Cartella della libreria |
| `DATA_DIR` | `./data` | Indice e impostazioni |
| `APPLE_BOOKS_CONTAINER` | — | Cartella del container di Apple Books o di un backup, per l'import delle annotazioni (solo macOS) |
| `APPLE_BOOKS_FORCE_REMOTE` | — | Solo per le prove: `1` fa rispondere `local: false` a `/api/apple-books/capabilities`, cioè simula un server remoto anche su un Mac |
| `AUTH_USER` / `AUTH_PASS_HASH` | — | Facoltative: utente e hash scrypt fissati dal server (altrimenti l'account si crea dall'interfaccia al primo avvio) |
| `AUTH_PASS` | — | Password in chiaro (deprecata, sconsigliata) |
| `AUTH_DISABLED` | — | `1` = app aperta se non esiste nessun account (sconsigliato) |
| `SESSION_SECRET` | generato in `DATA_DIR/.session-secret` | Segreto delle sessioni, almeno 32 caratteri |
| `SESSION_DAYS` | `30` | Durata della sessione |
| `TRUST_PROXY` | — | Proxy fidati (sintassi proxy-addr), es. `loopback,uniquelocal` |
| `IMPORT_ROOTS` | — | Cartelle assolute (separate da virgola) consentite per «Importa da percorso» |
| `CORS_ORIGINS` | — | Lascia vuota (l'app e' same-origin) |
| `GOOGLE_BOOKS_API_KEY` | — | Chiave Google Books (facoltativa; alternativa: impostarla dall'interfaccia) |
| `MAX_UPLOAD_MB` | `300` | Dimensione massima (1-4096 MB) dei file caricati dal browser. Anche il reverse proxy deve accettarla: in nginx `client_max_body_size` un po' sopra questo valore (es. `310m`), altrimenti risponde 413 |
| `CONVERT_TIMEOUT_SEC` | `600` | Tempo massimo di una conversione di formato (MOBI, AZW3, FB2, DJVU). Anche il reverse proxy deve attendere: in nginx `proxy_read_timeout` di almeno 900s sulle route di caricamento (vedi `deploy/nginx/books-editor.conf.example`) |
| `FANFIC_CHECK` | `on` | `off` disattiva il controllo automatico dei nuovi capitoli delle fanfiction AO3 ed EFP. Il controllo avvisa soltanto (etichetta sulla card, filtro «Aggiornamenti»); la storia si aggiorna dalla scheda. Il pulsante «Controlla aggiornamenti ora» nelle Impostazioni funziona comunque |
| `FANFIC_CHECK_HOUR` | `3` | Ora locale (0-23) del controllo notturno. Nel container conta `TZ` (default `Europe/Rome` nel compose). Se l'ultimo giro risale a più di 24 ore fa, ne parte uno 10 minuti dopo l'avvio |
| `FANFIC_CHECK_DELAY_SEC` | `6` | Pausa in secondi fra una richiesta e l'altra ai siti durante il controllo |
| `JELLYFIN_PATH_MAP` | — | Mappatura `percorso visto da Jellyfin=percorso dell'app` (coppie separate da `;`, vince il prefisso più lungo) per abbinare i file di Jellyfin alle schede. Vuota = percorsi uguali |
| `JELLYFIN_SYNC_MINUTES` | `30` | Ogni quanti minuti abbinare i nuovi elementi di Jellyfin e inviare le schede modificate (`0` = giro periodico spento) |
| `LOG_LEVEL` | `info` | Livello di log |

### Google Books: errore HTTP 429

Senza chiave API, Google Books applica un limite molto basso alle richieste
anonime e risponde `HTTP 429` (oppure `403` quando la quota è esaurita). Open
Library continua a funzionare e i suoi risultati restano visibili.

Per risolvere, in ordine di comodità:

1. apri **Impostazioni → Chiave API Google Books**, incolla una chiave gratuita
   ([come ottenerla](https://developers.google.com/books/docs/v1/getting_started#APIKey))
   e salva: non serve riavviare;
2. oppure imposta `GOOGLE_BOOKS_API_KEY` nell'ambiente / `.env` e riavvia;
3. oppure disattiva la fonte **Google Books** in Impostazioni e usa solo Open
   Library.

La chiave salvata dall'interfaccia finisce in `data/settings.json` e non viene
mai restituita al browser.

### Manca la descrizione di un libro?

Google Books espone descrizioni diverse per ogni **edizione**: la pagina che vedi
nel browser può avere una descrizione che la ricerca generica non restituisce
(oppure la ricerca può non trovare affatto quell'edizione). In questi casi:

1. apri la scheda **Metadati online**;
2. incolla il link dell'edizione (es. `https://books.google.it/books/edition/Titolo/1LwFtAEACAAJ`)
   nel campo **Link Google Books** e premi **Importa**;
3. il candidato con descrizione, editore, ISBN e copertina compare subito: applicalo come al solito.

La ricerca per ISBN, se non trova nulla, viene ripetuta automaticamente con
titolo e autore; il filtro lingua viene applicato solo se il libro non ha una
lingua propria e, se svuota i risultati, viene rimosso.

### Backup

Bastano due cartelle: `library/` (file, copertine, `book.json`) e `data/`
(indice cache, impostazioni e `series-cache.json`). La prima è il dato vero;
`data/series-cache.json` è solo una cache e può essere cancellato senza perdere
nulla.

---

## Come vengono letti i metadati

### EPUB

Viene letto l'`OPF` (contenuto, autore per ruolo, ISBN, editore, data, serie
Calibre), la copertina (manifest `cover-image`, meta `cover`, o immagine con
«cover» nel nome) e il testo dei capitoli, per contare le parole.

### Fanfic

Molti epub di fanfic contengono una pagina «Info» (in quelli AO3 è
`preface.xhtml`) con coppie `Etichetta: valore`. Il parser riconosce le etichette
più diffuse (in inglese e italiano):

`Title`, `Author`, `Fandom(s)`, `Characters`, `Relationship(s)`, `Pairing(s)`,
`Ship(s)`, `Rating`, `Archive Warning`, `Language`, `Words`, `Chapters`, `Status`,
`Published`, `Updated`, `Completed`, `Summary`, `Series`, `Beta`,
`Additional Tags`, `Categories`.

Gestisce sia `Rating: Explicit` sulla stessa riga sia il formato AO3 con
l'etichetta e il valore su righe separate. Dalle statistiche ricava stato
(Complete/Incomplete), numero di capitoli (es. `30/30` → 30), parole, data di
pubblicazione, serie e relativo numero. Il link AO3 viene ricavato dal testo
della pagina Info o dall'identificatore OPF dell'EPUB.

Se l'opera ha almeno 3 etichette riconosciute, o se compaiono marker tipici
(`fandom:`, `relationship:`, `rating:` …), viene classificata come fanfic.

Quando almeno un'opera della serie ha il link AO3, la finestra **Serie** apre la
pagina della serie sul sito e mostra le parti mancanti con numero, titolo, data e
link, senza aggiungerle alla libreria. Se il link manca, la finestra lo segnala:
basta incollarlo nella scheda **Metadati** di una delle opere.

Cloudflare a volte risponde ad AO3 con errori 525/403 intermittenti. Le pagine
delle serie vengono quindi lette prima direttamente (con `curl`, incluso
nell'immagine Docker) e, se non rispondono, tramite il reader pubblico
`r.jina.ai`, a cui viene inviato solo l'URL AO3 pubblico della serie.

I risultati delle ricerche (volumi/opere trovate) vengono salvati in
`data/series-cache.json` e riusati per **30 giorni** (configurabile in
**Impostazioni → Aggiorna le serie ogni**), anche dopo un riavvio.
«Aggiorna online» ignora la cache e rifà la ricerca.
Il conteggio parole dichiarato dall'autrice prevale su quello calcolato dai file,
perché si riferisce all'opera intera; il numero di capitoli dichiarato prevale
sul numero di file dello spine (che include preface e afterword).

### EFP Fanfiction (`efpfanfic.net`)

Nella finestra **Importa** puoi incollare un link `viewstory.php?sid=…` di EFP.
Il server legge la pagina della storia per titolo, autore, categoria, sinossi,
generi, personaggi, coppie, tipo di coppia, note, avvertimenti, contesto, serie,
rating, stato e data, poi usa l'endpoint pubblico
`printsave.php?action=printall` per scaricare **tutti i capitoli in una sola
richiesta**. Le pagine EFP sono in ISO-8859-1: il testo viene decodificato
correttamente prima di creare i file.

Vengono generati due documenti nella cartella della storia:

- **EPUB** con capitoli, indice e metadati, usato dalla libreria;
- **ODT** (OpenDocument Text) apribile con LibreOffice, OpenOffice o Word.

In entrambi il testo dei capitoli conserva la formattazione della storia:
grassetto, corsivo, sottolineato, barrato, paragrafi centrati o a destra, righe
vuote volute (es. fra le strofe) e separatori di scena. Font, dimensioni e
colori impostati dall'editor dell'autore vengono ignorati, così il documento
resta uniforme.

L'import compila `book.json` con i metadati EFP, salva il link in `efpUrl` e
l'identificatore `sid` in `identifiers.efp`. Le «Coppie» vanno in
`relationships`; generi, tipo di coppia, note (AU, What if?…), avvertimenti,
contesto e la sottocategoria delle storie originali (es. «Poesia») diventano
tag. Se la storia fa parte di una serie, il nome va in `series`, l'id della
serie in `identifiers.efpSeries` e la posizione in `seriesIndex`: EFP non la
indica, quindi è stimata dall'ordine di pubblicazione delle storie della serie. Se importi di nuovo la stessa
storia, la scheda viene aggiornata senza creare duplicati. Il pulsante
**Scarica ODT** nella finestra «Importa» scarica direttamente il documento senza
aggiungere nulla alla libreria.

Per le storie con rating rosso, senza login la pagina della storia mostra solo
titolo, sinossi e personaggi: gli altri metadati (generi, stato, data, note…)
vengono presi dall'elenco storie nella pagina dell'autore. Se EFP non
restituisce i capitoli in modo anonimo, l'app mostra un errore esplicito.
Scarica solo testi che hai il diritto di leggere, per uso personale.

### Sottolineature da Apple Books (macOS)

Apple Books salva evidenziazioni, sottolineature e note in un database SQLite
separato dagli EPUB:

- `~/Library/Containers/com.apple.iBooksX/Data/Documents/AEAnnotation/AEAnnotation*.sqlite`
- `.../BKLibrary/BKLibrary*.sqlite` per titolo, autore e stato di lettura.

In **Impostazioni → Sottolineature da Apple Books → Importa da Apple Books** l'app
legge le annotazioni, le abbina ai libri per titolo e autore (oppure tramite
l'identificatore Apple già salvato in `book.json`) e scrive il campo `highlights`.
Lo stesso abbinamento avviene in automatico, limitato al libro appena importato,
quando aggiungi un'opera (file, percorso sul server o EFP): sottolineature,
note, avanzamento di lettura e data di fine compaiono senza altri passaggi. Se
Apple Books non è disponibile l'import del libro riesce comunque.
L'import è ripetibile e idempotente: usa gli UUID delle annotazioni, quindi non
crea duplicati. Nella scheda **Sottolineature** puoi cercarle, copiarle e
scaricarle in Markdown.

Vengono importati solo i testi evidenziati o sottolineati con le relative note;
i segnalibri senza testo e le annotazioni dei PDF vengono ignorati. Su iPhone e
iPad le annotazioni arrivano al database del Mac tramite iCloud; in alternativa
puoi estrarre il container da un backup non cifrato e impostare
`APPLE_BOOKS_CONTAINER` sulla sua cartella `Data/Documents`.

### App desktop

L'app in `desktop/` (Electron) è disponibile per **Mac** (Apple Silicon e Intel) e per
**Windows** (64 bit) e funziona in due modi, che scegli al primo avvio:

- **Su questo computer** (consigliata): il server di Books Editor gira dentro l'app, solo
  su `127.0.0.1`, e i libri stanno in una cartella a tua scelta (proposta:
  `Documenti/Books Editor`). Non serve nessun server, nessun account e nessun login.
  Alla chiusura dell'app il server si ferma.
- **Collegati a un server**: apre il tuo server (`http://` o `https://`, verificato con
  `/api/health`) in una finestra, come prima. Chi aveva già un indirizzo salvato resta in
  questa modalità senza domande.

Si cambia da **Books Editor → Cambia modalità…**. In modalità locale la cartella dei
libri si cambia da **Impostazioni → Cartella della libreria → Scegli…**.

**Download.** I pacchetti sono nella pagina [Releases](../../releases) del repository:
`Books-Editor-<versione>-mac-arm64.dmg` (Mac con chip Apple), `…-mac-x64.dmg` (Mac Intel) e
`Books-Editor-<versione>-win-x64.exe` (installer per Windows, nella cartella
che scegli, senza diritti di amministratore).

**App non firmate.** I pacchetti non sono firmati né notarizzati:
- su **macOS**, al primo avvio fai clic destro sull'app → **Apri**; oppure, se il sistema
  la blocca, **Impostazioni di Sistema → Privacy e sicurezza → «Apri comunque»**;
- su **Windows**, SmartScreen mostra «Windows ha protetto il PC»: **Ulteriori informazioni →
  Esegui comunque**.

**Dove stanno i dati.** I libri nella cartella scelta (una sottocartella per libro, con
`book.json`). Indice, impostazioni, librerie aggiuntive e log del server stanno nella
cartella dell'app: `~/Library/Application Support/Books Editor` su Mac,
`%APPDATA%\Books Editor` su Windows (sottocartelle `data`, `librerie`, `logs`). Per
disinstallare basta eliminare l'app: i libri non si toccano.

**Conversioni.** MOBI, AZW3, FB2 e DJVU si convertono se sono installati
[Calibre](https://calibre-ebook.com) (e, per i DJVU scansionati, djvulibre); l'app li
trova nelle cartelle standard (anche su Windows). Senza, le conversioni restano
disattivate e il resto funziona.

**Apple Books (solo Mac).** L'app aggiunge funzioni che nel browser non compaiono:

1. **Importa da Apple Books**: sottolineature, note, avanzamento e date di fine lettura.
   Con il server su un altro computer l'app legge i database di Libri sul Mac e la pagina
   li invia al server; in modalità locale il server li legge da solo.
2. **Scrivi su Apple Books**: titolo, autori e copertina nella cartella iCloud di Libri,
   con backup in `~/Library/Application Support/Books Editor/applebooks-backups`.
3. **Apri in Libri**: apre l'EPUB, con i metadati della scheda, nell'app Libri.

Su Windows queste funzioni non esistono e l'interfaccia le nasconde. L'app lavora solo su
dati locali e non fa richieste autenticate al server: è la pagina web, con la propria
sessione, a parlare con il server e a passare i dati all'app. Per leggere i database di
Libri macOS può chiedere il permesso «accesso ai dati di altre app» (o l'accesso completo
al disco): concedilo a Books Editor in **Impostazioni di Sistema → Privacy e sicurezza**.

**Sicurezza in modalità locale.** Il server ascolta solo su `127.0.0.1` e ogni richiesta
all'API richiede un cookie con un token casuale, generato a ogni avvio e noto solo alla
finestra dell'app (variabile `DESKTOP_TOKEN`): un altro programma o una pagina web aperta
nel browser non possono usarla.

**Compilazione** (serve Node 22 o più recente; dalla radice, una volta):

```bash
npm install
npm run build        # server (server/dist) e interfaccia (web/dist)
cd desktop
npm install
npm run dist:mac-arm64   # release/Books-Editor-<versione>-mac-arm64.dmg
npm run dist:mac-x64     # ... -mac-x64.dmg
npm run dist:win         # ... -win-x64.exe (da Mac o Linux serve wine per icona e versione)
```

`npm run build` in `desktop/` compila main, preload e il server impacchettato
(`desktop/server-dist`); `npm run start` avvia l'app in sviluppo. `desktop/` ha il suo
`package.json` e non fa parte dei workspace: la build Docker del server non installa
Electron. Il server è un unico file (esbuild) con `@napi-rs/canvas` (il binario del
sistema di destinazione, scaricato da npm) e `pdfjs-dist` accanto, in `Resources/server`.
Il workflow `.github/workflows/desktop.yml` costruisce tutto e allega i pacchetti alla
Release quando si pubblica un tag `desktop-v*` (o a mano da **Actions**).

### PDF / DOCX / TXT

Titolo, autore, pagine, parole e (per i PDF) l'immagine incorporata come copertina.

### Online

- **Google Books**: `intitle:"…" inauthor:"…"` oppure per ISBN.
- **Open Library**: `title:"…" author:"…"` oppure per ISBN.
- **AO3 / FanFiction.net**: pagina originale, se il link è in chiaro. Per AO3 la
  pagina viene letta con uno User-Agent da browser e, se compare l'avviso per i
  contenuti adulti, con `view_adult=true`. Vengono estratti titolo, autore,
  fandom, rating, warning, relationship, personaggi, tag, lingua, serie,
  statistiche e summary. Nella scheda «Metadati online» puoi incollare un link
  AO3 (o solo l'ID dell'opera) se l'EPUB non lo contiene.

Nessun dato viene applicato senza passare dalla scheda di conferma, a meno che
non sia attivo «Compila in automatico». Se AO3 è momentaneamente irraggiungibile,
il pulsante ↻ «Rileggi i metadati dal file» ricarica i dati dalla pagina Info
dell'EPUB.

---

## Editor di copertine Penguin

Nella scheda **Copertina** di ogni opera trovi il pulsante **Crea copertina
Penguin**. L'editor funziona interamente nel browser e usa lo stesso endpoint di
caricamento delle copertine, quindi non richiede configurazione aggiuntiva.

- **Testi**: titolo (con a capo automatici), autore, occhiello, testatina e riga
  di serie/fandom. Nel layout *Immagine* la riga di serie diventa il sottotitolo
  e la testatina viene divisa ai lati del logo. I campi lasciati vuoti non
  vengono stampati.
- **Impaginazione**: *Bande* (la classica copertina a fasce arancioni), *Cornice*
  (bordo e fascia autore), *Moderno* (blocco colore pieno) e *Immagine* (foto a
  tutta larghezza in alto, fascia bianca con marchio e fondo nero con autore,
  titolo e sottotitolo).
- **Immagine**: nel layout *Immagine* puoi caricare un file JPG, PNG o WebP dal
  computer (oppure trascinarlo nell'apposito riquadro). L'immagine viene
  ridimensionata, ritagliata per riempire l'area superiore e incorporata
  nell'export; il pulsante «Rimuovi» ripristina il riquadro colorato.
- **Stile**: palette Penguin (arancio, carta, nero/oro, verde, blu, bordeaux,
  giallo), colori personalizzati, serif classico/elegante o sans, e marchio
  pinguino, ornamento, monogramma o nessuno.
- **Export**: anteprima dal vivo e immagine **1600 × 2400 px** in JPG o PNG.
  «Salva come copertina» la applica subito all'opera; «Scarica» conserva il file.

Il generatore è in `web/src/components/CoverEditor.tsx`. Non usa servizi esterni
né font remoti: il rendering avviene con il Canvas del browser a partire da un SVG,
così l'immagine esportata coincide con l'anteprima.

---

## Struttura del progetto

```
books-editor/
├── shared/types.ts          # tipi condivisi fra server e web
├── server/
│   └── src/
│       ├── index.ts          # avvio Fastify, autenticazione, file statici
│       ├── config.ts         # variabili d'ambiente e percorsi
│       ├── store.ts          # indice JSON + impostazioni (scrittura atomica)
│       ├── library.ts        # scansione, import, salvataggio, copertine
│       ├── appleBooksRead.ts # lettura dei database di Apple Books (senza libreria)
│       ├── appleBooks.ts     # abbinamento e import di evidenziazioni e note
│       ├── appleBooksWrite.ts # scrittura di titolo, autori e copertina su Apple Books
│       ├── jellyfin.ts       # client dell'API di Jellyfin
│       ├── jellyfinSync.ts   # abbinamento, invio dei metadati, file .ignore
│       ├── routes.ts         # API REST
│       ├── metadata/
│       │   ├── epub.ts       # parser EPUB (OPF, copertina, testo)
│       │   ├── fanfic.ts     # parser dei metadati inline delle fanfic
│       │   └── other.ts      # PDF, DOCX, TXT
│       └── providers/        # Google Books, Open Library, AO3, pagina fanfic
├── web/
│   └── src/
│       ├── App.tsx, store.ts, api.ts, utils.ts
│       └── components/       # TopBar, Sidebar, BookCard, DetailPanel, HighlightsTab, …
├── scripts/make-samples.mjs # epub di prova
├── Dockerfile, docker-compose.yml
└── library/, data/           # libreria e indice (non versionati)
```

Stack: **Fastify** (server), **React + Vite + Tailwind** (interfaccia),
**TypeScript** ovunque. Nessuna dipendenza nativa: si compila e si deploya senza
difficoltà.

---

## Scorciatoie

| Tasto | Azione |
|---|---|
| `/` | Vai alla ricerca |
| `Esc` | Chiudi la scheda aperta |

---

## API

Tutte le rotte sono sotto `/api`.

| Metodo | Rotta | Descrizione |
|---|---|---|
| `GET` | `/books` | Elenco sintetico + statistiche |
| `GET` | `/books/:id` | Scheda completa |
| `GET` | `/books/:id/download?file=` | Scarica il file principale (o un file extra della scheda, es. l'ODT EFP) |
| `PATCH` | `/books/:id` | Modifica i metadati |
| `DELETE` | `/books/:id` | Rimuove l'opera (`?keepFiles=1` conserva i file) |
| `GET` | `/covers/:id` | Immagine della copertina |
| `POST` | `/books/:id/cover` | Carica una copertina (multipart) |
| `POST` | `/books/:id/cover/url` | Scarica la copertina da un URL |
| `DELETE` | `/books/:id/cover` | Rimuove la copertina |
| `POST` | `/books/:id/refresh` | Rilegge i metadati dal file |
| `POST` | `/books/:id/lookup` | Cerca candidati online |
| `POST` | `/books/:id/lookup/google` | Importa una specifica edizione Google Books |
| `POST` | `/books/:id/lookup/ao3` | Importa i metadati da un link AO3 (o FanFiction.net) |
| `POST` | `/books/:id/apply` | Applica un candidato |
| `POST` | `/series/lookup` | Cerca online i volumi o le opere mancanti di una serie (libri e AO3) |
| `POST` | `/apple-books/import` | Importa evidenziazioni e note da Apple Books (body `{ "dryRun": true }` per l'anteprima) |
| `GET` | `/apple-books/capabilities` | `{ local }`: il server legge Apple Books da sé (macOS o `APPLE_BOOKS_CONTAINER`) |
| `POST` | `/apple-books/import-data` | Come `/apple-books/import`, ma con i dati letti dall'app per Mac (body `{ annotations, library, dryRun?, bookIds? }`) |
| `POST` | `/library/scan` | Riscansiona la cartella |
| `POST` | `/library/import` | Importa da un percorso sul server |
| `POST` | `/library/upload` | Importa un file caricato dal browser |
| `POST` | `/efp/import` | Scarica una storia EFP e la importa (EPUB + ODT) |
| `POST` | `/efp/download` | Scarica una storia EFP in ODT o EPUB |
| `GET`/`PUT` | `/settings` | Impostazioni della libreria |
| `GET` | `/jellyfin/info`, `/jellyfin/libraries` | Verifica la connessione a Jellyfin ed elenca le sue librerie |
| `POST` | `/jellyfin/sync` | Abbina e invia a Jellyfin i metadati in background (body `{ "force": true }` per rimandare anche le schede invariate) |
| `GET` | `/jellyfin/sync/status` | Stato e avanzamento dell'abbinamento e dell'invio |
| `POST` | `/books/:id/jellyfin-push` | Invia subito a Jellyfin i metadati di una scheda |

---

## Personalizzazione

- **Tema e colori**: `web/tailwind.config.js` (palette `ink`, `accent`, `rose`).
- **Campi dell'interfaccia**: `shared/types.ts` → `FIELD_SPECS` (etichette, gruppi,
  tipi). Aggiungere un campo lì lo rende disponibile nelle schede.
- **Etichette dei metadati fanfic**: `server/src/metadata/fanfic.ts` → `LABELS`.
- **Provider**: aggiungi un file in `server/src/providers/` e registralo in
  `lookupOnline` (la forma dei risultati è `MetadataCandidate`).

---

## Licenza

GPL-3.0-or-later: vedi il file [`LICENSE`](LICENSE).
