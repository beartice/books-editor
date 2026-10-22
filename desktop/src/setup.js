// Pagina di configurazione dell'indirizzo del server (nessuna risorsa remota).
const input = document.getElementById('url');
const msg = document.getElementById('msg');
const connect = document.getElementById('connect');
const cancel = document.getElementById('cancel');

const initial = new URLSearchParams(location.search);
if (initial.get('msg')) msg.textContent = initial.get('msg');

window.booksSetup.current().then((value) => {
  if (value) input.value = value;
  // Con un server gia' configurato si puo' annullare.
  cancel.hidden = !value;
});

cancel.addEventListener('click', () => window.booksSetup.cancel());

document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  msg.textContent = '';
  connect.disabled = true;
  connect.textContent = 'Verifica in corso…';
  try {
    const result = await window.booksSetup.connect(input.value);
    if (!result.ok) msg.textContent = result.message;
  } catch (error) {
    msg.textContent = 'Errore imprevisto: ' + error.message;
  } finally {
    connect.disabled = false;
    connect.textContent = 'Collega';
  }
});
