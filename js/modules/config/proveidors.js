/**
 * Configuració i gestió → proveidors. Dades bàsiques i principalment fixes
 * (un cop donades d'alta no tenen molt moviment), reservat a admin
 * segons authState.rol — veure js/auth.js i RLS a gaco_fase1_completa.sql.
 */
export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<div class="card"><p>Gestió de proveidors — pendent d\'implementar.</p></div>';
}
