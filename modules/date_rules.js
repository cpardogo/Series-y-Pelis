// modules/date_rules.js

/**
 * True si dateStr cae dentro del año 2026 (incluye límites).
 * Acepta strings tipo "2026-03-15" o cualquier formato parseable por Date.
 */
export function isReleaseIn2026(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  return d >= new Date("2026-01-01T00:00:00") && d <= new Date("2026-12-31T23:59:59");
}

/**
 * Devuelve la mejor fecha disponible del item.
 * Orden de preferencia (ajusta si tus campos difieren):
 * - release_es (estreno España)
 * - release_date (general)
 * - date (fallback)
 */
export function getBestReleaseDate(item) {
  return item?.release_es ?? item?.release_date ?? item?.date ?? null;
}