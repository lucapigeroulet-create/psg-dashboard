// Edge Function : rappel push quotidien "État de forme", déclenchée par pg_cron (pas par un joueur).
// Contrairement à send-push, elle n'est jamais appelée depuis le navigateur : pas de JWT
// utilisateur, protégée par un secret partagé (header x-cron-secret) au lieu d'un rôle.
//
// pg_cron ne connaît que l'heure UTC de la base (pas le fuseau France). Pour tomber juste
// sur 8h heure de Paris été comme hiver, deux tâches sont programmées (6h et 7h UTC) et
// cette fonction ne fait rien si l'heure de Paris au moment de l'appel n'est pas 8h.
//
// Secret requis côté Supabase (Project Settings > Edge Functions > Secrets) : CRON_SECRET
// (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY déjà présents)

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

webpush.setVapidDetails("mailto:contact@statfield.app", VAPID_PUBLIC, VAPID_PRIVATE);

function parisHourNow(): number {
  const hourStr = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    hour12: false
  }).format(new Date());
  return parseInt(hourStr, 10);
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Permet un test manuel immédiat (curl avec {"test":true}) sans attendre 8h à Paris.
  // pg_cron n'envoie jamais ce flag, donc les tirs automatiques restent gatés normalement.
  let isTest = false;
  try { isTest = (await req.clone().json())?.test === true; } catch (_e) { /* corps vide, ok */ }

  // Les deux tirs quotidiens (6h et 7h UTC) appellent la même fonction : celui qui ne
  // correspond pas à 8h heure de Paris ce jour-là (selon l'heure d'été/hiver) ne fait rien.
  if (!isTest && parisHourNow() !== 8) {
    return new Response(JSON.stringify({ skipped: true, reason: "pas 8h à Paris" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: subs, error: subsErr } = await adminClient.from("push_subscriptions").select("*");
  if (subsErr) return new Response(JSON.stringify({ error: subsErr.message }), { status: 500 });

  const payload = JSON.stringify({
    title: "🧠 État de forme",
    body: "Pense à remplir ton état de forme du jour !",
    url: "/"
  });

  let sent = 0, failed = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload);
      sent++;
    } catch (e) {
      failed++;
      const statusCode = e && (e.statusCode || e.status);
      if (statusCode === 410 || statusCode === 404) {
        await adminClient.from("push_subscriptions").delete().eq("id", s.id);
      }
    }
  }

  return new Response(JSON.stringify({ sent, failed, total: (subs || []).length }), {
    headers: { "Content-Type": "application/json" }
  });
});
