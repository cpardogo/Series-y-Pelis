// modules/ranking.js

/**
 * Pesos fijos (cuando hay todas las fuentes).
 * Si faltan fuentes, reescalamos automáticamente con lo disponible (sin penalizar por faltantes).
 */
const WEIGHTS = {
  imdb: 0.25,
  fa: 0.25,
  rtCrit: 0.125,
  rtAudience: 0.125,
  mcCrit: 0.125,
  mcUser: 0.125,
};

function toNumber(x) {
  if (x === null || x === undefined) return null;
  const n = typeof x === "string" ? Number(x.replace(",", ".")) : Number(x);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// --- Normalizadores a escala 0..100 ---
function normImdb(v) {
  const n = toNumber(v);
  if (n == null) return null;
  return clamp(n, 0, 10) * 10;
}
function normFa(v) {
  const n = toNumber(v);
  if (n == null) return null;
  return clamp(n, 0, 10) * 10;
}
function normPct(v) {
  const n = toNumber(v);
  if (n == null) return null;
  return clamp(n, 0, 100);
}
function normMcUser(v) {
  const n = toNumber(v);
  if (n == null) return null;
  return clamp(n, 0, 10) * 10;
}

/**
 * Lee ratings desde múltiples posibles paths para ser tolerantes con tu JSON.
 * Ajusta/añade aquí si tus campos se llaman distinto.
 */
function readRatings(item) {
  const imdbRaw =
    item?.ratings?.imdb?.rating ??
    item?.imdb?.rating ??
    item?.imdb_rating ??
    item?.imdbRating ??
    null;

  const faRaw =
    item?.ratings?.fa?.rating ??
    item?.fa?.rating ??
    item?.fa_rating ??
    item?.faRating ??
    null;

  const rtCritRaw =
    item?.ratings?.rt?.critics ??
    item?.rt?.critics ??
    item?.rt_critics ??
    item?.rtCritics ??
    null;

  const rtAudienceRaw =
    item?.ratings?.rt?.audience ??
    item?.rt?.audience ??
    item?.rt_audience ??
    item?.rtAudience ??
    null;

  const mcCritRaw =
    item?.ratings?.mc?.critics ??
    item?.mc?.critics ??
    item?.mc_critics ??
    item?.mcCritics ??
    null;

  const mcUserRaw =
    item?.ratings?.mc?.users ??
    item?.mc?.users ??
    item?.mc_users ??
    item?.mcUsers ??
    null;

  return { imdbRaw, faRaw, rtCritRaw, rtAudienceRaw, mcCritRaw, mcUserRaw };
}

/**
 * Reglas:
 * - Requisito mínimo para publicar: IMDb o FA (al menos uno)
 * - RT/MC opcionales: si faltan, reescala pesos con lo disponible
 * - Score final 0..100
 * - coverage: % de fuentes presentes (de 6)
 */
export function computeScore(item) {
  const { imdbRaw, faRaw, rtCritRaw, rtAudienceRaw, mcCritRaw, mcUserRaw } = readRatings(item);

  const imdb = normImdb(imdbRaw);
  const fa = normFa(faRaw);
  const rtCrit = normPct(rtCritRaw);
  const rtAudience = normPct(rtAudienceRaw);
  const mcCrit = normPct(mcCritRaw);
  const mcUser = normMcUser(mcUserRaw);

  // Requisito mínimo: IMDb o FA
  const hasCore = imdb != null || fa != null;
  if (!hasCore) {
    return {
      publishable: false,
      score: null,
      coverage: 0,
      weights_used: 0,
      missing: ["imdb/fa"],
    };
  }

  const parts = [
    ["imdb", imdb],
    ["fa", fa],
    ["rtCrit", rtCrit],
    ["rtAudience", rtAudience],
    ["mcCrit", mcCrit],
    ["mcUser", mcUser],
  ];

  let weightedSum = 0;
  let wSum = 0;
  const missing = [];

  for (const [k, v] of parts) {
    if (v == null) {
      missing.push(k);
      continue;
    }
    const w = WEIGHTS[k];
    weightedSum += w * v;
    wSum += w;
  }

  // Reescala para no penalizar por faltantes
  const score = wSum > 0 ? weightedSum / wSum : null;

  const present = parts.filter(([, v]) => v != null).length;
  const coverage = Math.round((present / parts.length) * 100);

  return {
    publishable: true,
    score: score == null ? null : Math.round(score * 10) / 10, // 1 decimal
    coverage,
    weights_used: Math.round(wSum * 1000) / 1000,
    missing,
  };
}

/**
 * Orden recomendado:
 * 1) score desc
 * 2) coverage desc (desempate)
 * 3) (opcional) popularidad / nº votos si existe
 */
export function sortByRanking(a, b) {
  const A = a?.ranking ?? computeScore(a);
  const B = b?.ranking ?? computeScore(b);

  if (A.publishable !== B.publishable) return A.publishable ? -1 : 1;

  if (A.score == null && B.score == null) return 0;
  if (A.score == null) return 1;
  if (B.score == null) return -1;

  if (B.score !== A.score) return B.score - A.score;
  if (B.coverage !== A.coverage) return B.coverage - A.coverage;

  // Desempate opcional por nº votos si lo tienes
  const aVotes = toNumber(a?.ratings?.imdb?.votes ?? a?.imdb_votes ?? a?.imdbVotes ?? null) ?? 0;
  const bVotes = toNumber(b?.ratings?.imdb?.votes ?? b?.imdb_votes ?? b?.imdbVotes ?? null) ?? 0;
  if (bVotes !== aVotes) return bVotes - aVotes;

  return 0;
}