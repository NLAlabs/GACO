/**
 * Informes — explícitament pendent de confeccionar (Fase 6 del pla original:
 * IVA trimestral/anual, resultat per activitat, resums d'ingressos i
 * despeses per conceptes/proveïdors/clients). No bloqueja l'inici de la
 * resta de fases.
 */
export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<div class="card"><p>Informes — pendent de confeccionar (Fase 6).</p></div>';
}
