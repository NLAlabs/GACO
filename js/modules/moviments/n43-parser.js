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
async function hashDeduplicacio(compteId, moviment, nOcurrencia = 1) {
  const concepte = conceptePerMoviment(moviment);
  const parts = [compteId, moviment.dataOperacio, moviment.dataValor, moviment.import, concepte];
  if (nOcurrencia > 1) parts.push(`#${nOcurrencia}`); // la 1a ocurrència conserva el hash antic
  const base = parts.join('|');
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
 * @returns {Promise<{ resultatsPerCompte: Array<ResultatCompte>, comptesNoResolts: Array<object>, avisos: string[] }>}
 *
 * ResultatCompte = {
 *   compteId, numCuenta, dataInicial, dataFinal,
 *   saldoInicial, saldoFinal (null si no hi ha registre 33), saldoCalculat,
 *   quadra (null|boolean), numApuntsDebe, totalImportDebe, numApuntsHaber, totalImportHaber,
 *   moviments: Array<object>  // files llestes per a gaco_moviments_n43 (sense importacio_id encara)
 * }
 *
 * NOTA (disseny pensant en l'automatització futura): aquesta funció i tot
 * aquest fitxer són purs (no coneixen Supabase ni el DOM) — el mateix codi
 * es podrà reutilitzar tal qual des d'una funció programada (p. ex. un
 * Supabase Edge Function que descarregui l'N43 automàticament) el dia que
 * el banc ho permeti, sense reescriure la lògica de parseig ni de quadre.
 * Només caldrà canviar qui truca a `importarFitxerN43` i com s'hi arriba
 * el `buffer`.
 */
async function importarFitxerN43(buffer, resoldreCompteId) {
  const { text, encoding } = decodeN43Buffer(buffer);
  const { comptes, avisos } = parseN43(text);
  const resultatsPerCompte = [];
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

    const moviments = [];
    // Moviments idèntics dins del mateix fitxer (p. ex. dues comissions de 0,90 € el mateix dia):
    // el primer manté el hash de sempre; del segon endavant s'hi afegeix el nº d'ocurrència.
    const ocurrencies = new Map();
    for (const moviment of compte.moviments) {
      const concepte = conceptePerMoviment(moviment);
      const clauMov = [moviment.dataOperacio, moviment.dataValor, moviment.import, concepte].join('|');
      const nOcurrencia = (ocurrencies.get(clauMov) ?? 0) + 1;
      ocurrencies.set(clauMov, nOcurrencia);
      moviments.push({
        compte_id: compteId,
        data_operacio: moviment.dataOperacio,
        data_valor: moviment.dataValor,
        import: moviment.import,
        concepte,
        referencia: [moviment.referencia1, moviment.referencia2].filter(Boolean).join(' / '),
        estat: 'pendent',
        hash_deduplicacio: await hashDeduplicacio(compteId, moviment, nOcurrencia),
      });
    }

    // Quadre de saldo: saldo_inicial + suma dels imports del fitxer ha de
    // coincidir amb el saldo_final que declara el propi fitxer (registre 33).
    // Si no hi ha registre 33, no es pot verificar (queda null, no false).
    const sumaImports = compte.moviments.reduce((s, m) => s + m.import, 0);
    const saldoFinal = compte.tancament ? compte.tancament.saldoFinal : null;
    let saldoInicial = compte.saldoInicial;
    let saldoCalculat = Math.round((saldoInicial + sumaImports) * 100) / 100;
    let quadra = saldoFinal === null ? null : Math.abs(saldoCalculat - saldoFinal) < 0.005;

    // Algunes entitats (Secció de Crèdit) emeten el signe del saldo inicial girat.
    // Si no quadra però girant-lo sí que quadra exactament, s'accepta i s'avisa.
    let signeInicialCorregit = false;
    if (quadra === false && saldoInicial !== 0) {
      const calculatGirat = Math.round((-saldoInicial + sumaImports) * 100) / 100;
      if (Math.abs(calculatGirat - saldoFinal) < 0.005) {
        avisos.push(
          `Compte ${compte.numCuenta}: el signe del saldo inicial semblava invertit (${saldoInicial.toFixed(2)} €) ` +
            `i s'ha corregit a ${(-saldoInicial).toFixed(2)} € perquè el quadre sigui exacte.`
        );
        saldoInicial = -saldoInicial;
        saldoCalculat = calculatGirat;
        quadra = true;
        signeInicialCorregit = true;
      }
    }

    if (!compte.tancament) {
      avisos.push(
        `Compte ${compte.numCuenta}: sense registre de tancament (33) — no es pot verificar el quadre de saldo.`
      );
    } else if (!quadra) {
      avisos.push(
        `Compte ${compte.numCuenta}: el saldo NO quadra (calculat ${saldoCalculat.toFixed(2)} €, ` +
          `fitxer ${saldoFinal.toFixed(2)} €, diferència ${(saldoFinal - saldoCalculat).toFixed(2)} €).`
      );
    }

    resultatsPerCompte.push({
      compteId,
      numCuenta: compte.numCuenta,
      dataInicial: compte.fechaInicial,
      dataFinal: compte.fechaFinal,
      saldoInicial,
      signeInicialCorregit,
      saldoFinal,
      saldoCalculat,
      quadra,
      numApuntsDebe: compte.tancament?.numApuntesDebe ?? null,
      totalImportDebe: compte.tancament?.totalImportesDebe ?? null,
      numApuntsHaber: compte.tancament?.numApuntesHaber ?? null,
      totalImportHaber: compte.tancament?.totalImportesHaber ?? null,
      moviments,
    });
  }

  return { resultatsPerCompte, comptesNoResolts, avisos };
}

// ----------------------------------------------------------------------------
// Ús real des de Supabase: veure n43-import.js del mateix directori, que
// insereix primer la tanda a gaco_importacions_n43 i després els moviments
// amb l'importacio_id ja assignat.
// ----------------------------------------------------------------------------

export {
  decodeN43Buffer,
  parseN43,
  conceptePerMoviment,
  hashDeduplicacio,
  importarFitxerN43,
};
