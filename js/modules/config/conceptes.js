import { supabase } from '../../lib/supabaseClient.js';

/**
 * Configuració i gestió → Conceptes.
 * Dues vies d'alta: formulari ràpid (un concepte puntual) i importació
 * massiva enganxant CSV (per als ~73 conceptes ja treballats per Josep,
 * veure document conceptual original, secció 3).
 *
 * Format CSV esperat, un concepte per línia, separat per punt i coma:
 *   grup;nom;codi;classificacio;tipus
 * codi i classificacio poden anar buits. tipus ha de ser
 * despesa|ingres|actiu (per defecte 'despesa' si es deixa buit).
 *
 * "Eliminar" = actiu=false (mateix criteri que la resta de mestres).
 */

const TIPUS_CONCEPTE = ['despesa', 'ingres', 'actiu', 'suplits'];

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant conceptes...</p>';

  const { data: conceptes, error } = await supabase
    .from('gaco_conceptes_comptables')
    .select('id, grup, nom, codi, classificacio, tipus, actiu')
    .order('grup')
    .order('nom');

  if (error) {
    contenidor.innerHTML = `<p class="error">Error carregant conceptes: ${error.message}</p>`;
    return;
  }

  // Agrupar per `grup` per fer la llista llegible amb 73 files
  const grups = {};
  for (const c of conceptes) {
    (grups[c.grup ?? '(sense grup)'] ??= []).push(c);
  }

  contenidor.innerHTML = `
    <div class="card">
      <p style="font-weight:500; margin-bottom:12px;">Nou concepte</p>
      <form id="form-concepte" style="display:flex; gap:8px; flex-wrap:wrap;">
        <input type="text" id="c-grup" placeholder="Grup (p.ex. CARBURANTS)" required style="flex:1; min-width:160px;" />
        <input type="text" id="c-nom" placeholder="Nom (p.ex. CARBURANTS - AdBlue)" required style="flex:1; min-width:200px;" />
        <input type="text" id="c-codi" placeholder="Codi PGC (opcional)" style="width:120px;" />
        <select id="c-tipus" style="width:130px;">
          ${TIPUS_CONCEPTE.map((t) => `<option value="${t}">${t}</option>`).join('')}
        </select>
        <input type="text" id="c-classificacio" placeholder="Classificació ampliada (opcional)" style="flex:2; min-width:220px;" />
        <button type="submit">Afegir concepte</button>
      </form>
    </div>

    <div class="card">
      <p style="font-weight:500; margin-bottom:12px;">Importació massiva (CSV)</p>
      <p style="font-size:13px; color:var(--gaco-text-secondary); margin-bottom:8px;">
        Una línia per concepte, camps separats per punt i coma: <code>grup;nom;codi;classificacio;tipus</code>.
        Codi i classificació poden anar buits. Si tipus es deixa buit, s'assigna "despesa".
      </p>
      <textarea id="csv-conceptes" placeholder="CARBURANTS;CARBURANTS - AdBlue;;;despesa
SOUS I SALARIS;SOUS I SALARIS-Geni;;;despesa" style="width:100%; min-height:100px; font-family:monospace; font-size:12px;"></textarea>
      <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
        <button type="button" id="btn-previsualitzar">Previsualitzar</button>
        <span id="resultat-import" style="font-size:13px;"></span>
      </div>
      <div id="previsualitzacio"></div>
    </div>

    <div class="card">
      <p style="font-weight:500; margin-bottom:12px;">Conceptes (${conceptes.length})</p>
      ${Object.entries(grups)
        .map(
          ([grup, items]) => `
        <div style="margin-bottom:12px;">
          <p style="font-size:12px; font-weight:600; color:var(--gaco-text-secondary); text-transform:uppercase; margin:12px 0 4px;">${grup}</p>
          ${items
            .map(
              (c) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-top:0.5px solid var(--gaco-border);">
              <span style="${c.actiu ? '' : 'color:var(--gaco-text-secondary); text-decoration:line-through;'}">${c.nom} <span style="font-size:11px; color:var(--gaco-text-secondary);">(${c.tipus})</span></span>
              <button data-toggle-concepte="${c.id}" data-actiu="${c.actiu}">${c.actiu ? 'Desactivar' : 'Reactivar'}</button>
            </div>
          `
            )
            .join('')}
        </div>
      `
        )
        .join('')}
    </div>
  `;

  document.getElementById('form-concepte').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nou = {
      grup: document.getElementById('c-grup').value.trim(),
      nom: document.getElementById('c-nom').value.trim(),
      codi: document.getElementById('c-codi').value.trim() || null,
      tipus: document.getElementById('c-tipus').value,
      classificacio: document.getElementById('c-classificacio').value.trim() || null,
      actiu: true,
    };
    if (!nou.grup || !nou.nom) return;

    const { error } = await supabase.from('gaco_conceptes_comptables').insert(nou);
    if (error) return alert(`Error afegint concepte: ${error.message}`);
    render();
  });

  document.querySelectorAll('[data-toggle-concepte]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.toggleConcepte;
      const actiuActual = btn.dataset.actiu === 'true';
      const { error } = await supabase.from('gaco_conceptes_comptables').update({ actiu: !actiuActual }).eq('id', id);
      if (error) return alert(`Error: ${error.message}`);
      render();
    });
  });

  document.getElementById('btn-previsualitzar').addEventListener('click', () => {
    const text = document.getElementById('csv-conceptes').value.trim();
    if (!text) return;

    const files = parsejarCsv(text);
    const valides = files.filter((f) => f.error === null);
    const invalides = files.filter((f) => f.error !== null);

    document.getElementById('resultat-import').textContent =
      `${valides.length} línies vàlides, ${invalides.length} amb error.`;

    const previ = document.getElementById('previsualitzacio');
    previ.innerHTML = `
      ${invalides.length > 0 ? `<p style="color:var(--gaco-danger); font-size:13px; margin-top:8px;">Errors:</p>
        ${invalides.map((f) => `<p style="font-size:12px; color:var(--gaco-danger); margin:2px 0;">Línia ${f.linia}: ${f.error} — "${f.original}"</p>`).join('')}` : ''}
      ${valides.length > 0 ? `<button id="btn-confirmar-import" style="margin-top:8px;">Confirmar i importar ${valides.length} conceptes</button>` : ''}
    `;

    if (valides.length > 0) {
      document.getElementById('btn-confirmar-import').addEventListener('click', async () => {
        const files_insert = valides.map((f) => ({
          grup: f.grup, nom: f.nom, codi: f.codi, classificacio: f.classificacio, tipus: f.tipus, actiu: true,
        }));
        const { error } = await supabase.from('gaco_conceptes_comptables').insert(files_insert);
        if (error) return alert(`Error important: ${error.message}`);
        render();
      });
    }
  });
}

function parsejarCsv(text) {
  return text
    .split('\n')
    .map((linia, i) => {
      const original = linia;
      linia = linia.trim().replace(/\r$/, '');
      if (!linia) return { linia: i + 1, error: 'línia buida', original, ometre: true };

      const camps = linia.split(';').map((c) => c.trim());

      // Capçalera real: "Id;GRUPCATEGORIA;NomCategoria;ComtpeComptable;Classificació Despesa;Tipus Categoria"
      // — es detecta i s'omet sense comptar com a error.
      if (camps[1]?.toUpperCase() === 'GRUPCATEGORIA' || camps[0]?.toUpperCase() === 'GRUPCATEGORIA') {
        return { linia: i + 1, error: null, original, ometre: true };
      }

      let grup, nom, codi, classificacio, tipusRaw;
      if (camps.length >= 6) {
        // Format real amb Id inicial: Id;grup;nom;codi;classificacio;tipus
        [, grup, nom, codi, classificacio, tipusRaw] = camps;
      } else if (camps.length === 5) {
        // Format simple sense Id: grup;nom;codi;classificacio;tipus
        [grup, nom, codi, classificacio, tipusRaw] = camps;
      } else {
        return { linia: i + 1, error: `nombre de camps inesperat (${camps.length})`, original };
      }

      if (!grup) return { linia: i + 1, error: 'falta el grup', original };
      if (!nom) return { linia: i + 1, error: 'falta el nom', original };

      const tipus = (tipusRaw || 'despesa').toLowerCase();
      if (!TIPUS_CONCEPTE.includes(tipus)) {
        return { linia: i + 1, error: `tipus "${tipusRaw}" no vàlid (ha de ser despesa|ingres|actiu|suplits)`, original };
      }

      return { linia: i + 1, error: null, grup, nom, codi: codi || null, classificacio: classificacio || null, tipus };
    })
    .filter((f) => !f.ometre);
}