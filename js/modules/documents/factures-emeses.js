import { supabase } from '../../lib/supabaseClient.js';

/**
 * Factures emeses — Fase 2 (encara no és Fase 1).
 * DECISIÓ PENDENT confirmada amb l'usuari (05/07/2026... conversa de
 * disseny): cal afegir un tercer valor 'ingres' a tipus_document
 * (actualment 'factura'|'pressupost') per cobrir ingressos sense
 * factura formal: subvencions, ajuts, devolucions, rendiments financers,
 * abonaments de sinistres. Mirroring exacte del que ja fa
 * gaco_factures_rebudes.tipus_factura='despesa'.
 * Aquest mòdul és un placeholder fins que es dissenyi l'esquema de Fase 2.
 */
export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<div class="card"><p>Facturació emesa — pendent de Fase 2.</p></div>';
}
