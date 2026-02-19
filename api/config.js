export default function handler(req, res) {
  const url = (process.env.SUPABASE_URL || "").trim();
  const anonKey = (process.env.SUPABASE_ANON_KEY || "").trim();

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    supabaseUrl: url,
    supabaseAnonKey: anonKey,
  });
}
