/* ============================================================================
 * Anubis (BotStopper) proof-of-work solver - Node.js port of the browser worker
 * ----------------------------------------------------------------------------
 * kyara.games est protege par Anubis. Sans le cookie delivre apres resolution
 * du challenge, toutes les routes /api/* repondent 403
 * {"error":"verification_required"}.
 *
 * Ce module ouvre la page d'accueil, lit le challenge "soteria", execute le
 * WASM officiel du site, resout le proof-of-work et recupere le cookie
 * d'authentification Anubis. Le cookie est mis en cache et renouvele quand il
 * expire.
 * ==========================================================================*/

import { fetch as undiciFetch } from "undici";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function jsonScript(html, id) {
  const re = new RegExp(
    `<script id="${id}" type="application/json">([\\s\\S]*?)</script>`
  );
  const m = html.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function setCookies(res) {
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const raw = res.headers.get("set-cookie") || "";
  // Split on commas that start a new cookie (name=value), not on Expires dates.
  return raw.split(/,(?=\s*[^;,=\s]+=)/).filter(Boolean);
}

function cookiePairs(res) {
  return setCookies(res)
    .map((c) => c.split(";")[0].trim())
    .filter((p) => p && !p.endsWith("="));
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

async function solveSoteria(info, log, dispatcher) {
  const wasmUrl = new URL(info.wasmURL, "https://kyara.games").toString();
  const wasmRes = await undiciFetch(wasmUrl, {
    headers: { "user-agent": DEFAULT_UA },
    dispatcher,
    signal: AbortSignal.timeout(20000),
  });
  if (!wasmRes.ok) throw new Error(`wasm fetch: HTTP ${wasmRes.status}`);
  const wasmBuffer = await wasmRes.arrayBuffer();

  const { instance } = await WebAssembly.instantiate(wasmBuffer, {});
  const e = instance.exports;

  const request = hexToBytes(info.request);
  const ptr = e.soteria_alloc(request.length);
  new Uint8Array(e.memory.buffer, ptr, request.length).set(request);

  let rc = e.soteria_solve(ptr, request.length);
  if (rc !== 0) throw new Error(`soteria_solve: ${rc}`);

  let attempts = 0;
  const t0 = Date.now();
  for (;;) {
    rc = e.soteria_step(32);
    attempts += 32 * 4;
    if (rc === 1) break;
    if (rc !== 0) throw new Error(`soteria_step: ${rc}`);
    if (Date.now() - t0 > 120000) throw new Error("soteria: timeout");
  }

  const noncesPtr = e.soteria_nonces();
  const noncesLen = e.soteria_nonces_len();
  const nonces = Array.from(
    new Uint32Array(e.memory.buffer, noncesPtr, noncesLen)
  );
  const fingerprint = BigInt
    .asUintN(64, e.soteria_fingerprint())
    .toString(16)
    .padStart(16, "0");

  if (log) log(`Anubis: challenge resolu en ${Date.now() - t0} ms (${attempts} essais)`);
  return { nonces, fingerprint };
}

/**
 * Recupere un cookie Anubis valide pour le domaine.
 * @returns {Promise<{cookie: string, expiresAt: number}|null>}
 *          null si la page n'a pas de challenge (acces deja autorise).
 */
export async function solveAnubis(base = "https://kyara.games", log = null, dispatcher = undefined) {
  const pageRes = await undiciFetch(`${base}/`, {
    headers: { "user-agent": DEFAULT_UA, accept: "text/html" },
    redirect: "manual",
    dispatcher,
    signal: AbortSignal.timeout(20000),
  });
  const html = await pageRes.text();

  const rawChallenge = jsonScript(html, "anubis_challenge");
  const info = jsonScript(html, "soteria_info");

  // Pas de challenge : soit la page n'est pas bloquee (acces direct), soit
  // Kyara renvoie une page d'erreur (522/503). On distingue les deux.
  if (!rawChallenge || !info) {
    if (pageRes.status !== 200) {
      const err = new Error(`Anubis: page d'accueil HTTP ${pageRes.status}`);
      err.status = pageRes.status;
      err.maintenance = pageRes.status === 503 || pageRes.status === 502 || pageRes.status === 504 || pageRes.status === 522;
      throw err;
    }
    if (log) log("Anubis: pas de challenge (acces direct)");
    return null;
  }

  // Selon la version d'Anubis, le challenge est imbrique sous "challenge".
  const challenge = rawChallenge.challenge || rawChallenge;

  const { nonces, fingerprint } = await solveSoteria(info, log, dispatcher);

  const passUrl = new URL(info.passURL, `${base}/`);
  passUrl.searchParams.set("id", challenge.id);
  passUrl.searchParams.set("nonces", nonces.join(","));
  passUrl.searchParams.set("fingerprint", fingerprint);
  passUrl.searchParams.set("redir", "/");
  passUrl.searchParams.set("elapsedTime", "1500");

  // Anubis lie le challenge au cookie de verification pose sur la page.
  const pageCookies = cookiePairs(pageRes);

  const passRes = await undiciFetch(passUrl.toString(), {
    headers: {
      "user-agent": DEFAULT_UA,
      accept: "text/html",
      ...(pageCookies.length ? { cookie: pageCookies.join("; ") } : {}),
    },
    redirect: "manual",
    dispatcher,
    signal: AbortSignal.timeout(20000),
  });

  const authCookies = cookiePairs(passRes).filter(
    (p) => !p.startsWith("techaro.lol-anubis-cookie-verification=")
  );

  if (!authCookies.length) {
    throw new Error(
      `Anubis: pas de cookie (HTTP ${passRes.status}) ${(await passRes.text()).slice(0, 200)}`
    );
  }

  const authCookie = authCookies.join("; ");
  return {
    cookie: authCookie,
    expiresAt: jwtExpiry(authCookie) || Date.now() + 3600 * 1000,
  };
}

/** Lit la date d'expiration (claim exp) du JWT Anubis. */
function jwtExpiry(cookie) {
  try {
    const value = cookie.slice(cookie.indexOf("=") + 1).trim();
    const payload = value.split(".")[1];
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
    );
    return json.exp ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}



