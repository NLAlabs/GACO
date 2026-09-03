import { supabase } from '../../lib/supabaseClient.js';

/**
 * Configuració i gestió → Proveïdors.
 * Alta ràpida amb els camps essencials (nom, CIF, tipus, subjecte IRPF);
 * la resta de dades (adreça, contacte, IBAN...) queden rere un
 * "Més camps" per no allargar el formulari del dia a dia — principi de
 * disseny àgil i lleuger del document original.
 *
 * "Eliminar" = actiu=false (mateix criteri que comptes bancaris — altres
 * taules com gaco_factures_rebudes referencien proveidor_id).
 */

const TIPUS_PROVEIDOR = [
  'fitosanitaris', 'gasoil', 'assegurances', 'gestoria', 'notaria',
  'registre', 'benzinera', 'ferreteria', 'material_agricola', 'altres',
];

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant proveïdors...</p>';

  const { data: proveidors, error } = await supabase
    .from('gaco_proveidors')
    .select('id, nom, cif, tipus, subjecte_irpf, actiu, telefon1, email1, iban1')
    .order('nom');

  if (error) {
    contenidor.innerHTML = `<p class="error">Error carregant proveïdors: ${error.message}</p>`;
    return;
  }

  contenidor.innerHTML = `
    <div class="card">
      <p style="font-weight:500; margin-bottom:12px;">Nou proveïdor</p>
      <form id="form-proveidor">
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
          <input type="text" id="prov-nom" placeholder="Nom / raó social" required style="flex:2; min-width:200px;" />
          <input type="text" id="prov-cif" placeholder="CIF/NIF" style="flex:1; min-width:120px;" />
          <select id="prov-tipus" style="flex:1; min-width:150px;">
            <option value="">Tipus...</option>
            ${TIPUS_PROVEIDOR.map((t) => `<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>
        <label style="display:flex; align-items:center; gap:6px; font-size:13px; margin-bottom:8px;">
          <input type="checkbox" id="prov-irpf" />
          Sol aplicar retenció IRPF (alerta, no percentatge fix)
        </label>

        <button type="button" id="toggle-mes-camps" style="margin-bottom:8px;">Més camps ▾</button>
        <div id="mes-camps" hidden style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
          <input type="text" id="prov-adreca" placeholder="Adreça" style="min-width:180px;" />
          <input type="text" id="prov-municipi" placeholder="Municipi" style="min-width:140px;" />
          <input type="text" id="prov-codipostal" placeholder="Codi postal" style="width:100px;" />
          <input type="text" id="prov-telefon" placeholder="Telèfon" style="width:130px;" />
          <input type="email" id="prov-email" placeholder="Correu" style="min-width:180px;" />
          <input type="text" id="prov-iban" placeholder="IBAN" style="min-width:200px;" />
          <input type="text" id="prov-compte-comptable" placeholder="Compte comptable (PGC, opcional)" style="min-width:200px;" />
          <input type="text" id="prov-codi-sao" placeholder="Codi SAO (opcional)" style="min-width:150px;" />
        </div>

        <button type="submit">Afegir proveïdor</button>
      </form>
    </div>

    <div class="card">
      <p style="font-weight:500; margin-bottom:12px;">Proveïdors (${proveidors.length})</p>
      ${proveidors
        .map(
          (p) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-top:0.5px solid var(--gaco-border);">
          <div style="${p.actiu ? '' : 'color:var(--gaco-text-secondary); text-decoration:line-through;'}">
            <p style="margin:0;">${p.nom} ${p.tipus ? `· ${p.tipus}` : ''} ${p.subjecte_irpf ? '· IRPF' : ''}</p>
            <p style="margin:2px 0 0; font-size:12px; color:var(--gaco-text-secondary);">
              ${[p.cif, p.telefon1, p.email1].filter(Boolean).join(' · ') || '—'}
            </p>
          </div>
          <div style="display:flex; gap:6px;">
            <button data-toggle-proveidor="${p.id}" data-actiu="${p.actiu}">${p.actiu ? 'Desactivar' : 'Reactivar'}</button>
          </div>
        </div>
      `
        )
        .join('')}
    </div>
  `;

  document.getElementById('toggle-mes-camps').addEventListener('click', () => {
    const bloc = document.getElementById('mes-camps');
    bloc.hidden = !bloc.hidden;
  });

  document.getElementById('form-proveidor').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nou = {
      nom: document.getElementById('prov-nom').value.trim(),
      cif: document.getElementById('prov-cif').value.trim() || null,
      tipus: document.getElementById('prov-tipus').value || null,
      subjecte_irpf: document.getElementById('prov-irpf').checked,
      adreca: document.getElementById('prov-adreca').value.trim() || null,
      municipi: document.getElementById('prov-municipi').value.trim() || null,
      codi_postal: document.getElementById('prov-codipostal').value.trim() || null,
      telefon1: document.getElementById('prov-telefon').value.trim() || null,
      email1: document.getElementById('prov-email').value.trim() || null,
      iban1: document.getElementById('prov-iban').value.trim() || null,
      compte_comptable: document.getElementById('prov-compte-comptable').value.trim() || null,
      codi_sao: document.getElementById('prov-codi-sao').value.trim() || null,
      actiu: true,
    };
    if (!nou.nom) return;

    const { error } = await supabase.from('gaco_proveidors').insert(nou);
    if (error) return alert(`Error afegint proveïdor: ${error.message}`);
    render();
  });

  document.querySelectorAll('[data-toggle-proveidor]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.toggleProveidor;
      const actiuActual = btn.dataset.actiu === 'true';
      const { error } = await supabase.from('gaco_proveidors').update({ actiu: !actiuActual }).eq('id', id);
      if (error) return alert(`Error: ${error.message}`);
      render();
    });
  });
}
