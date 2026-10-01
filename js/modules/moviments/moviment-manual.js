import { supabase } from '../../lib/supabaseClient.js';

function formatImport(n) {
  return n.toLocaleString('ca-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function formatData(dataStr) {
  if (!dataStr) return '?';
  const [y, m, d] = dataStr.split('-');
  return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
}

function afegirDies(dataStr, dies) {
  const d = new Date(dataStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dies);
  return d.toISOString().slice(0, 10);
}

/**
 * Mateix criteri de hash que n43-parser.js (compte+data_operacio+data_valor+
 * import+concepte) — així un moviment manual que després arribi de veritat
 * per N43 amb exactament el mateix concepte es deduplica sol.
 */
async function hashDeduplicacio(compteId, dataOperacio, dataValor, import_, concepte) {
  const base = [compteId, dataOperacio, dataValor, import_, concepte ?? ''].join('|');
  const bytes = new TextEncoder().encode(base);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant...</p>';

  const [{ data: comptes }, { data: conceptes }] = await Promise.all([
    supabase
      .from('gaco_comptes')
      .select('id, num_compte, descripcio, gaco_entitats_bancaries ( nom )')
      .order('num_compte'),
    supabase.from('gaco_conceptes_comptables').select('id, grup, nom').eq('actiu', true).order('grup').order('nom'),
  ]);

  contenidor.innerHTML = `
    <div class="card">
      <p class="modal-section-title">Afegir moviment manual</p>
      <p style="font-size:13px; color: var(--gaco-text-secondary);">
        Per a moviments que no us arriben (o no us arribaran) per N43: correccions, devolucions per un altre
        canal, etc. Si el moviment real acaba arribant per N43 més endavant, es comprovarà que no quedi duplicat.
      </p>
      <label>Compte
        <select id="m-compte">
          ${(comptes ?? []).map((c) => `<option value="${c.id}">${c.gaco_entitats_bancaries?.nom ?? '?'} · ${c.num_compte}${c.descripcio ? ' — ' + c.descripcio : ''}</option>`).join('')}
        </select>
      </label>
      <label>Data operació <input type="date" id="m-data-operacio" /></label>
      <label>Data valor <input type="date" id="m-data-valor" /></label>
      <label>Tipus
        <select id="m-signe">
          <option value="carrec">Càrrec (surten diners)</option>
          <option value="abonament">Abonament (entren diners)</option>
        </select>
      </label>
      <label>Import (€) <input type="number" id="m-import" step="0.01" min="0" /></label>
      <label>Concepte <input type="text" id="m-concepte" style="width:100%;" /></label>
      <label>Referència (opcional) <input type="text" id="m-referencia" style="width:100%;" /></label>
      <label>Concepte comptable (opcional)
        <select id="m-categoria">
          <option value="">Sense classificar</option>
          ${(conceptes ?? []).map((c) => `<option value="${c.id}">${c.grup} — ${c.nom}</option>`).join('')}
        </select>
      </label>
      <button type="button" id="btn-desar-moviment">Desar moviment</button>
      <div id="m-resultat"></div>
    </div>
  `;

  document.getElementById('btn-desar-moviment').addEventListener('click', () => desarMoviment(comptes ?? []));
}

async function cercarPossiblesDuplicats(compteId, dataValor, importSignat) {
  const { data } = await supabase
    .from('gaco_moviments_n43')
    .select('id, data_valor, import, concepte, origen')
    .eq('compte_id', compteId)
    .gte('data_valor', afegirDies(dataValor, -2))
    .lte('data_valor', afegirDies(dataValor, 2))
    .eq('import', importSignat);
  return data ?? [];
}

async function desarMoviment(comptes) {
  const resultatEl = document.getElementById('m-resultat');
  const compteId = document.getElementById('m-compte').value;
  const dataOperacio = document.getElementById('m-data-operacio').value;
  const dataValor = document.getElementById('m-data-valor').value;
  const signe = document.getElementById('m-signe').value;
  const importAbs = parseFloat(document.getElementById('m-import').value);
  const concepte = document.getElementById('m-concepte').value.trim();
  const referencia = document.getElementById('m-referencia').value.trim() || null;
  const categoriaId = document.getElementById('m-categoria').value || null;

  if (!compteId || !dataValor || !importAbs) {
    resultatEl.innerHTML = '<p class="error">Cal indicar compte, data valor i import.</p>';
    return;
  }

  const importSignat = signe === 'carrec' ? -Math.abs(importAbs) : Math.abs(importAbs);
  const dataOp = dataOperacio || dataValor;

  const duplicats = await cercarPossiblesDuplicats(compteId, dataValor, importSignat);
  if (duplicats.length && !document.getElementById('m-confirmar-igualment')) {
    const compte = comptes.find((c) => c.id === compteId);
    resultatEl.innerHTML = `
      <p class="error">⚠️ Ja hi ha ${duplicats.length} moviment(s) del mateix compte, import exacte i a ±2 dies — podria ser un duplicat:</p>
      ${duplicats
        .map(
          (d) =>
            `<p>${formatData(d.data_valor)} · ${formatImport(d.import)} · ${d.concepte ?? '(sense concepte)'} (${d.origen === 'manual' ? 'introduït a mà' : 'N43'})</p>`
        )
        .join('')}
      <button type="button" id="m-confirmar-igualment">És un moviment diferent, desar igualment</button>
    `;
    document.getElementById('m-confirmar-igualment').addEventListener('click', () => desarMovimentDefinitiu());
    return;
  }

  await desarMovimentDefinitiu();

  async function desarMovimentDefinitiu() {
    const hash = await hashDeduplicacio(compteId, dataOp, dataValor, importSignat, concepte);
    const { error } = await supabase.from('gaco_moviments_n43').insert({
      compte_id: compteId,
      data_operacio: dataOp,
      data_valor: dataValor,
      import: importSignat,
      concepte: concepte || null,
      referencia,
      categoria_id: categoriaId,
      origen: 'manual',
      estat: 'pendent',
      hash_deduplicacio: hash,
    });
    if (error) {
      resultatEl.innerHTML = `<p class="error">Error desant el moviment: ${error.message}</p>`;
      return;
    }
    resultatEl.innerHTML = '<p>✅ Moviment desat. Ja apareixerà a Conciliació.</p>';
    ['m-data-operacio', 'm-data-valor', 'm-import', 'm-concepte', 'm-referencia'].forEach((id) => {
      document.getElementById(id).value = '';
    });
  }
}
