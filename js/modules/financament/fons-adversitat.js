import { supabase } from '../../lib/supabaseClient.js';
import { openModal, closeModal } from '../../lib/modal.js';

/**
 * Finançament → Fons d'adversitat.
 * Seguiment FORA DE BALANÇ de les retencions al fons d'adversitat de la cooperativa
 * (taula gaco_fons_adversitat: una fila per campanya i fruita). No toca cap informe.
 * Campanya = any de tancament (com a SAO). Retorn previst = campanya + 5 (extrapolació
 * del retorn de la 2021 al juliol del 2026; confirmar el termini amb la cooperativa).
 * Exporta saldoViu() per a la targeta d'Inici.
 */

const ANYS_RETORN = 5;

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fImport = (n) =>
  n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('ca-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const fData = (s) => {
  if (!s) return '—';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

let files = [];

async function llegir() {
  const { data, error } = await supabase
    .from('gaco_fons_adversitat')
    .select('*')
    .order('campanya', { ascending: false })
    .order('fruita');
  if (error) throw error;
  return data ?? [];
}

// Per a la targeta d'Inici: { viu, retornat, perCampanya } o null si falla
export async function saldoViu() {
  const dades = await llegir();
  const viu = dades.filter((d) => d.estat === 'viu');
  const perCampanya = new Map();
  for (const d of viu) perCampanya.set(d.campanya, r2((perCampanya.get(d.campanya) ?? 0) + Number(d.import_retingut)));
  return {
    viu: r2(viu.reduce((s, d) => s + Number(d.import_retingut), 0)),
    retornat: r2(dades.filter((d) => d.estat === 'retornat').reduce((s, d) => s + Number(d.import_retornat ?? d.import_retingut), 0)),
    perCampanya: [...perCampanya.entries()].sort(),
  };
}

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant...</p>';
  try {
    files = await llegir();
  } catch (err) {
    contenidor.innerHTML = `<div class="card"><p class="error">No s'ha pogut llegir el fons d'adversitat: ${esc(err.message)}. Has executat l'SQL de la taula i de la RLS?</p></div>`;
    return;
  }
  pintar();
}

function pintar() {
  const contenidor = document.getElementById('app-content');
  const viu = files.filter((f) => f.estat === 'viu');
  const retornat = files.filter((f) => f.estat === 'retornat');
  const totViu = r2(viu.reduce((s, f) => s + Number(f.import_retingut), 0));
  const totRet = r2(retornat.reduce((s, f) => s + Number(f.import_retornat ?? f.import_retingut), 0));

  // Agrupa per campanya (ja ve ordenat de més recent a més antiga)
  const campanyes = new Map();
  for (const f of files) {
    if (!campanyes.has(f.campanya)) campanyes.set(f.campanya, []);
    campanyes.get(f.campanya).push(f);
  }

  const cos = [...campanyes.entries()]
    .map(([camp, fs]) => {
      const totalCamp = r2(fs.reduce((s, f) => s + Number(f.import_retingut), 0));
      const previst = fs.every((f) => f.estat === 'viu') && /^\d{4}$/.test(camp) ? `retorn previst ${Number(camp) + ANYS_RETORN}` : '';
      return `<tr class="hist-mes"><td colspan="5">Campanya ${esc(camp)} <span style="font-weight:400;">· ${fImport(totalCamp)}${previst ? ' · ' + previst : ''}</span></td></tr>
        ${fs
          .map(
            (f) => `<tr>
              <td>${esc(f.fruita)}</td>
              <td class="dr">${fImport(f.import_retingut)}</td>
              <td>${f.estat === 'viu' ? 'Viu' : `Retornat ${fData(f.data_retorn)} · ${fImport(f.import_retornat)}`}</td>
              <td>${esc(f.document_origen ?? '')}${f.notes ? `<div class="inici-sub">${esc(f.notes)}</div>` : ''}</td>
              <td><button type="button" data-editar="${f.id}">Editar</button></td>
            </tr>`
          )
          .join('')}`;
    })
    .join('');

  contenidor.innerHTML = `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <div>
          <p class="inici-etiq">Fons d'adversitat viu</p>
          <p class="inici-gran">${fImport(totViu)}</p>
          <p class="inici-sub">Retornat fins ara: ${fImport(totRet)}</p>
        </div>
        <button type="button" id="btn-nova-fons" style="background:var(--gaco-accent); color:#fff; border:none; border-radius:var(--gaco-radius); padding:8px 14px; cursor:pointer;">+ Nova fila</button>
      </div>
      <p class="inici-sub">Seguiment fora de balanç: no entra a Informes ni a Tresoreria. Les liquidacions porten la retenció al full de detall; la factura només mostra el net.
      Campanya = any de tancament, com a SAO. El retorn previst és una extrapolació (retorn de la 2021 al juliol del 2026): confirma el termini amb la cooperativa.</p>
    </div>
    <div class="hist-taula-wrap"><table class="hist-taula">
      <thead><tr><th>Fruita</th><th class="dr">Retingut</th><th>Estat</th><th>Document / notes</th><th></th></tr></thead>
      <tbody>${cos || '<tr><td colspan="5">Cap fila encara.</td></tr>'}</tbody>
    </table></div>
  `;

  contenidor.querySelector('#btn-nova-fons').addEventListener('click', () => formulari(null));
  contenidor.querySelectorAll('[data-editar]').forEach((b) =>
    b.addEventListener('click', () => formulari(files.find((x) => x.id === b.dataset.editar)))
  );
}

function formulari(f) {
  const e = f ?? {};
  const val = (x) => (x === null || x === undefined ? '' : esc(x));
  openModal({
    title: e.id ? `Fons d'adversitat — ${e.campanya} · ${e.fruita}` : 'Nova fila del fons d\'adversitat',
    bodyHtml: `
      <div class="modal-section">
        <label>Campanya (any de tancament) <input type="text" id="fa-campanya" value="${val(e.campanya)}" placeholder="p. ex. 2025" style="width:100px;" /></label>
        <label>Fruita <input type="text" id="fa-fruita" value="${val(e.fruita)}" placeholder="albercoc, nectarina, préssec pla..." /></label>
        <label>Import retingut (€) <input type="number" step="0.01" id="fa-import" value="${val(e.import_retingut)}" /></label>
        <label>Document d'origen <input type="text" id="fa-document" value="${val(e.document_origen)}" style="width:100%;" /></label>
      </div>
      <div class="modal-section">
        <label>Estat
          <select id="fa-estat">
            <option value="viu" ${e.estat !== 'retornat' ? 'selected' : ''}>Viu</option>
            <option value="retornat" ${e.estat === 'retornat' ? 'selected' : ''}>Retornat</option>
          </select>
        </label>
        <label>Data del retorn <input type="date" id="fa-data-retorn" value="${val(e.data_retorn)}" /></label>
        <label>Import retornat (€) <input type="number" step="0.01" id="fa-import-retornat" value="${val(e.import_retornat)}" /></label>
        <label>Notes <textarea id="fa-notes" style="width:100%; min-height:50px;">${val(e.notes)}</textarea></label>
      </div>
      <button type="button" id="btn-desar-fa">${e.id ? 'Desar canvis' : 'Desar'}</button>
      ${e.id ? '<button type="button" id="btn-esborrar-fa" style="margin-left:8px; color:#b00020;">Esborrar</button>' : ''}
    `,
    onMount: (body) => {
      const g = (id) => body.querySelector(id).value;
      const num = (id) => (g(id) === '' ? null : parseFloat(g(id)));

      body.querySelector('#btn-desar-fa').addEventListener('click', async () => {
        const campanya = g('#fa-campanya').trim();
        const fruita = g('#fa-fruita').trim();
        const imp = num('#fa-import');
        const estat = g('#fa-estat');
        if (!campanya || !fruita) return alert('Cal indicar la campanya i la fruita.');
        if (imp === null || imp < 0) return alert("Cal indicar l'import retingut.");
        if (estat === 'retornat' && (!g('#fa-data-retorn') || num('#fa-import-retornat') === null)) {
          return alert('Un fons retornat necessita data i import del retorn.');
        }
        const registre = {
          campanya,
          fruita,
          import_retingut: imp,
          document_origen: g('#fa-document').trim() || null,
          estat,
          data_retorn: estat === 'retornat' ? g('#fa-data-retorn') : null,
          import_retornat: estat === 'retornat' ? num('#fa-import-retornat') : null,
          notes: g('#fa-notes').trim() || null,
        };
        const q = e.id
          ? supabase.from('gaco_fons_adversitat').update(registre).eq('id', e.id)
          : supabase.from('gaco_fons_adversitat').insert(registre);
        const { error } = await q;
        if (error) return alert('Error desant: ' + error.message);
        closeModal();
        await render();
      });

      body.querySelector('#btn-esborrar-fa')?.addEventListener('click', async () => {
        if (!confirm('Esborrar aquesta fila del seguiment?')) return;
        const { error } = await supabase.from('gaco_fons_adversitat').delete().eq('id', e.id);
        if (error) return alert('Error esborrant: ' + error.message);
        closeModal();
        await render();
      });
    },
  });
}