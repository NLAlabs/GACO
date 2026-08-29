import { supabase } from '../../lib/supabaseClient.js';

/**
 * Factures rebudes — inclou tant 'factura' com 'despesa' (tipus_factura),
 * aquesta última per a despeses sense número de factura formal (rebuts
 * directes: subministraments, comissions bancàries...).
 * TODO: formulari d'alta amb accés ràpid contextual a la fitxa del
 * proveïdor (navegació contextual, principi del document).
 */
export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant factures rebudes...</p>';

  const { data, error } = await supabase
    .from('gaco_factures_rebudes')
    .select('id, num_factura, contrapart_nom, total, estat, data_venciment, gaco_proveidors(nom)')
    .order('data_factura', { ascending: false })
    .limit(50);

  if (error) {
    contenidor.innerHTML = `<p class="error">Error: ${error.message}</p>`;
    return;
  }

  contenidor.innerHTML = data
    .map(
      (f) => `
    <div class="card">
      <p>${f.gaco_proveidors?.nom ?? f.contrapart_nom ?? '(sense proveïdor)'} — ${f.num_factura ?? 'despesa'}</p>
      <p>${f.total ?? ''} € · ${f.estat}</p>
    </div>
  `
    )
    .join('');
}
