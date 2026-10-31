import { supabase } from '../../lib/supabaseClient.js';
import { openModal, closeModal } from '../../lib/modal.js';

// Compte per treballador. Conveni: import > 0 → la SL li deu; import < 0 → ell deu a la SL.
// Meritat = línies de les despeses al seu concepte de sou. Pagat = pagaments d'aquestes despeses.
// Bestretes/ajustos = gaco_treballadors_apunts. El saldo mai es desa.

function esc(t) {
  return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
function formatImport(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('ca-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}
function formatData(dataStr) {
  if (!dataStr) return '—';
  const [y, m, d] = String(dataStr).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
function avui() {
  return new Date().toISOString().slice(0, 10);
}
function arrodonir2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function textSaldo(v, nom) {
  if (Math.abs(v) < 0.005) return 'Saldat (0,00 €)';
  return v > 0 ? `La SL deu ${formatImport(v)} a ${nom}` : `${nom} deu ${formatImport(-v)} a la SL`;
}
function htmlSaldo(v, nom) {
  const color = v < -0.005 ? '#b00020' : 'inherit';
  return `<strong style="color:${color};">${textSaldo(v, nom)}</strong>`;
}

let treballadors = [];
let moviments = {}; // treballador_id -> [{data, text, import, tipus, apuntId?}]

async function carregarDades() {
  const { data: tr, error } = await supabase.from('gaco_treballadors').select('*').order('nom');
  if (error) throw error;
  treballadors = tr ?? [];
  moviments = {};

  for (const t of treballadors) {
    const llista = [];

    // Meritat: línies al concepte de sou de la persona
    const { data: linies, error: errL } = await supabase
      .from('gaco_detall_factures_rebudes')
      .select('factura_id, total_linia')
      .eq('categoria_id', t.concepte_id);
    if (errL) throw errL;

    const perFactura = new Map();
    for (const l of linies ?? []) perFactura.set(l.factura_id, (perFactura.get(l.factura_id) ?? 0) + Number(l.total_linia || 0));
    const ids = [...perFactura.keys()];

    if (ids.length) {
      const { data: factures, error: errF } = await supabase
        .from('gaco_factures_rebudes')
        .select('id, num_factura, data_factura')
        .in('id', ids);
      if (errF) throw errF;
      for (const f of factures ?? []) {
        llista.push({
          data: String(f.data_factura).slice(0, 10),
          text: `Nòmina ${f.num_factura ?? ''}`.trim(),
          import: arrodonir2(perFactura.get(f.id)),
          tipus: 'merit',
        });
      }

      // Pagat: pagaments de les despeses (devolució ja va amb signe negatiu)
      const { data: pags, error: errP } = await supabase
        .from('gaco_pagaments_factures_rebudes')
        .select('factura_id, data_pagament, import, tipus_moviment, notes')
        .in('factura_id', ids);
      if (errP) throw errP;
      const numPer = new Map((factures ?? []).map((f) => [f.id, f.num_factura]));
      for (const p of pags ?? []) {
        llista.push({
          data: String(p.data_pagament).slice(0, 10),
          text: `${p.tipus_moviment === 'devolucio' ? 'Devolució' : 'Pagament'} ${numPer.get(p.factura_id) ?? ''}${p.notes ? ' — ' + p.notes : ''}`.trim(),
          import: -arrodonir2(Number(p.import)),
          tipus: 'pagament',
        });
      }
    }

    // Bestretes i ajustos
    const { data: apunts, error: errA } = await supabase
      .from('gaco_treballadors_apunts')
      .select('id, data, concepte, motiu, tipus_moviment, import, moviment_n43_id')
      .eq('treballador_id', t.id);
    if (errA) throw errA;
    for (const a of apunts ?? []) {
      llista.push({
        data: a.data,
        text: `${a.concepte}${a.motiu ? ' — ' + a.motiu : ''}`,
        import: arrodonir2(Number(a.import)),
        tipus: a.tipus_moviment,
        apuntId: a.id,
        lligat: Boolean(a.moviment_n43_id),
      });
    }

    llista.sort((x, y) => (x.data < y.data ? -1 : x.data > y.data ? 1 : x.tipus === 'merit' ? -1 : 1));
    moviments[t.id] = llista;
  }
}

function saldoDe(id) {
  return arrodonir2((moviments[id] ?? []).reduce((s, m) => s + m.import, 0));
}

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant...</p>';
  try {
    await carregarDades();
  } catch (err) {
    contenidor.innerHTML = `<p class="error">Error carregant treballadors: ${err.message} (has executat l'SQL de gaco_treballadors?)</p>`;
    return;
  }

  const total = arrodonir2(treballadors.reduce((s, t) => s + saldoDe(t.id), 0));
  contenidor.innerHTML = `
    <div class="card">
      <p><strong>Saldo total amb els treballadors:</strong> ${
        Math.abs(total) < 0.005 ? 'saldat' : total > 0 ? `la SL els deu ${formatImport(total)}` : `els treballadors deuen ${formatImport(-total)} a la SL`
      }</p>
      <p style="font-size:13px; color: var(--gaco-text-secondary);">
        Saldo = nòmines (líquid) − pagaments + bestretes/ajustos. Positiu = la SL deu a la persona. Suma tots els exercicis.
        Roger (RNL) no és aquí: va pel compte de socis.
      </p>
    </div>
    ${treballadors.map(htmlTreballador).join('') || '<div class="card"><p>Cap treballador donat d\'alta.</p></div>'}
  `;

  contenidor.querySelectorAll('[data-extracte]').forEach((b) => b.addEventListener('click', () => obrirExtracte(b.dataset.extracte)));
  contenidor.querySelectorAll('[data-apunt]').forEach((b) => b.addEventListener('click', () => obrirNouApunt(b.dataset.apunt)));
}

function htmlTreballador(t) {
  const llista = moviments[t.id] ?? [];
  const suma = (tipus) => arrodonir2(llista.filter((m) => m.tipus === tipus).reduce((s, m) => s + m.import, 0));
  const merit = suma('merit');
  const pagat = -suma('pagament');
  const bestretes = arrodonir2(suma('bestreta') + suma('ajust'));
  return `
    <div class="card">
      <p class="modal-section-title">${esc(t.nom)}${t.actiu ? '' : ' · Inactiu'}</p>
      <p>Saldo actual: ${htmlSaldo(saldoDe(t.id), t.nom)}</p>
      <p style="font-size:13px;">Meritat ${formatImport(merit)} · pagat ${formatImport(pagat)} · bestretes i ajustos ${formatImport(bestretes)}</p>
      <button type="button" data-extracte="${t.id}">Extracte</button>
      <button type="button" data-apunt="${t.id}">+ Apunt</button>
    </div>
  `;
}

function obrirExtracte(id) {
  const t = treballadors.find((x) => x.id === id);
  let saldo = 0;
  const files = (moviments[id] ?? [])
    .map((m) => {
      saldo = arrodonir2(saldo + m.import);
      const accio = m.apuntId && !m.lligat ? `<button type="button" data-esborrar="${m.apuntId}" style="font-size:11px;">Esborrar</button>` : m.lligat ? '🔗' : '';
      return `<tr>
        <td>${formatData(m.data)}</td><td>${esc(m.text)}</td>
        <td style="text-align:right;">${formatImport(m.import)}</td>
        <td style="text-align:right;">${formatImport(saldo)}</td><td>${accio}</td></tr>`;
    })
    .join('');

  openModal({
    title: `Extracte — ${t?.nom ?? ''}`,
    wide: true,
    bodyHtml: `
      <div style="overflow-x:auto;">
        <table style="width:100%; font-size:13px; border-collapse:collapse;">
          <thead><tr><th align="left">Data</th><th align="left">Concepte</th><th align="right">Import</th><th align="right">Saldo</th><th></th></tr></thead>
          <tbody>${files || '<tr><td colspan="5">Cap moviment.</td></tr>'}</tbody>
        </table>
      </div>
      <p>Saldo final: ${htmlSaldo(saldoDe(id), t?.nom ?? '')}</p>
      <p style="font-size:12px; color: var(--gaco-text-secondary);">Les nòmines i els pagaments es gestionen des de Factures rebudes. 🔗 = bestreta lligada a un moviment bancari (es gestiona des de