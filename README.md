# ENS Card

Hyperliquid India x ENS. Enter a .eth name and an X handle, get a score out of 100 from public Hyperliquid data, and land on a public leaderboard. 80 or more is needed to claim, and the first 25 to claim get a card, one per person.

Live: https://www.hyperliquidindia.com/ens-card
Source: https://github.com/Imdavid21/ens-card
Related: [Wick Runner](https://github.com/Imdavid21/wick-runner), the game from the same event, is its own project at https://www.hyperliquidindia.com/wick-runner

## Deploy (Vercel + Supabase)
1. Supabase: run supabase/schema.sql in the SQL editor.
2. Vercel: import this folder. Storage is Vercel Blob (BLOB_READ_WRITE_TOKEN) or Supabase. Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, optional HLN_KEY (your own), ETH_RPC (a reliable mainnet RPC).
3. Run `npm run smoke -- 0xYourWallet` locally first to check live API shapes (scripts/smoke.js).
4. Tune lib/config.js (eligibleAt) after the first real scores.

Local preview with fake data: `npm run dev` (MOCK=1), tests: `npm test`.

## UI source
The page is React (framer-motion) in ui/src, bundled with esbuild (cd ui && npm i && npm run build) and inlined into public/index.html together with the card engine (ui/src/engine-api.js). public/index.html is the file Vercel serves.


## Claims and storage

Claiming asks for the email the person used on Luma. It is stored apart from the public data (Blob: a path derived from the token, never listed; Supabase: `entries.email`, run supabase/schema.sql) and is never returned by any endpoint. One card per wallet and per email.

Blob holds three small JSON documents (`lb.json`, `claims.json`, one private emails file), cached in the function for 45 s. Keep it that way: the free plan counts every list and every read that misses the CDN.

The site lives at hyperliquidindia.com/ens-card: vercel.json rewrites /ens-card, /ens-card/terms and /ens-card/api/* to the files and functions at the root, and sends / and /terms there.

The back of the card is a field of words: Hyperliquid terms and assets on the Hyperliquid India side of the logo, ENS terms on the ens side, with the fixed numbers set quieter among them (`backWords` in public/index.html). `window.__BACK = "dump"` shows the genesis record dump instead; `window.__FRONT = "hypurr"` shows the Hypurr front.

## Other pages on this project

- `/` redirects to `/ens-card` until 30 Oct 2026; after that the root should point to `/home`.
- `/home`: Hyperliquid India community site. `public/home` is a build of `Imdavid21/hyperliquid-india` (`npx vite build --base=/home/`); its APIs are `api/stats.js`, `posts.js`, `events.js`, `articles.js`, `telegram.js` and `_lib.js`. Rebuild and copy to update.
- `/wick-runner`: Wick Runner (STRAT x Hyperliquid India). Leaderboard is `api/wick-scores.js` on Vercel Blob key `wick-runner/scores.json`.
- `/house-of-hype`: guest directory for House of HYPE (3 Nov). Visitors unlock it with the attendee code (or `?code=` in the link). Upload the Luma guest CSV at `/house-of-hype/admin` with the admin key; only approved guests are kept and email/phone are dropped. Data: Supabase `hoh_guests`; codes in `hoh_config` (`attendee_code`, `admin_key`). API: `api/hoh-guests.js`.

## Writing (Substack)

`/writing` and `/writing/:slug` render the Hyperliquid India Substack natively (`api/writing.js`, `lib/substack.js`, rewrites in vercel.json). The page reads `hyperliquidindia.substack.com/feed` (full post HTML) plus the archive API for older posts, rebuilds tweets as X embeds, drops Substack subscribe blocks, sanitizes the HTML and caches at the edge for 5 minutes, so new posts appear without a redeploy. Subscriber only posts and anything Substack cannot serve redirect to the original on Substack. The email box posts to Substack's own subscribe endpoint, so Substack still owns the list and delivery. `/api/articles` (used by `/home`) is the same function in json mode and now links free posts to `/writing/:slug`. Keep `api/*.js` at 12 files or fewer: the Hobby plan rejects deployments above that. Tests: `node --test test/writing.test.js`.
