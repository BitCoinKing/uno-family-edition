export default function handler(req, res) {
  const url = process.env.SUPABASE_URL || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    supabaseUrl: url,
    supabaseAnonKey: anonKey,
  });
}
