import { supabase } from '../../lib/supabaseClient.js';
import { openModal, closeModal } from '../../lib/modal.js';

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

  contenidor.innerHTML = `
    ${parells.length ? '<h3>Traspassos detectats automàticament</h3>' : ''}
    ${parells.map((p) => htmlParellTraspas(p)).join('')}
    <h3>Moviments pendents</h3>
    <div id="llista-solts">${solts.map((m) => htmlMoviment(m)).join('')}</div>
  `;

  contenidor.querySelectorAll('[data-confirmar-traspas]').forEach((btn) => {
    btn.addEventListener('click', () => confirmarTraspas(btn.dataset.confirmarTraspas.split(',')));
  });
  contenidor.querySelectorAll('[data-ignorar]').forEach((btn) => {
    btn.addEventListener('click', () => ignorarMoviment(btn.dataset.ignorar));
  });
  contenidor.querySelectorAll('[data-vincular]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const m = moviments.find((x) => x.id === btn.dataset.vincular);
      obrirModalVincular(m);
    });
  });
}

function htmlParellTraspas([a, b]) {
  return `
    <div class="card">
      <p><strong>Traspàs intern</strong> — ${formatData(a.data_valor)}</p>
      <p>${etiquetaCompte(a.gaco_comptes)}: ${formatImport(a.import)}</p>
      <p>${etiquetaCompte(b.gaco_comptes)}: ${formatImport(b.import)}</p>
      <button type="button" data-confirmar-traspas="${a.id},${b.id}">Confirmar traspàs</button>
    </div>
  `;
}

function htmlMoviment(m) {
  const esCarrec = m.import < 0;
  return `
    <div class="card">
      <p class="modal-section-title">${etiquetaCompte(m.gaco_comptes)} · ${ETIQUETES_TIPUS[m.tipus_moviment] ?? 'Sense classificar'}</p>
      <p>${m.concepte ?? '(sense concepte)'}</p>
      ${m.referencia ? `<p style="color: var(--gaco-text-secondary); font-size: 13px;">${m.referencia}</p>` : ''}
      <p>${formatData(m.data_valor)} · <strong>${formatImport(m.import)}</strong></p>
      <button type="button" data-vincular="${m.id}">
        Vincular a ${esCarrec ? 'factura rebuda' : 'factura emesa'}
      </button>
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

// No es toca l'estat si ja és 'pendent_liquidar_soci'/'liquidada_soci' — flux propi de socis.
async function recalcularFacturaRebuda(facturaId) {
  const { data: factura } = await supabase
    .from('gaco_factures_rebudes')
    .select('total, estat')
    .eq('id', facturaId)
    .single();
  if (!factura || ['pendent_liquidar_soci', 'liquidada_soci'].includes(factura.estat)) return;

  const { data: pagaments } = await supabase
    .from('gaco_pagaments_factures_rebudes')
    .select('import, tipus_moviment')
    .eq('factura_id', facturaId);

  const pagat = (pagaments ?? []).reduce(
    (s, p) => s + (p.tipus_moviment === 'devolucio' ? -p.import : p.import),
    0
  );
  const total = factura.total ?? 0;
  const pendent = +(total - pagat).toFixed(2);
  const nouEstat = pendent <= 0.005 ? 'pagada' : pagat > 0 ? 'pagada_parcial' : 'pendent';

  await supabase
    .from('gaco_factures_rebudes')
    .update({ import_pagat: pagat, import_pendent: pendent, estat: nouEstat })
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
    (s, c) => s + (c.tipus_moviment === 'devolucio' ? -c.import : c.import),
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
