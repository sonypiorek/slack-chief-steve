# claude-code-bridge (Steve)

A Slack bot that gives Claude Code a two-way control channel from Slack. Tag `@Steve`
in a configured channel and Claude works in that channel's repo, committing straight to
`main` and replying in the thread.

## What it does

- `@Steve <task>` in a configured channel starts a Claude Code run in that channel's repo
- Reply in the thread with `@Steve <message>` to **resume the exact same Claude session**
- if you give it tools (like gmail or granola) it is able to perform a bunch of tasks, such as brief you into your next meeting, run research on your prospects, drafts follow ups. You can create claude skills, save them into your repo, run them auotmatially everyday, etc. 

## How session memory works (no database)

There is **no `sessions.json` or any server-side state**. The Slack thread *is* the store.

- Every Steve reply carries the Claude session id in Slack **message metadata**,
  invisible in the channel, but readable by the bridge (`include_all_metadata`)
- When you tag `@Steve` in a thread, the bridge reads the thread history, finds the most
  recent session id, and resumes that exact Claude session (`claude --resume <id>`)
- If none is found (e.g. an old thread Steve was tagged into mid-conversation), it
  starts fresh using the full thread history as context. Legacy threads that used the
  old visible `[SessionID: …]` text marker are still read, so they keep resuming too
- Nothing is lost on restart. Any thread can always be resumed just by tagging `@Steve`

The only runtime state is an in-memory list of *currently running* processes (used by
`status`, `stop`, and the TTL reaper), which is intentionally discarded on restart.

## Triggering

Steve responds **only** to explicit `@Steve` mentions. Plain thread replies with no
`@Steve` tag are ignored, so teammates can talk in a thread without triggering anything.

## Commands

| Command | Where | What |
|---|---|---|
| `@Steve <task>` | Channel | Start a new session in that channel's repo |
| `@Steve <message>` | Thread | Resume that thread's session (or start fresh from its history) |
| `@Steve status` | Anywhere | List currently running sessions (thread, channel, age, pid) |
| `@Steve stop` | Thread | Stop this thread's running session, committing any changes |
| `@Steve help` | Anywhere | Usage summary |

## Git model

- Commits directly to `REPO_BRANCH` (default `main`), no branches, never force-push
- Only touches git when `git status --porcelain` shows real changes
- Commit message: `steve: <first 60 chars of task>` (` (ended with error)` appended if the
  run errored, so partial work is still saved)
- Pulls `--rebase` only when the remote is strictly ahead; skips silently otherwise

## Security model

Read this before deploying. Steve runs Claude Code on your server with whatever
permissions you give it, so treat access to the bot as access to a shell.

**Tagging `@Steve` is code execution.** Anyone who can post in a configured
channel can have Claude Code act on that channel's repo and push to `main`,
with no approval step in between. `@Steve tighten the wording in the launch
brief` becomes a real Claude Code run on your server.

This holds no matter what the repo contains. Even if you only point Steve at a
folder of go-to-market docs, it still runs Claude Code with
`--dangerously-skip-permissions`, so it can run arbitrary shell commands on
the machine, not just edit those files. The blast radius is set by the server
account and the credentials it holds, not by whether the repo is prose or code.

That has a few consequences worth taking seriously:

- **Lock down channel membership.** Only put people you'd trust with push access
  to a repo into the channel mapped to it in `CHANNEL_REPO_MAP`. Prefer private
  channels. Adding someone to the channel hands them the keys.
- **Use `ALLOWED_SLACK_USER_IDS`.** Restrict triggering to a named allowlist
  instead of leaving it open to everyone in the channel.
- **Scope the Slack app to least privilege.** The manifest requests only the
  scopes the bridge needs. Don't add more, and don't install the app anywhere
  beyond the channels it has to be in.
- **Scope the git credentials narrowly.** Steve pushes with whatever git
  identity exists on the server. Give it push access to only the repos in
  `CHANNEL_REPO_MAP`. A per-repo deploy key beats a broad personal access token.
- **Run it as an unprivileged user.** The systemd unit runs as a normal user,
  not root. Keep it that way, and keep `.env` and the repos readable only by
  that user.
- **`.env` holds live tokens.** It's gitignored, so never commit it. Anyone who
  reads it can impersonate the bot.
- **Other people in the channel can influence Steve, even if they can't trigger
  it.** When Steve resumes or builds context it reads the whole thread, not just
  your messages. Someone in the channel who isn't on `ALLOWED_SLACK_USER_IDS` can
  still plant text that Claude may act on when an allowed user runs Steve. The
  allowlist controls who can *start* Steve; channel membership is the real trust
  boundary, so keep untrusted people out of mapped channels.

## Setup

Steve runs on any computer that stays on and online, so there are two ways to set it
up:

- **Just trying it out?** Do steps 1-6 on your own laptop.
- **Want it on 24/7 and reachable from your phone?** That needs an always-on server.
  Create the Slack app once (step 3), then follow the single checklist in step 7, which
  sets up everything else on the server.

Either way the setup is the same. Obviously, use claude to help you out if you get stuck. 

### 1. Install Bun and Claude Code

On the machine that will run Steve:

```bash
curl -fsSL https://bun.sh/install | bash         # Bun, the runtime Steve runs on
curl -fsSL https://claude.ai/install.sh | bash   # Claude Code
exec $SHELL                                       # reload your PATH
claude   # sign in once: press c, open the link in a browser, paste the code back, then /exit
```

### 2. Download Steve

```bash
git clone https://github.com/sonypiorek/slack-chief-steve.git ~/services/claude-code-bridge
cd ~/services/claude-code-bridge
bun install
```

### 3. Create the Slack app

In a browser:

1. Go to api.slack.com/apps, **Create New App -> From a manifest**, pick your
   workspace, and paste the contents of `slack-manifest.json`.
2. **Install** the app to your workspace, then copy the **Bot User OAuth Token**
   (`xoxb-…`).
3. Generate an app-level token: **Basic Information -> App-Level Tokens -> Generate**,
   give it the `connections:write` scope, and copy it (`xapp-…`). Socket Mode needs
   this one, and it does not exist until you generate it.

### 4. Configure

```bash
cp .env.example .env
nano .env
```

Fill in:
- `SLACK_BOT_TOKEN` (`xoxb-…`) and `SLACK_APP_TOKEN` (`xapp-…`)
- `CHANNEL_REPO_MAP`: single-line JSON mapping each channel ID to a repo path, e.g.
  `{"C0XXXXXXX":"/home/youruser/your-repo"}`. To get a channel ID, click the channel
  name in Slack and copy it from the bottom of the popup.
- `ALLOWED_SLACK_USER_IDS`: comma-separated Slack user IDs allowed to use Steve. Leave
  it empty and **everyone in the channel** can drive it, so set this.
- `REPO_BRANCH` and `SESSION_TTL_HOURS` (the defaults are fine)

Then two things that are easy to miss:

**Invite the bot to each channel.** In Slack, open every channel you listed and type
`/invite @Steve`. The bot only sees channels it has been invited to, so without this
Steve looks dead.

**Give Steve a repo it can push to.** This is a *different* repo from the bridge you
cloned in step 2: it's the project Steve actually edits (one per channel). Each path in
`CHANNEL_REPO_MAP` must be a clone on this machine with working `git push`. The secure
way is a per-repo deploy key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/steve_yourrepo -N ""
cat ~/.ssh/steve_yourrepo.pub   # add on GitHub: repo -> Settings -> Deploy keys -> Add key -> tick "Allow write access"
GIT_SSH_COMMAND='ssh -i ~/.ssh/steve_yourrepo' git clone git@github.com:you/your-repo.git ~/your-repo
git -C ~/your-repo config core.sshCommand 'ssh -i ~/.ssh/steve_yourrepo'
git -C ~/your-repo config user.name  "Steve (Claude Code)"
git -C ~/your-repo config user.email "steve@yourdomain.dev"
```

### 5. Run it

```bash
bun bridge.js
```

You should see the config banner and `⚡ Steve bridge running (Socket Mode)`. Tag
`@Steve help` in a configured channel to confirm it responds. Steve works for as long
as this stays running, which is enough to try it out. To keep it on permanently, see
step 7.

### 6. Giving Steve tools (MCP)

Optional, but it's where Steve gets useful: connect Gmail and it drafts replies from
your inbox, connect your meeting notes and it writes the follow-up.

Steve is just Claude Code, so you add tools the normal Claude Code way. Signed in as
the same user, run `claude` and use `/mcp` to add a server and log in (or
`claude mcp add ...` if you prefer the command line). Anything you connect is available
to every Steve run. The
[Claude Code MCP docs](https://docs.claude.com/en/docs/claude-code/mcp) have the exact
commands and the list of connectors.

One thing to keep in mind: connected tools run with no confirmation, so anyone who can
tag Steve can use them. Connect Gmail and they can read and send your mail. Only
connect what you'd trust everyone in that channel with.

### 7. Run it 24/7 (optional)

Steve only runs while your terminal is open, and a laptop sleeps when you close it. To
keep it on permanently and reach it from your phone, run it on an always-on Linux
server. This is the full setup as one checklist; it assumes you've created the Slack app
already (step 3), and everything else happens here on the server, ending with the service
that keeps Steve running for good:

1. **Rent a server.** A cheap VPS from Hetzner (around €4/mo) or DigitalOcean (around
   $4/mo). Create the smallest Ubuntu 24.04 instance and add your SSH key.
2. **Connect and make a non-root user:**
   ```bash
   ssh root@SERVER_IP
   adduser youruser && usermod -aG sudo youruser
   su - youruser
   ```
3. **Install Bun and Claude Code, then sign Claude in:**
   ```bash
   curl -fsSL https://bun.sh/install | bash
   curl -fsSL https://claude.ai/install.sh | bash
   exec $SHELL
   claude   # sign in once: press c, open the link in a browser, paste the code back, then /exit
   ```
4. **Download Steve:**
   ```bash
   git clone https://github.com/sonypiorek/slack-chief-steve.git ~/services/claude-code-bridge
   cd ~/services/claude-code-bridge && bun install
   ```
5. **Configure.** Copy the example and fill in the same Slack tokens from the app you
   already made, plus your `CHANNEL_REPO_MAP` and `ALLOWED_SLACK_USER_IDS`:
   ```bash
   cp .env.example .env && nano .env
   ```
6. **Give Steve a repo it can push to** (a per-repo deploy key is the safe way):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/steve_yourrepo -N ""
   cat ~/.ssh/steve_yourrepo.pub   # add on GitHub: repo -> Settings -> Deploy keys -> Add key -> tick "Allow write access"
   GIT_SSH_COMMAND='ssh -i ~/.ssh/steve_yourrepo' git clone git@github.com:you/your-repo.git ~/your-repo
   git -C ~/your-repo config core.sshCommand 'ssh -i ~/.ssh/steve_yourrepo'
   git -C ~/your-repo config user.name  "Steve (Claude Code)"
   git -C ~/your-repo config user.email "steve@yourdomain.dev"
   ```
7. **Run it as a service** so it survives crashes and reboots. If your user isn't
   `youruser`, edit `User=` and the paths in `claude-code-bridge.service` first.
   ```bash
   sudo ln -sf "$(which bun)" /usr/local/bin/bun
   sudo cp claude-code-bridge.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now claude-code-bridge
   systemctl status claude-code-bridge
   ```
   Watch the live logs with `journalctl -u claude-code-bridge -f`.

That's it. Steve runs around the clock, and everything happens in Slack from here.

## Requirements

- Bun (the runtime Steve runs on)
- Claude Code, installed and signed in
- Git push access to every repo in `CHANNEL_REPO_MAP`
