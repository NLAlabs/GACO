import { supabase } from '../../lib/supabaseClient.js';

/**
 * Documents → Factures rebudes.
 * Capçalera (gaco_factures_rebudes) amb filtres + alta ràpida + Veure/Editar.
 * Línies (gaco_detall_factures_rebudes) dins la mateixa vista de Veure/Editar,
 * amb recàlcul en viu de base_imposable/iva/suplits/total de la capçalera.
 *
 * Pendent per a la propera iteració: adjunts (gaco_adjunts_factures_rebudes)
 * i pagaments (gaco_pagaments_factures_rebudes).
 *
 * Exercici: es filtra SEMPRE per l'any en curs per defecte (lliçó de SAO —
 * mai llista sense filtrar per exercici), amb opció explícita "Tots".
 *
 * confirming_id: es deixa sempre null en aquesta pantalla. El confirming
 * real del negoci és "nosaltres com a proveïdor de serveis cobrant d'un
 * client" (cas d'ús de gaco_factures_emeses, pendent de fer), no de
 * pagar als nostres propis proveïdors — encara que la columna existeixi
 * físicament aquí.
 */

const TIPUS_FACTURA = ['factura', 'despesa'];
const ESTATS = ['pendent', 'pagada_parcial', 'pagada', 'pendent_liquidar_soci', 'liquidada_soci'];
const FORMES_PAGAMENT = ['compte_bancari', 'soci', 'confirming', 'compensacio'];
const ACTIVITATS = ['fruita_cereal', 'serveis', 'comuna'];

const ANY_ACTUAL = new Date().getFullYear();

// Cache local de dades de suport (poc volum, es carreguen un sol cop per render)
let proveidorsCache = [];
let conceptesCache = [];
let comptesCache = [];
let socisCache = [];
let immobilitzatCache = [];

// Cache de l'últim resultat llistat (per a l'exportació PDF i per repintar sense refer la consulta)
let resultatActual = [];

// Estat del filtre — es manté a nivell de mòdul perquè no es perdi en tornar de Veure/Editar
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
    <div class="card">
      <p style="font-weight:500; margin-bottom:12px;">Nova factura rebuda</p>
      <form id="form-factura-rebuda">
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
          <select id="fr-tipus-factura" style="flex:1; min-width:120px;">
            ${TIPUS_FACTURA.map((t) => `<option value="${t}">${t === 'factura' ? 'Factura' : 'Despesa'}</option>`).join('')}
          </select>
          <input type="text" id="fr-proveidor" list="dl-proveidors" placeholder="Proveïdor (o nom lliure)" style="flex:2; min-width:200px;" />
          <datalist id="dl-proveidors">
            ${proveidorsCache.map((p) => `<option value="${p.nom}" data-id="${p.id}"></option>`).join('')}
          </datalist>
          <input type="date" id="fr-data-factura" required style="flex:1; min-width:140px;" />
          <select id="fr-activitat" style="flex:1; min-width:130px;">
            <option value="">Activitat...</option>
            ${ACTIVITATS.map((a) => `<option value="${a}">${a}</option>`).join('')}
          </select>
        </div>

        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
          <select id="fr-forma-pagament" style="flex:1; min-width:150px;">
            <option value="">Forma de pagament...</option>
            ${FORMES_PAGAMENT.map((f) => `<option value="${f}">${f}</option>`).join('')}
          </select>
          <select id="fr-compte-bancari" style="display:none; flex:1; min-width:180px;">
            <option value="">Compte...</option>
            ${comptesCache.map((c) => `<option value="${c.id}">${c.entitatNom} · ${c.descripcio ?? c.num_compte}</option>`).join('')}
          </select>
          <select id="fr-soci" style="display:none; flex:1; min-width:150px;">
            <option value="">Soci...</option>
            ${socisCache.map((s) => `<option value="${s.id}">${s.nom}</option>`).join('')}
          </select>
          <p id="fr-confirming-nota" style="display:none; flex:1; min-width:150px; font-size:12px; color:var(--gaco-text-secondary); margin:0; align-self:center;">
            S'enllaçarà a la liquidació de confirming quan es tanqui el període (Finançament → Confirming).
          </p>
        </div>

        <button type="button" id="toggle-mes-camps-fr" style="margin-bottom:8px;">Més camps ▾</button>
        <div id="mes-camps-fr" style="display:none; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
          <input type="text" id="fr-num-factura" placeholder="Núm. factura proveïdor" style="min-width:160px;" />
          <input type="date" id="fr-data-recepcio" title="Data recepció" style="min-width:140px;" />
          <input type="date" id="fr-data-venciment" title="Data venciment" style="min-width:140px;" />
          <input type="number" id="fr-exercici" placeholder="Exercici" value="${ANY_ACTUAL}" style="width:100px;" />
          <input type="number" step="0.01" id="fr-irpf-pct" placeholder="% IRPF" style="width:100px;" />
          <input type="number" step="0.01" id="fr-irpf" placeholder="Import IRPF" style="width:120px;" />
          <label style="display:flex; align-items:center; gap:6px; font-size:13px;">
            <input type="checkbox" id="fr-imprevist" />
            Imprevist / puntual
          </label>
          <textarea id="fr-notes" placeholder="Notes" style="width:100%; min-height:50px;"></textarea>
        </div>

        <button type="submit">Afegir factura</button>
      </form>
    </div>

    <div class="card">
      <button type="button" id="toggle-filtres" style="margin-bottom:8px;">Filtres ▾</button>
      <div id="bloc-filtres" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
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
              <input type="checkbox" class="chk-estat" value="${e}" /> ${e}
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
    </div>

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <p style="font-weight:500; margin:0;">Factures (<span id="comptador-factures">0</span>)</p>
        <button type="button" id="btn-exportar-pdf">Exportar PDF</button>
      </div>
      <div id="llista-factures"></div>
    </div>
  `;

  // Toggles de blocs plegables (style.display, no hidden — bug ja conegut)
  document.getElementById('toggle-mes-camps-fr').addEventListener('click', () => {
    const bloc = document.getElementById('mes-camps-fr');
    bloc.style.display = bloc.style.display === 'none' ? 'flex' : 'none';
  });
  document.getElementById('toggle-filtres').addEventListener('click', () => {
    const bloc = document.getElementById('bloc-filtres');
    bloc.style.display = bloc.style.display === 'none' ? 'flex' : 'none';
  });

  // Forma de pagament: mostra el selector secundari corresponent
  document.getElementById('fr-forma-pagament').addEventListener('change', (e) => {
    document.getElementById('fr-compte-bancari').style.display = e.target.value === 'compte_bancari' ? 'block' : 'none';
    document.getElementById('fr-soci').style.display = e.target.value === 'soci' ? 'block' : 'none';
    document.getElementById('fr-confirming-nota').style.display = e.target.value === 'confirming' ? 'block' : 'none';
  });

  document.getElementById('form-factura-rebuda').addEventListener('submit', altaRapida);
  document.getElementById('btn-aplicar-filtres').addEventListener('click', () => {
    llegirFiltresDelFormulari();
    carregarLlista();
  });
  document.getElementById('btn-netejar-filtres').addEventListener('click', () => {
    netejarFiltres();
    render();
  });
  document.getElementById('btn-exportar-pdf').addEventListener('click', exportarPdf);

  // Preomplir els inputs de filtre amb l'estat actual (per si es torna d'una edició)
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
  // Rang senzill: 3 anys enrere fins l'any en curs. Ajustar si cal més històric.
  const anys = [];
  for (let a = ANY_ACTUAL; a >= ANY_ACTUAL - 3; a--) anys.push(a);
  return anys;
}

async function altaRapida(e) {
  e.preventDefault();

  const nomProveidorText = document.getElementById('fr-proveidor').value.trim();
  const proveidorTrobat = proveidorsCache.find((p) => p.nom === nomProveidorText);

  const formaPagament = document.getElementById('fr-forma-pagament').value || null;

  const nova = {
    tipus_factura: document.getElementById('fr-tipus-factura').value,
    proveidor_id: proveidorTrobat?.id ?? null,
    contrapart_nom: proveidorTrobat ? null : (nomProveidorText || null),
    data_factura: document.getElementById('fr-data-factura').value,
    activitat: document.getElementById('fr-activitat').value || null,
    forma_pagament: formaPagament,
    compte_bancari_id: formaPagament === 'compte_bancari' ? (document.getElementById('fr-compte-bancari').value || null) : null,
    soci_id: formaPagament === 'soci' ? (document.getElementById('fr-soci').value || null) : null,
    confirming_id: null, // mai a l'alta — cas d'ús real de confirming és a factures emeses, no aquí
    num_factura: document.getElementById('fr-num-factura').value.trim() || null,
    data_recepcio: document.getElementById('fr-data-recepcio').value || null,
    data_venciment: document.getElementById('fr-data-venciment').value || null,
    exercici: Number(document.getElementById('fr-exercici').value) || new Date(document.getElementById('fr-data-factura').value).getFullYear(),
    irpf_pct: document.getElementById('fr-irpf-pct').value ? Number(document.getElementById('fr-irpf-pct').value) : null,
    irpf: document.getElementById('fr-irpf').value ? Number(document.getElementById('fr-irpf').value) : null,
    imprevist: document.getElementById('fr-imprevist').checked,
    notes: document.getElementById('fr-notes').value.trim() || null,
    estat: 'pendent',
  };

  if (!nova.tipus_factura || !nova.data_factura) return;
  if (!nova.proveidor_id && !nova.contrapart_nom) {
    return alert('Cal indicar un proveïdor o un nom.');
  }

  const { error } = await supabase.from('gaco_factures_rebudes').insert(nova);
  if (error) return alert(`Error afegint factura: ${error.message}`);
  render();
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

  // Filtre per concepte: viu al detall, cal resoldre primer els factura_id afectats
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
    <div style="border-top:0.5px solid var(--gaco-border); padding:10px 0;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <p style="margin:0;">
            ${formatData(f.data_factura)} · ${f.proveidor?.nom ?? f.contrapart_nom ?? '—'}
            ${f.num_factura ? `· ${f.num_factura}` : ''}
            <span style="font-size:11px; color:var(--gaco-text-secondary);">(${f.tipus_factura})</span>
          </p>
          <p style="margin:2px 0 0; font-size:12px; color:var(--gaco-text-secondary);">
            Total: ${formatImport(f.total)} · Pendent: ${formatImport(f.import_pendent)} · <span style="color:var(--gaco-accent);">${f.estat}</span>
          </p>
        </div>
        <button data-veure="${f.id}">Veure/Editar</button>
      </div>
      <div id="edit-factura-${f.id}" style="display:none; margin-top:10px; padding-top:10px; border-top:0.5px dashed var(--gaco-border);"></div>
    </div>
  `
    )
    .join('');

  contenidor.querySelectorAll('[data-veure]').forEach((btn) => {
    btn.addEventListener('click', () => obrirEdicio(btn.dataset.veure));
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

function obrirEdicio(id) {
  const factura = resultatActual.find((f) => f.id === id);
  const bloc = document.getElementById(`edit-factura-${id}`);
  const esVisible = bloc.style.display !== 'none';

  document.querySelectorAll('[id^="edit-factura-"]').forEach((el) => (el.style.display = 'none'));
  if (esVisible) return;

  bloc.style.display = 'block';
  bloc.innerHTML = `
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
      <input type="text" id="ed-num-factura-${id}" placeholder="Núm. factura" value="${factura.num_factura ?? ''}" style="min-width:150px;" />
      <input type="date" id="ed-data-venciment-${id}" value="${factura.data_venciment ?? ''}" style="min-width:140px;" />
      <select id="ed-estat-${id}" style="min-width:160px;">
        ${ESTATS.map((e) => `<option value="${e}" ${factura.estat === e ? 'selected' : ''}>${e}</option>`).join('')}
      </select>
      <input type="number" step="0.01" id="ed-irpf-pct-${id}" placeholder="% IRPF" value="${factura.irpf_pct ?? ''}" style="width:100px;" />
      <input type="number" step="0.01" id="ed-irpf-${id}" placeholder="Import IRPF" value="${factura.irpf ?? ''}" style="width:120px;" />
    </div>
    <textarea id="ed-notes-${id}" placeholder="Notes" style="width:100%; min-height:50px; margin-bottom:8px;">${factura.notes ?? ''}</textarea>
    <button data-desar="${id}">Desar canvis de capçalera</button>

    <div style="margin-top:16px; padding-top:12px; border-top:1px solid var(--gaco-border);">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <p style="font-weight:500; margin:0;">Línies</p>
        <p id="totals-linies-${id}" style="margin:0; font-size:12px; color:var(--gaco-text-secondary);"></p>
      </div>

      <div id="llista-linies-${id}" style="margin-bottom:12px;"></div>

      <form id="form-linia-${id}" style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end;">
        <select id="ln-categoria-${id}" required style="min-width:200px;">
          <option value="">Concepte...</option>
          ${conceptesCache.map((c) => `<option value="${c.id}" data-tipus="${c.tipus}">${c.grup} · ${c.nom}</option>`).join('')}
        </select>
        <input type="text" id="ln-descripcio-${id}" placeholder="Descripció" style="flex:1; min-width:160px;" />
        <input type="number" step="0.01" id="ln-quantitat-${id}" placeholder="Quantitat" value="1" style="width:90px;" />
        <input type="number" step="0.01" id="ln-preu-${id}" placeholder="Preu unitari" required style="width:110px;" />
        <input type="number" step="0.01" id="ln-descompte-pct-${id}" placeholder="% desc." style="width:90px;" />
        <input type="number" step="0.01" id="ln-iva-pct-${id}" placeholder="% IVA" value="21" style="width:90px;" />
        <select id="ln-proveidor-suplit-${id}" style="display:none; min-width:160px;">
          <option value="">Proveïdor del suplit...</option>
          ${proveidorsCache.map((p) => `<option value="${p.id}">${p.nom}</option>`).join('')}
        </select>
        <select id="ln-immobilitzat-${id}" style="display:none; min-width:160px;">
          <option value="">Immobilitzat...</option>
          ${immobilitzatCache.map((m) => `<option value="${m.id}">${m.nom}</option>`).join('')}
        </select>
        <button type="submit">Afegir línia</button>
      </form>
    </div>
  `;

  bloc.querySelector(`[data-desar="${id}"]`).addEventListener('click', async () => {
    const actualitzat = {
      num_factura: document.getElementById(`ed-num-factura-${id}`).value.trim() || null,
      data_venciment: document.getElementById(`ed-data-venciment-${id}`).value || null,
      estat: document.getElementById(`ed-estat-${id}`).value,
      irpf_pct: document.getElementById(`ed-irpf-pct-${id}`).value ? Number(document.getElementById(`ed-irpf-pct-${id}`).value) : null,
      irpf: document.getElementById(`ed-irpf-${id}`).value ? Number(document.getElementById(`ed-irpf-${id}`).value) : null,
      notes: document.getElementById(`ed-notes-${id}`).value.trim() || null,
    };
    const { error } = await supabase.from('gaco_factures_rebudes').update(actualitzat).eq('id', id);
    if (error) return alert(`Error desant: ${error.message}`);
    render();
  });

  // Mostrar proveidor_suplit / immobilitzat només quan el concepte triat ho requereix
  document.getElementById(`ln-categoria-${id}`).addEventListener('change', (e) => {
    const tipus = e.target.selectedOptions[0]?.dataset.tipus;
    document.getElementById(`ln-proveidor-suplit-${id}`).style.display = tipus === 'suplits' ? 'block' : 'none';
    document.getElementById(`ln-immobilitzat-${id}`).style.display = tipus === 'actiu' ? 'block' : 'none';
  });

  document.getElementById(`form-linia-${id}`).addEventListener('submit', (e) => altaLinia(e, id));

  carregarLinies(id);
}

// -----------------------------------------------------------------------
// Línies de detall (gaco_detall_factures_rebudes)
// -----------------------------------------------------------------------

async function carregarLinies(facturaId) {
  const contenidor = document.getElementById(`llista-linies-${facturaId}`);
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

  pintarLinies(facturaId, data ?? []);
  await recalcularCapcalera(facturaId, data ?? []);
}

function pintarLinies(facturaId, linies) {
  const contenidor = document.getElementById(`llista-linies-${facturaId}`);

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
        <span style="color:var(--gaco-text-secondary);"> · ${l.quantitat ?? 1} × ${formatImport(l.preu_unitari)}</span>
        ${l.categoria?.tipus === 'suplits' ? `<span style="color:var(--gaco-accent);"> · suplit${l.proveidor_suplit?.nom ? ` (${l.proveidor_suplit.nom})` : ''}</span>` : ''}
        ${l.immobilitzat?.nom ? `<span style="color:var(--gaco-accent);"> · ${l.immobilitzat.nom}</span>` : ''}
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span>${formatImport(l.total_linia)} ${l.categoria?.tipus !== 'suplits' ? `+ ${formatImport(l.iva)} IVA` : ''}</span>
        <button data-eliminar-linia="${l.id}" data-factura="${facturaId}" title="Eliminar línia">✕</button>
      </div>
    </div>
  `
    )
    .join('');

  contenidor.querySelectorAll('[data-eliminar-linia]').forEach((btn) => {
    btn.addEventListener('click', () => eliminarLinia(btn.dataset.eliminarLinia, btn.dataset.factura));
  });
}

async function altaLinia(e, facturaId) {
  e.preventDefault();

  const categoriaId = document.getElementById(`ln-categoria-${facturaId}`).value;
  const categoria = conceptesCache.find((c) => c.id === categoriaId);
  const quantitat = Number(document.getElementById(`ln-quantitat-${facturaId}`).value) || 1;
  const preuUnitari = Number(document.getElementById(`ln-preu-${facturaId}`).value) || 0;
  const descomptePct = Number(document.getElementById(`ln-descompte-pct-${facturaId}`).value) || 0;
  const ivaPct = Number(document.getElementById(`ln-iva-pct-${facturaId}`).value) || 0;

  const importBase = quantitat * preuUnitari;
  const importDescompte = importBase * (descomptePct / 100);
  const totalLinia = importBase - importDescompte;
  // Suplits: import passat íntegre (ja porta el seu propi IVA de qui l'ha avançat), no en calculem IVA propi
  const iva = categoria?.tipus === 'suplits' ? 0 : totalLinia * (ivaPct / 100);

  if (!categoriaId) return alert('Cal triar un concepte.');

  const novaLinia = {
    factura_id: facturaId,
    categoria_id: categoriaId,
    descripcio: document.getElementById(`ln-descripcio-${facturaId}`).value.trim() || null,
    quantitat,
    preu_unitari: preuUnitari,
    descompte_pct: descomptePct || null,
    import_base: importBase,
    import_descompte: importDescompte || null,
    total_linia: totalLinia,
    iva_pct: categoria?.tipus === 'suplits' ? null : ivaPct,
    iva,
    proveidor_suplit_id: categoria?.tipus === 'suplits' ? (document.getElementById(`ln-proveidor-suplit-${facturaId}`).value || null) : null,
    immobilitzat_id: categoria?.tipus === 'actiu' ? (document.getElementById(`ln-immobilitzat-${facturaId}`).value || null) : null,
  };

  const { error } = await supabase.from('gaco_detall_factures_rebudes').insert(novaLinia);
  if (error) return alert(`Error afegint línia: ${error.message}`);

  e.target.reset();
  document.getElementById(`ln-quantitat-${facturaId}`).value = 1;
  document.getElementById(`ln-iva-pct-${facturaId}`).value = 21;
  await carregarLinies(facturaId);
}

async function eliminarLinia(liniaId, facturaId) {
  if (!confirm('Eliminar aquesta línia?')) return;
  const { error } = await supabase.from('gaco_detall_factures_rebudes').delete().eq('id', liniaId);
  if (error) return alert(`Error eliminant línia: ${error.message}`);
  await carregarLinies(facturaId);
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

  const factura = resultatActual.find((f) => f.id === facturaId);
  const irpf = Number(factura?.irpf) || 0;
  const total = baseImposable + iva - irpf + suplits;
  const importPagat = Number(factura?.import_pagat) || 0;
  const importPendent = total - importPagat;

  const totalsEl = document.getElementById(`totals-linies-${facturaId}`);
  if (totalsEl) {
    totalsEl.textContent = `Base: ${formatImport(baseImposable)} · IVA: ${formatImport(iva)} · Suplits: ${formatImport(suplits)} · Total: ${formatImport(total)}`;
  }

  const { error } = await supabase
    .from('gaco_factures_rebudes')
    .update({
      base_imposable: baseImposable,
      iva,
      suplits,
      total,
      import_pendent: importPendent,
    })
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
    f.estat,
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
  if (filtre.estats.length) parts.push(`Estat: ${filtre.estats.join(', ')}`);
  if (filtre.dataFacturaDes || filtre.dataFacturaFins) {
    parts.push(`Data factura: ${filtre.dataFacturaDes ?? '...'} — ${filtre.dataFacturaFins ?? '...'}`);
  }
  return parts.join(' · ');
}
