import { supabase } from './lib/supabaseClient.js';

/**
 * Estat d'autenticació en memòria. `rol` prové de gaco_usuaris_rol,
 * NO de auth.users (l'usuari ja ve autenticat de SAO).
 */
export const authState = {
  session: null,
  rol: null, // 'admin' | 'gestor' | 'visor' | 'gestoria'
};

export async function initAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  authState.session = session;
  if (session) {
    await carregarRol();
  }
  return authState;
}

async function carregarRol() {
  const { data, error } = await supabase
    .from('gaco_usuaris_rol')
    .select('rol')
    .eq('user_id', authState.session.user.id)
    .eq('actiu', true)
    .maybeSingle();

  if (error) {
    console.error('Error carregant el rol GACO:', error);
    authState.rol = null;
    return;
  }
  // Si l'usuari no té cap fila a gaco_usuaris_rol, no té accés a GACO
  // (encara que sigui usuari vàlid de SAO) — mostrar-ho clarament a la UI.
  authState.rol = data?.rol ?? null;
}

export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  authState.session = data.session;
  await carregarRol();
  return authState;
}

export async function logout() {
  await supabase.auth.signOut();
  authState.session = null;
  authState.rol = null;
}

export function pot(accio) {
  // Helper senzill per a la UI: pot('escriure') / pot('gestionar_usuaris')
  if (!authState.rol) return false;
  if (accio === 'escriure') return ['admin', 'gestor'].includes(authState.rol);
  if (accio === 'gestionar_usuaris') return authState.rol === 'admin';
  if (accio === 'llegir') return ['admin', 'gestor', 'visor'].includes(authState.rol);
  return false;
}
