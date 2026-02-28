// modules/coverage.js

/**
 * Calcula cobertura y devuelve:
 * - status: "ok" | "partial" | "low"
 * - score: number
 * - missing: string[]
 */
export function computeCoverage(item) {
  const missing = [];

  const hasReleaseES = Boolean(item.releaseDateES);
  const hasPlatform = Array.isArray(item.platforms) && item.platforms.length > 0;
  const hasGenres = Array.isArray(item.genres) && item.genres.length > 0;

  const hasIMDb = item.imdb && typeof item.imdb.rating === "number";
  const hasFA = item.fa && typeof item.fa.rating === "number";

  if (!hasReleaseES) missing.push("Fecha estreno ES");
  if (!hasPlatform) missing.push("Plataforma");
  if (!hasGenres) missing.push("Género");
  if (!hasIMDb) missing.push("IMDb");
  if (!hasFA) missing.push("Filmaffinity");

  // Pesos
  let score = 0;
  if (hasReleaseES) score += 3;
  if (hasPlatform) score += 2;
  if (hasGenres) score += 1;
  if (hasIMDb) score += 2;
  if (hasFA) score += 2;

  let status = "low";
  if (score >= 9) status = "ok";
  else if (score >= 6) status = "partial";

  return { status, score, missing };
}

/**
 * Devuelve texto corto para badge.
 */
export function coverageBadgeText(status) {
  if (status === "ok") return "✅ Completo";
  if (status === "partial") return "⚠️ Parcial";
  return "❌ Baja";
}
