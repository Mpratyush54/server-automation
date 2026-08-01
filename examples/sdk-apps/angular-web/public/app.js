const raw = '__API_BASE__';
const apiBase = raw === '__API_BASE__' ? '' : raw;

const logEl = document.getElementById('log');
const lines = [];

async function hit(path, opts) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${apiBase}${path}${sep}client=angular`, opts);
    const data = await res.json();
    lines.unshift(`[angular] ${opts?.method || 'GET'} ${path} → ${res.status} ${JSON.stringify(data).slice(0, 120)}`);
  } catch (e) {
    lines.unshift(`[angular] ERROR ${path}: ${e.message}`);
  }
  logEl.textContent = lines.slice(0, 12).join('\n');
}

document.getElementById('hello').onclick = () => hit('/api/hello');
document.getElementById('users').onclick = () => hit('/api/users');
document.getElementById('orders').onclick = () =>
  hit('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: 'angular-widget', qty: 1 }),
  });
document.getElementById('slow').onclick = () => hit('/api/slow');
document.getElementById('dbcheck').onclick = () => hit('/api/db-check');
