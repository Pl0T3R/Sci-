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
- **Win effects scale with the hand.** Every effect is over in about 2 seconds:
  - a plain win: chips fly to the winner;
  - two pair or trips: sparkles;
  - straight or flush: confetti and a banner;
  - full house: confetti cannons;
  - four of a kind: coin rain and a table shake;
  - straight flush: fireworks;
  - royal flush: everything, plus a golden flash.
- **The table:** leather rail with a gold inlay, textured felt in 5 colors (🎨 button), avatar seats with a countdown ring, chip stacks, dealt and flipped cards, and synthesized sound effects (🔊 to mute).
- **Rooms by code:** one player creates a room and gets a code (or picks their own, e.g. `FRIDAY`). Friends enter the code, or open the invite link (`?room=FRIDAY`), and they're all at the same table.
- Up to 9 players per table, with side pots, all-in run-outs, a 30-second turn timer, chat, a hand log and a leaderboard.
- If you refresh or briefly lose connection, you keep your seat. Players who are gone for 2 minutes are stood up automatically and their chips go back to their account.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

To play with friends on the **same Wi-Fi**, have them open `http://<your-computer's-IP>:3000`.

To play with friends **anywhere**, the server has to be reachable from the internet. Two options:

1. **Host it** on any service that runs Node.js with WebSockets (Render, Railway, Fly.io, a VPS, …).
   - Start command: `npm start`
   - The platform sets `PORT` automatically.
   - Set `DATA_DIR` to a **persistent disk/volume**. Accounts and chips are stored in `DATA_DIR/db.json`. Without a persistent disk, many hosts wipe files on each redeploy.
2. **Tunnel** from your own computer. For example, run `npx localtunnel --port 3000` or `cloudflared tunnel --url http://localhost:3000`, then share the URL it gives you.

## Configuration

| Env var    | Default  | Meaning                            |
|------------|----------|------------------------------------|
| `PORT`     | `3000`   | HTTP port                          |
| `DATA_DIR` | `./data` | Where `db.json` (accounts, chips, miners, avatars) is kept |

## Tests

```bash
npm test
```

The tests cover hand ranking, betting rules (blinds, min-raise, big blind option, side pots, timeouts), and account features (password reset, daily reward, miner income and vault cap, avatars). There is also an end-to-end run. The end-to-end test starts the real server, registers two players, plays a hand in a shared room, and checks that chips survive a server restart.

## Project layout

```
server.js          HTTP API (register/login/refill) + Socket.IO rooms
src/db.js          JSON-file storage: users, sessions, chips, rewards, miners, avatars
src/table.js       Poker table engine (betting rounds, pots, showdown, timers)
src/hand.js        Deck + hand evaluator
public/            Browser client (index.html, app.js, effects.js, style.css)
```

The chips are play money only. They have no real-world value.
