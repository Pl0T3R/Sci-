# ♠ Poker Night

A multiplayer Texas Hold'em (No-Limit) game you can play in the browser with friends on different devices.

- **Accounts:** register and log in. Passwords are hashed with scrypt, and logins last 30 days.
- **Chips stay on your account.** New players get 1,000 chips. When you sit at a table you buy in from your account. When you stand up or leave, your stack goes back to it. Stacks are also saved after every hand, so a closed tab or a server restart never loses chips.
- **Rooms by code:** one player creates a room and gets a code (or picks their own, e.g. `FRIDAY`). Friends enter the code, or open the invite link (`?room=FRIDAY`), and they're all at the same table.
- Up to 9 players per table, with side pots, all-in run-outs, a 30-second turn timer, chat, a hand log and a leaderboard.
- If you're broke (under 100 chips), you can claim 500 free chips once an hour from the lobby.
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
| `DATA_DIR` | `./data` | Where `db.json` (accounts) is kept |

## Tests

```bash
npm test
```

The tests cover hand ranking, betting rules (blinds, min-raise, big blind option, side pots, timeouts) and an end-to-end run. The end-to-end test starts the real server, registers two players, plays a hand in a shared room, and checks that chips survive a server restart.

## Project layout

```
server.js          HTTP API (register/login/refill) + Socket.IO rooms
src/db.js          JSON-file storage for users, sessions and chip balances
src/table.js       Poker table engine (betting rounds, pots, showdown, timers)
src/hand.js        Deck + hand evaluator
public/            Browser client (index.html, app.js, style.css)
```

The chips are play money only. They have no real-world value.
