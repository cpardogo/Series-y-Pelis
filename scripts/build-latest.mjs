import fs from "node:fs/promises";
import * as cheerio from "cheerio";

const TMDB_KEY = process.env.TMDB_API_KEY;
const OMDB_KEY = process.env.OMDB_API_KEY;

if (!TMDB_KEY) throw new Error("Missing TMDB_API_KEY secret");
if (!OMDB_KEY) throw new Error("Missing OMDB_API_KEY secret");

// ---------------------- Helpers ----------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmdb = async (path, params = {}) => {
  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const r = await fetch(url);
  if (!r.ok) throw new Error(`TMDb error ${r.status} on ${path}`);
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

// ---------------------- FilmAffinity Scraper (no oficial) ----------------------
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

  // Intenta localizar enlaces a fichas filmXXXXXX.html
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
  if (!html) return { fa: null, faVotes: null };

  const $ = cheerio.load(html);

  // 1) meta itemprop ratingValue
  let rating = null;
  const meta = $('meta[itemprop="ratingValue"]').attr("content");
  if (meta) {
    const v = Number(String(meta).replace(",", "."));
    if (Number.isFinite(v)) rating = v;
  }

  // 2) fallback: buscar un patrón tipo 7,3 o 7.3 en elementos "rating"
  if (rating == null) {
    const txt = $('[class*="rating"]').first().text();
    const m = txt && txt.match(/(\d{1,2}[.,]\d)/);
    if (m) {
      const v = Number(m[1].replace(",", "."));
      if (Number.isFinite(v)) rating = v;
    }
  }

  // votos (opcional)
  let votes = null;
  const votesMeta = $('meta[itemprop="ratingCount"]').attr("content");
  if (votesMeta) {
    const mm = String(votesMeta).replace(/\./g, "").match(/(\d{2,})/);
    if (mm) votes = Number(mm[1]);
  }

  return { fa: rating, faVotes: votes };
}

async function getFARating({ title, year }) {
  // Para afinar búsquedas: "Title 2026"
  const q = year ? `${title} ${year}` : title;

  await sleep(350);
  const faUrl = await faFindTitleUrl(q);
  if (!faUrl) return { fa: null, faUrl: null, faVotes: null };

  await sleep(350);
  const { fa, faVotes } = await faGetRatingFromTitlePage(faUrl);
  return { fa, faUrl, faVotes };
}

// ---------------------- Scoring ----------------------
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
  for (const k in WEIGHTS) {
    if (mapped[k] != null) total += (WEIGHTS[k] / wsum) * mapped[k];
  }
  return Math.round(total * 100) / 100;
}

function coverage(x) {
  const keys = ["fa", "imdb", "rtCrit", "rtAud", "mcCrit", "mcUser"];
  let have = 0;
  for (const k of keys) if (typeof x[k] === "number") have++;
  return `${have}/6`;
}

// Para que SIEMPRE haya top5 aunque falte IMDb/FA, usamos fallback con TMDb
const pickTop = (items, n = 5) =>
  items
    .filter(
      (x) =>
        (typeof x.final === "number" && x.final >= 1) ||
        (typeof x.imdb === "number" && x.imdb >= 1) ||
        (typeof x.fa === "number" && x.fa >= 1) ||
        (typeof x.tmdb === "number" && x.tmdb >= 1)
    )
    .sort(
      (a, b) =>
        (b.final ?? b.imdb ?? b.fa ?? b.tmdb ?? 0) - (a.final ?? a.imdb ?? a.fa ?? a.tmdb ?? 0)
    )
    .slice(0, n)
    .map((x, idx) => ({ rank: idx + 1, ...x }));

// ---------------------- Build Movies / Series ----------------------
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

  const results = page1.results?.slice(0, 18) ?? []; // limitado para no scrapear demasiado
  const enriched = [];

  for (const m of results) {
    const ext = await tmdb(`movie/${m.id}/external_ids`);
    const imdbId = ext.imdb_id;

    const imdb = await omdbByImdbId(imdbId);

    const year = (m.release_date || "").slice(0, 4) || null;
    const { fa } = await getFARating({ title: m.title, year });

    // RT/MC: mañana los añadimos (de momento null)
    const item = {
      title: m.title,
      where: "España (estreno reciente)",
      fa,
      imdb,
      rtCrit: null,
      rtAud: null,
      mcCrit: null,
      mcUser: null,
      tmdb: typeof m.vote_average === "number" ? Number(m.vote_average.toFixed(1)) : null,
      imdbId,
    };

    item.final = computeFinal(item);
    item.coverage = coverage(item);

    enriched.push(item);
  }

  return pickTop(enriched, 5);
};

const buildSeries = async () => {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 60);
  const toISO = (d) => d.toISOString().slice(0, 10);

  const page1 = await tmdb("discover/tv", {
    sort_by: "popularity.desc",
    "first_air_date.gte": toISO(from),
    "first_air_date.lte": toISO(now),
    page: "1",
  });

  const results = page1.results?.slice(0, 18) ?? [];
  const enriched = [];

  for (const s of results) {
    const ext = await tmdb(`tv/${s.id}/external_ids`);
    const imdbId = ext.imdb_id;

    const imdb = await omdbByImdbId(imdbId);

    const year = (s.first_air_date || "").slice(0, 4) || null;
    const { fa } = await getFARating({ title: s.name, year });

    const item = {
      title: s.name,
      where: "Estreno/temporada reciente",
      fa,
      imdb,
      rtCrit: null,
      rtAud: null,
      mcCrit: null,
      mcUser: null,
      tmdb: typeof s.vote_average === "number" ? Number(s.vote_average.toFixed(1)) : null,
      imdbId,
    };

    item.final = computeFinal(item);
    item.coverage = coverage(item);

    enriched.push(item);
  }

  return pickTop(enriched, 5);
};

// ---------------------- Main ----------------------
const main = async () => {
  const movies = await buildMoviesES();
  const series = await buildSeries();

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