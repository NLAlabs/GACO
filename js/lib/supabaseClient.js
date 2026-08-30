/**
 * Client Supabase compartit amb SAO — mateixa instància, mateix Auth.
 * GACO no crea cap sistema d'usuaris separat (veure document conceptual,
 * secció "Arquitectura tècnica").
 *
 * IMPORTANT: substituir per la URL i clau anon reals del projecte Supabase
 * de SAO abans de desplegar. No versionar la clau real en text pla si el
 * repositori és públic — usar variables d'entorn / build step.
 */

const SUPABASE_URL = 'https://xnxoufpizdtfklfjwqet.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhueG91ZnBpemR0ZmtsZmp3cWV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEwMDk4NDAsImV4cCI6MjA4NjU4NTg0MH0.izqQdOxUWUzXNhasXwHnm7IO2qVHHHzx9e-1FIGh9ic';

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
