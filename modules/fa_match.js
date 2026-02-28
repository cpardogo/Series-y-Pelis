// modules/fa_match.js
import { normalizeTitle, tokenSimilarity } from "./title_normalize.js";

/**
 * @typedef {Object} FACandidate
 * @property {string} title           - Título en FA
 * @property {"movie"|"series"|string} type  - Tipo en FA
 * @property {number|null} year       - Año (si FA lo trae)
 * @property {string|null} url        - Link (opcional)
 * @property {number|null} rating     - Nota FA (opcional)
 */

/**
 * Reglas duras: si no las cumple, se descarta.
 */
function hardReject(item, cand) {
  // 1) Tipo obligatorio
  const itType = item.type; // "movie" o "series"
  const faType = cand.type;

  if (itType === "movie" && faType !== "movie") return true;
  if (itType === "series" && faType !== "series") return true;

  // 2) Año (si lo tenemos en ambos)
  if (Number.isFinite(item.year) && Number.isFinite(cand.year)) {
    if (Math.abs(item.year - cand.year) > 1) return true;
  }

  return false;
}

/**
 * Score final: prioriza título + año + exactitud.
 */
function scoreCandidate(item, cand) {
  const tSim = tokenSimilarity(item.title, cand.title); // 0..1

  let score = 0;
  score += tSim * 100;

  // Bonus si el título normalizado es exactamente igual
  if (normalizeTitle(item.title) === normalizeTitle(cand.title)) score += 25;

  // Bonus por año cercano
  if (Number.isFinite(item.year) && Number.isFinite(cand.year)) {
    const diff = Math.abs(item.year - cand.year);
    score += diff === 0 ? 18 : diff === 1 ? 10 : 0;
  }

  // Pequeño bonus si tiene rating y url (señal de ficha completa)
  if (cand.rating != null) score += 3;
  if (cand.url) score += 2;

  return score;
}

/**
 * @param {Object} item
 * @param {FACandidate[]} candidates
 * @param {Object} [opts]
 * @param {number} [opts.minTitleSim] - umbral para aceptar (default 0.45)
 * @returns {FACandidate|null}
 */
export function pickBestFA(item, candidates = [], opts = {}) {
  const minTitleSim = opts.minTitleSim ?? 0.45;

  const filtered = candidates.filter((c) => !hardReject(item, c));
  if (!filtered.length) return null;

  const ranked = filtered
    .map((c) => ({ c, s: scoreCandidate(item, c) }))
    .sort((a, b) => b.s - a.s);

  // Validación final: que la similaridad mínima sea decente
  const best = ranked[0].c;
  const sim = tokenSimilarity(item.title, best.title);

  if (sim < minTitleSim) return null;
  return best;
}
