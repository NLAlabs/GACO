import { supabase } from '../../lib/supabaseClient.js';

/**
 * Configuració i gestió → Clients.
 * Mateix patró que Proveïdors: alta ràpida + "Més camps" opcional + cerca
 * per nom/CIF (client-side) + Veure/Editar + "Eliminar" = actiu=false.
 * Sense tipus ni subjecte_irpf (no apliquen a un client).
 */

const CAMPS_EDITABLES = [
  ['nom', 'Nom / raó social'],
  ['nom_comercial', 'Nom comercial'],
  ['cif', 'CIF/NIF'],
  ['adreca', 'Adreça'],
  ['municipi', 'Municipi'],
  ['codi_postal', 'Codi postal'],
  ['provincia', 'Província'],
  ['telefon1', 'Telèfon'],
  ['telefon2', 'Telèfon 2'],
  ['mobil1', 'Mòbil'],
  ['mobil2', 'Mòbil 2'],
  ['fax', 'Fax'],
  ['web', 'Web'],
  ['email1', 'Correu'],
  ['email2', 'Correu 2'],
  ['iban1', 'IBAN'],
  ['iban2', 'IBAN 2'],
];

let tots = []; // cache local per a la cerca sense tornar a consultar la BD

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant clients...</p>';

  const { data, error } = await supabase
    .from('gaco_clients')
    .select('*')
    .order('nom');

  if (error) {
    contenidor.innerHTML = `<p class="error">Error carregant clients: ${error.message}</p>`;
    return;
  }

  tots = data;
  contenidor.innerHTML = `
    <div class="card">
      <p style="font-weight:500; margin-bottom:12px;">Nou client</p>
      <form id="form-client">
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
          <input type="text" id="cli-nom" placeholder="Nom / raó social" required style="flex:2; min-width:200px;" />
          <input type="text" id="cli-cif" placeholder="CIF/NIF" style="flex:1; min-width:120px;" />
          <input type="text" id="cli-telefon" placeholder="Telèfon" style="flex:1; min-width:130px;" />
        </div>

        <button type="button" id="toggle-mes-camps" style="margin-bottom:8px;">Més camps ▾</button>
        <div id="mes-camps" style="display:none; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
          <input type="text" id="cli-nom-comercial" placeholder="Nom comercial" style="min-width:180px;" />
          <input type="text" id="cli-adreca" placeholder="Adreça" style="min-width:180px;" />
          <input type="text" id="cli-municipi" placeholder="Municipi" style="min-width:140px;" />
          <input type="text" id="cli-codipostal" placeholder="Codi postal" style="width:100px;" />
          <input type="text" id="cli-provincia" placeholder="Província" style="min-width:140px;" />
          <input type="text" id="cli-telefon2" placeholder="Telèfon 2" style="width:130px;" />
          <input type="text" id="cli-mobil1" placeholder="Mòbil" style="width:130px;" />
          <input type="text" id="cli-mobil2" placeholder="Mòbil 2" style="width:130px;" />
          <input type="text" id="cli-fax" placeholder="Fax" style="width:130px;" />
          <input type="text" id="cli-web" placeholder="Web" style="min-width:160px;" />
          <input type="email" id="cli-email" placeholder="Correu" style="min-width:180px;" />
          <input type="email" id="cli-email2" placeholder="Correu 2" style="min-width:180px;" />
          <input type="text" id="cli-iban" placeholder="IBAN" style="min-width:200px;" />
          <input type="text" id="cli-iban2" placeholder="IBAN 2" style="min-width:200px;" />
          <textarea id="cli-observacions" placeholder="Observacions" style="width:100%; min-height:50px;"></textarea>
        </div>

        <button type="submit">Afegir client</button>
      </form>
    </div>

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <p style="font-weight:500; margin:0;">Clients (<span id="comptador-clients">${tots.length}</span>)</p>
        <input type="search" id="cerca-client" placeholder="Cerca per nom o CIF..." style="min-width:220px;" />
      </div>
      <div id="llista-clients"></div>
    </div>
  `;

  document.getElementById('toggle-mes-camps').addEventListener('click', () => {
    const bloc = document.getElementById('mes-camps');
    bloc.style.display = bloc.style.display === 'none' ? 'flex' : 'none';
  });

  document.getElementById('form-client').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nou = {
      nom: document.getElementById('cli-nom').value.trim(),
      cif: document.getElementById('cli-cif').value.trim() || null,
      telefon1: document.getElementById('cli-telefon').value.trim() || null,
      nom_comercial: document.getElementById('cli-nom-comercial').value.trim() || null,
      adreca: document.getElementById('cli-adreca').value.trim() || null,
      municipi: document.getElementById('cli-municipi').value.trim() || null,
      codi_postal: document.getElementById('cli-codipostal').value.trim() || null,
      provincia: document.getElementById('cli-provincia').value.trim() || null,
      telefon2: document.getElementById('cli-telefon2').value.trim() || null,
      mobil1: document.getElementById('cli-mobil1').value.trim() || null,
      mobil2: document.getElementById('cli-mobil2').value.trim() || null,
      fax: document.getElementById('cli-fax').value.trim() || null,
      web: document.getElementById('cli-web').value.trim() || null,
      email1: document.getElementById('cli-email').value.trim() || null,
      email2: document.getElementById('cli-email2').value.trim() || null,
      iban1: document.getElementById('cli-iban').value.trim() || null,
      iban2: document.getElementById('cli-iban2').value.trim() || null,
      observacions: document.getElementById('cli-observacions').value.trim() || null,
      actiu: true,
    };
    if (!nou.nom) return;

    const { error } = await supabase.from('gaco_clients').insert(nou);
    if (error) return alert(`Error afegint client: ${error.message}`);
    render();
  });

  document.getElementById('cerca-client').addEventListener('input', (e) => {
    pintarLlista(filtrar(e.target.value));
  });

  pintarLlista(tots);
}

function filtrar(text) {
  const t = text.trim().toLowerCase();
  if (!t) return tots;
  return tots.filter(
    (c) => c.nom?.toLowerCase().includes(t) || c.cif?.toLowerCase().includes(t)
  );
}

function pintarLlista(llista) {
  document.getElementById('comptador-clients').textContent = llista.length;
  const contenidor = document.getElementById('llista-clients');

  contenidor.innerHTML = llista
    .map(
      (c) => `
    <div style="border-top:0.5px solid var(--gaco-border); padding:10px 0;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div style="${c.actiu ? '' : 'color:var(--gaco-text-secondary); text-decoration:line-through;'}">
          <p style="margin:0;">${c.nom} ${c.nom_comercial ? `· ${c.nom_comercial}` : ''}</p>
          <p style="margin:2px 0 0; font-size:12px; color:var(--gaco-text-secondary);">
            ${[c.cif, c.telefon1, c.email1].filter(Boolean).join(' · ') || '—'}
          </p>
          ${c.observacions ? `<p style="margin:4px 0 0; font-size:12px; color:var(--gaco-accent);">⚠ ${c.observacions}</p>` : ''}
        </div>
        <div style="display:flex; gap:6px;">
          <button data-veure="${c.id}">Veure/Editar</button>
          <button data-toggle-client="${c.id}" data-actiu="${c.actiu}">${c.actiu ? 'Desactivar' : 'Reactivar'}</button>
        </div>
      </div>
      <div id="edit-client-${c.id}" style="display:none; margin-top:10px; padding-top:10px; border-top:0.5px dashed var(--gaco-border);"></div>
    </div>
  `
    )
    .join('');

  contenidor.querySelectorAll('[data-toggle-client]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.toggleClient;
      const actiuActual = btn.dataset.actiu === 'true';
      const { error } = await supabase.from('gaco_clients').update({ actiu: !actiuActual }).eq('id', id);
      if (error) return alert(`Error: ${error.message}`);
      render();
    });
  });

  contenidor.querySelectorAll('[data-veure]').forEach((btn) => {
    btn.addEventListener('click', () => obrirEdicio(btn.dataset.veure));
  });
}

function obrirEdicio(id) {
  const client = tots.find((c) => c.id === id);
  const bloc = document.getElementById(`edit-client-${id}`);
  const esVisible = bloc.style.display !== 'none';

  document.querySelectorAll('[id^="edit-client-"]').forEach((el) => (el.style.display = 'none'));
  if (esVisible) return;

  bloc.style.display = 'block';
  bloc.innerHTML = `
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
      ${CAMPS_EDITABLES.map(
        ([camp, label]) => `
        <input type="text" id="ed-${camp}-${id}" placeholder="${label}" value="${client[camp] ?? ''}" style="min-width:160px;" />
      `
      ).join('')}
    </div>
    <textarea id="ed-observacions-${id}" placeholder="Observacions" style="width:100%; min-height:50px; margin-bottom:8px;">${client.observacions ?? ''}</textarea>
    <button data-desar="${id}">Desar canvis</button>
  `;

  bloc.querySelector(`[data-desar="${id}"]`).addEventListener('click', async () => {
    const actualitzat = {
      observacions: document.getElementById(`ed-observacions-${id}`).value.trim() || null,
    };
    CAMPS_EDITABLES.forEach(([camp]) => {
      actualitzat[camp] = document.getElementById(`ed-${camp}-${id}`).value.trim() || null;
    });
    const { error } = await supabase.from('gaco_clients').update(actualitzat).eq('id', id);
    if (error) return alert(`Error desant: ${error.message}`);
    render();
  });
}
