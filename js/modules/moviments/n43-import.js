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
async function comprovarContinuitat(compteId, saldoInicialNou, dataInicialNova, excloureId = null) {
  // Només compta la tanda que acaba ABANS d'aquesta: si s'importa un període
  // anterior a les tandes ja gravades, la "darrera per data_final" és una tanda
  // posterior i donaria un fals avís de salt.
  let consultaAnterior = supabase
    .from('gaco_importacions_n43')
    .select('data_final, saldo_final, saldo_calculat')
    .eq('compte_id', compteId)
    .lte('data_final', dataInicialNova);
  if (excloureId) consultaAnterior = consultaAnterior.neq('id', excloureId);
  const { data: anterior } = await consultaAnterior
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

/**
 * Si aquesta tanda s'importa per ompliar un buit o un període anterior, ha
 * d'enllaçar amb la tanda posterior ja gravada: el seu saldo_final ha de
 * coincidir amb el saldo_inicial de la següent. Retorna també l'id de la
 * següent perquè se n'actualitzi continua_anterior un cop gravada aquesta.
 */
async function comprovarContinuitatSeguent(compteId, saldoFinalNou, dataFinalNova, excloureId = null) {
  let consultaSeguent = supabase
    .from('gaco_importacions_n43')
    .select('id, data_inicial, saldo_inicial')
    .eq('compte_id', compteId)
    .gte('data_inicial', dataFinalNova);
  if (excloureId) consultaSeguent = consultaSeguent.neq('id', excloureId);
  const { data: seguent } = await consultaSeguent
    .order('data_inicial', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!seguent || saldoFinalNou === null || saldoFinalNou === undefined) {
    return { seguentId: null, continua: null, avis: null };
  }
  const continua = Math.abs(saldoFinalNou - seguent.saldo_inicial) < 0.005;
  const avis = continua
    ? null
    : `El saldo final d'aquesta importació (${formatImport(saldoFinalNou)}) no coincideix amb el saldo inicial ` +
      `de la importació següent ja gravada (${formatImport(seguent.saldo_inicial)}, des de ${formatData(seguent.data_inicial)}). ` +
      `Probablement falten dies per importar entremig.`;
  return { seguentId: seguent.id, continua, avis };
}

/**
 * Avisa (sense bloquejar) si algun moviment d'aquesta tanda coincideix en
 * compte+import+data (±2 dies) amb un moviment introduït a mà — probablement
 * és el mateix fet, arribat ara "de veritat" per N43.
 */
async function cercarPossiblesDuplicatsManual(compteId, moviments) {
  if (!moviments.length) return [];
  const dataMin = moviments.reduce((min, m) => (m.data_valor < min ? m.data_valor : min), moviments[0].data_valor);
  const dataMax = moviments.reduce((max, m) => (m.data_valor > max ? m.data_valor : max), moviments[0].data_valor);
  const dia = 86400000;
  const des = new Date(Date.parse(dataMin + 'T00:00:00Z') - 2 * dia).toISOString().slice(0, 10);
  const fins = new Date(Date.parse(dataMax + 'T00:00:00Z') + 2 * dia).toISOString().slice(0, 10);

  const { data: manuals } = await supabase
    .from('gaco_moviments_n43')
    .select('id, data_valor, import, concepte, estat')
    .eq('compte_id', compteId)
    .eq('origen', 'manual')
    .gte('data_valor', des)
    .lte('data_valor', fins);

  if (!manuals?.length) return [];
  return manuals.filter((man) => moviments.some((m) => m.import === man.import));
}

/**
 * Si aquest mateix període d'aquest compte ja s'havia importat (mateixes dates
 * inicial i final), es reutilitza la tanda en lloc de crear-ne una de repetida.
 * Es compara per dates i no pel nom del fitxer, que el banc canvia sovint.
 */
async function cercarTandaExistent(compteId, dataInicial, dataFinal) {
  const { data } = await supabase
    .from('gaco_importacions_n43')
    .select('id')
    .eq('compte_id', compteId)
    .eq('data_inicial', dataInicial)
    .eq('data_final', dataFinal)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/**
 * Els moviments d'una importació anterior a l'existència del control de tandes
 * (o gravats amb una tanda que després s'ha esborrat) no tenen importacio_id.
 * En reimportar el fitxer se'ls hi assigna la tanda, perquè Importacions els compti.
 */
async function lligarMovimentsSenseTanda(importacioId, hashes) {
  const mida = 100; // els hashes són llargs: es fan lots perquè la URL no es passi de llargada
  for (let i = 0; i < hashes.length; i += mida) {
    await supabase
      .from('gaco_moviments_n43')
      .update({ importacio_id: importacioId })
      .in('hash_deduplicacio', hashes.slice(i, i + mida))
      .is('importacio_id', null);
  }
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
    const existent = await cercarTandaExistent(resultat.compteId, resultat.dataInicial, resultat.dataFinal);
    const { continuaAnterior, avis: avisAnterior } = await comprovarContinuitat(
      resultat.compteId,
      resultat.saldoInicial,
      resultat.dataInicial,
      existent?.id ?? null
    );
    const seguent = await comprovarContinuitatSeguent(
      resultat.compteId,
      resultat.saldoFinal ?? resultat.saldoCalculat,
      resultat.dataFinal,
      existent?.id ?? null
    );
    const avisContinuitat = [avisAnterior, seguent.avis].filter(Boolean).join(' ') || null;
    const possiblesManuals = await cercarPossiblesDuplicatsManual(resultat.compteId, resultat.moviments);

    const registreTanda = {
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
    };

    // Reimportació del mateix període: s'actualitza la tanda existent (conserva el nom
    // del primer fitxer) en lloc de crear-ne una de repetida.
    const reutilitzada = Boolean(existent);
    const { data: importacio, error: errImportacio } = reutilitzada
      ? await supabase.from('gaco_importacions_n43').update(registreTanda).eq('id', existent.id).select('id').single()
      : await supabase.from('gaco_importacions_n43').insert({ ...registreTanda, nom_fitxer: file.name }).select('id').single();

    if (errImportacio) {
      targetesHtml.push(
        `<div class="card"><p class="error">Compte ${resultat.numCuenta}: error registrant la importació — ${errImportacio.message}</p></div>`
      );
      continue;
    }

    const movimentsAmbTanda = resultat.moviments.map((m) => ({ ...m, importacio_id: importacio.id }));
    // select('id') només retorna les files realment inserides (les duplicades s'ometen).
    const { data: inserits, error: errMoviments } = await supabase
      .from('gaco_moviments_n43')
      .upsert(movimentsAmbTanda, { onConflict: 'hash_deduplicacio', ignoreDuplicates: true })
      .select('id');

    if (errMoviments) {
      targetesHtml.push(
        `<div class="card"><p class="error">Compte ${resultat.numCuenta}: error gravant els moviments — ${errMoviments.message}</p></div>`
      );
      continue;
    }

    // La tanda posterior ja gravada ara té predecessora: refresca el seu indicador.
    if (seguent.seguentId) {
      await supabase.from('gaco_importacions_n43').update({ continua_anterior: seguent.continua }).eq('id', seguent.seguentId);
    }

    if (reutilitzada) await lligarMovimentsSenseTanda(importacio.id, resultat.moviments.map((m) => m.hash_deduplicacio));

    targetesHtml.push(
      htmlResumCompte(resultat, avisContinuitat, possiblesManuals, {
        reutilitzada,
        nous: inserits?.length ?? null,
      })
    );
  }

  resultatEl.innerHTML = targetesHtml.join('');
  if (avisos.length) console.log('Avisos del parseig N43:', avisos);
}

function htmlResumCompte(resultat, avisContinuitat, possiblesManuals = [], info = {}) {
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

  const duplicatsHtml = possiblesManuals.length
    ? `<p class="error">⚠️ ${possiblesManuals.length} moviment(s) d'aquest fitxer coincideixen amb un moviment que vau introduir a mà — reviseu-los a Conciliació per no deixar-los duplicats:</p>
       ${possiblesManuals
         .map(
           (m) =>
             `<p>${formatData(m.data_valor)} · ${formatImport(m.import)} · ${m.concepte ?? ''} — manual <strong>${m.estat}</strong>${
               m.estat === 'conciliat' ? ' (porta vincles: cal passar-los al moviment del banc abans d\'esborrar-lo)' : ''
             }</p>`
         )
         .join('')}`
    : '';

  const nousHtml =
    info.nous === null || info.nous === undefined
      ? `${resultat.moviments.length} moviments processats`
      : `${resultat.moviments.length} moviments al fitxer: <strong>${info.nous} nous</strong>, ${resultat.moviments.length - info.nous} ja existien`;
  const reutilitzadaHtml = info.reutilitzada
    ? '<p>ℹ️ Aquest període ja s\'havia importat: s\'ha reutilitzat la tanda existent (no se n\'ha creat cap de repetida).</p>'
    : '';
  const signeHtml = resultat.signeInicialCorregit
    ? `<p>ℹ️ El fitxer portava el signe del saldo inicial invertit: s'ha corregit a ${formatImport(resultat.saldoInicial)} perquè el quadre sigui exacte.</p>`
    : '';

  return `
    <div class="card">
      <p><strong>${resultat.numCuenta}</strong> — ${formatData(resultat.dataInicial)} a ${formatData(resultat.dataFinal)}</p>
      <p>${nousHtml} (saldo inicial ${formatImport(resultat.saldoInicial)}).</p>
      ${reutilitzadaHtml}
      ${signeHtml}
      ${quadraHtml}
      ${continuitatHtml}
      ${duplicatsHtml}
    </div>
  `;
}
