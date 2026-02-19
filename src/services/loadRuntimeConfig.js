export async function loadRuntimeConfig() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error("Config endpoint unavailable");
    const data = await response.json();

    return {
      supabaseUrl: data.supabaseUrl || "",
      supabaseAnonKey: data.supabaseAnonKey || "",
    };
  } catch {
    return {
      supabaseUrl: "",
      supabaseAnonKey: "",
    };
  }
}
