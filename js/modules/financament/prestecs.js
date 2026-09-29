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

function avui() {
  return new Date().toISOString().slice(0, 10);
}

const ETIQUETES_TIPUS_PRODUCTE = { prestec: 'Préstec', leasing: 'Leasing', renting: 'Renting' };
const ETIQUETES_PERIODICITAT = { mensual: 'Mensual', trimestral: 'Trimestral', semestral: 'Semestral', anual: 'Anual', altres: 'Altres' };
const ETIQUETES_TIPUS_QUOTA = {
  frances: 'Francès (quota constant)',
  alemany: 'Alemany (capital constant)',
  americana: 'Americà (només interessos + capital al final)',
};
// Mesos que avança cada quota / períodes que hi ha en un any, per periodicitat.
const PAS_MESOS = { mensual: 1, trimestral: 3, semestral: 6, anual: 12 };
const PERIODES_ANY = { mensual: 12, trimestral: 4, semestral: 2, anual: 1 };

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
  llistaEl.querySelectorAll('[data-veure]').forEach((btn) => {
    btn.addEventListener('click', () => obrirModalVeurePrestec(btn.dataset.veure));
  });
  llistaEl.querySelectorAll('[data-editar]').forEach((btn) => {
    btn.addEventListener('click', () => obrirModalEditarPrestec(btn.dataset.editar));
  });
}

function htmlPrestec(p) {
  return `
    <div class="card">
      <p class="modal-section-title">${p.gaco_entitats_bancaries?.nom ?? '?'} · ${ETIQUETES_TIPUS_PRODUCTE[p.tipus_producte] ?? p.tipus_producte} · ${p.estat === 'liquidat' ? 'Liquidat' : 'Actiu'}</p>
      <p><strong>${p.descripcio ?? '(sense descripció)'}</strong></p>
      <p>Capital inicial: ${formatImport(p.capital_inicial)} · Pendent: ${formatImport(p.capital_pendent)}</p>
      <p>Quota ${ETIQUETES_PERIODICITAT[p.periodicitat] ?? p.periodicitat}: ${formatImport(p.quota_periodica)}</p>
      <button type="button" data-veure="${p.id}">Veure</button>
      <button type="button" data-editar="${p.id}">Editar</button>
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

function formulariPrestecHtml(v = {}) {
  return `
      <div class="modal-section">
        ${selectHtml('nf-entitat', 'Entitat', entitatsCache.map((e) => `<option value="${e.id}" ${e.id === v.entitat_id ? 'selected' : ''}>${e.nom}</option>`).join(''))}
        ${selectHtml('nf-compte', 'Compte vinculat (opcional)', comptesCache.map((c) => `<option value="${c.id}" ${c.id === v.compte_id ? 'selected' : ''}>${c.num_compte}${c.descripcio ? ' — ' + c.descripcio : ''}</option>`).join(''), true)}
        <label>Tipus
          <select id="nf-tipus">
            <option value="prestec" ${v.tipus_producte === 'prestec' ? 'selected' : ''}>Préstec</option>
            <option value="leasing" ${v.tipus_producte === 'leasing' ? 'selected' : ''}>Leasing</option>
            <option value="renting" ${v.tipus_producte === 'renting' ? 'selected' : ''}>Renting</option>
          </select>
        </label>
        <label>Descripció <input type="text" id="nf-descripcio" value="${v.descripcio ?? ''}" placeholder="p. ex. Préstec ICF maquinària 2026" /></label>
        <label>Activitat
          <select id="nf-activitat">
            <option value="comuna" ${v.activitat === 'comuna' ? 'selected' : ''}>Comuna</option>
            <option value="fruita_cereal" ${v.activitat === 'fruita_cereal' ? 'selected' : ''}>Fruita/cereal</option>
            <option value="serveis" ${v.activitat === 'serveis' ? 'selected' : ''}>Serveis</option>
          </select>
        </label>
      </div>
      <div class="modal-section">
        <label>Capital inicial (€) <input type="number" id="nf-capital" step="0.01" value="${v.capital_inicial ?? ''}" /></label>
        <label>Capital pendent avui (€) — deixeu igual que el capital inicial si és un préstec nou
          <input type="number" id="nf-capital-pendent" step="0.01" value="${v.capital_pendent ?? ''}" /></label>
        <label>Data inici <input type="date" id="nf-data-inici" value="${v.data_inici ?? ''}" /></label>
        <label>Data primera quota (si difereix de la data d'inici, p. ex. per carència)
          <input type="date" id="nf-data-1a-quota" value="${v.data_primera_quota ?? ''}" /></label>
        <label>Tipus d'interès anual (%) <input type="number" id="nf-interes" step="0.01" value="${v.tipus_interes ?? ''}" /></label>
        <label>Modalitat d'interès
          <select id="nf-interes-modalitat">
            <option value="fix" ${v.tipus_interes_modalitat !== 'variable' ? 'selected' : ''}>Fix</option>
            <option value="variable" ${v.tipus_interes_modalitat === 'variable' ? 'selected' : ''}>Variable</option>
          </select>
        </label>
        <label>Periodicitat
          <select id="nf-periodicitat">
            <option value="mensual" ${v.periodicitat === 'mensual' ? 'selected' : ''}>Mensual</option>
            <option value="trimestral" ${v.periodicitat === 'trimestral' ? 'selected' : ''}>Trimestral</option>
            <option value="semestral" ${v.periodicitat === 'semestral' ? 'selected' : ''}>Semestral</option>
            <option value="anual" ${v.periodicitat === 'anual' ? 'selected' : ''}>Anual</option>
            <option value="altres" ${v.periodicitat === 'altres' ? 'selected' : ''}>Altres (sense càlcul automàtic)</option>
          </select>
        </label>
        <label>Nº de quotes totals (incloent-hi carència)
          <input type="number" id="nf-num-quotes" value="${v.nombre_quotes ?? ''}" style="width:90px;" /></label>
        <label>Sistema d'amortització
          <select id="nf-tipus-quota">
            <option value="frances" ${(!v.tipus_quota || v.tipus_quota === 'frances') ? 'selected' : ''}>Francès (quota constant)</option>
            <option value="alemany" ${v.tipus_quota === 'alemany' ? 'selected' : ''}>Alemany (capital constant)</option>
            <option value="americana" ${v.tipus_quota === 'americana' ? 'selected' : ''}>Americà (interessos + capital al final)</option>
          </select>
        </label>
        <label id="camp-quota-fixa">
          <span id="etiqueta-quota-fixa">Quota periòdica (€)</span> <input type="number" id="nf-quota" step="0.01" value="${v.quota_periodica ?? ''}" /></label>
        <button type="button" id="btn-calcular-quota">Calcular a partir del nº de quotes</button>
        <label>Data fi prevista (es calcula sola si poseu nº de quotes + data primera quota)
          <input type="date" id="nf-data-fi" value="${v.data_fi_prevista ?? ''}" /></label>
        <label id="camp-opcio-compra" style="display:${v.tipus_producte === 'leasing' ? 'block' : 'none'};">Opció de compra final (€)
          <input type="number" id="nf-opcio-compra" step="0.01" value="${v.opcio_compra ?? ''}" /></label>
      </div>
      <div class="modal-section">
        <p class="modal-section-title">Carència (opcional)</p>
        <label>Tipus de carència
          <select id="nf-tipus-carencia">
            <option value="" ${!v.tipus_carencia ? 'selected' : ''}>Sense carència</option>
            <option value="total" ${v.tipus_carencia === 'total' ? 'selected' : ''}>Total (sense quota)</option>
            <option value="nomes_interessos" ${v.tipus_carencia === 'nomes_interessos' ? 'selected' : ''}>Només interessos (sense amortitzar capital)</option>
          </select>
        </label>
        <label>Fi de la carència <input type="date" id="nf-fi-carencia" value="${v.data_fi_carencia ?? ''}" /></label>
      </div>
      <div class="modal-section">
        <label>Notes <textarea id="nf-notes" rows="2" style="width:100%;">${v.notes ?? ''}</textarea></label>
      </div>
      <p style="font-size:13px; color: var(--gaco-text-secondary);">
        El quadre de quotes (amb capital/interessos/bonificació calculats) es genera/recalcula des de "Veure quotes".
      </p>
  `;
}

function attachFormulariListeners(bodyEl) {
  bodyEl.querySelector('#nf-tipus').addEventListener('change', (e) => {
    bodyEl.querySelector('#camp-opcio-compra').style.display = e.target.value === 'leasing' ? 'block' : 'none';
  });

  const actualitzarEtiquetaQuota = () => {
    const tipusQuota = bodyEl.querySelector('#nf-tipus-quota').value;
    const etiqueta = bodyEl.querySelector('#etiqueta-quota-fixa');
    const campQuota = bodyEl.querySelector('#camp-quota-fixa');
    if (tipusQuota === 'alemany') {
      etiqueta.textContent = 'Capital fix per quota (€)';
      campQuota.style.display = 'block';
    } else if (tipusQuota === 'americana') {
      etiqueta.textContent = 'Quota periòdica (€) — no s\'usa, només interessos fins l\'última';
      campQuota.style.display = 'none';
    } else {
      etiqueta.textContent = 'Quota periòdica (€)';
      campQuota.style.display = 'block';
    }
  };
  bodyEl.querySelector('#nf-tipus-quota').addEventListener('change', actualitzarEtiquetaQuota);
  actualitzarEtiquetaQuota();

  bodyEl.querySelector('#btn-calcular-quota').addEventListener('click', () => {
    const capital = parseFloat(bodyEl.querySelector('#nf-capital-pendent').value || bodyEl.querySelector('#nf-capital').value);
    const tipusInteres = parseFloat(bodyEl.querySelector('#nf-interes').value);
    const periodicitat = bodyEl.querySelector('#nf-periodicitat').value;
    const tipusQuota = bodyEl.querySelector('#nf-tipus-quota').value;
    const numQuotesTotal = parseInt(bodyEl.querySelector('#nf-num-quotes').value, 10);
    const tipusCarencia = bodyEl.querySelector('#nf-tipus-carencia').value;
    const dataPrimeraQuota = bodyEl.querySelector('#nf-data-1a-quota').value || bodyEl.querySelector('#nf-data-inici').value;
    const dataFiCarencia = bodyEl.querySelector('#nf-fi-carencia').value;

    if (!capital || !tipusInteres || !periodicitat || periodicitat === 'altres' || !numQuotesTotal || !dataPrimeraQuota) {
      alert('Per calcular calen: capital, tipus d\'interès, periodicitat (no "altres"), nº de quotes i data de la primera quota.');
      return;
    }

    const periodesAny = PERIODES_ANY[periodicitat];
    const pasMesos = PAS_MESOS[periodicitat];

    // Compta quantes de les N quotes cauen dins la carència (no amortitzen capital).
    let numCarencia = 0;
    if (tipusCarencia && dataFiCarencia) {
      let data = dataPrimeraQuota;
      for (let k = 0; k < numQuotesTotal && data <= dataFiCarencia; k++) {
        numCarencia++;
        data = afegirMesos(dataPrimeraQuota, (k + 1) * pasMesos);
      }
    }
    const numAmortitzacio = numQuotesTotal - numCarencia;
    if (numAmortitzacio <= 0 && tipusQuota !== 'americana') {
      alert('El nombre de quotes de carència iguala o supera el total de quotes — reviseu les dates.');
      return;
    }

    if (tipusQuota === 'alemany') {
      const capitalFix = Math.round((capital / numAmortitzacio) * 100) / 100;
      bodyEl.querySelector('#nf-quota').value = capitalFix.toFixed(2);
    } else if (tipusQuota === 'americana') {
      bodyEl.querySelector('#nf-quota').value = ''; // no s'usa: capital=0 fins l'última quota
    } else {
      const quota = calcularQuotaAnualitat(capital, tipusInteres, periodesAny, numAmortitzacio);
      bodyEl.querySelector('#nf-quota').value = quota.toFixed(2);
    }

    // Data fi = data de l'última quota.
    const dataFi = afegirMesos(dataPrimeraQuota, (numQuotesTotal - 1) * pasMesos);
    bodyEl.querySelector('#nf-data-fi').value = dataFi;
  });
}

function llegirFormulariPrestec(bodyEl) {
  const val = (id) => bodyEl.querySelector(`#${id}`).value || null;
  const num = (id) => (bodyEl.querySelector(`#${id}`).value ? parseFloat(bodyEl.querySelector(`#${id}`).value) : null);
  return {
    entitat_id: val('nf-entitat'),
    compte_id: val('nf-compte'),
    tipus_producte: val('nf-tipus'),
    descripcio: val('nf-descripcio'),
    activitat: val('nf-activitat'),
    capital_inicial: num('nf-capital'),
    data_inici: val('nf-data-inici'),
    data_primera_quota: val('nf-data-1a-quota'),
    data_fi_prevista: val('nf-data-fi'),
    nombre_quotes: num('nf-num-quotes') ? parseInt(bodyEl.querySelector('#nf-num-quotes').value, 10) : null,
    tipus_interes: num('nf-interes'),
    tipus_interes_modalitat: val('nf-interes-modalitat'),
    tipus_quota: val('nf-tipus-quota'),
    quota_periodica: num('nf-quota'),
    periodicitat: val('nf-periodicitat'),
    opcio_compra: num('nf-opcio-compra'),
    tipus_carencia: val('nf-tipus-carencia'),
    data_fi_carencia: val('nf-fi-carencia'),
    notes: val('nf-notes'),
    capital_pendent: num('nf-capital-pendent') ?? num('nf-capital'),
  };
}

function obrirModalNouPrestec() {
  openModal({
    title: 'Nou préstec / leasing / renting',
    wide: true,
    bodyHtml: formulariPrestecHtml() + '<button type="button" id="btn-desar-prestec">Desar</button>',
    onMount: (bodyEl) => {
      attachFormulariListeners(bodyEl);
      bodyEl.querySelector('#btn-desar-prestec').addEventListener('click', () => desarNouPrestec(bodyEl));
    },
  });
}

async function desarNouPrestec(bodyEl) {
  const prestec = { ...llegirFormulariPrestec(bodyEl), estat: 'actiu' };

  const { error } = await supabase.from('gaco_prestecs').insert(prestec);
  if (error) {
    alert('Error desant el préstec: ' + error.message);
    return;
  }

  closeModal();
  carregarLlista();
}

async function obrirModalEditarPrestec(prestecId) {
  const { data: v, error } = await supabase.from('gaco_prestecs').select('*').eq('id', prestecId).single();
  if (error) {
    alert('Error carregant el préstec: ' + error.message);
    return;
  }

  openModal({
    title: `Editar — ${v.descripcio ?? ''}`,
    wide: true,
    bodyHtml:
      formulariPrestecHtml(v) +
      `<label>Estat
        <select id="nf-estat">
          <option value="actiu" ${v.estat === 'actiu' ? 'selected' : ''}>Actiu</option>
          <option value="liquidat" ${v.estat === 'liquidat' ? 'selected' : ''}>Liquidat</option>
        </select>
      </label>
      <button type="button" id="btn-desar-prestec">Desar canvis</button>`,
    onMount: (bodyEl) => {
      attachFormulariListeners(bodyEl);
      bodyEl.querySelector('#btn-desar-prestec').addEventListener('click', async () => {
        const canvis = { ...llegirFormulariPrestec(bodyEl), estat: bodyEl.querySelector('#nf-estat').value };
        const { error: errUpd } = await supabase.from('gaco_prestecs').update(canvis).eq('id', prestecId);
        if (errUpd) {
          alert('Error desant els canvis: ' + errUpd.message);
          return;
        }
        closeModal();
        carregarLlista();
      });
    },
  });
}

async function obrirModalVeurePrestec(prestecId) {
  const { data: v, error } = await supabase
    .from('gaco_prestecs')
    .select('*, gaco_entitats_bancaries ( nom ), gaco_comptes ( num_compte, descripcio )')
    .eq('id', prestecId)
    .single();
  if (error) {
    alert('Error carregant el préstec: ' + error.message);
    return;
  }

  const fila = (etiqueta, valor) => `<p><span style="color: var(--gaco-text-secondary);">${etiqueta}:</span> ${valor ?? '—'}</p>`;

  openModal({
    title: v.descripcio ?? 'Préstec',
    wide: true,
    bodyHtml: `
      <div class="modal-section">
        ${fila('Entitat', v.gaco_entitats_bancaries?.nom)}
        ${fila('Compte vinculat', v.gaco_comptes ? `${v.gaco_comptes.num_compte}${v.gaco_comptes.descripcio ? ' — ' + v.gaco_comptes.descripcio : ''}` : null)}
        ${fila('Tipus', ETIQUETES_TIPUS_PRODUCTE[v.tipus_producte] ?? v.tipus_producte)}
        ${fila('Activitat', v.activitat)}
        ${fila('Estat', v.estat === 'liquidat' ? 'Liquidat' : 'Actiu')}
      </div>
      <div class="modal-section">
        ${fila('Capital inicial', formatImport(v.capital_inicial))}
        ${fila('Capital pendent', formatImport(v.capital_pendent))}
        ${fila('Data inici', formatData(v.data_inici))}
        ${fila('Data primera quota', formatData(v.data_primera_quota))}
        ${fila('Data fi prevista', formatData(v.data_fi_prevista))}
        ${fila('Nº de quotes', v.nombre_quotes)}
        ${fila('Tipus d\'interès', v.tipus_interes !== null ? v.tipus_interes + '%' : null)}
        ${fila('Modalitat', v.tipus_interes_modalitat === 'variable' ? 'Variable' : 'Fix')}
        ${fila('Periodicitat', ETIQUETES_PERIODICITAT[v.periodicitat] ?? v.periodicitat)}
        ${fila('Sistema d\'amortització', ETIQUETES_TIPUS_QUOTA[v.tipus_quota] ?? v.tipus_quota)}
        ${fila('Quota periòdica', formatImport(v.quota_periodica))}
        ${v.tipus_producte === 'leasing' ? fila('Opció de compra', formatImport(v.opcio_compra)) : ''}
      </div>
      <div class="modal-section">
        ${fila('Carència', v.tipus_carencia ? (v.tipus_carencia === 'total' ? 'Total' : 'Només interessos') + ' fins ' + formatData(v.data_fi_carencia) : 'Sense carència')}
      </div>
      ${v.notes ? `<div class="modal-section">${fila('Notes', v.notes)}</div>` : ''}
    `,
  });
}

// ----------------------------------------------------------------------------
// Càlcul del quadre d'amortització (sistema francès: quota fixa, interès =
// capital pendent × tipus anual ÷ períodes/any). Verificat número a número
// amb un quadre real de l'usuari (ICF, 50.000 €, 3,5%, mensual).
// ----------------------------------------------------------------------------

function pctVigentLocal(bonificacions, dataStr) {
  const fila = bonificacions.find((b) => b.data_inici <= dataStr && (!b.data_fi || b.data_fi >= dataStr));
  return fila ? fila.pct_bonificacio : 0;
}

/**
 * Tipus d'interès vigent en una data, per a préstecs a interès variable:
 * la revisió més recent amb data_revisio <= dataStr (si n'hi ha alguna),
 * si no, el tipus base del préstec.
 */
function tipusInteresVigentLocal(revisions, tipusInteresBase, dataStr) {
  const aplicables = revisions.filter((r) => r.data_revisio <= dataStr).sort((a, b) => (a.data_revisio < b.data_revisio ? 1 : -1));
  return aplicables.length ? aplicables[0].tipus_interes_nou : tipusInteresBase;
}

/**
 * Quota fixa exacta (sistema francès) perquè `capital` quedi a 0 en
 * exactament `n` períodes, a un tipus anual `tipusInteres` (%) amb
 * `periodesAny` pagaments l'any. Mateixa fórmula que ja fem servir a
 * conciliacio.js per recalcular la quota després d'una amortització
 * extraordinària amb "mateix termini".
 */
function calcularQuotaAnualitat(capital, tipusInteres, periodesAny, n) {
  const i = tipusInteres / 100 / periodesAny;
  if (n <= 0) return 0;
  return i === 0 ? capital / n : (capital * i) / (1 - Math.pow(1 + i, -n));
}

/**
 * Suma `mesos` a una data 'YYYY-MM-DD' amb aritmètica pura (sense Date local,
 * per no patir desplaçaments d'un dia pel canvi d'hora estiu/hivern) i
 * conservant el dia original quan el mes destí el permet (si no, l'últim dia).
 */
function afegirMesos(dataStr, mesos) {
  const [y, m, d] = dataStr.split('-').map(Number);
  const total = y * 12 + (m - 1) + mesos;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const ultimDia = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, ultimDia);
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

function calcularQuadreAmortitzacio({
  prestecId,
  capitalInicial,
  dataIniciStr,
  dataFiStr,
  numQuotaInicial,
  quotaPeriodica, // frances: quota total fixa. alemany: capital fix per període. americana: no s'usa.
  periodicitat,
  tipusInteres,
  tipusCarencia,
  dataFiCarencia,
  bonificacions,
  tipusQuota = 'frances',
  revisionsInteres = [],
}) {
  const pasMesos = PAS_MESOS[periodicitat] ?? 1;
  const periodesAny = PERIODES_ANY[periodicitat] ?? 12;
  const quotes = [];
  let capitalPendent = capitalInicial;
  let num = numQuotaInicial;
  let k = 0;
  let dataStr = dataIniciStr;

  while (dataStr <= dataFiStr && capitalPendent > 0.005) {
    const dinsCarencia = dataFiCarencia && dataStr <= dataFiCarencia;
    const esDarreraQuota = afegirMesos(dataIniciStr, (k + 1) * pasMesos) > dataFiStr;
    const tipusInteresVigent = tipusInteresVigentLocal(revisionsInteres, tipusInteres, dataStr);

    let interessosTeorics = Math.round(((capitalPendent * (tipusInteresVigent / 100)) / periodesAny) * 100) / 100;
    let capital;
    if (dinsCarencia && tipusCarencia === 'total') {
      capital = 0;
      interessosTeorics = 0;
    } else if (dinsCarencia && tipusCarencia === 'nomes_interessos') {
      capital = 0;
    } else if (esDarreraQuota) {
      capital = capitalPendent; // última quota: absorbeix qualsevol residu d'arrodoniment
    } else if (tipusQuota === 'alemany') {
      capital = Math.min(quotaPeriodica, capitalPendent); // capital fix cada període
    } else if (tipusQuota === 'americana') {
      capital = 0; // no amortitza fins l'última quota (gestionat per esDarreraQuota)
    } else {
      capital = Math.round((quotaPeriodica - interessosTeorics) * 100) / 100; // frances
      if (capital > capitalPendent) capital = capitalPendent; // payoff anticipat (p. ex. quota massa alta)
      if (capital < 0) capital = 0; // la quota no cobreix ni l'interès (cas rar) — evita capital negatiu
    }

    const pct = pctVigentLocal(bonificacions, dataStr);
    const bonificats = Math.round(((interessosTeorics * pct) / 100) * 100) / 100;
    const pagats = Math.round((interessosTeorics - bonificats) * 100) / 100;
    const quotaAPagar = Math.round((capital + pagats) * 100) / 100;
    capitalPendent = Math.round((capitalPendent - capital) * 100) / 100;

    quotes.push({
      prestec_id: prestecId,
      num_quota: num,
      data_prevista: dataStr,
      import_capital: capital,
      import_interessos_teorics: interessosTeorics,
      import_interessos_bonificats: bonificats,
      import_interessos: pagats,
      import_quota: quotaAPagar,
      capital_pendent_despres: capitalPendent,
      data_pagament: null,
      estat: 'pendent',
    });

    k++;
    dataStr = afegirMesos(dataIniciStr, k * pasMesos);
    num++;
  }

  return quotes;
}

/**
 * Genera/recalcula el quadre a partir d'ara: esborra les quotes encara NO
 * pagades i les torna a calcular des del capital pendent i data actuals.
 * Les quotes ja marcades 'pagada' no es toquen — són fet històric.
 */
async function generarORecalcularQuadre(prestecId, prestec, bonificacions, revisionsInteres, dataDes, numInicial, marcarPagadesAbans) {
  const necessitaQuota = prestec.tipus_quota !== 'americana';
  if (!prestec.data_fi_prevista || !prestec.periodicitat || prestec.periodicitat === 'altres' || !prestec.tipus_interes || (necessitaQuota && !prestec.quota_periodica)) {
    alert("Falten dades del préstec (tipus d'interès, quota/capital fix, periodicitat mensual/trimestral/semestral/anual o data fi) per calcular el quadre automàticament.");
    return false;
  }

  const { error: errDel } = await supabase
    .from('gaco_quotes_prestec')
    .delete()
    .eq('prestec_id', prestecId)
    .eq('estat', 'pendent');
  if (errDel) {
    alert('Error esborrant les quotes pendents anteriors: ' + errDel.message);
    return false;
  }

  const quotes = calcularQuadreAmortitzacio({
    prestecId,
    capitalInicial: prestec.capital_pendent,
    dataIniciStr: dataDes,
    dataFiStr: prestec.data_fi_prevista,
    numQuotaInicial: numInicial,
    quotaPeriodica: prestec.quota_periodica,
    periodicitat: prestec.periodicitat,
    tipusInteres: prestec.tipus_interes,
    tipusCarencia: prestec.tipus_carencia,
    dataFiCarencia: prestec.data_fi_carencia,
    bonificacions,
    tipusQuota: prestec.tipus_quota,
    revisionsInteres,
  });

  // Historial: les quotes anteriors a la data de tall es donen per pagades
  // (ja liquidades fora de GACO) i el capital pendent passa a ser el que
  // queda després de l'última d'aquestes.
  let capitalPendentNou = null;
  if (marcarPagadesAbans) {
    for (const q of quotes) {
      if (q.data_prevista < marcarPagadesAbans) {
        q.estat = 'pagada';
        q.data_pagament = q.data_prevista;
        capitalPendentNou = q.capital_pendent_despres;
      }
    }
  }

  if (quotes.length) {
    const { error: errIns } = await supabase.from('gaco_quotes_prestec').insert(quotes);
    if (errIns) {
      alert('Error generant les quotes: ' + errIns.message);
      return false;
    }
  }

  if (capitalPendentNou !== null) {
    await supabase.from('gaco_prestecs').update({ capital_pendent: capitalPendentNou }).eq('id', prestecId);
  }
  return true;
}

async function obrirModalQuotes(prestecId, nomPrestec) {
  const [{ data: prestec, error: errPrestec }, { data: quotes, error }, { data: bonificacions }, { data: revisions }] = await Promise.all([
    supabase
      .from('gaco_prestecs')
      .select('capital_pendent, data_inici, data_primera_quota, data_fi_prevista, tipus_interes, tipus_interes_modalitat, tipus_quota, periodicitat, quota_periodica, tipus_carencia, data_fi_carencia')
      .eq('id', prestecId)
      .single(),
    supabase
      .from('gaco_quotes_prestec')
      .select('id, num_quota, data_prevista, import_quota, import_capital, import_interessos, import_interessos_teorics, import_interessos_bonificats, capital_pendent_despres, data_pagament, estat')
      .eq('prestec_id', prestecId)
      .order('num_quota'),
    supabase
      .from('gaco_prestecs_bonificacions_interes')
      .select('id, data_inici, data_fi, pct_bonificacio')
      .eq('prestec_id', prestecId)
      .order('data_inici'),
    supabase
      .from('gaco_prestecs_revisions_interes')
      .select('id, data_revisio, tipus_interes_nou')
      .eq('prestec_id', prestecId)
      .order('data_revisio'),
  ]);

  if (error || errPrestec) {
    alert('Error carregant les quotes: ' + (error?.message || errPrestec?.message));
    return;
  }

  const pagades = quotes.filter((q) => q.estat === 'pagada');
  const ultimaPagada = pagades[pagades.length - 1];
  const pasMesosDefecte = PAS_MESOS[prestec.periodicitat] ?? 1;
  const desDeDefecte = ultimaPagada ? afegirMesos(ultimaPagada.data_prevista, pasMesosDefecte) : prestec.data_primera_quota || prestec.data_inici || '';
  const numInicialDefecte = ultimaPagada ? ultimaPagada.num_quota + 1 : 1;

  openModal({
    title: `Quotes — ${nomPrestec || ''}`,
    wide: true,
    bodyHtml: `
      <div class="modal-section">
        <p class="modal-section-title">Bonificació d'interessos</p>
        <div id="llista-bonificacions">${(bonificacions ?? []).map((b) => htmlBonificacio(b)).join('') || '<p>Cap tram definit — es considera 0% de bonificació.</p>'}</div>
        <label>Des de <input type="date" id="b-data-inici" /></label>
        <label>Fins a (buit = indefinit) <input type="date" id="b-data-fi" /></label>
        <label>% Bonificació <input type="number" id="b-pct" step="0.01" style="width:80px;" /></label>
        <button type="button" id="btn-afegir-bonificacio">Afegir tram</button>
      </div>
      ${
        prestec.tipus_interes_modalitat === 'variable'
          ? `<div class="modal-section">
              <p class="modal-section-title">Revisions de tipus d'interès (variable) — tipus base: ${prestec.tipus_interes}%</p>
              <div id="llista-revisions">${(revisions ?? []).map((r) => htmlRevisio(r)).join('') || '<p>Cap revisió encara — s\'aplica el tipus base tot el préstec.</p>'}</div>
              <label>Data de la revisió <input type="date" id="r-data" /></label>
              <label>Nou tipus (%) <input type="number" id="r-tipus" step="0.01" style="width:80px;" /></label>
              <button type="button" id="btn-afegir-revisio">Afegir revisió</button>
            </div>`
          : ''
      }
      <div class="modal-section">
        <p class="modal-section-title">Generar / recalcular quadre de quotes</p>
        <p style="font-size:13px; color: var(--gaco-text-secondary);">
          Esborra i torna a calcular només les quotes encara NO pagades, a partir del capital pendent
          actual (${formatImport(prestec.capital_pendent)}). Torneu a prémer-ho sempre que canvieu la
          bonificació, el tipus d'interès o després d'una amortització extraordinària.
        </p>
        <label>Data de la primera quota a generar <input type="date" id="g-data-des" value="${desDeDefecte}" /></label>
        <label>Número d'aquesta quota <input type="number" id="g-num-inicial" value="${numInicialDefecte}" style="width:80px;" /></label>
        <label><input type="checkbox" id="g-marcar-pagades" /> Marcar com a pagades les quotes anteriors a
          <input type="date" id="g-data-tall" value="${avui()}" /></label>
        <p style="font-size:12px; color: var(--gaco-text-secondary);">
          Per a un préstec que ja porta anys: poseu la data de la primera quota real (p. ex. 03/10/2023), número 1,
          marqueu la casella i deixeu la data d'avui (o la de la primera quota que voleu conciliar amb el banc).
          Les dates de cada quota són aproximades (el banc les mou per dies festius); no afecta els imports.
        </p>
        <button type="button" id="btn-generar-quadre">Generar / recalcular</button>
      </div>
      <div id="llista-quotes">${quotes.map(htmlQuota).join('') || '<p>Cap quota generada encara.</p>'}</div>
      <div class="modal-section">
        <p class="modal-section-title">Afegir quota manual (només per a periodicitat "altres")</p>
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

      bodyEl.querySelectorAll('[data-esborrar-bonificacio]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Esborrar aquest tram de bonificació?')) return;
          await supabase.from('gaco_prestecs_bonificacions_interes').delete().eq('id', btn.dataset.esborrarBonificacio);
          closeModal();
          obrirModalQuotes(prestecId, nomPrestec);
        });
      });

      const btnAfegirRevisio = bodyEl.querySelector('#btn-afegir-revisio');
      if (btnAfegirRevisio) {
        btnAfegirRevisio.addEventListener('click', async () => {
          const dataRevisio = bodyEl.querySelector('#r-data').value;
          const tipusNou = bodyEl.querySelector('#r-tipus').value;
          if (!dataRevisio || tipusNou === '') {
            alert('Cal indicar la data i el nou tipus d\'interès.');
            return;
          }
          const { error: errR } = await supabase.from('gaco_prestecs_revisions_interes').insert({
            prestec_id: prestecId,
            data_revisio: dataRevisio,
            tipus_interes_nou: parseFloat(tipusNou),
          });
          if (errR) {
            alert('Error afegint la revisió: ' + errR.message);
            return;
          }
          closeModal();
          obrirModalQuotes(prestecId, nomPrestec);
        });
      }
      bodyEl.querySelectorAll('[data-esborrar-revisio]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Esborrar aquesta revisió de tipus?')) return;
          await supabase.from('gaco_prestecs_revisions_interes').delete().eq('id', btn.dataset.esborrarRevisio);
          closeModal();
          obrirModalQuotes(prestecId, nomPrestec);
        });
      });

      bodyEl.querySelector('#btn-generar-quadre').addEventListener('click', async () => {
        const dataDes = bodyEl.querySelector('#g-data-des').value;
        const numInicial = parseInt(bodyEl.querySelector('#g-num-inicial').value, 10) || 1;
        const marcar = bodyEl.querySelector('#g-marcar-pagades').checked;
        const dataTall = marcar ? bodyEl.querySelector('#g-data-tall').value : null;
        if (!dataDes) {
          alert('Cal indicar la data de la primera quota a generar.');
          return;
        }
        if (marcar && !dataTall) {
          alert('Cal indicar la data de tall per marcar quotes com a pagades.');
          return;
        }
        const ok = await generarORecalcularQuadre(prestecId, prestec, bonificacions ?? [], revisions ?? [], dataDes, numInicial, dataTall);
        if (ok) {
          closeModal();
          obrirModalQuotes(prestecId, nomPrestec);
        }
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
        btn.addEventListener('click', () =>
          toggleEditorQuota(bodyEl, btn.dataset.editarQuota, prestecId, nomPrestec, bonificacions ?? [])
        );
      });
    },
  });
}

function htmlBonificacio(b) {
  return `<p>${formatData(b.data_inici)} — ${b.data_fi ? formatData(b.data_fi) : 'indefinit'}: <strong>${b.pct_bonificacio}%</strong>
    <button type="button" data-esborrar-bonificacio="${b.id}" style="font-size:11px;">Esborrar</button></p>`;
}

function htmlRevisio(r) {
  return `<p>Des del ${formatData(r.data_revisio)}: <strong>${r.tipus_interes_nou}%</strong>
    <button type="button" data-esborrar-revisio="${r.id}" style="font-size:11px;">Esborrar</button></p>`;
}

function htmlQuota(q) {
  return `
    <div class="card" id="quota-${q.id}">
      <p>#${q.num_quota} — ${formatData(q.data_prevista)} · <strong>${formatImport(q.import_quota)}</strong> · ${q.estat === 'pagada' ? '✅ Pagada' : 'Pendent'}</p>
      ${
        q.import_capital !== null
          ? `<p style="color: var(--gaco-text-secondary);">Capital: ${formatImport(q.import_capital)} · Interessos pagats: ${formatImport(q.import_interessos)}${q.import_interessos_bonificats ? ` · Bonificats: ${formatImport(q.import_interessos_bonificats)}` : ''} · Capital pendent després: ${formatImport(q.capital_pendent_despres)}</p>`
          : ''
      }
      ${q.data_pagament ? `<p style="color: var(--gaco-text-secondary); font-size: 13px;">Pagada el ${formatData(q.data_pagament)}</p>` : ''}
      <button type="button" data-editar-quota="${q.id}">Ajustar detall (si el rebut real difereix en cèntims)</button>
      <div id="editor-quota-${q.id}"></div>
    </div>
  `;
}

async function toggleEditorQuota(bodyEl, quotaId, prestecId, nomPrestec, bonificacions) {
  const contenidor = bodyEl.querySelector(`#editor-quota-${quotaId}`);
  if (contenidor.innerHTML) {
    contenidor.innerHTML = '';
    return;
  }

  const { data: quota } = await supabase
    .from('gaco_quotes_prestec')
    .select('data_prevista, data_pagament, import_capital, import_interessos_teorics')
    .eq('id', quotaId)
    .single();
  const pctVigent = pctVigentLocal(bonificacions, quota.data_pagament || quota.data_prevista);

  contenidor.innerHTML = `
    <div class="modal-section">
      <p style="font-size:13px; color: var(--gaco-text-secondary);">Bonificació vigent en aquesta data: ${pctVigent}%. Valors precalculats — només cal tocar-los si el rebut real difereix.</p>
      <label>AMORT (capital, €) <input type="number" id="e-amort-${quotaId}" step="0.01" value="${quota.import_capital ?? ''}" /></label>
      <label>INTS (interès teòric del rebut, €) <input type="number" id="e-ints-${quotaId}" step="0.01" value="${quota.import_interessos_teorics ?? ''}" /></label>
      <p id="e-resultat-${quotaId}"></p>
      <button type="button" id="e-calcular-${quotaId}">Recalcular</button>
      <button type="button" id="e-desar-${quotaId}">Desar</button>
    </div>
  `;

  const calcular = () => {
    const amort = parseFloat(contenidor.querySelector(`#e-amort-${quotaId}`).value) || 0;
    const ints = parseFloat(contenidor.querySelector(`#e-ints-${quotaId}`).value) || 0;
    const bonificats = +((ints * pctVigent) / 100).toFixed(2);
    const pagats = +(ints - bonificats).toFixed(2);
    const total = +(amort + pagats).toFixed(2);
    contenidor.querySelector(`#e-resultat-${quotaId}`).innerHTML =
      `Interessos pagats: ${formatImport(pagats)} · Bonificats: ${formatImport(bonificats)} · <strong>Total quota: ${formatImport(total)}</strong>`;
    return { import_capital: amort, import_interessos_teorics: ints, import_interessos_bonificats: bonificats, import_interessos: pagats, import_quota: total };
  };
  calcular();
  contenidor.querySelector(`#e-calcular-${quotaId}`).addEventListener('click', calcular);

  contenidor.querySelector(`#e-desar-${quotaId}`).addEventListener('click', async () => {
    const valors = calcular();
    const { error } = await supabase.from('gaco_quotes_prestec').update(valors).eq('id', quotaId);
    if (error) {
      alert('Error desant el detall: ' + error.message);
      return;
    }
    closeModal();
    obrirModalQuotes(prestecId, nomPrestec);
  });
}

export { calcularQuadreAmortitzacio, pctVigentLocal };
