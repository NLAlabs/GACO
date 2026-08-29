/**
 * GACO — Importador Norma 43 (AEB / CSB43)
 * ============================================================================
 * Parseig de fitxers d'extracte bancari en format Norma 43 (registres de
 * longitud fixa, 80 caràcters), segons especificació oficial AEB
 * ("Información normalizada de cuenta corriente", Serie 43, juliol 2001).
 *
 * Verificat (05/07/2026) contra fitxers reals de Banc A, Banc B (BBVA) i
 * Banc C (Secció de Crèdit): els 3 emeten N43 estàndard vàlid.
 *
 * Punts de disseny confirmats al document conceptual GACO v0.1:
 *  - Codificació NO uniforme entre entitats: Banc A arriba en UTF-8;
 *    Banc B i Banc C arriben en Latin-1/ISO-8859-1. Cal detectar-la per
 *    fitxer (fallback UTF-8 -> Latin-1), no assumir-ne una de fixa.
 *  - El registre 23 (text ampliat) és de format lliure i s'annexa al
 *    concepte del moviment corresponent (no té el layout fix del 22).
 *  - El camp "Nº de documento" del registre 22 sol arribar buit -> el hash
 *    de deduplicació es basa en compte+data_operacio+data_valor+import+
 *    concepte, MAI en aquest camp.
 *  - Un fitxer pot contenir dos (o més) comptes en blocs 11...33
 *    consecutius (p. ex. CC + pòlissa de Banc A en un sol fitxer) -> cal
 *    gestionar múltiples capçaleres/tancaments dins un mateix fitxer, no
 *    assumir un únic compte per fitxer.
 *  - El codi de divisa de capçalera varia entre entitats (s'han observat
 *    "1" i "2") -> NO es valida estrictament, s'assumeix EUR sempre.
 *
 * Aquest mòdul és pur (no coneix Supabase ni gaco_comptes): parseja el
 * fitxer i retorna estructures de dades. La resolució de compte_id i la
 * inserció a BD es fan a la capa d'importació (vegeu exemple al final).
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// Especificació de camps per tipus de registre (posicions 1-based, inclusives,
// tal com les documenta l'AEB — es converteixen a índexs 0-based en llegir-les)
// ----------------------------------------------------------------------------

const CAMPS = {
  // 1.1 Registre de capçalera de compte
  11: {
    claveEntidad:    [3, 6],
    claveOficina:    [7, 10],
    numCuenta:       [11, 20],
    fechaInicial:    [21, 26],
    fechaFinal:      [27, 32],
    claveDebeHaber:  [33, 33],
    saldoInicial:    [34, 47],
    claveDivisa:     [48, 50],
    modalidad:       [51, 51],
    nombreAbreviado: [52, 77],
  },
  // 1.2 Registre principal de moviments (obligatori)
  22: {
    claveOficinaOrigen: [7, 10],
    fechaOperacion:     [11, 16],
    fechaValor:         [17, 22],
    conceptoComun:      [23, 24],
    conceptoPropio:     [25, 27],
    claveDebeHaber:     [28, 28],
    importe:            [29, 42],
    numDocumento:       [43, 52],
    referencia1:        [53, 64],
    referencia2:        [65, 80],
  },
  // 1.3 Registres complementaris de concepte (fins a 5, opcionals)
  23: {
    codigoDato: [3, 4],
    concepto1:  [5, 42],
    concepto2:  [43, 80],
  },
  // 1.5 Registre final de compte
  33: {
    claveEntidad:      [3, 6],
    claveOficina:      [7, 10],
    numCuenta:         [11, 20],
    numApuntesDebe:    [21, 25],
    totalImportesDebe: [26, 39],
    numApuntesHaber:   [40, 44],
    totalImportesHaber:[45, 58],
    codigoSaldoFinal:  [59, 59],
    saldoFinal:        [60, 73],
    claveDivisa:       [74, 76],
  },
  // 1.6 Registre de fi de fitxer
  88: {
    numRegistros: [21, 26],
  },
};

function camp(linia, [de, a]) {
  // Posicions 1-based inclusives -> slice 0-based
  return linia.slice(de - 1, a).trim();
}

/**
 * AAMMDD -> 'YYYY-MM-DD'. Assumeix segle 20xx (format en ús des dels 2000).
 */
function parseDataN43(aammdd) {
  if (!aammdd || aammdd === '000000' || aammdd.trim() === '') return null;
  const aa = aammdd.slice(0, 2);
  const mm = aammdd.slice(2, 4);
  const dd = aammdd.slice(4, 6);
  return `20${aa}-${mm}-${dd}`;
}

/**
 * Importe de 14 posicions, 2 decimals implícits sense coma, + signe D/H.
 * Debe (1) = càrrec = negatiu. Haber (2) = abonament/ingrés = positiu.
 * (Mateix criteri que gaco_moviments_n43.import: positiu=ingrés, negatiu=càrrec)
 */
function parseImportSignat(digits14, claveDebeHaber) {
  const valorAbsolut = parseInt(digits14, 10) / 100;
  return claveDebeHaber === '1' ? -valorAbsolut : valorAbsolut;
}

// ----------------------------------------------------------------------------
// Detecció de codificació: UTF-8 estricte amb fallback a Latin-1/ISO-8859-1
// ----------------------------------------------------------------------------

/**
 * Prova de decodificar com a UTF-8 estricte (TextDecoder amb fatal:true).
 * Si falla (bytes invàlids en UTF-8, típic de fitxers Latin-1 amb
 * caràcters accentuats), fa fallback a ISO-8859-1 (Latin-1 = windows-1252
 * en la pràctica pel rang que interessa aquí).
 *
 * @param {ArrayBuffer} buffer
 * @returns {{ text: string, encoding: 'utf-8'|'latin1' }}
 */
function decodeN43Buffer(buffer) {
  try {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    const text = utf8Decoder.decode(buffer);
    return { text, encoding: 'utf-8' };
  } catch (e) {
    const latin1Decoder = new TextDecoder('iso-8859-1');
    const text = latin1Decoder.decode(buffer);
    return { text, encoding: 'latin1' };
  }
}

// ----------------------------------------------------------------------------
// Parseig principal
// ----------------------------------------------------------------------------

/**
 * Parseja el contingut textual d'un fitxer N43 (ja decodificat).
 * Suporta múltiples blocs de compte (11...33) dins un mateix fitxer.
 *
 * @param {string} text
 * @returns {{ comptes: Array<ComptePersat>, avisos: string[] }}
 *
 * ComptePersat = {
 *   claveEntidad, claveOficina, numCuenta, fechaInicial, fechaFinal,
 *   saldoInicial, claveDivisa, nombreAbreviado,
 *   moviments: Array<{
 *     dataOperacio, dataValor, conceptePropi, conceptComu, import,
 *     numDocument, referencia1, referencia2, conceptesAmpliats: string[]
 *   }>,
 *   tancament: { numApuntesDebe, totalImportesDebe, numApuntesHaber,
 *                totalImportesHaber, saldoFinal } | null
 * }
 */
function parseN43(text) {
  const linies = text.split(/\r\n|\r|\n/).filter((l) => l.length >= 2);
  const comptes = [];
  const avisos = [];
  let compteActual = null;
  let movimentActual = null;

  for (const linia of linies) {
    const tipus = linia.slice(0, 2);

    switch (tipus) {
      case '11': {
        const c = CAMPS[11];
        compteActual = {
          claveEntidad: camp(linia, c.claveEntidad),
          claveOficina: camp(linia, c.claveOficina),
          numCuenta: camp(linia, c.numCuenta),
          fechaInicial: parseDataN43(camp(linia, c.fechaInicial)),
          fechaFinal: parseDataN43(camp(linia, c.fechaFinal)),
          saldoInicial: parseImportSignat(
            camp(linia, c.saldoInicial),
            camp(linia, c.claveDebeHaber)
          ),
          // Codi de divisa NO es valida (varia entre entitats) — s'assumeix EUR
          claveDivisa: camp(linia, c.claveDivisa),
          nombreAbreviado: camp(linia, c.nombreAbreviado),
          moviments: [],
          tancament: null,
        };
        movimentActual = null;
        break;
      }

      case '22': {
        if (!compteActual) {
          avisos.push(`Registre 22 trobat sense capçalera 11 prèvia: "${linia}"`);
          break;
        }
        const c = CAMPS[22];
        movimentActual = {
          dataOperacio: parseDataN43(camp(linia, c.fechaOperacion)),
          dataValor: parseDataN43(camp(linia, c.fechaValor)),
          conceptComu: camp(linia, c.conceptoComun),
          conceptePropi: camp(linia, c.conceptoPropio),
          import: parseImportSignat(camp(linia, c.importe), camp(linia, c.claveDebeHaber)),
          numDocument: camp(linia, c.numDocumento), // sol arribar buit — no fer-hi confiança
          referencia1: camp(linia, c.referencia1),
          referencia2: camp(linia, c.referencia2),
          conceptesAmpliats: [], // s'omple amb registres 23 si n'hi ha
        };
        compteActual.moviments.push(movimentActual);
        break;
      }

      case '23': {
        if (!movimentActual) {
          avisos.push(`Registre 23 (concepte ampliat) sense moviment 22 previ: "${linia}"`);
          break;
        }
        const c = CAMPS[23];
        const part1 = camp(linia, c.concepto1);
        const part2 = camp(linia, c.concepto2);
        const text23 = `${part1} ${part2}`.trim();
        if (text23) movimentActual.conceptesAmpliats.push(text23);
        break;
      }

      case '33': {
        if (!compteActual) {
          avisos.push(`Registre 33 (tancament) sense capçalera 11 prèvia: "${linia}"`);
          break;
        }
        const c = CAMPS[33];
        compteActual.tancament = {
          numApuntesDebe: parseInt(camp(linia, c.numApuntesDebe), 10),
          totalImportesDebe: parseInt(camp(linia, c.totalImportesDebe), 10) / 100,
          numApuntesHaber: parseInt(camp(linia, c.numApuntesHaber), 10),
          totalImportesHaber: parseInt(camp(linia, c.totalImportesHaber), 10) / 100,
          saldoFinal: parseImportSignat(
            camp(linia, c.saldoFinal),
            camp(linia, c.codigoSaldoFinal)
          ),
        };
        comptes.push(compteActual);
        // Reiniciar per si segueix un altre bloc 11...33 al mateix fitxer
        compteActual = null;
        movimentActual = null;
        break;
      }

      case '88':
        // Registre de fi de fitxer — informatiu, no cal processar-lo per a la importació
        break;

      default:
        avisos.push(`Tipus de registre no reconegut ("${tipus}"): "${linia}"`);
    }
  }

  if (compteActual) {
    avisos.push(
      `Fitxer acaba sense registre 33 de tancament per al compte ${compteActual.numCuenta} — es conserva igualment.`
    );
    comptes.push(compteActual);
  }

  return { comptes, avisos };
}

// ----------------------------------------------------------------------------
// Deduplicació
// ----------------------------------------------------------------------------

/**
 * Concepte final que s'emmagatzema a gaco_moviments_n43.concepte:
 * concepte propi del registre 22 + tots els registres 23 annexats.
 */
function conceptePerMoviment(moviment) {
  const parts = [moviment.conceptePropi, ...moviment.conceptesAmpliats].filter(Boolean);
  return parts.join(' ').trim();
}

/**
 * Hash de deduplicació: compte + data_operacio + data_valor + import + concepte.
 * NOMÉS aquests camps — el nº de document sol arribar buit i no és fiable.
 * SHA-256 en hex via Web Crypto (async, disponible en navegador i Node 19+).
 *
 * @param {string} compteId  uuid de gaco_comptes (ja resolt, no numCuenta cru)
 */
async function hashDeduplicacio(compteId, moviment) {
  const concepte = conceptePerMoviment(moviment);
  const base = [compteId, moviment.dataOperacio, moviment.dataValor, moviment.import, concepte].join('|');
  const bytes = new TextEncoder().encode(base);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ----------------------------------------------------------------------------
// Punt d'entrada d'alt nivell: de fitxer cru a files llestes per a
// gaco_moviments_n43. La resolució compte N43 -> gaco_comptes.id es
// delega en `resoldreCompteId`, perquè el criteri d'aparellament
// (per num_compte complet, per IBAN, o per últims dígits) depèn de com
// s'hagi emplenat gaco_comptes.num_compte i no ve fixat pel document.
// ----------------------------------------------------------------------------

/**
 * @param {ArrayBuffer} buffer  contingut cru del fitxer N43 pujat
 * @param {(compteN43: {claveEntidad, claveOficina, numCuenta}) => Promise<string|null>} resoldreCompteId
 *        Funció que retorna el uuid de gaco_comptes corresponent, o null si no es troba cap match.
 * @returns {Promise<{ filesPerInserir: Array<object>, comptesNoResolts: Array<object>, avisos: string[] }>}
 */
async function importarFitxerN43(buffer, resoldreCompteId) {
  const { text, encoding } = decodeN43Buffer(buffer);
  const { comptes, avisos } = parseN43(text);
  const filesPerInserir = [];
  const comptesNoResolts = [];

  avisos.push(`Codificació detectada: ${encoding}.`);

  for (const compte of comptes) {
    const compteId = await resoldreCompteId({
      claveEntidad: compte.claveEntidad,
      claveOficina: compte.claveOficina,
      numCuenta: compte.numCuenta,
    });

    if (!compteId) {
      comptesNoResolts.push(compte);
      avisos.push(
        `Compte N43 ${compte.claveEntidad}-${compte.claveOficina}-${compte.numCuenta} no s'ha pogut aparellar amb cap gaco_comptes.`
      );
      continue;
    }

    for (const moviment of compte.moviments) {
      const concepte = conceptePerMoviment(moviment);
      filesPerInserir.push({
        compte_id: compteId,
        data_operacio: moviment.dataOperacio,
        data_valor: moviment.dataValor,
        import: moviment.import,
        concepte,
        referencia: [moviment.referencia1, moviment.referencia2].filter(Boolean).join(' / '),
        estat: 'pendent',
        hash_deduplicacio: await hashDeduplicacio(compteId, moviment),
      });
    }
  }

  return { filesPerInserir, comptesNoResolts, avisos };
}

// ----------------------------------------------------------------------------
// Exemple d'ús amb supabase-js (comentat — no s'executa com a part del mòdul)
// ----------------------------------------------------------------------------
/*
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function resoldreCompteId({ claveEntidad, claveOficina, numCuenta }) {
  // Exemple de criteri d'aparellament — AJUSTAR segons com s'emmagatzemi
  // realment num_compte a gaco_comptes (IBAN complet vs. número intern):
  const { data } = await supabase
    .from('gaco_comptes')
    .select('id, num_compte')
    .ilike('num_compte', `%${numCuenta}%`)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function handleFileUpload(file) {
  const buffer = await file.arrayBuffer();
  const { filesPerInserir, comptesNoResolts, avisos } = await importarFitxerN43(buffer, resoldreCompteId);

  if (comptesNoResolts.length > 0) {
    console.warn('Comptes sense aparellar:', comptesNoResolts);
    // Mostrar a l'usuari abans de continuar — no inserir moviments orfes.
  }

  // upsert per aprofitar la restricció UNIQUE de hash_deduplicacio:
  // reimportar el mateix fitxer no genera duplicats (ignoreDuplicates: true).
  const { error } = await supabase
    .from('gaco_moviments_n43')
    .upsert(filesPerInserir, { onConflict: 'hash_deduplicacio', ignoreDuplicates: true });

  if (error) console.error('Error important N43:', error);
  console.log('Avisos:', avisos);
}
*/

export {
  decodeN43Buffer,
  parseN43,
  conceptePerMoviment,
  hashDeduplicacio,
  importarFitxerN43,
};
