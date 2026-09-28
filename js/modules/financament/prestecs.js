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
        <label>Capital pendent avui (€) — deixeu igual que el capital inicial si és un préstec nou
          <input type="number" id="nf-capital-pendent" step="0.01" /></label>
        <label>Data inici <input type="date" id="nf-data-inici" /></label>
        <label>Data fi prevista <input type="date" id="nf-data-fi" /></label>
        <label>Tipus d'interès (%) <input type="number" id="nf-interes" step="0.01" /></label>
        <label>Modalitat d'interès
          <select id="nf-interes-modalitat">
            <option value="fix">Fix</option>
            <option value="variable">Variable</option>
          </select>
        </label>
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
      <div class="modal-section">
        <p class="modal-section-title">Carència (opcional)</p>
        <label>Tipus de carència
          <select id="nf-tipus-carencia">
            <option value="">Sense carència</option>
            <option value="total">Total (sense quota)</option>
            <option value="nomes_interessos">Només interessos (sense amortitzar capital)</option>
          </select>
        </label>
        <label>Fi de la carència <input type="date" id="nf-fi-carencia" /></label>
      </div>
      <label><input type="checkbox" id="nf-generar-quotes" checked /> Generar automàticament el quadre de quotes (mensual/trimestral)</label>
      <div class="modal-section">
        <label>Generar quotes a partir de (buit = data d'inici; useu la data d'avui si el préstec ja porta temps en marxa)
          <input type="date" id="nf-generar-des-de" /></label>
        <label>Número de la primera quota a generar
          <input type="number" id="nf-primera-quota-num" value="1" style="width:80px;" /></label>
      </div>
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
    tipus_interes_modalitat: val('nf-interes-modalitat'),
    quota_periodica: num('nf-quota'),
    periodicitat: val('nf-periodicitat'),
    opcio_compra: num('nf-opcio-compra'),
    tipus_carencia: val('nf-tipus-carencia'),
    data_fi_carencia: val('nf-fi-carencia'),
    capital_pendent: num('nf-capital-pendent') ?? num('nf-capital'),
    estat: 'actiu',
  };

  const { data, error } = await supabase.from('gaco_prestecs').insert(prestec).select('id').single();
  if (error) {
    alert('Error desant el préstec: ' + error.message);
    return;
  }

  if (bodyEl.querySelector('#nf-generar-quotes').checked) {
    const generarDesDe = bodyEl.querySelector('#nf-generar-des-de').value || prestec.data_inici;
    const primeraQuotaNum = parseInt(bodyEl.querySelector('#nf-primera-quota-num').value, 10) || 1;
    await generarQuotes(data.id, prestec, generarDesDe, primeraQuotaNum);
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
 *
 * `generarDesDe`/`primeraQuotaNum` permeten donar d'alta un préstec que ja
 * porta temps en marxa sense fabricar quotes "pendents" de dates passades
 * que en realitat ja estan pagades fora de GACO — es genera només des
 * d'ara endavant, amb el número de quota real que li correspongui.
 */
async function generarQuotes(prestecId, prestec, generarDesDe, primeraQuotaNum) {
  if (!prestec.data_inici || !prestec.data_fi_prevista || !prestec.periodicitat || prestec.periodicitat === 'altres') {
    return; // no es pot generar automàticament — l'usuari afegirà quotes manualment
  }
  const pasMesos = prestec.periodicitat === 'trimestral' ? 3 : 1;
  const quotes = [];
  let data = new Date(prestec.data_inici);
  const dataFi = new Date(prestec.data_fi_prevista);
  let num = 1;

  while (data <= dataFi) {
    const dataStr = data.toISOString().slice(0, 10);
    if (dataStr >= generarDesDe) {
      const dinsCarencia = prestec.data_fi_carencia && dataStr <= prestec.data_fi_carencia;
      quotes.push({
        prestec_id: prestecId,
        num_quota: primeraQuotaNum + (num - 1),
        data_prevista: dataStr,
        import_quota: dinsCarencia && prestec.tipus_carencia === 'total' ? 0 : prestec.quota_periodica,
        import_capital: dinsCarencia ? 0 : null, // 'total' o 'nomes_interessos': no amortitza capital
        estat: 'pendent',
      });
    }
    data.setMonth(data.getMonth() + pasMesos);
    num++;
  }

  if (quotes.length) {
    const { error } = await supabase.from('gaco_quotes_prestec').insert(quotes);
    if (error) alert('Préstec desat, però hi ha hagut un error generant les quotes: ' + error.message);
  }
}

async function obtenirPctBonificacioVigent(prestecId, data) {
  const { data: fila } = await supabase
    .from('gaco_prestecs_bonificacions_interes')
    .select('pct_bonificacio')
    .eq('prestec_id', prestecId)
    .lte('data_inici', data)
    .or(`data_fi.is.null,data_fi.gte.${data}`)
    .order('data_inici', { ascending: false })
    .limit(1)
    .maybeSingle();
  return fila?.pct_bonificacio ?? 0;
}

async function obrirModalQuotes(prestecId, nomPrestec) {
  const [{ data: quotes, error }, { data: bonificacions }] = await Promise.all([
    supabase
      .from('gaco_quotes_prestec')
      .select('id, num_quota, data_prevista, import_quota, import_capital, import_interessos, import_interessos_teorics, import_interessos_bonificats, data_pagament, estat')
      .eq('prestec_id', prestecId)
      .order('num_quota'),
    supabase
      .from('gaco_prestecs_bonificacions_interes')
      .select('id, data_inici, data_fi, pct_bonificacio')
      .eq('prestec_id', prestecId)
      .order('data_inici'),
  ]);

  if (error) {
    alert('Error carregant les quotes: ' + error.message);
    return;
  }

  openModal({
    title: `Quotes — ${nomPrestec || ''}`,
    wide: true,
    bodyHtml: `
      <div class="modal-section">
        <p class="modal-section-title">Bonificació d'interessos vigent</p>
        <div id="llista-bonificacions">${(bonificacions ?? []).map(htmlBonificacio).join('') || '<p>Cap tram definit — es considera 0% de bonificació.</p>'}</div>
        <label>Des de <input type="date" id="b-data-inici" /></label>
        <label>Fins a (buit = indefinit) <input type="date" id="b-data-fi" /></label>
        <label>% Bonificació <input type="number" id="b-pct" step="0.01" style="width:80px;" /></label>
        <button type="button" id="btn-afegir-bonificacio">Afegir tram</button>
      </div>
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
      bodyEl.querySelector('#btn-afegir-bonificacio').addEventListener('click', async () => {
        const dataInici = bodyEl.querySelector('#b-data-inici').value;
        const pct = bodyEl.querySelector('#b-pct').value;
        if (!dataInici) {
          alert('Cal indicar la data "Des de" del tram de bonificació.');
          return;
        }
        if (pct === '') {
          alert('Cal indicar el % de bonificació.');
          return;
        }
        const { error: errB } = await supabase.from('gaco_prestecs_bonificacions_interes').insert({
          prestec_id: prestecId,
          data_inici: dataInici,
          data_fi: bodyEl.querySelector('#b-data-fi').value || null,
          pct_bonificacio: parseFloat(pct),
        });
        if (errB) {
          alert('Error afegint el tram de bonificació: ' + errB.message);
          return;
        }
        closeModal();
        obrirModalQuotes(prestecId, nomPrestec);
      });

      bodyEl.querySelector('#btn-afegir-quota').addEventListener('click', async () => {
        const dataPrevista = bodyEl.querySelector('#q-data').value;
        if (!dataPrevista) {
          alert('Cal indicar la data prevista de la quota.');
          return;
        }
        const { error: errIns } = await supabase.from('gaco_quotes_prestec').insert({
          prestec_id: prestecId,
          num_quota: parseInt(bodyEl.querySelector('#q-num').value, 10),
          data_prevista: dataPrevista,
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

      bodyEl.querySelectorAll('[data-editar-quota]').forEach((btn) => {
        btn.addEventListener('click', () => toggleEditorQuota(bodyEl, btn.dataset.editarQuota, prestecId, nomPrestec));
      });
    },
  });
}

function htmlBonificacio(b) {
  return `<p>${formatData(b.data_inici)} — ${b.data_fi ? formatData(b.data_fi) : 'indefinit'}: <strong>${b.pct_bonificacio}%</strong></p>`;
}

function htmlQuota(q) {
  return `
    <div class="card" id="quota-${q.id}">
      <p>#${q.num_quota} — ${formatData(q.data_prevista)} · ${formatImport(q.import_quota)} · ${q.estat === 'pagada' ? '✅ Pagada' : 'Pendent'}</p>
      ${
        q.import_capital !== null
          ? `<p style="color: var(--gaco-text-secondary);">Capital: ${formatImport(q.import_capital)} · Interessos pagats: ${formatImport(q.import_interessos)}${q.import_interessos_bonificats ? ` · Bonificats: ${formatImport(q.import_interessos_bonificats)}` : ''}</p>`
          : ''
      }
      <button type="button" data-editar-quota="${q.id}">Editar detall (AMORT / INTS del rebut)</button>
      <div id="editor-quota-${q.id}"></div>
    </div>
  `;
}

async function toggleEditorQuota(bodyEl, quotaId, prestecId, nomPrestec) {
  const contenidor = bodyEl.querySelector(`#editor-quota-${quotaId}`);
  if (contenidor.innerHTML) {
    contenidor.innerHTML = '';
    return;
  }

  const { data: quota } = await supabase
    .from('gaco_quotes_prestec')
    .select('data_prevista, data_pagament')
    .eq('id', quotaId)
    .single();
  const pctVigent = await obtenirPctBonificacioVigent(prestecId, quota.data_pagament || quota.data_prevista);

  contenidor.innerHTML = `
    <div class="modal-section">
      <p style="font-size:13px; color: var(--gaco-text-secondary);">Bonificació vigent en aquesta data: ${pctVigent}%</p>
      <label>AMORT (capital, €) <input type="number" id="e-amort-${quotaId}" step="0.01" /></label>
      <label>INTS (interès teòric del rebut, €) <input type="number" id="e-ints-${quotaId}" step="0.01" /></label>
      <p id="e-resultat-${quotaId}"></p>
      <button type="button" id="e-calcular-${quotaId}">Calcular</button>
      <button type="button" id="e-desar-${quotaId}" disabled>Desar</button>
    </div>
  `;

  let calculat = null;
  contenidor.querySelector(`#e-calcular-${quotaId}`).addEventListener('click', () => {
    const amort = parseFloat(contenidor.querySelector(`#e-amort-${quotaId}`).value) || 0;
    const ints = parseFloat(contenidor.querySelector(`#e-ints-${quotaId}`).value) || 0;
    const bonificats = +((ints * pctVigent) / 100).toFixed(2);
    const pagats = +(ints - bonificats).toFixed(2);
    const total = +(amort + pagats).toFixed(2);
    calculat = { import_capital: amort, import_interessos_teorics: ints, import_interessos_bonificats: bonificats, import_interessos: pagats, import_quota: total };
    contenidor.querySelector(`#e-resultat-${quotaId}`).innerHTML =
      `Interessos pagats: ${formatImport(pagats)} · Bonificats: ${formatImport(bonificats)} · <strong>Total quota: ${formatImport(total)}</strong>`;
    contenidor.querySelector(`#e-desar-${quotaId}`).disabled = false;
  });

  contenidor.querySelector(`#e-desar-${quotaId}`).addEventListener('click', async () => {
    if (!calculat) return;
    const { error } = await supabase.from('gaco_quotes_prestec').update(calculat).eq('id', quotaId);
    if (error) {
      alert('Error desant el detall: ' + error.message);
      return;
    }
    closeModal();
    obrirModalQuotes(prestecId, nomPrestec);
  });
}
