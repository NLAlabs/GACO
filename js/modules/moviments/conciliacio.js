import { supabase } from '../../lib/supabaseClient.js';

/**
 * Conciliació — mockup validat amb l'usuari (veure conversa de disseny).
 * Pendent d'implementar en aquest esquelet:
 *  1. Llistar gaco_moviments_n43 amb estat='pendent'.
 *  2. Detecció automàtica de traspàs pòlissa: mateixa data_valor + import
 *     de signe oposat entre compte_id i el seu compte_polissa_vinculat_id.
 *  3. Acció "Vincular factura/liquidació": crea fila a gaco_conciliacions.
 *  4. Acció "Ignorar": estat='ignorat'.
 */
export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant moviments pendents...</p>';

  const { data: moviments, error } = await supabase
    .from('gaco_moviments_n43')
    .select('id, data_valor, import, concepte, compte_id')
    .eq('estat', 'pendent')
    .order('data_valor', { ascending: false });

  if (error) {
    contenidor.innerHTML = `<p class="error">Error carregant moviments: ${error.message}</p>`;
    return;
  }

  if (!moviments.length) {
    contenidor.innerHTML = '<div class="card"><p>No hi ha moviments pendents de conciliar.</p></div>';
    return;
  }

  contenidor.innerHTML = moviments
    .map(
      (m) => `
    <div class="card">
      <p>${m.concepte ?? '(sense concepte)'}</p>
      <p>${m.data_valor} · ${m.import} €</p>
      <!-- TODO: botons Vincular / Ignorar, i detecció automàtica de traspàs -->
    </div>
  `
    )
    .join('');
}
