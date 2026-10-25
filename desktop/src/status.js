// Stato del server locale: avvio in corso oppure errore con «Riavvia».
const query = new URLSearchParams(location.search);
const error = query.get('state') === 'error';
const [first, ...rest] = (query.get('msg') || '').split('\n');

document.getElementById('title').textContent = error ? 'Books Editor non riesce a partire' : 'Avvio di Books Editor…';
document.getElementById('text').textContent = error ? first : 'Sto preparando la libreria, ci vuole un attimo.';
const detail = document.getElementById('detail');
if (error && rest.join('\n').trim()) {
  detail.textContent = rest.join('\n').trim();
  detail.hidden = false;
}
document.getElementById('actions').hidden = !error;
document.getElementById('restart').addEventListener('click', () => window.booksSetup.restart());
document.getElementById('change').addEventListener('click', () => window.booksSetup.changeMode());
