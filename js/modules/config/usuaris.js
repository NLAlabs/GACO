import { supabase } from '../../lib/supabaseClient.js';

/**
 * Configuració i gestió → Usuaris.
 * NOMÉS admin (aplicat també per RLS a gaco_usuaris_rol — gaco_gestio_admin).
 *
 * No es pot llistar auth.users des del client (taula privada de Supabase).
 * Per donar d'alta un usuari nou, cal saber el seu correu (el mateix que
 * ja fa servir a SAO) — la funció gaco_alta_usuari_per_email el busca a
 * auth.users pel seu compte (veure gaco_funcio_alta_usuari.sql).
 */
export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant usuaris...</p>';

  const { data: usuaris, error } = await supabase
    .from('gaco_usuaris_rol')
    .select('id, rol, actiu, created_at')
    .order('rol');

  if (error) {
    contenidor.innerHTML = `<p class="error">Error carregant usuaris: ${error.message}</p>`;
    return;
  }

  contenidor.innerHTML = `
    <div class="card">
      <p style="font-weight:500; margin-bottom:12px;">Donar d'alta un usuari de SAO</p>
      <p style="font-size:13px; color:var(--gaco-text-secondary); margin-bottom:12px;">
        Ha de ser un correu que ja existeixi a SAO — GACO no crea usuaris nous, només rols sobre els existents.
      </p>
      <form id="alta-usuari-form" style="display:flex; gap:8px; flex-wrap:wrap;">
        <input type="email" id="nou-usuari-email" placeholder="correu@exemple.com" required style="flex:1; min-width:200px;" />
        <select id="nou-usuari-rol">
          <option value="gestor">gestor</option>
          <option value="visor">visor</option>
          <option value="gestoria">gestoria</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit">Donar d'alta</button>
      </form>
      <p id="alta-usuari-resultat" style="font-size:13px; margin-top:8px;"></p>
    </div>

    <div class="card">
      <p style="font-weight:500; margin-bottom:12px;">Usuaris actuals</p>
      ${usuaris
        .map(
          (u) => `
        <div style="display:flex; justify-content:space-between; padding:8px 0; border-top:0.5px solid var(--gaco-border);">
          <span>${u.rol}</span>
          <span style="color:${u.actiu ? 'var(--gaco-success)' : 'var(--gaco-text-secondary)'};">${u.actiu ? 'actiu' : 'inactiu'}</span>
        </div>
      `
        )
        .join('')}
      <!-- TODO: mostrar el correu real (requereix una vista/funció addicional
           que faci JOIN amb auth.users, mateix motiu que a l'alta) -->
    </div>
  `;

  document.getElementById('alta-usuari-form').addEventListener('submit', handleAltaUsuari);
}

async function handleAltaUsuari(event) {
  event.preventDefault();
  const email = document.getElementById('nou-usuari-email').value;
  const rol = document.getElementById('nou-usuari-rol').value;
  const resultatEl = document.getElementById('alta-usuari-resultat');

  const { data, error } = await supabase.rpc('gaco_alta_usuari_per_email', {
    p_email: email,
    p_rol: rol,
  });

  if (error) {
    resultatEl.textContent = `Error: ${error.message}`;
    resultatEl.style.color = 'var(--gaco-danger)';
    return;
  }

  resultatEl.textContent = `${email} donat d'alta com a ${rol}.`;
  resultatEl.style.color = 'var(--gaco-success)';
  render(); // refresca la llista
}
