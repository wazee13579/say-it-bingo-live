# SAY IT! BINGO — Standalone multiplayer website

This is a **complete Bingo website with its own Node.js multiplayer server**. It does not use Higgsfield, Firebase, Supabase, or any account-based guest sign-in. All player interactions happen through your own server.

## Included

- Exactly **25 squares** on a 5×5 Bingo card, populated from your editable `sayings.txt` list
- A fresh **random card for every new player/tab**, with a Randomise My Card button
- A **name prompt** for each new player; no account required
- A **live leaderboard** synced to all connected players using server-sent events (SSE)
- Rows, columns, and diagonal Bingo detection; ranks by Bingos, longest uninterrupted streak, progress toward a line, then total marked
- Player cards and marked squares **saved on the server** (when its storage is persistent)
- A **private host control** to kick every player, end the room, clear the leaderboard, and create a brand-new room link
- Old room links are **invalidated on the server**; players cannot sneak back into the ended room
- Host permission is controlled by a private recovery link and an unguessable key; never included in public invitation links
- No external npm dependencies; Node.js 20+ is sufficient

## Add or change sayings (ONE file)

Open **`sayings.txt`** in the main directory (next to `server.mjs`) and put **one saying per line**. Add new lines or remove old sayings, then save it. No code changes are needed.

To edit on GitHub: open `sayings.txt` → click the pencil (Edit this file) → update the lines → **Commit changes**. Render redeploys automatically from the `main` branch, using the free web service you've connected.

- Blank lines are ignored; repeated identical lines are treated as a single saying.
- Use at least **two different sayings**; the game needs variety to randomise a card.
- Cards always have **25 squares**. With fewer than 25 sayings, some repeat; with 25 or more, each card uses 25 different sayings drawn at random.
- New sayings affect **newly created or randomised player cards** after the redeployment. Players' existing cards keep their previous sayings until they randomise.
- **Important on free Render hosting:** every redeployment restarts the server, and old rooms/scores/host links may be lost because its storage is temporary. Finish an active game before editing this file. Create a new room after redeploying.

## Test it on your computer

1. Install Node.js 20 or newer.
2. Unzip the folder, then open a terminal/Command Prompt in the folder containing `package.json`.
3. Run `npm start`.
4. Open http://localhost:3000 in a browser.
5. Click **Create a New Bingo Room**, type your name, and try the game.

This local address works on your own computer only. To let friends in other houses join, **deploy the Node.js server to a public hosting provider** (instructions below).

### How links work

- **Public invite link:** `https://your-site.example/?room=ROOM_CODE`
- **Private host recovery link:** `https://your-site.example/?room=ROOM_CODE#host=SECRET`

The public link is safe to share. The host recovery link is **not** safe to share: anyone with it can kick all players. Store that link privately, especially if you change browsers or clear browser data.

Each browser *tab* gets a separate random card on first join. Refreshing the same tab resumes its existing card and marks. A new tab or person joining creates a new card. Randomising a card resets that player's marks and Bingo score only.

### Kick everyone + new link

Only the host sees the **KICK EVERYONE + NEW LINK** button. When pressed and confirmed:

1. The old room is closed and its leaderboard is erased.
2. Everyone connected receives a message that the host ended the round.
3. The old invitation cannot be used to play again.
4. The host is taken to a brand-new room.
5. The new shareable invitation is displayed automatically.

**This is intentionally irreversible.** Existing progress is not migrated to the new room.

## Put it online (Render)

Render is an example of a third-party host, not a requirement. You could also use Railway, Fly.io, or any host that runs a persistent Node.js server.

1. Put the full unzipped folder in a GitHub repository.
2. In [Render](https://dashboard.render.com/), choose **New → Web Service** and connect the GitHub repository.
3. Use the **Node** runtime and the start command **`npm start`**. No build step or external packages are needed.
4. Use health check path **`/health`**.
5. When the deployment finishes, Render supplies a public `https://...onrender.com` address. Open it, create your room, and copy the public invitation link to your friends.

### Important: permanent storage

This small app saves room data to a JSON file on its own server. Its default data location is `data/state.json`. Many hosting services (including Render) use **temporary filesystems by default**. Without persistent storage, rooms, scores, and host keys will disappear on restart/redeploy.

For long-lived rooms on Render, choose a plan that supports a **persistent disk**, mount it at `/var/data`, and add the environment variable:

`STATE_FILE=/var/data/state.json`

Render's persistent disks are for paid web services. If you choose an ephemeral/free service, this version works while the server is running, but games can disappear after restarts or redeploys. Do not share a link you need to preserve until you have persistent storage configured.

Keep this website at **one server instance**; its file-based state and SSE connections are not designed for load-balancing across multiple machines. To scale out, replace file storage and in-process broadcasts with a shared database and pub/sub.

## Commands

- `npm start` — run server on port 3000 or the `PORT` environment variable
- `npm test` — run integration tests
- `npm run dev` — development server with reload on changed files

## Privacy and game rules

- Players enter a name, which others in the room can see on the leaderboard.
- Players do not have to sign into any provider.
- No email addresses, phone numbers, or passwords are collected.
- The app checks moves and host operations on the server. It does not verify that someone really heard a saying — this is a friendly, honour-system Bingo game.
- Public room links are unlisted, not secret-authenticated. Anyone with the public link can join that room.
- Players' names, cards, and hashed access credentials are stored in the server's JSON state file. Keep that file private, and do not commit it to GitHub.

## Files

`sayings.txt` — **the only file to edit to add or remove Bingo sayings**

`server.mjs` — HTTP, game rules, persistence, server validation and live updates

`public/index.html` — accessible, responsive interface

`public/style.css` — responsive Bingo visual design

`public/app.js` — player/host controls and live connection

`test/bingo.test.mjs` — end-to-end API and persistence tests

---

Built as an independent alternative to the original Higgsfield-hosted game.
