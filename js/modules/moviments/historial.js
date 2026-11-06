import { supabase } from '../../lib/supabaseClient.js';

/**
 * Historial de moviments, en format d'extracte bancari: una fila per moviment,
 * més recent a dalt (clic a "Data" per invertir), separador per mes, saldo si
 * s'ha triat un compte, totals del filtre i exportació a PDF.
 * El saldo es calcula sempre per data valor des del primer saldo conegut.
 */

const PAGINA = 100;
const MESOS = ['gener', 'febrer', 'març', 'abril', 'maig', 'juny', 'juliol', 'agost', 'setembre', 'octubre', 'novembre', 'desembre'];

const ETIQUETES_TIPUS = {
  fra_rebuda: 'Factura rebuda',
  fra_emesa: 'Factura emesa',
  traspas: 'Traspàs',
  rebut: 'Rebut',
  reintegrament_soci: 'Moviment amb soci',
  altres: 'Altres',
};

const ETIQUETES_ESTAT = {
  pendent: 'Pendent',
  conciliat: 'Conciliat',
  traspas_intern: 'Traspàs',
  ignorat: 'Ignorat',
};

function formatImport(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('ca-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function formatData(dataStr) {
  if (!dataStr) return '';
  const [y, m, d] = String(dataStr).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

let comptesCache = [];
// Estat de l'última cerca. `files` sempre en ordre cronològic (de més antic a més recent).
const estat = {
  files: [],
  ambSaldo: false,
  senseSaldoReal: false,
  truncat: false,
  ordreDesc: true,
  mostrades: PAGINA,
  factures: new Map(),
  filtre: {},
  compteText: 'Tots els comptes',
  compteNum: 'tots',
};

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant...</p>';

  const { data: comptes, error: errComptes } = await supabase
    .from('gaco_comptes')
    .select('id, num_compte, descripcio, entitat_id, gaco_entitats_bancaries ( id, nom )')
    .order('num_compte');

  if (errComptes) {
    contenidor.innerHTML = `<p class="error">Error carregant comptes: ${errComptes.message}</p>`;
    return;
  }
  comptesCache = comptes;

  const entitats = [...new Map(comptes.map((c) => [c.gaco_entitats_bancaries?.id, c.gaco_entitats_bancaries])).values()].filter(Boolean);

  contenidor.innerHTML = `
    <div class="card hist-filtres" id="hist-filtres">
      <label>Entitat
        <select id="f-entitat">
          <option value="">Totes</option>
          ${entitats.map((e) => `<option value="${e.id}">${esc(e.nom)}</option>`).join('')}
        </select>
      </label>
      <label>Compte (per veure el saldo)
        <select id="f-compte">
          <option value="">Tots (sense saldo)</option>
          ${comptes.map((c) => `<option value="${c.id}" data-entitat="${c.entitat_id}">${esc(c.num_compte)}${c.descripcio ? ' — ' + esc(c.descripcio) : ''}</option>`).join('')}
        </select>
      </label>
      <label>Des de <input type="date" id="f-data-des" /></label>
      <label>Fins a <input type="date" id="f-data-fins" /></label>
      <label>Tipus
        <select id="f-signe">
          <option value="">Tots</option>
          <option value="carrec">Càrrecs</option>
          <option value="abonament">Abonaments</option>
        </select>
      </label>
      <label>Import des de <input type="number" id="f-import-des" step="0.01" min="0" /></label>
      <label>Import fins a <input type="number" id="f-import-fins" step="0.01" min="0" /></label>
      <button type="button" id="btn-cercar" class="primari">Cercar</button>
      <button type="button" id="btn-pdf" disabled>Exportar PDF</button>
    </div>
    <div id="resultat-historial"><p>Cercant...</p></div>
  `;

  document.getElementById('f-entitat').addEventListener('change', (e) => {
    const entitatId = e.target.value;
    const selectCompte = document.getElementById('f-compte');
    selectCompte.value = '';
    [...selectCompte.options].forEach((opt) => {
      opt.hidden = entitatId && opt.dataset.entitat && opt.dataset.entitat !== entitatId;
    });
  });
  document.getElementById('btn-cercar').addEventListener('click', cercar);
  document.getElementById('btn-pdf').addEventListener('click', exportarPdf);
  document.getElementById('hist-filtres').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') cercar();
  });

  // Delegació d'esdeveniments: expandir fila, invertir ordre, mostrar-ne més
  document.getElementById('resultat-historial').addEventListener('click', (e) => {
    if (e.target.closest('#hist-ord')) {
      estat.ordreDesc = !estat.ordreDesc;
      pintar();
    } else if (e.target.closest('#btn-mes')) {
      estat.mostrades += PAGINA;
      pintar();
    } else {
      const fila = e.target.closest('.hist-fila');
      if (fila) fila.classList.toggle('obert');
    }
  });

  await cercar();
}

async function cercar() {
  const resultatEl = document.getElementById('resultat-historial');
  resultatEl.innerHTML = '<p>Cercant...</p>';

  const compteId = document.getElementById('f-compte').value;
  const dataDes = document.getElementById('f-data-des').value || null;
  const dataFins = document.getElementById('f-data-fins').value || null;
  const signe = document.getElementById('f-signe').value;
  const importDes = parseFloat(document.getElementById('f-import-des').value) || null;
  const importFins = parseFloat(document.getElementById('f-import-fins').value) || null;

  estat.filtre = { dataDes, dataFins, signe, importDes, importFins };
  estat.mostrades = PAGINA;
  const compte = comptesCache.find((c) => c.id === compteId);
  estat.compteText = compte
    ? `${compte.gaco_entitats_bancaries?.nom ?? ''} · ${compte.num_compte}${compte.descripcio ? ' · ' + compte.descripcio : ''}`
    : 'Tots els comptes';
  estat.compteNum = compte ? String(compte.num_compte).replace(/\W/g, '').slice(-6) : 'tots';

  if (!compteId) {
    await cercarSenseSaldo({ dataDes, dataFins, signe, importDes, importFins });
  } else {
    await cercarAmbSaldo(compteId, { dataDes, dataFins, signe, importDes, importFins });
  }
  pintar();
}

async function cercarAmbSaldo(compteId, { dataDes, dataFins, signe, importDes, importFins }) {
  const resultatEl = document.getElementById('resultat-historial');

  // Baseline: primer saldo conegut d'aquest compte
  const { data: baseline } = await supabase
    .from('gaco_importacions_n43')
    .select('data_inicial, saldo_inicial')
    .eq('compte_id', compteId)
    .order('data_inicial', { ascending: true })
    .limit(1)
    .maybeSingle();

  const dataBase = baseline?.data_inicial ?? null;
  const saldoBase = baseline?.saldo_inicial ?? 0;

  let query = supabase
    .from('gaco_moviments_n43')
    .select('id, data_operacio, data_valor, import, concepte, referencia, tipus_moviment, estat')
    .eq('compte_id', compteId)
    .order('data_valor', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(5000);
  if (dataBase) query = query.gte('data_valor', dataBase);

  const { data: moviments, error } = await query;
  if (error) {
    resultatEl.innerHTML = `<p class="error">Error carregant moviments: ${error.message}</p>`;
    estat.files = [];
    return;
  }

  let acumulat = saldoBase;
  const ambSaldo = moviments.map((m) => {
    acumulat = Math.round((acumulat + m.import) * 100) / 100;
    return { ...m, saldoVirtual: acumulat };
  });

  // Els filtres no afecten el càlcul del saldo, que ja està fet
  let filtrats = ambSaldo;
  if (dataDes) filtrats = filtrats.filter((m) => m.data_valor >= dataDes);
  if (dataFins) filtrats = filtrats.filter((m) => m.data_valor <= dataFins);
  if (signe === 'carrec') filtrats = filtrats.filter((m) => m.import < 0);
  if (signe === 'abonament') filtrats = filtrats.filter((m) => m.import > 0);
  if (importDes !== null) filtrats = filtrats.filter((m) => Math.abs(m.import) >= importDes);
  if (importFins !== null) filtrats = filtrats.filter((m) => Math.abs(m.import) <= importFins);

  estat.factures = await buscarFacturesVinculades(filtrats.filter((m) => m.estat === 'conciliat').map((m) => m.id));
  estat.files = filtrats;
  estat.ambSaldo = true;
  estat.senseSaldoReal = !baseline;
  estat.truncat = false;
}

async function cercarSenseSaldo({ dataDes, dataFins, signe, importDes, importFins }) {
  const resultatEl = document.getElementById('resultat-historial');
  let query = supabase
    .from('gaco_moviments_n43')
    .select(`
      id, data_operacio, data_valor, import, concepte, referencia, tipus_moviment, estat, compte_id,
      gaco_comptes ( num_compte, descripcio, gaco_entitats_bancaries ( nom ) )
    `)
    .order('data_valor', { ascending: false })
    .limit(1000);

  if (dataDes) query = query.gte('data_valor', dataDes);
  if (dataFins) query = query.lte('data_valor', dataFins);
  if (signe === 'carrec') query = query.lt('import', 0);
  if (signe === 'abonament') query = query.gt('import', 0);

  const { data, error } = await query;
  if (error) {
    resultatEl.innerHTML = `<p class="error">Error carregant moviments: ${error.message}</p>`;
    estat.files = [];
    return;
  }

  let filtrats = data;
  if (importDes !== null) filtrats = filtrats.filter((m) => Math.abs(m.import) >= importDes);
  if (importFins !== null) filtrats = filtrats.filter((m) => Math.abs(m.import) <= importFins);

  estat.factures = await buscarFacturesVinculades(filtrats.filter((m) => m.estat === 'conciliat').map((m) => m.id));
  estat.files = [...filtrats].reverse(); // la consulta ve de més recent a més antic
  estat.ambSaldo = false;
  estat.senseSaldoReal = false;
  estat.truncat = data.length >= 1000;
}

/**
 * Retorna un Map moviment_n43_id -> text descriptiu de la factura vinculada,
 * consultant en bloc pagaments i cobraments (evita N+1 consultes).
 */
async function buscarFacturesVinculades(idsConciliats) {
  const resultat = new Map();
  if (!idsConciliats.length) return resultat;

  // Els ids es consulten per lots perquè la URL no es passi de llargada
  const lots = [];
  for (let i = 0; i < idsConciliats.length; i += 100) lots.push(idsConciliats.slice(i, i + 100));

  const pagaments = [];
  const cobraments = [];
  for (const lot of lots) {
    const [{ data: p }, { data: c }] = await Promise.all([
      supabase.from('gaco_pagaments_factures_rebudes').select('moviment_n43_id, factura_id').in('moviment_n43_id', lot),
      supabase.from('gaco_cobraments_factures_emeses').select('moviment_n43_id, factura_id').in('moviment_n43_id', lot),
    ]);
    pagaments.push(...(p ?? []));
    cobraments.push(...(c ?? []));
  }

  const idsRebudes = [...new Set(pagaments.map((p) => p.factura_id))];
  const idsEmeses = [...new Set(cobraments.map((c) => c.factura_id))];

  const rebudes = [];
  for (let i = 0; i < idsRebudes.length; i += 100) {
    const { data } = await supabase
      .from('gaco_factures_rebudes')
      .select('id, num_factura, contrapart_nom, gaco_proveidors ( nom )')
      .in('id', idsRebudes.slice(i, i + 100));
    rebudes.push(...(data ?? []));
  }
  const emeses = [];
  for (let i = 0; i < idsEmeses.length; i += 100) {
    const { data } = await supabase
      .from('gaco_factures_emeses')
      .select('id, num_document, contrapart_nom, gaco_clients ( nom )')
      .in('id', idsEmeses.slice(i, i + 100));
    emeses.push(...(data ?? []));
  }

  const rebudesPerId = new Map(rebudes.map((f) => [f.id, f]));
  const emesesPerId = new Map(emeses.map((f) => [f.id, f]));

  for (const p of pagaments) {
    const f = rebudesPerId.get(p.factura_id);
    if (f) resultat.set(p.moviment_n43_id, `Factura rebuda · ${f.gaco_proveidors?.nom || f.contrapart_nom || '?'}${f.num_factura ? ' · ' + f.num_factura : ''}`);
  }
  for (const c of cobraments) {
    const f = emesesPerId.get(c.factura_id);
    if (f) resultat.set(c.moviment_n43_id, `Factura emesa · ${f.gaco_clients?.nom || f.contrapart_nom || '?'}${f.num_document ? ' · ' + f.num_document : ''}`);
  }
  return resultat;
}

// ---------- Pintat ----------

function htmlFila(m) {
  const vincle = estat.factures.get(m.id);
  const tipus = vincle ? '' : ETIQUETES_TIPUS[m.tipus_moviment] ?? '';
  const banc = estat.ambSaldo ? '' : `${esc(m.gaco_comptes?.gaco_entitats_bancaries?.nom ?? '?')} · ${esc(m.gaco_comptes?.num_compte ?? '?')}`;
  const sec = [banc, vincle ? '↳ ' + esc(vincle) : esc(tipus)].filter(Boolean).join(' · ');
  const oper = m.data_operacio && String(m.data_operacio).slice(0, 10) !== m.data_valor ? formatData(m.data_operacio) : '';
  return `<tr class="hist-fila">
    <td>${formatData(m.data_valor)}</td>
    <td class="hist-oper">${oper}</td>
    <td>
      <div class="hist-concepte">${esc(m.concepte ?? '(sense concepte)')}</div>
      <div class="hist-sec"><span class="hist-estat ${esc(m.estat)}">${esc(ETIQUETES_ESTAT[m.estat] ?? m.estat)}</span>${sec}</div>
      ${m.referencia ? `<div class="hist-ref">${esc(m.referencia)}</div>` : ''}
    </td>
    <td class="dr ${m.import > 0 ? 'hist-pos' : ''}"><strong>${formatImport(m.import)}</strong></td>
    ${estat.ambSaldo ? `<td class="dr hist-saldo">${formatImport(m.saldoVirtual)}</td>` : ''}
  </tr>`;
}

function totals() {
  const entrades = r2(estat.files.filter((m) => m.import > 0).reduce((s, m) => s + m.import, 0));
  const sortides = r2(estat.files.filter((m) => m.import < 0).reduce((s, m) => s + m.import, 0));
  return { entrades, sortides, net: r2(entrades + sortides), n: estat.files.length };
}

function pintar() {
  const el = document.getElementById('resultat-historial');
  const btnPdf = document.getElementById('btn-pdf');
  if (btnPdf) btnPdf.disabled = !estat.files.length;

  if (!estat.files.length) {
    if (!el.querySelector('.error')) el.innerHTML = '<div class="card"><p>Cap moviment amb aquest filtre.</p></div>';
    return;
  }

  const ordenats = estat.ordreDesc ? [...estat.files].reverse() : estat.files;
  const visibles = ordenats.slice(0, estat.mostrades);
  const columnes = estat.ambSaldo ? 5 : 4;

  let mesActual = '';
  let files = '';
  for (const m of visibles) {
    const mes = m.data_valor.slice(0, 7);
    if (mes !== mesActual) {
      mesActual = mes;
      const [y, mm] = mes.split('-');
      files += `<tr class="hist-mes"><td colspan="${columnes}">${MESOS[Number(mm) - 1]} ${y}</td></tr>`;
    }
    files += htmlFila(m);
  }

  const t = totals();
  el.innerHTML = `
    ${estat.senseSaldoReal ? '<p class="error">⚠️ No hi ha cap importació registrada per a aquest compte: el saldo és relatiu (comença a 0,00 €) i no està verificat contra el banc.</p>' : ''}
    ${estat.truncat ? '<p class="error">Es mostren els 1.000 moviments més recents. Afina el filtre per veure\'n més.</p>' : ''}
    <div class="hist-taula-wrap">
      <table class="hist-taula">
        <colgroup>
          <col style="width:96px"><col class="hist-oper" style="width:96px"><col>
          <col style="width:116px">${estat.ambSaldo ? '<col style="width:116px">' : ''}
        </colgroup>
        <thead><tr>
          <th class="hist-ord" id="hist-ord" title="Invertir l'ordre">Data ${estat.ordreDesc ? '▼' : '▲'}</th>
          <th class="hist-oper">Oper.</th><th>Concepte</th><th class="dr">Import</th>${estat.ambSaldo ? '<th class="dr">Saldo</th>' : ''}
        </tr></thead>
        <tbody>${files}</tbody>
      </table>
      <div class="hist-peu">
        <span>${t.n} moviments</span>
        <span>Entrades <strong class="hist-pos">${formatImport(t.entrades)}</strong></span>
        <span>Sortides <strong>${formatImport(t.sortides)}</strong></span>
        <span>Net <strong>${formatImport(t.net)}</strong></span>
      </div>
    </div>
    ${visibles.length < ordenats.length ? `<p class="hist-mes-mes"><button type="button" id="btn-mes">Mostrar-ne més (${visibles.length} de ${ordenats.length})</button></p>` : ''}
  `;
}

// ---------- Exportació a PDF (de tot el resultat filtrat, en l'ordre que es veu) ----------

let jsPdfCarregat = false;

async function carregarJsPdf() {
  if (jsPdfCarregat) return;
  // En sèrie: el plugin autotable necessita que window.jspdf ja existeixi.
  await carregarScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
  await carregarScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
  jsPdfCarregat = true;
}

function carregarScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// Les fonts estàndard de jsPDF no porten alguns símbols: es substitueixen per equivalents simples
const pla = (s) =>
  String(s ?? '')
    .replace(/[\u2212\u2012\u2013\u2014]/g, '-')
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/[↳→]/g, '>');

async function exportarPdf() {
  if (!estat.files.length) return alert('No hi ha moviments per exportar.');
  try {
    await carregarJsPdf();
    generarPdf();
  } catch (err) {
    console.error('Error generant el PDF:', err);
    alert(`No s'ha pogut generar el PDF: ${err.message ?? err}`);
  }
}

function descripcioFiltre() {
  const f = estat.filtre;
  const parts = [];
  if (f.dataDes || f.dataFins) parts.push(`Periode: ${f.dataDes ? formatData(f.dataDes) : '...'} - ${f.dataFins ? formatData(f.dataFins) : '...'}`);
  else parts.push("Tot l'historial");
  if (f.signe === 'carrec') parts.push('Nomes carrecs');
  if (f.signe === 'abonament') parts.push('Nomes abonaments');
  if (f.importDes !== null && f.importDes !== undefined) parts.push(`Import des de ${formatImport(f.importDes)}`);
  if (f.importFins !== null && f.importFins !== undefined) parts.push(`Import fins a ${formatImport(f.importFins)}`);
  return parts.join(' · ');
}

function generarPdf() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const ordenats = estat.ordreDesc ? [...estat.files].reverse() : estat.files;

  doc.setFontSize(14);
  doc.text('Historial de moviments', 14, 15);
  doc.setFontSize(9);
  doc.text(pla(estat.compteText), 14, 21);
  doc.text(pla(descripcioFiltre()), 14, 26);
  doc.text(`Generat: ${pla(new Date().toLocaleString('ca-ES'))}`, 14, 31);

  const concepte = (m) => {
    const vincle = estat.factures.get(m.id);
    return pla(`${m.concepte ?? '(sense concepte)'}${vincle ? '\n> ' + vincle : ''}`);
  };

  const head = estat.ambSaldo ? [['Data', 'Concepte', 'Import', 'Saldo']] : [['Data', 'Compte', 'Concepte', 'Import']];
  const body = ordenats.map((m) =>
    estat.ambSaldo
      ? [formatData(m.data_valor), concepte(m), pla(formatImport(m.import)), pla(formatImport(m.saldoVirtual))]
      : [
          formatData(m.data_valor),
          pla(`${m.gaco_comptes?.gaco_entitats_bancaries?.nom ?? '?'}\n${String(m.gaco_comptes?.num_compte ?? '').slice(-8)}`),
          concepte(m),
          pla(formatImport(m.import)),
        ]
  );

  doc.autoTable({
    startY: 36,
    head,
    body,
    styles: { fontSize: 8, cellPadding: 1.6 },
    headStyles: { fillColor: [136, 0, 27] }, // granat GACO
    columnStyles: estat.ambSaldo
      ? { 0: { cellWidth: 22 }, 2: { halign: 'right', cellWidth: 30 }, 3: { halign: 'right', cellWidth: 30 } }
      : { 0: { cellWidth: 22 }, 1: { cellWidth: 30 }, 3: { halign: 'right', cellWidth: 30 } },
    didDrawPage: () => {
      doc.setFontSize(8);
      doc.text(`Pagina ${doc.internal.getCurrentPageInfo().pageNumber}`, 196, 290, { align: 'right' });
    },
  });

  const t = totals();
  let y = doc.lastAutoTable.finalY + 8;
  if (y > 280) {
    doc.addPage();
    y = 20;
  }
  doc.setFontSize(9);
  doc.text(
    pla(`${t.n} moviments · Entrades: ${formatImport(t.entrades)} · Sortides: ${formatImport(t.sortides)} · Net: ${formatImport(t.net)}`),
    14,
    y
  );

  const avui = new Date().toLocaleDateString('sv-SE');
  doc.save(`historial-${estat.compteNum}-${avui}.pdf`);
}