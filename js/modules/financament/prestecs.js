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
        <label>Tipus d'interès anual (%) <input type="number" id="nf-interes" step="0.01" /></label>
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
            <option value="altres">Altres (sense càlcul automàtic)</option>
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
      <p style="font-size:13px; color: var(--gaco-text-secondary);">
        El quadre de quotes (amb capital/interessos/bonificació calculats) es genera després, des de "Veure quotes".
      </p>
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

  const { error } = await supabase.from('gaco_prestecs').insert(prestec);
  if (error) {
    alert('Error desant el préstec: ' + error.message);
    return;
  }

  closeModal();
  carregarLlista();
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
  quotaPeriodica,
  periodicitat,
  tipusInteres,
  tipusCarencia,
  dataFiCarencia,
  bonificacions,
}) {
  const pasMesos = periodicitat === 'trimestral' ? 3 : 1;
  const periodesAny = periodicitat === 'trimestral' ? 4 : 12;
  const quotes = [];
  let capitalPendent = capitalInicial;
  let num = numQuotaInicial;
  let k = 0;
  let dataStr = dataIniciStr;

  while (dataStr <= dataFiStr && capitalPendent > 0.005) {
    const dinsCarencia = dataFiCarencia && dataStr <= dataFiCarencia;

    let interessosTeorics = Math.round(((capitalPendent * (tipusInteres / 100)) / periodesAny) * 100) / 100;
    let capital;
    if (dinsCarencia && tipusCarencia === 'total') {
      capital = 0;
      interessosTeorics = 0;
    } else if (dinsCarencia && tipusCarencia === 'nomes_interessos') {
      capital = 0;
    } else {
      capital = Math.round((quotaPeriodica - interessosTeorics) * 100) / 100;
      if (capital > capitalPendent) capital = capitalPendent; // darrera quota: payoff exacte
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
async function generarORecalcularQuadre(prestecId, prestec, bonificacions, dataDes, numInicial, marcarPagadesAbans) {
  if (!prestec.data_fi_prevista || !prestec.periodicitat || prestec.periodicitat === 'altres' || !prestec.tipus_interes || !prestec.quota_periodica) {
    alert("Falten dades del préstec (tipus d'interès, quota, periodicitat mensual/trimestral o data fi) per calcular el quadre automàticament.");
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
  const [{ data: prestec, error: errPrestec }, { data: quotes, error }, { data: bonificacions }] = await Promise.all([
    supabase
      .from('gaco_prestecs')
      .select('capital_pendent, data_inici, data_fi_prevista, tipus_interes, periodicitat, quota_periodica, tipus_carencia, data_fi_carencia')
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
  ]);

  if (error || errPrestec) {
    alert('Error carregant les quotes: ' + (error?.message || errPrestec?.message));
    return;
  }

  const pagades = quotes.filter((q) => q.estat === 'pagada');
  const ultimaPagada = pagades[pagades.length - 1];
  const pasMesosDefecte = prestec.periodicitat === 'trimestral' ? 3 : 1;
  const desDeDefecte = ultimaPagada ? afegirMesos(ultimaPagada.data_prevista, pasMesosDefecte) : '';
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
        const ok = await generarORecalcularQuadre(prestecId, prestec, bonificacions ?? [], dataDes, numInicial, dataTall);
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
