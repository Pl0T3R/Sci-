# ♠ Poker Night

A multiplayer Texas Hold'em (No-Limit) game you can play in the browser with friends on different devices.

- **Accounts:** register and log in. Passwords are hashed with scrypt, and logins last 30 days.
- **Password reset without email:** at registration you get a one-time **recovery code** (e.g. `J7TM-LTDK-LVCV`). "Forgot password?" plus that code lets you set a new password. Each code works once, and a new one is issued. You can also change your password or generate a new code from your profile.
- **Chips stay on your account.** New players get 1,000 chips. When you sit at a table you buy in from your account. When you stand up or leave, your stack goes back to it. Stacks are also saved after every hand, so a closed tab or a server restart never loses chips.
- **Daily reward:** +250 chips once per day (resets at midnight UTC). If you're broke (under 100 chips), you can also claim 500 free chips once an hour.
- **Crypto mine:** buy miners that produce chips around the clock, even while you're offline. To keep them balanced:
  - each miner takes roughly 3–5 days to pay for itself;
  - every extra miner of the same kind costs 15% more;
  - the vault only holds 24 hours of output, so you have to come back daily to collect.

  | Miner | Price | Chips / hour |
  |---|---|---|
  | 🔌 USB Stick Miner | 500 | 5 |
  | 💻 Old Laptop | 2,500 | 28 |
  | 🖥️ Gaming Rig | 10,000 | 125 |
  | 📟 ASIC Miner | 40,000 | 550 |
  | 🏭 Mining Farm | 150,000 | 2,250 |
- **Avatars:** pick an emoji and a color, or upload a photo (cropped to a 128px square).
- **Emotes:** 😂 😭 😡 😎 🤔 👏 🔥 💀 … pop up over your seat for everyone at the table.
- **Military win effects for big hands.** High card, pair, two pair and three of a kind only send the chips flying to the winner. From a straight up, each hand calls in a bigger strike, and the chips fly out of the impact:
  - straight: sniper scope view with sway and a heartbeat, then the shot;
  - flush: two fighter jets make a strafing run with tracers and a sonic boom;
  - full house: a drone camera locks onto the pot (night vision, radar lock), then a **Nike missile** hits: blast light, lens flare, a cracked crater, embers, and a shockwave that knocks the cards, chips and players back;
  - four of a kind: red alert, then a B-2 carpet-bombs across the felt;
  - straight flush: five targets lock on, then a missile barrage;
  - royal flush: DEFCON 1, a siren, then a nuke with a whiteout, mushroom cloud, fallout and falling ash.

  Most effects take 1–2.5 seconds; the nuke takes about 3.5. Each one ends with a stamped stencil banner naming the winner and their winnings, and synthesized sound with echo. You can preview them all from the lobby.
- **The table:** leather rail with a gold inlay, textured felt in 5 colors (🎨 button), avatar seats with a countdown ring, chip stacks, dealt and flipped cards, and synthesized sound effects (🔊 to mute).
- **Rooms by code:** one player creates a room and gets a code (or picks their own, e.g. `FRIDAY`). Friends enter the code, or open the invite link (`?room=FRIDAY`), and they're all at the same table.
- Up to 9 players per table, with side pots, all-in run-outs, a 30-second turn timer, chat, a hand log and a leaderboard.
- If you refresh or briefly lose connection, you keep your seat. Players who are gone for 2 minutes are stood up automatically and their chips go back to their account.

## Put it online (free): Render + Neon

This takes about 10 minutes and needs no credit card for the database. Render may ask for one to verify your account.

You need two free accounts:
- [Neon](https://neon.tech) hosts the database, so accounts and chips survive restarts.
- [Render](https://render.com) runs the game server.

**1. Create the database (Neon)**
1. Sign up at neon.tech (you can log in with GitHub).
2. Create a project. Pick the region **AWS Europe Central (Frankfurt)**.
3. On the project dashboard, click **Connect** and copy the connection string. It looks like `postgresql://user:password@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`. Keep it secret: it's the key to your database.

**2. Deploy the server (Render)**
1. Sign up at render.com with your GitHub account.
2. Click **New → Blueprint** and select this repository (`Sci-`). If it isn't listed, click the link to give Render access to it.
3. Render reads `render.yaml` and shows a service called `poker-night`. When it asks for `DATABASE_URL`, paste the Neon connection string.
4. Click **Apply**. The first build takes 2–3 minutes.
5. Open the service. Its address is at the top, e.g. `https://poker-night-xxxx.onrender.com`. That's the link for your friends.

**3. Play**
Register, create a room, and send your friends the invite link (the **Copy invite link** button on the table).

Good to know:
- **Sleeping server:** on Render's free plan the server goes to sleep after 15 minutes with nobody on it. The first visit after that takes up to a minute to load; after that it's fast.
- **Chips are safe:** they're stored in Neon, not on the server. Stacks on a table when the server sleeps or restarts go back to their owners.
- **Updates:** every push to this branch redeploys automatically. If Render doesn't pick up a push, use **Manual Deploy** in its dashboard.
- **Other hosts:** any host that runs Node.js with WebSockets works (Railway, Fly.io, a VPS). Set `DATABASE_URL` to a Postgres database, or set `DATA_DIR` to a persistent disk.

## Run it on your own computer

```bash
npm install
npm start          # http://localhost:3000
```

Friends on the **same Wi-Fi** can open `http://<your-computer's-IP>:3000`. For a quick test with friends elsewhere, `npx localtunnel --port 3000` gives you a temporary public link while your computer is on.

## Local sandbox (test mode)

A private copy of the game on your own computer, for trying things out alone. You need [Node.js](https://nodejs.org) (the LTS version).

- **Windows:** double-click `start-sandbox.bat`.
- **Mac/Linux:** run `./start-sandbox.sh`.
- **Anywhere:** `npm install`, then `npm run sandbox`.

The browser opens at `http://localhost:3000`. In the sandbox:

- **Test accounts:** `test1`, `test2`, `test3` (password `test`), each with 100,000 chips, plus one-click login buttons.
- **Several players on one computer:** every browser tab can be logged in to a different account.
- **🤖 Add bot:** bots sit at the table and play by themselves, so you can play alone. **🧹 Remove bots** sends them away.
- **🎯 Rig my next hand:** pick Straight … Royal Flush, and your next hand deals it to you. Play it to the showdown to see the win effect in a real game.
- **⏩ Skip 12 hours:** miners fill up and the daily reward comes back. **💰 +10,000 chips** tops up your account.

Sandbox data is kept in `sandbox-data/`, separate from the real game. `DATABASE_URL` is always ignored, so the sandbox can never touch the online database. The sandbox tools don't exist on a normally started server. To start over, run `npm run sandbox:reset`.

## Configuration

| Env var        | Default  | Meaning |
|----------------|----------|---------|
| `PORT`         | `3000`   | HTTP port (hosts set this automatically) |
| `DATABASE_URL` | –        | Postgres connection string. When set, everything is stored in the database. |
| `DATA_DIR`     | `./data` | Where `db.json` is kept when `DATABASE_URL` isn't set |
| `TRUST_PROXY`  | –        | Set when running behind a reverse proxy, so login rate limits see real client IPs. This is automatic on Render, Railway and Fly. |

## Tests

```bash
npm test
```

The tests cover hand ranking, betting rules (blinds, min-raise, big blind option, side pots, timeouts), the sandbox (rigged hands, bots, isolation from the real database), and account features (password reset, daily reward, miner income and vault cap, avatars). There is also an end-to-end run. The end-to-end test starts the real server, registers two players, plays a hand in a shared room, and checks that chips survive a server restart. To run the end-to-end test against Postgres, run `DATABASE_URL=postgres://… node --test test/server.test.js`.

## Project layout

```
server.js          HTTP API (register/login/refill) + Socket.IO rooms
src/db.js          Storage (JSON file or Postgres): users, sessions, chips, rewards, miners, avatars
src/table.js       Poker table engine (betting rounds, pots, showdown, timers)
src/hand.js        Deck + hand evaluator
public/            Browser client (index.html, app.js, effects.js, style.css)
public/fonts/      Black Ops One stencil font (SIL Open Font License)
src/sandbox.js     Sandbox mode: test accounts and bots
start-sandbox.*    Double-click launchers for the local sandbox
render.yaml        One-click Render deployment (Blueprint)
```

The chips are play money only. They have no real-world value.
