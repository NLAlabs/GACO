import { supabase } from '../../lib/supabaseClient.js';
import { importarFitxerN43 } from './n43-parser.js';

function formatImport(n) {
  return n.toLocaleString('ca-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function formatData(dataStr) {
  if (!dataStr) return '?';
  const [y, m, d] = dataStr.split('-');
  return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
}

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = `
    <div class="card">
      <p>Puja un fitxer N43 del banc. Els moviments ja importats no es duplicaran.</p>
      <input type="file" id="n43-input" accept=".n43,.txt" />
      <div id="n43-resultat"></div>
    </div>
  `;

  document.getElementById('n43-input').addEventListener('change', handleFileUpload);
}

async function resoldreCompteId({ claveEntidad, claveOficina, numCuenta }) {
  // Criteri de match a confirmar amb dades reals — veure nota al fitxer n43-parser.js
  const { data } = await supabase
    .from('gaco_comptes')
    .select('id, num_compte')
    .ilike('num_compte', `%${numCuenta}%`)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * Consulta la darrera importació ja gravada d'aquest compte (per data_final)
 * per comprovar continuïtat: el saldo_inicial d'aquesta tanda nova hauria de
 * coincidir amb el saldo_final (o saldo_calculat, si no n'hi havia) de
 * l'anterior. Si no coincideix, hi ha un buit (o un solapament) de dies
 * sense importar entre totes dues — es marca com a avís, no es bloqueja.
 */
async function comprovarContinuitat(compteId, saldoInicialNou) {
  const { data: anterior } = await supabase
    .from('gaco_importacions_n43')
    .select('data_final, saldo_final, saldo_calculat')
    .eq('compte_id', compteId)
    .order('data_final', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!anterior) return { continuaAnterior: null, avis: null }; // primera importació d'aquest compte

  const saldoReferencia = anterior.saldo_final ?? anterior.saldo_calculat;
  const continuaAnterior = Math.abs(saldoReferencia - saldoInicialNou) < 0.005;
  const avis = continuaAnterior
    ? null
    : `El saldo inicial d'aquesta importació (${formatImport(saldoInicialNou)}) no coincideix amb el saldo ` +
      `de tancament de l'anterior importació d'aquest compte (${formatImport(saldoReferencia)}, fins ${formatData(anterior.data_final)}). ` +
      `Probablement falten dies per importar entremig.`;

  return { continuaAnterior, avis };
}

async function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const resultatEl = document.getElementById('n43-resultat');
  resultatEl.textContent = 'Processant...';

  const buffer = await file.arrayBuffer();
  const { resultatsPerCompte, comptesNoResolts, avisos } = await importarFitxerN43(buffer, resoldreCompteId);

  if (comptesNoResolts.length > 0) {
    resultatEl.innerHTML = `<p class="error">Comptes del fitxer no reconeguts a GACO: ${comptesNoResolts
      .map((c) => c.numCuenta)
      .join(', ')}. Dona'ls d'alta a Configuració abans d'importar.</p>`;
    return;
  }

  const targetesHtml = [];

  for (const resultat of resultatsPerCompte) {
    const { continuaAnterior, avis: avisContinuitat } = await comprovarContinuitat(
      resultat.compteId,
      resultat.saldoInicial
    );

    const { data: importacio, error: errImportacio } = await supabase
      .from('gaco_importacions_n43')
      .insert({
        compte_id: resultat.compteId,
        data_inicial: resultat.dataInicial,
        data_final: resultat.dataFinal,
        saldo_inicial: resultat.saldoInicial,
        saldo_final: resultat.saldoFinal,
        saldo_calculat: resultat.saldoCalculat,
        quadra: resultat.quadra,
        continua_anterior: continuaAnterior,
        num_apunts_debe: resultat.numApuntsDebe,
        total_import_debe: resultat.totalImportDebe,
        num_apunts_haber: resultat.numApuntsHaber,
        total_import_haber: resultat.totalImportHaber,
        nom_fitxer: file.name,
      })
      .select('id')
      .single();

    if (errImportacio) {
      targetesHtml.push(
        `<div class="card"><p class="error">Compte ${resultat.numCuenta}: error registrant la importació — ${errImportacio.message}</p></div>`
      );
      continue;
    }

    const movimentsAmbTanda = resultat.moviments.map((m) => ({ ...m, importacio_id: importacio.id }));
    const { error: errMoviments } = await supabase
      .from('gaco_moviments_n43')
      .upsert(movimentsAmbTanda, { onConflict: 'hash_deduplicacio', ignoreDuplicates: true });

    if (errMoviments) {
      targetesHtml.push(
        `<div class="card"><p class="error">Compte ${resultat.numCuenta}: error gravant els moviments — ${errMoviments.message}</p></div>`
      );
      continue;
    }

    targetesHtml.push(htmlResumCompte(resultat, avisContinuitat));
  }

  resultatEl.innerHTML = targetesHtml.join('');
  if (avisos.length) console.log('Avisos del parseig N43:', avisos);
}

function htmlResumCompte(resultat, avisContinuitat) {
  const quadraHtml =
    resultat.quadra === null
      ? '<p>⚠️ Sense registre de tancament al fitxer — no es pot verificar el saldo final.</p>'
      : resultat.quadra
        ? `<p>✅ Saldo quadra: ${formatImport(resultat.saldoCalculat)}</p>`
        : `<p class="error">⚠️ El saldo NO quadra — calculat ${formatImport(resultat.saldoCalculat)}, ` +
          `fitxer diu ${formatImport(resultat.saldoFinal)}.</p>`;

  const continuitatHtml =
    avisContinuitat === null
      ? ''
      : `<p class="error">⚠️ ${avisContinuitat}</p>`;

  return `
    <div class="card">
      <p><strong>${resultat.numCuenta}</strong> — ${formatData(resultat.dataInicial)} a ${formatData(resultat.dataFinal)}</p>
      <p>${resultat.moviments.length} moviments processats (saldo inicial ${formatImport(resultat.saldoInicial)}).</p>
      ${quadraHtml}
      ${continuitatHtml}
    </div>
  `;
}
