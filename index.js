const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

const KEY = process.env.TMDB_API_KEY;
const REGION = process.env.REGION || 'US'; // streaming availability country
const IMG = 'https://image.tmdb.org/t/p/w500';
const BG = 'https://image.tmdb.org/t/p/w1280';
const WINDOW_DAYS = 15; // every "recently added" row = new releases from the past 15 days

if (!KEY) console.warn('Missing TMDB_API_KEY environment variable!');

// ---------- helpers ----------
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 864e5));
const today = () => iso(new Date());

async function tmdb(path, params = {}) {
  const url = new URL('https://api.themoviedb.org/3' + path);
  url.searchParams.set('api_key', KEY);
  url.searchParams.set('language', 'en-US');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status} on ${path}`);
  return res.json();
}

async function pages(path, params, n = 2, kind) {
  const out = [];
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) => tmdb(path, { ...params, page: i + 1 }).catch(() => ({ results: [] })))
  );
  for (const r of results) {
    for (const x of r.results || []) {
      out.push({
        ...x,
        kind: kind || (x.media_type === 'movie' ? 'movie' : 'tv'),
        date: x.release_date || x.first_air_date || '',
      });
    }
  }
  return out;
}

// caches
const catCache = new Map(); // catalog id -> {t, metas}
const idCache = new Map();  // "movie:123" -> imdb id
const CAT_TTL = 3 * 3600e3; // 3 hours

async function imdbId(kind, id) {
  const key = `${kind}:${id}`;
  if (idCache.has(key)) return idCache.get(key);
  try {
    const d = await tmdb(`/${kind}/${id}/external_ids`);
    const v = d.imdb_id || null;
    idCache.set(key, v);
    return v;
  } catch {
    return null;
  }
}

async function toMetas(items, limit = 80) {
  const seen = new Set();
  const uniq = items.filter((x) => {
    const k = x.imdb || `${x.kind}:${x.id}`;
    if (seen.has(k) || !(x.poster_path || x.poster_url)) return false;
    seen.add(k);
    return true;
  }).slice(0, limit);

  const metas = await Promise.all(uniq.map(async (x) => {
    const imdb = x.imdb || (await imdbId(x.kind, x.id));
    if (!imdb) return null;
    return {
      id: imdb,
      type: x.kind === 'movie' ? 'movie' : 'series',
      name: x.title || x.name,
      poster: x.poster_url || IMG + x.poster_path,
      background: x.backdrop_path ? BG + x.backdrop_path : undefined,
      description: x.overview,
      releaseInfo: (x.date || '').slice(0, 4),
      imdbRating: x.vote_average ? Number(x.vote_average).toFixed(1) : undefined,
    };
  }));

  const out = [];
  const ids = new Set();
  for (const m of metas) {
    if (m && !ids.has(m.id)) { ids.add(m.id); out.push(m); }
  }
  return out;
}

const NON_SCRIPTED = [10764, 10767, 10763, 10766]; // reality, talk, news, soap
const isShow = (x) => (x.genre_ids || []).some((g) => [10764, 10767, 10763].includes(g));
const isAnime = (x) => (x.genre_ids || []).includes(16) && x.original_language === 'ja';

// ---------- TVmaze (streaming premieres) ----------
// TVmaze's web schedule lists every streaming episode by day. Episode 1 of a season
// = a series premiere or a new season, with the platform name and IMDb id included.
let tvmCache = { t: 0, data: [] };

async function tvmazeWeb(days) {
  if (tvmCache.data.length && Date.now() - tvmCache.t < CAT_TTL) return tvmCache.data;
  const dates = Array.from({ length: days + 1 }, (_, i) => daysAgo(i));
  const lists = await Promise.all(
    dates.map((d) =>
      fetch(`https://api.tvmaze.com/schedule/web?date=${d}`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
    )
  );
  const data = lists.flat().filter((ep) => ep && ep.number === 1 && ep._embedded && ep._embedded.show);
  tvmCache = { t: Date.now(), data };
  return data;
}

async function tvmazePremieres(days, nameRegex) {
  const eps = await tvmazeWeb(days);
  const out = [];
  for (const ep of eps) {
    const show = ep._embedded.show;
    const channel = show.webChannel && show.webChannel.name;
    const imdb = show.externals && show.externals.imdb;
    if (!channel || !nameRegex.test(channel) || !imdb) continue;
    const img = show.image && (show.image.original || show.image.medium);
    if (!img) continue;
    out.push({
      kind: 'tv',
      imdb,
      id: show.id,
      name: show.name,
      poster_url: img,
      overview: (show.summary || '').replace(/<[^>]+>/g, ''),
      vote_average: (show.rating && show.rating.average) || 0,
      date: ep.airdate || show.premiered || '',
    });
  }
  return out;
}

// ---------- row builders ----------
const trendingTv = (filter) => async () => {
  const items = await pages('/trending/tv/day', {}, 3, 'tv');
  return items.filter(filter);
};

// Brand-new releases on a platform in the last 15 days:
//  - movies: released in the window AND streaming (flatrate) on that platform
//    (new direct-to-streaming films, documentaries, stand-up specials, originals)
//  - series: first aired in the window on that platform (TMDB) + new series/season
//    premieres on that platform (TVmaze)
// Old library titles that merely arrived on the platform are NOT included.
function recent(providerIds, nameRegex, days = WINDOW_DAYS) {
  return async () => {
    const base = {
      watch_region: REGION,
      with_watch_providers: providerIds,
      with_watch_monetization_types: 'flatrate',
      sort_by: 'popularity.desc',
    };
    const from = daysAgo(days), to = today();
    const [movies, tv, premieres] = await Promise.all([
      pages('/discover/movie', { ...base, 'primary_release_date.gte': from, 'primary_release_date.lte': to }, 2, 'movie'),
      pages('/discover/tv', { ...base, 'first_air_date.gte': from, 'first_air_date.lte': to }, 2, 'tv'),
      tvmazePremieres(days, nameRegex).catch(() => []),
    ]);
    // newest first, mixing movies and series
    return [...premieres, ...tv, ...movies].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  };
}

// Suggested extra row: highly rated releases from the last 15 days
async function topRatedNew() {
  const from = daysAgo(WINDOW_DAYS), to = today();
  const common = { 'vote_count.gte': 30, 'vote_average.gte': 7, sort_by: 'vote_average.desc' };
  const [m, t] = await Promise.all([
    pages('/discover/movie', { ...common, 'primary_release_date.gte': from, 'primary_release_date.lte': to }, 1, 'movie'),
    pages('/discover/tv', { ...common, 'first_air_date.gte': from, 'first_air_date.lte': to }, 1, 'tv'),
  ]);
  return [...m, ...t].sort((a, b) => b.vote_average - a.vote_average);
}

// ---------- catalogue list ----------
// type: 'movie' | 'series' (mixed rows use 'movie'; items carry their own real type)
const ROWS = [
  { id: 'trend-series', name: '🔥 Trending Today: Series', type: 'series', build: trendingTv((x) => !isShow(x) && !isAnime(x) && !(x.genre_ids || []).some((g) => NON_SCRIPTED.includes(g))) },
  { id: 'trend-movies', name: '🔥 Trending Today: Movies', type: 'movie', build: async () => pages('/trending/movie/day', {}, 3, 'movie') },
  { id: 'trend-shows', name: '🔥 Trending Today: Shows', type: 'series', build: trendingTv(isShow) },
  { id: 'trend-anime', name: '🔥 Trending Today: Anime Series', type: 'series', build: trendingTv(isAnime) },

  { id: 'new-netflix', name: '🆕 New on Netflix (15 days)', type: 'movie', build: recent('8', /Netflix/i) },
  { id: 'new-prime', name: '🆕 New on Prime Video (15 days)', type: 'movie', build: recent('9|119', /Prime|Amazon/i) },
  { id: 'new-max', name: '🆕 New on Max (15 days)', type: 'movie', build: recent('1899|384', /Max/i) },
  { id: 'new-paramount', name: '🆕 New on Paramount+ (15 days)', type: 'movie', build: recent('531|582', /Paramount/i) },
  { id: 'new-hulu', name: '🆕 New on Hulu (15 days)', type: 'movie', build: recent('15', /Hulu/i) },
  { id: 'new-peacock-mgm', name: '🆕 New on Peacock & MGM+ (15 days)', type: 'movie', build: recent('386|34', /Peacock|MGM/i) },
  { id: 'new-crunchyroll', name: '🆕 New on Crunchyroll (15 days)', type: 'movie', build: recent('283', /Crunchyroll/i) },
  { id: 'new-disney', name: '🆕 New on Disney+ (15 days)', type: 'movie', build: recent('337', /Disney/i) },
  { id: 'new-apple', name: '🆕 New on Apple TV+ (15 days)', type: 'movie', build: recent('350', /Apple/i) },

  { id: 'top-new', name: '⭐ Top Rated New (15 days)', type: 'movie', build: topRatedNew },
];

const manifest = {
  id: 'community.streamvault',
  version: '1.1.0',
  name: 'StreamVault',
  description: 'Trending today + brand-new releases (past 15 days) on Netflix, Prime, Max, Paramount+, Hulu, Peacock, MGM+, Crunchyroll, Disney+ and Apple TV+.',
  resources: ['catalog'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: ROWS.map((r) => ({ type: r.type, id: r.id, name: r.name, extra: [{ name: 'skip', isRequired: false }] })),
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ id, extra }) => {
  const row = ROWS.find((r) => r.id === id);
  if (!row) return { metas: [] };
  const skip = Number((extra && extra.skip) || 0);

  let cached = catCache.get(id);
  if (!cached || Date.now() - cached.t > CAT_TTL) {
    try {
      const items = await row.build();
      const metas = await toMetas(items, 80);
      cached = { t: Date.now(), metas };
      catCache.set(id, cached);
    } catch (e) {
      console.error(id, e.message);
      if (!cached) return { metas: [] };
    }
  }
  return { metas: cached.metas.slice(skip, skip + 100), cacheMaxAge: 3600 };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
