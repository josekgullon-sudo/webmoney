// Panel: barras del grafico, selector de red y actualizacion en vivo por SSE.

function paintBars() {
  document.querySelectorAll('.bar-fill[data-pct]').forEach((el) => {
    el.style.width = `${Math.max(2, Number(el.dataset.pct) || 0)}%`;
  });
}

/** El desplegable de red depende de la criptomoneda elegida. */
function setupWalletForm() {
  const assetSelect = document.getElementById('asset-select');
  const networkSelect = document.getElementById('network-select');
  if (!assetSelect || !networkSelect) return;

  let networks = {};
  try {
    networks = JSON.parse(decodeURIComponent(networkSelect.dataset.networks || '%7B%7D'));
  } catch {
    return;
  }

  const render = (keepSelected) => {
    const options = networks[assetSelect.value] || [];
    const previous = keepSelected || networkSelect.value;
    networkSelect.replaceChildren(
      ...options.map((name) => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        if (name === previous) option.selected = true;
        return option;
      })
    );
  };

  render(networkSelect.dataset.selected);
  assetSelect.addEventListener('change', () => render());
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el && value != null && el.textContent !== String(value)) el.textContent = value;
}

async function refreshSummary() {
  try {
    const res = await fetch('/api/resumen', { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    setText('stat-today', data.today.gross);
    setText('stat-today-net', data.today.net);
    setText('stat-today-count', data.today.count);
    setText('stat-pending', data.pending.text);
    setText('stat-month', data.month.net);
    renderRecent(data.payments);
  } catch {
    /* si falla la actualizacion se reintenta en el siguiente evento */
  }
}

function renderRecent(payments) {
  const table = document.getElementById('recent-payments');
  if (!table || !payments) return;
  const body = table.querySelector('tbody');
  const hasUserColumn = table.querySelectorAll('thead th').length === 6;
  const previous = new Set([...body.querySelectorAll('tr')].map((tr) => tr.dataset.id));

  body.replaceChildren(
    ...payments.map((p) => {
      const tr = document.createElement('tr');
      tr.dataset.id = String(p.id);
      if (previous.size > 0 && !previous.has(String(p.id))) tr.className = 'flash';

      const cells = [p.paidAt];
      if (hasUserColumn) cells.push(p.user || '—');
      cells.push(p.description || '—', p.amount, p.net);

      cells.forEach((value, index) => {
        const td = document.createElement('td');
        td.textContent = value;
        if (index >= cells.length - 2) td.className = 'right';
        tr.append(td);
      });

      const status = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `badge ${p.status}`;
      badge.textContent = p.statusText || p.status;
      status.append(badge);
      tr.append(status);
      return tr;
    })
  );
}

function connectStream() {
  const dot = document.getElementById('live-dot');
  if (!('EventSource' in window)) return;

  const source = new EventSource('/api/stream');
  source.addEventListener('open', () => dot?.classList.add('on'));
  source.addEventListener('error', () => dot?.classList.remove('on'));
  source.addEventListener('payment', refreshSummary);
  source.addEventListener('payout', () => window.location.reload());
}

paintBars();
setupWalletForm();
if (document.getElementById('live-dot')) connectStream();
