import { supabase } from '../../lib/supabaseClient.js';

/**
 * Informes de GACO (economia i finances). Sis pestanyes: Resultat, Costos,
 * Costos per mes, Ingressos, IVA i Pendents. Cada informe és una taula (amb
 * files desplegables) que també s'exporta a PDF.
 * Vistes: gaco_informe_costos, gaco_informe_ingressos, gaco_informe_iva,
 * gaco_pendents_pagament i taula gaco_factures_emeses.
 */

const ANY_ACTUAL = new Date().getFullYear();
const MESOS = ['gener', 'febrer', 'març', 'abril', 'maig', 'juny', 'juliol', 'agost', 'setembre', 'octubre', 'novembre', 'desembre'];
const ETIQ_CLASSE = {
  bestreta_agraria: 'Bestretes agràries',
  liquidacio_agraria: 'Liquidacions agràries',
  prestacio_serveis: 'Prestació de serveis',
  ingres_extraordinari: 'Ingressos extraordinaris',
};

const fImport = (n) =>
  n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('ca-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const fPct = (x, tot) => (tot ? ((x / tot) * 100).toLocaleString('ca-ES', { maximumFractionDigits: 1 }) + ' %' : '');
const fData = (s) => {
  if (!s) return '—';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
const suma = (arr, f) => r2(arr.reduce((s, x) => s + Number(f(x) || 0), 0));

// Supabase talla a 1.000 files: es llegeix per pàgines
async function llegeixTot(fer) {
  let tots = [];
  for (let d = 0; ; d += 1000) {
    const { data, error } = await fer().range(d, d + 999);
    if (error) throw error;
    tots = tots.concat(data);
    if (data.length < 1000) break;
  }
  return tots;
}

// Agrupa en dos nivells (pare i fills) sumant els valors de vals(d) = [v0, v1, ...]
function agrupa(files, kPare, kFill, vals) {
  const pares = new Map();
  for (const d of files) {
    const np = kPare(d);
    const p = pares.get(np) ?? { nom: np, n: 0, v: [], fills: new Map() };
    const v = vals(d);
    p.n++;
    v.forEach((x, i) => (p.v[i] = (p.v[i] ?? 0) + x));
    const nf = kFill(d);
    const f = p.fills.get(nf) ?? { nom: nf, n: 0, v: [] };
    f.n++;
    v.forEach((x, i) => (f.v[i] = (f.v[i] ?? 0) + x));
    p.fills.set(nf, f);
    pares.set(np, p);
  }
  const ord = (a, b) => Math.abs(b.v[0]) - Math.abs(a.v[0]);
  return [...pares.values()].map((p) => ({ ...p, fills: [...p.fills.values()].sort(ord) })).sort(ord);
}

// ---------- Informes ----------

const NOTA_SALARIS = "El cost salarial és el líquid de les nòmines: la Seguretat Social és a la seva partida i la retenció d'IRPF (model 111) és a 'Altres tributs'.";

async function dadesCostos({ any, activitat }) {
  return llegeixTot(() => {
    let q = supabase.from('gaco_informe_costos').select('grup, concepte, tipus_concepte, activitat, mes, import').eq('exercici', any);
    if (activitat === '_cap') q = q.is('activitat', null);
    else if (activitat) q = q.eq('activitat', activitat);
    return q;
  });
}

async function dadesIngressos({ any }) {
  return llegeixTot(() => supabase.from('gaco_informe_ingressos').select('origen, classe, tercer, import').eq('exercici', any));
}

async function infCostos(ctx) {
  const dades = await dadesCostos(ctx);
  const desp = dades.filter((d) => d.tipus_concepte === 'despesa');
  const act = dades.filter((d) => d.tipus_concepte === 'actiu');
  const total = suma(desp, (d) => d.import);
  const arbre = agrupa(desp, (d) => d.grup, (d) => d.concepte, (d) => [Number(d.import)]);
  const files = arbre.map((p) => ({
    cel: [p.nom, fImport(r2(p.v[0])), fPct(p.v[0], total)],
    fills: p.fills.map((f) => ({ cel: [f.nom, fImport(r2(f.v[0])), fPct(f.v[0], total)] })),
  }));
  files.push({ cel: ['Total costos', fImport(total), '100 %'], total: true });
  if (act.length) files.push({ cel: ['Inversions (actius), a part', fImport(suma(act, (d) => d.import)), ''] });
  return {
    titol: 'Costos per grup i concepte',
    columnes: ['Concepte', 'Import', '%'],
    files,
    notes: [
      "Base imposable, sense IVA ni suplits. Inclou els moviments bancaris sense factura, descomptant-hi les retrocessions. Clica un grup per veure els conceptes.",
      NOTA_SALARIS,
    ],
  };
}

async function infCostosMes(ctx) {
  const dades = (await dadesCostos(ctx)).filter((d) => d.tipus_concepte === 'despesa');
  const perMes = Array(12).fill(0);
  for (const d of dades) perMes[Number(String(d.mes).slice(5, 7)) - 1] += Number(d.import);
  let acum = 0;
  const files = perMes.map((v, i) => {
    acum += v;
    return { cel: [cap(MESOS[i]), fImport(r2(v)), fImport(r2(acum))] };
  });
  files.push({ cel: ['Total', fImport(r2(acum)), ''], total: true });
  return {
    titol: 'Costos per mes',
    columnes: ['Mes', 'Cost', 'Acumulat'],
    files,
    notes: ['Mes de la data de factura (o de la data valor, als moviments sense factura), no el mes del servei.', NOTA_SALARIS],
  };
}

async function infIngressos(ctx) {
  const dades = await dadesIngressos(ctx);
  const etiq = (d) => (d.origen === 'factura' ? ETIQ_CLASSE[d.classe] ?? d.classe : `${cap(String(d.classe))} (sense factura)`);
  const total = suma(dades, (d) => d.import);
  const arbre = agrupa(dades, etiq, (d) => d.tercer || '(sense nom)', (d) => [Number(d.import)]);
  const files = arbre.map((p) => ({
    cel: [p.nom, String(p.n), fImport(r2(p.v[0]))],
    fills: p.fills.map((f) => ({ cel: [f.nom, String(f.n), fImport(r2(f.v[0]))] })),
  }));
  files.push({ cel: ['Total ingressos', String(dades.length), fImport(total)], total: true });
  const notes = ['Base imposable. Factures emeses (no pressupostos) i moviments bancaris sense factura amb concepte d\'ingrés (ajuts i subvencions).'];
  if (dades.some((d) => d.classe === 'bestreta_agraria')) {
    notes.push(
      "Les bestretes són a compte de la liquidació final de la fruita. Quan arribi, comprova si la cooperativa la fa pel total o només per la diferència: sumar-la a les bestretes duplicaria l'ingrés."
    );
  }
  return { titol: 'Ingressos', columnes: ['Classe', 'Docs', 'Base'], files, notes };
}

// Amortitzacions del registre d'immobilitzat (vista gaco_immobilitzat_amortitzacio, des del 2026).
// Retorna null si no hi ha dades per a l'exercici o la vista no existeix.
async function dadesAmortitzacio(any) {
  if (any < 2026) return null;
  try {
    const dades = await llegeixTot(() => supabase.from('gaco_immobilitzat_amortitzacio').select('quota').eq('exercici', any));
    return dades.length ? suma(dades, (d) => d.quota) : null;
  } catch (err) {
    console.warn('Amortitzacions no disponibles:', err);
    return null;
  }
}

async function infResum(ctx) {
  const [cost, ing, amort] = await Promise.all([dadesCostos({ any: ctx.any, activitat: '' }), dadesIngressos(ctx), dadesAmortitzacio(ctx.any)]);
  const costos = suma(cost.filter((d) => d.tipus_concepte === 'despesa'), (d) => d.import);
  const inversions = suma(cost.filter((d) => d.tipus_concepte === 'actiu'), (d) => d.import);
  const ingF = suma(ing.filter((d) => d.origen === 'factura'), (d) => d.import);
  const ingM = suma(ing.filter((d) => d.origen !== 'factura'), (d) => d.import);
  const ingT = r2(ingF + ingM);
  return {
    titol: 'Resultat de gestió',
    columnes: ['Concepte', 'Import'],
    files: [
      { seccio: 'Ingressos' },
      { cel: ['Factures emeses', fImport(ingF)] },
      { cel: ['Ajuts, subvencions i altres, sense factura', fImport(ingM)] },
      { cel: ['Total ingressos', fImport(ingT)], total: true },
      { seccio: 'Costos' },
      { cel: ['Costos (base imposable, sense inversions)', fImport(costos)], total: true },
      { seccio: 'Resultat' },
      { cel: ['Resultat de gestió', fImport(r2(ingT - costos))], total: true },
      ...(amort !== null
        ? [
            { cel: ['Amortitzacions de l\'exercici (només els elements del registre)', fImport(amort)] },
            { cel: ['Resultat després d\'amortitzacions (parcial)', fImport(r2(ingT - costos - amort))], total: true },
          ]
        : []),
      { seccio: 'Informatiu' },
      { cel: ['Inversions (actius), no incloses al resultat', fImport(inversions)] },
    ],
    notes: [
      amort !== null
        ? "No és el resultat comptable: no inclou periodificacions, i depèn de les liquidacions finals de la campanya que encara no siguin emeses. Les amortitzacions són parcials: només hi són els elements ja carregats al registre d'immobilitzat (falten, p. ex., els tractors fins que la gestoria aclareixi com s'amortitzen)."
        : "No és el resultat comptable: no inclou periodificacions ni amortitzacions, i depèn de les liquidacions finals de la campanya que encara no siguin emeses.",
      NOTA_SALARIS,
      'Les bestretes agràries són a compte de la liquidació final: vigila no comptar-ho dues vegades quan arribi.',
    ],
  };
}

const CLASSES_TRES = [
  ['cobraments_clients', 'Cobraments de clients'],
  ['ingressos_sense_factura', 'Ingressos sense factura (ajuts i subvencions)'],
  ['hisenda', "Hisenda: devolucions d'impostos"],
  ['pagaments_proveidors', 'Pagaments a proveïdors (amb factura)'],
  ['despeses_sense_factura', 'Despeses sense factura'],
  ['prestecs', 'Préstecs: quotes, amortitzacions i disposicions'],
  ['socis', 'Socis i vinculats'],
  ['treballadors', 'Treballadors: bestretes'],
  ['balanc_altres', 'Altres moviments de balanç'],
  ['pendent', 'Pendents de classificar'],
  ['ignorat', 'Ignorats'],
  ['sense_classificar', 'Sense classificar'],
];

async function infTresoreria({ any }) {
  const dades = await llegeixTot(() => supabase.from('gaco_informe_tresoreria').select('mes, classe, import').eq('exercici', any));
  const mov = dades.filter((d) => d.classe !== 'traspas'); // els traspassos entre comptes propis es compensen
  const fila = (nom, arr) => {
    const e = suma(arr.filter((x) => Number(x.import) > 0), (x) => x.import);
    const sd = suma(arr.filter((x) => Number(x.import) < 0), (x) => x.import);
    return [nom, fImport(e), fImport(sd), fImport(r2(e + sd))];
  };
  const files = [];
  for (const [clau, nom] of CLASSES_TRES) {
    const arr = mov.filter((d) => d.classe === clau);
    if (!arr.length) continue;
    const mesos = [...new Set(arr.map((d) => String(d.mes).slice(0, 7)))].sort();
    files.push({
      cel: fila(nom, arr),
      fills: mesos.map((m) => ({ cel: fila(cap(MESOS[Number(m.slice(5, 7)) - 1]), arr.filter((d) => String(d.mes).slice(0, 7) === m)) })),
    });
  }
  files.push({ cel: fila('Variació neta de tresoreria', mov), total: true });
  return {
    titol: 'Tresoreria: moviments reals del banc',
    columnes: ['Concepte', 'Entrades', 'Sortides', 'Net'],
    files,
    notes: [
      "Fluxos reals dels comptes, per data valor. Els traspassos entre comptes propis no hi són, perquè es compensen.",
      "No és el resultat: una devolució d'IVA, una disposició de préstec o una bestreta entren a la tresoreria però no als ingressos ni als costos. Clica una fila per veure-la per mesos.",
    ],
  };
}

async function infIva({ any }) {
  const d = await llegeixTot(() => supabase.from('gaco_informe_iva').select('trimestre, tipus, iva_pct, base, iva').eq('exercici', any));
  const etiq = (tipus, pct) => `${cap(tipus)} ${pct === null || pct === undefined ? (tipus === 'suportat' ? '(suplits, sense IVA)' : '(sense IVA calculable)') : Number(pct).toLocaleString('ca-ES') + ' %'}`;
  const files = [];
  const T = { sb: 0, si: 0, rb: 0, ri: 0 };
  for (let t = 1; t <= 4; t++) {
    const sup = d.filter((x) => x.trimestre === t && x.tipus === 'suportat');
    const rep = d.filter((x) => x.trimestre === t && x.tipus === 'repercutit');
    const sb = suma(sup, (x) => x.base), si = suma(sup, (x) => x.iva), rb = suma(rep, (x) => x.base), ri = suma(rep, (x) => x.iva);
    T.sb += sb; T.si += si; T.rb += rb; T.ri += ri;
    const ord = (a, b) => Number(b.iva_pct ?? -1) - Number(a.iva_pct ?? -1);
    files.push({
      cel: [`T${t}`, fImport(sb), fImport(si), fImport(rb), fImport(ri), fImport(r2(ri - si))],
      fills: [
        ...[...sup].sort(ord).map((x) => ({ cel: [etiq('suportat', x.iva_pct), fImport(x.base), fImport(x.iva), '', '', ''] })),
        ...[...rep].sort(ord).map((x) => ({ cel: [etiq('repercutit', x.iva_pct), '', '', fImport(x.base), fImport(x.iva), ''] })),
      ],
    });
  }
  files.push({ cel: ['Total any', fImport(r2(T.sb)), fImport(r2(T.si)), fImport(r2(T.rb)), fImport(r2(T.ri)), fImport(r2(T.ri - T.si))], total: true });
  return {
    titol: 'IVA per trimestre',
    columnes: ['Trimestre', 'Base suportada', 'IVA suportat', 'Base repercutida', 'IVA repercutit', 'Repercutit − suportat'],
    files,
    notes: [
      "Indicatiu, per data de factura. El suportat inclou les inversions i exclou els suplits. Positiu = a ingressar; negatiu = a compensar. Confirma amb la gestoria la data de meritació i el tractament de les bestretes agràries.",
    ],
  };
}

async function infPendents() {
  const avui = new Date().toLocaleDateString('sv-SE');
  const [rebudes, emeses] = await Promise.all([
    llegeixTot(() => supabase.from('gaco_pendents_pagament').select('proveidor, num_factura, data_venciment, import_pendent, es_nomina')),
    llegeixTot(() =>
      supabase
        .from('gaco_factures_emeses')
        .select('num_document, data_venciment, import_pendent, contrapart_nom, client:gaco_clients(nom)')
        .in('estat', ['emesa', 'cobrada_parcial', 'impagada'])
        .or('import_pendent.gt.0.005,import_pendent.lt.-0.005') // també rectificatives (pendent negatiu)
    ),
  ]);
  const vencut = (d) => (d.data_venciment && d.data_venciment < avui ? Number(d.import_pendent) : 0);
  const seccio = (titol, dades, kPare, kFill, totalTxt) => {
    const arbre = agrupa(dades, kPare, kFill, (d) => [Number(d.import_pendent), vencut(d)]);
    const files = [{ seccio: titol }];
    for (const p of arbre) {
      files.push({
        cel: [p.nom, String(p.n), fImport(r2(p.v[0])), fImport(r2(p.v[1]))],
        fills: p.fills.map((f) => ({ cel: [f.nom, '', fImport(r2(f.v[0])), fImport(r2(f.v[1]))] })),
      });
    }
    files.push({ cel: [totalTxt, String(dades.length), fImport(suma(dades, (d) => d.import_pendent)), fImport(suma(dades, vencut))], total: true });
    return files;
  };
  const aPagar = rebudes.filter((d) => !d.es_nomina);
  return {
    titol: 'Pendents de pagar i de cobrar',
    columnes: ['Tercer', 'Docs', 'Pendent', 'Vençut'],
    files: [
      ...seccio('A pagar a proveïdors', aPagar, (d) => d.proveidor, (d) => `${d.num_factura ?? 's/n'} · venç. ${fData(d.data_venciment)}`, 'Total a pagar'),
      ...seccio('A cobrar de clients', emeses, (d) => d.client?.nom || d.contrapart_nom || '(sense nom)', (d) => `${d.num_document ?? 's/n'} · venç. ${fData(d.data_venciment)}`, 'Total a cobrar'),
    ],
    notes: ["A pagar no inclou les nòmines: el seu saldo és a Finançament → Compte treballadors. 'Vençut' és el que ja ha passat del venciment."],
  };
}

const TABS = [
  ['resum', 'Resultat', infResum, false],
  ['costos', 'Costos', infCostos, true],
  ['costos_mes', 'Costos per mes', infCostosMes, true],
  ['ingressos', 'Ingressos', infIngressos, false],
  ['tresoreria', 'Tresoreria', infTresoreria, false],
  ['iva', 'IVA', infIva, false],
  ['pendents', 'Pendents', infPendents, false],
];

const ctx = { tab: 'resum', any: ANY_ACTUAL, activitat: '' };
let actual = null;

// ---------- Pantalla ----------

function htmlTaula(inf) {
  const n = inf.columnes.length;
  const cel = (c, j, pare) => `<td class="${j > 0 ? 'dr' : ''}">${j === 0 && pare ? '▸ ' : ''}${esc(c)}</td>`;
  let cos = '';
  let id = 0;
  for (const f of inf.files) {
    if (f.seccio) {
      cos += `<tr class="hist-mes"><td colspan="${n}">${esc(f.seccio)}</td></tr>`;
      continue;
    }
    const pare = f.fills && f.fills.length;
    const clau = `f${id++}`;
    cos += `<tr class="${pare ? 'inf-pare' : ''} ${f.total ? 'inf-total' : ''}" ${pare ? `data-fills="${clau}"` : ''}>${f.cel.map((c, j) => cel(c, j, pare)).join('')}</tr>`;
    for (const g of f.fills ?? []) cos += `<tr class="inf-fill" hidden data-pare="${clau}">${g.cel.map((c, j) => cel(c, j, false)).join('')}</tr>`;
  }
  const colgroup = `<colgroup><col>${inf.columnes.slice(1).map(() => `<col style="width:${n > 4 ? 120 : 130}px">`).join('')}</colgroup>`;
  return `<div class="hist-taula-wrap"><table class="hist-taula">${colgroup}
    <thead><tr>${inf.columnes.map((c, i) => `<th class="${i > 0 ? 'dr' : ''}">${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${cos}</tbody></table></div>
    ${(inf.notes ?? []).map((t) => `<p class="inf-nota">${esc(t)}</p>`).join('')}`;
}

async function carregar() {
  const el = document.getElementById('inf-resultat');
  el.innerHTML = '<p>Generant l\'informe...</p>';
  const tab = TABS.find((t) => t[0] === ctx.tab);
  document.getElementById('inf-activitat-bloc').style.display = tab[3] ? '' : 'none';
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('actiu', b.dataset.tab === ctx.tab));
  try {
    actual = await tab[2](ctx);
    el.innerHTML = htmlTaula(actual);
  } catch (err) {
    console.error(err);
    actual = null;
    el.innerHTML = `<div class="card"><p class="error">No s'ha pogut generar l'informe: ${esc(err.message ?? err)}. Has executat l'SQL de les vistes d'informes?</p></div>`;
  }
  document.getElementById('btn-pdf-inf').disabled = !actual;
}

export async function render() {
  const contenidor = document.getElementById('app-content');
  const anys = [];
  for (let a = ANY_ACTUAL; a >= ANY_ACTUAL - 3; a--) anys.push(a);
  contenidor.innerHTML = `
    <div class="inf-tabs">${TABS.map((t) => `<button type="button" data-tab="${t[0]}">${t[1]}</button>`).join('')}</div>
    <div class="card hist-filtres">
      <label>Exercici <select id="inf-any">${anys.map((a) => `<option value="${a}" ${a === ctx.any ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
      <label id="inf-activitat-bloc">Activitat
        <select id="inf-activitat">
          <option value="">Totes</option>
          <option value="fruita_cereal">Fruita / cereal</option>
          <option value="serveis">Serveis</option>
          <option value="comuna">Comuna</option>
          <option value="_cap">Sense activitat (moviments)</option>
        </select>
      </label>
      <button type="button" id="btn-pdf-inf" disabled>Exportar PDF</button>
    </div>
    <div id="inf-resultat"></div>
  `;
  document.getElementById('inf-activitat').value = ctx.activitat;
  contenidor.querySelector('.inf-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) {
      ctx.tab = b.dataset.tab;
      carregar();
    }
  });
  document.getElementById('inf-any').addEventListener('change', (e) => {
    ctx.any = Number(e.target.value);
    carregar();
  });
  document.getElementById('inf-activitat').addEventListener('change', (e) => {
    ctx.activitat = e.target.value;
    carregar();
  });
  document.getElementById('btn-pdf-inf').addEventListener('click', exportarPdf);
  document.getElementById('inf-resultat').addEventListener('click', (e) => {
    const tr = e.target.closest('[data-fills]');
    if (!tr) return;
    const fills = document.querySelectorAll(`[data-pare="${tr.dataset.fills}"]`);
    const obrir = fills[0]?.hidden;
    fills.forEach((r) => (r.hidden = !obrir));
    const cel = tr.querySelector('td');
    cel.textContent = (obrir ? '▾ ' : '▸ ') + cel.textContent.replace(/^[▸▾] /, '');
  });
  await carregar();
}

// ---------- PDF ----------

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
const pla = (s) =>
  String(s ?? '').replace(/[\u2212\u2012\u2013\u2014]/g, '-').replace(/[\u00a0\u202f]/g, ' ').replace(/[▸▾]/g, '').replace(/→/g, '>');

async function exportarPdf() {
  if (!actual) return;
  try {
    await carregarJsPdf();
    generarPdf();
  } catch (err) {
    console.error('Error generant el PDF:', err);
    alert(`No s'ha pogut generar el PDF: ${err.message ?? err}`);
  }
}

function generarPdf() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const n = actual.columnes.length;
  const tab = TABS.find((t) => t[0] === ctx.tab);
  const act = tab[3] && ctx.activitat ? ` · Activitat: ${ctx.activitat === '_cap' ? 'sense activitat' : ctx.activitat}` : '';

  doc.setFontSize(14);
  doc.text(pla(actual.titol), 14, 15);
  doc.setFontSize(9);
  doc.text(pla(`Exercici ${ctx.any}${act}`), 14, 21);
  doc.text(`Generat: ${pla(new Date().toLocaleString('ca-ES'))}`, 14, 26);

  const body = [];
  for (const f of actual.files) {
    if (f.seccio) {
      body.push([{ content: pla(f.seccio), colSpan: n, styles: { fillColor: [243, 223, 227], textColor: [136, 0, 27], fontStyle: 'bold' } }]);
      continue;
    }
    body.push(f.cel.map((c) => ({ content: pla(c), styles: f.total ? { fontStyle: 'bold' } : f.fills?.length ? { fontStyle: 'bold' } : {} })));
    for (const g of f.fills ?? []) {
      body.push(g.cel.map((c, j) => ({ content: pla(j === 0 ? '    ' + c : c), styles: { textColor: [107, 106, 102] } })));
    }
  }
  const columnStyles = {};
  for (let i = 1; i < n; i++) columnStyles[i] = { halign: 'right' };

  doc.autoTable({
    startY: 31,
    head: [actual.columnes.map(pla)],
    body,
    styles: { fontSize: 8, cellPadding: 1.6 },
    headStyles: { fillColor: [136, 0, 27], halign: 'left' },
    columnStyles,
    didParseCell: (d) => {
      if (d.section === 'head' && d.column.index > 0) d.cell.styles.halign = 'right';
    },
    didDrawPage: () => {
      doc.setFontSize(8);
      doc.text(`Pàgina ${doc.internal.getCurrentPageInfo().pageNumber}`, 196, 290, { align: 'right' });
    },
  });

  let y = doc.lastAutoTable.finalY + 7;
  doc.setFontSize(8);
  for (const nota of actual.notes ?? []) {
    const linies = doc.splitTextToSize(pla(nota), 182);
    if (y + linies.length * 4 > 282) {
      doc.addPage();
      y = 20;
    }
    doc.text(linies, 14, y);
    y += linies.length * 4 + 2;
  }
  doc.save(`informe-${ctx.tab}-${ctx.any}.pdf`);
}