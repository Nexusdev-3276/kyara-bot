/* ============================================================================
 * Kyara — farm serveur (portage du coeur de l'extension, sans navigateur)
 * ----------------------------------------------------------------------------
 * Ouvre UNIQUEMENT le gratuit : packs du jour, dons, stock freePacks+bonusPacks.
 * Chaque ouverture envoie maxChakra: 0 -> aucune depense possible.
 * Reclame les quetes et fait les actions simples (fiches, wishlist).
 * Recycle / mise en vente : desactive par defaut (actions irreversibles).
 * ==========================================================================*/

import { solveAnubis } from "./anubis.mjs";

let TOKEN = process.env.KYARA_TOKEN || "";
const ONCE = process.argv.includes("--once");
const BASE = "https://kyara.games";
const POLL = Math.max(15, Number(process.env.POLL_SECONDS || 60));
const DO_QUESTS = String(process.env.DO_QUESTS || "true") !== "false";
const SELL_DUPES = String(process.env.SELL_DUPES || "false") === "true";
const SELL_RARITIES = new Set(
  String(process.env.SELL_RARITIES || "C,U,R,E")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
);
// Securite absolue : jamais Legendaire ni Mythique, meme si la variable est mal configuree.
SELL_RARITIES.delete("L");
SELL_RARITIES.delete("M");
const MAX_LISTINGS_PER_RUN = Math.max(1, Number(process.env.MAX_LISTINGS_PER_RUN || 3));
const DRY_RUN = String(process.env.DRY_RUN || "false") === "true";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
let LABEL = process.env.ACCOUNT_LABEL || "kyara";
const log = (...a) => console.log(`[${now()}] [${LABEL}]`, ...a);

// Proxy support: set PROXY_URL env var to route requests through a proxy.
// Supports HTTP and HTTPS proxies (e.g. http://user:pass@host:port).
// Un Agent undici explicite est utilise pour tolerer les handshakes TLS lents
// (Kyara peut mettre ~10 s a répondre aux IP de datacenter).
import { Agent as UndiciAgent, ProxyAgent, fetch as undiciFetch } from "undici";

const PROXY_URL = process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
let proxyDispatcher;
if (PROXY_URL) {
  proxyDispatcher = new ProxyAgent(PROXY_URL);
  log("Proxy active:", PROXY_URL.replace(/\/\/[^@]*@/, "//***@"));
} else {
  proxyDispatcher = new UndiciAgent({
    connect: { timeout: 45000 },
    keepAliveTimeout: 60000,
    keepAliveMaxTimeout: 120000,
    // Une seule connexion : le challenge Anubis et les appels API partent
    // ainsi de la meme IP de sortie (le cookie Anubis est lie a l'IP).
    connections: 1,
  });
}

// Le client web envoie un identifiant d'appareil stable sur chaque requete.
// Kyara peut refuser les appels sans lui (403 network_refused).
let DEVICE_ID = process.env.KYARA_DEVICE_ID || crypto.randomUUID();

function buildHeaders() {
  return {
    authorization: `Bearer ${TOKEN}`,
    origin: BASE,
    referer: `${BASE}/`,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    accept: "application/json",
    "x-device-id": DEVICE_ID,
  };
}
let HEADERS = buildHeaders();

/* ------------------------- Anubis (BotStopper) ------------------------- */
// kyara.games renvoie 403 verification_required tant qu'un challenge
// proof-of-work Anubis n'a pas ete resolu. On resout le challenge une fois,
// on garde le cookie en cache et on le renouvelle seulement s'il est refuse.

const ANUBIS_ENABLED = String(process.env.ANUBIS || "true") !== "false";
let anubisCookie = "";
let anubisExpiry = 0;
let anubisInFlight = null;

async function getAnubisCookie(force = false) {
  if (!ANUBIS_ENABLED) return "";
  if (!force && anubisExpiry && Date.now() < anubisExpiry - 60000) {
    return anubisCookie;
  }
  if (anubisInFlight) return anubisInFlight;

  anubisInFlight = (async () => {
    try {
      let result = null;
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          result = await solveAnubis(BASE, log, proxyDispatcher);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          // Site en maintenance : inutile de reessayer, on remonte l'info.
          if (e.maintenance) break;
          if (attempt === 0) {
            log("Anubis: 2e tentative dans 2s -", e.message);
            await sleep(2000);
          }
        }
      }
      if (lastError) throw lastError;
      if (result && result.cookie) {
        anubisCookie = result.cookie;
        anubisExpiry = result.expiresAt;
        log("Anubis: session obtenue");
      } else if (result === null) {
        // Page accessible sans challenge : inutile de re-tester a chaque appel.
        anubisCookie = "";
        anubisExpiry = Date.now() + 10 * 60 * 1000;
        log("Anubis: acces direct (pas de challenge)");
      } else {
        anubisCookie = "";
        anubisExpiry = 0;
      }
      return anubisCookie;
    } finally {
      anubisInFlight = null;
    }
  })();

  return anubisInFlight;
}

let rateUntil = 0;
let rateFails = 0;

async function api(path, opts = {}) {
  const wait = rateUntil - Date.now();
  if (wait > 0) await sleep(wait);

  const headers = { ...HEADERS };
  if (opts.body) headers["content-type"] = "application/json";
  const cookie = await getAnubisCookie();
  if (cookie) headers.cookie = cookie;

  const res = await undiciFetch(`${BASE}${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    dispatcher: proxyDispatcher,
  });

  let data = null;
  try { data = await res.json(); } catch { /* non JSON */ }

  // Cookie Anubis absent/expire : on resout le challenge et on reessaie une fois.
  // Kyara peut repondre verification_required ou network_refused selon la couche
  // qui bloque ; les deux signifient qu'il faut une session Anubis.
  if (
    res.status === 403 &&
    data &&
    (data.error === "verification_required" || data.error === "network_refused") &&
    !opts.anubisRetried
  ) {
    log("Anubis: verification demandee, resolution du challenge...");
    await getAnubisCookie(true);
    return api(path, { ...opts, anubisRetried: true });
  }

  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data && data.error;

    if (res.status === 429) {
      rateFails = Math.min(rateFails + 1, 4);
      const base = [30, 60, 120, 300][rateFails - 1] || 300;
      const ra = Number(res.headers.get("retry-after"));
      const waitMs = Math.min(300, Math.max(base, Number.isFinite(ra) ? ra : 0)) * 1000;
      rateUntil = Date.now() + waitMs;
      err.retryAfterMs = waitMs;
    }
    throw err;
  }

  rateFails = 0;
  return data;
}

/* ---------------------------- Farm gratuit ---------------------------- */

function packPrice(p) {
  return Number(p && (p.chakraPrice ?? p.price ?? 150));
}
function active(p, t) {
  return !p.schedule || (t >= p.schedule[0] && t < p.schedule[1]);
}

let catalog = null;
let catalogAt = 0;

async function getCatalog() {
  if (catalog && Date.now() - catalogAt < 6 * 3600 * 1000) return catalog;
  const raw = await api("/api/packs");
  catalog = (raw || []).filter((p) => p && p.id).map((p) => ({
    id: p.id,
    name: p.name || p.id,
    price: Numeric(p),
    usesFreePacks: (p.usesFreePacks ?? (packPrice(p) === 0)) ? 1 : 0,
    perDay: p.limit && p.limit.perDay ? Number(p.limit.perDay) : null,
    grantOnly: p.grantOnly ? 1 : 0,
    schedule: p.schedule ? [Date.parse(p.schedule.start), Date.parse(p.schedule.end)] : null,
  }));
  catalogAt = Date.now();
  return catalog;
}
function Numeric(p) { return Number(p.chakraPrice ?? p.price ?? 0); }

function buildPlan(cat, me, packState) {
  const t = Date.now();
  const limits = (packState && packState.limits) || {};
  const grants = (me && me.grants) || {};
  const pool = Number((me && me.freePacks) || 0) + Number((me && me.bonusPacks) || 0);
  const eligible = cat.filter((p) => p.usesFreePacks && active(p, t) && !p.grantOnly);
  const primary = eligible.find((p) => p.id === "all") || eligible[0] || null;

  const days = [], gifts = [], poolItems = [];

  for (const p of cat) {
    if (!active(p, t)) continue;
    const g = Number(grants[p.id] || 0);
    if (p.grantOnly && !g) continue;

    let left = null;
    if (limits[p.id] && Number.isFinite(limits[p.id].left)) left = limits[p.id].left;
    else if (p.perDay) left = p.perDay;
    if (left !== null && left <= 0) continue;

    const isPool = !!p.usesFreePacks;
    const isFreeDaily = !isPool && !p.grantOnly && packPrice(p) <= 0;

    let avail = g;
    if (isPool && primary && p.id === primary.id && pool > 0) avail += pool;
    if (isFreeDaily && left !== null) avail += left;
    if (avail <= 0) continue;
    if (left !== null) avail = Math.min(avail, left);

    const item = {
      id: p.id,
      name: p.name,
      count: Math.min(avail, 10),
      kind: isFreeDaily ? "jour" : (g > 0 ? "don" : "stock"),
    };
    if (isFreeDaily) days.push(item);
    else if (g > 0) gifts.push(item);
    else poolItems.push(item);
  }

  for (const id of Object.keys(grants)) {
    const g = Number(grants[id] || 0);
    if (g <= 0 || cat.some((p) => p.id === id)) continue;
    const left = limits[id] && Number.isFinite(limits[id].left) ? limits[id].left : null;
    const c = left !== null ? Math.min(g, left) : g;
    if (c > 0) gifts.push({ id, name: id, count: Math.min(c, 10), kind: "don" });
  }

  return days.concat(gifts, poolItems);
}

/* ---------------------------- Quetes ---------------------------- */

const HANDLED = new Set(["open-1", "open-5", "recycle-1", "recycle-10", "wishlist-3", "detail-1", "details-3", "list-1"]);

async function runQuests() {
  if (!DO_QUESTS) return;
  const p = await api("/api/me/progress");
  if (!p) return;

  if (p.claimable > 0) {
    const res = await api("/api/me/progress/claim", { method: "POST", body: { kind: "all" } });
    const g = (res && res.gained) || {};
    const bits = [];
    if (g.chakra) bits.push(`+${g.chakra} chakra`);
    if (g.bonusPacks) bits.push(`+${g.bonusPacks} boosters bonus`);
    log("Quetes reclamees", bits.length ? `(${bits.join(", ")})` : "");
  }

  const welcome = (p.welcome && p.welcome.quests) || [];
  const daily = (p.daily && p.daily.missions) || [];
  const find = (list, id) => list.find((q) => q.id === id);

  // Consulter des fiches
  const d1 = find(welcome, "detail-1");
  const d3 = find(daily, "details-3");
  let needDetail = 0;
  if (d1 && !d1.done) needDetail += Math.max(1, (d1.target || 1) - (d1.progress || 0));
  if (d3 && !d3.done) needDetail += Math.max(1, (d3.target || 3) - (d3.progress || 0));
  if (needDetail > 0) {
    try {
      const col = await api("/api/me/collection?lean=1");
      const ids = (col || []).map((x) => x && x.characterId).filter((x) => x != null);
      let ok = 0;
      for (const id of ids.slice(0, needDetail + 6)) {
        if (ok >= needDetail) break;
        try { await api(`/api/characters/${encodeURIComponent(id)}/detail`); ok++; } catch {}
        await sleep(1000);
      }
      if (ok) log(`Fiches consultees pour les quetes (${ok})`);
    } catch (e) { log("Fiches: echec", e.message); }
  }

  // Wishlist
  const wl = find(welcome, "wishlist-3");
  if (wl && !wl.done) {
    try {
      const need = Math.max(1, (wl.target || 3) - (wl.progress || 0));
      const [list, col, chars] = await Promise.all([
        api("/api/me/wishlist").catch(() => null),
        api("/api/me/collection?lean=1").catch(() => []),
        api("/api/characters").catch(() => []),
      ]);
      const owned = new Set((col || []).map((x) => x && x.characterId));
      const wished = new Set(Array.isArray(list) ? list.map((x) => (x && (x.characterId ?? x.id)) ?? x) : []);
      let ok = 0;
      for (const c of chars || []) {
        if (ok >= need) break;
        if (!c || c.id == null || owned.has(c.id) || wished.has(c.id)) continue;
        try { await api(`/api/me/wishlist/${encodeURIComponent(c.id)}`, { method: "PUT" }); ok++; } catch {}
        await sleep(1000);
      }
      if (ok) log(`Wishlist: ${ok} perso(s) ajoute(s)`);
    } catch (e) { log("Wishlist: echec", e.message); }
  }

  // Recyclage / vente : le mode deploye vend les doublons (voir sellDuplicates).
  const r10 = find(daily, "recycle-10");
  if (r10 && !r10.done) {
    log('Quete "Recycle 10 doublons" non faite (mode vente des doublons actif).');
  }

  const missing = [];
  for (const list of [welcome, daily]) {
    for (const q of list) {
      if (q && !q.done && !HANDLED.has(q.id)) missing.push(q.label || q.id);
    }
  }
  if (missing.length) log("Quetes non gerees (a faire a la main):", missing.slice(0, 6).join(" | "));
}

/* ---------------------------- Vente des doublons ---------------------------- */

let rarityMap = null;
let rarityAt = 0;

async function getRarityMap() {
  if (rarityMap && Date.now() - rarityAt < 22 * 3600 * 1000) return rarityMap;
  const chars = await api("/api/characters");
  rarityMap = new Map((chars || []).map((c) => [c.id, c.rarity || "?"]));
  rarityAt = Date.now();
  return rarityMap;
}

let configCache = null;
let configAt = 0;

async function getConfig() {
  if (configCache && Date.now() - configAt < 6 * 3600 * 1000) return configCache;
  configCache = await api("/api/config");
  configAt = Date.now();
  return configCache;
}

async function lowestPrice(characterId) {
  try {
    const data = await api(
      `/api/market/listings?type=fixed&characterId=${encodeURIComponent(characterId)}&sort=price_asc&pageSize=10&page=1`
    );
    const prices = ((data && data.items) || [])
      .filter((x) => x && x.status === "active" && !x.isMine)
      .map((x) => Number(x.price))
      .filter((n) => Number.isFinite(n) && n > 0);
    return prices.length ? Math.min(...prices) : null;
  } catch {
    return null;
  }
}

async function sellDuplicates() {
  if (!SELL_DUPES || !SELL_RARITIES.size) return;

  try {
    const access = await api("/api/me/market/access");
    if (!access || !access.allowed) {
      log("Vente doublons: marche inaccessible", (access && access.reasons && access.reasons[0]) || "");
      return;
    }

    const mine = await api("/api/me/market").catch(() => null);
    const active = ((mine && mine.listings) || []).filter((x) => x && x.status === "active");
    const limit = Number((me && me.marketLimits && me.marketLimits.listings) || 10);
    let slots = Math.max(0, limit - active.length);
    if (slots <= 0) {
      log(`Vente doublons: ${limit} annonces actives, aucune place libre.`);
      return;
    }

    const col = await api("/api/me/collection?lean=1");
    const rarity = await getRarityMap();
    const cfg = await getConfig();
    const recycle = (cfg && cfg.recycle) || {};
    const activeIds = new Set(active.map((x) => x && x.character && x.character.id).filter((x) => x != null));

    const now = Date.now();
    const candidates = (col || []).filter((x) => {
      if (!x || x.qty < 2 || x.locked || x.sellBlock || x.resaleLocked || x.listable === 0) return false;
      if (x.resaleUntil && Date.parse(x.resaleUntil) > now) return false;
      const r = rarity.get(x.characterId);
      if (!r || !SELL_RARITIES.has(r)) return false;
      if (activeIds.has(x.characterId)) return false;
      return true;
    });

    // Les plus values d'abord : E, R, U, C.
    const rank = { E: 0, R: 1, U: 2, C: 3 };
    candidates.sort((a, b) => {
      const ra = rank[rarity.get(a.characterId)] ?? 9;
      const rb = rank[rarity.get(b.characterId)] ?? 9;
      return ra - rb || b.qty - a.qty;
    });

    let listed = 0;
    for (const card of candidates) {
      if (listed >= MAX_LISTINGS_PER_RUN || slots <= 0) break;

      const r = rarity.get(card.characterId);
      const floor = await lowestPrice(card.characterId);
      const minPrice = Math.max(1, Number(recycle[r] || 1));
      const price = Math.max(minPrice, floor ? Math.floor(floor) - 1 : 0);

      const fee = Math.max(1, Math.ceil((price * 2) / 100));
      const tax = Math.floor((price * 5) / 100);
      const net = price - fee - tax;
      if (!Number.isFinite(price) || price < 1 || net <= 0) {
        log(`Vente doublons: perso ${card.characterId} (${r}) ignore (prix ${price}, net ${net}).`);
        continue;
      }
      if (Number(me.chakra || 0) < fee) {
        log(`Vente doublons: pas assez de chakra pour les frais (${fee}).`);
        break;
      }

      if (DRY_RUN) {
        listed++;
        slots--;
        log(`[DRY] Vente doublon: perso ${card.characterId} (${r}) a ${price} chakra (frais ${fee}, 12h).`);
        continue;
      }

      try {
        const res = await api("/api/market/listings", {
          method: "POST",
          body: { characterId: card.characterId, type: "fixed", price, buyoutPrice: null, durationHours: 12 },
        });
        listed++;
        slots--;
        if (res && res.user) me = res.user;
        else me.chakra = Number(me.chakra || 0) - fee;
        const matched = !!(res && res.matched);
        log(`Vente doublon: perso ${card.characterId} (${r}) a ${price} chakra (frais ${fee}, 12h)${matched ? " - vendu aussitot" : ""}.`);
      } catch (e) {
        if (e.status === 429) {
          log(`Vente doublons: 429, pause ${Math.round((rateUntil - Date.now()) / 1000)} s.`);
          break;
        }
        log(`Vente doublons: echec perso ${card.characterId}: ${e.message}`);
      }

      await sleep(1500);
    }

    if (listed === 0) log("Vente doublons: aucun doublon rentable a mettre en vente.");
  } catch (e) {
    log("Vente doublons: echec", e.message);
  }
}

/* ---------------------------- Boucle ---------------------------- */

let lastFarmLog = "";
let me = null;

export function setAccount({ token, label, device }) {
  if (!token) throw new Error("token manquant");
  TOKEN = token;
  LABEL = label || "kyara";
  DEVICE_ID = device || process.env.KYARA_DEVICE_ID || crypto.randomUUID();
  HEADERS = buildHeaders();
  me = null;
  lastFarmLog = "";
}

export function getSnapshot() {
  return {
    pseudo: me && me.pseudo,
    chakra: me && me.chakra,
    freePacks: me && me.freePacks,
    nextFreeAt: me && me.nextFreeAt,
  };
}

// Verification legere : un seul bootstrap, sans quetes ni vente.
// Sert au cron 1-2 min : on n'ouvre que si un booster est disponible.
export async function checkOnce() {
  const boot = await api("/api/me/bootstrap");
  if (boot && boot.me) me = boot.me;

  const free = Number((me && me.freePacks) || 0);
  const bonus = Number((me && me.bonusPacks) || 0);
  const grants = (me && me.grants) || {};
  const hasGrants = Object.values(grants).some((x) => Number(x) > 0);

  return {
    ready: free + bonus > 0 || hasGrants,
    bonusPacks: bonus,
    hasGrants,
    ...getSnapshot(),
  };
}

const MAX_ROUNDS = 5;
const MAX_BOOSTERS = 100;

async function tick() {
  let openedBatches = 0;
  let boosters = 0;
  let lastWait = POLL * 1000;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const boot = await api("/api/me/bootstrap");
    me = boot.me || me;

    const free = Number((me && me.freePacks) || 0);
    const bonus = Number((me && me.bonusPacks) || 0);
    const pool = free + bonus;
    const hasGrants = !!(me && me.grants && Object.values(me.grants).some((x) => Number(x) > 0));

    let plan = [];
    if (pool > 0 || hasGrants) {
      try {
        const cat = await getCatalog();
        const state = await api("/api/me/packs").catch(() => null);
        plan = buildPlan(cat, me, state);
      } catch (e) {
        log("Plan: echec", e.message);
      }
    }

    if (!plan.length) {
      const nf = me && me.nextFreeAt ? Date.parse(me.nextFreeAt) : 0;
      lastWait = nf > Date.now() ? Math.min(15 * 60 * 1000, nf - Date.now() + 2000) : POLL * 1000;
      break;
    }

    const sig = plan.map((i) => `${i.id}x${i.count}`).join("+");
    if (sig !== lastFarmLog) {
      lastFarmLog = sig;
      log("Farm gratuit:", plan.map((i) => `${i.name} x${i.count}`).join(" + "));
    }

    let roundOpened = 0;
    for (const item of plan) {
      if (boosters >= MAX_BOOSTERS) break;
      let count = Math.max(0, Math.min(10, Number(item.count) || 0));
      count = Math.min(count, MAX_BOOSTERS - boosters);
      if (count <= 0) continue;

      try {
        const payload = await api(`/api/packs/${encodeURIComponent(item.id)}/open-many`, {
          method: "POST",
          body: { count, maxChakra: 0 },
        });
        const results = (payload && payload.results) || [];
        let cards = 0, news = 0, best = null;
        const rank = { C: 0, U: 1, R: 2, E: 3, L: 4, M: 5 };
        for (const r of results) {
          for (const c of r.cards || []) {
            cards++;
            if (c.isNew) news++;
            if (!best || (rank[c.rarity] ?? -1) > (rank[best.rarity] ?? -1)) best = c;
          }
          if (r.user) me = r.user;
        }
        openedBatches++;
        roundOpened++;
        boosters += count;
        log(`${item.name} x${count} -> ${cards} cartes, ${news} nouvelles${best ? `, meilleure: ${best.name} (${best.rarity})` : ""}`);
      } catch (e) {
        if (e.status === 429) {
          log(`429 - pause ${Math.round((rateUntil - Date.now()) / 1000)} s`);
          return 5000;
        }
        if (e.status === 401) {
          log("Session invalide (401). Le token a expire : recupere un nouveau kyara_token.");
          return 5 * 60 * 1000;
        }
        log(`Echec ${item.name} x${count}:`, e.message);
      }

      await sleep(2500);
    }

    if (roundOpened === 0) break;
    await sleep(1500);
  }

  try {
    await runQuests();
  } catch (e) {
    log("Quetes: echec", e.message);
  }

  if (openedBatches === 0) {
    log(`Rien de gratuit a ouvrir. Prochain booster dans ~${Math.round(lastWait / 1000)} s.`);
  } else {
    log(`Run terminee : ${boosters} booster(s) ouvert(s) en ${openedBatches} lot(s).`);
  }

  return lastWait;
}

export async function runOnce() {
  return await tick();
}

async function main() {
  if (!TOKEN) {
    console.error("KYARA_TOKEN manquant (variable d'environnement).");
    process.exit(1);
  }

  log(`Kyara server bot demarre${ONCE ? " (run unique)" : ""}. Farm gratuit uniquement (maxChakra=0).`);

  if (ONCE) {
    try {
      await tick();
      process.exit(0);
    } catch (e) {
      if (e.status === 401) {
        log("Token invalide (401). Mets a jour KYARA_TOKEN.");
        process.exit(2);
      }
      log("Erreur:", e.status || "", e.message);
      process.exit(1);
    }
  }

  // Optionnel : si tu veux aussi une pause avant le tout premier run au demarrage.
  const initialDelay = 1800000 + Math.random() * 600000;
  log(`Premiere attente aleatoire de ${Math.round(initialDelay / 60000)} minutes avant le premier run.`);
  await sleep(initialDelay);

  for (;;) {
    let wait = POLL * 1000;
    try {
      wait = await tick();
    } catch (e) {
      if (e.status === 401) {
        log("Token invalide (401). Arret ; mets a jour KYARA_TOKEN puis relance.");
        process.exit(2);
      }
      if (e.status === 429) {
        wait = 5000;
      } else {
        log("Erreur:", e.status || "", e.message);
        wait = 60 * 1000;
      }
    }
    const randomDelay = 1800000 + Math.random() * 600000;
    await sleep(randomDelay);
  }
}

const isDirectRun = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("kyara-bot.mjs");
if (isDirectRun) main();
