const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

const KEY = process.env.TMDB_API_KEY;
const REGION = process.env.REGION || 'US'; // streaming availability country
const IMG = 'https://image.tmdb.org/t/p/w500';
const BG = 'https://image.tmdb.org/t/p/w1280';
const WINDOW_DAYS = 15;   // "New on ..." rows = past 15 days
const MONTH_DAYS = 30;    // "Trending This Month" rows
const REFRESH_HOURS = 6;  // every row refreshes at least every 6 hours

if (!KEY) console.warn('Missing TMDB_API_KEY environment variable!');

// ---------- helpers ----------
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 864e5));
const today = () => iso(new Date());
const newestFirst = (arr) => arr.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

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
const CAT_TTL = REFRESH_HOURS * 3600e3;

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
const isScriptedSeries = (x) => !isShow(x) && !isAnime(x) && !(x.genre_ids || []).some((g) => NON_SCRIPTED.includes(g));

// ---------- TVmaze (streaming premieres) ----------
// TVmaze's web schedule lists every streaming episode by day. Episode 1 of a season
// = a series premiere or a new season, with the platform name and IMDb id included.
let tvmCache = { t: 0, data: [] };

async function tvmazeWeb(days) {
  if (tvmCache.data.length && Date.now() - tvmCache.t < CAT_TTL) return tvmCache.data;
  // always fetch the last 30 days; each row filters down to its own window
  const dates = Array.from({ length: Math.max(days, 30) + 1 }, (_, i) => daysAgo(i));
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
  const cutoff = daysAgo(days);
  const out = [];
  for (const ep of eps) {
    if ((ep.airdate || '') < cutoff) continue;
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
// Trending This Week (TMDB weekly trending), newest releases first
const trendingWeekTv = (filter) => async () => {
  const items = await pages('/trending/tv/week', {}, 3, 'tv');
  return newestFirst(items.filter(filter));
};
// Shows (reality, talk, news) rarely reach the global top trending list, so add the
// most popular shows that aired in the last 7 days to fill the row.
async function trendingWeekShows() {
  const [trending, popular] = await Promise.all([
    pages('/trending/tv/week', {}, 3, 'tv'),
    pages('/discover/tv', {
      with_genres: '10764|10767|10763',
      'air_date.gte': daysAgo(7),
      'air_date.lte': today(),
      sort_by: 'popularity.desc',
      with_original_language: 'en',
    }, 3, 'tv'),
  ]);
  return newestFirst([...trending.filter(isShow), ...popular]);
}
const trendingWeekMovies = async () => newestFirst(await pages('/trending/movie/week', {}, 3, 'movie'));

// Trending This Month: TMDB has no monthly trending, so this is the most popular
// titles released / airing in the last 30 days, newest first.
function monthRow({ tvParams, movieParams, includeTv = true, includeMovies = true }) {
  return async () => {
    const from = daysAgo(MONTH_DAYS), to = today();
    const jobs = [];
    if (includeMovies) {
      jobs.push(pages('/discover/movie', { sort_by: 'popularity.desc', 'primary_release_date.gte': from, 'primary_release_date.lte': to, ...movieParams }, 2, 'movie'));
    }
    if (includeTv) {
      jobs.push(pages('/discover/tv', { sort_by: 'popularity.desc', 'air_date.gte': from, 'air_date.lte': to, ...tvParams }, 2, 'tv'));
    }
    const lists = await Promise.all(jobs);
    return newestFirst(lists.flat());
  };
}

// Brand-new releases on a platform in the last 15 days:
//  - movies: released in the window AND streaming (flatrate) on that platform
//  - series: first aired in the window on that platform
//  - new season premieres (TVmaze) and the platform's originals with new episodes (by network)
// Newest first.
function recent(providerIds, networkIds, nameRegex, days = WINDOW_DAYS) {
  return async () => {
    const base = {
      watch_region: REGION,
      with_watch_providers: providerIds,
      with_watch_monetization_types: 'flatrate',
      sort_by: 'popularity.desc',
    };
    const from = daysAgo(days), to = today();
    const [movies, tvNew, tvOriginals, premieres] = await Promise.all([
      pages('/discover/movie', { ...base, 'primary_release_date.gte': from, 'primary_release_date.lte': to }, 2, 'movie'),
      pages('/discover/tv', { ...base, 'first_air_date.gte': from, 'first_air_date.lte': to }, 2, 'tv'),
      pages('/discover/tv', { with_networks: networkIds, 'air_date.gte': from, 'air_date.lte': to, sort_by: 'popularity.desc' }, 2, 'tv'),
      tvmazePremieres(days, nameRegex).catch(() => []),
    ]);
    return newestFirst([...premieres, ...tvNew, ...movies, ...tvOriginals]);
  };
}

// Look up TMDB streaming-provider IDs by name (so no IDs are guessed)
let provList = null;
async function providerIds(regexes) {
  if (!provList) {
    const [m, t] = await Promise.all([
      tmdb('/watch/providers/movie', { watch_region: REGION }),
      tmdb('/watch/providers/tv', { watch_region: REGION }),
    ]);
    provList = [...(m.results || []), ...(t.results || [])];
  }
  const ids = new Set();
  for (const p of provList) if (regexes.some((r) => r.test(p.provider_name))) ids.add(p.provider_id);
  return [...ids].join('|');
}

// Look up TMDB keyword IDs by exact name
const kwCache = new Map();
async function keywordIds(names) {
  const ids = [];
  for (const name of names) {
    if (!kwCache.has(name)) {
      const r = await tmdb('/search/keyword', { query: name }).catch(() => ({ results: [] }));
      kwCache.set(name, (r.results || []).filter((k) => k.name.toLowerCase() === name).map((k) => k.id));
    }
    ids.push(...kwCache.get(name));
  }
  return ids.join('|');
}

// Smaller platforms: new releases in the last 30 days, newest first
function recentNamed(providerRegexes, nameRegex, days = 30, monetization = 'flatrate') {
  return async () => {
    const ids = await providerIds(providerRegexes).catch(() => '');
    const from = daysAgo(days), to = today();
    const base = {
      watch_region: REGION,
      with_watch_providers: ids,
      with_watch_monetization_types: monetization,
      sort_by: 'popularity.desc',
    };
    const [movies, tv, premieres] = await Promise.all([
      ids ? pages('/discover/movie', { ...base, 'primary_release_date.gte': from, 'primary_release_date.lte': to }, 2, 'movie') : [],
      ids ? pages('/discover/tv', { ...base, 'first_air_date.gte': from, 'first_air_date.lte': to }, 2, 'tv') : [],
      tvmazePremieres(days, nameRegex).catch(() => []),
    ]);
    return newestFirst([...premieres, ...tv, ...movies]);
  };
}

// BBC + Sky: new series and new seasons (episode 1) from UK broadcasters in the last 30 days.
// TVmaze's UK schedule covers BBC and Sky channels; TMDB adds BBC-network series.
let ukCache = { t: 0, data: [] };
async function tvmazeUk() {
  if (ukCache.data.length && Date.now() - ukCache.t < CAT_TTL) return ukCache.data;
  const dates = Array.from({ length: 31 }, (_, i) => daysAgo(i));
  const lists = await Promise.all(
    dates.map((d) =>
      fetch(`https://api.tvmaze.com/schedule?country=GB&date=${d}`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
    )
  );
  const data = lists.flat().filter((ep) => ep && ep.number === 1 && ep.show);
  ukCache = { t: Date.now(), data };
  return data;
}

function recentUk(days = 30) {
  return async () => {
    const from = daysAgo(days), to = today();
    const [eps, tv] = await Promise.all([
      tvmazeUk().catch(() => []),
      pages('/discover/tv', { with_networks: '4|332|3|100', 'first_air_date.gte': from, 'first_air_date.lte': to, sort_by: 'popularity.desc' }, 2, 'tv'),
    ]);
    const premieres = [];
    for (const ep of eps) {
      const show = ep.show;
      const net = (show.network && show.network.name) || (show.webChannel && show.webChannel.name) || '';
      const imdb = show.externals && show.externals.imdb;
      const img = show.image && (show.image.original || show.image.medium);
      if (!/BBC|Sky/i.test(net) || !imdb || !img || (ep.airdate || '') < from) continue;
      premieres.push({
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
    return newestFirst([...premieres, ...tv]);
  };
}

// Evergreen rows (no time limit), ordered by rating
const bestAnime = async () =>
  pages('/discover/tv', { with_genres: '16', with_original_language: 'ja', 'vote_average.gte': 8, 'vote_count.gte': 500, sort_by: 'vote_average.desc' }, 4, 'tv');

const ultimateComedy = async () =>
  pages('/discover/movie', { with_genres: '35', without_genres: '16', 'vote_average.gte': 7, 'vote_count.gte': 3000, sort_by: 'vote_average.desc' }, 4, 'movie');

// Popular comedy movies: sorted by popularity, lower rating bar so big franchises
// (The Hangover 1-3 etc.) are included
// Animated movies (Toy Story, Moana...) are excluded, plus a few live-action kids'
// franchises (Sonic...). Live-action family comedies like Home Alone stay.
// A list of must-have comedies is also looked up by name so favourites like
// The Hangover 1-3 are always in the row.
const KIDS_BLOCK = /sonic the hedgehog|alvin and the chipmunks|smurfs|garfield|scooby-doo|dolittle|peter rabbit|paddington|the lego|minions|mario/i;
const MUST_HAVE_COMEDIES = [
  'The Hangover', 'The Hangover Part II', 'The Hangover Part III',
  'Home Alone', 'Home Alone 2: Lost in New York',
  'Superbad', 'Step Brothers', 'Anchorman: The Legend of Ron Burgundy', 'Bridesmaids',
  'Dumb and Dumber', 'Ted', 'Neighbors', 'Central Intelligence', 'Rush Hour',
  'Meet the Parents', 'American Pie', '21 Jump Street', 'Tropic Thunder',
  'Pineapple Express', 'Grown Ups', 'Role Models', 'We\'re the Millers',
];

async function findMovieByTitle(title) {
  const r = await tmdb('/search/movie', { query: title }).catch(() => ({ results: [] }));
  const want = title.toLowerCase();
  const live = (r.results || []).filter((x) => !(x.genre_ids || []).includes(16));
  // exact title match first, otherwise the most popular non-animated result
  const hit = live.find((x) => (x.title || '').toLowerCase() === want) || live[0];
  return hit ? { ...hit, kind: 'movie', date: hit.release_date || '' } : null;
}

const popularComedy = async () => {
  const [discovered, pinned] = await Promise.all([
    pages('/discover/movie', {
      with_genres: '35',
      without_genres: '16',
      'vote_average.gte': 5.8,
      'vote_count.gte': 2000,
      sort_by: 'popularity.desc',
    }, 5, 'movie'),
    Promise.all(MUST_HAVE_COMEDIES.map(findMovieByTitle)),
  ]);
  const clean = discovered.filter((x) => !KIDS_BLOCK.test(x.title || ''));
  // Pinned favourites go FIRST (in list order) so they can never be cut by the
  // row size limit; the rest follow, most popular first.
  clean.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  return [...pinned.filter(Boolean), ...clean];
};

// Animated & family comedy movies (Toy Story, Moana, Sonic, Shrek...), popular first
async function animatedFamilyComedy() {
  const common = { 'vote_average.gte': 6.3, 'vote_count.gte': 1500, sort_by: 'popularity.desc' };
  const [animated, family] = await Promise.all([
    pages('/discover/movie', { ...common, with_genres: '35,16' }, 4, 'movie'),
    pages('/discover/movie', { ...common, with_genres: '35,10751' }, 4, 'movie'),
  ]);
  return [...animated, ...family].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
}

// Best documentaries: movies + series mixed, best rated first
async function bestDocumentaries() {
  const [m, t] = await Promise.all([
    pages('/discover/movie', { with_genres: '99', 'vote_average.gte': 7.5, 'vote_count.gte': 500, sort_by: 'vote_average.desc' }, 3, 'movie'),
    pages('/discover/tv', { with_genres: '99', 'vote_average.gte': 8, 'vote_count.gte': 200, sort_by: 'vote_average.desc' }, 3, 'tv'),
  ]);
  return [...m, ...t].sort((a, b) => b.vote_average - a.vote_average);
}

// Best travel and food shows as reality TV (also docu-style travel/food shows).
// Scripted series and animation/anime are excluded.
async function bestTravelFood() {
  const kw = await keywordIds(['travel', 'food', 'cooking', 'chef', 'cuisine', 'culinary', 'travelogue']);
  if (!kw) return [];
  const items = await pages('/discover/tv', {
    with_keywords: kw,
    with_genres: '10764|99',
    without_genres: '16,18,35,10765,10759',
    'vote_average.gte': 7,
    'vote_count.gte': 50,
    sort_by: 'vote_average.desc',
  }, 5, 'tv');
  return items.filter((x) => x.original_language !== 'ja' || !(x.genre_ids || []).includes(16));
}

// Shared filters for reality competition rows: no animation, no scripted series,
// and no cooking shows (there is a separate cooking row). Thresholds are loose so the
// rows are long; the sort puts the best rated first.
const COMP_BASE = { without_genres: '16,18,35,10765,10759', 'vote_average.gte': 6.5, 'vote_count.gte': 30, sort_by: 'vote_average.desc' };
const COOKING = /\b(cook|cooking|chef|chefs|bake|baking|baker|cake|kitchen|culinary)\b/i;

// Two sources are merged: shows tagged with matching keywords, and reality shows whose
// description matches the topic. Cooking shows are removed.
async function competitionRow(keywordNames, topicRegex) {
  const [kw, noCook] = await Promise.all([
    keywordIds(keywordNames),
    keywordIds(['cooking competition', 'cooking', 'chef', 'baking']),
  ]);
  const kwParams = { ...COMP_BASE, with_genres: '10764|10767|99' };
  if (kw) kwParams.with_keywords = kw;
  if (noCook) kwParams.without_keywords = noCook;
  const [byKw, byReality] = await Promise.all([
    kw ? pages('/discover/tv', kwParams, 8, 'tv') : [],
    pages('/discover/tv', { ...COMP_BASE, with_genres: '10764', 'vote_count.gte': 50 }, 8, 'tv'),
  ]);
  const matched = byReality.filter((x) => topicRegex.test(`${x.name || ''} ${x.overview || ''}`));
  return [...byKw, ...matched]
    .filter((x) => !COOKING.test(`${x.name || ''} ${x.overview || ''}`))
    .sort((a, b) => b.vote_average - a.vote_average);
}

// Physical and survival reality competitions (Survivor, Alone, Ninja Warrior,
// Physical 100, Amazing Race...)
const physicalSurvival = () => competitionRow([
  'survival', 'survivor', 'castaway', 'deserted island', 'wilderness', 'race around the world',
  'physical challenge', 'obstacle course', 'endurance', 'ninja warrior', 'athletic competition', 'challenge',
], /surviv|island|wilderness|stranded|obstacle|endurance|physical|athlet|race|castaway|extreme|outlast|tribe|desert|jungle/i);

// Talent, dating, elimination and quiz / game shows
const talentDatingQuiz = () => competitionRow([
  'talent show', 'singing competition', 'dating competition', 'dating show', 'elimination',
  'voting', 'reality competition', 'game show', 'quiz show',
], /talent|sing|dating|date|love|elimin|vote|quiz|game show|contestant|competit|trivia|judges|audition/i);

// Best original series per platform: series made by the platform's own network,
// best rated first. Scripted/unscripted both count; talk and news are left out.
function bestOriginals(networkIds, minVotes, minRating = 7.5) {
  return async () => {
    const items = await pages('/discover/tv', {
      with_networks: networkIds,
      without_genres: '10763,10767,10766',
      'vote_average.gte': minRating,
      'vote_count.gte': minVotes,
      sort_by: 'vote_average.desc',
    }, 6, 'tv');
    return items.sort((a, b) => b.vote_average - a.vote_average);
  };
}

// Best concert films: concert / live performance movies and music documentaries
async function bestConcertFilms() {
  const kw = await keywordIds(['concert', 'live concert', 'concert film', 'live performance']);
  const common = { 'vote_average.gte': 7, 'vote_count.gte': 150, sort_by: 'vote_average.desc' };
  const [byKw, byGenre] = await Promise.all([
    kw ? pages('/discover/movie', { ...common, with_keywords: kw }, 3, 'movie') : [],
    pages('/discover/movie', { ...common, with_genres: '10402,99' }, 3, 'movie'),
  ]);
  return [...byKw, ...byGenre].sort((a, b) => b.vote_average - a.vote_average);
}

// Hidden gems: very well rated but NOT popular. Few votes and a low TMDB popularity
// score, so franchise hits (Dragon Ball, Demon Slayer, Chainsaw Man...) are filtered out.
const GEM_MAX_POPULARITY = 30;
const GEM_MAX_VOTES_SERIES = 1200;
const GEM_MAX_VOTES_MOVIES = 2500;

async function hiddenGemsSeries() {
  const items = await pages('/discover/tv', {
    'vote_average.gte': 7.6,
    'vote_count.gte': 100,
    'vote_count.lte': GEM_MAX_VOTES_SERIES,
    sort_by: 'vote_average.desc',
  }, 10, 'tv');
  return items.filter((x) => (x.popularity || 0) <= GEM_MAX_POPULARITY);
}

async function hiddenGemsMovies() {
  const items = await pages('/discover/movie', {
    'vote_average.gte': 7.3,
    'vote_count.gte': 300,
    'vote_count.lte': GEM_MAX_VOTES_MOVIES,
    sort_by: 'vote_average.desc',
  }, 10, 'movie');
  return items.filter((x) => (x.popularity || 0) <= GEM_MAX_POPULARITY);
}

// Based on a true story (movies + series)
async function trueStory() {
  const kw = await keywordIds(['based on true story']);
  if (!kw) return [];
  const [m, t] = await Promise.all([
    pages('/discover/movie', { with_keywords: kw, 'vote_average.gte': 7, 'vote_count.gte': 1000, sort_by: 'vote_average.desc' }, 3, 'movie'),
    pages('/discover/tv', { with_keywords: kw, 'vote_average.gte': 7.5, 'vote_count.gte': 300, sort_by: 'vote_average.desc' }, 2, 'tv'),
  ]);
  return [...m, ...t].sort((a, b) => b.vote_average - a.vote_average);
}

// Feel-good & comfort watches: rom-com movies + well-loved sitcoms
async function feelGood() {
  const [m, t] = await Promise.all([
    pages('/discover/movie', { with_genres: '35,10749', 'vote_average.gte': 6.8, 'vote_count.gte': 1500, sort_by: 'popularity.desc' }, 3, 'movie'),
    pages('/discover/tv', { with_genres: '35', 'vote_average.gte': 7.8, 'vote_count.gte': 1000, sort_by: 'popularity.desc' }, 2, 'tv'),
  ]);
  const mixed = [];
  for (let i = 0; i < Math.max(m.length, t.length); i++) {
    if (m[i]) mixed.push(m[i]);
    if (t[i]) mixed.push(t[i]);
  }
  return mixed;
}

async function psychThrillerSeries() {
  const kw = await keywordIds(['psychological thriller', 'psychological', 'mind games']);
  if (!kw) return [];
  return pages('/discover/tv', { with_keywords: kw, 'vote_average.gte': 7, 'vote_count.gte': 200, sort_by: 'vote_average.desc' }, 3, 'tv');
}

async function psychopathRoles() {
  const kw = await keywordIds(['psychopath', 'sociopath', 'serial killer']);
  if (!kw) return [];
  const [m, t] = await Promise.all([
    pages('/discover/movie', { with_keywords: kw, 'vote_average.gte': 6.5, 'vote_count.gte': 500, sort_by: 'vote_average.desc' }, 3, 'movie'),
    pages('/discover/tv', { with_keywords: kw, 'vote_average.gte': 7, 'vote_count.gte': 200, sort_by: 'vote_average.desc' }, 2, 'tv'),
  ]);
  return [...m, ...t].sort((a, b) => b.vote_average - a.vote_average);
}

// Extra row: highly rated releases from the last 15 days
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
const SHOW_GENRES = '10764|10767'; // reality | talk
const ROWS = [
  { id: 'week-series', name: '📈 Trending This Week: Series', type: 'series', build: trendingWeekTv(isScriptedSeries) },
  { id: 'week-movies', name: '📈 Trending This Week: Movies', type: 'movie', build: trendingWeekMovies },
  { id: 'week-shows', name: '📈 Trending This Week: Shows', type: 'series', build: trendingWeekShows },
  { id: 'week-anime', name: '📈 Trending This Week: Anime Series', type: 'series', build: trendingWeekTv(isAnime) },

  { id: 'month-series', name: '🗓️ Trending This Month: Series', type: 'series', build: monthRow({ includeMovies: false, tvParams: { without_genres: '10764,10767,10763,10766' } }) },
  { id: 'month-movies', name: '🗓️ Trending This Month: Movies', type: 'movie', build: monthRow({ includeTv: false, movieParams: {} }) },
  { id: 'month-shows', name: '🗓️ Trending This Month: Shows', type: 'series', build: monthRow({ includeMovies: false, tvParams: { with_genres: SHOW_GENRES } }) },
  { id: 'month-standup', name: '🎤 Trending This Month: Stand-Up Comedy', type: 'movie', build: monthRow({ movieParams: { with_keywords: '9716' }, tvParams: { with_keywords: '9716' } }) },

  { id: 'new-netflix', name: '🆕 New on Netflix (15 days)', type: 'movie', build: recent('8', '213', /Netflix/i) },
  { id: 'new-prime', name: '🆕 New on Prime Video (15 days)', type: 'movie', build: recent('9|119', '1024', /Prime|Amazon/i) },
  { id: 'new-max', name: '🆕 New on Max (15 days)', type: 'movie', build: recent('1899|384', '49|3186', /Max|HBO/i) },
  { id: 'new-paramount-peacock-mgm', name: '🆕 New on Paramount+, Peacock & MGM+ (15 days)', type: 'movie', build: recent('531|582|386|34', '4330|3353|6219', /Paramount|Peacock|MGM/i) },
  { id: 'new-hulu-disney', name: '🆕 New on Hulu & Disney+ (15 days)', type: 'movie', build: recent('15|337', '453|2739|88', /Hulu|Disney|FX/i) },
  { id: 'new-apple', name: '🆕 New on Apple TV+ (15 days)', type: 'movie', build: recent('350', '2552', /Apple/i) },
  { id: 'new-crunchyroll', name: '🆕 New on Crunchyroll (15 days)', type: 'movie', build: recent('283', '1112', /Crunchyroll/i) },

  { id: 'new-starz-amc', name: '🆕 New on STARZ & AMC+ (30 days)', type: 'movie', build: recentNamed([/starz/i, /amc\s?\+|amc plus/i], /Starz|AMC/i) },
  { id: 'new-acorn-britbox-hallmark', name: '🆕 New on Acorn TV, BritBox & Hallmark+ (30 days)', type: 'movie', build: recentNamed([/acorn/i, /britbox/i, /hallmark/i], /Acorn|BritBox|Hallmark/i) },
  { id: 'new-bbc-sky', name: '🆕 New on BBC & Sky (30 days)', type: 'series', build: recentUk(30) },
  { id: 'new-hidive-shudder-discovery', name: '🆕 New on HIDIVE, Shudder & Discovery+ (30 days)', type: 'movie', build: recentNamed([/hidive/i, /shudder/i, /discovery\s?\+|discovery plus/i], /Hidive|Shudder|Discovery/i) },

  { id: 'new-free-indie-more', name: '🆕 New on Tubi, Pluto, Roku, BET+, MUBI & More (30 days)', type: 'movie', build: recentNamed(
      [/tubi/i, /pluto/i, /roku channel/i, /^bet\s?\+|bet plus/i, /mubi/i, /criterion/i, /curiosity/i, /youtube premium/i, /^vix/i, /^the cw|^cw$/i],
      /BET\+|Tubi|Pluto|Roku|MUBI|Criterion|Curiosity|YouTube|ViX|The CW/i,
      30,
      'flatrate|free|ads'
    ) },

  { id: 'best-anime', name: '🏆 Best Anime Series (Top Rated)', type: 'series', build: bestAnime },
  { id: 'ultimate-comedy', name: '😂 The Ultimate Comedy Movies', type: 'movie', build: ultimateComedy },
  { id: 'popular-comedy', name: '🎭 Popular Comedy Movies', type: 'movie', build: popularComedy },
  { id: 'best-docs', name: '🎞️ Best Documentaries (Movies & Series)', type: 'movie', build: bestDocumentaries },
  { id: 'best-travel-food', name: '🍜 Best Travel & Food Shows (Reality)', type: 'series', build: bestTravelFood },
  { id: 'best-physical-survival', name: '🏝️ Best Physical & Survival Reality Competitions', type: 'series', build: physicalSurvival },
  { id: 'best-talent-dating-quiz', name: '🎤 Best Talent, Dating, Elimination & Quiz Shows', type: 'series', build: talentDatingQuiz },
  { id: 'orig-netflix', name: '🔴 Best Netflix Original Series', type: 'series', build: bestOriginals('213', 500, 7.8) },
  { id: 'orig-apple', name: '🍎 Best Apple TV+ Original Series', type: 'series', build: bestOriginals('2552', 100, 7.5) },
  { id: 'orig-disney', name: '🏰 Best Disney+ Original Series', type: 'series', build: bestOriginals('2739', 100, 7.3) },
  { id: 'orig-prime', name: '📦 Best Prime Video Original Series', type: 'series', build: bestOriginals('1024', 200, 7.5) },
  { id: 'orig-paramount-peacock-amc-mgm', name: '⛰️ Best Paramount+, Peacock, AMC+ & MGM+ Originals', type: 'series', build: bestOriginals('4330|3353|174|6636|6219', 150, 7.5) },
  { id: 'best-concerts', name: '🎶 Best Concert Films', type: 'movie', build: bestConcertFilms },
  { id: 'animated-family-comedy', name: '🧸 Animated & Family Comedy Movies', type: 'movie', build: animatedFamilyComedy },
  { id: 'gems-series', name: '💎 Hidden Gems: Series', type: 'series', build: hiddenGemsSeries },
  { id: 'gems-movies', name: '💎 Hidden Gems: Movies', type: 'movie', build: hiddenGemsMovies },
  { id: 'true-story', name: '📖 Based on a True Story', type: 'movie', build: trueStory },
  { id: 'feel-good', name: '☀️ Feel-Good & Comfort Watches', type: 'movie', build: feelGood },
  { id: 'psych-thrillers', name: '🧠 Psychological Thriller Series', type: 'series', build: psychThrillerSeries },
  { id: 'psychopath-roles', name: '🔪 Psychopath Roles (Movies & Series)', type: 'movie', build: psychopathRoles },

  { id: 'top-new', name: '⭐ Top Rated New (15 days)', type: 'movie', build: topRatedNew },
];

const manifest = {
  id: 'community.streamvault',
  version: '1.7.0',
  name: 'StreamVault',
  description: 'Trending this week and month, plus brand-new releases (past 15 days) on Netflix, Prime, Max, Paramount+, Peacock, MGM+, Hulu, Disney+, Apple TV+ and Crunchyroll.',
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
