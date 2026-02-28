// modules/rules.js

function parseISODate(iso) {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Ventana: estrenos ES en los últimos N días (default 14).
 * Incluye si releaseDateES existe y está dentro de la ventana.
 */
export function isInSpainReleaseWindow(item, days = 14, now = new Date()) {
  const d = parseISODate(item.releaseDateES);
  if (!d) return false;

  const ms = now.getTime() - d.getTime();
  const diffDays = ms / (1000 * 60 * 60 * 24);

  return diffDays >= 0 && diffDays <= days;
}

/**
 * Filtro por plataformas y géneros (OR por defecto).
 * @param {Object} item
 * @param {Object} state
 * @param {string[]} state.platformsSelected
 * @param {string[]} state.genresSelected
 */
export function passesUIFilters(item, state) {
  const pSel = state.platformsSelected ?? [];
  const gSel = state.genresSelected ?? [];

  const itemPlatforms = (item.platforms ?? []).map((x) => String(x));
  const itemGenres = (item.genres ?? []).map((x) => String(x));

  const platformOK =
    !pSel.length || pSel.some((p) => itemPlatforms.includes(p));

  const genreOK =
    !gSel.length || gSel.some((g) => itemGenres.includes(g));

  return platformOK && genreOK;
}
