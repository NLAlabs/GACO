import { supabase } from '../../lib/supabaseClient.js';

/**
 * Configuració i gestió → Comptes bancaris.
 * "Eliminar" = actiu=false (desactivar), MAI un DELETE real — altres
 * taules (moviments N43, préstecs, factures, pòlisses) referencien
 * gaco_comptes.id, i esborrar-lo de veritat trencaria l'historial o
 * fallaria per restricció de clau forana. Un compte desactivat
 * desapareix de les llistes operatives (Moviments → Comptes) però es
 * manté íntegre per a tot el que ja hi apunta.
 */
export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant...</p>';

  const [{ data: entitats, error: errEntitats }, { data: comptes, error: errComptes }] = await Promise.all([
    supabase.from('gaco_entitats_bancaries').select('id, nom, actiu').order('nom'),
    supabase
      .from('gaco_comptes')
      .select('id, tipus, num_compte, descripcio, actiu, entitat_id, compte_polissa_vinculat_id, compte_liquidacio_id')
      .order('created_at'),
  ]);

  if (errEntitats || errComptes) {
    contenidor.innerHTML = `<p class="error">Error carregant dades: ${(errEntitats || errComptes).message}</p>`;
    return;
  }

  contenidor.innerHTML = `
    <div class="card">
      <p style="font-weight:500; margin-bottom:12px;">Entitats bancàries</p>
      <form id="form-entitat" style="display:flex; gap:8px; margin-bottom:12px;">
        <input type="text" id="entitat-nom" placeholder="Nom de l'entitat (p.ex. Banc A)" required style="flex:1;" />
        <button type="submit">Afegir entitat</button>
      </form>
      ${entitats
        .map(
          (e) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-top:0.5px solid var(--gaco-border);">
          <span style="${e.actiu ? '' : 'color:var(--gaco-text-secondary); text-decoration:line-through;'}">${e.nom}</span>
          <button data-toggle-entitat="${e.id}" data-actiu="${e.actiu}">${e.actiu ? 'Desactivar' : 'Reactivar'}</button>
        </div>
      `
        )
        .join('')}
    </div>

    <div class="card">
      <p style="font-weight:500; margin-bottom:12px;">Comptes</p>
      <form id="form-compte" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">
        <select id="compte-entitat" required>
          <option value="">Entitat...</option>
          ${entitats.filter((e) => e.actiu).map((e) => `<option value="${e.id}">${e.nom}</option>`).join('')}
        </select>
        <select id="compte-tipus" required>
          <option value="corrent">Compte corrent</option>
          <option value="credit">Pòlissa de crèdit</option>
          <option value="estalvi">Estalvi</option>
          <option value="targeta_debit">Targeta de dèbit</option>
          <option value="targeta_credit">Targeta de crèdit</option>
        </select>
        <input type="text" id="compte-num" placeholder="Número de compte / IBAN" required style="min-width:220px;" />
        <input type="text" id="compte-desc" placeholder="Descripció (opcional)" />
        <button type="submit">Afegir compte</button>
      </form>

      ${comptes
        .map((c) => {
          const entitat = entitats.find((e) => e.id === c.entitat_id);
          return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-top:0.5px solid var(--gaco-border);">
          <div style="${c.actiu ? '' : 'color:var(--gaco-text-secondary); text-decoration:line-through;'}">
            <p style="margin:0;">${c.descripcio || c.tipus} — ${entitat?.nom ?? '(entitat desconeguda)'}</p>
            <p style="margin:2px 0 0; font-size:12px; color:var(--gaco-text-secondary);">${c.num_compte}</p>
          </div>
          <div style="display:flex; gap:6px;">
            <button data-edit-compte="${c.id}">Editar</button>
            <button data-toggle-compte="${c.id}" data-actiu="${c.actiu}">${c.actiu ? 'Desactivar' : 'Reactivar'}</button>
          </div>
        </div>
        <div id="edit-compte-${c.id}" hidden style="padding:10px 0; border-top:0.5px dashed var(--gaco-border);"></div>
      `;
        })
        .join('')}
    </div>
  `;

  // ---- Entitats: alta ----
  document.getElementById('form-entitat').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nom = document.getElementById('entitat-nom').value.trim();
    if (!nom) return;
    const { error } = await supabase.from('gaco_entitats_bancaries').insert({ nom, actiu: true });
    if (error) return alert(`Error afegint entitat: ${error.message}`);
    render();
  });

  // ---- Entitats: activar/desactivar ----
  document.querySelectorAll('[data-toggle-entitat]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.toggleEntitat;
      const actiuActual = btn.dataset.actiu === 'true';
      const { error } = await supabase.from('gaco_entitats_bancaries').update({ actiu: !actiuActual }).eq('id', id);
      if (error) return alert(`Error: ${error.message}`);
      render();
    });
  });

  // ---- Comptes: alta ----
  document.getElementById('form-compte').addEventListener('submit', async (e) => {
    e.preventDefault();
    const entitat_id = document.getElementById('compte-entitat').value;
    const tipus = document.getElementById('compte-tipus').value;
    const num_compte = document.getElementById('compte-num').value.trim();
    const descripcio = document.getElementById('compte-desc').value.trim() || null;
    if (!entitat_id || !num_compte) return;

    const { error } = await supabase.from('gaco_comptes').insert({ entitat_id, tipus, num_compte, descripcio, actiu: true });
    if (error) return alert(`Error afegint compte: ${error.message}`);
    render();
  });

  // ---- Comptes: activar/desactivar ----
  document.querySelectorAll('[data-toggle-compte]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.toggleCompte;
      const actiuActual = btn.dataset.actiu === 'true';
      const missatge = actiuActual
        ? 'Desactivar aquest compte? No s\'esborra res, només deixa de sortir a les llistes operatives.'
        : 'Reactivar aquest compte?';
      if (!confirm(missatge)) return;
      const { error } = await supabase.from('gaco_comptes').update({ actiu: !actiuActual }).eq('id', id);
      if (error) return alert(`Error: ${error.message}`);
      render();
    });
  });

  // ---- Comptes: editar (formulari inline) ----
  document.querySelectorAll('[data-edit-compte]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.editCompte;
      const compte = comptes.find((c) => c.id === id);
      const contenidorEdit = document.getElementById(`edit-compte-${id}`);
      const esVisible = !contenidorEdit.hidden;

      // Tanca qualsevol altre formulari d'edició obert
      document.querySelectorAll('[id^="edit-compte-"]').forEach((el) => (el.hidden = true));

      if (esVisible) return; // toggle: si ja era visible, el deixem tancat

      contenidorEdit.hidden = false;
      contenidorEdit.innerHTML = `
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <input type="text" id="edit-num-${id}" value="${compte.num_compte}" style="min-width:200px;" />
          <input type="text" id="edit-desc-${id}" value="${compte.descripcio ?? ''}" placeholder="Descripció" />
          <button data-desar-compte="${id}">Desar</button>
        </div>
      `;
      document.querySelector(`[data-desar-compte="${id}"]`).addEventListener('click', async () => {
        const num_compte = document.getElementById(`edit-num-${id}`).value.trim();
        const descripcio = document.getElementById(`edit-desc-${id}`).value.trim() || null;
        const { error } = await supabase.from('gaco_comptes').update({ num_compte, descripcio }).eq('id', id);
        if (error) return alert(`Error desant: ${error.message}`);
        render();
      });
    });
  });
}
