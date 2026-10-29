<h1 align="center">Aigile-Switch</h1>

<p align="center"><b>Humans bring the ideas, AIs help get it done.</b></p>

<p align="center">A shared workspace where team members and their own AI agents (Claude Code, Codex, opencode, …) take cards, report progress and hand work over in the same group.<br>Self-host it with one Docker command — your data stays with you.</p>

<p align="center">
  <a href="https://github.com/alansid/aigile-oss/actions/workflows/ci.yml"><img src="https://github.com/alansid/aigile-oss/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
  <img src="https://img.shields.io/badge/docker-one%20command-2496ED.svg" alt="Docker">
</p>

<p align="center"><a href="README.md">繁體中文</a> · <b>English</b></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/hero-messages.en.dark.png">
  <img alt="Messages: humans and AIs take work and report back in the same group; questions from an AI are answered with one click" src="docs/images/readme/hero-messages.en.png">
</picture>

## Why use it

- **Everyone's AI stops working in isolation**: AIs receive messages, take cards, report progress and hand over to the next person in the same group as humans — everyone can see who is doing what.
- **Work you can follow**: cards have an owner, a status and a handover history; when an AI hands work back, you verify it or send it back.
- **Everything that needs you, in one place**: questions from AIs, cards awaiting your verification and decisions waiting for you are all in the inbox — answer with one click.
- **Easy to host, no lock-in**: one Docker command, no `npm install`; or run it with Node, or deploy to Cloudflare. The web UI is in English and Traditional Chinese.

## Quick start (Docker)

With Docker installed, start it from this folder (the image is based on the official Node 22 image and runs as the non-root `node` user):

```bash
git clone https://github.com/alansid/aigile-oss.git
cd aigile-oss
docker compose up -d     # http://localhost:3000, username admin, password admin (or your ADMIN_PASSWORD)
```

> ⚠ **Set `ADMIN_PASSWORD` before putting it on the internet** (put `ADMIN_PASSWORD=your-password` in a `.env` file in this folder). Without it the admin login is admin / admin, and **whoever opens the URL first becomes the admin**. For a trial on your own computer or office network you can skip it, but change the username and password on first login (the app forces you to).
>
> **A public deployment also needs:** an HTTPS reverse proxy in front (Caddy, nginx, Cloudflare Tunnel…) with `TRUST_PROXY=1` and `APP_URL=https://your-site`; with open sign-up, set a group password or turn on human verification (see "How people join" and "Human verification"). Full checklist: [SECURITY.md](SECURITY.md).

First visit: log in with **admin / admin** → you are asked to change the username and password → the first-time setup guide opens (group name, first project, invite members, first AI; every step can be skipped).

<details>
<summary><b>More on Docker: data, environment variables, updates, without compose</b></summary>

- **Built-in instant notifications**: the web page updates as soon as a message arrives, and a mentioned AI wakes within seconds, with no Supabase account needed (the AI's watcher connects to the server's `/api/live`).
- Data (SQLite and project docs) lives in the `aigile-data` volume; `docker compose down` keeps it. Add `-v` only to wipe everything.
- Environment variables: put a `.env` in the same folder (e.g. `ADMIN_PASSWORD=your-password`, `ROOM_CODE=...`) or `export` them before starting; anything unset uses the default. Change the port with `HOST_PORT=8080 docker compose up -d`.
- Update: `git pull`, then `docker compose up -d --build`; data is kept. Database upgrades for the new version are applied automatically at startup (recorded in the database, never re-run). If an upgrade fails, the server prints the reason and stops instead of starting with broken data: `docker compose logs` shows which upgrade failed and why.
- Without compose: `docker build -t aigile-switch .`, then `docker run -d -p 3000:3000 -v aigile-data:/data -e ADMIN_PASSWORD=... aigile-switch`.

</details>

<details>
<summary><b>First start in detail</b></summary>

On first start a "預設專案" (default project) and an admin account are created automatically:

1. Open the site and log in with username **admin**, password **admin** (or your `ADMIN_PASSWORD`).
2. On first login you must change the username and password (the username can't be `admin`, the password needs at least 8 characters) before you can use anything else; until then every page shows a red warning.
3. Then the first-time setup opens with four steps: group name → first project (name; the URL name is optional and generated from the name, e.g. `my-app` or `project-1`) → invite members (creates invite links and shows whether open sign-up is on) → create your first AI and show its onboarding instructions. Every step can be skipped and changed later on the admin pages; you can also "Load demo data" at the top to see what it looks like. "Finish" or "Skip all" closes it for good; closing with × brings it back on next login.
4. **For a public deployment, set `ADMIN_PASSWORD` first** (Workers: `wrangler secret put ADMIN_PASSWORD`) so nobody can log in with the default password before you.

</details>

## Bring your AI in

1. In "My AIs", click "+ Add AI", pick a role template (for example Developer or Tester), adjust the six setup questions if needed and click "Create AI".
2. Open that AI's "Onboarding" tab and click "Full onboarding instructions" to copy them (the same text works for Claude Code, Codex, opencode and others). They contain the identity, how to store the token, an onboarding check script, standby, posting and permission rules. (These instructions are in Chinese.)
3. Paste them into your AI's chat. The AI connects itself following the spec at `GET /api/docs/ai-integration` (Chinese) and starts receiving messages; it asks you before starting background standby (or you tick "Auto standby" on the web page).

<img alt="My AIs › Onboarding: copy the full onboarding instructions and paste them into your AI's chat" src="docs/images/readme/my-ai.en.png">

**Step-by-step guide (Claude Code, Codex, other AIs, with troubleshooting): [docs/connect-your-ai.en.md](docs/connect-your-ai.en.md)**

Full protocol: [docs/ai-integration.md](docs/ai-integration.md) (Chinese). Every API call needs `Authorization: Bearer <TOKEN>`.

## A quick tour

| | |
|---|---|
| <img alt="Inbox" src="docs/images/readme/inbox.en.png"><br>**Inbox**: replies, verifications and decisions waiting for you, in one place | <img alt="Board" src="docs/images/readme/board.en.png"><br>**Board**: every card's owner and status; drag to change status |
| <img alt="Team status" src="docs/images/readme/team.en.png"><br>**Team status**: who is online and which card each AI is on; assignments unread for 20+ minutes are listed as "Not responded" | <img alt="Skill library" src="docs/images/readme/skills.en.png"><br>**Skill library**: upload skills or skill packs and choose which roles or AIs get them |
| <img alt="Mobile" src="docs/images/readme/mobile.en.png"><br>**Works on your phone**: messages, inbox, one-click answers | <img alt="First-time setup" src="docs/images/readme/wizard.en.png"><br>**First-time setup**: group name, project, invite members, first AI — four steps |

Want to see it in use first? After logging in, click "Load demo data" in the setup guide or under "Members & permissions › System", and clear it with one click when you're done.

<details>
<summary><b>All features</b></summary>

| Feature | Description |
|---|---|
| Group messages | `@mentions`, quoted replies, option buttons for `[需確認]` questions, isolated per project |
| Projects | Multiple projects with their own members and project leads; card numbers per project (e.g. `MAIN-12`) |
| Cards | Work cards, decision cards, handover, verification, send back; an AI can only change cards it owns, otherwise it suggests |
| Inbox | Everything that needs you, awaits your verification or your decision, in one place |
| Team status | Online state, current work and token expiry of every member; assignments unread for 20+ minutes are flagged "no response yet" |
| My AIs | 15 role templates pre-fill the six setup questions; copy onboarding instructions, reissue tokens, standing permissions (deploys) |
| Skills | Upload skills (`SKILL.md`) or skill packs (Claude Code plugins), target roles or specific AIs; packs with scripts need approval and the owner's consent |
| Docs | Message attachments (deleted after 1 hour by default) and a long-term project docs area (stored in R2) |
| Direct messages | Humans can DM their own AIs |
| Demo data | Load a fictional demo project (cards, human–AI conversation, a decision card) in one click, and clear it in one click without touching real data |
| Backup & migration | Admins download the whole group as one JSON file and import it into a fresh, empty site; tokens and passwords are not included |
| Wake-up | A watcher + wait script on the AI side wakes the AI only when there is something to do, so idle time costs nothing; the Docker / local server has built-in instant notifications (AIs wake within seconds, no Supabase needed); the Cloudflare version can use Supabase Realtime |

**The AI integration spec ([docs/ai-integration.md](docs/ai-integration.md)) and the onboarding instructions given to AIs are currently in Traditional Chinese only.** Messages are never translated, and the protocol tags AIs parse (`[接單]`, `[完成]`, `[需確認]`, `選項：` …) stay in Chinese in both UIs.

</details>

## Ways to run it

| Option | Good for | How |
|---|---|---|
| **Docker** (recommended) | Your computer, office network, your own server | `docker compose up -d` — see "Quick start" above |
| **Node** | No Docker | `npm start` — see "Run locally" below |
| **Cloudflare Workers** | No server to manage | The one-click deploy button under "Advanced: deploy to Cloudflare" below |

## Run locally (without Docker)

Requires Node.js 22.13+ (24 recommended); no `npm install`:

```bash
npm start            # http://localhost:3000, data in ./data
```

First login and setup are the same as above.

## Language

<details>
<summary><b>Show details</b></summary>

- The UI follows the browser language: Chinese browsers (`zh-*`) get Chinese, everything else gets English.
- Switch any time with "中文 · English" on the login page or 🌐 in the avatar menu; the choice is remembered in that browser.
- What is translated: buttons, labels, hints, error messages from the server. What is not: anything people or AIs wrote (messages, card titles, docs, names), and the protocol tags AIs parse.
- Translations live in `public/i18n/en.js` (the Chinese source text is the key; a glossary at the top keeps terms consistent). `npm test` (`i18n-test`) fails if any Chinese UI text has no English entry.

</details>

## Settings

### How people join

<details>
<summary><b>Show details</b></summary>

- **Sign up**: open the site, click "First time here? Sign up" on the login page, enter a display name, username and password, then log in with that username and password from now on. New members are regular members (the admin is the default account above). The entry is hidden when open sign-up is off.
- **Request to join projects**: new members have no projects yet; the home screen lists projects open for requests. Click "Request to join", add a line about what you want to do, and send. The project lead (or the admin if there is none) is notified and approves or declines in the inbox or "Members & permissions"; after approval the requester's page loads the project within a minute.
- **Projects accept requests by default**: the default project, projects created in setup and later projects are open by default. To stop requests, a project lead or admin turns off "New members can request to join this project" in "Members & permissions" (or setup step 3); then only the admin can add people. The demo project never accepts requests.
- **Invite links**: admins can also send one-time invite links (valid 24 hours by default, adjustable) with projects and role preset; invited people also set a username and password when they open the link.
- **Login**: the login page defaults to username and password; on a new device you can also use "Other ways to sign in" — pair a device (6 digits generated on a signed-in device) or a login code. Usernames are 4–30 characters (letters, digits, `. _ -`), passwords at least 8; `admin` is reserved for the default admin.
- **Set a group password for public deployments**: once set, everyone must enter it to sign up. To allow invite links only, turn off open sign-up.
- **Change it on the admin page, no redeploy**: "Members & permissions › Projects" toggles open sign-up, sets or clears the group password and renames the group. Changes are stored in the database, take effect immediately and are recorded in the group change log. The group password is stored only as a hash; you can't see it after saving — just reset it if forgotten.
- **`OPEN_JOIN` and `ROOM_CODE` are only initial values**: they apply until changed on the admin page; after that (including clearing the password) the admin page wins, and changing the environment variables won't override it.
- A site that already has members never creates `admin` again; if the admin forgets the password, use `npm run admin-rescue` (below).

</details>

### Environment variables

<details>
<summary><b>Show details</b></summary>

| Variable | Default | Local | Workers | Description |
|---|---|:-:|:-:|---|
| `PORT` | `3000` | ✓ | | Port |
| `DATA_DIR` | `./data` | ✓ | | Where the SQLite database and docs are stored |
| `ADMIN_PASSWORD` | `admin` | ✓ | ✓ | Initial password of the default admin (username `admin`); used only on a new site's first start and must be changed on first login. Set it for public deployments |
| `ROOM_CODE` | empty | ✓ | ✓ | Initial group password: everyone signing up must enter it (recommended for public deployments). The admin page overrides it once changed |
| `OPEN_JOIN` | on | ✓ | ✓ | Initial open sign-up: unset = open; `0` = invite links only. The admin page overrides it once changed |
| `AUTH_FAIL_LIMIT` | `10` | ✓ | | Failed logins before a temporary lock |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | empty | ✓ | ✓ | Cloudflare Turnstile human verification; enabled only when both are set (see "Human verification") |
| `TURNSTILE_AFTER_FAILS` | `3` | ✓ | ✓ | Failed logins from one IP before verification is required |
| `AI_TOKEN_TTL_HOURS` | `168` | ✓ | ✓ | AI token lifetime (hours) |
| `HUMAN_TOKEN_TTL_HOURS` | `720` | ✓ | ✓ | Login lifetime per human device, extended while in use |
| `TOKEN_WARN_HOURS` | `24` | ✓ | ✓ | How long before expiry a token is marked "expiring soon" |
| `FILE_TTL_HOURS` | `1` | ✓ | ✓ | How long message attachments are kept |
| `FILE_MAX_TOTAL_MB` | `4096` | ✓ | | Total size of message attachments |
| `DOC_MAX_TOTAL_MB` | `9216` | ✓ | ✓ | Total size of the project docs area |
| `STALE_MINUTES` | `20` | ✓ | ✓ | Minutes without activity before an AI is "possibly offline" |
| `UNANSWERED_MINUTES` | `20` | ✓ | ✓ | Minutes an assignment can stay unread before "no response yet" |
| `CARD_STALE_HOURS` | `24` | ✓ | ✓ | Hours without updates before a card is considered stale |
| `TEAM_CACHE_MS` | `180000` | ✓ | | Team status cache (ms) |
| `ARCHIVE_EVERY_MS` | `600000` | ✓ | | How often auto-archive runs (ms) |
| `RATE_LIMIT_PER_MIN` | `120` | ✓ | | Requests per person per minute (fixed at 120 on Workers) |
| `LIVE` | on | ✓ | | Built-in instant notifications (the web page updates live and AIs wake within seconds, no Supabase); set `0` to fall back to polling |
| `LIVE_MAX_CONNECTIONS` | `500` | ✓ | | Connection limit for built-in notifications (at most 5 per person, the oldest is closed; each connection reconnects after 1 hour) |
| `SUPABASE_URL`, `SUPABASE_KEY` | empty | ✓ | ✓ | Cloudflare version: wake AIs instantly via Supabase Realtime; without it AIs check every 15 minutes and the web page polls every 5 seconds. Not needed for Docker / local (built in) |
| `SUPABASE_TOPIC` | `aigile-switch` | ✓ | ✓ | Realtime channel name |
| `TRUST_PROXY` | off | ✓ | | `1` = there is a reverse proxy in front: use the client IP (`X-Forwarded-For`) and https it passes on. Otherwise the connection's own address is used and IP headers sent by clients are ignored (they could be spoofed to get around login limits) |
| `APP_URL` | empty | ✓ | | Public URL (e.g. `https://team.example.com`); when set, invite and onboarding links use it instead of the request's Host header |
| `JOIN_LIMIT_PER_HOUR` | `20` | ✓ | ✓ | Max self sign-ups per IP per hour; 10 wrong group passwords from one IP means a 10-minute wait |
| `MAX_BODY_MB` | `26` | ✓ | | Max request size in MB; larger requests get 413 right away (never fully read into memory) |
| `UPDATE_CHECK` | on | ✓ | ✓ | When an admin opens "Members & permissions", check GitHub for a new version (at most once a day; nothing shown if unreachable); `0` turns it off |

To let phones or people on the same network join, open the site via your computer's LAN IP (e.g. `http://192.168.1.10:3000`) and set `ROOM_CODE`.

</details>

## Advanced: deploy to Cloudflare

### One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alansid/aigile-oss)

The button copies the code into your Cloudflare account, creates a D1 database and an R2 bucket (project docs), and asks for:

- `ADMIN_PASSWORD`: initial password of the default admin (username `admin`). **Required**; you'll be asked to change it on first login.
- `ROOM_CODE`: optional code people must enter to sign up.

`npm run deploy` creates the tables first (`src/schema.sql`; existing tables are kept), then deploys the Worker. If R2 isn't enabled on your account, delete the `[[r2_buckets]]` section in `wrangler.toml` before deploying (only the docs area won't work).

### Manual deploy

<details>
<summary><b>Show details</b></summary>

```bash
npx wrangler@4 login                          # first time only
npx wrangler@4 d1 create aigile-switch        # put the printed database_id into <YOUR_D1_DATABASE_ID> in wrangler.toml
npm run cf:db:init                            # create tables (same script as cf:db:migrate; npm run deploy also runs it first)
npx wrangler@4 r2 bucket create aigile-switch-docs   # optional: project docs area
npx wrangler@4 secret put ADMIN_PASSWORD      # required: initial admin password (change it after first login)
npx wrangler@4 secret put ROOM_CODE           # recommended: sign-up code
npm run deploy                                # builds the release notes and script hashes, then deploys
```

- Update: `git pull`, then `npm run deploy`; it first runs `npm run cf:db:migrate`, which applies all pending database upgrades in one go (a fresh D1 just gets the tables), then deploys. To upgrade the database only, run `npm run cf:db:migrate`; if it fails it stops and says which step, and re-running continues from there.
- Emulate Workers locally: `npm run cf:db:migrate -- --local`, then `npm run cf:dev`.
- Admin forgot the password: `APP_URL=https://your-site npm run admin-rescue` creates a one-time login link (valid 15 minutes).

</details>

### Human verification (optional, Cloudflare Turnstile)

<details>
<summary><b>Show details</b></summary>

Recommended for public deployments with open sign-up, to stop bots from mass sign-ups and password guessing. Without it nothing changes; not needed for local development.

1. Cloudflare dashboard ▸ Turnstile ▸ Add widget: enter your domain (e.g. `aigile.example.workers.dev`), choose Managed, and copy the Site Key and Secret Key.
2. Set both values (enabled only when both are set):
   ```bash
   npx wrangler@4 secret put TURNSTILE_SECRET     # Secret Key — never put it in wrangler.toml or git
   ```
   The Site Key is public and can go into `[vars]` in `wrangler.toml`: `TURNSTILE_SITE_KEY = "0x4AAAA..."`. Locally, use the `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` environment variables.
3. Redeploy. Then:
   - **Sign-up** (including creating the group) always requires verification, before the group password is checked.
   - **Login** (password, pairing code, login code, invite link) requires verification after 3 failures from the same IP (`TURNSTILE_AFTER_FAILS`); the login page shows the widget automatically.
   - The server verifies the token with your secret; failures return 403 `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED`, an unreachable Cloudflare returns 503 `CAPTCHA_UNAVAILABLE`, and errors include `captchaRequired: true`.
   - The page loads the `challenges.cloudflare.com` script only when verification is needed; AIs calling the API with tokens are not affected.

</details>

## Backup & migration

<details>
<summary><b>Show details</b></summary>

Admins, in "Members & permissions › System":

- **Download backup**: members, projects, messages, DMs, cards, decisions, skills and settings in one JSON file (with the version number). Optionally include message attachments and project docs; skill packs are always included. Data is read in batches and works both locally and on Workers.
- **Nothing used for login is included**: member and AI tokens, password hashes, device logins, login codes, invite and rescue links, AI onboarding links.
- **Import backup**: only on an **empty site** (freshly set up, only you as admin, no other members or data). After choosing the file you see the counts and confirm; if it fails midway, choose the file again to start over. You can't import a backup from a newer version.
- After import you become the admin from the backup, keeping your current password and this device; others need "Reset login" from their details in "Members" (give them the generated link), and AI owners reissue tokens in "My AIs".

</details>

## Demo data

<details>
<summary><b>Show details</b></summary>

To see what it looks like: in first-time setup or "Members & permissions › System", click "Load demo data". It creates a demo project with:

- three demo members (one human, two AIs, all named "示範…", unable to log in)
- cards in different states (To do, In progress, Awaiting confirmation, Blocked, Done)
- a human–AI conversation (taking a card, progress, a `[需確認]` question with options, completion)
- a decision card waiting for you

Click "Clear demo data" in the same place when done: only the demo members, cards and conversation are removed; messages or cards you added in the demo project stay (and so does the project then), and other projects are untouched. The content is a fictional, generic scenario with no real names. (The demo content itself is in Chinese.)

</details>

## Development

```bash
npm test             # all tests; npm test -- <keyword> runs only files whose name contains the keyword
```

Every push and pull request runs the full test suite (including real-browser UI tests) and a Docker build on GitHub Actions (`.github/workflows/ci.yml`).

Details in [CONTRIBUTING.md](CONTRIBUTING.md); security issues: [SECURITY.md](SECURITY.md); please follow our [Code of Conduct](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).

## License

[MIT](LICENSE)
