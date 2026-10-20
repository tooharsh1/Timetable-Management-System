import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedProfile } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { supabase, user, profile, configured } = await getAuthenticatedProfile();
  if (!configured) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  if (!user || !profile) return NextResponse.json({ error: "Authentication is required." }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ error: "Only an approved administrator can change locks." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const sessionId = String(body.session_id ?? "");
  const locked = body.locked;
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sessionId) || typeof locked !== "boolean") return NextResponse.json({ error: "Provide a valid session and lock state." }, { status: 400 });
  const { data, error } = await supabase!.rpc("set_session_lock", { p_session_id: sessionId, p_locked: locked, p_reason: String(body.reason ?? "Administrator lock") });
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  return NextResponse.json({ locked: Boolean(data), message: locked ? "Session locked and protected during regeneration." : "Session unlocked and available for reconfiguration." });
}
