import { createBrowserClient } from "@supabase/ssr";

declare global { interface Window { __RGIT_PUBLIC_CONFIG__?: { supabaseUrl?: string; supabaseAnonKey?: string; cookieSecure?: boolean } } }

export function hasSupabaseConfig() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

function cookieOptions() {
  // HTTPS Preview is embedded cross-site, so its session cookie must be None+Secure.
  // Set NEXT_PUBLIC_COOKIE_SECURE=false only for plain-HTTP local development.
  const secure = typeof window === "undefined" ? process.env.NEXT_PUBLIC_COOKIE_SECURE !== "false" : window.__RGIT_PUBLIC_CONFIG__?.cookieSecure ?? process.env.NEXT_PUBLIC_COOKIE_SECURE !== "false";
  return { path: "/", sameSite: secure ? ("none" as const) : ("lax" as const), secure };
}

export function getBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || (typeof window === "undefined" ? "" : window.__RGIT_PUBLIC_CONFIG__?.supabaseUrl);
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || (typeof window === "undefined" ? "" : window.__RGIT_PUBLIC_CONFIG__?.supabaseAnonKey);
  if (!url || !key) return null;
  return createBrowserClient(url, key, { cookieOptions: cookieOptions() });
}
