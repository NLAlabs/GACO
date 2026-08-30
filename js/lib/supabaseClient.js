/**
 * Client Supabase compartit amb SAO — mateixa instància, mateix Auth.
 * GACO no crea cap sistema d'usuaris separat (veure document conceptual,
 * secció "Arquitectura tècnica").
 *
 * IMPORTANT: substituir per la URL i clau anon reals del projecte Supabase
 * de SAO abans de desplegar. No versionar la clau real en text pla si el
 * repositori és públic — usar variables d'entorn / build step.
 */

const SUPABASE_URL = 'https://arsjypznhmzyfbbxvrdd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFyc2p5cHpuaG16eWZiYnh2cmRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwMjA2MzgsImV4cCI6MjEwMzU5NjYzOH0.19k9tc9gcFG6ZH8caZAMyBt0pYqqdLZECA0OK4t1PMc';

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
