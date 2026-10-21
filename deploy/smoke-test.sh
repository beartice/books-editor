#!/usr/bin/env bash
# Prova locale dell'immagine Docker prima del deploy.
# Uso: deploy/smoke-test.sh <cartella-temporanea> [immagine]
#   <cartella-temporanea>  cartella (anche inesistente) usata per data/ e library/
#                          di prova; viene rimossa alla fine.
#   [immagine]             default: books-editor:latest (da costruire prima).
# Non usa data/ e library/ del progetto.
set -u

WORK="${1:-}"
IMAGE="${2:-books-editor:latest}"
if [ -z "$WORK" ]; then
  echo "Uso: $0 <cartella-temporanea> [immagine]" >&2
  exit 2
fi
case "$WORK" in
  /*) ;;
  *) WORK="$PWD/$WORK" ;;
esac
# Sicurezza: mai la cartella del progetto o le sue data/library.
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
case "$WORK/" in
  "$PROJECT/"|"$PROJECT/data/"*|"$PROJECT/library/"*)
    echo "Rifiuto di usare $WORK: scegli una cartella temporanea fuori da data/ e library/" >&2
    exit 2 ;;
esac

NAME="libreria-smoke-$$"
PORT=18787
BASE="http://127.0.0.1:$PORT"
USER_T="prova"
PASS_T="password-di-prova-$$"
JAR="$WORK/cookies.txt"
FAILS=0
RESULTS=()

ok()   { RESULTS+=("OK    $1"); }
fail() { RESULTS+=("FAIL  $1${2:+ ($2)}"); FAILS=$((FAILS + 1)); }
check() { # check <descrizione> <esito 0=ok> [dettaglio]
  if [ "$2" -eq 0 ]; then ok "$1"; else fail "$1" "${3:-}"; fi
}

cleanup() {
  docker rm -f "$NAME" "$NAME-setup" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/data" "$WORK/library"
printf '[]' > "$WORK/data/index.json"
# L'utente del container e' uid 1000: i volumi devono essere scrivibili da lui.
# (Con Docker Desktop su macOS i permessi sono gia' mappati; chmod e' il fallback.)
chown -R 1000:1000 "$WORK/data" "$WORK/library" 2>/dev/null || chmod -R a+rwX "$WORK/data" "$WORK/library"

# Hash di prova generato dall'immagine stessa (password su stdin).
HASH_LINE="$(printf '%s' "$PASS_T" | docker run --rm -i "$IMAGE" node server/dist/server/src/tools/hash-password.js 2>&1)"
AUTH_PASS_HASH="${HASH_LINE#AUTH_PASS_HASH=}"
case "$AUTH_PASS_HASH" in
  scrypt\$*) ok "hash-password genera un hash scrypt" ;;
  *) fail "hash-password genera un hash scrypt" "$HASH_LINE"; AUTH_PASS_HASH="" ;;
esac

# Stesse opzioni di docker-compose.yml.
docker run -d --name "$NAME" \
  --read-only --tmpfs /tmp \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --memory 1g \
  -p "127.0.0.1:$PORT:8787" \
  -e NODE_ENV=production -e TRUST_PROXY=loopback,uniquelocal \
  -e AUTH_USER="$USER_T" -e AUTH_PASS_HASH="$AUTH_PASS_HASH" \
  -e SESSION_SECRET="$(printf 'x%.0s' {1..40})" \
  -e LOG_LEVEL=info \
  -v "$WORK/library:/app/library" -v "$WORK/data:/app/data" \
  "$IMAGE" >/dev/null 2>"$WORK/run.err"
check "avvio del container" $? "$(cat "$WORK/run.err" 2>/dev/null)"

# Attesa di /api/health (max 60 s).
UP=1
for _ in $(seq 1 60); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then UP=0; break; fi
  sleep 1
done
check "/api/health risponde" $UP

if [ "$UP" -eq 0 ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/books")"
  [ "$CODE" = "401" ]; check "/api/books senza login -> 401" $? "ricevuto $CODE"

  HDRS="$(curl -s -D - -o /dev/null -c "$JAR" -X POST "$BASE/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$USER_T\",\"password\":\"$PASS_T\"}")"
  echo "$HDRS" | head -1 | grep -q ' 200'; check "login riuscito" $? "$(echo "$HDRS" | head -1)"
  echo "$HDRS" | grep -i '^set-cookie' | grep -qi 'HttpOnly'; check "cookie HttpOnly" $?
  echo "$HDRS" | grep -i '^set-cookie' | grep -qi 'SameSite=Strict'; check "cookie SameSite=Strict" $?

  CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/api/books")"
  [ "$CODE" = "200" ]; check "/api/books con cookie -> 200" $? "ricevuto $CODE"

  curl -s -D - -o /dev/null -b "$JAR" "$BASE/" | grep -qi '^content-security-policy:'
  check "intestazione Content-Security-Policy presente" $?

  UID_IN="$(docker exec "$NAME" id -u 2>&1)"
  [ "$UID_IN" != "0" ] && [ -n "$UID_IN" ]; check "processo non root" $? "uid=$UID_IN"

  CODE="$(curl -s -o "$WORK/new.json" -w '%{http_code}' -b "$JAR" -X POST "$BASE/api/library/new" \
    -H 'Content-Type: application/json' -d '{"title":"Libro di prova","authors":["Prova"]}')"
  [ "$CODE" = "200" ] && [ -n "$(find "$WORK/library" -name book.json 2>/dev/null)" ]
  check "scrittura nei volumi (POST /api/library/new)" $? "HTTP $CODE $(head -c 200 "$WORK/new.json" 2>/dev/null)"

  curl -s -b "$JAR" "$BASE/" | grep -qi '<!doctype html\|<div id="root"'
  check "/ restituisce index.html" $?
else
  echo "--- log del container ---" >&2
  docker logs "$NAME" 2>&1 | tail -30 >&2
fi

# ---------------------------------------------------------------------------
# Scenario 2: primo avvio SENZA AUTH_* (l'account si crea dall'interfaccia).
# ---------------------------------------------------------------------------
docker rm -f "$NAME" >/dev/null 2>&1
mkdir -p "$WORK/data2" "$WORK/library2"
printf '[]' > "$WORK/data2/index.json"
chown -R 1000:1000 "$WORK/data2" "$WORK/library2" 2>/dev/null || chmod -R a+rwX "$WORK/data2" "$WORK/library2"
JAR2="$WORK/cookies2.txt"
NAME2="$NAME-setup"

docker run -d --name "$NAME2" \
  --read-only --tmpfs /tmp \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --memory 1g \
  -p "127.0.0.1:$PORT:8787" \
  -e NODE_ENV=production -e TRUST_PROXY=loopback,uniquelocal \
  -e SESSION_SECRET="$(printf 'x%.0s' {1..40})" \
  -e LOG_LEVEL=info \
  -v "$WORK/library2:/app/library" -v "$WORK/data2:/app/data" \
  "$IMAGE" >/dev/null 2>"$WORK/run2.err"
check "primo avvio: avvio del container senza AUTH_*" $? "$(cat "$WORK/run2.err" 2>/dev/null)"

UP=1
for _ in $(seq 1 60); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then UP=0; break; fi
  sleep 1
done
check "primo avvio: /api/health risponde" $UP

if [ "$UP" -eq 0 ]; then
  JSON='Content-Type: application/json'
  ME="$(curl -s "$BASE/api/auth/me")"
  echo "$ME" | grep -q '"setupRequired":true'; check "primo avvio: /api/auth/me dice setupRequired" $? "$ME"

  CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/books")"
  [ "$CODE" = "403" ]; check "primo avvio: /api/books -> 403" $? "ricevuto $CODE"

  # Richiesta che sembra remota (X-Forwarded-For): senza codice va rifiutata.
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/setup" \
    -H "$JSON" -H 'X-Forwarded-For: 203.0.113.9' \
    -d "{\"username\":\"$USER_T\",\"password\":\"$PASS_T\"}")"
  [ "$CODE" = "403" ]; check "primo avvio: setup remoto senza codice rifiutato" $? "ricevuto $CODE"

  SETUP_CODE="$(tr -d '[:space:]' < "$WORK/data2/.setup-code" 2>/dev/null)"
  [ -n "$SETUP_CODE" ]; check "primo avvio: .setup-code presente nel volume dati" $?

  HDRS="$(curl -s -D - -o /dev/null -c "$JAR2" -X POST "$BASE/api/auth/setup" \
    -H "$JSON" -H 'X-Forwarded-For: 203.0.113.9' \
    -d "{\"username\":\"$USER_T\",\"password\":\"$PASS_T\",\"setupCode\":\"$SETUP_CODE\"}")"
  echo "$HDRS" | head -1 | grep -q ' 200'; check "primo avvio: setup con il codice -> account creato" $? "$(echo "$HDRS" | head -1)"
  echo "$HDRS" | grep -i '^set-cookie' | grep -qi 'HttpOnly'; check "primo avvio: cookie di sessione impostato" $?

  CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" "$BASE/api/books")"
  [ "$CODE" = "200" ]; check "primo avvio: /api/books con cookie -> 200" $? "ricevuto $CODE"

  CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/setup" \
    -H "$JSON" -d "{\"username\":\"altro\",\"password\":\"un-altra-password\"}")"
  [ "$CODE" = "409" ]; check "primo avvio: secondo setup -> 409" $? "ricevuto $CODE"

  [ ! -e "$WORK/data2/.setup-code" ]; check "primo avvio: .setup-code cancellato" $?
  [ -f "$WORK/data2/auth.json" ] && ! grep -q "$PASS_T" "$WORK/data2/auth.json"
  check "primo avvio: auth.json creato, senza password in chiaro" $?
else
  echo "--- log del container (primo avvio) ---" >&2
  docker logs "$NAME2" 2>&1 | tail -30 >&2
fi

echo
echo "===== Riepilogo smoke test ====="
printf '%s\n' "${RESULTS[@]}"
echo "Falliti: $FAILS"
[ "$FAILS" -eq 0 ]
