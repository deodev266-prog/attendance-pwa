// Exports the attendance summary to a Google Sheet.
// Auth: the caller's Supabase JWT is forwarded to Postgres, so admin_attendance_summary()
// enforces is_admin() in the database. No service_role key is used anywhere.
// Google access: a service account (secret) that the target sheet is shared with.
// Scale: Supabase returns max 1000 rows per request, so rows are fetched per course in pages of 1000
// and written to Sheets in chunks.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const b64u = (x: ArrayBuffer | string) =>
  btoa(typeof x === "string" ? x : String.fromCharCode(...new Uint8Array(x)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function googleToken(sa: { client_email: string; private_key: string }) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64u(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const pem = sa.private_key.replace(/-----[A-Z ]+-----|\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claim}`));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${b64u(sig)}` }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("Google auth failed: " + (j.error_description || j.error));
  return j.access_token as string;
}

// deno-lint-ignore no-explicit-any
async function fetchRows(sb: any, b: any) {
  let courseIds: string[] = b.course_id ? [b.course_id] : [];
  if (!courseIds.length) {
    let q = sb.from("courses").select("id").order("id");
    if (b.department_id) q = q.eq("department_id", b.department_id);
    const { data, error } = await q.range(0, 999);
    if (error) throw error;
    courseIds = data.map((c: { id: string }) => c.id);
  }
  const all: any[] = [];
  for (const cid of courseIds) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.rpc("admin_attendance_summary", {
        p_department_id: b.department_id || null, p_course_id: cid, p_from: b.from || null, p_to: b.to || null,
      }).range(from, from + 999);
      if (error) throw error;
      all.push(...data);
      if (data.length < 1000) break;
    }
  }
  return all;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await sb.auth.getUser(auth.replace(/^Bearer /i, ""));
    if (!user) return json({ error: "Not signed in" }, 401);

    const { data: adm } = await sb.from("administrators").select("id").eq("id", user.id).eq("is_active", true).maybeSingle();
    if (!adm) return json({ error: "Administrators only" }, 403);

    const b = await req.json().catch(() => ({}));
    const data = await fetchRows(sb, b);
    if (!data.length) return json({ error: "No rows match these filters" }, 404);

    const saRaw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
    const sheetId = (b.spreadsheet_id || Deno.env.get("GOOGLE_SHEET_ID") || "").trim();
    if (!saRaw || !sheetId) return json({ error: "Google Sheets is not configured on the server yet (see README)" }, 501);
    if (!/^[A-Za-z0-9_-]{20,}$/.test(sheetId)) return json({ error: "Invalid spreadsheet ID" }, 400);

    const sa = JSON.parse(saRaw);
    const token = await googleToken(sa);
    const gh = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;
    const d = new Date();
    const title = `Attendance ${d.toISOString().slice(0, 16).replace("T", " ").replace(":", "")}`;

    const add = await fetch(`${base}:batchUpdate`, { method: "POST", headers: gh, body: JSON.stringify({ requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: data.length + 10, columnCount: 8 } } } }] }) });
    const addJ = await add.json();
    if (!add.ok) return json({ error: "Sheets: " + (addJ.error?.message ?? "cannot add tab. Is the sheet shared with " + sa.client_email + "?") }, 502);
    const gid = addJ.replies[0].addSheet.properties.sheetId;

    const header = ["Matric No", "Name", "Department", "Course Code", "Course Title", "Sessions Held", "Sessions Attended", "Attendance %"];
    const rows = [header, ...data.map((r: any) => [r.matric_no, r.full_name, r.department, r.course_code, r.course_title, r.sessions_held, r.sessions_attended, Number(r.attendance_percentage)])];
    for (let i = 0; i < rows.length; i += 5000) { // chunked writes; RAW = no formula injection
      const put = await fetch(`${base}/values/${encodeURIComponent(`'${title}'!A${i + 1}`)}?valueInputOption=RAW`, {
        method: "PUT", headers: gh, body: JSON.stringify({ values: rows.slice(i, i + 5000) }),
      });
      if (!put.ok) return json({ error: "Sheets write failed: " + ((await put.json()).error?.message ?? put.status) }, 502);
    }
    return json({ ok: true, rows: data.length, url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${gid}` });
  } catch (e) {
    const m = (e as { message?: string }).message ?? String(e);
    return json({ error: m }, m.includes("Administrators only") ? 403 : 500);
  }
});
