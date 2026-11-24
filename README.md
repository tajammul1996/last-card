# Last Card

A match-the-color multiplayer card game for 2–10 players, played on phones in the browser. One person starts a table, shares the link, and everyone joins. No accounts, no app install.

## Deploy on Render (free)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/tajammul1996/last-card)

1. Click the button above and sign in to Render with GitHub.
2. Confirm the `last-card` service (it reads `render.yaml`) and click **Apply** / **Deploy**.
3. When it's live, open the `https://last-card-xxxx.onrender.com` address it gives you.

Every push to `main` redeploys automatically.

The blueprint also creates **last-card-store**, a free Render Key Value instance. The server saves every table there, so games carry on after a redeploy or restart: phones reconnect on their own and players keep their seats, hands and chat. Without `REDIS_URL` the server still runs, keeping tables in memory only.

### Accounts and leaderboard (Upstash)

Players sign in with a name and a 4-digit PIN, and the leaderboard counts wins across all games. These live in a permanent store set by `STORE_URL` (an [Upstash](https://upstash.com) Redis URL, free plan). In Render: **last-card → Environment → STORE_URL**, paste the URL (`rediss://default:…@….upstash.io:6379`) and save. Without `STORE_URL` the server falls back to the Render Key Value store, which can be wiped when Render restarts it.

**Free-tier note:** Render puts free web services to sleep after about 15 minutes without visitors. The first person to open the link afterwards waits up to a minute while it wakes up.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # full rounds with simulated phones, sign-in, link switching, leaderboard, then a restart test (needs redis-server)
```

## How it works

- `server.js`: Node HTTP + Socket.IO server. It holds every table in memory and is the only thing that changes game state, so each phone only ever receives its own hand.
- `public/engine.js`: the rules (deck, matching, skip/reverse/+2/+4, stacking, last-card catches). Shared by the server and the browser.
- `public/index.html`: the phone client.

Players are remembered by a random token in the browser, so refreshing or briefly losing signal puts you back in your seat.

## Features

- Invite links open a join screen for that table, with the host and players listed. Opening a different table's link switches to it cleanly; a seat in a running game is kept so you can go back.
- Sign in with a name and 4-digit PIN on any phone. Five wrong PINs lock that name for 10 minutes.
- Leaderboard of wins across all games, with a tab per game, This week / All time, a top-3 podium, last played and your own row always visible. Winners see their new rank when a round ends; non-hosts can nudge the host to deal.
- Only the host (whoever created the table) deals and changes house rules. The host can hand that role to someone else, and if the host goes offline anyone can take over.
- Turn circle: players sit around the piles in play order; the ring flows the way play goes, the current player glows, the next one is marked, and Reverse flips the flow.
- Phone and desktop layouts: on a computer, chat docks beside the table and you can play with the keyboard (1–9 play a card, D draw, L Last card, C chat).
- Everyone at the table is told when someone joins or leaves, also mid-game.
- Table chat with quick replies and emoji reactions.
- A soft chime on your turn, a fanfare and confetti when a round is won, a pop for new messages. Players can turn sounds off under **Players**.
- Big hands scroll sideways with at least 60% of every card visible.
- When a new version is deployed, open phones show a **Refresh** banner, and a refresh puts you straight back in your seat.

## House rules

Toggle in the lobby before dealing:

- **Stack +2 and +4** (on by default): answer a +2 with a +2 or +4, or a +4 with a +4; the first player who can't draws the total.
- **Draw until you can play** (off by default).
