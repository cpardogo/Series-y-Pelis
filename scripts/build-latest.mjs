import fs from "node:fs/promises";
import * as cheerio from "cheerio";

const TMDB_KEY = process.env.TMDB_API_KEY;
const OMDB_KEY = process.env.OMDB_API_KEY;

if (!TMDB_KEY) throw new Error("Missing TMDB_API_KEY secret");
if (!OMDB_KEY) throw new Error("Missing OMDB_API_KEY secret");

// ---------------------- helpers ----------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmdb = async (p, params = {}) => {
  const url = new URL(`https://api.themoviedb.org/3/${p}`);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TMDb error ${r.status} on ${p}`);
  return r.json();
};

const omdbByImdbId = async (imdbId) => {
  if (!imdbId) return null;
  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", OMDB_KEY);
  url.searchParams.set("i", imdbId);
  const r = await fetch(url);
  const j = await r.json();
  if (j?.Response === "False") return null;
  const rating = Number(j.imdbRating);
  return Number.isFinite(rating) ? rating : null;
};

// Normalización para limpiar sufijos de FA (“SerieAnimación”, “Miniserie”…)
function stripDiacritics(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// ---- Similaridad simple + normalización para matching ----
function normalizeTitle(s = "") {
  return stripDiacritics(String(s).toLowerCase())
    .replace(/&/g, "and")
    .replace(/[’'"]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSimilarity(a, b) {
  const A = new Set(normalizeTitle(a).split(" ").filter(Boolean));
  const B = new Set(normalizeTitle(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;

  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

// Detecta si una página de FA parece "series" o "movie" (heurística)
function detectFATypeFromPage($) {
  const txt = stripDiacritics($.text()).toLowerCase();

  // señales típicas de series
  const looksSeries =
    txt.includes("miniserie") ||
    txt.includes("serie de tv") ||
    txt.includes("serie") ||
    txt.includes("tv series") ||
    txt.includes("episodios") ||
    txt.includes("temporada");

  // señales típicas de película
  const looksMovie =
    txt.includes("pelicula") ||
    txt.includes("largometraje") ||
    txt.includes("cortometraje");

  if (looksSeries && !looksMovie) return "series";
  if (looksMovie && !looksSeries) return "movie";
  return null; // no concluyente
}

/**
 * Limpieza de títulos:
 * - quita paréntesis, parte tras ":" y comillas
 * - elimina sufijos típicos de FA al FINAL: SerieAnimación, Serie, Miniserie, etc (con/ sin acentos, pegados o separados)
 */
const cleanTitle = (t) => {
  if (!t) return null;

  let s = String(t)
    .replace(/\s*\(.*?\)\s*/g, " ") // quita (…)
    .replace(/\s*:\s*.*/g, "") // quita “: …”
    .replace(/[’'"]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Normaliza guiones
  s = s.replace(/\s*–\s*/g, " - ").replace(/\s*-\s*/g, " - ").trim();

  // Quitar sufijos al final
  const suffixes = [
    "serieanimacion",
    "serie animacion",
    "serie",
    "serietv",
    "serie tv",
    "serie de tv",
    "serie de television",
    "miniserie",
    "tv",
    "documental",
    "serie documental",
  ];

  // Intentamos borrar 1–2 sufijos encadenados (por si acaso)
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;

    for (const suf of suffixes) {
      const re = new RegExp(`(?:\\s*[\\-–—·•|/:]?\\s*)${suf}\\s*$`, "i");
      if (re.test(stripDiacritics(s).toLowerCase())) {
        s = s.replace(re, "").trim();
        changed = true;
      }
    }

    s = s.replace(/\s+/g, " ").trim();
    if (!changed) break;
  }

  return s || null;
};

function whereString({ platforms, inCinemasES }) {
  const p = Array.isArray(platforms) ? platforms.filter(Boolean) : [];
  if (p.length && inCinemasES) return `Cines · ${p.join(" · ")}`;
  if (p.length) return p.join(" · ");
  if (inCinemasES) return "Cines";
  return "España";
}

// Fecha ISO YYYY-MM-DD -> Date (UTC-ish)
function parseISODate(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).slice(0, 10) + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

// Ventana (últimos N días desde estreno ES)
function isInLastDays(isoDate, days, now = new Date()) {
  const d = parseISODate(isoDate);
  if (!d) return false;
  const diffDays = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= days;
}

// ---------------- TMDb: título ES + estreno ES + providers ES + géneros ----------------
async function getMovieESDetails(id) {
  const d = await tmdb(`movie/${id}`, { language: "es-ES" });

  // Estreno ES + flag "cines"
  let releaseES = d.release_date || null;
  let inCinemasES = false;

  try {
    const rd = await tmdb(`movie/${id}/release_dates`);
    const es = (rd.results || []).find((x) => x.iso_3166_1 === "ES");
    const rds = es?.release_dates || [];
    const date = rds?.[0]?.release_date;
    if (date) releaseES = date.slice(0, 10);
    if (rds.some((x) => x?.type === 3 || x?.type === 2)) inCinemasES = true; // theatrical/limited
  } catch {}

  // Providers ES
  let platforms = [];
  try {
    const wp = await tmdb(`movie/${id}/watch/providers`);
    const es = wp.results?.ES;
    const list = [
      ...(es?.flatrate || []),
      ...(es?.rent || []),
      ...(es?.buy || []),
      ...(es?.free || []),
      ...(es?.ads || []),
    ];
    const uniq = new Map();
    for (const p of list) {
      if (!p?.provider_id) continue;
      uniq.set(p.provider_id, p.provider_name || `Provider ${p.provider_id}`);
    }
    platforms = [...uniq.values()].slice(0, 8);
  } catch {}

  const genres = Array.isArray(d.genres) ? d.genres.map((g) => g.name).filter(Boolean) : [];

  return {
    titleEs: d.title || null,
    titleOriginal: d.original_title || null,
    releaseES,
    platforms,
    inCinemasES,
    genres,
  };
}

async function getSeriesESDetails(id) {
  const d = await tmdb(`tv/${id}`, { language: "es-ES" });

  const releaseES = d.first_air_date || null;

  let platforms = [];
  try {
    const wp = await tmdb(`tv/${id}/watch/providers`);
    const es = wp.results?.ES;
    const list = [
      ...(es?.flatrate || []),
      ...(es?.rent || []),
      ...(es?.buy || []),
      ...(es?.free || []),
      ...(es?.ads || []),
    ];
    const uniq = new Map();
    for (const p of list) {
      if (!p?.provider_id) continue;
      uniq.set(p.provider_id, p.provider_name || `Provider ${p.provider_id}`);
    }
    platforms = [...uniq.values()].slice(0, 8);
  } catch {}

  const genres = Array.isArray(d.genres) ? d.genres.map((g) => g.name).filter(Boolean) : [];

  return {
    titleEs: d.name || null,
    titleOriginal: d.original_name || null,
    releaseES,
    platforms,
    genres,
  };
}

// ---------------- FilmAffinity scraping (no oficial) ----------------
const FA_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; SeriesyPelisRadar/1.0; +https://cpardogo.github.io/Series-y-Pelis/)",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
};

async function faFetch(url) {
  const r = await fetch(url, { headers: FA_HEADERS });
  if (!r.ok) return null;
  return r.text();
}

function normalizeFAUrl(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `https://www.filmaffinity.com${href}`;
  return `https://www.filmaffinity.com/es/${href}`;
}

async function faFindTitleUrls(query, limit = 8) {
  const url = new URL("https://www.filmaffinity.com/es/search.php");
  url.searchParams.set("stext", query);
  url.searchParams.set("stype", "all");

  const html = await faFetch(url.toString());
  if (!html) return [];

  const $ = cheerio.load(html);
  const links = [];

  $("a").each((_, a) => {
    const href = $(a).attr("href");
    if (href && href.includes("/es/film") && href.endsWith(".html")) links.push(href);
  });

  const uniq = [...new Set(links)].map(normalizeFAUrl).filter(Boolean);
  return uniq.slice(0, limit);
}

async function faGetRatingFromTitlePage(faUrl) {
  const html = await faFetch(faUrl);
  if (!html) return { fa: null, faTitle: null, faType: null, faYear: null };

  const $ = cheerio.load(html);

  const faTitle =
    cleanTitle($("h1").first().text()) ||
    cleanTitle($("title").first().text().replace(/\s*\|\s*FilmAffinity.*/i, "")) ||
    null;

  // Año: intentamos sacar (YYYY) del <title>
  const titleTxt = $("title").first().text() || "";
  const mYear = stripDiacritics(titleTxt).match(/\b(19|20)\d{2}\b/);
  const faYear = mYear ? Number(mYear[0]) : null;

  // Tipo (movie/series) por heurística
  const faType = detectFATypeFromPage($);

  let rating = null;
  const meta = $('meta[itemprop="ratingValue"]').attr("content");
  if (meta) {
    const v = Number(String(meta).replace(",", "."));
    if (Number.isFinite(v)) rating = v;
  }

  if (rating == null) {
    const txt = $('[class*="rating"]').first().text();
    const m = txt && txt.match(/(\d{1,2}[.,]\d)/);
    if (m) {
      const v = Number(m[1].replace(",", "."));
      if (Number.isFinite(v)) rating = v;
    }
  }

  return { fa: rating, faTitle, faType, faYear };
}

const faCache = new Map();

async function getFARating({ titleEs, titleOriginal, year, desiredType }) {
  const es = cleanTitle(titleEs);
  const orig = cleanTitle(titleOriginal);

  const queries = [
    year && es ? `${es} ${year}` : null,
    es,
    year && orig ? `${orig} ${year}` : null,
    orig,
  ].filter(Boolean);

  const minSim = 0.45;

  for (const q of queries) {
    const cacheKey = `${q}::${desiredType || "any"}`;
    if (faCache.has(cacheKey)) return faCache.get(cacheKey);

    await sleep(250);

    const faUrls = await faFindTitleUrls(q, 8);
    if (!faUrls.length) {
      const res = { fa: null, faUrl: null, faTitle: null, faType: null };
      faCache.set(cacheKey, res);
      continue;
    }

    // Evaluamos varios candidatos
    let best = null;
    let bestScore = -Infinity;

    for (const faUrl of faUrls) {
      await sleep(200);
      const cand = await faGetRatingFromTitlePage(faUrl);

      // Regla dura: si detectamos tipo y NO coincide, descartamos
      if (desiredType && cand.faType && cand.faType !== desiredType) continue;

      // Similaridad de título
      const sim = tokenSimilarity(es || orig || q, cand.faTitle || "");
      if (sim < minSim) continue;

      // Score
      let score = sim * 100;

      // Bonus por título normalizado exacto
      if (normalizeTitle(es || "") && normalizeTitle(es || "") === normalizeTitle(cand.faTitle || "")) score += 25;

      // Bonus por año cercano si lo tenemos
      const yItem = Number(year);
      const yFA = Number(cand.faYear);
      if (Number.isFinite(yItem) && Number.isFinite(yFA)) {
        const diff = Math.abs(yItem - yFA);
        score += diff === 0 ? 18 : diff === 1 ? 10 : 0;
      }

      // Bonus por tener rating
      if (typeof cand.fa === "number") score += 3;

      if (score > bestScore) {
        bestScore = score;
        best = { ...cand, faUrl };
      }
    }

    const res = best
      ? { fa: typeof best.fa === "number" ? best.fa : null, faUrl: best.faUrl, faTitle: best.faTitle || null, faType: best.faType || null }
      : { fa: null, faUrl: null, faTitle: null, faType: null };

    faCache.set(cacheKey, res);

    if (res.fa != null || res.faTitle != null) return res;
  }

  return { fa: null, faUrl: null, faTitle: null, faType: null };
}

// ---------------- scoring ----------------
const WEIGHTS = {
  fa: 0.25,
  imdb: 0.25,
  rtCrit: 0.125,
  rtAud: 0.125,
  mcCrit: 0.125,
  mcUser: 0.125,
};
const to10 = (x100) => (typeof x100 === "number" ? x100 / 10 : null);

function computeFinal(x) {
  const mapped = {
    fa: typeof x.fa === "number" ? x.fa : null,
    imdb: typeof x.imdb === "number" ? x.imdb : null,
    rtCrit: to10(x.rtCrit),
    rtAud: to10(x.rtAud),
    mcCrit: to10(x.mcCrit),
    mcUser: typeof x.mcUser === "number" ? x.mcUser : null,
  };

  let wsum = 0;
  for (const k in WEIGHTS) if (mapped[k] != null) wsum += WEIGHTS[k];
  if (wsum === 0) return null;

  let total = 0;
  for (const k in WEIGHTS) if (mapped[k] != null) total += (WEIGHTS[k] / wsum) * mapped[k];
  return Math.round(total * 100) / 100;
}

function coverage(x) {
  const keys = ["fa", "imdb", "rtCrit", "rtAud", "mcCrit", "mcUser"];
  let have = 0;
  for (const k of keys) if (typeof x[k] === "number") have++;
  return `${have}/6`;
}

function hasCoverage(item) {
  const c = String(item?.coverage ?? "").trim();
  const m = c.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return false;
  const have = Number(m[1]);
  return Number.isFinite(have) && have > 0;
}

const pickTop = (items, n = 5) =>
  items
    .filter((x) => x && hasCoverage(x))
    .sort((a, b) => (b.final ?? b.imdb ?? b.fa ?? 0) - (a.final ?? a.imdb ?? a.fa ?? 0))
    .slice(0, n)
    .map((x, idx) => ({ rank: idx + 1, ...x }));

// ---------------- Build: SOLO con presencia en España ----------------
const buildMoviesES = async () => {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 45);
  const toISO = (d) => d.toISOString().slice(0, 10);

  const page1 = await tmdb("discover/movie", {
    region: "ES",
    sort_by: "popularity.desc",
    "primary_release_date.gte": toISO(from),
    "primary_release_date.lte": toISO(now),
    page: "1",
  });

  const results = page1.results?.slice(0, 18) ?? [];
  const enriched = [];

  for (const m of results) {
    const es = await getMovieESDetails(m.id);

    const hasES = !!es.releaseES || (es.platforms && es.platforms.length) || es.inCinemasES;
    if (!hasES) continue;

    const ext = await tmdb(`movie/${m.id}/external_ids`);
    const imdbId = ext.imdb_id;
    const imdb = await omdbByImdbId(imdbId);

    const year = (es.releaseES || m.release_date || "").slice(0, 4) || null;
    const { fa, faUrl, faTitle } = await getFARating({
      titleEs: es.titleEs || m.title,
      titleOriginal: es.titleOriginal,
      year,
      desiredType: "movie",
    });

    const item = {
      type: "movie",

      title: faTitle || (es.titleEs || m.title),
      titleTmdbEs: es.titleEs || m.title,
      faTitle: faTitle || null,
      faUrl: faUrl || null,
      imdbUrl: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,

      releaseES: es.releaseES || null,
      // alias para el front (más claro)
      releaseDateES: es.releaseES || null,

      platforms: es.platforms || [],
      inCinemasES: !!es.inCinemasES,
      where: whereString(es),

      genres: es.genres || [],
      fa,
      imdb,

      rtCrit: null,
      rtAud: null,
      mcCrit: null,
      mcUser: null,

      tmdb: typeof m.vote_average === "number" ? Number(m.vote_average.toFixed(1)) : null,

      // ✅ IMÁGENES para el front (poster + background)
      posterPath: m.poster_path || null,
      backdropPath: m.backdrop_path || null,

      imdbId,
    };

    item.final = computeFinal(item) ?? item.imdb ?? item.fa ?? null;
    item.coverage = coverage(item);

    if (!hasCoverage(item)) continue;

    enriched.push(item);
  }

  return pickTop(enriched, 5);
};

const buildSeriesES = async () => {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 60);
  const toISO = (d) => d.toISOString().slice(0, 10);

  const page1 = await tmdb("discover/tv", {
    sort_by: "popularity.desc",
    "first_air_date.gte": toISO(from),
    "first_air_date.lte": toISO(now),
    watch_region: "ES",
    with_watch_monetization_types: "flatrate|free|ads|rent|buy",
    page: "1",
  });

  const results = page1.results?.slice(0, 18) ?? [];
  const enriched = [];

  for (const s of results) {
    const es = await getSeriesESDetails(s.id);

    const hasESPlatforms = Array.isArray(es.platforms) && es.platforms.length > 0;
    if (!hasESPlatforms) continue;

    // ✅ Regla: SOLO series estrenadas en España en las ÚLTIMAS 2 SEMANAS
    // Si por lo que sea no hay releaseES, se descarta (no es auditable)
    if (!isInLastDays(es.releaseES, 14, now)) continue;

    const ext = await tmdb(`tv/${s.id}/external_ids`);
    const imdbId = ext.imdb_id;
    const imdb = await omdbByImdbId(imdbId);

    const year = (es.releaseES || s.first_air_date || "").slice(0, 4) || null;
    const { fa, faUrl, faTitle } = await getFARating({
      titleEs: es.titleEs || s.name,
      titleOriginal: es.titleOriginal,
      year,
      desiredType: "series",
    });

    const item = {
      type: "series",

      title: faTitle || (es.titleEs || s.name),
      titleTmdbEs: es.titleEs || s.name,
      faTitle: faTitle || null,
      faUrl: faUrl || null,
      imdbUrl: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,

      releaseES: es.releaseES || null,
      // alias para el front
      releaseDateES: es.releaseES || null,

      platforms: es.platforms || [],
      inCinemasES: false,
      where: whereString({ platforms: es.platforms, inCinemasES: false }),

      genres: es.genres || [],
      fa,
      imdb,

      rtCrit: null,
      rtAud: null,
      mcCrit: null,
      mcUser: null,

      tmdb: typeof s.vote_average === "number" ? Number(s.vote_average.toFixed(1)) : null,

      // ✅ IMÁGENES para el front (poster + background)
      posterPath: s.poster_path || null,
      backdropPath: s.backdrop_path || null,

      imdbId,
    };

    item.final = computeFinal(item) ?? item.imdb ?? item.fa ?? null;
    item.coverage = coverage(item);

    if (!hasCoverage(item)) continue;

    enriched.push(item);
  }

  return pickTop(enriched, 5);
};

// ---------------- main (latest + histórico) ----------------
const main = async () => {
  const movies = await buildMoviesES();
  const series = await buildSeriesES();

  const date = new Date().toISOString().slice(0, 10);
  const payload = { updatedAt: date, movies, series };

  await fs.mkdir("data", { recursive: true });
  await fs.mkdir("data/history", { recursive: true });

  await fs.writeFile("data/latest.json", JSON.stringify(payload, null, 2), "utf8");
  await fs.writeFile(`data/history/${date}.json`, JSON.stringify(payload, null, 2), "utf8");

  const indexPath = "data/history/index.json";
  let index = [];
  try {
    index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    if (!Array.isArray(index)) index = [];
  } catch {}
  if (!index.includes(date)) index.push(date);
  index.sort();
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");

  console.log("Wrote data/latest.json and data/history/" + date + ".json");
};

main();
