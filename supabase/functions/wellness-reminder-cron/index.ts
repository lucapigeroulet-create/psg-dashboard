// Edge Function : envoie les notifications push programmées (table notifications_programmees),
// déclenchée toutes les heures par pg_cron (jamais par un navigateur).
// Historiquement "wellness-reminder-cron" (rappel État de forme codé en dur) ; le nom est
// conservé pour ne pas casser l'URL appelée par pg_cron, mais la fonction est désormais
// générique : titre, texte, heure (Paris), jours et joueurs ciblés viennent de la table,
// gérée par le staff depuis l'onglet Messages du dashboard.
//
// Déployée manuellement via l'outil MCP Supabase (deploy_edge_function) — ce fichier
// est gardé dans le repo pour référence/historique, il n'y a pas de pipeline de déploiement.
//
// Protégée par un secret partagé (header x-cron-secret) au lieu d'un JWT utilisateur.
// pg_cron tire toutes les heures à :00 UTC ; l'heure de Paris est recalculée ici, donc
// l'heure d'été/hiver est gérée automatiquement.
//
// Secrets requis côté Supabase : CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
// (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY sont injectés automatiquement)

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

webpush.setVapidDetails("mailto:contact@statfield.app", VAPID_PUBLIC, VAPID_PRIVATE);

// Heure + jour de semaine actuels à Paris (jour selon la convention JS : 0=dimanche ... 6=samedi)
function parisNow(): { hour: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    hour12: false,
    weekday: "short"
  }).formatToParts(new Date());
  const hour = parseInt(parts.find((p) => p.type === "hour")!.value, 10);
  const wd = parts.find((p) => p.type === "weekday")!.value;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  return { hour, day };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Test manuel : {"test":true} envoie immédiatement toutes les notifications actives,
  // {"test":true,"id":"<uuid>"} seulement celle-là. pg_cron envoie toujours {} : les
  // tirs automatiques restent gatés sur l'heure/le jour normalement.
  let isTest = false;
  let testId: string | null = null;
  try {
    const body = await req.clone().json();
    isTest = body?.test === true;
    testId = typeof body?.id === "string" ? body.id : null;
  } catch (_e) { /* corps vide, ok */ }

  const { hour, day } = parisNow();
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: notifs, error: notifsErr } = await adminClient
    .from("notifications_programmees")
    .select("*")
    .eq("actif", true);
  if (notifsErr) return new Response(JSON.stringify({ error: notifsErr.message }), { status: 500 });

  const due = (notifs || []).filter((n) => {
    if (isTest) return testId ? n.id === testId : true;
    const jours = Array.isArray(n.jours) ? n.jours : [];
    return n.heure === hour && jours.includes(day);
  });
  if (due.length === 0) {
    return new Response(JSON.stringify({ skipped: true, hour, day }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  const { data: subs, error: subsErr } = await adminClient.from("push_subscriptions").select("*");
  if (subsErr) return new Response(JSON.stringify({ error: subsErr.message }), { status: 500 });

  // Les groupes ne sont résolus que si au moins une notification cible un groupe
  let joueurs: { nom: string; groupe: string | null; org: string }[] = [];
  if (due.some((n) => n.cible_type === "group")) {
    const { data } = await adminClient.from("joueurs").select("nom, groupe, org");
    joueurs = data || [];
  }

  const deadIds = new Set<string>();
  const results: { id: string; titre: string; sent: number; failed: number; total: number }[] = [];
  for (const n of due) {
    const cibleJoueurs: string[] = Array.isArray(n.cible_joueurs) ? n.cible_joueurs : [];
    const groupNoms = n.cible_type === "group"
      ? joueurs.filter((j) => j.org === n.org && j.groupe === n.cible_groupe).map((j) => j.nom)
      : [];
    const targets = (subs || []).filter((s) => {
      if (s.org !== n.org || deadIds.has(s.id)) return false;
      if (n.cible_type === "group") return groupNoms.includes(s.joueur_nom);
      if (n.cible_type === "players") return cibleJoueurs.includes(s.joueur_nom);
      return true; // 'all'
    });

    const payload = JSON.stringify({ title: n.titre, body: n.contenu, url: "/" });
    let sent = 0, failed = 0;
    for (const s of targets) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload);
        sent++;
      } catch (e) {
        failed++;
        const err = e as { statusCode?: number; status?: number };
        const statusCode = err && (err.statusCode || err.status);
        if (statusCode === 410 || statusCode === 404) {
          // Abonnement mort (désinstallé, permission révoquée...) : nettoyage automatique
          deadIds.add(s.id);
          await adminClient.from("push_subscriptions").delete().eq("id", s.id);
        }
      }
    }
    results.push({ id: n.id, titre: n.titre, sent, failed, total: targets.length });
  }

  return new Response(JSON.stringify({ hour, day, notifications: results }), {
    headers: { "Content-Type": "application/json" }
  });
});
