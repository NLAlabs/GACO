import { supabase } from '../../lib/supabaseClient.js';
import { openModal, closeModal } from '../../lib/modal.js';

function formatImport(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('ca-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function formatData(dataStr) {
  if (!dataStr) return '—';
  const [y, m, d] = dataStr.split('-');
  return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
}

const ETIQUETES_TIPUS_PRODUCTE = { prestec: 'Préstec', leasing: 'Leasing', renting: 'Renting' };
const ETIQUETES_PERIODICITAT = { mensual: 'Mensual', trimestral: 'Trimestral', altres: 'Altres' };

let entitatsCache = [];
let comptesCache = [];

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant...</p>';

  const [{ data: entitats }, { data: comptes }] = await Promise.all([
    supabase.from('gaco_entitats_bancaries').select('id, nom').order('nom'),
    supabase.from('gaco_comptes').select('id, num_compte, descripcio').order('num_compte'),
  ]);
  entitatsCache = entitats ?? [];
  comptesCache = comptes ?? [];

  contenidor.innerHTML = `
    <div class="card">
      <label>Estat
        <select id="f-estat">
          <option value="actiu">Actius</option>
          <option value="liquidat">Liquidats</option>
          <option value="">Tots</option>
        </select>
      </label>
      <button type="button" id="btn-nou-prestec">+ Nou préstec / leasing / renting</button>
    </div>
    <div id="llista-prestecs"><p>Carregant...</p></div>
  `;

  document.getElementById('f-estat').addEventListener('change', carregarLlista);
  document.getElementById('btn-nou-prestec').addEventListener('click', obrirModalNouPrestec);

  await carregarLlista();
}

async function carregarLlista() {
  const llistaEl = document.getElementById('llista-prestecs');
  llistaEl.innerHTML = '<p>Carregant...</p>';

  const estat = document.getElementById('f-estat').value;
  let query = supabase
    .from('gaco_prestecs')
    .select('id, tipus_producte, descripcio, capital_inicial, capital_pendent, quota_periodica, periodicitat, estat, entitat_id, gaco_entitats_bancaries ( nom )')
    .order('estat')
    .order('created_at', { ascending: false });
  if (estat) query = query.eq('estat', estat);

  const { data, error } = await query;
  if (error) {
    llistaEl.innerHTML = `<p class="error">Error carregant préstecs: ${error.message}</p>`;
    return;
  }

  if (!data.length) {
    llistaEl.innerHTML = '<div class="card"><p>Cap préstec amb aquest filtre.</p></div>';
    return;
  }

  llistaEl.innerHTML = data.map(htmlPrestec).join('');
  llistaEl.querySelectorAll('[data-veure-quotes]').forEach((btn) => {
    btn.addEventListener('click', () => obrirModalQuotes(btn.dataset.veureQuotes, btn.dataset.nom));
  });
}

function htmlPrestec(p) {
  return `
    <div class="card">
      <p class="modal-section-title">${p.gaco_entitats_bancaries?.nom ?? '?'} · ${ETIQUETES_TIPUS_PRODUCTE[p.tipus_producte] ?? p.tipus_producte} · ${p.estat === 'liquidat' ? 'Liquidat' : 'Actiu'}</p>
      <p><strong>${p.descripcio ?? '(sense descripció)'}</strong></p>
      <p>Capital inicial: ${formatImport(p.capital_inicial)} · Pendent: ${formatImport(p.capital_pendent)}</p>
      <p>Quota ${ETIQUETES_PERIODICITAT[p.periodicitat] ?? p.periodicitat}: ${formatImport(p.quota_periodica)}</p>
      <button type="button" data-veure-quotes="${p.id}" data-nom="${(p.descripcio ?? '').replace(/"/g, '&quot;')}">Veure quotes</button>
    </div>
  `;
}

function selectHtml(id, label, opcions, opcionalTot) {
  return `
    <label>${label}
      <select id="${id}">
        ${opcionalTot ? '<option value="">(cap)</option>' : ''}
        ${opcions}
      </select>
    </label>
  `;
}

function obrirModalNouPrestec() {
  openModal({
    title: 'Nou préstec / leasing / renting',
    wide: true,
    bodyHtml: `
      <div class="modal-section">
        ${selectHtml('nf-entitat', 'Entitat', entitatsCache.map((e) => `<option value="${e.id}">${e.nom}</option>`).join(''))}
        ${selectHtml('nf-compte', 'Compte vinculat (opcional)', comptesCache.map((c) => `<option value="${c.id}">${c.num_compte}${c.descripcio ? ' — ' + c.descripcio : ''}</option>`).join(''), true)}
        <label>Tipus
          <select id="nf-tipus">
            <option value="prestec">Préstec</option>
            <option value="leasing">Leasing</option>
            <option value="renting">Renting</option>
          </select>
        </label>
        <label>Descripció <input type="text" id="nf-descripcio" placeholder="p. ex. Préstec ICF maquinària 2026" /></label>
        <label>Activitat
          <select id="nf-activitat">
            <option value="comuna">Comuna</option>
            <option value="fruita_cereal">Fruita/cereal</option>
            <option value="serveis">Serveis</option>
          </select>
        </label>
      </div>
      <div class="modal-section">
        <label>Capital inicial (€) <input type="number" id="nf-capital" step="0.01" /></label>
        <label>Data inici <input type="date" id="nf-data-inici" /></label>
        <label>Data fi prevista <input type="date" id="nf-data-fi" /></label>
        <label>Tipus d'interès (%) <input type="number" id="nf-interes" step="0.01" /></label>
        <label>Quota periòdica (€) <input type="number" id="nf-quota" step="0.01" /></label>
        <label>Periodicitat
          <select id="nf-periodicitat">
            <option value="mensual">Mensual</option>
            <option value="trimestral">Trimestral</option>
            <option value="altres">Altres</option>
          </select>
        </label>
        <label id="camp-opcio-compra" style="display:none;">Opció de compra final (€) <input type="number" id="nf-opcio-compra" step="0.01" /></label>
      </div>
      <label><input type="checkbox" id="nf-generar-quotes" checked /> Generar automàticament el quadre de quotes (mensual/trimestral)</label>
      <button type="button" id="btn-desar-prestec">Desar</button>
    `,
    onMount: (bodyEl) => {
      bodyEl.querySelector('#nf-tipus').addEventListener('change', (e) => {
        bodyEl.querySelector('#camp-opcio-compra').style.display = e.target.value === 'leasing' ? 'block' : 'none';
      });
      bodyEl.querySelector('#btn-desar-prestec').addEventListener('click', () => desarNouPrestec(bodyEl));
    },
  });
}

async function desarNouPrestec(bodyEl) {
  const val = (id) => bodyEl.querySelector(`#${id}`).value || null;
  const num = (id) => (bodyEl.querySelector(`#${id}`).value ? parseFloat(bodyEl.querySelector(`#${id}`).value) : null);

  const prestec = {
    entitat_id: val('nf-entitat'),
    compte_id: val('nf-compte'),
    tipus_producte: val('nf-tipus'),
    descripcio: val('nf-descripcio'),
    activitat: val('nf-activitat'),
    capital_inicial: num('nf-capital'),
    data_inici: val('nf-data-inici'),
    data_fi_prevista: val('nf-data-fi'),
    tipus_interes: num('nf-interes'),
    quota_periodica: num('nf-quota'),
    periodicitat: val('nf-periodicitat'),
    opcio_compra: num('nf-opcio-compra'),
    capital_pendent: num('nf-capital'),
    estat: 'actiu',
  };

  const { data, error } = await supabase.from('gaco_prestecs').insert(prestec).select('id').single();
  if (error) {
    alert('Error desant el préstec: ' + error.message);
    return;
  }

  if (bodyEl.querySelector('#nf-generar-quotes').checked) {
    await generarQuotes(data.id, prestec);
  }

  closeModal();
  carregarLlista();
}

/**
 * Genera el quadre de quotes amb dates espaiades segons periodicitat i
 * import_quota = quota_periodica. El desglossament capital/interessos de
 * cada quota es deixa buit (null) — no el podem calcular sense el quadre
 * d'amortització real del banc; s'omple més tard editant cada quota quan
 * arribi (o es dedueix del rebut un cop conciliat).
 */
async function generarQuotes(prestecId, prestec) {
  if (!prestec.data_inici || !prestec.data_fi_prevista || !prestec.periodicitat || prestec.periodicitat === 'altres') {
    return; // no es pot generar automàticament — l'usuari afegirà quotes manualment
  }
  const pasMesos = prestec.periodicitat === 'trimestral' ? 3 : 1;
  const quotes = [];
  let data = new Date(prestec.data_inici);
  const dataFi = new Date(prestec.data_fi_prevista);
  let num = 1;

  while (data <= dataFi) {
    quotes.push({
      prestec_id: prestecId,
      num_quota: num,
      data_prevista: data.toISOString().slice(0, 10),
      import_quota: prestec.quota_periodica,
      estat: 'pendent',
    });
    data.setMonth(data.getMonth() + pasMesos);
    num++;
  }

  if (quotes.length) {
    const { error } = await supabase.from('gaco_quotes_prestec').insert(quotes);
    if (error) alert('Préstec desat, però hi ha hagut un error generant les quotes: ' + error.message);
  }
}

async function obrirModalQuotes(prestecId, nomPrestec) {
  const { data: quotes, error } = await supabase
    .from('gaco_quotes_prestec')
    .select('id, num_quota, data_prevista, import_quota, import_capital, import_interessos, data_pagament, estat')
    .eq('prestec_id', prestecId)
    .order('num_quota');

  if (error) {
    alert('Error carregant les quotes: ' + error.message);
    return;
  }

  openModal({
    title: `Quotes — ${nomPrestec || ''}`,
    wide: true,
    bodyHtml: `
      <div id="llista-quotes">${quotes.map(htmlQuota).join('') || '<p>Cap quota generada encara.</p>'}</div>
      <div class="modal-section">
        <p class="modal-section-title">Afegir quota manual</p>
        <label>Núm. <input type="number" id="q-num" value="${quotes.length + 1}" style="width:70px;" /></label>
        <label>Data prevista <input type="date" id="q-data" /></label>
        <label>Import (€) <input type="number" id="q-import" step="0.01" /></label>
        <button type="button" id="btn-afegir-quota">Afegir</button>
      </div>
    `,
    onMount: (bodyEl) => {
      bodyEl.querySelector('#btn-afegir-quota').addEventListener('click', async () => {
        const { error: errIns } = await supabase.from('gaco_quotes_prestec').insert({
          prestec_id: prestecId,
          num_quota: parseInt(bodyEl.querySelector('#q-num').value, 10),
          data_prevista: bodyEl.querySelector('#q-data').value,
          import_quota: parseFloat(bodyEl.querySelector('#q-import').value) || null,
          estat: 'pendent',
        });
        if (errIns) {
          alert('Error afegint la quota: ' + errIns.message);
          return;
        }
        closeModal();
        obrirModalQuotes(prestecId, nomPrestec);
      });
    },
  });
}

function htmlQuota(q) {
  return `
    <div class="card">
      <p>#${q.num_quota} — ${formatData(q.data_prevista)} · ${formatImport(q.import_quota)} · ${q.estat === 'pagada' ? '✅ Pagada' : 'Pendent'}</p>
      ${q.estat === 'pagada' ? `<p style="color: var(--gaco-text-secondary);">Pagada el ${formatData(q.data_pagament)}${q.import_capital !== null ? ` · Capital: ${formatImport(q.import_capital)} · Interessos: ${formatImport(q.import_interessos)}` : ''}</p>` : ''}
    </div>
  `;
}
