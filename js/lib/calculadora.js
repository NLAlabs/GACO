// js/lib/calculadora.js
// Calculadora flotant global: obrir amb Alt+K o clic al botó, insereix el
// resultat al darrer camp enfocat, o el copia al porta-retalls.
// Mateix esperit visual que modal.js (variables --gaco-*).

let panelEl = null;
let displayEl = null;
let lastFocusedInput = null;
let current = '0';
let justEvaluated = false;

function esCampValid(el) {
  return el && el.tagName === 'INPUT' &&
    (el.type === 'number' || el.type === 'text' || el.type === '');
}

// Recorda sempre el darrer input vàlid enfocat, encara que després
// el focus passi a la calculadora.
document.addEventListener('focusin', (e) => {
  if (esCampValid(e.target)) lastFocusedInput = e.target;
});

function formatCaES(n) {
  if (!isFinite(n)) return 'Error';
  return n.toLocaleString('ca-ES', { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}

function evaluar(expr) {
  // Només dígits, operadors bàsics, punt i parèntesis. Res de codi arbitrari.
  if (!/^[0-9+\-*/().\s]+$/.test(expr)) return NaN;
  try {
    // eslint-disable-next-line no-new-func
    return Function('"use strict"; return (' + expr + ')')();
  } catch {
    return NaN;
  }
}

function actualitzarDisplay() {
  displayEl.textContent = current;
}

function premeTecla(t) {
  if (t === 'C') {
    current = '0';
    justEvaluated = false;
  } else if (t === '⌫') {
    current = current.length > 1 ? current.slice(0, -1) : '0';
  } else if (t === '=') {
    const resultat = evaluar(current);
    current = isNaN(resultat) ? 'Error' : String(resultat);
    justEvaluated = true;
  } else {
    if (justEvaluated && !'+-*/'.includes(t)) current = '0';
    justEvaluated = false;
    if (current === '0' && !'.+-*/'.includes(t)) current = t;
    else current += t;
  }
  actualitzarDisplay();
}

function valorNumeric() {
  const v = evaluar(current);
  return isNaN(v) ? null : v;
}

function inserirAlCamp() {
  const v = valorNumeric();
  if (v === null || !lastFocusedInput) return;
  const el = lastFocusedInput;
  el.value = el.type === 'number' ? String(v) : formatCaES(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.focus();
  tancarCalculadora();
}

async function copiarResultat() {
  const v = valorNumeric();
  if (v === null) return;
  try {
    await navigator.clipboard.writeText(String(v));
    displayEl.classList.add('gaco-calc-copiat');
    setTimeout(() => displayEl.classList.remove('gaco-calc-copiat'), 400);
  } catch {
    // clipboard no disponible (context no segur, etc.) — no fem res més
  }
}

function crearPanell() {
  const el = document.createElement('div');
  el.className = 'gaco-calc-panel';
  el.innerHTML = `
    <div class="gaco-calc-header">
      <span>Calculadora</span>
      <button type="button" class="gaco-calc-close" aria-label="Tancar">×</button>
    </div>
    <div class="gaco-calc-display">0</div>
    <div class="gaco-calc-grid">
      ${['7','8','9','/','4','5','6','*','1','2','3','-','C','0','.','+']
        .map(t => `<button type="button" data-key="${t}">${t}</button>`).join('')}
      <button type="button" data-key="⌫" class="gaco-calc-wide">⌫</button>
      <button type="button" data-key="=" class="gaco-calc-wide gaco-calc-eq">=</button>
    </div>
    <div class="gaco-calc-actions">
      <button type="button" class="gaco-calc-insert">Inserir al camp</button>
      <button type="button" class="gaco-calc-copy">Copiar</button>
    </div>
  `;
  document.body.appendChild(el);

  // Evita que un clic dins la calculadora es propagui fins al listener
  // "clic fora tanca el modal" que pugui tenir modal.js a document.
  el.addEventListener('click', (e) => e.stopPropagation());
  el.addEventListener('mousedown', (e) => e.stopPropagation());

  displayEl = el.querySelector('.gaco-calc-display');
  el.querySelector('.gaco-calc-close').addEventListener('click', tancarCalculadora);
  el.querySelector('.gaco-calc-insert').addEventListener('click', inserirAlCamp);
  el.querySelector('.gaco-calc-copy').addEventListener('click', copiarResultat);
  el.querySelectorAll('[data-key]').forEach(btn => {
    btn.addEventListener('click', () => premeTecla(btn.dataset.key));
  });
  return el;
}

function crearBotoFlotant() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'gaco-calc-fab';
  btn.title = 'Calculadora (Alt+K)';
  btn.textContent = '🧮';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCalculadora();
  });
  document.body.appendChild(btn);
}

export function obrirCalculadora() {
  if (!panelEl) panelEl = crearPanell();
  current = '0';
  justEvaluated = false;
  actualitzarDisplay();
  panelEl.classList.add('active');
}

export function tancarCalculadora() {
  if (panelEl) panelEl.classList.remove('active');
}

export function toggleCalculadora() {
  if (panelEl && panelEl.classList.contains('active')) tancarCalculadora();
  else obrirCalculadora();
}

export function initCalculadora() {
  crearBotoFlotant();
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      toggleCalculadora();
    } else if (e.key === 'Escape' && panelEl && panelEl.classList.contains('active')) {
      tancarCalculadora();
    }
  });
}
