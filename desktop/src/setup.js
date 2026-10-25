// Pagina di scelta della modalita' (nessuna risorsa remota).
const folder = document.getElementById('folder');
const url = document.getElementById('url');
const msg = document.getElementById('msg');
const go = document.getElementById('go');
const cancel = document.getElementById('cancel');
const radios = document.querySelectorAll('input[name=mode]');
const localDetail = document.getElementById('detail-local');
const localHint = document.querySelector('#choice-local .hint');

const initial = new URLSearchParams(location.search);
if (initial.get('msg')) msg.textContent = initial.get('msg');

const selected = () => document.querySelector('input[name=mode]:checked').value;
let currentMode = null;

function refresh() {
  const mode = selected();
  document.getElementById('choice-local').classList.toggle('selected', mode === 'local');
  document.getElementById('choice-server').classList.toggle('selected', mode === 'server');
  // Con il server gia' su questo computer la cartella si cambia dalle Impostazioni.
  localDetail.hidden = mode !== 'local' || currentMode === 'local';
  document.getElementById('detail-server').hidden = mode !== 'server';
  go.textContent = mode === 'local' ? (currentMode === 'local' ? 'Resta su questo computer' : 'Continua') : 'Collega';
}
radios.forEach((radio) => radio.addEventListener('change', refresh));

window.booksSetup.state().then((state) => {
  if (!state) return;
  currentMode = state.mode;
  folder.value = state.defaultLibraryRoot;
  if (state.serverUrl) url.value = state.serverUrl;
  cancel.hidden = !state.canCancel;
  if (state.mode === 'server') document.querySelector('input[value=server]').checked = true;
  if (state.mode === 'local') {
    localHint.textContent = 'In uso adesso. Per cambiare la cartella dei libri vai in Impostazioni → Cartella della libreria.';
  }
  refresh();
});

cancel.addEventListener('click', () => window.booksSetup.cancel());

document.getElementById('pick').addEventListener('click', async () => {
  const picked = await window.booksSetup.pickFolder(folder.value);
  if (picked) folder.value = picked;
});

document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  msg.textContent = '';
  const label = go.textContent;
  go.disabled = true;
  try {
    if (selected() === 'local') {
      if (currentMode === 'local') {
        await window.booksSetup.cancel();
        return;
      }
      go.textContent = 'Avvio…';
      const result = await window.booksSetup.useLocal(folder.value);
      if (!result.ok) msg.textContent = result.message;
    } else {
      go.textContent = 'Verifica in corso…';
      const result = await window.booksSetup.connect(url.value);
      if (!result.ok) msg.textContent = result.message;
    }
  } catch (error) {
    msg.textContent = 'Errore imprevisto: ' + error.message;
  } finally {
    go.disabled = false;
    go.textContent = label;
  }
});
