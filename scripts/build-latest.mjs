import fs from "node:fs/promises";

const TMDB_KEY = process.env.TMDB_API_KEY;
const OMDB_KEY = process.env.OMDB_API_KEY;

if (!TMDB_KEY) throw new Error("Missing TMDB_API_KEY secret");
if (!OMDB_KEY) throw new Error("Missing OMDB_API_KEY secret");

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

const pickTop = (items, n = 5) =>
  items
    .filter(x => x.imdb && x.imdb >= 1)
    .sort((a, b) => b.imdb - a.imdb)
    .slice(0, n)
    .map((x, idx) => ({ rank: idx + 1, ...x, score: x.imdb }));

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
    page: "1"
  });

  const results = page1.results?.slice(0, 20) ?? [];
  const enriched = [];

  for (const m of results) {
    const ext = await tmdb(`movie/${m.id}/external_ids`);
    const imdbId = ext.imdb_id;
    const imdb = await omdbByImdbId(imdbId);
    enriched.push({
      title: m.title,
      where: "España (estreno reciente)",
      imdb,
      tmdb: m.vote_average ? Number(m.vote_average.toFixed(1)) : null,
      imdbId
    });
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
    page: "1"
  });

  const results = page1.results?.slice(0, 20) ?? [];
  const enriched = [];

  for (const s of results) {
    const ext = await tmdb(`tv/${s.id}/external_ids`);
    const imdbId = ext.imdb_id;
    const imdb = await omdbByImdbId(imdbId);
    enriched.push({
      title: s.name,
      where: "Estreno/temporada reciente",
      imdb,
      tmdb: s.vote_average ? Number(s.vote_average.toFixed(1)) : null,
      imdbId
    });
  }
  return pickTop(enriched, 5);
};

const main = async () => {
  const movies = await buildMoviesES();
  const series = await buildSeries();

  const payload = {
    updatedAt: new Date().toISOString().slice(0, 10),
    movies,
    series
  };

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/latest.json", JSON.stringify(payload, null, 2), "utf8");
  console.log("Wrote data/latest.json");
};

main();
