import { supabase } from '../../lib/supabaseClient.js';
import { openModal, closeModal } from '../../lib/modal.js';

// ----------------------------------------------------------------------------
// Compte corrent de socis (comptes 551/555).
// Conveni de signe: import > 0 → la SL deu al soci; import < 0 → el soci deu a la SL.
// El saldo NO es desa: sempre es calcula sumant els apunts (per data).
// ----------------------------------------------------------------------------

const TIPUS = {
  avancament_factura: { label: 'Avançament de factura (el soci paga una despesa de la SL)', signe: 1 },
  compensacio_factura: { label: 'Compensació de factura (factura del soci liquidada contra el saldo)', signe: 1 },
  transferencia_a_soci: { label: 'Transferència de la SL (préstec o entrega de diners)', signe: -1 },
  saldo_obertura: { label: "Saldo d'obertura (el de la gestoria)", signe: 0 },
  ajust: { label: 'Ajust', signe: 0 },
};

function esc(t) {
  return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function formatImport(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('ca-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
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

function textSaldo(v, nom) {
  if (Math.abs(v) < 0.005) return 'Saldat (0,00 €)';
  return v > 0 ? `La SL deu ${formatImport(v)} a ${nom}` : `${nom} deu ${formatImport(-v)} a la SL`;
}

function htmlSaldo(v, nom) {
  const color = v < -0.005 ? '#b00020' : 'inherit';
  return `<strong style="color:${color};">${textSaldo(v, nom)}</strong>`;
}

const TITOL_SOCIS = 'Préstecs dels socis';
const TITOL_VINCULAT = 'Préstecs a RNA (pare)';

let socisCache = [];
let proveidorsCache = [];
let apuntsPerSoci = {};
let anyVista = new Date().getFullYear();

async function carregarDades() {
  const { data: socis, error } = await supabase.from('gaco_socis').select('*').order('nom');
  if (error) throw error;

  let apunts = [];
  const mida = 1000;
  for (let desde = 0; ; desde += mida) {
    const { data, error: errA } = await supabase
      .from('gaco_socis_compte_corrent')
      .select('id, soci_id, data, concepte, tipus_moviment, import, factura_id, moviment_n43_id, created_at')
      .order('data', { ascending: true })
      .order('created_at', { ascending: true })
      .range(desde, desde + mida - 1);
    if (errA) throw errA;
    apunts = apunts.concat(data);
    if (data.length < mida) break;
  }

  const { data: provs } = await supabase.from('gaco_proveidors').select('id, nom').eq('actiu', true).order('nom');
  proveidorsCache = provs ?? [];

  socisCache = socis ?? [];
  apuntsPerSoci = {};
  for (const s of socisCache) apuntsPerSoci[s.id] = [];
  for (const a of apunts) (apuntsPerSoci[a.soci_id] ??= []).push(a);
}

function resumAny(apunts, any) {
  const ini = `${any}-01-01`;
  const fi = `${any}-12-31`;
  let inicial = 0;
  let abonaments = 0;
  let carregues = 0;
  for (const a of apunts) {
    const imp = Number(a.import);
    if (a.data < ini) inicial += imp;
    else if (a.data <= fi) {
      if (imp >= 0) abonaments += imp;
      else carregues += imp;
    }
  }
  return { inicial: arrodonir2(inicial), abonaments: arrodonir2(abonaments), carregues: arrodonir2(carregues), final: arrodonir2(inicial + abonaments + carregues) };
}

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant...</p>';
  try {
    await carregarDades();
  } catch (err) {
    contenidor.innerHTML = `<p class="error">Error carregant socis: ${err.message}</p>`;
    return;
  }
  pintar();
}

function saldoTotal(llista) {
  return arrodonir2(llista.reduce((t, s) => t + (apuntsPerSoci[s.id] ?? []).reduce((u, a) => u + Number(a.import), 0), 0));
}

function pintar() {
  const contenidor = document.getElementById('app-content');
  const anys = new Set([new Date().getFullYear()]);
  Object.values(apuntsPerSoci).forEach((l) => l.forEach((a) => anys.add(Number(a.data.slice(0, 4)))));
  const llistaAnys = [...anys].sort((a, b) => b - a);

  const socis = socisCache.filter((s) => (s.tipus ?? 'soci') === 'soci');
  const vinculats = socisCache.filter((s) => s.tipus === 'vinculat');
  const totSocis = saldoTotal(socis);
  const totVinc = saldoTotal(vinculats);
  const net = arrodonir2(totSocis + totVinc);

  const textSocis = Math.abs(totSocis) < 0.005 ? 'saldat' : totSocis > 0 ? `la SL els deu ${formatImport(totSocis)}` : `els socis deuen ${formatImport(-totSocis)} a la SL`;
  const textVinc = Math.abs(totVinc) < 0.005 ? 'saldat' : totVinc > 0 ? `la SL li deu ${formatImport(totVinc)}` : `RNA deu ${formatImport(-totVinc)} a la SL`;
  const textNet = Math.abs(net) < 0.005 ? 'Compensat: saldo net 0,00 €' : net > 0 ? `Posició neta: la SL deu ${formatImport(net)} en conjunt` : `Posició neta: ${formatImport(-net)} a favor de la SL en conjunt`;

  contenidor.innerHTML = `
    <div class="card">
      <label>Any <select id="soci-any">${llistaAnys.map((y) => `<option value="${y}" ${y === anyVista ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      <p><strong>${TITOL_SOCIS}:</strong> ${textSocis}</p>
      <p><strong>${TITOL_VINCULAT}:</strong> ${textVinc}</p>
      <p><strong>${textNet}</strong></p>
      <p style="font-size:13px; color: var(--gaco-text-secondary);">
        Saldo positiu = la SL deu a la persona · negatiu = la persona deu a la SL (comptes 551/555). Els saldos es calculen dels apunts.
      </p>
    </div>
    <h3>${TITOL_SOCIS}</h3>
    ${socis.map(htmlSoci).join('') || '<div class="card"><p>Cap soci donat d\'alta.</p></div>'}
    <h3>${TITOL_VINCULAT}</h3>
    ${vinculats.map(htmlSoci).join('') || '<div class="card"><p>Cap persona vinculada donada d\'alta (veure schema_socis.sql).</p></div>'}
  `;

  contenidor.querySelector('#soci-any').addEventListener('change', (e) => {
    anyVista = Number(e.target.value);
    pintar();
  });
  contenidor.querySelectorAll('[data-extracte]').forEach((b) => b.addEventListener('click', () => obrirExtracte(b.dataset.extracte)));
  contenidor.querySelectorAll('[data-apunt]').forEach((b) => b.addEventListener('click', () => obrirNouApunt(b.dataset.apunt)));
  contenidor.querySelectorAll('[data-quadre]').forEach((b) => b.addEventListener('click', () => obrirQuadre(b.dataset.quadre)));
  contenidor.querySelectorAll('[data-lligar]').forEach((b) => b.addEventListener('click', () => obrirLligarProveidor(b.dataset.lligar)));
  contenidor.querySelectorAll('[data-compensar]').forEach((b) => b.addEventListener('click', () => obrirCompensar(b.dataset.compensar)));
}

function htmlSoci(s) {
  const apunts = apuntsPerSoci[s.id] ?? [];
  const total = arrodonir2(apunts.reduce((t, a) => t + Number(a.import), 0));
  const r = resumAny(apunts, anyVista);
  return `
    <div class="card">
      <p class="modal-section-title">${esc(s.nom)}${s.actiu ? '' : ' · Inactiu'}</p>
      <p>Saldo actual: ${htmlSaldo(total, s.nom)}</p>
      <p style="font-size:13px;">${anyVista}: inicial ${formatImport(r.inicial)} · abonaments al soci ${formatImport(r.abonaments)} · càrregues al soci ${formatImport(r.carregues)} · final any <strong>${formatImport(r.final)}</strong></p>
      <p style="font-size:13px;">Proveïdor lligat (les seves factures i arrendaments): ${
        s.proveidor_id ? `<strong>${esc(proveidorsCache.find((p) => p.id === s.proveidor_id)?.nom ?? '?')}</strong>` : '<em>cap</em>'
      } <button type="button" data-lligar="${s.id}" style="font-size:11px;">${s.proveidor_id ? 'Canviar' : 'Lligar'}</button></p>
      <button type="button" data-extracte="${s.id}">Extracte</button>
      <button type="button" data-apunt="${s.id}">+ Apunt</button>
      <button type="button" data-compensar="${s.id}" ${s.proveidor_id ? '' : 'disabled title="Primer cal lligar el proveïdor"'}>Compensar factures</button>
      <button type="button" data-quadre="${s.id}">Quadre amb la gestoria</button>
    </div>
  `;
}

// --- Extracte -----------------------------------------------------------------

function obrirExtracte(sociId) {
  const soci = socisCache.find((s) => s.id === sociId);
  const apunts = apuntsPerSoci[sociId] ?? [];
  const ini = `${anyVista}-01-01`;
  const fi = `${anyVista}-12-31`;
  const r = resumAny(apunts, anyVista);

  let saldo = r.inicial;
  const files = apunts
    .filter((a) => a.data >= ini && a.data <= fi)
    .map((a) => {
      saldo = arrodonir2(saldo + Number(a.import));
      const lligat = a.factura_id || a.moviment_n43_id;
      return `<tr>
        <td>${formatData(a.data)}</td>
        <td>${esc(a.concepte)}</td>
        <td>${TIPUS[a.tipus_moviment]?.label.split(' (')[0] ?? esc(a.tipus_moviment)}</td>
        <td style="text-align:right;">${formatImport(a.import)}</td>
        <td style="text-align:right;">${formatImport(saldo)}</td>
        <td>${lligat ? '<span title="Lligat a una factura o moviment bancari">🔗</span>' : `<button type="button" data-esborrar="${a.id}" style="font-size:11px;">Esborrar</button>`}</td>
      </tr>`;
    })
    .join('');

  openModal({
    title: `Extracte ${anyVista} — ${soci?.nom ?? ''}`,
    wide: true,
    bodyHtml: `
      <p>Saldo a l'1/1/${anyVista}: ${htmlSaldo(r.inicial, soci?.nom ?? '')}</p>
      <div style="overflow-x:auto;">
        <table style="width:100%; font-size:13px; border-collapse:collapse;">
          <thead><tr><th align="left">Data</th><th align="left">Concepte</th><th align="left">Tipus</th><th align="right">Import</th><th align="right">Saldo</th><th></th></tr></thead>
          <tbody>${files || '<tr><td colspan="6">Cap apunt aquest any.</td></tr>'}</tbody>
        </table>
      </div>
      <p>Saldo a 31/12/${anyVista}: ${htmlSaldo(r.final, soci?.nom ?? '')}</p>
      <p style="font-size:12px; color: var(--gaco-text-secondary);">Els apunts amb 🔗 venen d'una factura o d'un moviment bancari: es gestionen des d'allà.</p>
    `,
    onMount: (body) => {
      body.querySelectorAll('[data-esborrar]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Esborrar aquest apunt?')) return;
          const { error } = await supabase.from('gaco_socis_compte_corrent').delete().eq('id', btn.dataset.esborrar);
          if (error) return alert('Error esborrant: ' + error.message);
          closeModal();
          await render();
          obrirExtracte(sociId);
        });
      });
    },
  });
}

// --- Nou apunt manual ---------------------------------------------------------

function obrirNouApunt(sociId) {
  const soci = socisCache.find((s) => s.id === sociId);
  openModal({
    title: `Nou apunt — ${soci?.nom ?? ''}`,
    wide: true,
    bodyHtml: `
      <div class="modal-section">
        <label>Data <input type="date" id="a-data" value="${avui()}" /></label>
        <label>Tipus
          <select id="a-tipus">${Object.entries(TIPUS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
        </label>
        <div id="a-direccio-bloc">
          <label><input type="radio" name="a-dir" value="1" /> La SL deu més a la persona (+)</label>
          <label><input type="radio" name="a-dir" value="-1" /> La persona deu més a la SL (−)</label>
        </div>
        <label>Import (€, sempre positiu) <input type="number" step="0.01" min="0" id="a-import" /></label>
        <label>Concepte <input type="text" id="a-concepte" /></label>
      </div>
      <button type="button" id="btn-desar-apunt">Desar</button>
    `,
    onMount: (body) => {
      const tipusEl = body.querySelector('#a-tipus');
      const radios = [...body.querySelectorAll('input[name="a-dir"]')];
      const aplicarTipus = () => {
        const signe = TIPUS[tipusEl.value].signe;
        radios.forEach((r) => {
          r.disabled = signe !== 0;
          r.checked = signe !== 0 && Number(r.value) === signe;
        });
      };
      tipusEl.addEventListener('change', aplicarTipus);
      aplicarTipus();

      body.querySelector('#btn-desar-apunt').addEventListener('click', async () => {
        const data = body.querySelector('#a-data').value;
        const tipus = tipusEl.value;
        const importAbs = parseFloat(body.querySelector('#a-import').value);
        const sel = radios.find((r) => r.checked);
        if (!data) return alert('Cal indicar la data.');
        if (!(importAbs > 0)) return alert("L'import ha de ser major que zero.");
        if (!sel) return alert('Cal indicar en quin sentit va l\'apunt.');
        const concepte = body.querySelector('#a-concepte').value.trim() || TIPUS[tipus].label.split(' (')[0];
        const { error } = await supabase.from('gaco_socis_compte_corrent').insert({
          soci_id: sociId,
          data,
          concepte,
          tipus_moviment: tipus,
          import: arrodonir2(importAbs * Number(sel.value)),
        });
        if (error) return alert('Error desant l\'apunt: ' + error.message);
        closeModal();
        render();
      });
    },
  });
}

// --- Quadre amb la gestoria (551/555) ------------------------------------------

function obrirQuadre(sociId) {
  const soci = socisCache.find((s) => s.id === sociId);
  const apunts = apuntsPerSoci[sociId] ?? [];

  openModal({
    title: `Quadre amb la gestoria — ${soci?.nom ?? ''}`,
    wide: true,
    bodyHtml: `
      <div class="modal-section">
        <label>Data del saldo de la gestoria <input type="date" id="q-data" value="${anyVista}-12-31" /></label>
        <label>Saldo de la gestoria (€) <input type="number" step="0.01" min="0" id="q-import" /></label>
        <label>
          <select id="q-dir">
            <option value="-1">La persona deu a la SL (saldo deutor)</option>
            <option value="1">La SL deu a la persona (saldo creditor)</option>
          </select>
        </label>
        <div id="q-resultat" style="margin-top:8px;"></div>
      </div>
    `,
    onMount: (body) => {
      const calc = () => {
        const data = body.querySelector('#q-data').value;
        const imp = parseFloat(body.querySelector('#q-import').value);
        const el = body.querySelector('#q-resultat');
        if (!data || Number.isNaN(imp)) {
          el.innerHTML = '';
          return;
        }
        const gestoria = arrodonir2(imp * Number(body.querySelector('#q-dir').value));
        const app = arrodonir2(apunts.filter((a) => a.data <= data).reduce((t, a) => t + Number(a.import), 0));
        const dif = arrodonir2(gestoria - app);
        el.innerHTML = `
          <p>Gestoria a ${formatData(data)}: ${htmlSaldo(gestoria, soci?.nom ?? '')}</p>
          <p>GACO a ${formatData(data)}: ${htmlSaldo(app, soci?.nom ?? '')}</p>
          <p>${Math.abs(dif) < 0.005 ? '✔ Quadra.' : `<strong style="color:#b00020;">⚠ Diferència ${formatImport(dif)}</strong> (gestoria − GACO)`}</p>`;
      };
      ['#q-data', '#q-import', '#q-dir'].forEach((id) => body.querySelector(id).addEventListener('input', calc));
    },
  });
}

// --- Lligar la persona amb el seu proveïdor ------------------------------------

function obrirLligarProveidor(sociId) {
  const soci = socisCache.find((x) => x.id === sociId);
  openModal({
    title: `Proveïdor lligat — ${soci?.nom ?? ''}`,
    bodyHtml: `
      <p style="font-size:13px;">El proveïdor sota el qual aquesta persona et factura (arrendaments, serveis). Serveix per trobar les seves factures pendents a l'hora de compensar.</p>
      <label>Proveïdor
        <select id="lp-prov">
          <option value="">(cap)</option>
          ${proveidorsCache.map((p) => `<option value="${p.id}" ${soci?.proveidor_id === p.id ? 'selected' : ''}>${esc(p.nom)}</option>`).join('')}
        </select>
      </label>
      <button type="button" id="btn-desar-prov">Desar</button>
    `,
    onMount: (body) => {
      body.querySelector('#btn-desar-prov').addEventListener('click', async () => {
        const { error } = await supabase
          .from('gaco_socis')
          .update({ proveidor_id: body.querySelector('#lp-prov').value || null })
          .eq('id', sociId);
        if (error) return alert('Error desant (has executat schema_socis.sql?): ' + error.message);
        closeModal();
        render();
      });
    },
  });
}

// --- Compensació de factures pendents contra el compte corrent -------------------
// Circuit comptable: durant l'any les factures de la persona queden pendents com a
// proveïdor/creditor; a final d'any es salden contra el seu compte 555/551.
// Per cada factura: pagament (sense banc) + apunt positiu al compte corrent
// (la SL "li paga" la factura amb el que ell ja devia) + recàlcul de la capçalera.

async function obrirCompensar(sociId) {
  const soci = socisCache.find((x) => x.id === sociId);
  if (!soci?.proveidor_id) return alert('Primer cal lligar el proveïdor.');

  const { data: factures, error } = await supabase
    .from('gaco_factures_rebudes')
    .select('id, num_factura, data_factura, total, import_pagat, import_pendent, estat')
    .eq('proveidor_id', soci.proveidor_id)
    .in('estat', ['pendent', 'pagada_parcial'])
    .order('data_factura', { ascending: true });
  if (error) return alert('Error cercant les factures: ' + error.message);

  const pendentDe = (f) => arrodonir2(Number(f.import_pendent ?? (Number(f.total ?? 0) - Number(f.import_pagat ?? 0))));
  const llista = (factures ?? []).map((f) => ({ ...f, pendent: pendentDe(f) })).filter((f) => f.pendent > 0);

  openModal({
    title: `Compensar factures — ${soci.nom}`,
    wide: true,
    bodyHtml: `
      <p style="font-size:13px;">Se salden contra el compte corrent de ${esc(soci.nom)}: el seu saldo millora de l'import marcat i les factures queden pagades.</p>
      <label>Data de la compensació <input type="date" id="cp-data" value="${anyVista}-12-31" /></label>
      <div style="margin-top:8px;">
        ${
          llista
            .map(
              (f) => `<label style="display:block; cursor:pointer; margin-bottom:4px;">
                <input type="checkbox" class="cp-check" value="${f.id}" data-pendent="${f.pendent}" checked />
                ${formatData(f.data_factura)} · ${esc(f.num_factura ?? '(sense número)')} — pendent ${formatImport(f.pendent)}
              </label>`
            )
            .join('') || '<p>Aquest proveïdor no té factures pendents.</p>'
        }
      </div>
      <p id="cp-total" style="font-weight:bold;"></p>
      <button type="button" id="btn-compensar" ${llista.length ? '' : 'disabled'}>Compensar les marcades</button>
    `,
    onMount: (body) => {
      const checks = () => [...body.querySelectorAll('.cp-check')];
      const pintarTotal = () => {
        const t = arrodonir2(checks().filter((c) => c.checked).reduce((a, c) => a + Number(c.dataset.pendent), 0));
        body.querySelector('#cp-total').textContent = `Total a compensar: ${formatImport(t)}`;
      };
      checks().forEach((c) => c.addEventListener('change', pintarTotal));
      pintarTotal();

      body.querySelector('#btn-compensar').addEventListener('click', async () => {
        const data = body.querySelector('#cp-data').value;
        const marcades = checks().filter((c) => c.checked);
        if (!data) return alert('Cal indicar la data.');
        if (!marcades.length) return alert('No hi ha cap factura marcada.');
        body.querySelector('#btn-compensar').disabled = true;

        let fetes = 0;
        for (const c of marcades) {
          const f = llista.find((x) => x.id === c.value);
          const ok = await compensarFactura(soci, f, data);
          if (!ok) {
            alert(`S'ha aturat a la factura ${f.num_factura ?? ''}. Compensades fins ara: ${fetes}.`);
            break;
          }
          fetes++;
        }
        closeModal();
        render();
      });
    },
  });
}

async function compensarFactura(soci, f, data) {
  const { data: pagament, error: errP } = await supabase
    .from('gaco_pagaments_factures_rebudes')
    .insert({
      factura_id: f.id,
      data_pagament: data,
      import: f.pendent,
      tipus_moviment: 'pagament',
      soci_id: soci.id,
      notes: 'Compensació amb compte corrent',
    })
    .select('id')
    .single();
  if (errP) {
    alert('Error registrant el pagament: ' + errP.message);
    return false;
  }

  const { error: errA } = await supabase.from('gaco_socis_compte_corrent').insert({
    soci_id: soci.id,
    data,
    concepte: `Compensació factura ${f.num_factura ?? ''}`.trim(),
    tipus_moviment: 'compensacio_factura',
    import: f.pendent,
    factura_id: f.id,
  });
  if (errA) {
    await supabase.from('gaco_pagaments_factures_rebudes').delete().eq('id', pagament.id);
    alert('Error registrant l\'apunt al compte corrent (has executat schema_socis.sql?): ' + errA.message);
    return false;
  }

  // Recàlcul de la capçalera, com fa Factures rebudes
  const { data: pags } = await supabase.from('gaco_pagaments_factures_rebudes').select('import').eq('factura_id', f.id);
  const pagat = arrodonir2((pags ?? []).reduce((a, p) => a + (Number(p.import) || 0), 0));
  const total = Number(f.total) || 0;
  const pendent = arrodonir2(total - pagat);
  const estat = total > 0 && pendent <= 0 ? 'pagada' : pagat > 0 ? 'pagada_parcial' : 'pendent';
  const { error: errF } = await supabase
    .from('gaco_factures_rebudes')
    .update({ import_pagat: pagat, import_pendent: pendent, estat, forma_pagament: 'compensacio', soci_id: soci.id })
    .eq('id', f.id);
  if (errF) {
    alert('Compensada, però no s\'ha pogut actualitzar la factura: ' + errF.message);
    return false;
  }
  return true;
}
