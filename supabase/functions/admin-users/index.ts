// Creates administrator accounts on the server.
// The service-role key exists ONLY in this function's environment (Supabase injects it); it never reaches the browser.
// The caller must be a signed-in, active Super Admin: checked with the caller's own JWT through is_super_admin().
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await caller.auth.getUser(auth.replace(/^Bearer /i, ""));
    if (!user) return json({ error: "Not signed in" }, 401);
    const { data: isSuper } = await caller.rpc("is_super_admin");
    if (isSuper !== true) return json({ error: "Super Admins only" }, 403);

    const b = await req.json().catch(() => ({}));
    if (b.action !== "create") return json({ error: "Unknown action" }, 400);
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");
    const fullName = String(b.full_name || "").trim().slice(0, 120) || null;
    const role = b.role === "super_admin" ? "super_admin" : "admin";
    if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Enter a valid email address" }, 400);
    if (password.length < 8 || password.length > 72) return json({ error: "Password must be 8 to 72 characters" }, 400);

    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: fullName ? { full_name: fullName } : {} });
    if (error) return json({ error: /already|registered|exists/i.test(error.message) ? "An account with that email already exists. Use 'Or promote an existing account' instead." : error.message }, 400);

    const { error: e2 } = await svc.from("administrators").insert({ id: data.user.id, email, full_name: fullName, role });
    if (e2) { await svc.auth.admin.deleteUser(data.user.id); return json({ error: "Could not create the administrator: " + e2.message }, 500); }
    await svc.from("audit_logs").insert({ admin_id: user.id, action: "admin_account_created", metadata: { admin_id: data.user.id, role } });
    return json({ ok: true, id: data.user.id });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
