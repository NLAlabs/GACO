import { supabase } from '../../lib/supabaseClient.js';
import { openModal, closeModal } from '../../lib/modal.js';
import { calcularLiquidacio, tipusVigent, diesEntre as diesPeriode } from '../financament/polisses.js';

/**
 * Conciliació bancària.
 *  1. Llista gaco_moviments_n43 amb estat='pendent', amb etiqueta de banc/compte.
 *  2. Detecció automàtica de traspàs pòlissa↔compte corrent (validada al document
 *     conceptual amb dades reals: mateixa data_valor, import exacte de signe
 *     oposat, entre un compte i el seu compte_polissa_vinculat_id — el text del
 *     concepte NO és fiable com a criteri, no s'utilitza).
 *  3. Vincular a factura real → crea fila a gaco_pagaments_factures_rebudes o
 *     gaco_cobraments_factures_emeses amb moviment_n43_id, i marca el moviment
 *     com a 'conciliat'. PENDENT: cerca de factura candidata (falta confirmar
 *     l'esquema exacte de gaco_factures_rebudes/gaco_factures_emeses).
 */

function formatImport(n) {
  return n.toLocaleString('ca-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function formatData(dataStr) {
  if (!dataStr) return '';
  const [y, m, d] = dataStr.split('-');
  return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
}

function etiquetaCompte(compte) {
  if (!compte) return '(compte desconegut)';
  const banc = compte.gaco_entitats_bancaries?.nom ?? '?';
  const detall = compte.descripcio || compte.tipus;
  return `${banc} · ${detall}`;
}

const ETIQUETES_TIPUS = {
  fra_rebuda: 'Factura rebuda',
  fra_emesa: 'Factura emesa',
  traspas: 'Traspàs',
  rebut: 'Rebut',
  reintegrament_soci: 'Reintegrament soci',
  altres: 'Altres',
};

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant moviments pendents...</p>';

  const { data: moviments, error } = await supabase
    .from('gaco_moviments_n43')
    .select(`
      id, data_valor, import, concepte, referencia, tipus_moviment, estat, compte_id,
      gaco_comptes ( descripcio, tipus, compte_polissa_vinculat_id,
        gaco_entitats_bancaries ( nom ) )
    `)
    .eq('estat', 'pendent')
    .order('data_valor', { ascending: false });

  if (error) {
    contenidor.innerHTML = `<p class="error">Error carregant moviments: ${error.message}</p>`;
    return;
  }

  if (!moviments.length) {
    contenidor.innerHTML = '<div class="card"><p>No hi ha moviments pendents de conciliar.</p></div>';
    return;
  }

  // --- Detecció de traspassos pòlissa↔compte ---
  const usats = new Set();
  const parells = [];
  for (const m of moviments) {
    if (usats.has(m.id)) continue;
    const vinculatId = m.gaco_comptes?.compte_polissa_vinculat_id;
    if (!vinculatId) continue;
    const candidat = moviments.find(
      (x) =>
        !usats.has(x.id) &&
        x.id !== m.id &&
        x.compte_id === vinculatId &&
        x.data_valor === m.data_valor &&
        Math.abs(x.import + m.import) < 0.005 // import exacte, signe oposat
    );
    if (candidat) {
      usats.add(m.id);
      usats.add(candidat.id);
      parells.push([m, candidat]);
    }
  }

  const solts = moviments.filter((m) => !usats.has(m.id));

  // --- Possibles traspassos entre comptes propis (bancs diferents) ---
  // Import exacte i signe oposat, comptes diferents, data de valor a ≤3 dies.
  // Menys fiable que el vincle explícit de pòlissa: es mostren a part i només
  // si la parella és única (si hi ha ambigüitat, es deixa per al botó manual).
  const possibles = [];
  const usatsPossibles = new Set();
  const compatibles = (a, b) =>
    a.compte_id !== b.compte_id && Math.abs(a.import + b.import) < 0.005 && diesEntre(a.data_valor, b.data_valor) <= 3;
  for (const m of solts) {
    if (m.import >= 0 || usatsPossibles.has(m.id)) continue; // es parteix del càrrec
    const opcions = solts.filter((x) => x.import > 0 && !usatsPossibles.has(x.id) && compatibles(m, x));
    if (opcions.length !== 1) continue;
    const rival = solts.filter((x) => x.import < 0 && !usatsPossibles.has(x.id) && compatibles(x, opcions[0]));
    if (rival.length !== 1) continue;
    usatsPossibles.add(m.id);
    usatsPossibles.add(opcions[0].id);
    possibles.push([m, opcions[0]]);
  }
  const soltsFinals = solts.filter((m) => !usatsPossibles.has(m.id));

  contenidor.innerHTML = `
    ${parells.length ? '<h3>Traspassos detectats (comptes vinculats)</h3>' : ''}
    ${parells.map((p) => htmlParellTraspas(p)).join('')}
    ${
      possibles.length
        ? `<h3>Possibles traspassos entre comptes propis</h3>
           <p style="font-size:13px; color: var(--gaco-text-secondary);">Coincideixen import i data (±3 dies), però els comptes no estan vinculats: reviseu-ho abans de confirmar.</p>`
        : ''
    }
    ${possibles.map((p) => htmlParellTraspas(p, true)).join('')}
    <h3>Moviments pendents</h3>
    <div id="llista-solts">${soltsFinals.map((m) => htmlMoviment(m)).join('')}</div>
  `;

  contenidor.querySelectorAll('[data-confirmar-traspas]').forEach((btn) => {
    btn.addEventListener('click', () => confirmarTraspas(btn.dataset.confirmarTraspas.split(',')));
  });
  contenidor.querySelectorAll('[data-ignorar]').forEach((btn) => {
    btn.addEventListener('click', () => ignorarMoviment(btn.dataset.ignorar));
  });
  contenidor.querySelectorAll('[data-quees]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const m = moviments.find((x) => x.id === btn.dataset.quees);
      obrirModalQueEs(m);
    });
  });
}

function htmlParellTraspas([a, b], dubtos = false) {
  return `
    <div class="card">
      <p><strong>${dubtos ? 'Possible traspàs' : 'Traspàs intern'}</strong>${dubtos ? '' : ' — ' + formatData(a.data_valor)}</p>
      <p>${etiquetaCompte(a.gaco_comptes)}: ${formatImport(a.import)}${dubtos ? ' · ' + formatData(a.data_valor) : ''}</p>
      <p>${etiquetaCompte(b.gaco_comptes)}: ${formatImport(b.import)}${dubtos ? ' · ' + formatData(b.data_valor) : ''}</p>
      <button type="button" data-confirmar-traspas="${a.id},${b.id}">Confirmar traspàs</button>
    </div>
  `;
}

function htmlMoviment(m) {
  return `
    <div class="card">
      <p class="modal-section-title">${etiquetaCompte(m.gaco_comptes)} · ${ETIQUETES_TIPUS[m.tipus_moviment] ?? 'Sense classificar'}</p>
      <p>${m.concepte ?? '(sense concepte)'}</p>
      ${m.referencia ? `<p style="color: var(--gaco-text-secondary); font-size: 13px;">${m.referencia}</p>` : ''}
      <p>${formatData(m.data_valor)} · <strong>${formatImport(m.import)}</strong></p>
      <button type="button" data-quees="${m.id}">Què és?</button>
      <button type="button" data-ignorar="${m.id}">Ignorar</button>
    </div>
  `;
}

async function confirmarTraspas([id1, id2]) {
  const { error } = await supabase
    .from('gaco_moviments_n43')
    .update({ estat: 'traspas_intern', tipus_moviment: 'traspas' })
    .in('id', [id1, id2]);
  if (error) {
    alert('Error confirmant el traspàs: ' + error.message);
    return;
  }
  render();
}

async function ignorarMoviment(id) {
  const { error } = await supabase.from('gaco_moviments_n43').update({ estat: 'ignorat' }).eq('id', id);
  if (error) {
    alert('Error ignorant el moviment: ' + error.message);
    return;
  }
  render();
}

const ESTATS_OBERTS_REBUDES = ['pendent', 'pagada_parcial', 'pendent_liquidar_soci'];
const ESTATS_OBERTS_EMESES = ['emesa', 'cobrada_parcial', 'impagada'];

async function cercarFacturesCandidates(moviment) {
  const esRebuda = moviment.import < 0;
  if (esRebuda) {
    const { data, error } = await supabase
      .from('gaco_factures_rebudes')
      .select('id, num_factura, data_factura, total, import_pendent, estat, contrapart_nom, gaco_proveidors ( nom )')
      .in('estat', ESTATS_OBERTS_REBUDES)
      .order('data_factura', { ascending: false })
      .limit(200);
    if (error) throw error;
    return data.map((f) => ({
      id: f.id,
      nom: f.gaco_proveidors?.nom || f.contrapart_nom || '(sense nom)',
      num: f.num_factura,
      data: f.data_factura,
      pendent: f.import_pendent,
      estat: f.estat,
    }));
  }
  const { data, error } = await supabase
    .from('gaco_factures_emeses')
    .select('id, num_document, data_document, total, import_pendent, estat, contrapart_nom, gaco_clients ( nom )')
    .in('estat', ESTATS_OBERTS_EMESES)
    .order('data_document', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data.map((f) => ({
    id: f.id,
    nom: f.gaco_clients?.nom || f.contrapart_nom || '(sense nom)',
    num: f.num_document,
    data: f.data_document,
    pendent: f.import_pendent,
    estat: f.estat,
  }));
}

function htmlCandidata(c, importObjectiu) {
  const coincideix = Math.abs((c.pendent ?? 0) - importObjectiu) < 0.005;
  return `
    <label class="modal-section" style="display:block; cursor:pointer;">
      <input type="radio" name="factura-candidata" value="${c.id}" />
      <strong>${c.nom}</strong>${c.num ? ' · ' + c.num : ''} — ${formatData(c.data)}
      · Pendent: ${formatImport(c.pendent ?? 0)} ${coincideix ? ' ✅ import exacte' : ''}
    </label>
  `;
}

async function obrirModalVincular(moviment) {
  let candidates;
  try {
    candidates = await cercarFacturesCandidates(moviment);
  } catch (err) {
    alert('Error cercant factures: ' + err.message);
    return;
  }

  const importObjectiu = Math.abs(moviment.import);
  candidates.sort((a, b) => Math.abs((a.pendent ?? 0) - importObjectiu) - Math.abs((b.pendent ?? 0) - importObjectiu));

  openModal({
    title: `Vincular moviment de ${formatImport(moviment.import)}`,
    wide: true,
    bodyHtml: `
      <p>${formatData(moviment.data_valor)} · ${etiquetaCompte(moviment.gaco_comptes)}</p>
      <p>${moviment.concepte ?? ''}</p>
      <div class="modal-section">
        <input type="text" id="cerca-factura" placeholder="Filtrar per nom o número..." style="width:100%; padding:8px;" />
      </div>
      <div id="llista-candidates">
        ${candidates.length ? candidates.map((c) => htmlCandidata(c, importObjectiu)).join('') : '<p>No hi ha factures obertes d\'aquest tipus.</p>'}
      </div>
      <button type="button" id="btn-confirmar-vincle" disabled>Vincular</button>
    `,
    onMount: (bodyEl) => {
      const inputCerca = bodyEl.querySelector('#cerca-factura');
      const llista = bodyEl.querySelector('#llista-candidates');
      const btnConfirmar = bodyEl.querySelector('#btn-confirmar-vincle');

      inputCerca.addEventListener('input', () => {
        const text = inputCerca.value.trim().toLowerCase();
        const filtrades = candidates.filter(
          (c) => c.nom.toLowerCase().includes(text) || (c.num ?? '').toLowerCase().includes(text)
        );
        llista.innerHTML = filtrades.length
          ? filtrades.map((c) => htmlCandidata(c, importObjectiu)).join('')
          : '<p>Cap resultat.</p>';
      });

      bodyEl.addEventListener('change', (e) => {
        if (e.target.name === 'factura-candidata') btnConfirmar.disabled = false;
      });

      btnConfirmar.addEventListener('click', async () => {
        const seleccionada = bodyEl.querySelector('input[name="factura-candidata"]:checked');
        if (!seleccionada) return;
        const factura = candidates.find((c) => c.id === seleccionada.value);
        btnConfirmar.disabled = true;
        btnConfirmar.textContent = 'Vinculant...';
        await vincular(moviment, factura.id);
      });
    },
  });
}

async function vincular(moviment, facturaId) {
  const esRebuda = moviment.import < 0;
  const taula = esRebuda ? 'gaco_pagaments_factures_rebudes' : 'gaco_cobraments_factures_emeses';
  const campData = esRebuda ? 'data_pagament' : 'data_cobrament';

  const { error: errInsert } = await supabase.from(taula).insert({
    factura_id: facturaId,
    [campData]: moviment.data_valor,
    import: Math.abs(moviment.import),
    compte_bancari_id: moviment.compte_id,
    moviment_n43_id: moviment.id,
  });
  if (errInsert) {
    alert('Error vinculant: ' + errInsert.message);
    return;
  }

  if (esRebuda) await recalcularFacturaRebuda(facturaId);
  else await recalcularFacturaEmesa(facturaId);

  const { error: errMoviment } = await supabase
    .from('gaco_moviments_n43')
    .update({ estat: 'conciliat', tipus_moviment: esRebuda ? 'fra_rebuda' : 'fra_emesa' })
    .eq('id', moviment.id);
  if (errMoviment) {
    alert('Vinculat, però hi ha hagut un error marcant el moviment com a conciliat: ' + errMoviment.message);
  }

  closeModal();
  render();
}

// --- Vincle a quota de préstec (rebuts d'ICF i similars) ---

async function obrirModalVincularPrestec(moviment) {
  const { data: quotes, error } = await supabase
    .from('gaco_quotes_prestec')
    .select('id, num_quota, data_prevista, import_quota, prestec_id, estat, gaco_prestecs ( descripcio, gaco_entitats_bancaries ( nom ) )')
    .is('moviment_n43_id', null)
    .in('estat', ['pendent', 'pagada'])
    .order('data_prevista', { ascending: true })
    .limit(200);

  if (error) {
    alert('Error cercant quotes: ' + error.message);
    return;
  }

  const importObjectiu = Math.abs(moviment.import);
  quotes.sort((a, b) => Math.abs((a.import_quota ?? 0) - importObjectiu) - Math.abs((b.import_quota ?? 0) - importObjectiu));

  openModal({
    title: `Vincular moviment de ${formatImport(moviment.import)} a una quota`,
    wide: true,
    bodyHtml: `
      <p>${formatData(moviment.data_valor)} · ${etiquetaCompte(moviment.gaco_comptes)}</p>
      <p>${moviment.concepte ?? ''}</p>
      <div id="llista-quotes-candidates">
        ${quotes.length ? quotes.map((q) => htmlQuotaCandidata(q, importObjectiu)).join('') : '<p>No hi ha cap quota disponible.</p>'}
      </div>
      <button type="button" id="btn-confirmar-vincle-prestec" disabled>Vincular</button>
    `,
    onMount: (bodyEl) => {
      const btnConfirmar = bodyEl.querySelector('#btn-confirmar-vincle-prestec');
      bodyEl.addEventListener('change', (e) => {
        if (e.target.name === 'quota-candidata') btnConfirmar.disabled = false;
      });
      btnConfirmar.addEventListener('click', async () => {
        const seleccionada = bodyEl.querySelector('input[name="quota-candidata"]:checked');
        if (!seleccionada) return;
        btnConfirmar.disabled = true;
        btnConfirmar.textContent = 'Vinculant...';
        await vincularPrestec(moviment, seleccionada.value);
      });
    },
  });
}

function htmlQuotaCandidata(q, importObjectiu) {
  const coincideix = Math.abs((q.import_quota ?? 0) - importObjectiu) < 0.005;
  return `
    <label class="modal-section" style="display:block; cursor:pointer;">
      <input type="radio" name="quota-candidata" value="${q.id}" />
      <strong>${q.gaco_prestecs?.gaco_entitats_bancaries?.nom ?? '?'} · ${q.gaco_prestecs?.descripcio ?? ''}</strong>
      — Quota #${q.num_quota} · ${formatData(q.data_prevista)} · ${formatImport(q.import_quota)} ${coincideix ? ' ✅ import exacte' : ''}
      ${q.estat === 'pagada' ? ' · <em>ja marcada com a pagada — vincle retroactiu</em>' : ''}
    </label>
  `;
}

async function vincularPrestec(moviment, quotaId) {
  const { data: quotaAbans, error: errLectura } = await supabase
    .from('gaco_quotes_prestec')
    .select('estat')
    .eq('id', quotaId)
    .single();
  if (errLectura) {
    alert('Error llegint la quota: ' + errLectura.message);
    return;
  }
  const jaEstavaPagada = quotaAbans.estat === 'pagada';

  const { data: quota, error: errQuota } = await supabase
    .from('gaco_quotes_prestec')
    .update({
      data_pagament: moviment.data_valor,
      moviment_n43_id: moviment.id,
      estat: 'pagada',
    })
    .eq('id', quotaId)
    .select('prestec_id, import_capital, import_quota')
    .single();

  if (errQuota) {
    alert('Error vinculant la quota: ' + errQuota.message);
    return;
  }

  // Descompta capital de la quota del capital pendent del préstec, si es
  // coneix el desglossament — però NOMÉS si la quota passa ara de pendent a
  // pagada per primera vegada. Si ja era 'pagada' (vincle retroactiu d'una
  // quota marcada com a históric), el capital ja es va descomptar en el seu
  // moment i tornar-ho a fer el duplicaria.
  if (!jaEstavaPagada && quota.import_capital !== null) {
    const { data: prestec } = await supabase
      .from('gaco_prestecs')
      .select('capital_pendent')
      .eq('id', quota.prestec_id)
      .single();
    if (prestec) {
      await supabase
        .from('gaco_prestecs')
        .update({ capital_pendent: +(prestec.capital_pendent - quota.import_capital).toFixed(2) })
        .eq('id', quota.prestec_id);
    }
  }

  const { error: errMoviment } = await supabase
    .from('gaco_moviments_n43')
    .update({ estat: 'conciliat', tipus_moviment: 'rebut' })
    .eq('id', moviment.id);
  if (errMoviment) {
    alert('Vinculat, però hi ha hagut un error marcant el moviment com a conciliat: ' + errMoviment.message);
  }

  // Quadre: l'import del moviment hauria de coincidir amb el teòric de la
  // quota. Si no coincideix, avisem — no bloquegem, ja està vinculat.
  if (quota.import_quota !== null && Math.abs(Math.abs(moviment.import) - quota.import_quota) > 0.01) {
    alert(
      `Vinculat, però l'import no quadra exactament: moviment ${formatImport(moviment.import)}, ` +
        `quota teòrica ${formatImport(quota.import_quota)}. Reviseu "Ajustar detall" d'aquesta quota a Finançament.`
    );
  }

  closeModal();
  render();
}

// --- Amortització extraordinària (cobrament d'ajuts, Secció de Crèdit) ---

async function obrirModalAmortitzacioExtra(moviment) {
  const { data: prestecs, error } = await supabase
    .from('gaco_prestecs')
    .select('id, descripcio, gaco_entitats_bancaries ( nom )')
    .eq('estat', 'actiu')
    .order('descripcio');

  if (error) {
    alert('Error carregant préstecs: ' + error.message);
    return;
  }

  openModal({
    title: `Amortització extraordinària de ${formatImport(moviment.import)}`,
    bodyHtml: `
      <p>${formatData(moviment.data_valor)} · ${etiquetaCompte(moviment.gaco_comptes)}</p>
      <label>Préstec
        <select id="ax-prestec">
          ${prestecs.map((p) => `<option value="${p.id}">${p.gaco_entitats_bancaries?.nom ?? '?'} · ${p.descripcio ?? ''}</option>`).join('')}
        </select>
      </label>
      <label>Import amortitzat (€) <input type="number" id="ax-import" step="0.01" value="${Math.abs(moviment.import)}" /></label>
      <label>Efecte sobre les quotes futures
        <select id="ax-mode">
          <option value="escurcar">Escurçar el termini (la quota es manté)</option>
          <option value="reduir">Reduir la quota (el termini es manté)</option>
        </select>
      </label>
      <button type="button" id="btn-confirmar-ax">Confirmar</button>
    `,
    onMount: (bodyEl) => {
      bodyEl.querySelector('#btn-confirmar-ax').addEventListener('click', async () => {
        const prestecId = bodyEl.querySelector('#ax-prestec').value;
        const import_ = parseFloat(bodyEl.querySelector('#ax-import').value);
        const mode = bodyEl.querySelector('#ax-mode').value;
        await confirmarAmortitzacioExtra(moviment, prestecId, import_, mode);
      });
    },
  });
}

async function confirmarAmortitzacioExtra(moviment, prestecId, import_, mode) {
  const { error: errIns } = await supabase.from('gaco_amortitzacions_extraordinaries').insert({
    prestec_id: prestecId,
    data: moviment.data_valor,
    import: import_,
    moviment_n43_id: moviment.id,
  });
  if (errIns) {
    alert('Error registrant l\'amortització: ' + errIns.message);
    return;
  }

  const { data: prestec } = await supabase
    .from('gaco_prestecs')
    .select('capital_pendent, tipus_interes, periodicitat, data_fi_prevista')
    .eq('id', prestecId)
    .single();

  let missatgeRecalcul = '';
  if (prestec) {
    const nouCapital = +(prestec.capital_pendent - import_).toFixed(2);
    const canvis = { capital_pendent: nouCapital };

    // "Reduir quota": mateix termini, nova quota fixa (fórmula d'anualitat).
    if (mode === 'reduir' && prestec.tipus_interes && prestec.data_fi_prevista && prestec.periodicitat !== 'altres') {
      const pasMesos = prestec.periodicitat === 'trimestral' ? 3 : 1;
      const periodesAny = prestec.periodicitat === 'trimestral' ? 4 : 12;
      const i = prestec.tipus_interes / 100 / periodesAny;

      let n = 0;
      const d = new Date(moviment.data_valor); // UTC mitjanit
      const dataFi = new Date(prestec.data_fi_prevista);
      d.setUTCMonth(d.getUTCMonth() + pasMesos);
      while (d <= dataFi) {
        n++;
        d.setUTCMonth(d.getUTCMonth() + pasMesos);
      }

      if (n > 0) {
        const novaQuota = i === 0 ? nouCapital / n : (nouCapital * i) / (1 - Math.pow(1 + i, -n));
        canvis.quota_periodica = +novaQuota.toFixed(2);
        missatgeRecalcul = `Nova quota calculada: ${formatImport(canvis.quota_periodica)} (${n} quotes restants).`;
      }
    }

    await supabase.from('gaco_prestecs').update(canvis).eq('id', prestecId);
  }

  const { error: errMoviment } = await supabase
    .from('gaco_moviments_n43')
    .update({ estat: 'conciliat', tipus_moviment: 'rebut' })
    .eq('id', moviment.id);
  if (errMoviment) {
    alert('Registrat, però hi ha hagut un error marcant el moviment com a conciliat: ' + errMoviment.message);
  }

  alert(
    `Amortització registrada. ${missatgeRecalcul}\n\n` +
      `Ara aneu a Finançament → Préstecs → Veure quotes i premeu "Generar / recalcular" perquè el quadre de quotes pendents reflecteixi el nou capital.`
  );

  closeModal();
  render();
}

// No es toca l'estat si ja és 'pendent_liquidar_soci'/'liquidada_soci' — flux propi de socis.
// --- Retrocessió d'una despesa ja pagada (opció A: resta de la despesa, no ingrés a part) ---

async function obrirModalRetrocessio(m) {
  const { data: candidates, error } = await supabase
    .from('gaco_factures_rebudes')
    .select('id, num_factura, data_factura, total, contrapart_nom, gaco_proveidors ( nom )')
    .in('estat', ['pagada', 'pagada_parcial'])
    .order('data_factura', { ascending: false })
    .limit(200);
  if (error) {
    alert('Error cercant despeses: ' + error.message);
    return;
  }

  const importObjectiu = Math.abs(m.import);
  const candidatesAmbNom = candidates.map((f) => ({
    ...f,
    nom: f.gaco_proveidors?.nom || f.contrapart_nom || '?',
  }));
  candidatesAmbNom.sort((a, b) => Math.abs(a.total - importObjectiu) - Math.abs(b.total - importObjectiu));

  openModal({
    title: `Retrocessió de ${formatImport(m.import)}`,
    wide: true,
    bodyHtml: `
      <p>${formatData(m.data_valor)} · ${etiquetaCompte(m.gaco_comptes)}</p>
      <p>${m.concepte ?? ''}</p>
      <div class="modal-section">
        <input type="text" id="rc-cerca" placeholder="Filtrar per proveïdor o número..." style="width:100%; padding:8px;" />
      </div>
      <div id="rc-llista">${candidatesAmbNom.map((f) => htmlCandidataRetrocessio(f)).join('') || '<p>No hi ha cap despesa pagada.</p>'}</div>
      <button type="button" id="btn-confirmar-retrocessio" disabled>Vincular com a devolució</button>
    `,
    onMount: (body) => {
      const inputCerca = body.querySelector('#rc-cerca');
      const llista = body.querySelector('#rc-llista');
      const btn = body.querySelector('#btn-confirmar-retrocessio');

      inputCerca.addEventListener('input', () => {
        const text = inputCerca.value.trim().toLowerCase();
        const filtrades = candidatesAmbNom.filter(
          (f) => f.nom.toLowerCase().includes(text) || (f.num_factura ?? '').toLowerCase().includes(text)
        );
        llista.innerHTML = filtrades.map((f) => htmlCandidataRetrocessio(f)).join('') || '<p>Cap resultat.</p>';
      });

      body.addEventListener('change', (e) => {
        if (e.target.name === 'despesa-candidata') btn.disabled = false;
      });

      btn.addEventListener('click', async () => {
        const triada = body.querySelector('input[name="despesa-candidata"]:checked');
        if (!triada) return;
        btn.disabled = true;
        btn.textContent = 'Vinculant...';
        await vincularRetrocessio(m, triada.value);
      });
    },
  });
}

function htmlCandidataRetrocessio(f) {
  return `
    <label class="modal-section" style="display:block; cursor:pointer;">
      <input type="radio" name="despesa-candidata" value="${f.id}" />
      <strong>${f.nom}</strong>${f.num_factura ? ' · ' + f.num_factura : ''} — ${formatData(f.data_factura)} · Total: ${formatImport(f.total)}
    </label>
  `;
}

async function vincularRetrocessio(m, facturaId) {
  const { error: errIns } = await supabase.from('gaco_pagaments_factures_rebudes').insert({
    factura_id: facturaId,
    tipus_moviment: 'devolucio',
    data_pagament: m.data_valor,
    import: Math.abs(m.import),
    compte_bancari_id: m.compte_id,
    moviment_n43_id: m.id,
  });
  if (errIns) {
    alert('Error vinculant la retrocessió: ' + errIns.message);
    return;
  }

  await recalcularFacturaRebuda(facturaId);

  const { error: errMoviment } = await supabase
    .from('gaco_moviments_n43')
    .update({ estat: 'conciliat', tipus_moviment: 'fra_rebuda' })
    .eq('id', m.id);
  if (errMoviment) {
    alert('Vinculat, però hi ha hagut un error marcant el moviment com a conciliat: ' + errMoviment.message);
  }

  closeModal();
  render();
}

async function recalcularFacturaRebuda(facturaId) {
  const { data: factura } = await supabase
    .from('gaco_factures_rebudes')
    .select('total, estat, tipus_factura')
    .eq('id', facturaId)
    .single();
  if (!factura || ['pendent_liquidar_soci', 'liquidada_soci'].includes(factura.estat)) return;

  const { data: pagaments } = await supabase
    .from('gaco_pagaments_factures_rebudes')
    .select('import, tipus_moviment')
    .eq('factura_id', facturaId);

  const pagatBrut = (pagaments ?? [])
    .filter((p) => p.tipus_moviment !== 'devolucio')
    .reduce((s, p) => s + p.import, 0);
  const devolucions = (pagaments ?? [])
    .filter((p) => p.tipus_moviment === 'devolucio')
    .reduce((s, p) => s + Math.abs(p.import), 0);
  const pagatNet = +(pagatBrut - devolucions).toFixed(2);
  const total = factura.total ?? 0;

  // 'despesa' (comissions, nòmines...): una devolució sol ser una retrocessió/
  // bonificació — no reobre el deute, es basa en el pagat brut (import_pagat
  // mostra el net perquè es vegi la retrocessió).
  // 'factura' (proveïdor amb número real): una devolució sol ser un retorn
  // comercial — sí reobre pendent, es basa en el pagat net, com abans.
  const esDespesa = factura.tipus_factura === 'despesa';
  const pagatPerEstat = esDespesa ? pagatBrut : pagatNet;
  const pendent = +(total - pagatPerEstat).toFixed(2);
  const nouEstat = pendent <= 0.005 ? 'pagada' : pagatPerEstat > 0 ? 'pagada_parcial' : 'pendent';

  await supabase
    .from('gaco_factures_rebudes')
    .update({ import_pagat: pagatNet, import_pendent: pendent, estat: nouEstat })
    .eq('id', facturaId);
}

// Només es toca l'estat si ja estava emesa (no en fase d'esborrany/pressupost).
async function recalcularFacturaEmesa(facturaId) {
  const { data: factura } = await supabase
    .from('gaco_factures_emeses')
    .select('total, estat')
    .eq('id', facturaId)
    .single();
  if (!factura || ['esborrany', 'pressupost_enviat', 'pressupost_acceptat'].includes(factura.estat)) return;

  const { data: cobraments } = await supabase
    .from('gaco_cobraments_factures_emeses')
    .select('import, tipus_moviment')
    .eq('factura_id', facturaId);

  const cobrat = (cobraments ?? []).reduce(
    (s, c) => s + (c.tipus_moviment === 'devolucio' ? -Math.abs(c.import) : c.import),
    0
  );
  const total = factura.total ?? 0;
  const pendent = +(total - cobrat).toFixed(2);
  const nouEstat = pendent <= 0.005 ? 'cobrada' : cobrat > 0 ? 'cobrada_parcial' : 'emesa';

  await supabase
    .from('gaco_factures_emeses')
    .update({ import_cobrat: cobrat, import_pendent: pendent, estat: nouEstat })
    .eq('id', facturaId);
}

// ============================================================================
// Menú "Què és?" — les opcions depenen del signe del moviment
// ============================================================================

function diesEntre(dataA, dataB) {
  return Math.abs(Date.parse(dataA + 'T00:00:00Z') - Date.parse(dataB + 'T00:00:00Z')) / 86400000;
}

function obrirModalQueEs(m) {
  const esCarrec = m.import < 0;
  const opcions = esCarrec
    ? [
        ...(m.gaco_comptes?.tipus === 'credit' ? [['liquidacio-polissa', 'Liquidació trimestral de la pòlissa (interessos + comissions)']] : []),
        ['factura', "Pagament d'una factura o despesa ja registrada"],
        ['nova-despesa', 'Nova despesa (comissió bancària, taxa...)'],
        ['prestec', 'Quota de préstec'],
        ['amortitzacio', 'Amortització extraordinària de préstec'],
        ['traspas', 'Traspàs a un altre compte propi'],
        ['sense-factura', 'Sense factura (reintegrament de soci, altres)'],
      ]
    : [
        ['factura', "Cobrament d'una factura emesa"],
        ['retrocessio', "Retrocessió d'una despesa ja pagada (comissió, etc.)"],
        ['traspas', "Traspàs des d'un altre compte propi"],
        ['sense-factura', 'Ingrés sense despesa relacionada (ajut o subvenció, altres)'],
      ];

  openModal({
    title: `Què és aquest moviment de ${formatImport(m.import)}?`,
    bodyHtml: `
      <p>${formatData(m.data_valor)} · ${etiquetaCompte(m.gaco_comptes)}</p>
      <p>${m.concepte ?? ''}</p>
      ${m.referencia ? `<p style="color: var(--gaco-text-secondary); font-size: 13px;">${m.referencia}</p>` : ''}
      <div>
        ${opcions
          .map(
            ([clau, text]) =>
              `<button type="button" data-opcio="${clau}" style="display:block; width:100%; text-align:left; margin-bottom:6px; padding:10px;">${text}</button>`
          )
          .join('')}
      </div>
    `,
    onMount: (body) => {
      body.querySelectorAll('[data-opcio]').forEach((btn) => {
        btn.addEventListener('click', () => {
          switch (btn.dataset.opcio) {
            case 'factura':
              return obrirModalVincular(m);
            case 'retrocessio':
              return obrirModalRetrocessio(m);
            case 'nova-despesa':
              return obrirModalNovaDespesa(m);
            case 'prestec':
              return obrirModalVincularPrestec(m);
            case 'amortitzacio':
              return obrirModalAmortitzacioExtra(m);
            case 'traspas':
              return obrirModalTraspasManual(m);
            case 'sense-factura':
              return obrirModalClassificar(m);
            case 'liquidacio-polissa':
              return obrirModalLiquidacioPolissa(m);
          }
        });
      });
    },
  });
}

// --- Nova despesa creada des del propi moviment (comissions, taxes...) ---

async function obrirModalNovaDespesa(m) {
  const [{ data: proveidors }, { data: conceptes }] = await Promise.all([
    supabase.from('gaco_proveidors').select('id, nom').eq('actiu', true).order('nom'),
    supabase.from('gaco_conceptes_comptables').select('id, grup, nom').eq('actiu', true).eq('tipus', 'despesa').order('grup').order('nom'),
  ]);

  openModal({
    title: `Nova despesa de ${formatImport(Math.abs(m.import))}`,
    wide: true,
    bodyHtml: `
      <p>${formatData(m.data_valor)} · ${etiquetaCompte(m.gaco_comptes)}</p>
      <p>${m.concepte ?? ''}</p>
      <div class="modal-section">
        <label>Proveïdor (o nom lliure)
          <input type="text" id="nd-proveidor" list="dl-nd-proveidors" placeholder="p. ex. IBERCAJA" />
          <datalist id="dl-nd-proveidors">${(proveidors ?? []).map((p) => `<option value="${p.nom}"></option>`).join('')}</datalist>
        </label>
        <label>Concepte
          <select id="nd-concepte">
            <option value="">Selecciona...</option>
            ${(conceptes ?? []).map((c) => `<option value="${c.id}">${c.grup} — ${c.nom}</option>`).join('')}
          </select>
        </label>
        <label>Descripció <input type="text" id="nd-descripcio" value="${(m.concepte ?? '').replace(/"/g, '&quot;')}" /></label>
        <label>IVA (%) — les comissions bancàries solen ser exemptes
          <input type="number" id="nd-iva" value="0" step="0.01" style="width:80px;" /></label>
        <label>Activitat
          <select id="nd-activitat">
            <option value="comuna">Comuna</option>
            <option value="fruita_cereal">Fruita/cereal</option>
            <option value="serveis">Serveis</option>
          </select>
        </label>
        <label>Núm. factura (opcional) <input type="text" id="nd-num" /></label>
      </div>
      <p style="font-size:13px; color: var(--gaco-text-secondary);">
        Es crea la despesa a Documents → Factures rebudes com a "Despesa", ja pagada amb aquest moviment.
      </p>
      <button type="button" id="btn-crear-despesa">Crear i conciliar</button>
    `,
    onMount: (body) => {
      body.querySelector('#btn-crear-despesa').addEventListener('click', async () => {
        const nom = body.querySelector('#nd-proveidor').value.trim();
        const concepteId = body.querySelector('#nd-concepte').value;
        if (!nom) return alert('Cal indicar un proveïdor o un nom.');
        if (!concepteId) return alert('Cal triar un concepte.');
        const prov = (proveidors ?? []).find((p) => p.nom.toLowerCase() === nom.toLowerCase());
        body.querySelector('#btn-crear-despesa').disabled = true;
        await crearDespesaDesDeMoviment(m, {
          proveidorId: prov?.id ?? null,
          proveidorNom: nom,
          concepteId,
          descripcio: body.querySelector('#nd-descripcio').value.trim() || null,
          ivaPct: Number(body.querySelector('#nd-iva').value) || 0,
          activitat: body.querySelector('#nd-activitat').value,
          numFactura: body.querySelector('#nd-num').value.trim() || null,
        });
      });
    },
  });
}

async function crearDespesaDesDeMoviment(m, d) {
  const total = Math.abs(m.import);
  const base = Math.round((total / (1 + d.ivaPct / 100)) * 100) / 100;
  const iva = Math.round((total - base) * 100) / 100;

  const { data: factura, error } = await supabase
    .from('gaco_factures_rebudes')
    .insert({
      tipus_factura: 'despesa',
      proveidor_id: d.proveidorId,
      contrapart_nom: d.proveidorId ? null : d.proveidorNom,
      num_factura: d.numFactura,
      data_factura: m.data_valor,
      data_recepcio: m.data_valor,
      activitat: d.activitat,
      exercici: Number(m.data_valor.slice(0, 4)),
      imprevist: false,
      confirming_id: null,
      base_imposable: base,
      iva,
      suplits: 0,
      total,
      import_pagat: 0,
      import_pendent: total,
      estat: 'pendent',
      forma_pagament: 'compte_bancari',
      compte_bancari_id: m.compte_id,
    })
    .select('id')
    .single();
  if (error) {
    alert('Error creant la despesa: ' + error.message);
    return;
  }

  const { error: errLinia } = await supabase.from('gaco_detall_factures_rebudes').insert({
    factura_id: factura.id,
    categoria_id: d.concepteId,
    descripcio: d.descripcio,
    quantitat: 1,
    preu_unitari: base,
    descompte_pct: null,
    import_base: base,
    import_descompte: null,
    total_linia: base,
    iva_pct: d.ivaPct,
    iva,
    proveidor_suplit_id: null,
    immobilitzat_id: null,
  });
  if (errLinia) {
    await supabase.from('gaco_factures_rebudes').delete().eq('id', factura.id); // no deixar una despesa sense línia
    alert('Error creant la línia de la despesa: ' + errLinia.message);
    return;
  }

  // Reaprofita el flux normal: pagament amb moviment_n43_id, recàlcul d'estat i moviment conciliat.
  await vincular(m, factura.id);
}

// --- Liquidació trimestral d'una pòlissa de crèdit ---
// Crea gaco_liquidacions_polissa (amb el detall del càlcul) + una despesa a
// gaco_factures_rebudes (proveïdor = banc, IVA 0, una línia per concepte) i
// concilia el moviment. Si ja hi havia la liquidació del mateix final de
// període registrada a mà (sense moviment), la completa en lloc de duplicar-la.

function dataMesDies(dataStr, dies) {
  const d = new Date(dataStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dies);
  return d.toISOString().slice(0, 10);
}

async function obrirModalLiquidacioPolissa(m) {
  const [{ data: condData }, { data: revisions }, { data: ultimes }, { data: proveidors }, { data: conceptes }] = await Promise.all([
    supabase.from('gaco_polisses_condicions').select('*').eq('compte_id', m.compte_id).order('data_formalitzacio', { ascending: false }).limit(1),
    supabase.from('gaco_polisses_revisions_interes').select('*').eq('compte_id', m.compte_id),
    supabase.from('gaco_liquidacions_polissa').select('periode_fi').eq('compte_polissa_id', m.compte_id).not('periode_fi', 'is', null).lt('periode_fi', dataMesDies(m.data_valor, -1)).order('periode_fi', { ascending: false }).limit(1),
    supabase.from('gaco_proveidors').select('id, nom').eq('actiu', true).order('nom'),
    supabase.from('gaco_conceptes_comptables').select('id, grup, nom').eq('actiu', true).eq('tipus', 'despesa').order('grup').order('nom'),
  ]);
  const cond = condData?.[0];
  if (!cond) {
    alert('Aquesta pòlissa no té condicions registrades. Afegeix-les a Finançament → Pòlisses → Condicions.');
    return;
  }

  const totalMov = Math.abs(m.import);
  const fiDef = dataMesDies(m.data_valor, -1);
  const iniciDef = ultimes?.[0]?.periode_fi ? dataMesDies(ultimes[0].periode_fi, 1) : '';
  const nomBanc = m.gaco_comptes?.gaco_entitats_bancaries?.nom ?? '';
  const opcionsConcepte = (conceptes ?? []).map((c) => `<option value="${c.id}">${c.grup} — ${c.nom}</option>`).join('');

  openModal({
    title: `Liquidació de pòlissa de ${formatImport(totalMov)}`,
    wide: true,
    bodyHtml: `
      <p>${formatData(m.data_valor)} · ${etiquetaCompte(m.gaco_comptes)}</p>
      <div class="modal-section">
        <label>Inici del període <input type="date" id="lp-inici" value="${iniciDef}" /></label>
        <label>Fi del període <input type="date" id="lp-fi" value="${fiDef}" /></label>
        <label>Números deure (de l'extracte) <input type="number" step="0.01" id="lp-numeros" /></label>
        <label>Tipus nominal (%) <input type="number" step="0.001" id="lp-tipus" /></label>
        <label>TAE (informatiu) <input type="number" step="0.001" id="lp-tae" /></label>
        <button type="button" id="btn-lp-precalcular">Precalcular imports</button>
      </div>
      <div class="modal-section">
        <label>Interessos <input type="number" step="0.01" id="lp-interessos" /></label>
        <label>Excedits <input type="number" step="0.01" id="lp-excedits" value="0" /></label>
        <label>Comissió de no disposat <input type="number" step="0.01" id="lp-comissio" /></label>
        <p id="lp-quadre" style="font-size:13px;"></p>
      </div>
      <div class="modal-section">
        <label>Proveïdor (o nom lliure)
          <input type="text" id="lp-proveidor" list="dl-lp-proveidors" value="${nomBanc.replace(/"/g, '&quot;')}" />
          <datalist id="dl-lp-proveidors">${(proveidors ?? []).map((p) => `<option value="${p.nom}"></option>`).join('')}</datalist>
        </label>
        <label>Concepte dels interessos (i excedits)
          <select id="lp-concepte-int"><option value="">Selecciona...</option>${opcionsConcepte}</select></label>
        <label>Concepte de les comissions
          <select id="lp-concepte-com"><option value="">Selecciona...</option>${opcionsConcepte}</select></label>
        <label>Activitat
          <select id="lp-activitat">
            <option value="comuna">Comuna</option>
            <option value="fruita_cereal">Fruita/cereal</option>
            <option value="serveis">Serveis</option>
          </select></label>
      </div>
      <p style="font-size:13px; color: var(--gaco-text-secondary);">
        Es crea la liquidació, una despesa a Factures rebudes amb una línia per concepte (IVA 0%) i es concilia aquest moviment.
      </p>
      <button type="button" id="btn-lp-crear">Crear i conciliar</button>
    `,
    onMount: (body) => {
      const g = (id) => body.querySelector(id).value;
      const num = (id) => (g(id) === '' ? null : parseFloat(g(id)));

      const pintar = () => {
        const suma = Math.round(((num('#lp-interessos') ?? 0) + (num('#lp-excedits') ?? 0) + (num('#lp-comissio') ?? 0)) * 100) / 100;
        const ok = Math.abs(suma - totalMov) < 0.005;
        body.querySelector('#lp-quadre').innerHTML = `Suma de components: ${formatImport(suma)} · Moviment: ${formatImport(totalMov)} ${
          ok ? '✔' : `<strong style="color:#b00020;">⚠ diferència ${formatImport(Math.round((suma - totalMov) * 100) / 100)}</strong>`
        }`;
      };
      ['#lp-interessos', '#lp-excedits', '#lp-comissio'].forEach((id) => body.querySelector(id).addEventListener('input', pintar));

      body.querySelector('#btn-lp-precalcular').addEventListener('click', () => {
        const inici = g('#lp-inici');
        const fi = g('#lp-fi');
        const numeros = num('#lp-numeros');
        if (!inici || !fi || numeros === null) return alert('Cal indicar inici, fi i números deure.');
        if (g('#lp-tipus') === '') {
          const tv = tipusVigent(revisions ?? [], inici);
          if (tv !== null) body.querySelector('#lp-tipus').value = tv;
        }
        const tipus = num('#lp-tipus');
        if (tipus === null) return alert('No hi ha tipus vigent: indica el tipus nominal.');
        const t = calcularLiquidacio({
          numeros,
          dies: diesPeriode(inici, fi),
          tipusPct: tipus,
          limit: Number(cond.limit_import),
          comissioPct: Number(cond.comissio_disponibilitat_pct),
        });
        body.querySelector('#lp-interessos').value = t.interessos;
        body.querySelector('#lp-comissio').value = t.comissio;
        pintar();
      });
      pintar();

      body.querySelector('#btn-lp-crear').addEventListener('click', async () => {
        const inici = g('#lp-inici');
        const fi = g('#lp-fi');
        const interessos = num('#lp-interessos') ?? 0;
        const excedits = num('#lp-excedits') ?? 0;
        const comissio = num('#lp-comissio') ?? 0;
        const nom = g('#lp-proveidor').trim();
        const concepteInt = g('#lp-concepte-int');
        const concepteCom = g('#lp-concepte-com');
        if (!inici || !fi || fi < inici) return alert('Cal indicar un període vàlid.');
        if (Math.abs(interessos + excedits + comissio - totalMov) >= 0.005) return alert('La suma de components ha de coincidir amb el moviment.');
        if (!nom) return alert('Cal indicar un proveïdor o un nom.');
        if ((interessos + excedits > 0 && !concepteInt) || (comissio > 0 && !concepteCom)) return alert('Cal triar el concepte de cada import.');
        const prov = (proveidors ?? []).find((p) => p.nom.toLowerCase() === nom.toLowerCase());
        body.querySelector('#btn-lp-crear').disabled = true;
        const numeros = num('#lp-numeros');
        const dies = diesPeriode(inici, fi);
        await confirmarLiquidacioPolissa(m, {
          inici, fi, dies, numeros,
          saldoMitja: numeros !== null ? Math.round(((numeros * 100) / dies) * 100) / 100 : null,
          tipus: num('#lp-tipus'), tae: num('#lp-tae'),
          interessos, excedits, comissio,
          proveidorId: prov?.id ?? null, proveidorNom: nom,
          concepteInt, concepteCom, activitat: g('#lp-activitat'),
        });
      });
    },
  });
}

async function confirmarLiquidacioPolissa(m, d) {
  const total = Math.abs(m.import);

  // Liquidació ja registrada a mà amb el mateix final de període?
  const { data: existents } = await supabase
    .from('gaco_liquidacions_polissa')
    .select('id, moviment_n43_id')
    .eq('compte_polissa_id', m.compte_id)
    .eq('periode_fi', d.fi);
  const existent = existents?.[0] ?? null;
  if (existent?.moviment_n43_id) {
    alert('Aquesta liquidació (mateix final de període) ja està conciliada amb un altre moviment.');
    closeModal();
    return;
  }

  const descripcioPeriode = `${formatData(d.inici)} - ${formatData(d.fi)}`;
  const { data: factura, error } = await supabase
    .from('gaco_factures_rebudes')
    .insert({
      tipus_factura: 'despesa',
      proveidor_id: d.proveidorId,
      contrapart_nom: d.proveidorId ? null : d.proveidorNom,
      num_factura: null,
      data_factura: m.data_valor,
      data_recepcio: m.data_valor,
      activitat: d.activitat,
      exercici: Number(m.data_valor.slice(0, 4)),
      imprevist: false,
      confirming_id: null,
      base_imposable: total,
      iva: 0,
      suplits: 0,
      total,
      import_pagat: 0,
      import_pendent: total,
      estat: 'pendent',
      forma_pagament: 'compte_bancari',
      compte_bancari_id: m.compte_id,
    })
    .select('id')
    .single();
  if (error) {
    alert('Error creant la despesa: ' + error.message);
    return;
  }

  const linia = (concepteId, descripcio, import_) => ({
    factura_id: factura.id,
    categoria_id: concepteId,
    descripcio,
    quantitat: 1,
    preu_unitari: import_,
    descompte_pct: null,
    import_base: import_,
    import_descompte: null,
    total_linia: import_,
    iva_pct: 0,
    iva: 0,
    proveidor_suplit_id: null,
    immobilitzat_id: null,
  });
  const linies = [];
  if (d.interessos > 0) linies.push(linia(d.concepteInt, `Interessos pòlissa ${descripcioPeriode}`, d.interessos));
  if (d.excedits > 0) linies.push(linia(d.concepteInt, `Interessos d'excedits pòlissa ${descripcioPeriode}`, d.excedits));
  if (d.comissio > 0) linies.push(linia(d.concepteCom, `Comissió de no disponibilitat ${descripcioPeriode}`, d.comissio));

  const desfer = async () => {
    await supabase.from('gaco_detall_factures_rebudes').delete().eq('factura_id', factura.id);
    await supabase.from('gaco_factures_rebudes').delete().eq('id', factura.id);
  };

  const { error: errLinies } = await supabase.from('gaco_detall_factures_rebudes').insert(linies);
  if (errLinies) {
    await desfer();
    alert('Error creant les línies de la despesa: ' + errLinies.message);
    return;
  }

  const registre = {
    compte_polissa_id: m.compte_id,
    moviment_n43_id: m.id,
    factura_rebuda_id: factura.id,
    data: m.data_valor,
    periode_inici: d.inici,
    periode_fi: d.fi,
    dies: d.dies,
    numeros_deure: d.numeros,
    saldo_mitja: d.saldoMitja,
    tipus_nominal_pct: d.tipus,
    tae_pct: d.tae,
    import_interessos: d.interessos,
    import_excedits: d.excedits,
    import_comissio_no_disposat: d.comissio,
    import_total: total,
  };
  const { error: errLiq } = existent
    ? await supabase.from('gaco_liquidacions_polissa').update(registre).eq('id', existent.id)
    : await supabase.from('gaco_liquidacions_polissa').insert(registre);
  if (errLiq) {
    await desfer();
    alert('Error desant la liquidació: ' + errLiq.message);
    return;
  }

  // Flux normal: pagament amb moviment_n43_id, recàlcul d'estat i moviment conciliat.
  await vincular(m, factura.id);
}

// --- Classificar sense factura (reintegrament de soci, retrocessió, ajut...) ---

async function obrirModalClassificar(m) {
  const { data: conceptes } = await supabase
    .from('gaco_conceptes_comptables')
    .select('id, grup, nom, tipus')
    .eq('actiu', true)
    .order('grup')
    .order('nom');

  openModal({
    title: `Classificar ${formatImport(m.import)} sense factura`,
    wide: true,
    bodyHtml: `
      <p>${formatData(m.data_valor)} · ${etiquetaCompte(m.gaco_comptes)}</p>
      <p>${m.concepte ?? ''}</p>
      <label>Tipus
        <select id="cl-tipus">
          <option value="altres">Altres (retrocessió, ajut o subvenció...)</option>
          <option value="reintegrament_soci">Reintegrament de soci</option>
        </select>
      </label>
      <label>Concepte
        <select id="cl-concepte">
          <option value="">Selecciona...</option>
          ${(conceptes ?? []).map((c) => `<option value="${c.id}">${c.grup} — ${c.nom} (${c.tipus})</option>`).join('')}
        </select>
      </label>
      <p style="font-size:13px; color: var(--gaco-text-secondary);">
        Si és la retrocessió d'una comissió, trieu el mateix concepte que la despesa: als informes per concepte
        quedaran compensades.
      </p>
      <button type="button" id="btn-classificar">Confirmar</button>
    `,
    onMount: (body) => {
      body.querySelector('#btn-classificar').addEventListener('click', async () => {
        const tipus = body.querySelector('#cl-tipus').value;
        const concepteId = body.querySelector('#cl-concepte').value || null;
        if (tipus === 'altres' && !concepteId) return alert('Cal triar un concepte.');
        const { error } = await supabase
          .from('gaco_moviments_n43')
          .update({ estat: 'conciliat', tipus_moviment: tipus, categoria_id: concepteId })
          .eq('id', m.id);
        if (error) return alert('Error classificant el moviment: ' + error.message);
        closeModal();
        render();
      });
    },
  });
}

// --- Traspàs manual: triar la parella entre els moviments pendents d'altres comptes ---

async function obrirModalTraspasManual(m) {
  const dia = 86400000;
  const centre = Date.parse(m.data_valor + 'T00:00:00Z');
  const des = new Date(centre - 5 * dia).toISOString().slice(0, 10);
  const fins = new Date(centre + 5 * dia).toISOString().slice(0, 10);

  const { data: candidats, error } = await supabase
    .from('gaco_moviments_n43')
    .select('id, data_valor, import, concepte, gaco_comptes ( descripcio, tipus, gaco_entitats_bancaries ( nom ) )')
    .eq('estat', 'pendent')
    .neq('compte_id', m.compte_id)
    .eq('import', -m.import)
    .gte('data_valor', des)
    .lte('data_valor', fins)
    .order('data_valor');
  if (error) {
    alert('Error cercant la parella del traspàs: ' + error.message);
    return;
  }

  openModal({
    title: `Traspàs de ${formatImport(m.import)}`,
    wide: true,
    bodyHtml: `
      <p>${formatData(m.data_valor)} · ${etiquetaCompte(m.gaco_comptes)}</p>
      <p style="font-size:13px; color: var(--gaco-text-secondary);">
        Moviments pendents d'altres comptes amb l'import exacte contrari, a ±5 dies.
      </p>
      ${(candidats ?? [])
        .map(
          (c) => `
        <label class="modal-section" style="display:block; cursor:pointer;">
          <input type="radio" name="parella" value="${c.id}" />
          <strong>${etiquetaCompte(c.gaco_comptes)}</strong> — ${formatData(c.data_valor)} · ${formatImport(c.import)}
          <span style="color: var(--gaco-text-secondary);"> ${c.concepte ?? ''}</span>
        </label>`
        )
        .join('')}
      <label class="modal-section" style="display:block; cursor:pointer;">
        <input type="radio" name="parella" value="sense" ${(candidats ?? []).length ? '' : 'checked'} />
        L'altre moviment encara no està importat (marcar només aquest com a traspàs)
      </label>
      <button type="button" id="btn-confirmar-traspas-manual">Confirmar traspàs</button>
    `,
    onMount: (body) => {
      body.querySelector('#btn-confirmar-traspas-manual').addEventListener('click', async () => {
        const triat = body.querySelector('input[name="parella"]:checked');
        if (!triat) return alert('Trieu una opció.');
        const ids = triat.value === 'sense' ? [m.id] : [m.id, triat.value];
        const { error: errUpd } = await supabase
          .from('gaco_moviments_n43')
          .update({ estat: 'traspas_intern', tipus_moviment: 'traspas' })
          .in('id', ids);
        if (errUpd) return alert('Error confirmant el traspàs: ' + errUpd.message);
        closeModal();
        render();
      });
    },
  });
}
