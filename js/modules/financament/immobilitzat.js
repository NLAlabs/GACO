import { supabase } from '../../lib/supabaseClient.js';
import { openModal, closeModal } from '../../lib/modal.js';

/**
 * Finançament → Immobilitzat.
 * Registre d'elements d'immobilitzat material (gaco_immobilitzat) i quadre d'amortització per
 * exercici (vista gaco_immobilitzat_amortitzacio, lineal, prorrata per dies, des del 2026).
 * Els saldos d'obertura (amortitzat acumulat a 31/12/2025) vénen de la gestoria; si es deixen
 * en blanc, la vista calcula l'acumulat teòric des de la data d'alta.
 * El quadre per compte comptable serveix per quadrar amb el major de la gestoria.
 */

const ACTIVITATS = { fruita_cereal: 'Fruita / cereal', serveis: 'Serveis', comuna: 'Comuna' };
const PRIMER_ANY = 2026; // la vista només té exercicis des d'aquí

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fImport = (n) =>
  n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('ca-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const fData = (s) => {
  if (!s) return '—';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

let anyVista = Math.max(new Date().getFullYear(), PRIMER_ANY);
let elements = [];
let quotes = [];
let errorVista = null;

async function carregarDades() {
  const { data: els, error } = await supabase
    .from('gaco_immobilitzat')
    .select('*')
    .order('compte_comptable', { ascending: true })
    .order('nom', { ascending: true });
  if (error) throw error;
  elements = els ?? [];

  const { data: q, error: errQ } = await supabase.from('gaco_immobilitzat_amortitzacio').select('*');
  errorVista = errQ ? errQ.message : null;
  quotes = q ?? [];
}

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant...</p>';
  try {
    await carregarDades();
  } catch (err) {
    contenidor.innerHTML = `<p class="error">Error carregant l'immobilitzat: ${esc(err.message)}</p>`;
    return;
  }
  pintar();
}

function anysDisponibles() {
  const fins = Math.max(new Date().getFullYear(), PRIMER_ANY);
  const anys = [];
  for (let a = fins; a >= PRIMER_ANY; a--) anys.push(a);
  return anys;
}

function taulaQuadre(files) {
  const tot = {
    cost: r2(files.reduce((s, f) => s + Number(f.cost_adquisicio), 0)),
    quota: r2(files.reduce((s, f) => s + Number(f.quota), 0)),
    acum: r2(files.reduce((s, f) => s + Number(f.amortitzat_acumulat), 0)),
    net: r2(files.reduce((s, f) => s + Number(f.valor_net), 0)),
  };
  return `<div class="hist-taula-wrap"><table class="hist-taula">
    <thead><tr><th>Element</th><th>Compte</th><th class="dr">Cost</th><th class="dr">Quota ${anyVista}</th><th class="dr">Amortitzat acumulat</th><th class="dr">Valor net</th></tr></thead>
    <tbody>
      ${files
        .map(
          (f) => `<tr><td>${esc(f.nom)}</td><td>${esc(f.compte_comptable ?? '—')}</td>
            <td class="dr">${fImport(f.cost_adquisicio)}</td><td class="dr"><strong>${fImport(f.quota)}</strong></td>
            <td class="dr">${fImport(f.amortitzat_acumulat)}</td><td class="dr">${fImport(f.valor_net)}</td></tr>`
        )
        .join('')}
      <tr class="inf-total"><td colspan="2">Total</td><td class="dr">${fImport(tot.cost)}</td><td class="dr">${fImport(tot.quota)}</td><td class="dr">${fImport(tot.acum)}</td><td class="dr">${fImport(tot.net)}</td></tr>
    </tbody></table></div>`;
}

function taulaPerCompte(files) {
  const grups = new Map();
  for (const f of files) {
    const k = f.compte_comptable || '(sense compte)';
    const g = grups.get(k) ?? { cost: 0, quota: 0, acum: 0, net: 0 };
    g.cost += Number(f.cost_adquisicio);
    g.quota += Number(f.quota);
    g.acum += Number(f.amortitzat_acumulat);
    g.net += Number(f.valor_net);
    grups.set(k, g);
  }
  return `<div class="hist-taula-wrap"><table class="hist-taula">
    <thead><tr><th>Compte comptable</th><th class="dr">Cost</th><th class="dr">Quota ${anyVista}</th><th class="dr">Amort. acumulada a 31/12/${anyVista}</th></tr></thead>
    <tbody>${[...grups.entries()]
      .sort()
      .map(([k, g]) => `<tr><td>${esc(k)}</td><td class="dr">${fImport(r2(g.cost))}</td><td class="dr">${fImport(r2(g.quota))}</td><td class="dr">${fImport(r2(g.acum))}</td></tr>`)
      .join('')}</tbody></table></div>`;
}

function htmlElement(e) {
  const avisos = [];
  if (!(Number(e.vida_util_anys) > 0)) avisos.push('⚠ Sense vida útil: no genera amortització');
  if (e.data_baixa) avisos.push(`Baixa el ${fData(e.data_baixa)}${e.import_baixa !== null ? ' · ' + fImport(e.import_baixa) : ''}`);
  if (!e.actiu) avisos.push('Inactiu');
  return `<div style="border-top:0.5px solid var(--gaco-border); padding:10px 0; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
    <div>
      <p style="margin:0; font-weight:500;">${esc(e.nom)}</p>
      <p style="margin:2px 0 0; font-size:12px; color:var(--gaco-text-secondary);">
        ${esc(e.compte_comptable ?? 'sense compte')} · Alta ${fData(e.data_alta)} · Cost ${fImport(e.cost_adquisicio)} · Residual ${fImport(e.valor_residual)}
        · Vida ${e.vida_util_anys ?? '—'} anys · Acumulat 31/12/2025: ${e.amortitzat_acumulat_31122025 === null || e.amortitzat_acumulat_31122025 === undefined ? 'calculat per GACO' : fImport(e.amortitzat_acumulat_31122025)}
        ${e.activitat ? ' · ' + (ACTIVITATS[e.activitat] ?? e.activitat) : ''}${e.maquinaria_sao_ref ? ' · SAO: ' + esc(e.maquinaria_sao_ref) : ''}
      </p>
      ${avisos.length ? `<p style="margin:2px 0 0; font-size:12px; color:#8a5200;">${avisos.map(esc).join(' · ')}</p>` : ''}
    </div>
    <button type="button" data-editar="${e.id}">Veure/Editar</button>
  </div>`;
}

function pintar() {
  const contenidor = document.getElementById('app-content');
  const filesAny = quotes.filter((q) => Number(q.exercici) === anyVista).sort((a, b) => String(a.compte_comptable ?? '').localeCompare(String(b.compte_comptable ?? '')) || a.nom.localeCompare(b.nom));

  contenidor.innerHTML = `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <label>Exercici <select id="im-any">${anysDisponibles().map((a) => `<option value="${a}" ${a === anyVista ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
        <button type="button" id="btn-nou-element" style="background:var(--gaco-accent); color:#fff; border:none; border-radius:var(--gaco-radius); padding:8px 14px; cursor:pointer;">+ Nou element</button>
      </div>
      <p style="font-size:13px; color:var(--gaco-text-secondary);">
        Amortització lineal, proporcional als dies en ús el primer any. És un seguiment: l'oficial és el quadre de la gestoria.
        Els elements de 300 € o menys van com a despesa (llibertat d'amortització), no aquí.
      </p>
    </div>
    ${errorVista ? `<div class="card"><p class="error">No s'ha pogut llegir el quadre d'amortització (has executat l'SQL de la vista gaco_immobilitzat_amortitzacio?): ${esc(errorVista)}</p></div>` : ''}
    <h3>Quadre d'amortització ${anyVista}</h3>
    ${filesAny.length ? taulaQuadre(filesAny) : '<div class="card"><p>Cap element amortitzable en aquest exercici.</p></div>'}
    ${filesAny.length ? `<h3>Per compte comptable</h3>${taulaPerCompte(filesAny)}<p class="inf-nota">Compara'l amb el major de la gestoria (compte 281xxxx a 31/12/${anyVista}).</p>` : ''}
    <h3>Elements (${elements.length})</h3>
    <div class="card">${elements.map(htmlElement).join('') || '<p>Cap element registrat.</p>'}</div>
  `;

  contenidor.querySelector('#im-any').addEventListener('change', (e) => {
    anyVista = Number(e.target.value);
    pintar();
  });
  contenidor.querySelector('#btn-nou-element').addEventListener('click', () => obrirFormulari(null));
  contenidor.querySelectorAll('[data-editar]').forEach((b) =>
    b.addEventListener('click', () => obrirFormulari(elements.find((x) => x.id === b.dataset.editar)))
  );
}

async function obrirFormulari(v) {
  const e = v ?? {};
  const val = (x) => (x === null || x === undefined ? '' : esc(x));

  // Factures rebudes recents, per lligar l'element a la factura de compra
  const { data: factures } = await supabase
    .from('gaco_factures_rebudes')
    .select('id, num_factura, data_factura, total, contrapart_nom, proveidor:gaco_proveidors(nom)')
    .order('data_factura', { ascending: false })
    .limit(200);

  openModal({
    title: e.id ? `Element — ${e.nom}` : 'Nou element d\'immobilitzat',
    wide: true,
    bodyHtml: `
      <div class="modal-section">
        <label>Nom <input type="text" id="im-nom" value="${val(e.nom)}" style="width:100%;" /></label>
        <label>Categoria <input type="text" id="im-categoria" value="${val(e.categoria)}" placeholder="p. ex. instal·lacions, tractor, eines" /></label>
        <label>Compte comptable (el de la gestoria) <input type="text" id="im-compte" value="${val(e.compte_comptable)}" placeholder="p. ex. 2150001" style="width:140px;" /></label>
        <label>Activitat
          <select id="im-activitat">
            <option value="">(cap)</option>
            ${Object.entries(ACTIVITATS).map(([k, t]) => `<option value="${k}" ${e.activitat === k ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="modal-section">
        <label>Data d'alta (posada en funcionament) <input type="date" id="im-alta" value="${val(e.data_alta)}" /></label>
        <label>Cost d'adquisició (€) <input type="number" step="0.01" id="im-cost" value="${val(e.cost_adquisicio)}" /></label>
        <label>Valor residual (€) <input type="number" step="0.01" id="im-residual" value="${e.valor_residual ?? 0}" /></label>
        <label>Vida útil (anys) <input type="number" step="0.01" id="im-vida" value="${val(e.vida_util_anys)}" style="width:100px;" /></label>
        <label>Amortitzat acumulat a 31/12/2025 (€) — de la gestoria; buit = el calcula GACO des de la data d'alta
          <input type="number" step="0.01" id="im-obertura" value="${val(e.amortitzat_acumulat_31122025)}" /></label>
      </div>
      <div class="modal-section">
        <label>Factura de compra (opcional)
          <select id="im-factura">
            <option value="">(cap)</option>
            ${(factures ?? [])
              .map((f) => `<option value="${f.id}" ${e.factura_compra_id === f.id ? 'selected' : ''}>${esc(f.proveidor?.nom ?? f.contrapart_nom ?? '—')} ${esc(f.num_factura ?? '')} · ${fData(f.data_factura)} · ${fImport(f.total)}</option>`)
              .join('')}
          </select>
        </label>
        <label>Referència a SAO (maquinària) <input type="text" id="im-sao" value="${val(e.maquinaria_sao_ref)}" /></label>
        <label>Notes <textarea id="im-notes" style="width:100%; min-height:50px;">${val(e.notes)}</textarea></label>
      </div>
      <div class="modal-section">
        <p class="modal-section-title">Baixa (opcional)</p>
        <label>Data de baixa <input type="date" id="im-baixa" value="${val(e.data_baixa)}" /></label>
        <label>Import de la baixa (€, si es ven) <input type="number" step="0.01" id="im-import-baixa" value="${val(e.import_baixa)}" /></label>
        <label><input type="checkbox" id="im-actiu" ${e.id && !e.actiu ? '' : 'checked'} /> Actiu</label>
      </div>
      <button type="button" id="btn-desar-element">${e.id ? 'Desar canvis' : 'Desar'}</button>
      ${e.id ? '<button type="button" id="btn-esborrar-element" style="margin-left:8px; color:#b00020;">Esborrar</button>' : ''}
    `,
    onMount: (body) => {
      const g = (id) => body.querySelector(id).value;
      const num = (id) => (g(id) === '' ? null : parseFloat(g(id)));

      body.querySelector('#btn-desar-element').addEventListener('click', async () => {
        const nom = g('#im-nom').trim();
        const cost = num('#im-cost');
        if (!nom) return alert('Cal indicar el nom.');
        if (!g('#im-alta')) return alert("Cal indicar la data d'alta.");
        if (cost === null || cost < 0) return alert("Cal indicar el cost d'adquisició.");
        const residual = num('#im-residual') ?? 0;
        if (residual > cost) return alert('El valor residual no pot ser superior al cost.');
        const vida = num('#im-vida');
        if (!(vida > 0) && !confirm("Sense vida útil l'element no genera amortització. Desar igualment?")) return;
        if (g('#im-baixa') && g('#im-baixa') < g('#im-alta')) return alert("La data de baixa no pot ser anterior a l'alta.");

        const registre = {
          nom,
          categoria: g('#im-categoria').trim() || null,
          compte_comptable: g('#im-compte').trim() || null,
          activitat: g('#im-activitat') || null,
          data_alta: g('#im-alta'),
          cost_adquisicio: cost,
          valor_residual: residual,
          vida_util_anys: vida,
          metode_amortitzacio: 'lineal',
          amortitzat_acumulat_31122025: num('#im-obertura'),
          factura_compra_id: g('#im-factura') || null,
          maquinaria_sao_ref: g('#im-sao').trim() || null,
          notes: g('#im-notes').trim() || null,
          data_baixa: g('#im-baixa') || null,
          import_baixa: num('#im-import-baixa'),
          actiu: body.querySelector('#im-actiu').checked,
        };
        const q = e.id ? supabase.from('gaco_immobilitzat').update(registre).eq('id', e.id) : supabase.from('gaco_immobilitzat').insert(registre);
        const { error } = await q;
        if (error) return alert('Error desant: ' + error.message);
        closeModal();
        await render();
      });

      body.querySelector('#btn-esborrar-element')?.addEventListener('click', async () => {
        if (!confirm('Esborrar aquest element del registre? (No esborra cap factura.)')) return;
        const { error } = await supabase.from('gaco_immobilitzat').delete().eq('id', e.id);
        if (error) return alert('Error esborrant (potser té línies de factura lligades): ' + error.message);
        closeModal();
        await render();
      });
    },
  });
}