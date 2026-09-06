import { supabase } from '../../lib/supabaseClient.js';
import { openModal, closeModal } from '../../lib/modal.js';

/**
 * Documents → Factures rebudes.
 * Vista principal: només llista (una fila per factura, camps etiquetats) +
 * filtres plegats + botó "+ Nova factura". Tota l'alta/edició es fa en un
 * modal, seguint l'ordre de lectura natural d'una factura:
 *   A — Dades de la factura
 *   B — Línies + totals calculats
 *   C — Venciment i forma de pagament (al final, com a Access)
 *
 * Pendent per a la propera iteració: adjunts (gaco_adjunts_factures_rebudes)
 * i pagaments (gaco_pagaments_factures_rebudes) — probablement un bloc D.
 *
 * Exercici: es filtra SEMPRE per l'any en curs per defecte (lliçó de SAO —
 * mai llista sense filtrar per exercici), amb opció explícita "Tots".
 *
 * confirming_id: es deixa sempre null. El cas d'ús real del confirming és
 * "nosaltres com a proveïdor de serveis cobrant d'un client" (factures
 * emeses, pendent de fer), no pagar als nostres propis proveïdors.
 *
 * metode_pagament_compte: només rellevant quan forma_pagament='compte_bancari'
 * (domiciliacio|transferencia|targeta) — requereix l'ALTER TABLE corresponent.
 *
 * preu_unitari: la columna real és numeric(12,6) (ampliada des de (12,2) —
 * factures com el gasoil porten preu per litre amb 6 decimals, p.ex.
 * 0,929000 €/L). Cal l'ALTER TABLE corresponent abans de fer servir això.
 */

const TIPUS_FACTURA = ['factura', 'despesa'];
const ESTATS = ['pendent', 'pagada_parcial', 'pagada', 'pendent_liquidar_soci', 'liquidada_soci'];
const FORMES_PAGAMENT = ['compte_bancari', 'soci', 'confirming', 'compensacio'];
const METODES_PAGAMENT_COMPTE = ['domiciliacio', 'transferencia', 'targeta'];
const ACTIVITATS = ['fruita_cereal', 'serveis', 'comuna'];

const ETIQUETES_ESTAT = {
  pendent: 'Pendent',
  pagada_parcial: 'Pagada parcial',
  pagada: 'Pagada',
  pendent_liquidar_soci: 'Pendent liquidar soci',
  liquidada_soci: 'Liquidada soci',
};

const ETIQUETES_METODE_COMPTE = {
  domiciliacio: 'Domiciliació',
  transferencia: 'Transferència',
  targeta: 'Targeta',
};

const ANY_ACTUAL = new Date().getFullYear();

// Cache local de dades de suport (poc volum, es carreguen un sol cop per render)
let proveidorsCache = [];
let conceptesCache = [];
let comptesCache = [];
let socisCache = [];
let immobilitzatCache = [];

// Cache de l'últim resultat llistat (per a l'exportació PDF)
let resultatActual = [];

// Estat del filtre — es manté a nivell de mòdul perquè no es perdi en tancar el modal
const filtre = {
  exercici: ANY_ACTUAL, // null = "Tots els exercicis"
  proveidorId: null,
  contrapartText: '',
  categoriaId: null,
  dataFacturaDes: null,
  dataFacturaFins: null,
  dataVencDes: null,
  dataVencFins: null,
  importDes: null,
  importFins: null,
  estats: [],
  tipus: [],
};

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant factures rebudes...</p>';

  await carregarDadesSuport();

  contenidor.innerHTML = `
    <datalist id="dl-proveidors">
      ${proveidorsCache.map((p) => `<option value="${p.nom}" data-id="${p.id}"></option>`).join('')}
    </datalist>

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
        <p style="font-weight:500; margin:0;">Factures rebudes (<span id="comptador-factures">0</span>)</p>
        <div style="display:flex; gap:8px;">
          <button type="button" id="btn-exportar-pdf">Exportar PDF</button>
          <button type="button" id="btn-nova-factura" style="background:var(--gaco-accent); color:#fff; border:none; border-radius:var(--gaco-radius); padding:8px 14px; cursor:pointer;">+ Nova factura</button>
        </div>
      </div>

      <button type="button" id="toggle-filtres" style="margin-bottom:8px;">Filtres ▾</button>
      <div id="bloc-filtres" style="display:none; gap:8px; flex-wrap:wrap; margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid var(--gaco-border);">
        <select id="f-exercici" style="min-width:130px;">
          <option value="">Tots els exercicis</option>
          ${anysDisponibles().map((a) => `<option value="${a}" ${a === filtre.exercici ? 'selected' : ''}>${a}</option>`).join('')}
        </select>
        <input type="text" id="f-proveidor" list="dl-proveidors" placeholder="Proveïdor..." style="min-width:180px;" />
        <select id="f-categoria" style="min-width:180px;">
          <option value="">Concepte...</option>
          ${conceptesCache.map((c) => `<option value="${c.id}">${c.grup} · ${c.nom}</option>`).join('')}
        </select>
        <span style="font-size:12px; color:var(--gaco-text-secondary); align-self:center;">Data factura:</span>
        <input type="date" id="f-data-factura-des" style="min-width:130px;" />
        <input type="date" id="f-data-factura-fins" style="min-width:130px;" />
        <span style="font-size:12px; color:var(--gaco-text-secondary); align-self:center;">Venciment:</span>
        <input type="date" id="f-data-venc-des" style="min-width:130px;" />
        <input type="date" id="f-data-venc-fins" style="min-width:130px;" />
        <span style="font-size:12px; color:var(--gaco-text-secondary); align-self:center;">Import:</span>
        <input type="number" step="0.01" id="f-import-des" placeholder="des" style="width:90px;" />
        <input type="number" step="0.01" id="f-import-fins" placeholder="fins" style="width:90px;" />
        <div id="f-estats" style="display:flex; gap:4px; flex-wrap:wrap; align-items:center;">
          ${ESTATS.map((e) => `
            <label style="font-size:12px; display:flex; align-items:center; gap:3px;">
              <input type="checkbox" class="chk-estat" value="${e}" /> ${ETIQUETES_ESTAT[e]}
            </label>`).join('')}
        </div>
        <div id="f-tipus" style="display:flex; gap:4px; flex-wrap:wrap; align-items:center;">
          ${TIPUS_FACTURA.map((t) => `
            <label style="font-size:12px; display:flex; align-items:center; gap:3px;">
              <input type="checkbox" class="chk-tipus" value="${t}" /> ${t}
            </label>`).join('')}
        </div>
        <button type="button" id="btn-aplicar-filtres">Aplicar</button>
        <button type="button" id="btn-netejar-filtres">Netejar</button>
      </div>

      <div id="llista-factures"></div>
    </div>
  `;

  document.getElementById('toggle-filtres').addEventListener('click', () => {
    const bloc = document.getElementById('bloc-filtres');
    bloc.style.display = bloc.style.display === 'none' ? 'flex' : 'none';
  });
  document.getElementById('btn-aplicar-filtres').addEventListener('click', () => {
    llegirFiltresDelFormulari();
    carregarLlista();
  });
  document.getElementById('btn-netejar-filtres').addEventListener('click', () => {
    netejarFiltres();
    render();
  });
  document.getElementById('btn-exportar-pdf').addEventListener('click', exportarPdf);
  document.getElementById('btn-nova-factura').addEventListener('click', obrirModalNovaFactura);

  restaurarFiltresAlFormulari();
  await carregarLlista();
}

async function carregarDadesSuport() {
  const [{ data: proveidors }, { data: conceptes }, { data: comptes }, { data: socis }, { data: immobilitzat }] = await Promise.all([
    supabase.from('gaco_proveidors').select('id, nom').eq('actiu', true).order('nom'),
    supabase.from('gaco_conceptes_comptables').select('id, grup, nom, tipus').eq('actiu', true).order('grup'),
    supabase.from('gaco_comptes').select('id, descripcio, num_compte, entitat:gaco_entitats_bancaries(nom)').eq('actiu', true),
    supabase.from('gaco_socis').select('id, nom').eq('actiu', true).order('nom'),
    supabase.from('gaco_immobilitzat').select('id, nom').eq('actiu', true).order('nom'),
  ]);
  proveidorsCache = proveidors ?? [];
  conceptesCache = conceptes ?? [];
  comptesCache = (comptes ?? []).map((c) => ({ ...c, entitatNom: c.entitat?.nom ?? '' }));
  socisCache = socis ?? [];
  immobilitzatCache = immobilitzat ?? [];
}

function anysDisponibles() {
  const anys = [];
  for (let a = ANY_ACTUAL; a >= ANY_ACTUAL - 3; a--) anys.push(a);
  return anys;
}

// -----------------------------------------------------------------------
// Filtres
// -----------------------------------------------------------------------

function llegirFiltresDelFormulari() {
  filtre.exercici = document.getElementById('f-exercici').value ? Number(document.getElementById('f-exercici').value) : null;
  const nomProv = document.getElementById('f-proveidor').value.trim();
  const provTrobat = proveidorsCache.find((p) => p.nom === nomProv);
  filtre.proveidorId = provTrobat?.id ?? null;
  filtre.contrapartText = provTrobat ? '' : nomProv;
  filtre.categoriaId = document.getElementById('f-categoria').value || null;
  filtre.dataFacturaDes = document.getElementById('f-data-factura-des').value || null;
  filtre.dataFacturaFins = document.getElementById('f-data-factura-fins').value || null;
  filtre.dataVencDes = document.getElementById('f-data-venc-des').value || null;
  filtre.dataVencFins = document.getElementById('f-data-venc-fins').value || null;
  filtre.importDes = document.getElementById('f-import-des').value ? Number(document.getElementById('f-import-des').value) : null;
  filtre.importFins = document.getElementById('f-import-fins').value ? Number(document.getElementById('f-import-fins').value) : null;
  filtre.estats = [...document.querySelectorAll('.chk-estat:checked')].map((c) => c.value);
  filtre.tipus = [...document.querySelectorAll('.chk-tipus:checked')].map((c) => c.value);
}

function restaurarFiltresAlFormulari() {
  if (filtre.contrapartText) document.getElementById('f-proveidor').value = filtre.contrapartText;
  else if (filtre.proveidorId) {
    const p = proveidorsCache.find((p) => p.id === filtre.proveidorId);
    if (p) document.getElementById('f-proveidor').value = p.nom;
  }
  if (filtre.categoriaId) document.getElementById('f-categoria').value = filtre.categoriaId;
  if (filtre.dataFacturaDes) document.getElementById('f-data-factura-des').value = filtre.dataFacturaDes;
  if (filtre.dataFacturaFins) document.getElementById('f-data-factura-fins').value = filtre.dataFacturaFins;
  if (filtre.dataVencDes) document.getElementById('f-data-venc-des').value = filtre.dataVencDes;
  if (filtre.dataVencFins) document.getElementById('f-data-venc-fins').value = filtre.dataVencFins;
  if (filtre.importDes != null) document.getElementById('f-import-des').value = filtre.importDes;
  if (filtre.importFins != null) document.getElementById('f-import-fins').value = filtre.importFins;
  document.querySelectorAll('.chk-estat').forEach((c) => (c.checked = filtre.estats.includes(c.value)));
  document.querySelectorAll('.chk-tipus').forEach((c) => (c.checked = filtre.tipus.includes(c.value)));
}

function netejarFiltres() {
  filtre.exercici = ANY_ACTUAL;
  filtre.proveidorId = null;
  filtre.contrapartText = '';
  filtre.categoriaId = null;
  filtre.dataFacturaDes = null;
  filtre.dataFacturaFins = null;
  filtre.dataVencDes = null;
  filtre.dataVencFins = null;
  filtre.importDes = null;
  filtre.importFins = null;
  filtre.estats = [];
  filtre.tipus = [];
}

async function carregarLlista() {
  const contenidor = document.getElementById('llista-factures');
  contenidor.innerHTML = '<p>Cercant...</p>';

  let query = supabase.from('gaco_factures_rebudes').select('*, proveidor:gaco_proveidors(nom)').order('data_factura', { ascending: false });

  if (filtre.exercici != null) query = query.eq('exercici', filtre.exercici);
  if (filtre.proveidorId) query = query.eq('proveidor_id', filtre.proveidorId);
  if (filtre.contrapartText) query = query.ilike('contrapart_nom', `%${filtre.contrapartText}%`);
  if (filtre.dataFacturaDes) query = query.gte('data_factura', filtre.dataFacturaDes);
  if (filtre.dataFacturaFins) query = query.lte('data_factura', filtre.dataFacturaFins);
  if (filtre.dataVencDes) query = query.gte('data_venciment', filtre.dataVencDes);
  if (filtre.dataVencFins) query = query.lte('data_venciment', filtre.dataVencFins);
  if (filtre.importDes != null) query = query.gte('total', filtre.importDes);
  if (filtre.importFins != null) query = query.lte('total', filtre.importFins);
  if (filtre.estats.length) query = query.in('estat', filtre.estats);
  if (filtre.tipus.length) query = query.in('tipus_factura', filtre.tipus);

  if (filtre.categoriaId) {
    const { data: linies } = await supabase
      .from('gaco_detall_factures_rebudes')
      .select('factura_id')
      .eq('categoria_id', filtre.categoriaId);
    const ids = [...new Set((linies ?? []).map((l) => l.factura_id))];
    if (ids.length === 0) {
      resultatActual = [];
      pintarLlista([]);
      return;
    }
    query = query.in('id', ids);
  }

  const { data, error } = await query;
  if (error) {
    contenidor.innerHTML = `<p class="error">Error cercant factures: ${error.message}</p>`;
    return;
  }

  resultatActual = data ?? [];
  pintarLlista(resultatActual);
}

function pintarLlista(llista) {
  document.getElementById('comptador-factures').textContent = llista.length;
  const contenidor = document.getElementById('llista-factures');

  if (llista.length === 0) {
    contenidor.innerHTML = '<p style="color:var(--gaco-text-secondary);">Cap factura amb aquest filtre.</p>';
    return;
  }

  contenidor.innerHTML = llista
    .map(
      (f) => `
    <div style="border-top:0.5px solid var(--gaco-border); padding:10px 0; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
      <div>
        <p style="margin:0; font-weight:500;">${f.proveidor?.nom ?? f.contrapart_nom ?? '—'}</p>
        <p style="margin:2px 0 0; font-size:12px; color:var(--gaco-text-secondary);">
          Data: ${formatData(f.data_factura)} · Núm.: ${f.num_factura ?? '—'} · Tipus: ${f.tipus_factura}
          · Total: ${formatImport(f.total)} · Pendent: ${formatImport(f.import_pendent)}
          · Estat: <span style="color:var(--gaco-accent);">${ETIQUETES_ESTAT[f.estat] ?? f.estat}</span>
        </p>
      </div>
      <button data-veure="${f.id}">Veure/Editar</button>
    </div>
  `
    )
    .join('');

  contenidor.querySelectorAll('[data-veure]').forEach((btn) => {
    btn.addEventListener('click', () => obrirModalFactura(btn.dataset.veure));
  });
}

function formatData(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ca-ES');
}
function formatImport(n) {
  if (n == null) return '—';
  return `${Number(n).toFixed(2)} €`;
}
// Preus unitaris (p.ex. gasoil €/L) poden portar fins a 6 decimals reals.
// Es mostren traient zeros sobrants, amb un mínim de 2 decimals.
function formatPreuUnitari(n) {
  if (n == null) return '—';
  const num = Number(n);
  let s = num.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  if (!s.includes('.')) s += '.00';
  const decimals = s.split('.')[1]?.length ?? 0;
  if (decimals < 2) s = num.toFixed(2);
  return `${s} €`;
}

// -----------------------------------------------------------------------
// Modal — Nova factura (bloc A, minimalista, per crear la capçalera)
// -----------------------------------------------------------------------

function obrirModalNovaFactura() {
  openModal({
    title: 'Nova factura rebuda',
    bodyHtml: `
      ${htmlSeccioA(null)}
      <button type="button" id="btn-crear-factura" style="background:var(--gaco-accent); color:#fff; border:none; border-radius:var(--gaco-radius); padding:8px 14px; cursor:pointer;">
        Crear factura i continuar
      </button>
      <p style="font-size:12px; color:var(--gaco-text-secondary); margin-top:8px;">
        Un cop creada podràs afegir-hi línies, venciment i forma de pagament.
      </p>
    `,
    onMount: (body) => {
      body.querySelector('#btn-crear-factura').addEventListener('click', () => crearFacturaDesDeModal(body));
    },
  });
}

async function crearFacturaDesDeModal(body) {
  const nomProveidorText = body.querySelector('#m-proveidor').value.trim();
  const proveidorTrobat = proveidorsCache.find((p) => p.nom === nomProveidorText);
  const dataFactura = body.querySelector('#m-data-factura').value;

  if (!dataFactura) return alert('Cal indicar la data de factura.');
  if (!proveidorTrobat && !nomProveidorText) return alert('Cal indicar un proveïdor o un nom.');

  const nova = {
    tipus_factura: body.querySelector('#m-tipus-factura').value,
    proveidor_id: proveidorTrobat?.id ?? null,
    contrapart_nom: proveidorTrobat ? null : nomProveidorText,
    num_factura: body.querySelector('#m-num-factura').value.trim() || null,
    data_factura: dataFactura,
    data_recepcio: body.querySelector('#m-data-recepcio').value || null,
    activitat: body.querySelector('#m-activitat').value || null,
    exercici: Number(body.querySelector('#m-exercici').value) || new Date(dataFactura).getFullYear(),
    imprevist: body.querySelector('#m-imprevist').checked,
    confirming_id: null,
    estat: 'pendent',
  };

  const { data, error } = await supabase.from('gaco_factures_rebudes').insert(nova).select().single();
  if (error) return alert(`Error creant la factura: ${error.message}`);

  await carregarLlista();
  obrirModalFactura(data.id);
}

// -----------------------------------------------------------------------
// Modal — Veure/Editar factura completa (A + B línies + C venciment/pagament)
// -----------------------------------------------------------------------

async function obrirModalFactura(id) {
  const { data: f, error } = await supabase
    .from('gaco_factures_rebudes')
    .select('*, proveidor:gaco_proveidors(nom)')
    .eq('id', id)
    .single();

  if (error) return alert(`Error carregant la factura: ${error.message}`);

  openModal({
    title: `Factura · ${f.proveidor?.nom ?? f.contrapart_nom ?? '—'}`,
    wide: true,
    bodyHtml: `
      ${htmlSeccioA(f)}
      ${htmlSeccioB()}
      ${htmlSeccioC(f)}
      <button type="button" id="btn-desar-factura" style="background:var(--gaco-accent); color:#fff; border:none; border-radius:var(--gaco-radius); padding:8px 14px; cursor:pointer;">
        Desar canvis
      </button>
    `,
    onMount: (body) => vincularModalFactura(body, f),
  });
}

function camp(label, inputHtml) {
  return `
    <label style="font-size:12px; color:var(--gaco-text-secondary); display:flex; flex-direction:column; gap:2px; flex:1; min-width:120px;">
      ${label}
      ${inputHtml}
    </label>
  `;
}

function htmlSeccioA(f) {
  const provNom = f?.proveidor?.nom ?? f?.contrapart_nom ?? '';
  return `
    <div class="modal-section">
      <p class="modal-section-title">A · Dades de la factura</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        ${camp('Tipus', `<select id="m-tipus-factura">${TIPUS_FACTURA.map((t) => `<option value="${t}" ${f?.tipus_factura === t ? 'selected' : ''}>${t === 'factura' ? 'Factura' : 'Despesa'}</option>`).join('')}</select>`)}
        ${camp('Proveïdor', `<input type="text" id="m-proveidor" list="dl-proveidors" placeholder="Nom lliure si no és un proveïdor donat d'alta" value="${provNom}" style="min-width:200px;" />`)}
        ${camp('Núm. factura proveïdor', `<input type="text" id="m-num-factura" value="${f?.num_factura ?? ''}" />`)}
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        ${camp('Data factura', `<input type="date" id="m-data-factura" required value="${f?.data_factura ?? ''}" />`)}
        ${camp('Data recepció', `<input type="date" id="m-data-recepcio" value="${f?.data_recepcio ?? ''}" />`)}
        ${camp('Activitat', `<select id="m-activitat"><option value="">Selecciona...</option>${ACTIVITATS.map((a) => `<option value="${a}" ${f?.activitat === a ? 'selected' : ''}>${a}</option>`).join('')}</select>`)}
        ${camp('Exercici', `<input type="number" id="m-exercici" value="${f?.exercici ?? ANY_ACTUAL}" style="width:100px;" />`)}
      </div>
      <label style="display:flex; align-items:center; gap:6px; font-size:13px;">
        <input type="checkbox" id="m-imprevist" ${f?.imprevist ? 'checked' : ''} />
        Imprevist / puntual
      </label>
    </div>
  `;
}

function htmlSeccioB() {
  return `
    <div class="modal-section">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:4px;">
        <p class="modal-section-title" style="margin:0;">B · Línies</p>
        <p id="totals-linies" style="margin:0; font-size:12px; font-weight:500; color:var(--gaco-accent);"></p>
      </div>
      <div id="llista-linies" style="margin-bottom:12px;"></div>
      <form id="form-linia" style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end;">
        ${camp('Concepte', `<select id="ln-categoria" required style="min-width:200px;"><option value="">Selecciona...</option>${conceptesCache.map((c) => `<option value="${c.id}" data-tipus="${c.tipus}">${c.grup} · ${c.nom}</option>`).join('')}</select>`)}
        ${camp('Descripció', `<input type="text" id="ln-descripcio" style="min-width:160px;" />`)}
        ${camp('Quantitat', `<input type="number" step="0.01" id="ln-quantitat" value="1" style="width:90px;" />`)}
        ${camp('Preu unitari (€)', `<input type="number" step="0.000001" id="ln-preu" required style="width:130px;" />`)}
        <button type="button" id="ln-calc-toggle" style="align-self:flex-end; font-size:12px;" title="Calcular el preu unitari a partir de l'import total de la línia (útil quan la factura dona base imposable però no preu/unitat)">
          🧮 Calcula preu
        </button>
        ${camp('% descompte', `<input type="number" step="0.01" id="ln-descompte-pct" style="width:90px;" />`)}
        ${camp('% IVA', `<input type="number" step="0.01" id="ln-iva-pct" value="21" style="width:90px;" />`)}
        <div id="ln-bloc-suplit" style="display:none;">
          ${camp('Proveïdor del suplit', `<select id="ln-proveidor-suplit" style="min-width:160px;"><option value="">Selecciona...</option>${proveidorsCache.map((p) => `<option value="${p.id}">${p.nom}</option>`).join('')}</select>`)}
        </div>
        <div id="ln-bloc-immobilitzat" style="display:none;">
          ${camp('Immobilitzat', `<select id="ln-immobilitzat" style="min-width:160px;"><option value="">Selecciona...</option>${immobilitzatCache.map((m) => `<option value="${m.id}">${m.nom}</option>`).join('')}</select>`)}
        </div>
        <button type="submit">Afegir línia</button>

        <div id="ln-calc-bloc" style="display:none; gap:6px; align-items:flex-end; width:100%; padding-top:8px; border-top:1px dashed var(--gaco-border);">
          ${camp('Import de la línia sense IVA (€)', `<input type="number" step="0.01" id="ln-calc-import" style="width:150px;" placeholder="p.ex. base imposable del gasoil" />`)}
          <button type="button" id="ln-calc-aplicar">Aplica → preu unitari</button>
          <p style="margin:0; font-size:11px; color:var(--gaco-text-secondary);">Es divideix per la quantitat indicada a dalt.</p>
        </div>
      </form>
    </div>
  `;
}

function htmlSeccioC(f) {
  return `
    <div class="modal-section">
      <p class="modal-section-title">C · Venciment i pagament</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        ${camp('Data venciment', `<input type="date" id="m-data-venciment" value="${f?.data_venciment ?? ''}" />`)}
        ${camp('Forma de pagament', `<select id="m-forma-pagament"><option value="">Selecciona...</option>${FORMES_PAGAMENT.map((fp) => `<option value="${fp}" ${f?.forma_pagament === fp ? 'selected' : ''}>${fp}</option>`).join('')}</select>`)}
        <div id="m-bloc-compte" style="display:${f?.forma_pagament === 'compte_bancari' ? 'flex' : 'none'}; gap:8px; flex-wrap:wrap;">
          ${camp('Compte', `<select id="m-compte-bancari" style="min-width:180px;"><option value="">Selecciona...</option>${comptesCache.map((c) => `<option value="${c.id}" ${f?.compte_bancari_id === c.id ? 'selected' : ''}>${c.entitatNom} · ${c.descripcio ?? c.num_compte}</option>`).join('')}</select>`)}
          ${camp('Mètode', `<select id="m-metode-pagament-compte" style="min-width:150px;"><option value="">Selecciona...</option>${METODES_PAGAMENT_COMPTE.map((mp) => `<option value="${mp}" ${f?.metode_pagament_compte === mp ? 'selected' : ''}>${ETIQUETES_METODE_COMPTE[mp]}</option>`).join('')}</select>`)}
        </div>
        <div id="m-bloc-soci" style="display:${f?.forma_pagament === 'soci' ? 'flex' : 'none'};">
          ${camp('Soci', `<select id="m-soci" style="min-width:150px;"><option value="">Selecciona...</option>${socisCache.map((s) => `<option value="${s.id}" ${f?.soci_id === s.id ? 'selected' : ''}>${s.nom}</option>`).join('')}</select>`)}
        </div>
        <p id="m-confirming-nota" style="display:${f?.forma_pagament === 'confirming' ? 'block' : 'none'}; flex:1; min-width:150px; font-size:12px; color:var(--gaco-text-secondary); margin:0; align-self:center;">
          S'enllaçarà a la liquidació de confirming quan es tanqui el període (Finançament → Confirming).
        </p>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end; margin-bottom:8px;">
        ${camp('Estat', `<select id="m-estat" style="min-width:180px;">${ESTATS.map((e) => `<option value="${e}" ${(f?.estat ?? 'pendent') === e ? 'selected' : ''}>${ETIQUETES_ESTAT[e]}</option>`).join('')}</select>`)}
        ${camp('% IRPF', `<input type="number" step="0.01" id="m-irpf-pct" value="${f?.irpf_pct ?? ''}" style="width:100px;" />`)}
        ${camp('Import IRPF (€)', `<input type="number" step="0.01" id="m-irpf" value="${f?.irpf ?? ''}" style="width:120px;" />`)}
        <p style="margin:0; font-size:13px; color:var(--gaco-text-secondary); align-self:center;">
          Pagat: ${formatImport(f?.import_pagat)} · Pendent: ${formatImport(f?.import_pendent)}
        </p>
      </div>
      ${camp('Notes', `<textarea id="m-notes" style="width:100%; min-height:50px;">${f?.notes ?? ''}</textarea>`)}
    </div>
  `;
}

function vincularModalFactura(body, f) {
  body.querySelector('#m-forma-pagament').addEventListener('change', (e) => {
    body.querySelector('#m-bloc-compte').style.display = e.target.value === 'compte_bancari' ? 'flex' : 'none';
    body.querySelector('#m-bloc-soci').style.display = e.target.value === 'soci' ? 'flex' : 'none';
    body.querySelector('#m-confirming-nota').style.display = e.target.value === 'confirming' ? 'block' : 'none';
  });

  body.querySelector('#ln-categoria').addEventListener('change', (e) => {
    const tipus = e.target.selectedOptions[0]?.dataset.tipus;
    body.querySelector('#ln-bloc-suplit').style.display = tipus === 'suplits' ? 'block' : 'none';
    body.querySelector('#ln-bloc-immobilitzat').style.display = tipus === 'actiu' ? 'block' : 'none';
  });

  // Calculadora de preu unitari (import ÷ quantitat) — per a factures que
  // donen base imposable/litres però no el preu per unitat (p.ex. gasoil)
  body.querySelector('#ln-calc-toggle').addEventListener('click', () => {
    const bloc = body.querySelector('#ln-calc-bloc');
    bloc.style.display = bloc.style.display === 'none' ? 'flex' : 'none';
  });
  body.querySelector('#ln-calc-aplicar').addEventListener('click', () => {
    const importLinia = Number(body.querySelector('#ln-calc-import').value) || 0;
    const quantitat = Number(body.querySelector('#ln-quantitat').value) || 0;
    if (!quantitat) return alert('Cal indicar la quantitat (p.ex. litres) abans de calcular.');
    if (!importLinia) return alert("Cal indicar l'import de la línia.");
    const preu = importLinia / quantitat;
    body.querySelector('#ln-preu').value = preu.toFixed(6);
    body.querySelector('#ln-calc-import').value = '';
    body.querySelector('#ln-calc-bloc').style.display = 'none';
  });

  body.querySelector('#form-linia').addEventListener('submit', (e) => altaLinia(e, body, f.id));
  body.querySelector('#btn-desar-factura').addEventListener('click', () => desarCapcalera(body, f.id));

  carregarLinies(body, f.id);
}

async function desarCapcalera(body, facturaId) {
  const nomProveidorText = body.querySelector('#m-proveidor').value.trim();
  const proveidorTrobat = proveidorsCache.find((p) => p.nom === nomProveidorText);
  const formaPagament = body.querySelector('#m-forma-pagament').value || null;

  const actualitzat = {
    tipus_factura: body.querySelector('#m-tipus-factura').value,
    proveidor_id: proveidorTrobat?.id ?? null,
    contrapart_nom: proveidorTrobat ? null : (nomProveidorText || null),
    num_factura: body.querySelector('#m-num-factura').value.trim() || null,
    data_factura: body.querySelector('#m-data-factura').value,
    data_recepcio: body.querySelector('#m-data-recepcio').value || null,
    activitat: body.querySelector('#m-activitat').value || null,
    exercici: Number(body.querySelector('#m-exercici').value) || null,
    imprevist: body.querySelector('#m-imprevist').checked,
    data_venciment: body.querySelector('#m-data-venciment').value || null,
    forma_pagament: formaPagament,
    compte_bancari_id: formaPagament === 'compte_bancari' ? (body.querySelector('#m-compte-bancari').value || null) : null,
    metode_pagament_compte: formaPagament === 'compte_bancari' ? (body.querySelector('#m-metode-pagament-compte').value || null) : null,
    soci_id: formaPagament === 'soci' ? (body.querySelector('#m-soci').value || null) : null,
    estat: body.querySelector('#m-estat').value,
    irpf_pct: body.querySelector('#m-irpf-pct').value ? Number(body.querySelector('#m-irpf-pct').value) : null,
    irpf: body.querySelector('#m-irpf').value ? Number(body.querySelector('#m-irpf').value) : null,
    notes: body.querySelector('#m-notes').value.trim() || null,
  };

  const { error } = await supabase.from('gaco_factures_rebudes').update(actualitzat).eq('id', facturaId);
  if (error) return alert(`Error desant: ${error.message}`);

  // Recalcular el total per si l'IRPF ha canviat (base/iva/suplits ja estan al dia per les línies)
  const { data: linies } = await supabase
    .from('gaco_detall_factures_rebudes')
    .select('*, categoria:gaco_conceptes_comptables(tipus)')
    .eq('factura_id', facturaId);
  await recalcularCapcalera(facturaId, linies ?? []);

  closeModal();
  await carregarLlista();
}

// -----------------------------------------------------------------------
// Línies de detall (gaco_detall_factures_rebudes)
// -----------------------------------------------------------------------

async function carregarLinies(body, facturaId) {
  const contenidor = body.querySelector('#llista-linies');
  contenidor.innerHTML = '<p>Carregant línies...</p>';

  const { data, error } = await supabase
    .from('gaco_detall_factures_rebudes')
    .select('*, categoria:gaco_conceptes_comptables(grup, nom, tipus), proveidor_suplit:gaco_proveidors(nom), immobilitzat:gaco_immobilitzat(nom)')
    .eq('factura_id', facturaId)
    .order('created_at');

  if (error) {
    contenidor.innerHTML = `<p class="error">Error carregant línies: ${error.message}</p>`;
    return;
  }

  pintarLinies(body, facturaId, data ?? []);
  await recalcularCapcalera(facturaId, data ?? []);
}

function pintarLinies(body, facturaId, linies) {
  const contenidor = body.querySelector('#llista-linies');

  if (linies.length === 0) {
    contenidor.innerHTML = '<p style="color:var(--gaco-text-secondary); font-size:13px;">Encara no hi ha línies.</p>';
    return;
  }

  contenidor.innerHTML = linies
    .map(
      (l) => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-top:0.5px solid var(--gaco-border); font-size:13px;">
      <div>
        <span>${l.categoria?.grup ?? '—'} · ${l.categoria?.nom ?? '—'}</span>
        ${l.descripcio ? ` — ${l.descripcio}` : ''}
        <span style="color:var(--gaco-text-secondary);"> · ${l.quantitat ?? 1} × ${formatPreuUnitari(l.preu_unitari)}</span>
        ${l.descompte_pct ? `<span style="color:var(--gaco-text-secondary);"> · Desc. ${l.descompte_pct}% (-${formatImport(l.import_descompte)})</span>` : ''}
        ${l.categoria?.tipus === 'suplits' ? `<span style="color:var(--gaco-accent);"> · suplit${l.proveidor_suplit?.nom ? ` (${l.proveidor_suplit.nom})` : ''}</span>` : ''}
        ${l.immobilitzat?.nom ? `<span style="color:var(--gaco-accent);"> · ${l.immobilitzat.nom}</span>` : ''}
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span>${formatImport(l.total_linia)} ${l.categoria?.tipus !== 'suplits' ? `+ ${formatImport(l.iva)} IVA` : ''}</span>
        <button data-eliminar-linia="${l.id}" title="Eliminar línia">✕</button>
      </div>
    </div>
  `
    )
    .join('');

  contenidor.querySelectorAll('[data-eliminar-linia]').forEach((btn) => {
    btn.addEventListener('click', () => eliminarLinia(btn.dataset.eliminarLinia, body, facturaId));
  });
}

async function altaLinia(e, body, facturaId) {
  e.preventDefault();

  const categoriaSelect = body.querySelector('#ln-categoria');
  const categoriaId = categoriaSelect.value;
  const categoria = conceptesCache.find((c) => c.id === categoriaId);
  const quantitat = Number(body.querySelector('#ln-quantitat').value) || 1;
  const preuUnitari = Number(body.querySelector('#ln-preu').value) || 0;
  const descomptePct = Number(body.querySelector('#ln-descompte-pct').value) || 0;
  const ivaPct = Number(body.querySelector('#ln-iva-pct').value) || 0;

  const importBase = quantitat * preuUnitari;
  const importDescompte = importBase * (descomptePct / 100);
  const totalLinia = importBase - importDescompte;
  // Suplits: import passat íntegre (ja porta el seu propi IVA de qui l'ha avançat), no en calculem IVA propi
  const iva = categoria?.tipus === 'suplits' ? 0 : totalLinia * (ivaPct / 100);

  if (!categoriaId) return alert('Cal triar un concepte.');

  const novaLinia = {
    factura_id: facturaId,
    categoria_id: categoriaId,
    descripcio: body.querySelector('#ln-descripcio').value.trim() || null,
    quantitat,
    preu_unitari: preuUnitari,
    descompte_pct: descomptePct || null,
    import_base: importBase,
    import_descompte: importDescompte || null,
    total_linia: totalLinia,
    iva_pct: categoria?.tipus === 'suplits' ? null : ivaPct,
    iva,
    proveidor_suplit_id: categoria?.tipus === 'suplits' ? (body.querySelector('#ln-proveidor-suplit').value || null) : null,
    immobilitzat_id: categoria?.tipus === 'actiu' ? (body.querySelector('#ln-immobilitzat').value || null) : null,
  };

  const { error } = await supabase.from('gaco_detall_factures_rebudes').insert(novaLinia);
  if (error) return alert(`Error afegint línia: ${error.message}`);

  // Reinicia els camps de la línia PERÒ manté el concepte seleccionat — sovint
  // s'afegeixen diverses línies seguides del mateix concepte (p.ex. varies
  // nòmines "Serveis professionals - Laboral" una darrere l'altra).
  body.querySelector('#ln-descripcio').value = '';
  body.querySelector('#ln-quantitat').value = 1;
  body.querySelector('#ln-preu').value = '';
  body.querySelector('#ln-descompte-pct').value = '';
  body.querySelector('#ln-iva-pct').value = ivaPct || 21;
  // Els selectors de suplit/immobilitzat sí que es netegen (no volem
  // arrossegar per error el mateix immobilitzat/proveïdor a la línia següent)
  const selectSuplit = body.querySelector('#ln-proveidor-suplit');
  const selectImmobilitzat = body.querySelector('#ln-immobilitzat');
  if (selectSuplit) selectSuplit.value = '';
  if (selectImmobilitzat) selectImmobilitzat.value = '';

  await carregarLinies(body, facturaId);
  body.querySelector('#ln-preu').focus();
}

async function eliminarLinia(liniaId, body, facturaId) {
  if (!confirm('Eliminar aquesta línia?')) return;
  const { error } = await supabase.from('gaco_detall_factures_rebudes').delete().eq('id', liniaId);
  if (error) return alert(`Error eliminant línia: ${error.message}`);
  await carregarLinies(body, facturaId);
}

// -----------------------------------------------------------------------
// Recàlcul de capçalera a partir de les línies (base_imposable/iva/suplits/total)
// -----------------------------------------------------------------------

async function recalcularCapcalera(facturaId, linies) {
  let baseImposable = 0;
  let iva = 0;
  let suplits = 0;

  for (const l of linies) {
    if (l.categoria?.tipus === 'suplits') {
      suplits += Number(l.total_linia) || 0;
    } else {
      baseImposable += Number(l.total_linia) || 0;
      iva += Number(l.iva) || 0;
    }
  }

  const { data: capcalera } = await supabase.from('gaco_factures_rebudes').select('irpf, import_pagat').eq('id', facturaId).single();
  const irpf = Number(capcalera?.irpf) || 0;
  const total = baseImposable + iva - irpf + suplits;
  const importPagat = Number(capcalera?.import_pagat) || 0;
  const importPendent = total - importPagat;

  const totalsEl = document.getElementById('totals-linies');
  if (totalsEl) {
    totalsEl.textContent = `Base: ${formatImport(baseImposable)} · IVA: ${formatImport(iva)} · Suplits: ${formatImport(suplits)} · IRPF: ${formatImport(irpf)} · Total: ${formatImport(total)}`;
  }

  const { error } = await supabase
    .from('gaco_factures_rebudes')
    .update({ base_imposable: baseImposable, iva, suplits, total, import_pendent: importPendent })
    .eq('id', facturaId);

  if (error) console.error('Error actualitzant totals de capçalera:', error);
}

// -----------------------------------------------------------------------
// Exportació PDF (del resultat filtrat actual, no de tota la taula)
// -----------------------------------------------------------------------

let jsPdfCarregat = false;

async function carregarJsPdf() {
  if (jsPdfCarregat) return;
  await Promise.all([
    carregarScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'),
    carregarScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'),
  ]);
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

async function exportarPdf() {
  if (resultatActual.length === 0) return alert('No hi ha resultats per exportar.');
  await carregarJsPdf();

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFontSize(14);
  doc.text('Factures rebudes', 14, 15);
  doc.setFontSize(9);
  doc.text(`Generat: ${new Date().toLocaleString('ca-ES')}`, 14, 21);
  doc.text(descripcioFiltreActiu(), 14, 26);

  const files = resultatActual.map((f) => [
    formatData(f.data_factura),
    f.num_factura ?? '—',
    f.proveidor?.nom ?? f.contrapart_nom ?? '—',
    formatImport(f.base_imposable),
    formatImport(f.iva),
    formatImport(f.suplits),
    formatImport(f.total),
    ETIQUETES_ESTAT[f.estat] ?? f.estat,
  ]);

  const sumar = (camp) => resultatActual.reduce((acc, f) => acc + (Number(f[camp]) || 0), 0);

  doc.autoTable({
    startY: 32,
    head: [['Data', 'Núm.', 'Proveïdor', 'Base', 'IVA', 'Suplits', 'Total', 'Estat']],
    body: files,
    foot: [['', '', 'TOTALS', formatImport(sumar('base_imposable')), formatImport(sumar('iva')), formatImport(sumar('suplits')), formatImport(sumar('total')), '']],
    styles: { fontSize: 8 },
    headStyles: { fillColor: [136, 0, 27] }, // granat GACO
  });

  doc.save(`factures-rebudes-${filtre.exercici ?? 'tots'}.pdf`);
}

function descripcioFiltreActiu() {
  const parts = [];
  parts.push(`Exercici: ${filtre.exercici ?? 'Tots'}`);
  if (filtre.proveidorId || filtre.contrapartText) {
    const nom = filtre.proveidorId ? proveidorsCache.find((p) => p.id === filtre.proveidorId)?.nom : filtre.contrapartText;
    parts.push(`Proveïdor: ${nom}`);
  }
  if (filtre.estats.length) parts.push(`Estat: ${filtre.estats.map((e) => ETIQUETES_ESTAT[e]).join(', ')}`);
  if (filtre.dataFacturaDes || filtre.dataFacturaFins) {
    parts.push(`Data factura: ${filtre.dataFacturaDes ?? '...'} — ${filtre.dataFacturaFins ?? '...'}`);
  }
  return parts.join(' · ');
}
