import { supabase } from '../../lib/supabaseClient.js';

/**
 * Vista operativa de comptes (dins Moviments) — diferent de la gestió
 * d'alta/baixa de comptes, que viu a Configuració i gestió (nomesAdmin).
 * Mostra saldo aproximat (suma de moviments) i accés ràpid a N43/conciliació.
 */
export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant comptes...</p>';

  const { data: comptes, error } = await supabase
    .from('gaco_comptes')
    .select('id, tipus, descripcio, num_compte, gaco_entitats_bancaries(nom)')
    .eq('actiu', true);

  if (error) {
    contenidor.innerHTML = `<p class="error">Error carregant comptes: ${error.message}</p>`;
    return;
  }

  contenidor.innerHTML = comptes
    .map(
      (c) => `
    <div class="card">
      <p>${c.descripcio ?? c.tipus} — ${c.gaco_entitats_bancaries?.nom ?? ''}</p>
      <p style="color: var(--gaco-text-secondary); font-size: 13px;">${c.num_compte}</p>
      <!-- TODO: saldo calculat (suma de gaco_moviments_n43.import per compte_id) -->
    </div>
  `
    )
    .join('');
}
