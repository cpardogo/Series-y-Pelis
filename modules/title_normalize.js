// modules/title_normalize.js
export function stripDiacritics(s = "") {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizeTitle(s = "") {
  const cleaned = stripDiacritics(String(s).toLowerCase())
    .replace(/&/g, "and")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Quita “ruido” típico que a veces se cuela en títulos
  return cleaned
    .replace(/\b(miniserie|mini serie|serie animacion|serie de animacion|temporada|season)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Similaridad simple (0..1) por tokens, suficiente para re-ranquear candidatos
export function tokenSimilarity(a, b) {
  const A = new Set(normalizeTitle(a).split(" ").filter(Boolean));
  const B = new Set(normalizeTitle(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;

  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;

  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}
