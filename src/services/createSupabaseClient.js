import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export function createSupabase(url, anonKey) {
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}
