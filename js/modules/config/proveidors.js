import { supabase } from '../../lib/supabaseClient.js';

/**
 * Configuració i gestió → Proveïdors.
 * Alta ràpida (nom, CIF, tipus, IRPF) + "Més camps" opcional.
 * Cerca per nom/CIF (client-side, pensat per ~100-150 proveïdors — si
 * algun dia creix molt més, caldria passar el filtre a la consulta).
 * Editar obre un formulari inline amb tots els camps.
 * "Eliminar" = actiu=false (mateix criteri que Comptes bancaris).
 */

const TIPUS_PROVEIDOR = [
     'Adobs i fitosanitaris', 'Assegurances', 'Bancs/Financeres', 'Carburants', 'Ferreteria', 'Gestoria', 'Material_Agricola', 'Notaria/Registre',
  'Reparacions', 'Subministraments', 'Altres',
];

const CAMPS_EDITABLES = [
  ['nom', 'Nom / raó social'],
  ['nom_comercial', 'Nom comercial'],
  ['cif', 'CIF/NIF'],
  ['adreca', 'Adreça'],
  ['municipi', 'Municipi'],
  ['codi_postal', 'Codi postal'],
  ['provincia', 'Província'],
  ['telefon1', 'Telèfon'],
  ['email1', 'Correu'],
  ['iban1', 'IBAN'],
  ['compte_comptable', 'Compte comptable (PGC)'],
  ['codi_sao', 'Codi SAO'],
];

let tots = []; // cache local per a la cerca sense tornar a consultar la BD

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant proveïdors...</p>';

  const { data, error } = await supabase
    .from('gaco_proveidors')
    .select('*')
    .order('nom');

  if (error) {
    contenidor.innerHTML = `<p class="error">Error carregant proveïdors: ${error.message}</p>`;
    return;
  }

  tots = data;
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
        <div id="mes-camps" style="display:none; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
          <input type="text" id="prov-adreca" placeholder="Adreça" style="min-width:180px;" />
          <input type="text" id="prov-municipi" placeholder="Municipi" style="min-width:140px;" />
          <input type="text" id="prov-codipostal" placeholder="Codi postal" style="width:100px;" />
          <input type="text" id="prov-telefon" placeholder="Telèfon" style="width:130px;" />
          <input type="email" id="prov-email" placeholder="Correu" style="min-width:180px;" />
          <input type="text" id="prov-iban" placeholder="IBAN" style="min-width:200px;" />
          <input type="text" id="prov-compte-comptable" placeholder="Compte comptable (PGC, opcional)" style="min-width:200px;" />
          <input type="text" id="prov-codi-sao" placeholder="Codi SAO (opcional)" style="min-width:150px;" />
          <textarea id="prov-observacions" placeholder="Observacions (p.ex. &quot;deixem de treballar-hi&quot;, &quot;el comercial ha de portar mostres&quot;...)" style="width:100%; min-height:50px;"></textarea>
        </div>

        <button type="submit">Afegir proveïdor</button>
      </form>
    </div>

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <p style="font-weight:500; margin:0;">Proveïdors (<span id="comptador-proveidors">${tots.length}</span>)</p>
        <input type="search" id="cerca-proveidor" placeholder="Cerca per nom o CIF..." style="min-width:220px;" />
      </div>
      <div id="llista-proveidors"></div>
    </div>
  `;

  // "Més camps": ara es controla directament per style.display, sense
  // dependre de l'atribut hidden (que un style inline sempre ignorava)
  document.getElementById('toggle-mes-camps').addEventListener('click', () => {
    const bloc = document.getElementById('mes-camps');
    bloc.style.display = bloc.style.display === 'none' ? 'flex' : 'none';
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
      observacions: document.getElementById('prov-observacions').value.trim() || null,
      actiu: true,
    };
    if (!nou.nom) return;

    const { error } = await supabase.from('gaco_proveidors').insert(nou);
    if (error) return alert(`Error afegint proveïdor: ${error.message}`);
    render();
  });

  document.getElementById('cerca-proveidor').addEventListener('input', (e) => {
    pintarLlista(filtrar(e.target.value));
  });

  pintarLlista(tots);
}

function filtrar(text) {
  const t = text.trim().toLowerCase();
  if (!t) return tots;
  return tots.filter(
    (p) => p.nom?.toLowerCase().includes(t) || p.cif?.toLowerCase().includes(t)
  );
}

function pintarLlista(llista) {
  document.getElementById('comptador-proveidors').textContent = llista.length;
  const contenidor = document.getElementById('llista-proveidors');

  contenidor.innerHTML = llista
    .map(
      (p) => `
    <div style="border-top:0.5px solid var(--gaco-border); padding:10px 0;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div style="${p.actiu ? '' : 'color:var(--gaco-text-secondary); text-decoration:line-through;'}">
          <p style="margin:0;">${p.nom} ${p.tipus ? `· ${p.tipus}` : ''} ${p.subjecte_irpf ? '· IRPF' : ''}</p>
          <p style="margin:2px 0 0; font-size:12px; color:var(--gaco-text-secondary);">
            ${[p.cif, p.telefon1, p.email1].filter(Boolean).join(' · ') || '—'}
          </p>
          ${p.observacions ? `<p style="margin:4px 0 0; font-size:12px; color:var(--gaco-accent);">⚠ ${p.observacions}</p>` : ''}
        </div>
        <div style="display:flex; gap:6px;">
          <button data-veure="${p.id}">Veure/Editar</button>
          <button data-toggle-proveidor="${p.id}" data-actiu="${p.actiu}">${p.actiu ? 'Desactivar' : 'Reactivar'}</button>
        </div>
      </div>
      <div id="edit-proveidor-${p.id}" style="display:none; margin-top:10px; padding-top:10px; border-top:0.5px dashed var(--gaco-border);"></div>
    </div>
  `
    )
    .join('');

  contenidor.querySelectorAll('[data-toggle-proveidor]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.toggleProveidor;
      const actiuActual = btn.dataset.actiu === 'true';
      const { error } = await supabase.from('gaco_proveidors').update({ actiu: !actiuActual }).eq('id', id);
      if (error) return alert(`Error: ${error.message}`);
      render();
    });
  });

  contenidor.querySelectorAll('[data-veure]').forEach((btn) => {
    btn.addEventListener('click', () => obrirEdicio(btn.dataset.veure));
  });
}

function obrirEdicio(id) {
  const proveidor = tots.find((p) => p.id === id);
  const bloc = document.getElementById(`edit-proveidor-${id}`);
  const esVisible = bloc.style.display !== 'none';

  // Tanca qualsevol altra fitxa oberta
  document.querySelectorAll('[id^="edit-proveidor-"]').forEach((el) => (el.style.display = 'none'));
  if (esVisible) return; // toggle: si ja era visible, es queda tancat

  bloc.style.display = 'block';
  bloc.innerHTML = `
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
      ${CAMPS_EDITABLES.map(
        ([camp, label]) => `
        <input type="text" id="ed-${camp}-${id}" placeholder="${label}" value="${proveidor[camp] ?? ''}" style="min-width:160px;" />
      `
      ).join('')}
      <select id="ed-tipus-${id}" style="min-width:150px;">
        <option value="">Tipus...</option>
        ${TIPUS_PROVEIDOR.map(
          (t) => `<option value="${t}" ${proveidor.tipus === t ? 'selected' : ''}>${t}</option>`
        ).join('')}
      </select>
      <label style="display:flex; align-items:center; gap:6px; font-size:13px;">
        <input type="checkbox" id="ed-irpf-${id}" ${proveidor.subjecte_irpf ? 'checked' : ''} />
        Subjecte IRPF
      </label>
    </div>
    <textarea id="ed-observacions-${id}" placeholder="Observacions" style="width:100%; min-height:50px; margin-bottom:8px;">${proveidor.observacions ?? ''}</textarea>
    <button data-desar="${id}">Desar canvis</button>
  `;

  bloc.querySelector(`[data-desar="${id}"]`).addEventListener('click', async () => {
    const actualitzat = {
      tipus: document.getElementById(`ed-tipus-${id}`).value || null,
      subjecte_irpf: document.getElementById(`ed-irpf-${id}`).checked,
      observacions: document.getElementById(`ed-observacions-${id}`).value.trim() || null,
    };
    CAMPS_EDITABLES.forEach(([camp]) => {
      actualitzat[camp] = document.getElementById(`ed-${camp}-${id}`).value.trim() || null;
    });
    const { error } = await supabase.from('gaco_proveidors').update(actualitzat).eq('id', id);
    if (error) return alert(`Error desant: ${error.message}`);
    render();
  });
}
