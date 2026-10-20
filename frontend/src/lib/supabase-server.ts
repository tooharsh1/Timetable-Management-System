import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { AppRole, UserProfile } from "./supabase-types";

const databaseRoleToAppRole: Record<string, AppRole | undefined> = { Admin: "admin", Teacher: "teacher", Student: "student" };

function cookieOptions() {
  // HTTPS Preview is embedded cross-site; set None+Secure by default.
  // Set NEXT_PUBLIC_COOKIE_SECURE=false only for plain-HTTP local development.
  const secure = process.env.NEXT_PUBLIC_COOKIE_SECURE !== "false";
  return { path: "/", sameSite: secure ? ("none" as const) : ("lax" as const), secure };
}

export async function getServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookieOptions: cookieOptions(),
    cookies: {
      getAll() { return cookieStore.getAll(); },
      setAll(values) {
        try { values.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); }
        catch { /* Server components cannot always write cookies; middleware and route handlers refresh them. */ }
      },
    },
  });
}

export async function getAuthenticatedProfile() {
  const supabase = await getServerSupabase();
  if (!supabase) return { supabase: null, user: null, profile: null, configured: false };
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return { supabase, user: null, profile: null, configured: true };
  const { data: row, error } = await supabase.from("profiles").select("id,role,display_name,admin_approved").eq("id", authData.user.id).maybeSingle();
  if (error || !row) return { supabase, user: authData.user, profile: null, configured: true };
  const role = databaseRoleToAppRole[String(row.role)];
  if (!role || (role === "admin" && row.admin_approved !== true)) return { supabase, user: authData.user, profile: null, configured: true };
  const profile: UserProfile = { id: String(row.id), role, full_name: String(row.display_name ?? authData.user.email ?? "RGIT user"), initials: null, department_id: null, class_id: null, batch_id: null };
  return { supabase, user: authData.user, profile, configured: true };
}
