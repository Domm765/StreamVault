# StreamVault (Stremio addon)

Rows: Trending Today (series, movies, shows, anime), Recently Added on Netflix (15 days), Prime Video, Max, Paramount+, Hulu, Peacock & MGM+, Crunchyroll, plus Disney+, Apple TV+ and Top Rated New.

## Deploy from your phone
1. Get a free TMDB API key (themoviedb.org → Settings → API → "API Key (v3 auth)").
2. Create a new GitHub repo and upload `package.json`, `index.js`, `README.md`.
3. On render.com: New → Web Service → connect the repo.
   - Build command: `npm install`
   - Start command: `node index.js`
4. Add environment variable `TMDB_API_KEY` = your key. (Optional: `REGION` = e.g. `US`, `GB`, `FR`.)
5. When deployed, open `https://YOUR-APP.onrender.com/manifest.json` — if it shows text, it works.
6. In Stremio: Addons → paste `https://YOUR-APP.onrender.com/manifest.json` (or open the link and tap Install).

## Notes
- Data sources: TMDB (trending, movies, series) and TVmaze (streaming series and season premieres by platform).
- Every "New on ..." row only shows brand-new releases from the past 15 days: movies, series, documentaries and stand-up specials that premiered in that window on that platform. Older library titles that just arrived on a platform are not shown.
- Region defaults to US. Catalogues refresh every 3 hours.
