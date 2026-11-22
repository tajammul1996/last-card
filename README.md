# Last Card

A match-the-color multiplayer card game for 2–10 players, played on phones in the browser. One person starts a table, shares the link, and everyone joins. No accounts, no app install.

## Deploy on Render (free)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/tajammul1996/last-card)

1. Click the button above and sign in to Render with GitHub.
2. Confirm the `last-card` service (it reads `render.yaml`) and click **Apply** / **Deploy**.
3. When it's live, open the `https://last-card-xxxx.onrender.com` address it gives you.

Every push to `main` redeploys automatically.

**Free-tier note:** Render puts free services to sleep after about 15 minutes without visitors. The first person to open the link afterwards waits up to a minute while it wakes up. Tables live in memory, so a restart or sleep clears any game in progress.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # plays 25 full rounds with 5 simulated phones
```

## How it works

- `server.js`: Node HTTP + Socket.IO server. It holds every table in memory and is the only thing that changes game state, so each phone only ever receives its own hand.
- `public/engine.js`: the rules (deck, matching, skip/reverse/+2/+4, stacking, last-card catches). Shared by the server and the browser.
- `public/index.html`: the phone client.

Players are remembered by a random token in the browser, so refreshing or briefly losing signal puts you back in your seat.

## House rules

Toggle in the lobby before dealing:

- **Stack +2 and +4** (on by default): answer a +2 with a +2 or +4, or a +4 with a +4; the first player who can't draws the total.
- **Draw until you can play** (off by default).
