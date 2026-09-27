import { supabase } from '../../lib/supabaseClient.js';

function formatImport(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('ca-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function formatData(dataStr) {
  if (!dataStr) return '?';
  const [y, m, d] = dataStr.split('-');
  return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
}

function formatDataHora(isoStr) {
  const d = new Date(isoStr);
  return `${formatData(d.toISOString().slice(0, 10))} ${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

function badgeQuadra(quadra) {
  if (quadra === null) return '<span title="Fitxer sense registre de tancament">—</span>';
  return quadra ? '✅' : '⚠️';
}

function badgeContinuitat(continua) {
  if (continua === null) return '<span title="Primera importació d\'aquest compte">— (primera)</span>';
  return continua ? '✅' : '⚠️ salt/solapament';
}

let comptesCache = [];

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
  comptesCache = comptes;

  const entitats = [...new Map(comptes.map((c) => [c.gaco_entitats_bancaries?.id, c.gaco_entitats_bancaries])).values()].filter(
    Boolean
  );

  contenidor.innerHTML = `
    <div class="card">
      <label>Entitat
        <select id="filtre-entitat">
          <option value="">Totes</option>
          ${entitats.map((e) => `<option value="${e.id}">${e.nom}</option>`).join('')}
        </select>
      </label>
      <label>Compte
        <select id="filtre-compte">
          <option value="">Tots</option>
          ${comptes.map((c) => `<option value="${c.id}" data-entitat="${c.entitat_id}">${c.num_compte}${c.descripcio ? ' — ' + c.descripcio : ''}</option>`).join('')}
        </select>
      </label>
    </div>
    <div id="llista-importacions"><p>Carregant importacions...</p></div>
  `;

  document.getElementById('filtre-entitat').addEventListener('change', (e) => {
    const entitatId = e.target.value;
    const selectCompte = document.getElementById('filtre-compte');
    selectCompte.value = '';
    [...selectCompte.options].forEach((opt) => {
      opt.hidden = entitatId && opt.dataset.entitat && opt.dataset.entitat !== entitatId;
    });
    carregarLlista();
  });
  document.getElementById('filtre-compte').addEventListener('change', carregarLlista);

  await carregarLlista();
}

async function carregarLlista() {
  const llistaEl = document.getElementById('llista-importacions');
  llistaEl.innerHTML = '<p>Carregant...</p>';

  const entitatId = document.getElementById('filtre-entitat').value;
  const compteId = document.getElementById('filtre-compte').value;

  let query = supabase
    .from('gaco_importacions_n43')
    .select(`
      id, data_inicial, data_final, saldo_inicial, saldo_final, saldo_calculat,
      quadra, continua_anterior, num_apunts_debe, num_apunts_haber, nom_fitxer, created_at,
      gaco_comptes ( num_compte, descripcio, entitat_id, gaco_entitats_bancaries ( nom ) )
    `)
    .order('data_final', { ascending: false });

  if (compteId) query = query.eq('compte_id', compteId);

  const { data, error } = await query;
  if (error) {
    llistaEl.innerHTML = `<p class="error">Error carregant importacions: ${error.message}</p>`;
    return;
  }

  const filtrades = entitatId ? data.filter((i) => i.gaco_comptes?.entitat_id === entitatId) : data;

  if (!filtrades.length) {
    llistaEl.innerHTML = '<div class="card"><p>Cap importació registrada amb aquest filtre.</p></div>';
    return;
  }

  llistaEl.innerHTML = filtrades.map(htmlImportacio).join('');
}

function htmlImportacio(imp) {
  const compte = imp.gaco_comptes;
  const numMoviments = (imp.num_apunts_debe ?? 0) + (imp.num_apunts_haber ?? 0);
  return `
    <div class="card">
      <p class="modal-section-title">${compte?.gaco_entitats_bancaries?.nom ?? '?'} · ${compte?.num_compte ?? '?'}</p>
      <p><strong>${formatData(imp.data_inicial)} a ${formatData(imp.data_final)}</strong> — ${numMoviments} moviments</p>
      <p>Saldo inicial: ${formatImport(imp.saldo_inicial)} · Saldo final fitxer: ${formatImport(imp.saldo_final)} · Calculat: ${formatImport(imp.saldo_calculat)}</p>
      <p>Quadra: ${badgeQuadra(imp.quadra)} &nbsp;·&nbsp; Continuïtat amb l'anterior: ${badgeContinuitat(imp.continua_anterior)}</p>
      <p style="color: var(--gaco-text-secondary); font-size: 13px;">
        ${imp.nom_fitxer ?? '(sense nom de fitxer)'} · importat ${formatDataHora(imp.created_at)}
      </p>
    </div>
  `;
}
