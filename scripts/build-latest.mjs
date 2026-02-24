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

const cleanTitle = (t) => {
  if (!t) return null;
  return String(t)
    .replace(/\s*\(.*?\)\s*/g, " ")        // quita (…)
    .replace(/\s*:\s*.*/g, "")            // quita “: …”
    .replace(/[’'"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

function whereString({ platforms, inCinemasES }) {
  const p = Array.isArray(platforms) ? platforms.filter(Boolean) : [];
  if (p.length && inCinemasES) return `Cines · ${p.join(" · ")}`;
  if (p.length) return p.join(" · ");
  if (inCinemasES) return "Cines";
  return "España";
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

  // Providers ES (flatrate/rent/buy/free/ads)
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

  // Géneros ES
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

  // Providers ES
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

  // Géneros ES
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

async function faFindTitleUrl(query) {
  const url = new URL("https://www.filmaffinity.com/es/search.php");
  url.searchParams.set("stext", query);
  url.searchParams.set("stype", "all");

  const html = await faFetch(url.toString());
  if (!html) return null;

  const $ = cheerio.load(html);
  const links = [];

  $("a").each((_, a) => {
    const href = $(a).attr("href");
    if (href && href.includes("/es/film") && href.endsWith(".html")) links.push(href);
  });

  const uniq = [...new Set(links)].map(normalizeFAUrl).filter(Boolean);
  return uniq.length ? uniq[0] : null;
}

async function faGetRatingFromTitlePage(faUrl) {
  const html = await faFetch(faUrl);
  if (!html) return { fa: null, faTitle: null };

  const $ = cheerio.load(html);

  // título FA (prefer h1, fallback a <title>)
  const faTitle =
    cleanTitle($("h1").first().text()) ||
    cleanTitle($("title").first().text().replace(/\s*\|\s*FilmAffinity.*/i, "")) ||
    null;

  // rating FA
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

  return { fa: rating, faTitle };
}

const faCache = new Map();

async function getFARating({ titleEs, titleOriginal, year }) {
  const es = cleanTitle(titleEs);
  const orig = cleanTitle(titleOriginal);

  const queries = [
    year && es ? `${es} ${year}` : null,
    es,
    year && orig ? `${orig} ${year}` : null,
    orig,
  ].filter(Boolean);

  for (const q of queries) {
    if (faCache.has(q)) return faCache.get(q);

    await sleep(250);
    const faUrl = await faFindTitleUrl(q);
    if (!faUrl) {
      const res = { fa: null, faUrl: null, faTitle: null };
      faCache.set(q, res);
      continue;
    }

    await sleep(250);
    const { fa, faTitle } = await faGetRatingFromTitlePage(faUrl);

    const res = {
      fa: typeof fa === "number" ? fa : null,
      faUrl,
      faTitle: faTitle || null,
    };

    faCache.set(q, res);

    // si al menos tenemos título o nota, ya nos vale
    if (res.fa != null || res.faTitle != null) return res;
  }

  return { fa: null, faUrl: null, faTitle: null };
}

// ---------------- scoring (listo para RT/MC mañana) ----------------
const WEIGHTS = { fa: 0.25, imdb: 0.25, rtCrit: 0.125, rtAud: 0.125, mcCrit: 0.125, mcUser: 0.125 };
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

/**
 * Devuelve TRUE si coverage es > 0/6
 * - coverage siempre es string tipo "2/6"
 */
function hasCoverage(item) {
  const c = String(item?.coverage ?? "").trim();
  const m = c.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return false;
  const have = Number(m[1]);
  return Number.isFinite(have) && have > 0;
}

/**
 * Top N solo con cobertura (>0/6)
 * - Orden: final -> imdb -> fa (no tmdb si coverage es 0/6 porque ya se filtró)
 */
const pickTop = (items, n = 5) =>
  items
    .filter((x) => x && hasCoverage(x)) // ✅ elimina 0/6 y sin cobertura
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

    // Solo si tiene presencia ES: estreno ES o plataformas ES o cines ES
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
    });

    const item = {
      title: faTitle || (es.titleEs || m.title),        // ✅ título como en FA si existe
      titleTmdbEs: es.titleEs || m.title,
      faTitle: faTitle || null,
      faUrl: faUrl || null,
      imdbUrl: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,

      releaseES: es.releaseES || null,
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
      imdbId,
    };

    // final: SOLO basado en fuentes (FA/IMDb/RT/MC); si no hay, queda null
    item.final = computeFinal(item) ?? item.imdb ?? item.fa ?? null;
    item.coverage = coverage(item);

    // ✅ Elimina aquí mismo los 0/6 (ahorra ruido)
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

    // Solo series con plataformas ES (para saber “dónde ver”)
    const hasESPlatforms = Array.isArray(es.platforms) && es.platforms.length > 0;
    if (!hasESPlatforms) continue;

    const ext = await tmdb(`tv/${s.id}/external_ids`);
    const imdbId = ext.imdb_id;
    const imdb = await omdbByImdbId(imdbId);

    const year = (es.releaseES || s.first_air_date || "").slice(0, 4) || null;
    const { fa, faUrl, faTitle } = await getFARating({
      titleEs: es.titleEs || s.name,
      titleOriginal: es.titleOriginal,
      year,
    });

    const item = {
      title: faTitle || (es.titleEs || s.name),
      titleTmdbEs: es.titleEs || s.name,
      faTitle: faTitle || null,
      faUrl: faUrl || null,
      imdbUrl: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,

      releaseES: es.releaseES || null,
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
      imdbId,
    };

    // final: SOLO basado en fuentes (FA/IMDb/RT/MC); si no hay, queda null
    item.final = computeFinal(item) ?? item.imdb ?? item.fa ?? null;
    item.coverage = coverage(item);

    // ✅ Elimina aquí mismo los 0/6
    if (!hasCoverage(item)) continue;

    enriched.push(item);
  }

  return pickTop(enriched, 5);
};

// ---------------- main ----------------
const main = async () => {
  const movies = await buildMoviesES();
  const series = await buildSeriesES();

  const payload = {
    updatedAt: new Date().toISOString().slice(0, 10),
    movies,
    series,
  };

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/latest.json", JSON.stringify(payload, null, 2), "utf8");
  console.log("Wrote data/latest.json");
};

main();
