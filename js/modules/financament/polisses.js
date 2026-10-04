import { supabase } from '../../lib/supabaseClient.js';
import { openModal, closeModal } from '../../lib/modal.js';

// ----------------------------------------------------------------------------
// Pòlisses de crèdit (comptes tipus 'credit').
// Fórmules verificades número a número amb 2 extractes reals d'Ibercaja (4794):
//   dies            = periode_fi − periode_inici + 1 (extrems inclosos)
//   saldo_mitja     = números_deure × 100 ÷ dies
//   interessos      = números_deure × tipus_nominal% ÷ 365   (any civil)
//   comissió dispon.= (límit − saldo_mitja) × comissió% × dies ÷ 365
//   total           = interessos + excedits + comissió
// Revisió de tipus: el nou tipus s'aplica des de data_efecte (inclosa),
// mateixa semàntica que gaco_prestecs_revisions_interes.
// ----------------------------------------------------------------------------

function formatImport(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('ca-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function formatNum(n, dec = 2) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('ca-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function formatData(dataStr) {
  if (!dataStr) return '—';
  const [y, m, d] = dataStr.split('-');
  return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
}

function avui() {
  return new Date().toISOString().slice(0, 10);
}

function arrodonir2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function diesEntre(inici, fi) {
  const a = new Date(inici + 'T00:00:00Z');
  const b = new Date(fi + 'T00:00:00Z');
  return Math.round((b - a) / 86400000) + 1;
}

function diesFinsAvui(dataStr) {
  const a = new Date(avui() + 'T00:00:00Z');
  const b = new Date(dataStr + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

export function tipusVigent(revisions, dataStr) {
  const aplicables = revisions.filter((r) => r.data_efecte <= dataStr).sort((a, b) => (a.data_efecte < b.data_efecte ? 1 : -1));
  return aplicables.length ? Number(aplicables[0].tipus_nominal_pct) : null;
}

/** Càlcul teòric d'una liquidació a partir dels números i les condicions. */
export function calcularLiquidacio({ numeros, dies, tipusPct, limit, comissioPct }) {
  const saldoMitja = dies > 0 ? (numeros * 100) / dies : 0;
  const interessos = arrodonir2((numeros * tipusPct) / 365);
  const comissio = arrodonir2(Math.max(0, limit - saldoMitja) * (comissioPct / 100) * (dies / 365));
  return { saldoMitja: arrodonir2(saldoMitja), interessos, comissio };
}


function dataSuma(dataStr, dies) {
  const d = new Date(dataStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dies);
  return d.toISOString().slice(0, 10);
}

/**
 * Quadre automàtic: recalcula els números del deure des dels moviments N43
 * del compte, dia a dia per DATA VALOR (saldo de final de dia × 1 dia).
 * Saldo(D) = saldo_inicial de la primera importació + Σ imports amb data_valor ≤ D.
 * Saldo negatiu = deute. Es treballa en cèntims per no acumular error de coma flotant.
 */
export async function calcularNumerosDesDeMoviments(compteId, inici, fi, limit) {
  const { data: imps, error: errImp } = await supabase
    .from('gaco_importacions_n43')
    .select('data_inicial, data_final, saldo_inicial, quadra, continua_anterior')
    .eq('compte_id', compteId)
    .order('data_inicial', { ascending: true });
  if (errImp) return { error: errImp.message };
  if (!imps?.length) return { error: "No hi ha cap importació N43 d'aquest compte." };

  const primera = imps[0];
  if (primera.data_inicial > inici) {
    return { error: `Les importacions N43 comencen el ${formatData(primera.data_inicial)}, després de l'inici del període: no es pot calcular.` };
  }

  const avisos = [];
  const rellevants = imps.filter((i) => i.data_final >= inici && i.data_inicial <= fi);
  if (rellevants.some((i) => i.quadra === false)) avisos.push("Alguna importació del període no quadra el saldo (veure Moviments → Importacions).");
  if (rellevants.some((i) => i.continua_anterior === false)) avisos.push('Hi ha un salt de continuïtat entre importacions dins del període.');
  const ultimaFinal = imps.reduce((mx, i) => (i.data_final > mx ? i.data_final : mx), '');
  if (ultimaFinal < fi) avisos.push(`Els moviments importats només arriben fins al ${formatData(ultimaFinal)}.`);

  let tots = [];
  const mida = 1000;
  for (let desde = 0; ; desde += mida) {
    const { data, error } = await supabase
      .from('gaco_moviments_n43')
      .select('data_valor, import')
      .eq('compte_id', compteId)
      .lte('data_valor', fi)
      .order('data_valor', { ascending: true })
      .order('id', { ascending: true })
      .range(desde, desde + mida - 1);
    if (error) return { error: error.message };
    tots = tots.concat(data);
    if (data.length < mida) break;
  }

  let saldoCt = Math.round(Number(primera.saldo_inicial) * 100);
  let idx = 0;
  while (idx < tots.length && tots[idx].data_valor < inici) {
    saldoCt += Math.round(Number(tots[idx].import) * 100);
    idx++;
  }

  const limitCt = Math.round(limit * 100);
  let numerosCt = 0; // saldo(cèntims) acumulat en dies
  let excedCt = 0;
  let maxDeuteCt = 0;
  let diesExcedit = 0;
  for (let d = inici; d <= fi; d = dataSuma(d, 1)) {
    while (idx < tots.length && tots[idx].data_valor <= d) {
      saldoCt += Math.round(Number(tots[idx].import) * 100);
      idx++;
    }
    const deute = saldoCt < 0 ? -saldoCt : 0;
    numerosCt += deute;
    if (deute > maxDeuteCt) maxDeuteCt = deute;
    if (deute > limitCt) {
      excedCt += deute - limitCt;
      diesExcedit++;
    }
  }

  // número = saldo × dies ÷ 100 ; amb cèntims: ÷ 100 (cèntims→€) ÷ 100
  return {
    numeros: arrodonir2(numerosCt / 10000),
    numerosExcedits: arrodonir2(excedCt / 10000),
    maxDispost: maxDeuteCt / 100,
    diesExcedit,
    avisos,
  };
}

let polissesCache = [];

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant...</p>';
  await carregarLlista();
}

async function carregarLlista() {
  const contenidor = document.getElementById('app-content');

  const [{ data: comptes, error }, { data: condicions }] = await Promise.all([
    supabase
      .from('gaco_comptes')
      .select('id, num_compte, descripcio, actiu, compte_polissa_vinculat_id, gaco_entitats_bancaries ( nom )')
      .eq('tipus', 'credit')
      .order('num_compte'),
    supabase.from('gaco_polisses_condicions').select('*').order('data_formalitzacio', { ascending: false }),
  ]);

  if (error) {
    contenidor.innerHTML = `<p class="error">Error carregant pòlisses: ${error.message}</p>`;
    return;
  }

  polissesCache = comptes ?? [];
  if (!polissesCache.length) {
    contenidor.innerHTML = '<div class="card"><p>Cap compte de tipus crèdit. Crea\'l a Configuració → Comptes.</p></div>';
    return;
  }

  // Últim saldo conegut per compte (última importació N43)
  const saldos = {};
  await Promise.all(
    polissesCache.map(async (c) => {
      const { data } = await supabase
        .from('gaco_importacions_n43')
        .select('data_final, saldo_final, saldo_calculat')
        .eq('compte_id', c.id)
        .order('data_final', { ascending: false })
        .limit(1);
      saldos[c.id] = data?.[0] ?? null;
    })
  );

  contenidor.innerHTML = polissesCache
    .map((c) => {
      const cond = (condicions ?? []).find((x) => x.compte_id === c.id) ?? null;
      return htmlPolissa(c, cond, saldos[c.id]);
    })
    .join('');

  contenidor.querySelectorAll('[data-liquidacions]').forEach((btn) => {
    btn.addEventListener('click', () => obrirModalLiquidacions(btn.dataset.liquidacions));
  });
  contenidor.querySelectorAll('[data-condicions]').forEach((btn) => {
    btn.addEventListener('click', () => obrirModalCondicions(btn.dataset.condicions));
  });
  contenidor.querySelectorAll('[data-revisions]').forEach((btn) => {
    btn.addEventListener('click', () => obrirModalRevisions(btn.dataset.revisions));
  });
}

function htmlPolissa(c, cond, saldoInfo) {
  let blocSaldo = '<p>Dispost actual: — (cap importació N43 encara)</p>';
  if (saldoInfo) {
    const saldo = saldoInfo.saldo_final ?? saldoInfo.saldo_calculat;
    const dispost = saldo < 0 ? -saldo : 0;
    const limit = cond ? Number(cond.limit_import) : null;
    blocSaldo = `<p>Dispost a ${formatData(saldoInfo.data_final)}: <strong>${formatImport(dispost)}</strong>${
      limit !== null ? ` · Disponible: <strong>${formatImport(limit - dispost)}</strong>` : ''
    }</p>`;
  }

  let blocVenciment = '';
  if (cond?.data_venciment) {
    const dies = diesFinsAvui(cond.data_venciment);
    const av = dies < 0 ? ` <strong style="color:#b00020;">(vençuda fa ${-dies} dies)</strong>` : dies <= 90 ? ` <strong style="color:#b00020;">(venç en ${dies} dies — cal renovar)</strong>` : ` (en ${dies} dies)`;
    blocVenciment = `<p>Venciment: ${formatData(cond.data_venciment)}${av}</p>`;
  }

  return `
    <div class="card">
      <p class="modal-section-title">${c.gaco_entitats_bancaries?.nom ?? '?'} · Pòlissa ${c.num_compte}${c.actiu ? '' : ' · Inactiva'}</p>
      ${c.descripcio ? `<p><strong>${c.descripcio}</strong></p>` : ''}
      ${
        cond
          ? `<p>Límit: <strong>${formatImport(cond.limit_import)}</strong> · Comissió disponibilitat: ${formatNum(cond.comissio_disponibilitat_pct, 3)}% anual · Excedits: ${cond.interes_excedits_pct !== null ? formatNum(cond.interes_excedits_pct, 3) + '%' : '—'}</p>
             ${cond.index_referencia ? `<p>Interès: ${cond.index_referencia} + ${formatNum(cond.diferencial_pct, 3)} (${cond.periodicitat_revisio ?? '—'})</p>` : ''}
             ${blocVenciment}`
          : '<p style="color:#b00020;">Sense condicions de contracte registrades.</p>'
      }
      ${blocSaldo}
      <button type="button" data-liquidacions="${c.id}">Liquidacions</button>
      <button type="button" data-revisions="${c.id}">Tipus d'interès</button>
      <button type="button" data-condicions="${c.id}">Condicions</button>
    </div>
  `;
}

// ----------------------------------------------------------------------------
// Condicions del contracte
// ----------------------------------------------------------------------------

async function obrirModalCondicions(compteId) {
  const { data, error } = await supabase
    .from('gaco_polisses_condicions')
    .select('*')
    .eq('compte_id', compteId)
    .order('data_formalitzacio', { ascending: false })
    .limit(1);
  if (error) {
    alert('Error carregant les condicions: ' + error.message);
    return;
  }
  const v = data?.[0] ?? {};
  const val = (x) => (x === null || x === undefined ? '' : x);

  openModal({
    title: 'Condicions del contracte',
    wide: true,
    bodyHtml: `
      <div class="modal-section">
        <label>Data de formalització <input type="date" id="c-formalitzacio" value="${val(v.data_formalitzacio)}" /></label>
        <label>Data de venciment <input type="date" id="c-venciment" value="${val(v.data_venciment)}" /></label>
        <label>Límit (€) <input type="number" step="0.01" id="c-limit" value="${val(v.limit_import)}" /></label>
      </div>
      <div class="modal-section">
        <label>Comissió de disponibilitat (% anual) <input type="number" step="0.001" id="c-com-disp" value="${val(v.comissio_disponibilitat_pct)}" /></label>
        <label>Comissió d'obertura (%) <input type="number" step="0.001" id="c-com-ob-pct" value="${val(v.comissio_obertura_pct)}" /></label>
        <label>Comissió d'obertura (€) <input type="number" step="0.01" id="c-com-ob-imp" value="${val(v.comissio_obertura_import)}" /></label>
        <label>Interès d'excedits (% anual) <input type="number" step="0.001" id="c-excedits" value="${val(v.interes_excedits_pct)}" /></label>
      </div>
      <div class="modal-section">
        <label>Índex de referència <input type="text" id="c-index" value="${val(v.index_referencia)}" placeholder="EURIBOR 6M" /></label>
        <label>Diferencial (punts) <input type="number" step="0.001" id="c-diferencial" value="${val(v.diferencial_pct)}" /></label>
        <label>Periodicitat de revisió <input type="text" id="c-per-revisio" value="${val(v.periodicitat_revisio)}" placeholder="semestral" /></label>
        <label>Periodicitat de liquidació <input type="text" id="c-per-liq" value="${v.periodicitat_liquidacio ?? 'trimestral'}" /></label>
        <label>Notes <input type="text" id="c-notes" value="${(v.notes ?? '').replace(/"/g, '&quot;')}" /></label>
      </div>
      <button type="button" id="btn-desar-condicions">Desar</button>
    `,
    onMount: (bodyEl) => {
      bodyEl.querySelector('#btn-desar-condicions').addEventListener('click', async () => {
        const g = (id) => bodyEl.querySelector(id).value;
        const num = (id) => (g(id) === '' ? null : parseFloat(g(id)));
        const registre = {
          compte_id: compteId,
          data_formalitzacio: g('#c-formalitzacio'),
          data_venciment: g('#c-venciment') || null,
          limit_import: num('#c-limit'),
          comissio_disponibilitat_pct: num('#c-com-disp') ?? 0,
          comissio_obertura_pct: num('#c-com-ob-pct'),
          comissio_obertura_import: num('#c-com-ob-imp'),
          interes_excedits_pct: num('#c-excedits'),
          index_referencia: g('#c-index') || null,
          diferencial_pct: num('#c-diferencial'),
          periodicitat_revisio: g('#c-per-revisio') || null,
          periodicitat_liquidacio: g('#c-per-liq') || 'trimestral',
          notes: g('#c-notes') || null,
        };
        if (!registre.data_formalitzacio || registre.limit_import === null) {
          alert('Cal indicar com a mínim la data de formalització i el límit.');
          return;
        }
        const query = v.id
          ? supabase.from('gaco_polisses_condicions').update(registre).eq('id', v.id)
          : supabase.from('gaco_polisses_condicions').insert(registre);
        const { error: errDes } = await query;
        if (errDes) {
          alert('Error desant les condicions: ' + errDes.message);
          return;
        }
        closeModal();
        carregarLlista();
      });
    },
  });
}

// ----------------------------------------------------------------------------
// Historial de tipus d'interès (variable)
// ----------------------------------------------------------------------------

function htmlRevisio(r) {
  return `<p>Des del ${formatData(r.data_efecte)}: <strong>${formatNum(r.tipus_nominal_pct, 3)}%</strong>${r.notes ? ' — ' + r.notes : ''}
    <button type="button" data-esborrar-revisio="${r.id}" style="font-size:11px;">Esborrar</button></p>`;
}

async function obrirModalRevisions(compteId) {
  const { data: revisions, error } = await supabase
    .from('gaco_polisses_revisions_interes')
    .select('*')
    .eq('compte_id', compteId)
    .order('data_efecte', { ascending: false });
  if (error) {
    alert('Error carregant les revisions: ' + error.message);
    return;
  }

  openModal({
    title: "Tipus d'interès de la pòlissa",
    wide: true,
    bodyHtml: `
      <div class="modal-section">
        <p style="font-size:13px; color: var(--gaco-text-secondary);">
          La data és el <strong>primer dia</strong> amb el nou tipus (el dia de revisió del contracte encara compta amb el tipus vell).
        </p>
        <div>${(revisions ?? []).map(htmlRevisio).join('') || '<p>Cap tipus registrat.</p>'}</div>
      </div>
      <div class="modal-section">
        <label>Vigent des de <input type="date" id="r-data" /></label>
        <label>Tipus nominal (%) <input type="number" id="r-tipus" step="0.001" style="width:90px;" /></label>
        <label>Notes <input type="text" id="r-notes" placeholder="p. ex. EURIBOR 6M + 2,600" /></label>
        <button type="button" id="btn-afegir-revisio">Afegir tipus</button>
      </div>
    `,
    onMount: (bodyEl) => {
      bodyEl.querySelector('#btn-afegir-revisio').addEventListener('click', async () => {
        const data = bodyEl.querySelector('#r-data').value;
        const tipus = bodyEl.querySelector('#r-tipus').value;
        if (!data || tipus === '') {
          alert('Cal indicar la data i el tipus.');
          return;
        }
        const { error: errR } = await supabase.from('gaco_polisses_revisions_interes').insert({
          compte_id: compteId,
          data_efecte: data,
          tipus_nominal_pct: parseFloat(tipus),
          notes: bodyEl.querySelector('#r-notes').value || null,
        });
        if (errR) {
          alert('Error afegint el tipus: ' + errR.message);
          return;
        }
        closeModal();
        obrirModalRevisions(compteId);
      });
      bodyEl.querySelectorAll('[data-esborrar-revisio]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Esborrar aquest tipus?')) return;
          await supabase.from('gaco_polisses_revisions_interes').delete().eq('id', btn.dataset.esborrarRevisio);
          closeModal();
          obrirModalRevisions(compteId);
        });
      });
    },
  });
}

// ----------------------------------------------------------------------------
// Liquidacions trimestrals
// ----------------------------------------------------------------------------

function htmlLiquidacio(l) {
  const periode = l.periode_inici ? `${formatData(l.periode_inici)} → ${formatData(l.periode_fi)} (${l.dies} dies)` : formatData(l.data);
  return `
    <div class="card">
      <p class="modal-section-title">${periode} · valor ${formatData(l.data)}</p>
      <p>Interessos: ${formatImport(l.import_interessos)} · Comissió disponibilitat: ${formatImport(l.import_comissio_no_disposat)}${
        Number(l.import_excedits) ? ' · <strong>Excedits: ' + formatImport(l.import_excedits) + '</strong>' : ''
      }</p>
      <p>Total carregat: <strong>${formatImport(l.import_total ?? l.import)}</strong>${l.tipus_nominal_pct !== null ? ` · Tipus ${formatNum(l.tipus_nominal_pct, 3)}% · Saldo mitjà ${formatImport(l.saldo_mitja)}` : ''}</p>
      ${l.moviment_n43_id ? '<p style="font-size:12px;">✔ Conciliada amb moviment bancari</p>' : '<p style="font-size:12px; color:#b00020;">Sense conciliar</p>'}
      <button type="button" data-editar-liq="${l.id}">Editar</button>
      <button type="button" data-esborrar-liq="${l.id}">Esborrar</button>
    </div>
  `;
}

async function obrirModalLiquidacions(compteId) {
  const compte = polissesCache.find((c) => c.id === compteId);
  const { data: liqs, error } = await supabase
    .from('gaco_liquidacions_polissa')
    .select('*')
    .eq('compte_polissa_id', compteId)
    .order('data', { ascending: false });
  if (error) {
    alert('Error carregant les liquidacions: ' + error.message);
    return;
  }

  openModal({
    title: `Liquidacions — ${compte?.num_compte ?? ''}`,
    wide: true,
    bodyHtml: `
      <div class="modal-section">
        <button type="button" id="btn-nova-liq">+ Nova liquidació</button>
      </div>
      ${(liqs ?? []).map(htmlLiquidacio).join('') || '<p>Cap liquidació registrada.</p>'}
    `,
    onMount: (bodyEl) => {
      bodyEl.querySelector('#btn-nova-liq').addEventListener('click', () => {
        closeModal();
        obrirModalFormLiquidacio(compteId, null);
      });
      bodyEl.querySelectorAll('[data-editar-liq]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const l = liqs.find((x) => x.id === btn.dataset.editarLiq);
          closeModal();
          obrirModalFormLiquidacio(compteId, l);
        });
      });
      bodyEl.querySelectorAll('[data-esborrar-liq]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Esborrar aquesta liquidació? (No esborra el moviment bancari ni cap despesa associada.)')) return;
          const { error: errE } = await supabase.from('gaco_liquidacions_polissa').delete().eq('id', btn.dataset.esborrarLiq);
          if (errE) {
            alert('Error esborrant: ' + errE.message);
            return;
          }
          closeModal();
          obrirModalLiquidacions(compteId);
        });
      });
    },
  });
}

async function obrirModalFormLiquidacio(compteId, v) {
  const [{ data: condData }, { data: revisions }] = await Promise.all([
    supabase.from('gaco_polisses_condicions').select('*').eq('compte_id', compteId).order('data_formalitzacio', { ascending: false }).limit(1),
    supabase.from('gaco_polisses_revisions_interes').select('*').eq('compte_id', compteId),
  ]);
  const cond = condData?.[0];
  if (!cond) {
    alert('Primer cal registrar les condicions del contracte (botó "Condicions").');
    obrirModalLiquidacions(compteId);
    return;
  }
  const val = (x) => (x === null || x === undefined ? '' : x);
  v = v ?? {};

  openModal({
    title: v.id ? 'Editar liquidació' : 'Nova liquidació',
    wide: true,
    bodyHtml: `
      <div class="modal-section">
        <p class="modal-section-title">Dades de l'extracte</p>
        <label>Inici del període <input type="date" id="l-inici" value="${val(v.periode_inici)}" /></label>
        <label>Fi del període <input type="date" id="l-fi" value="${val(v.periode_fi)}" /></label>
        <label>Data valor del càrrec <input type="date" id="l-data" value="${val(v.data)}" /></label>
        <label>Números deure <input type="number" step="0.01" id="l-numeros" value="${val(v.numeros_deure)}" /></label>
        <label>Tipus nominal (%) <input type="number" step="0.001" id="l-tipus" value="${val(v.tipus_nominal_pct)}" /></label>
        <label>TAE (informatiu) <input type="number" step="0.001" id="l-tae" value="${val(v.tae_pct)}" /></label>
      </div>
      <div class="modal-section">
        <p class="modal-section-title">Imports segons el banc</p>
        <label>Interessos <input type="number" step="0.01" id="l-interessos" value="${val(v.import_interessos)}" /></label>
        <label>Excedits <input type="number" step="0.01" id="l-excedits" value="${val(v.import_excedits ?? 0)}" /></label>
        <label>Comissió no disposat <input type="number" step="0.01" id="l-comissio" value="${val(v.import_comissio_no_disposat)}" /></label>
        <label>Total carregat <input type="number" step="0.01" id="l-total" value="${val(v.import_total)}" /></label>
        <button type="button" id="btn-calc-mov">Calcular números des dels moviments N43</button>
        <button type="button" id="btn-precalcular">Precalcular imports amb les condicions</button>
        <div id="l-info-mov" style="margin-top:8px; font-size:13px;"></div>
        <div id="l-quadre" style="margin-top:8px; font-size:13px;"></div>
      </div>
      <label>Notes <input type="text" id="l-notes" value="${(v.notes ?? '').replace(/"/g, '&quot;')}" /></label>
      <button type="button" id="btn-desar-liq">Desar</button>
    `,
    onMount: (bodyEl) => {
      const g = (id) => bodyEl.querySelector(id).value;
      const num = (id) => (g(id) === '' ? null : parseFloat(g(id)));

      function teoric() {
        const inici = g('#l-inici');
        const fi = g('#l-fi');
        const numeros = num('#l-numeros');
        if (!inici || !fi || numeros === null) return null;
        const dies = diesEntre(inici, fi);
        const tipusPct = num('#l-tipus') ?? tipusVigent(revisions ?? [], inici);
        if (tipusPct === null) return null;
        return { dies, tipusPct, ...calcularLiquidacio({ numeros, dies, tipusPct, limit: Number(cond.limit_import), comissioPct: Number(cond.comissio_disponibilitat_pct) }) };
      }

      function pintarQuadre() {
        const el = bodyEl.querySelector('#l-quadre');
        const t = teoric();
        if (!t) {
          el.innerHTML = '';
          return;
        }
        const inici = g('#l-inici');
        const fi = g('#l-fi');
        const revDins = (revisions ?? []).filter((r) => r.data_efecte > inici && r.data_efecte <= fi);
        const cmp = (nom, banc, calc) => {
          if (banc === null) return `<p>${nom}: càlcul ${formatImport(calc)}</p>`;
          const dif = arrodonir2(banc - calc);
          return `<p>${nom}: banc ${formatImport(banc)} · càlcul ${formatImport(calc)} ${Math.abs(dif) < 0.015 ? '✔' : `<strong style="color:#b00020;">⚠ diferència ${formatImport(dif)}</strong>`}</p>`;
        };
        el.innerHTML = `
          <p>${t.dies} dies · saldo mitjà teòric ${formatImport(t.saldoMitja)} · tipus ${formatNum(t.tipusPct, 3)}%</p>
          ${cmp('Interessos', num('#l-interessos'), t.interessos)}
          ${cmp('Comissió', num('#l-comissio'), t.comissio)}
          ${revDins.length ? `<p style="color:#b00020;">⚠ Hi ha un canvi de tipus dins del període (${revDins.map((r) => formatData(r.data_efecte)).join(', ')}): el càlcul amb un sol tipus no és exacte; fes servir els imports del banc.</p>` : ''}
        `;
      }

      bodyEl.querySelector('#btn-calc-mov').addEventListener('click', async () => {
        const inici = g('#l-inici');
        const fi = g('#l-fi');
        const infoEl = bodyEl.querySelector('#l-info-mov');
        if (!inici || !fi) {
          alert("Cal indicar l'inici i la fi del període.");
          return;
        }
        infoEl.textContent = 'Calculant...';
        const r = await calcularNumerosDesDeMoviments(compteId, inici, fi, Number(cond.limit_import));
        if (r.error) {
          infoEl.innerHTML = `<span style="color:#b00020;">${r.error}</span>`;
          return;
        }
        const banc = num('#l-numeros');
        let cmp = '';
        if (banc === null) {
          bodyEl.querySelector('#l-numeros').value = r.numeros;
          cmp = ' (omplert al camp)';
        } else {
          const dif = arrodonir2(banc - r.numeros);
          cmp = Math.abs(dif) < 1 ? ' ✔ quadra amb el banc' : ` <strong style="color:#b00020;">⚠ banc ${formatNum(banc)} · diferència ${formatNum(dif)}</strong>`;
        }
        const excedits = r.diesExcedit
          ? `<p style="color:#b00020;"><strong>⚠ ${r.diesExcedit} dies amb saldo per sobre del límit</strong> (números d'excedit ${formatNum(r.numerosExcedits)}${
              cond.interes_excedits_pct ? ' · interès teòric ' + formatImport((r.numerosExcedits * Number(cond.interes_excedits_pct)) / 365) : ''
            }).</p>`
          : `<p>Cap dia per sobre del límit. Màxim dispost: ${formatImport(r.maxDispost)} (a ${formatImport(Number(cond.limit_import) - r.maxDispost)} del límit).</p>`;
        infoEl.innerHTML = `<p>Números des dels moviments: <strong>${formatNum(r.numeros)}</strong>${cmp}</p>${excedits}${r.avisos.map((a) => `<p style="color:#b00020;">⚠ ${a}</p>`).join('')}`;
        pintarQuadre();
      });

      bodyEl.querySelector('#btn-precalcular').addEventListener('click', () => {
        const inici = g('#l-inici');
        if (inici && g('#l-tipus') === '') {
          const tv = tipusVigent(revisions ?? [], inici);
          if (tv !== null) bodyEl.querySelector('#l-tipus').value = tv;
        }
        const t = teoric();
        if (!t) {
          alert('Cal indicar inici, fi, números deure i que hi hagi un tipus vigent.');
          return;
        }
        bodyEl.querySelector('#l-interessos').value = t.interessos;
        bodyEl.querySelector('#l-comissio').value = t.comissio;
        if (!g('#l-data') && g('#l-fi')) {
          const d = new Date(g('#l-fi') + 'T00:00:00Z');
          d.setUTCDate(d.getUTCDate() + 1);
          bodyEl.querySelector('#l-data').value = d.toISOString().slice(0, 10);
        }
        bodyEl.querySelector('#l-total').value = arrodonir2(t.interessos + (num('#l-excedits') ?? 0) + t.comissio);
        pintarQuadre();
      });

      ['#l-inici', '#l-fi', '#l-numeros', '#l-tipus', '#l-interessos', '#l-comissio'].forEach((id) => bodyEl.querySelector(id).addEventListener('input', pintarQuadre));
      pintarQuadre();

      bodyEl.querySelector('#btn-desar-liq').addEventListener('click', async () => {
        const inici = g('#l-inici');
        const fi = g('#l-fi');
        const dataValor = g('#l-data');
        if (!inici || !fi || !dataValor) {
          alert('Cal indicar inici, fi i data valor.');
          return;
        }
        if (fi < inici) {
          alert('La fi del període no pot ser anterior a l\'inici.');
          return;
        }
        const interessos = num('#l-interessos') ?? 0;
        const excedits = num('#l-excedits') ?? 0;
        const comissio = num('#l-comissio') ?? 0;
        const totalCalc = arrodonir2(interessos + excedits + comissio);
        const total = num('#l-total') ?? totalCalc;
        if (Math.abs(total - totalCalc) >= 0.015 && !confirm(`El total (${formatImport(total)}) no coincideix amb la suma de components (${formatImport(totalCalc)}). Desar igualment?`)) return;

        const numeros = num('#l-numeros');
        const dies = diesEntre(inici, fi);
        const registre = {
          compte_polissa_id: compteId,
          data: dataValor,
          periode_inici: inici,
          periode_fi: fi,
          dies,
          numeros_deure: numeros,
          saldo_mitja: numeros !== null ? arrodonir2((numeros * 100) / dies) : null,
          tipus_nominal_pct: num('#l-tipus'),
          tae_pct: num('#l-tae'),
          import_interessos: interessos,
          import_excedits: excedits,
          import_comissio_no_disposat: comissio,
          import_total: total,
          notes: g('#l-notes') || null,
        };
        const query = v.id
          ? supabase.from('gaco_liquidacions_polissa').update(registre).eq('id', v.id)
          : supabase.from('gaco_liquidacions_polissa').insert(registre);
        const { error } = await query;
        if (error) {
          alert(error.code === '23505' ? 'Ja existeix una liquidació d\'aquesta pòlissa amb el mateix final de període.' : 'Error desant la liquidació: ' + error.message);
          return;
        }
        closeModal();
        obrirModalLiquidacions(compteId);
      });
    },
  });
}
