// Edge Function : envoie une notification push aux joueurs ciblés.
// Déployée manuellement via l'outil MCP Supabase (deploy_edge_function) — ce fichier
// est gardé dans le repo pour référence/historique, il n'y a pas de pipeline de déploiement.
//
// Secrets requis côté Supabase (Project Settings > Edge Functions > Secrets) :
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
// (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY sont injectés automatiquement)

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;

webpush.setVapidDetails("mailto:contact@statfield.app", VAPID_PUBLIC, VAPID_PRIVATE);

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return new Response("Unauthorized", { status: 401 });

    const { data: profile } = await userClient.from("profiles").select("role").eq("id", user.id).single();
    if (!profile || !["admin", "staff"].includes(profile.role)) {
      return new Response("Forbidden", { status: 403 });
    }

    const { org, joueurs, title, body, url } = await req.json();
    if (!org || !Array.isArray(joueurs) || joueurs.length === 0) {
      return new Response(JSON.stringify({ error: "org et joueurs requis" }), { status: 400 });
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: subs, error: subsErr } = await adminClient
      .from("push_subscriptions")
      .select("*")
      .eq("org", org)
      .in("joueur_nom", joueurs);
    if (subsErr) return new Response(JSON.stringify({ error: subsErr.message }), { status: 500 });

    let sent = 0, failed = 0;
    for (const s of subs || []) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: s.keys },
          JSON.stringify({ title, body, url: url || "/" })
        );
        sent++;
      } catch (e) {
        failed++;
        const statusCode = e && (e.statusCode || e.status);
        if (statusCode === 410 || statusCode === 404) {
          // Abonnement mort (désinstallé, permission révoquée...) : nettoyage automatique
          await adminClient.from("push_subscriptions").delete().eq("id", s.id);
        }
      }
    }

    return new Response(JSON.stringify({ sent, failed, total: (subs || []).length }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500 });
  }
});
