import { supabase } from '../lib/supabaseClient.js';

/**
 * Inici: resum ràpid, no un dashboard decoratiu.
 * Mostra el que cal fer, no números bonics sense acció associada
 * (principi "prioritzar la tasca més freqüent").
 */
export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant...</p>';

  const { count: pendentsConciliar } = await supabase
    .from('gaco_moviments_n43')
    .select('id', { count: 'exact', head: true })
    .eq('estat', 'pendent');

  const { count: facturesPendents } = await supabase
    .from('gaco_factures_rebudes')
    .select('id', { count: 'exact', head: true })
    .in('estat', ['pendent', 'pagada_parcial']);

  contenidor.innerHTML = `
    <div class="card">
      <p><a href="#/moviments/conciliacio">${pendentsConciliar ?? 0} moviments pendents de conciliar →</a></p>
      <p><a href="#/documents/rebudes">${facturesPendents ?? 0} factures pendents de pagament →</a></p>
    </div>
  `;
}
