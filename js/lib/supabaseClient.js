/**
 * Client Supabase compartit amb SAO — mateixa instància, mateix Auth.
 * GACO no crea cap sistema d'usuaris separat (veure document conceptual,
 * secció "Arquitectura tècnica").
 *
 * IMPORTANT: substituir per la URL i clau anon reals del projecte Supabase
 * de SAO abans de desplegar. No versionar la clau real en text pla si el
 * repositori és públic — usar variables d'entorn / build step.
 */

const SUPABASE_URL = 'https://<el-mateix-projecte-que-sao>.supabase.co';
const SUPABASE_ANON_KEY = '<clau-anon-publica-de-sao>';

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
