import { supabase } from '../../lib/supabaseClient.js';

function formatImport(n) {
  return n.toLocaleString('ca-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function formatData(dataStr) {
  if (!dataStr) return '?';
  const [y, m, d] = dataStr.split('-');
  return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
}

const ETIQUETES_TIPUS = {
  fra_rebuda: 'Factura rebuda',
  fra_emesa: 'Factura emesa',
  traspas: 'Traspàs',
  rebut: 'Rebut',
  reintegrament_soci: 'Reintegrament soci',
  altres: 'Altres',
};

const ETIQUETES_ESTAT = {
  pendent: 'Pendent',
  conciliat: 'Conciliat',
  traspas_intern: 'Traspàs intern',
  ignorat: 'Ignorat',
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

  const entitats = [...new Map(comptes.map((c) => [c.gaco_entitats_bancaries?.id, c.gaco_entitats_bancaries])).values()].filter(
    Boolean
  );

  contenidor.innerHTML = `
    <div class="card">
      <label>Entitat
        <select id="f-entitat">
          <option value="">Totes</option>
          ${entitats.map((e) => `<option value="${e.id}">${e.nom}</option>`).join('')}
        </select>
      </label>
      <label>Compte (obligatori per veure el saldo)
        <select id="f-compte">
          <option value="">Tots els comptes (sense saldo)</option>
          ${comptes.map((c) => `<option value="${c.id}" data-entitat="${c.entitat_id}">${c.num_compte}${c.descripcio ? ' — ' + c.descripcio : ''}</option>`).join('')}
        </select>
      </label>
      <label>Des de <input type="date" id="f-data-des" /></label>
      <label>Fins a <input type="date" id="f-data-fins" /></label>
      <label>Tipus
        <select id="f-signe">
          <option value="">Tots</option>
          <option value="carrec">Només càrrecs</option>
          <option value="abonament">Només abonaments</option>
        </select>
      </label>
      <label>Import des de <input type="number" id="f-import-des" step="0.01" min="0" /></label>
      <label>Import fins a <input type="number" id="f-import-fins" step="0.01" min="0" /></label>
      <button type="button" id="btn-cercar">Cercar</button>
    </div>
    <div id="resultat-historial"><p>Selecciona filtres i prem Cercar.</p></div>
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

  if (!compteId) {
    await cercarSenseSaldo({ dataDes, dataFins, signe, importDes, importFins });
    return;
  }

  // --- Baseline: primer saldo conegut d'aquest compte ---
  const { data: baseline } = await supabase
    .from('gaco_importacions_n43')
    .select('data_inicial, saldo_inicial')
    .eq('compte_id', compteId)
    .order('data_inicial', { ascending: true })
    .limit(1)
    .maybeSingle();

  const dataBase = baseline?.data_inicial ?? null;
  const saldoBase = baseline?.saldo_inicial ?? 0;
  const senseSaldoReal = !baseline;

  // --- Tots els moviments del compte des de la baseline, en ordre cronològic ---
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
    return;
  }

  // --- Saldo acumulat, en ordre cronològic ---
  let acumulat = saldoBase;
  const ambSaldo = moviments.map((m) => {
    acumulat = Math.round((acumulat + m.import) * 100) / 100;
    return { ...m, saldoVirtual: acumulat };
  });

  // --- Filtres de visualització (no afecten el càlcul del saldo, ja fet) ---
  let filtrats = ambSaldo;
  if (dataDes) filtrats = filtrats.filter((m) => m.data_valor >= dataDes);
  if (dataFins) filtrats = filtrats.filter((m) => m.data_valor <= dataFins);
  if (signe === 'carrec') filtrats = filtrats.filter((m) => m.import < 0);
  if (signe === 'abonament') filtrats = filtrats.filter((m) => m.import > 0);
  if (importDes !== null) filtrats = filtrats.filter((m) => Math.abs(m.import) >= importDes);
  if (importFins !== null) filtrats = filtrats.filter((m) => Math.abs(m.import) <= importFins);

  const factures = await buscarFacturesVinculades(filtrats.filter((m) => m.estat === 'conciliat').map((m) => m.id));

  // Es mostra del més recent al més antic, mantenint el saldo ja calculat per fila.
  const ordenatsDescendent = [...filtrats].reverse();

  resultatEl.innerHTML = `
    ${senseSaldoReal ? '<p class="error">⚠️ No hi ha cap importació registrada per a aquest compte des del canvi de disseny — el saldo es mostra relatiu (començant a 0,00 €), no verificat contra el banc.</p>' : ''}
    ${ordenatsDescendent.length ? ordenatsDescendent.map((m) => htmlMoviment(m, factures.get(m.id))).join('') : '<div class="card"><p>Cap moviment amb aquest filtre.</p></div>'}
  `;
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
    return;
  }

  let filtrats = data;
  if (importDes !== null) filtrats = filtrats.filter((m) => Math.abs(m.import) >= importDes);
  if (importFins !== null) filtrats = filtrats.filter((m) => Math.abs(m.import) <= importFins);

  const factures = await buscarFacturesVinculades(filtrats.filter((m) => m.estat === 'conciliat').map((m) => m.id));

  resultatEl.innerHTML = filtrats.length
    ? filtrats.map((m) => htmlMoviment(m, factures.get(m.id), true)).join('')
    : '<div class="card"><p>Cap moviment amb aquest filtre.</p></div>';
}

/**
 * Retorna un Map moviment_n43_id -> text descriptiu de la factura vinculada,
 * consultant en bloc gaco_pagaments_factures_rebudes i
 * gaco_cobraments_factures_emeses (evita N+1 consultes).
 */
async function buscarFacturesVinculades(idsConciliats) {
  const resultat = new Map();
  if (!idsConciliats.length) return resultat;

  const [{ data: pagaments }, { data: cobraments }] = await Promise.all([
    supabase
      .from('gaco_pagaments_factures_rebudes')
      .select('moviment_n43_id, factura_id')
      .in('moviment_n43_id', idsConciliats),
    supabase
      .from('gaco_cobraments_factures_emeses')
      .select('moviment_n43_id, factura_id')
      .in('moviment_n43_id', idsConciliats),
  ]);

  const idsRebudes = (pagaments ?? []).map((p) => p.factura_id);
  const idsEmeses = (cobraments ?? []).map((c) => c.factura_id);

  const [{ data: rebudes }, { data: emeses }] = await Promise.all([
    idsRebudes.length
      ? supabase
          .from('gaco_factures_rebudes')
          .select('id, num_factura, contrapart_nom, gaco_proveidors ( nom )')
          .in('id', idsRebudes)
      : Promise.resolve({ data: [] }),
    idsEmeses.length
      ? supabase
          .from('gaco_factures_emeses')
          .select('id, num_document, contrapart_nom, gaco_clients ( nom )')
          .in('id', idsEmeses)
      : Promise.resolve({ data: [] }),
  ]);

  const rebudesPerId = new Map((rebudes ?? []).map((f) => [f.id, f]));
  const emesesPerId = new Map((emeses ?? []).map((f) => [f.id, f]));

  for (const p of pagaments ?? []) {
    const f = rebudesPerId.get(p.factura_id);
    if (f) resultat.set(p.moviment_n43_id, `Factura rebuda · ${f.gaco_proveidors?.nom || f.contrapart_nom || '?'}${f.num_factura ? ' · ' + f.num_factura : ''}`);
  }
  for (const c of cobraments ?? []) {
    const f = emesesPerId.get(c.factura_id);
    if (f) resultat.set(c.moviment_n43_id, `Factura emesa · ${f.gaco_clients?.nom || f.contrapart_nom || '?'}${f.num_document ? ' · ' + f.num_document : ''}`);
  }
  return resultat;
}

function htmlMoviment(m, facturaVinculada, ambBanc = false) {
  const capcalera = ambBanc
    ? `${m.gaco_comptes?.gaco_entitats_bancaries?.nom ?? '?'} · ${m.gaco_comptes?.num_compte ?? '?'}`
    : ETIQUETES_TIPUS[m.tipus_moviment] ?? 'Sense classificar';

  return `
    <div class="card">
      <p class="modal-section-title">${capcalera} · ${ETIQUETES_ESTAT[m.estat] ?? m.estat}</p>
      <p>${m.concepte ?? '(sense concepte)'}</p>
      ${m.referencia ? `<p style="color: var(--gaco-text-secondary); font-size: 13px;">${m.referencia}</p>` : ''}
      <p>${formatData(m.data_valor)} · <strong>${formatImport(m.import)}</strong>
        ${m.saldoVirtual !== undefined ? ` · Saldo: ${formatImport(m.saldoVirtual)}` : ''}
      </p>
      ${facturaVinculada ? `<p style="color: var(--gaco-text-secondary);">↳ ${facturaVinculada}</p>` : ''}
    </div>
  `;
}
