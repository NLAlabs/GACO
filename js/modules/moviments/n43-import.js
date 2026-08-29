import { supabase } from '../../lib/supabaseClient.js';
import { importarFitxerN43 } from './n43-parser.js';

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = `
    <div class="card">
      <p>Puja un fitxer N43 del banc. Els moviments ja importats no es duplicaran.</p>
      <input type="file" id="n43-input" accept=".n43,.txt" />
      <div id="n43-resultat"></div>
    </div>
  `;

  document.getElementById('n43-input').addEventListener('change', handleFileUpload);
}

async function resoldreCompteId({ claveEntidad, claveOficina, numCuenta }) {
  // Criteri de match a confirmar amb dades reals — veure nota al fitxer n43-parser.js
  const { data } = await supabase
    .from('gaco_comptes')
    .select('id, num_compte')
    .ilike('num_compte', `%${numCuenta}%`)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const resultatEl = document.getElementById('n43-resultat');
  resultatEl.textContent = 'Processant...';

  const buffer = await file.arrayBuffer();
  const { filesPerInserir, comptesNoResolts, avisos } = await importarFitxerN43(buffer, resoldreCompteId);

  if (comptesNoResolts.length > 0) {
    resultatEl.innerHTML = `<p class="error">Comptes del fitxer no reconeguts a GACO: ${comptesNoResolts
      .map((c) => c.numCuenta)
      .join(', ')}. Dona'ls d'alta a Configuració abans d'importar.</p>`;
    return;
  }

  const { error } = await supabase
    .from('gaco_moviments_n43')
    .upsert(filesPerInserir, { onConflict: 'hash_deduplicacio', ignoreDuplicates: true });

  if (error) {
    resultatEl.innerHTML = `<p class="error">Error important: ${error.message}</p>`;
    return;
  }

  resultatEl.innerHTML = `<p>${filesPerInserir.length} moviments processats. Revisa els avisos a la consola si n'hi ha.</p>`;
  console.log('Avisos de la importació:', avisos);
}
