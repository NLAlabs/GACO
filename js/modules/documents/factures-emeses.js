import { supabase } from '../../lib/supabaseClient.js';
import { openModal, closeModal } from '../../lib/modal.js';

/**
 * Documents → Factures emeses.
 * Cobreix 5 tipus_document sota una sola capçalera (gaco_factures_emeses):
 *   - prestacio_serveis / pressupost / ingres_extraordinari → línies
 *     genèriques (gaco_detall_factures_emeses), estructuralment com rebudes.
 *   - bestreta_agraria / liquidacio_agraria → productes per fruita/varietat
 *     (gaco_liquidacio_productes + gaco_detall_liquidacio_producte).
 *     PENDENT: aquesta primera versió només fa el bloc A (dades) d'aquests
 *     dos tipus; el bloc de productes és una propera iteració.
 *
 * "+ Nova factura" obre primer un selector dels 5 tipus, després el bloc A
 * adaptat a la selecció (bestreta/liquidació necessiten número de document
 * de la Cooperativa i codi propi de soci/proveïdor).
 *
 * Confirming: el cobrament real es registra a gaco_cobraments_factures_emeses
 * (origen='confirming_client' + import_descompte_confirming + confirming_id
 * opcional cap a la liquidació periòdica de gaco_confirming) — no hi ha cap
 * "forma de pagament" a la capçalera, a diferència de rebudes.
 *
 * Fitxers: fitxer_pdf_url/fitxer_xml_url són camps ÚNICS a la capçalera
 * (no una llista d'adjunts com a rebudes) — pugen a Storage bucket
 * 'gaco-adjunts', carpeta 'emeses/{factura_id}/'.
 *
 * gaco_clients: assumeixo id, nom, actiu (mateix patró que gaco_proveidors,
 * sense confirmar l'esquema real encara).
 */

const TIPUS_DOCUMENT_INFO = {
  prestacio_serveis: { label: 'Prestació de serveis', descripcio: 'Factura de serveis (moviments de terra, etc.) amb línies de concepte.' },
  pressupost: { label: 'Pressupost / proforma', descripcio: 'Oferta prèvia al client, encara no és una factura emesa.' },
  ingres_extraordinari: { label: 'Ingrés extraordinari', descripcio: 'Ingrés puntual sense document formal (p.ex. retorn Fons Adversitat).' },
  bestreta_agraria: { label: 'Bestreta agrària', descripcio: 'Avançament de la Cooperativa sobre collita. Bloc de productes: pendent.' },
  liquidacio_agraria: { label: 'Liquidació agrària', descripcio: 'Liquidació final de la Cooperativa. Bloc de productes: pendent.' },
};
const TIPUS_DOCUMENT = Object.keys(TIPUS_DOCUMENT_INFO);
const TIPUS_AMB_LINIES = ['prestacio_serveis', 'pressupost', 'ingres_extraordinari'];
const TIPUS_AGRARIS = ['bestreta_agraria', 'liquidacio_agraria'];

const ESTATS = ['esborrany', 'pressupost_enviat', 'pressupost_acceptat', 'emesa', 'cobrada_parcial', 'cobrada', 'impagada'];
const ESTATS_NO_AUTOACTUALITZAR = ['esborrany', 'pressupost_enviat', 'pressupost_acceptat'];
const ACTIVITATS = ['fruita_cereal', 'serveis', 'comuna'];
const ORIGENS_COBRAMENT = ['transferencia', 'confirming_client'];
const BUCKET_ADJUNTS = 'gaco-adjunts';

const ETIQUETES_ESTAT = {
  esborrany: 'Esborrany',
  pressupost_enviat: 'Pressupost enviat',
  pressupost_acceptat: 'Pressupost acceptat',
  emesa: 'Emesa',
  cobrada_parcial: 'Cobrada parcial',
  cobrada: 'Cobrada',
  impagada: 'Impagada',
};

const ANY_ACTUAL = new Date().getFullYear();

let clientsCache = [];
let conceptesCache = [];
let comptesCache = [];
let catalogServeisCache = [];
let confirmingCache = [];

let resultatActual = [];

const filtre = {
  exercici: ANY_ACTUAL,
  clientId: null,
  contrapartText: '',
  categoriaId: null,
  dataDocumentDes: null,
  dataDocumentFins: null,
  dataVencDes: null,
  dataVencFins: null,
  importDes: null,
  importFins: null,
  estats: [],
  tipusDocument: [],
};

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant factures emeses...</p>';

  await carregarDadesSuport();

  contenidor.innerHTML = `
    <datalist id="dl-clients">
      ${clientsCache.map((c) => `<option value="${c.nom}" data-id="${c.id}"></option>`).join('')}
    </datalist>

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
        <p style="font-weight:500; margin:0;">Factures emeses (<span id="comptador-factures">0</span>)</p>
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
        <input type="text" id="f-client" list="dl-clients" placeholder="Client..." style="min-width:180px;" />
        <select id="f-categoria" style="min-width:180px;">
          <option value="">Concepte...</option>
          ${conceptesCache.map((c) => `<option value="${c.id}">${c.grup} · ${c.nom}</option>`).join('')}
        </select>
        <span style="font-size:12px; color:var(--gaco-text-secondary); align-self:center;">Data document:</span>
        <input type="date" id="f-data-doc-des" style="min-width:130px;" />
        <input type="date" id="f-data-doc-fins" style="min-width:130px;" />
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
          ${TIPUS_DOCUMENT.map((t) => `
            <label style="font-size:12px; display:flex; align-items:center; gap:3px;">
              <input type="checkbox" class="chk-tipus" value="${t}" /> ${TIPUS_DOCUMENT_INFO[t].label}
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
  document.getElementById('btn-nova-factura').addEventListener('click', obrirModalSelectorTipus);

  restaurarFiltresAlFormulari();
  await carregarLlista();
}

async function carregarDadesSuport() {
  const [{ data: clients }, { data: conceptes }, { data: comptes }, { data: catalogServeis }, { data: confirming }] = await Promise.all([
    supabase.from('gaco_clients').select('id, nom').eq('actiu', true).order('nom'),
    supabase.from('gaco_conceptes_comptables').select('id, grup, nom').eq('actiu', true).order('grup'),
    supabase.from('gaco_comptes').select('id, descripcio, num_compte, entitat:gaco_entitats_bancaries(nom)').eq('actiu', true),
    supabase.from('gaco_catalog_serveis').select('id, nom, preu_unitari, iva_pct').eq('actiu', true).order('nom'),
    supabase.from('gaco_confirming').select('id, periode_inici, periode_fi, entitat:gaco_entitats_bancaries(nom)').order('periode_inici', { ascending: false }),
  ]);
  clientsCache = clients ?? [];
  conceptesCache = conceptes ?? [];
  comptesCache = (comptes ?? []).map((c) => ({ ...c, entitatNom: c.entitat?.nom ?? '' }));
  catalogServeisCache = catalogServeis ?? [];
  confirmingCache = (confirming ?? []).map((c) => ({ ...c, entitatNom: c.entitat?.nom ?? '' }));
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
  const nomClient = document.getElementById('f-client').value.trim();
  const clientTrobat = clientsCache.find((c) => c.nom === nomClient);
  filtre.clientId = clientTrobat?.id ?? null;
  filtre.contrapartText = clientTrobat ? '' : nomClient;
  filtre.categoriaId = document.getElementById('f-categoria').value || null;
  filtre.dataDocumentDes = document.getElementById('f-data-doc-des').value || null;
  filtre.dataDocumentFins = document.getElementById('f-data-doc-fins').value || null;
  filtre.dataVencDes = document.getElementById('f-data-venc-des').value || null;
  filtre.dataVencFins = document.getElementById('f-data-venc-fins').value || null;
  filtre.importDes = document.getElementById('f-import-des').value ? Number(document.getElementById('f-import-des').value) : null;
  filtre.importFins = document.getElementById('f-import-fins').value ? Number(document.getElementById('f-import-fins').value) : null;
  filtre.estats = [...document.querySelectorAll('.chk-estat:checked')].map((c) => c.value);
  filtre.tipusDocument = [...document.querySelectorAll('.chk-tipus:checked')].map((c) => c.value);
}

function restaurarFiltresAlFormulari() {
  if (filtre.contrapartText) document.getElementById('f-client').value = filtre.contrapartText;
  else if (filtre.clientId) {
    const c = clientsCache.find((c) => c.id === filtre.clientId);
    if (c) document.getElementById('f-client').value = c.nom;
  }
  if (filtre.categoriaId) document.getElementById('f-categoria').value = filtre.categoriaId;
  if (filtre.dataDocumentDes) document.getElementById('f-data-doc-des').value = filtre.dataDocumentDes;
  if (filtre.dataDocumentFins) document.getElementById('f-data-doc-fins').value = filtre.dataDocumentFins;
  if (filtre.dataVencDes) document.getElementById('f-data-venc-des').value = filtre.dataVencDes;
  if (filtre.dataVencFins) document.getElementById('f-data-venc-fins').value = filtre.dataVencFins;
  if (filtre.importDes != null) document.getElementById('f-import-des').value = filtre.importDes;
  if (filtre.importFins != null) document.getElementById('f-import-fins').value = filtre.importFins;
  document.querySelectorAll('.chk-estat').forEach((c) => (c.checked = filtre.estats.includes(c.value)));
  document.querySelectorAll('.chk-tipus').forEach((c) => (c.checked = filtre.tipusDocument.includes(c.value)));
}

function netejarFiltres() {
  filtre.exercici = ANY_ACTUAL;
  filtre.clientId = null;
  filtre.contrapartText = '';
  filtre.categoriaId = null;
  filtre.dataDocumentDes = null;
  filtre.dataDocumentFins = null;
  filtre.dataVencDes = null;
  filtre.dataVencFins = null;
  filtre.importDes = null;
  filtre.importFins = null;
  filtre.estats = [];
  filtre.tipusDocument = [];
}

async function carregarLlista() {
  const contenidor = document.getElementById('llista-factures');
  contenidor.innerHTML = '<p>Cercant...</p>';

  let query = supabase.from('gaco_factures_emeses').select('*, client:gaco_clients(nom)').order('data_document', { ascending: false });

  if (filtre.exercici != null) query = query.eq('exercici', filtre.exercici);
  if (filtre.clientId) query = query.eq('client_id', filtre.clientId);
  if (filtre.contrapartText) query = query.ilike('contrapart_nom', `%${filtre.contrapartText}%`);
  if (filtre.dataDocumentDes) query = query.gte('data_document', filtre.dataDocumentDes);
  if (filtre.dataDocumentFins) query = query.lte('data_document', filtre.dataDocumentFins);
  if (filtre.dataVencDes) query = query.gte('data_venciment', filtre.dataVencDes);
  if (filtre.dataVencFins) query = query.lte('data_venciment', filtre.dataVencFins);
  if (filtre.importDes != null) query = query.gte('total', filtre.importDes);
  if (filtre.importFins != null) query = query.lte('total', filtre.importFins);
  if (filtre.estats.length) query = query.in('estat', filtre.estats);
  if (filtre.tipusDocument.length) query = query.in('tipus_document', filtre.tipusDocument);

  if (filtre.categoriaId) {
    const { data: linies } = await supabase
      .from('gaco_detall_factures_emeses')
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
        <p style="margin:0; font-weight:500;">${f.client?.nom ?? f.contrapart_nom ?? '—'}</p>
        <p style="margin:2px 0 0; font-size:12px; color:var(--gaco-text-secondary);">
          Data: ${formatData(f.data_document)} · Núm.: ${f.num_document ?? '—'} · ${TIPUS_DOCUMENT_INFO[f.tipus_document]?.label ?? f.tipus_document}
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

function camp(label, inputHtml) {
  return `
    <label style="font-size:12px; color:var(--gaco-text-secondary); display:flex; flex-direction:column; gap:2px; flex:1; min-width:120px;">
      ${label}
      ${inputHtml}
    </label>
  `;
}

// -----------------------------------------------------------------------
// Selector de tipus de document → bloc A adaptat → crear capçalera
// -----------------------------------------------------------------------

function obrirModalSelectorTipus() {
  openModal({
    title: 'Nova factura emesa',
    bodyHtml: `
      <div class="modal-section">
        <p class="modal-section-title">Quin tipus de document vols crear?</p>
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${TIPUS_DOCUMENT.map(
            (t) => `
            <button type="button" class="btn-tipus-document" data-tipus="${t}" style="text-align:left; padding:12px; border:1px solid var(--gaco-border); border-radius:var(--gaco-radius); background:#fff; cursor:pointer;">
              <strong>${TIPUS_DOCUMENT_INFO[t].label}</strong><br/>
              <span style="font-size:12px; color:var(--gaco-text-secondary);">${TIPUS_DOCUMENT_INFO[t].descripcio}</span>
            </button>`
          ).join('')}
        </div>
      </div>
    `,
    onMount: (body) => {
      body.querySelectorAll('.btn-tipus-document').forEach((btn) => {
        btn.addEventListener('click', () => obrirModalNovaFacturaTipus(btn.dataset.tipus));
      });
    },
  });
}

function obrirModalNovaFacturaTipus(tipus) {
  openModal({
    title: `Nova factura · ${TIPUS_DOCUMENT_INFO[tipus].label}`,
    bodyHtml: `
      ${htmlSeccioA(tipus, null)}
      <button type="button" id="btn-crear-factura" style="background:var(--gaco-accent); color:#fff; border:none; border-radius:var(--gaco-radius); padding:8px 14px; cursor:pointer;">
        Crear factura i continuar
      </button>
    `,
    onMount: (body) => {
      body.querySelector('#btn-crear-factura').addEventListener('click', () => crearFacturaDesDeModal(body, tipus));
    },
  });
}

async function crearFacturaDesDeModal(body, tipus) {
  const nomClientText = body.querySelector('#m-client').value.trim();
  const clientTrobat = clientsCache.find((c) => c.nom === nomClientText);
  const dataDocument = body.querySelector('#m-data-document').value;

  if (!dataDocument) return alert('Cal indicar la data del document.');
  if (!clientTrobat && !nomClientText && tipus !== 'ingres_extraordinari') {
    return alert('Cal indicar un client o un nom.');
  }

  const nova = {
    tipus_document: tipus,
    client_id: clientTrobat?.id ?? null,
    contrapart_nom: clientTrobat ? null : (nomClientText || null),
    data_document: dataDocument,
    activitat: body.querySelector('#m-activitat').value || null,
    exercici: Number(body.querySelector('#m-exercici').value) || new Date(dataDocument).getFullYear(),
    imprevist: body.querySelector('#m-imprevist')?.checked ?? false,
    num_document: body.querySelector('#m-num-document')?.value.trim() || null,
    estat: 'esborrany',
  };

  if (TIPUS_AGRARIS.includes(tipus)) {
    nova.proveidor_codi = body.querySelector('#m-proveidor-codi')?.value.trim() || null;
    nova.num_fac_proveedor = body.querySelector('#m-num-fac-proveedor')?.value.trim() || null;
    if (tipus === 'liquidacio_agraria') {
      const fonsAdversitat = body.querySelector('#m-fons-adversitat')?.value;
      nova.import_fons_adversitat = fonsAdversitat ? Number(fonsAdversitat) : null;
    }
  }

  const { data, error } = await supabase.from('gaco_factures_emeses').insert(nova).select().single();
  if (error) return alert(`Error creant la factura: ${error.message}`);

  await carregarLlista();
  obrirModalFactura(data.id);
}

// -----------------------------------------------------------------------
// Modal — Veure/Editar factura completa
// -----------------------------------------------------------------------

async function obrirModalFactura(id) {
  const { data: f, error } = await supabase
    .from('gaco_factures_emeses')
    .select('*, client:gaco_clients(nom)')
    .eq('id', id)
    .single();

  if (error) return alert(`Error carregant la factura: ${error.message}`);

  const teLinies = TIPUS_AMB_LINIES.includes(f.tipus_document);

  openModal({
    title: `${TIPUS_DOCUMENT_INFO[f.tipus_document]?.label ?? f.tipus_document} · ${f.client?.nom ?? f.contrapart_nom ?? '—'}`,
    wide: true,
    bodyHtml: `
      ${htmlSeccioA(f.tipus_document, f)}
      ${teLinies ? htmlSeccioB() : htmlSeccioBProductes()}
      ${htmlSeccioC(f)}
      <button type="button" id="btn-desar-factura" style="background:var(--gaco-accent); color:#fff; border:none; border-radius:var(--gaco-radius); padding:8px 14px; cursor:pointer;">
        Desar canvis
      </button>
      ${htmlSeccioD(f)}
    `,
    onMount: (body) => vincularModalFactura(body, f, teLinies),
  });
}

function htmlSeccioA(tipus, f) {
  const nomClient = f?.client?.nom ?? f?.contrapart_nom ?? '';
  const esAgrari = TIPUS_AGRARIS.includes(tipus);

  return `
    <div class="modal-section">
      <p class="modal-section-title">A · Dades del document</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        ${camp('Client', `<input type="text" id="m-client" list="dl-clients" placeholder="Nom lliure si no és un client donat d'alta" value="${nomClient}" style="min-width:200px;" />`)}
        ${camp('Data document', `<input type="date" id="m-data-document" required value="${f?.data_document ?? ''}" />`)}
        ${camp('Activitat', `<select id="m-activitat"><option value="">Selecciona...</option>${ACTIVITATS.map((a) => `<option value="${a}" ${f?.activitat === a ? 'selected' : ''}>${a}</option>`).join('')}</select>`)}
        ${camp('Exercici', `<input type="number" id="m-exercici" value="${f?.exercici ?? ANY_ACTUAL}" style="width:100px;" />`)}
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        ${camp(esAgrari ? 'Núm. document (Cooperativa)' : 'Núm. document propi', `<input type="text" id="m-num-document" value="${f?.num_document ?? ''}" />`)}
        ${esAgrari ? camp('Codi propi (soci/proveïdor)', `<input type="text" id="m-proveidor-codi" value="${f?.proveidor_codi ?? ''}" />`) : ''}
        ${esAgrari ? camp('Núm. factura Cooperativa', `<input type="text" id="m-num-fac-proveedor" value="${f?.num_fac_proveedor ?? ''}" />`) : ''}
        ${tipus === 'liquidacio_agraria' ? camp('Fons Adversitat (€, només fruita)', `<input type="number" step="0.01" id="m-fons-adversitat" value="${f?.import_fons_adversitat ?? ''}" />`) : ''}
      </div>
      ${
        !esAgrari
          ? `<label style="display:flex; align-items:center; gap:6px; font-size:13px;">
              <input type="checkbox" id="m-imprevist" ${f?.imprevist ? 'checked' : ''} />
              Imprevist / puntual
            </label>`
          : ''
      }
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
      <form id="form-linia">
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
          <div style="flex:1; min-width:200px;">
            ${camp('Servei del catàleg (opcional)', `<select id="ln-catalog-servei" style="width:100%;"><option value="">Cap...</option>${catalogServeisCache.map((s) => `<option value="${s.id}" data-preu="${s.preu_unitari ?? ''}" data-iva="${s.iva_pct ?? ''}">${s.nom}</option>`).join('')}</select>`)}
          </div>
          <div style="flex:1; min-width:200px;">
            ${camp('Concepte', `<select id="ln-categoria" required style="width:100%;"><option value="">Selecciona...</option>${conceptesCache.map((c) => `<option value="${c.id}">${c.grup} · ${c.nom}</option>`).join('')}</select>`)}
          </div>
          <div style="flex:2; min-width:260px;">
            ${camp('Descripció', `<input type="text" id="ln-concepte-text" maxlength="300" style="width:100%;" />`)}
          </div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end;">
          ${camp('Quantitat', `<input type="number" step="0.01" id="ln-quantitat" value="1" style="width:90px;" />`)}
          ${camp('Preu unitari (€)', `<input type="number" step="0.000001" id="ln-preu" required style="width:130px;" />`)}
          ${camp('% IVA', `<input type="number" step="0.01" id="ln-iva-pct" value="21" style="width:90px;" />`)}
          <button type="submit">Afegir línia</button>
        </div>
      </form>
    </div>
  `;
}

// -----------------------------------------------------------------------
// Bloc B alternatiu — Productes (bestreta_agraria / liquidacio_agraria)
// Fruita: línies per qualitat/calibre amb categoria comercial/no_comercial.
// Cereal: camps directes (kg, preu, %rend informatiu, despesa/kg, aportació
// capital/kg) — fórmula confirmada amb factura real:
//   import = kg_net × preu; BI = import − despesa_kg×kg_net;
//   iva = BI×4%; bestreta = −(aportacio_capital_kg×kg_net) [DEDUCCIÓ];
//   import_net = comercial+no_comercial+BI+iva+bestreta (unificat amb fruita)
// -----------------------------------------------------------------------

const TIPUS_CALCUL_PRODUCTE = ['fruita', 'cereal'];

function htmlSeccioBProductes() {
  return `
    <div class="modal-section">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:4px;">
        <p class="modal-section-title" style="margin:0;">B · Productes</p>
        <p id="totals-productes" style="margin:0; font-size:12px; font-weight:500; color:var(--gaco-accent);"></p>
      </div>
      <div id="llista-productes" style="margin-bottom:12px;"></div>
      <form id="form-producte">
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end; margin-bottom:8px;">
          ${camp('Fruita / Cereal', `<input type="text" id="pr-fruita" required placeholder="p.ex. Paraguaio, BLAT" style="min-width:160px;" />`)}
          ${camp('Varietat', `<input type="text" id="pr-varietat" style="min-width:140px;" />`)}
          ${camp('Codi producte (opcional)', `<input type="text" id="pr-codi" style="min-width:120px;" />`)}
          ${camp('Tipus de càlcul', `<select id="pr-tipus-calcul">${TIPUS_CALCUL_PRODUCTE.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>`)}
          <button type="submit">Afegir producte</button>
        </div>
      </form>
    </div>
  `;
}

function htmlDetallProducteFruita(p, tipusDocument) {
  return `
    <div style="margin-top:8px; padding-top:8px; border-top:1px dashed var(--gaco-border);">
      ${
        tipusDocument === 'liquidacio_agraria'
          ? `<div style="display:flex; gap:8px; align-items:flex-end; margin-bottom:8px;">
              ${camp('Bestreta ja avançada (€)', `<input type="number" step="0.01" id="pr-bestreta-${p.id}" value="${p.import_bestreta ?? ''}" style="width:130px;" />`)}
              <button type="button" data-desar-bestreta="${p.id}">Desar</button>
            </div>`
          : ''
      }
      <div id="llista-detall-producte-${p.id}" style="margin-bottom:10px;"></div>
      <form id="form-detall-producte-${p.id}">
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end;">
          ${camp('Categoria', `<select id="dp-categoria-${p.id}"><option value="comercial">Comercial</option><option value="no_comercial">No comercial (anomalia)</option></select>`)}
          ${camp('Qualitat / Anomalia', `<input type="text" id="dp-qualitat-${p.id}" placeholder="p.ex. PRIMERES o PODRIT" style="min-width:140px;" />`)}
          ${camp('Calibre', `<input type="text" id="dp-calibre-${p.id}" style="width:100px;" />`)}
          ${camp('Kg', `<input type="number" step="0.01" id="dp-kg-${p.id}" required style="width:100px;" />`)}
          ${camp('Preu/Kg (€)', `<input type="number" step="0.0001" id="dp-preu-kg-${p.id}" required style="width:110px;" />`)}
          <button type="submit" data-producte="${p.id}">Afegir línia</button>
        </div>
      </form>
    </div>
  `;
}

function htmlDetallProducteCereal(p) {
  return `
    <div style="margin-top:8px; padding-top:8px; border-top:1px dashed var(--gaco-border);">
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end; margin-bottom:8px;">
        ${camp('Kg', `<input type="number" step="0.01" id="pc-kg-${p.id}" value="${p.kg ?? ''}" style="width:110px;" />`)}
        ${camp('Preu/Kg (€)', `<input type="number" step="0.0001" id="pc-preu-kg-${p.id}" value="${p.preu_kg ?? ''}" style="width:110px;" />`)}
        ${camp('% Rend/PE (informatiu)', `<input type="number" step="0.01" id="pc-rendiment-${p.id}" value="${p.pct_rendiment ?? ''}" style="width:110px;" />`)}
        ${camp('Despesa/Kg (€)', `<input type="number" step="0.0001" id="pc-despesa-${p.id}" value="${p.despesa_kg ?? ''}" style="width:110px;" />`)}
        ${camp('Aportació capital/Kg (€)', `<input type="number" step="0.0001" id="pc-aportacio-${p.id}" value="${p.aportacio_capital_kg ?? ''}" style="width:130px;" />`)}
        <button type="button" data-desar-cereal="${p.id}">Calcular i desar</button>
      </div>
      <p id="resum-cereal-${p.id}" style="margin:0; font-size:12px; color:var(--gaco-accent);"></p>
    </div>
  `;
}

function resumCereal(p) {
  const kgNet = Number(p.kg_net ?? p.kg) || 0;
  return `Kg net: ${kgNet} · Import: ${formatImport(kgNet * (Number(p.preu_kg) || 0))} · BI: ${formatImport(p.base_imposable)} · IVA: ${formatImport(p.iva)} · Aportació: ${formatImport((Number(p.aportacio_capital_kg) || 0) * kgNet)} · Net: ${formatImport(p.import_net)}`;
}


function htmlSeccioC(f) {
  return `
    <div class="modal-section">
      <p class="modal-section-title">C · Venciment i cobrament</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end; margin-bottom:8px;">
        ${camp('Data venciment', `<input type="date" id="m-data-venciment" value="${f?.data_venciment ?? ''}" />`)}
        ${camp('Compte de cobrament', `<select id="m-compte-bancari"><option value="">Selecciona...</option>${comptesCache.map((c) => `<option value="${c.id}" ${f?.compte_bancari_id === c.id ? 'selected' : ''}>${c.entitatNom} · ${c.descripcio ?? c.num_compte}</option>`).join('')}</select>`)}
        ${camp('Estat', `<select id="m-estat">${ESTATS.map((e) => `<option value="${e}" ${(f?.estat ?? 'esborrany') === e ? 'selected' : ''}>${ETIQUETES_ESTAT[e]}</option>`).join('')}</select>`)}
        <p id="resum-cobrament" style="margin:0; font-size:13px; color:var(--gaco-text-secondary); align-self:center;">
          Cobrat: ${formatImport(f?.import_cobrat)} · Pendent: ${formatImport(f?.import_pendent)}
        </p>
      </div>
      ${camp('Notes', `<textarea id="m-notes" style="width:100%; min-height:50px;">${f?.notes ?? ''}</textarea>`)}
    </div>
  `;
}

function htmlSeccioD(f) {
  return `
    <div class="modal-section">
      <p class="modal-section-title">D · Fitxers</p>
      <div style="display:flex; gap:16px; flex-wrap:wrap; margin-bottom:8px;">
        <div>
          <p style="font-size:12px; color:var(--gaco-text-secondary); margin:0 0 4px;">PDF de la factura</p>
          ${f?.fitxer_pdf_url ? `<p style="font-size:13px; margin:0 0 4px;">Ja n'hi ha un pujat — pujar-ne un altre el substitueix.</p>` : ''}
          <input type="file" id="doc-fitxer-pdf" accept="application/pdf" />
          <button type="button" id="doc-pujar-pdf" style="margin-left:6px;">Pujar</button>
        </div>
        <div>
          <p style="font-size:12px; color:var(--gaco-text-secondary); margin:0 0 4px;">XML (factura electrònica B2B)</p>
          ${f?.fitxer_xml_url ? `<p style="font-size:13px; margin:0 0 4px;">Ja n'hi ha un pujat — pujar-ne un altre el substitueix.</p>` : ''}
          <input type="file" id="doc-fitxer-xml" accept="text/xml,application/xml" />
          <button type="button" id="doc-pujar-xml" style="margin-left:6px;">Pujar</button>
        </div>
      </div>
    </div>

    <div class="modal-section">
      <p class="modal-section-title">E · Cobraments</p>
      <div id="llista-cobraments" style="margin-bottom:10px;"></div>
      <form id="form-cobrament" style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end;">
        ${camp('Data cobrament', `<input type="date" id="cb-data" required />`)}
        ${camp('Import (€)', `<input type="number" step="0.01" id="cb-import" required style="width:120px;" />`)}
        ${camp('Tipus', `<select id="cb-tipus"><option value="cobrament">Cobrament</option><option value="devolucio">Devolució</option></select>`)}
        ${camp('Origen', `<select id="cb-origen"><option value="">Selecciona...</option>${ORIGENS_COBRAMENT.map((o) => `<option value="${o}">${o === 'confirming_client' ? 'Confirming del client' : 'Transferència'}</option>`).join('')}</select>`)}
        <div id="cb-bloc-confirming" style="display:none; gap:8px; flex-wrap:wrap;">
          ${camp('Descompte confirming (€)', `<input type="number" step="0.01" id="cb-descompte-confirming" style="width:120px;" />`)}
          ${camp('Liquidació confirming', `<select id="cb-confirming-id"><option value="">Cap / encara no tancada...</option>${confirmingCache.map((c) => `<option value="${c.id}">${c.entitatNom} · ${formatData(c.periode_inici)}–${formatData(c.periode_fi)}</option>`).join('')}</select>`)}
        </div>
        ${camp('Compte (opcional)', `<select id="cb-compte"><option value="">Selecciona...</option>${comptesCache.map((c) => `<option value="${c.id}">${c.entitatNom} · ${c.descripcio ?? c.num_compte}</option>`).join('')}</select>`)}
        ${camp('Notes', `<input type="text" id="cb-notes" style="min-width:160px;" />`)}
        <button type="submit">Registrar cobrament</button>
      </form>
    </div>
  `;
}

function vincularModalFactura(body, f, teLinies) {
  if (teLinies) {
    body.querySelector('#ln-catalog-servei')?.addEventListener('change', (e) => {
      const opt = e.target.selectedOptions[0];
      if (opt?.dataset.preu) body.querySelector('#ln-preu').value = opt.dataset.preu;
      if (opt?.dataset.iva) body.querySelector('#ln-iva-pct').value = opt.dataset.iva;
      if (opt?.textContent && opt.value) body.querySelector('#ln-concepte-text').value = opt.textContent.trim();
    });
    body.querySelector('#form-linia').addEventListener('submit', (e) => altaLinia(e, body, f.id));
    carregarLinies(body, f.id);
  } else if (TIPUS_AGRARIS.includes(f.tipus_document)) {
    body.querySelector('#form-producte').addEventListener('submit', (e) => altaProducte(e, body, f.id, f.tipus_document));
    carregarProductes(body, f.id, f.tipus_document);
  }

  body.querySelector('#btn-desar-factura').addEventListener('click', () => desarCapcalera(body, f));

  body.querySelector('#doc-pujar-pdf').addEventListener('click', () => pujarFitxer(body, f.id, 'pdf'));
  body.querySelector('#doc-pujar-xml').addEventListener('click', () => pujarFitxer(body, f.id, 'xml'));

  body.querySelector('#cb-origen').addEventListener('change', (e) => {
    body.querySelector('#cb-bloc-confirming').style.display = e.target.value === 'confirming_client' ? 'flex' : 'none';
  });
  body.querySelector('#form-cobrament').addEventListener('submit', (e) => altaCobrament(e, body, f.id));

  carregarCobraments(body, f.id);
}

async function desarCapcalera(body, f) {
  const nomClientText = body.querySelector('#m-client').value.trim();
  const clientTrobat = clientsCache.find((c) => c.nom === nomClientText);

  const actualitzat = {
    client_id: clientTrobat?.id ?? null,
    contrapart_nom: clientTrobat ? null : (nomClientText || null),
    data_document: body.querySelector('#m-data-document').value,
    activitat: body.querySelector('#m-activitat').value || null,
    exercici: Number(body.querySelector('#m-exercici').value) || null,
    num_document: body.querySelector('#m-num-document')?.value.trim() || null,
    data_venciment: body.querySelector('#m-data-venciment').value || null,
    compte_bancari_id: body.querySelector('#m-compte-bancari').value || null,
    estat: body.querySelector('#m-estat').value,
    notes: body.querySelector('#m-notes').value.trim() || null,
  };

  if (body.querySelector('#m-imprevist')) actualitzat.imprevist = body.querySelector('#m-imprevist').checked;
  if (TIPUS_AGRARIS.includes(f.tipus_document)) {
    actualitzat.proveidor_codi = body.querySelector('#m-proveidor-codi')?.value.trim() || null;
    actualitzat.num_fac_proveedor = body.querySelector('#m-num-fac-proveedor')?.value.trim() || null;
    if (f.tipus_document === 'liquidacio_agraria') {
      const fonsAdversitat = body.querySelector('#m-fons-adversitat')?.value;
      actualitzat.import_fons_adversitat = fonsAdversitat ? Number(fonsAdversitat) : null;
    }
  }

  const { error } = await supabase.from('gaco_factures_emeses').update(actualitzat).eq('id', f.id);
  if (error) return alert(`Error desant: ${error.message}`);

  if (TIPUS_AMB_LINIES.includes(f.tipus_document)) {
    const { data: linies } = await supabase.from('gaco_detall_factures_emeses').select('*').eq('factura_id', f.id);
    await recalcularCapcalera(f.id, linies ?? [], actualitzat.import_fons_adversitat ?? f.import_fons_adversitat);
  } else if (TIPUS_AGRARIS.includes(f.tipus_document)) {
    const { data: productes } = await supabase.from('gaco_liquidacio_productes').select('*').eq('factura_id', f.id);
    await recalcularCapceleraAgraria(f.id, productes ?? []);
  }

  closeModal();
  await carregarLlista();
}

// -----------------------------------------------------------------------
// Línies (gaco_detall_factures_emeses) — només prestacio_serveis/pressupost/ingres_extraordinari
// -----------------------------------------------------------------------

async function carregarLinies(body, facturaId) {
  const contenidor = body.querySelector('#llista-linies');
  contenidor.innerHTML = '<p>Carregant línies...</p>';

  const { data, error } = await supabase
    .from('gaco_detall_factures_emeses')
    .select('*, categoria:gaco_conceptes_comptables(grup, nom)')
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
        ${l.concepte ? ` — ${l.concepte}` : ''}
        <span style="color:var(--gaco-text-secondary);"> · ${l.quantitat ?? 1} × ${formatImport(l.preu_unitari)}</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span>${formatImport(l.base_imposable)} + ${formatImport(l.iva)} IVA</span>
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

  const categoriaId = body.querySelector('#ln-categoria').value;
  const quantitat = Number(body.querySelector('#ln-quantitat').value) || 1;
  const preuUnitari = Number(body.querySelector('#ln-preu').value) || 0;
  const ivaPct = Number(body.querySelector('#ln-iva-pct').value) || 0;

  if (!categoriaId) return alert('Cal triar un concepte.');

  const baseImposable = quantitat * preuUnitari;
  const iva = baseImposable * (ivaPct / 100);

  const novaLinia = {
    factura_id: facturaId,
    catalog_servei_id: body.querySelector('#ln-catalog-servei')?.value || null,
    categoria_id: categoriaId,
    concepte: body.querySelector('#ln-concepte-text').value.trim() || null,
    quantitat,
    preu_unitari: preuUnitari,
    base_imposable: baseImposable,
    iva_pct: ivaPct,
    iva,
  };

  const { error } = await supabase.from('gaco_detall_factures_emeses').insert(novaLinia);
  if (error) return alert(`Error afegint línia: ${error.message}`);

  body.querySelector('#ln-concepte-text').value = '';
  body.querySelector('#ln-quantitat').value = 1;
  body.querySelector('#ln-preu').value = '';
  body.querySelector('#ln-iva-pct').value = ivaPct || 21;

  await carregarLinies(body, facturaId);
  body.querySelector('#ln-preu').focus();
}

async function eliminarLinia(liniaId, body, facturaId) {
  if (!confirm('Eliminar aquesta línia?')) return;
  const { error } = await supabase.from('gaco_detall_factures_emeses').delete().eq('id', liniaId);
  if (error) return alert(`Error eliminant línia: ${error.message}`);
  await carregarLinies(body, facturaId);
}

async function recalcularCapcalera(facturaId, linies, fonsAdversitatOverride) {
  let baseImposable = 0;
  let iva = 0;
  for (const l of linies) {
    baseImposable += Number(l.base_imposable) || 0;
    iva += Number(l.iva) || 0;
  }

  const { data: capcalera } = await supabase
    .from('gaco_factures_emeses')
    .select('import_fons_adversitat, import_cobrat')
    .eq('id', facturaId)
    .single();

  const fonsAdversitat = fonsAdversitatOverride ?? (Number(capcalera?.import_fons_adversitat) || 0);
  const total = baseImposable - fonsAdversitat + iva;
  const importCobrat = Number(capcalera?.import_cobrat) || 0;
  const importPendent = total - importCobrat;

  const totalsEl = document.getElementById('totals-linies');
  if (totalsEl) {
    totalsEl.textContent = `Base: ${formatImport(baseImposable)} · IVA: ${formatImport(iva)} · Total: ${formatImport(total)}`;
  }

  const { error } = await supabase
    .from('gaco_factures_emeses')
    .update({ base_imposable: baseImposable, iva, total, import_pendent: importPendent })
    .eq('id', facturaId);

  if (error) console.error('Error actualitzant totals de capçalera:', error);

  const resumEl = document.getElementById('resum-cobrament');
  if (resumEl) resumEl.textContent = `Cobrat: ${formatImport(importCobrat)} · Pendent: ${formatImport(importPendent)}`;
}

// -----------------------------------------------------------------------
// Fitxers (fitxer_pdf_url / fitxer_xml_url — camps únics a la capçalera)
// -----------------------------------------------------------------------

async function pujarFitxer(body, facturaId, tipus) {
  const inputId = tipus === 'pdf' ? '#doc-fitxer-pdf' : '#doc-fitxer-xml';
  const fileInput = body.querySelector(inputId);
  const file = fileInput.files[0];
  if (!file) return alert('Selecciona un fitxer primer.');

  const path = `emeses/${facturaId}/${tipus}-${Date.now()}-${file.name}`;
  const { error: errorPujada } = await supabase.storage.from(BUCKET_ADJUNTS).upload(path, file, { upsert: true });
  if (errorPujada) return alert(`Error pujant el fitxer: ${errorPujada.message}`);

  const camp = tipus === 'pdf' ? 'fitxer_pdf_url' : 'fitxer_xml_url';
  const { error } = await supabase.from('gaco_factures_emeses').update({ [camp]: path }).eq('id', facturaId);
  if (error) return alert(`Error desant la referència del fitxer: ${error.message}`);

  fileInput.value = '';
  alert(`Fitxer ${tipus.toUpperCase()} pujat correctament.`);
}

// -----------------------------------------------------------------------
// Cobraments (gaco_cobraments_factures_emeses)
// -----------------------------------------------------------------------

async function carregarCobraments(body, facturaId) {
  const contenidor = body.querySelector('#llista-cobraments');
  contenidor.innerHTML = '<p>Carregant cobraments...</p>';

  const { data, error } = await supabase
    .from('gaco_cobraments_factures_emeses')
    .select('*, compte:gaco_comptes(descripcio, num_compte)')
    .eq('factura_id', facturaId)
    .order('data_cobrament');

  if (error) {
    contenidor.innerHTML = `<p class="error">Error carregant cobraments: ${error.message}</p>`;
    return;
  }

  if (!data || data.length === 0) {
    contenidor.innerHTML = '<p style="color:var(--gaco-text-secondary); font-size:13px;">Cap cobrament registrat encara.</p>';
  } else {
    contenidor.innerHTML = data
      .map(
        (c) => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-top:0.5px solid var(--gaco-border); font-size:13px;">
        <div>
          ${formatData(c.data_cobrament)} · ${c.tipus_moviment === 'devolucio' ? 'Devolució' : 'Cobrament'}
          ${c.origen === 'confirming_client' ? ' · Confirming client' : ''}
          ${c.compte ? ` · ${c.compte.descripcio ?? c.compte.num_compte}` : ''}
          ${c.notes ? ` — ${c.notes}` : ''}
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span>${formatImport(c.import)}${c.import_descompte_confirming ? ` (desc. ${formatImport(c.import_descompte_confirming)})` : ''}</span>
          <button data-eliminar-cobrament="${c.id}" title="Eliminar cobrament">✕</button>
        </div>
      </div>
    `
      )
      .join('');

    contenidor.querySelectorAll('[data-eliminar-cobrament]').forEach((btn) => {
      btn.addEventListener('click', () => eliminarCobrament(btn.dataset.eliminarCobrament, body, facturaId));
    });
  }

  await recalcularCobramentsCapcalera(facturaId);
}

async function altaCobrament(e, body, facturaId) {
  e.preventDefault();

  const dataCobrament = body.querySelector('#cb-data').value;
  const importIntroduit = Number(body.querySelector('#cb-import').value) || 0;
  const tipusMoviment = body.querySelector('#cb-tipus').value;
  const origen = body.querySelector('#cb-origen').value || null;
  const compteId = body.querySelector('#cb-compte').value || null;
  const notes = body.querySelector('#cb-notes').value.trim() || null;

  if (!dataCobrament || !importIntroduit) return alert('Cal indicar data i import.');

  const importAmbSigne = tipusMoviment === 'devolucio' ? -Math.abs(importIntroduit) : Math.abs(importIntroduit);

  const nou = {
    factura_id: facturaId,
    data_cobrament: dataCobrament,
    import: importAmbSigne,
    tipus_moviment: tipusMoviment,
    origen,
    compte_bancari_id: compteId,
    notes,
  };

  if (origen === 'confirming_client') {
    const descompte = body.querySelector('#cb-descompte-confirming').value;
    nou.import_descompte_confirming = descompte ? Number(descompte) : null;
    nou.confirming_id = body.querySelector('#cb-confirming-id').value || null;
  }

  const { error } = await supabase.from('gaco_cobraments_factures_emeses').insert(nou);
  if (error) return alert(`Error registrant el cobrament: ${error.message}`);

  e.target.reset();
  body.querySelector('#cb-bloc-confirming').style.display = 'none';
  await carregarCobraments(body, facturaId);
}

async function eliminarCobrament(cobramentId, body, facturaId) {
  if (!confirm('Eliminar aquest cobrament?')) return;
  const { error } = await supabase.from('gaco_cobraments_factures_emeses').delete().eq('id', cobramentId);
  if (error) return alert(`Error eliminant el cobrament: ${error.message}`);
  await carregarCobraments(body, facturaId);
}

async function recalcularCobramentsCapcalera(facturaId) {
  const { data: cobraments } = await supabase
    .from('gaco_cobraments_factures_emeses')
    .select('import')
    .eq('factura_id', facturaId);

  const importCobrat = (cobraments ?? []).reduce((acc, c) => acc + (Number(c.import) || 0), 0);

  const { data: capcalera } = await supabase
    .from('gaco_factures_emeses')
    .select('total, estat')
    .eq('id', facturaId)
    .single();

  const total = Number(capcalera?.total) || 0;
  const importPendent = total - importCobrat;

  let nouEstat = capcalera?.estat;
  if (!ESTATS_NO_AUTOACTUALITZAR.includes(capcalera?.estat)) {
    if (total > 0 && importPendent <= 0) nouEstat = 'cobrada';
    else if (importCobrat > 0) nouEstat = 'cobrada_parcial';
    else nouEstat = 'emesa';
  }

  const { error } = await supabase
    .from('gaco_factures_emeses')
    .update({ import_cobrat: importCobrat, import_pendent: importPendent, estat: nouEstat })
    .eq('id', facturaId);

  if (error) console.error('Error actualitzant cobraments de capçalera:', error);

  const resumEl = document.getElementById('resum-cobrament');
  if (resumEl) resumEl.textContent = `Cobrat: ${formatImport(importCobrat)} · Pendent: ${formatImport(importPendent)}`;

  const estatSelect = document.getElementById('m-estat');
  if (estatSelect && nouEstat) estatSelect.value = nouEstat;
}

// -----------------------------------------------------------------------
// Productes agraris (gaco_liquidacio_productes + gaco_detall_liquidacio_producte)
// -----------------------------------------------------------------------

async function carregarProductes(body, facturaId, tipusDocument) {
  const contenidor = body.querySelector('#llista-productes');
  contenidor.innerHTML = '<p>Carregant productes...</p>';

  const { data, error } = await supabase
    .from('gaco_liquidacio_productes')
    .select('*')
    .eq('factura_id', facturaId)
    .order('created_at');

  if (error) {
    contenidor.innerHTML = `<p class="error">Error carregant productes: ${error.message}</p>`;
    return;
  }

  pintarProductes(body, facturaId, tipusDocument, data ?? []);
  await recalcularCapceleraAgraria(facturaId, data ?? []);
}

function pintarProductes(body, facturaId, tipusDocument, productes) {
  const contenidor = body.querySelector('#llista-productes');

  if (productes.length === 0) {
    contenidor.innerHTML = '<p style="color:var(--gaco-text-secondary); font-size:13px;">Encara no hi ha productes.</p>';
    return;
  }

  contenidor.innerHTML = productes
    .map(
      (p) => `
    <div style="border-top:0.5px solid var(--gaco-border); padding:8px 0;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <strong>${p.fruita}</strong>${p.varietat ? ` · ${p.varietat}` : ''} <span style="font-size:11px; color:var(--gaco-text-secondary);">(${p.tipus_calcul})</span>
          <span style="font-size:12px; color:var(--gaco-text-secondary);"> · Net: ${formatImport(p.import_net)}</span>
        </div>
        <div style="display:flex; gap:6px;">
          <button data-veure-producte="${p.id}">Veure/Editar</button>
          <button data-eliminar-producte="${p.id}" title="Eliminar producte">✕</button>
        </div>
      </div>
      <div id="detall-producte-${p.id}" style="display:none;"></div>
    </div>
  `
    )
    .join('');

  contenidor.querySelectorAll('[data-eliminar-producte]').forEach((btn) => {
    btn.addEventListener('click', () => eliminarProducte(btn.dataset.eliminarProducte, body, facturaId, tipusDocument));
  });

  contenidor.querySelectorAll('[data-veure-producte]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.veureProducte;
      const producte = productes.find((p) => p.id === id);
      obrirDetallProducte(body, facturaId, tipusDocument, producte);
    });
  });
}

function obrirDetallProducte(body, facturaId, tipusDocument, producte) {
  const bloc = body.querySelector(`#detall-producte-${producte.id}`);
  const esVisible = bloc.style.display !== 'none';

  body.querySelectorAll('[id^="detall-producte-"]').forEach((el) => (el.style.display = 'none'));
  if (esVisible) return;

  bloc.style.display = 'block';
  bloc.innerHTML = producte.tipus_calcul === 'cereal' ? htmlDetallProducteCereal(producte) : htmlDetallProducteFruita(producte, tipusDocument);

  if (producte.tipus_calcul === 'cereal') {
    bloc.querySelector(`[data-desar-cereal="${producte.id}"]`).addEventListener('click', () =>
      desarProducteCereal(body, facturaId, tipusDocument, producte.id)
    );
    bloc.querySelector(`#resum-cereal-${producte.id}`).textContent = resumCereal(producte);
  } else {
    bloc.querySelector(`[data-desar-bestreta="${producte.id}"]`)?.addEventListener('click', () =>
      desarBestretaFruita(body, facturaId, tipusDocument, producte.id)
    );
    bloc.querySelector(`#form-detall-producte-${producte.id}`).addEventListener('submit', (e) =>
      altaLiniaProducte(e, body, facturaId, tipusDocument, producte.id)
    );
    carregarLiniesProducte(body, facturaId, tipusDocument, producte.id);
  }
}

async function desarBestretaFruita(body, facturaId, tipusDocument, producteId) {
  const bestreta = Number(body.querySelector(`#pr-bestreta-${producteId}`).value) || 0;
  const { error } = await supabase.from('gaco_liquidacio_productes').update({ import_bestreta: bestreta }).eq('id', producteId);
  if (error) return alert(`Error desant la bestreta: ${error.message}`);
  const { data: linies } = await supabase.from('gaco_detall_liquidacio_producte').select('*').eq('producte_id', producteId);
  await recalcularProducteFruita(facturaId, tipusDocument, producteId, linies ?? []);
}

async function altaProducte(e, body, facturaId, tipusDocument) {
  e.preventDefault();

  const fruita = body.querySelector('#pr-fruita').value.trim();
  if (!fruita) return alert('Cal indicar la fruita o el cereal.');

  const nou = {
    factura_id: facturaId,
    fruita,
    varietat: body.querySelector('#pr-varietat').value.trim() || null,
    codi_producte: body.querySelector('#pr-codi').value.trim() || null,
    tipus_calcul: body.querySelector('#pr-tipus-calcul').value,
  };

  const { error } = await supabase.from('gaco_liquidacio_productes').insert(nou);
  if (error) return alert(`Error afegint producte: ${error.message}`);

  body.querySelector('#pr-fruita').value = '';
  body.querySelector('#pr-varietat').value = '';
  body.querySelector('#pr-codi').value = '';

  await carregarProductes(body, facturaId, tipusDocument);
}

async function eliminarProducte(producteId, body, facturaId, tipusDocument) {
  if (!confirm('Eliminar aquest producte i totes les seves línies?')) return;
  await supabase.from('gaco_detall_liquidacio_producte').delete().eq('producte_id', producteId);
  const { error } = await supabase.from('gaco_liquidacio_productes').delete().eq('id', producteId);
  if (error) return alert(`Error eliminant producte: ${error.message}`);
  await carregarProductes(body, facturaId, tipusDocument);
}

// -- Fruita: línies de detall per qualitat/calibre --

async function carregarLiniesProducte(body, facturaId, tipusDocument, producteId) {
  const contenidor = body.querySelector(`#llista-detall-producte-${producteId}`);
  contenidor.innerHTML = '<p>Carregant línies...</p>';

  const { data, error } = await supabase
    .from('gaco_detall_liquidacio_producte')
    .select('*')
    .eq('producte_id', producteId)
    .order('created_at');

  if (error) {
    contenidor.innerHTML = `<p class="error">Error carregant línies: ${error.message}</p>`;
    return;
  }

  pintarLiniesProducte(body, facturaId, tipusDocument, producteId, data ?? []);
  await recalcularProducteFruita(facturaId, tipusDocument, producteId, data ?? []);
}

function pintarLiniesProducte(body, facturaId, tipusDocument, producteId, linies) {
  const contenidor = body.querySelector(`#llista-detall-producte-${producteId}`);

  if (linies.length === 0) {
    contenidor.innerHTML = '<p style="color:var(--gaco-text-secondary); font-size:12px;">Cap línia encara.</p>';
    return;
  }

  contenidor.innerHTML = linies
    .map(
      (l) => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:4px 0; font-size:12px;">
      <span>${l.categoria === 'comercial' ? 'Comercial' : 'No comercial'} · ${l.qualitat ?? '—'}${l.calibre ? ` · Calibre ${l.calibre}` : ''} · ${l.kg} Kg × ${l.preu_kg} €</span>
      <span>${formatImport(l.import)} <button data-eliminar-detall="${l.id}" title="Eliminar">✕</button></span>
    </div>
  `
    )
    .join('');

  contenidor.querySelectorAll('[data-eliminar-detall]').forEach((btn) => {
    btn.addEventListener('click', () => eliminarLiniaProducte(btn.dataset.eliminarDetall, body, facturaId, tipusDocument, producteId));
  });
}

async function altaLiniaProducte(e, body, facturaId, tipusDocument, producteId) {
  e.preventDefault();

  const categoria = body.querySelector(`#dp-categoria-${producteId}`).value;
  const qualitat = body.querySelector(`#dp-qualitat-${producteId}`).value.trim() || null;
  const calibre = body.querySelector(`#dp-calibre-${producteId}`).value.trim() || null;
  const kg = Number(body.querySelector(`#dp-kg-${producteId}`).value) || 0;
  const preuKg = Number(body.querySelector(`#dp-preu-kg-${producteId}`).value) || 0;

  if (!kg || !preuKg) return alert('Cal indicar Kg i Preu/Kg.');

  const nova = {
    producte_id: producteId,
    categoria,
    qualitat,
    calibre,
    kg,
    preu_kg: preuKg,
    import: kg * preuKg,
  };

  const { error } = await supabase.from('gaco_detall_liquidacio_producte').insert(nova);
  if (error) return alert(`Error afegint línia: ${error.message}`);

  body.querySelector(`#dp-qualitat-${producteId}`).value = '';
  body.querySelector(`#dp-calibre-${producteId}`).value = '';
  body.querySelector(`#dp-kg-${producteId}`).value = '';
  body.querySelector(`#dp-preu-kg-${producteId}`).value = '';

  await carregarLiniesProducte(body, facturaId, tipusDocument, producteId);
}

async function eliminarLiniaProducte(liniaId, body, facturaId, tipusDocument, producteId) {
  if (!confirm('Eliminar aquesta línia?')) return;
  const { error } = await supabase.from('gaco_detall_liquidacio_producte').delete().eq('id', liniaId);
  if (error) return alert(`Error eliminant línia: ${error.message}`);
  await carregarLiniesProducte(body, facturaId, tipusDocument, producteId);
}

async function recalcularProducteFruita(facturaId, tipusDocument, producteId, linies) {
  let importComercial = 0;
  let importNoComercial = 0;
  for (const l of linies) {
    if (l.categoria === 'no_comercial') importNoComercial += Number(l.import) || 0;
    else importComercial += Number(l.import) || 0;
  }

  // La bestreta ja avançada es manté manual (el document de liquidació la
  // dona feta) — no es toca aquí, només es recalcula import_net.
  const { data: producte } = await supabase
    .from('gaco_liquidacio_productes')
    .select('import_bestreta')
    .eq('id', producteId)
    .single();

  const bestreta = Number(producte?.import_bestreta) || 0;
  const importNet = importComercial + importNoComercial + bestreta;

  const { error } = await supabase
    .from('gaco_liquidacio_productes')
    .update({ import_comercial: importComercial, import_no_comercial: importNoComercial, import_net: importNet })
    .eq('id', producteId);

  if (error) console.error('Error actualitzant producte:', error);

  const { data: tots } = await supabase.from('gaco_liquidacio_productes').select('*').eq('factura_id', facturaId);
  await recalcularCapceleraAgraria(facturaId, tots ?? []);
}

// -- Cereal: camps directes --

async function desarProducteCereal(body, facturaId, tipusDocument, producteId) {
  const kg = Number(body.querySelector(`#pc-kg-${producteId}`).value) || 0;
  const preuKg = Number(body.querySelector(`#pc-preu-kg-${producteId}`).value) || 0;
  const pctRendiment = body.querySelector(`#pc-rendiment-${producteId}`).value ? Number(body.querySelector(`#pc-rendiment-${producteId}`).value) : null;
  const despesaKg = Number(body.querySelector(`#pc-despesa-${producteId}`).value) || 0;
  const aportacioCapitalKg = Number(body.querySelector(`#pc-aportacio-${producteId}`).value) || 0;

  if (!kg || !preuKg) return alert('Cal indicar Kg i Preu/Kg.');

  // Fórmula confirmada amb factura real (% Rend/PE és informatiu, Net = Kg):
  const kgNet = kg;
  const importBrut = kgNet * preuKg;
  const baseImposable = importBrut - despesaKg * kgNet;
  const iva = baseImposable * 0.04;
  const bestreta = -(aportacioCapitalKg * kgNet); // deducció, mai manual per a cereal
  const importNet = baseImposable + iva + bestreta;

  const actualitzat = {
    kg,
    preu_kg: preuKg,
    pct_rendiment: pctRendiment,
    kg_net: kgNet,
    despesa_kg: despesaKg,
    aportacio_capital_kg: aportacioCapitalKg,
    base_imposable: baseImposable,
    iva,
    import_bestreta: bestreta,
    import_net: importNet,
  };

  const { error } = await supabase.from('gaco_liquidacio_productes').update(actualitzat).eq('id', producteId);
  if (error) return alert(`Error desant el producte: ${error.message}`);

  const resumEl = body.querySelector(`#resum-cereal-${producteId}`);
  if (resumEl) {
    resumEl.textContent = `Kg net: ${kgNet} · Import: ${formatImport(importBrut)} · BI: ${formatImport(baseImposable)} · IVA: ${formatImport(iva)} · Aportació: ${formatImport(aportacioCapitalKg * kgNet)} · Net: ${formatImport(importNet)}`;
  }

  const { data: tots } = await supabase.from('gaco_liquidacio_productes').select('*').eq('factura_id', facturaId);
  await recalcularCapceleraAgraria(facturaId, tots ?? []);
}

// -- Capçalera agrària --

async function recalcularCapceleraAgraria(facturaId, productes) {
  let baseImposable = 0;
  let iva = 0;
  let importNet = 0;

  for (const p of productes) {
    if (p.tipus_calcul === 'cereal') {
      baseImposable += Number(p.base_imposable) || 0;
      iva += Number(p.iva) || 0;
    } else {
      baseImposable += (Number(p.import_comercial) || 0) + (Number(p.import_no_comercial) || 0);
    }
    importNet += Number(p.import_net) || 0;
  }

  const { data: capcalera } = await supabase
    .from('gaco_factures_emeses')
    .select('import_fons_adversitat, import_cobrat')
    .eq('id', facturaId)
    .single();

  const fonsAdversitat = Number(capcalera?.import_fons_adversitat) || 0;
  const total = importNet - fonsAdversitat;
  const importCobrat = Number(capcalera?.import_cobrat) || 0;
  const importPendent = total - importCobrat;

  const totalsEl = document.getElementById('totals-productes');
  if (totalsEl) {
    totalsEl.textContent = `Base: ${formatImport(baseImposable)} · IVA: ${formatImport(iva)} · Total: ${formatImport(total)}`;
  }

  const { error } = await supabase
    .from('gaco_factures_emeses')
    .update({ base_imposable: baseImposable, iva, total, import_pendent: importPendent })
    .eq('id', facturaId);

  if (error) console.error('Error actualitzant capçalera agrària:', error);

  const resumEl = document.getElementById('resum-cobrament');
  if (resumEl) resumEl.textContent = `Cobrat: ${formatImport(importCobrat)} · Pendent: ${formatImport(importPendent)}`;
}

// -----------------------------------------------------------------------
// Exportació PDF
// -----------------------------------------------------------------------

let jsPdfCarregat = false;

async function carregarJsPdf() {
  if (jsPdfCarregat) return;
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

async function exportarPdf() {
  if (resultatActual.length === 0) return alert('No hi ha resultats per exportar.');

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

  doc.setFontSize(14);
  doc.text('Factures emeses', 14, 15);
  doc.setFontSize(9);
  doc.text(`Generat: ${new Date().toLocaleString('ca-ES')}`, 14, 21);
  doc.text(descripcioFiltreActiu(), 14, 26);

  const files = resultatActual.map((f) => [
    formatData(f.data_document),
    f.num_document ?? '—',
    f.client?.nom ?? f.contrapart_nom ?? '—',
    formatImport(f.base_imposable),
    formatImport(f.iva),
    formatImport(f.total),
    ETIQUETES_ESTAT[f.estat] ?? f.estat,
  ]);

  const sumar = (camp) => resultatActual.reduce((acc, f) => acc + (Number(f[camp]) || 0), 0);

  doc.autoTable({
    startY: 32,
    head: [['Data', 'Núm.', 'Client', 'Base', 'IVA', 'Total', 'Estat']],
    body: files,
    foot: [['', '', 'TOTALS', formatImport(sumar('base_imposable')), formatImport(sumar('iva')), formatImport(sumar('total')), '']],
    styles: { fontSize: 8 },
    headStyles: { fillColor: [136, 0, 27] },
  });

  doc.save(`factures-emeses-${filtre.exercici ?? 'tots'}.pdf`);
}

function descripcioFiltreActiu() {
  const parts = [];
  parts.push(`Exercici: ${filtre.exercici ?? 'Tots'}`);
  if (filtre.clientId || filtre.contrapartText) {
    const nom = filtre.clientId ? clientsCache.find((c) => c.id === filtre.clientId)?.nom : filtre.contrapartText;
    parts.push(`Client: ${nom}`);
  }
  if (filtre.estats.length) parts.push(`Estat: ${filtre.estats.map((e) => ETIQUETES_ESTAT[e]).join(', ')}`);
  if (filtre.dataDocumentDes || filtre.dataDocumentFins) {
    parts.push(`Data document: ${filtre.dataDocumentDes ?? '...'} — ${filtre.dataDocumentFins ?? '...'}`);
  }
  return parts.join(' · ');
}
