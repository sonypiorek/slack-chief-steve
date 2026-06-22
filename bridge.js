// Steve — Slack ↔ Claude Code bridge (Bun runtime, @slack/bolt Socket Mode).
//
// State model: there is NO file-based state. The Slack thread IS the store.
// Every Steve reply carries the Claude session id in invisible Slack message
// metadata; when @Steve is mentioned in a thread we scan the history for the most
// recent one and resume that exact Claude session (legacy threads using the old
// visible `[SessionID: <id>]` text marker are still read). The only runtime state
// is `running` — an in-memory map of executing processes, lost on restart.
//
// Bun loads .env natively; systemd injects it via EnvironmentFile. No dotenv needed.
const { App } = require('@slack/bolt');
const { execSync, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

// ── Config ────────────────────────────────────────────────────────────────────
let CHANNEL_REPO_MAP;
try {
  CHANNEL_REPO_MAP = JSON.parse(process.env.CHANNEL_REPO_MAP || '{}');
} catch (e) {
  console.error(`[ERROR] CHANNEL_REPO_MAP is not valid JSON: ${e.message}`);
  process.exit(1);
}

const REPO_BRANCH    = process.env.REPO_BRANCH || 'main';
const SESSION_TTL_MS = (parseFloat(process.env.SESSION_TTL_HOURS) || 5) * 60 * 60 * 1000;
const TTL_HOURS      = process.env.SESSION_TTL_HOURS || 5;
const ALLOWED_USERS  = (process.env.ALLOWED_SLACK_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const CLAUDE_BIN     = process.env.CLAUDE_BIN || '/home/youruser/.local/bin/claude';
const HOME           = process.env.HOME || '/home/youruser';

const SLACK_MAX     = 3500;   // practical per-message text budget
const MAX_CHUNKS    = 8;      // cap output messages to avoid flooding
const SID_RE        = /\[SessionID:\s*([^\]]+)\]/;

// ── Runtime state ───────────────────────────────────────────────────────────────
const running       = new Map(); // threadTs -> { proc, startedAt, channelId, repoPath, task }
const repoChains     = new Map(); // repoPath -> Promise (per-repo serialization mutex)
const userNameCache = new Map(); // userId -> display name
let BOT_USER_ID = null;

// ── Slack app ───────────────────────────────────────────────────────────────────
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// ── Logging ─────────────────────────────────────────────────────────────────────
function log(tag, ...parts) {
  console.log(tag, ...parts);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function isAllowed(userId) {
  if (ALLOWED_USERS.length === 0) return true;
  return ALLOWED_USERS.includes(userId);
}

// ── Per-repo async mutex ────────────────────────────────────────────────────────
// Serializes the whole fetch→claude→commit unit per repo so concurrent threads on
// the same repo can't have `git add -A` capture each other's in-progress edits.
function withRepoLock(repoPath, fn) {
  const prev = repoChains.get(repoPath) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  repoChains.set(repoPath, next.finally(() => {
    if (repoChains.get(repoPath) === next) repoChains.delete(repoPath);
  }));
  return next;
}

// ── Text helpers ────────────────────────────────────────────────────────────────
function stripMention(text) {
  return (text || '').replace(/<@[UW][A-Z0-9]+(\|[^>]+)?>/g, '').trim();
}

function stripSessionLine(text) {
  return (text || '').replace(/\n*\[SessionID:[^\]]*\]\s*$/, '').trim();
}

// Read the Claude session id off a message: prefer invisible Slack message
// metadata, fall back to the legacy `[SessionID: <id>]` text marker so threads
// started before metadata was introduced still resume.
function sessionIdOf(msg) {
  const meta = msg?.metadata?.event_payload?.session_id;
  if (meta) return String(meta).trim();
  // Only honour the legacy text marker on Steve's own messages, so a user can't
  // post a fake `[SessionID: …]` to redirect a resume at someone else's session.
  if (!isSteve(msg)) return null;
  const m = (msg?.text || '').match(SID_RE);
  return m ? m[1].trim() : null;
}

// Scan messages bottom-up for the most recent session id.
function extractSessionId(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const sid = sessionIdOf(messages[i]);
    if (sid) return sid;
  }
  return null;
}

function isSteve(msg) {
  return Boolean(msg.bot_id) || (BOT_USER_ID && msg.user === BOT_USER_ID);
}

// ── User name resolution (cached) ───────────────────────────────────────────────
async function userName(client, id) {
  if (!id) return 'unknown';
  if (userNameCache.has(id)) return userNameCache.get(id);
  let name = id;
  try {
    const res = await client.users.info({ user: id });
    name = res.user?.profile?.display_name || res.user?.real_name || id;
  } catch (e) {
    // names are cosmetic — fall back to the raw id
  }
  userNameCache.set(id, name);
  return name;
}

async function resolveNames(client, ids) {
  const distinct = [...new Set(ids.filter(Boolean))];
  await Promise.all(distinct.map(id => userName(client, id)));
}

// ── Image attachments (ephemeral) ─────────────────────────────────────────────
// Claude reads images from disk by path, so we must write them somewhere — but only
// for the lifetime of the run. We download into a fresh per-run OS temp dir and the
// caller deletes the whole dir in `finally`, so nothing persists. The temp dir is
// outside any repo, so `git add -A` never sees it either. Slack's url_private needs
// the bot token as a bearer header AND the `files:read` scope. Bun's built-in fetch.
// Returns { dir, paths }; `dir` is null when there are no images to clean up.
async function downloadImages(files) {
  const images = (files || []).filter(f => (f.mimetype || '').startsWith('image/'));
  if (images.length === 0) return { dir: null, paths: [] };
  const dir = fs.mkdtempSync(`${os.tmpdir()}/steve-img-`);
  const paths = [];
  for (const f of images) {
    const url = f.url_private_download || f.url_private;
    if (!url) continue;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });
      if (!res.ok) { log('[IMG:ERR]', f.id, `http ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const safeName = (f.name || `${f.id}.img`).replace(/[^\w.\-]/g, '_');
      const dest = `${dir}/${safeName}`;
      fs.writeFileSync(dest, buf);
      paths.push(dest);
      log('[IMG]', dest, `${buf.length}b`);
    } catch (e) {
      log('[IMG:ERR]', f.id, e.message);
    }
  }
  return { dir, paths };
}

function cleanupImages(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); log('[IMG:CLEAN]', dir); }
  catch (e) { log('[IMG:ERR]', 'cleanup', e.message); }
}

// ── Slack posting ─────────────────────────────────────────────────────────────
async function postMsg(client, channel, threadTs, text, metadata) {
  await client.chat.postMessage({
    channel, thread_ts: threadTs, text,
    ...(metadata ? { metadata } : {}),
  });
}

// Split text into <=max-char chunks on line boundaries; hard-split over-long lines.
function chunkForSlack(text, max = SLACK_MAX) {
  const chunks = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (line.length > max) {
      if (buf) { chunks.push(buf); buf = ''; }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    if (buf.length + line.length + 1 > max) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [''];
}

// Post a result, splitting if needed; append the SessionID marker to the LAST chunk.
async function postResult(client, channel, threadTs, resultText, sessionId) {
  let chunks = chunkForSlack(resultText || '_(no output)_');
  let truncated = false;
  if (chunks.length > MAX_CHUNKS) {
    chunks = chunks.slice(0, MAX_CHUNKS);
    truncated = true;
  }
  for (let i = 0; i < chunks.length; i++) {
    let text = chunks[i];
    const isLast = i === chunks.length - 1;
    if (isLast && truncated) text += '\n\n…(output truncated)';
    // Carry the session id in invisible Slack message metadata, not the body,
    // so it never shows in the channel. Read back via include_all_metadata.
    const metadata = (isLast && sessionId)
      ? { event_type: 'steve_session', event_payload: { session_id: sessionId } }
      : undefined;
    await postMsg(client, channel, threadTs, text, metadata);
  }
}

// ── Git helpers (all run inside withRepoLock) ───────────────────────────────────
function git(repoPath, args) {
  return execSync(`git -C ${repoPath} ${args}`).toString();
}

function gitFetch(repoPath) {
  execSync(`git -C ${repoPath} fetch origin`, { stdio: 'pipe' });
}

// Pull --rebase only if origin is strictly ahead. Returns 'pulled' | 'skip'.
// Throws on rebase failure (diverged) so the caller can abort the run.
function pullIfAhead(repoPath, branch) {
  let hasUpstream = true;
  try {
    git(repoPath, 'rev-parse --abbrev-ref --symbolic-full-name @{u}');
  } catch (e) {
    hasUpstream = false;
  }
  if (!hasUpstream) {
    log('[GIT:SKIP]', repoPath, 'no upstream');
    return 'skip';
  }
  const behind = parseInt(git(repoPath, `rev-list --count HEAD..origin/${branch}`).trim(), 10) || 0;
  if (behind === 0) {
    log('[GIT:SKIP]', repoPath, 'up to date');
    return 'skip';
  }
  log('[GIT:PULL]', repoPath, `behind ${behind}`);
  execSync(`git -C ${repoPath} pull --rebase origin ${branch}`, { stdio: 'pipe' });
  return 'pulled';
}

function gitHasChanges(repoPath) {
  return git(repoPath, 'status --porcelain').trim().length > 0;
}

function commitMsg(task, errored) {
  const base = `steve: ${(task || 'session').slice(0, 60)}`;
  return errored ? `${base} (ended with error)` : base;
}

// Commit any leftover working-tree changes, then push if the local branch is ahead
// of origin. The push gate is separate from the commit gate because Claude often
// commits its own work (leaving a clean tree but an unpushed commit) — we still
// need to push those.
function gitCommitPush(repoPath, branch, message) {
  if (gitHasChanges(repoPath)) {
    // execFileSync (no shell) — the commit message contains the user's task text,
    // so it must never be interpolated into a shell string. Passed as a single argv
    // element, `$(…)`, backticks, and quotes are inert.
    execFileSync('git', ['-C', repoPath, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repoPath, 'commit', '-m', message], { stdio: 'pipe' });
    log('[GIT:COMMIT]', repoPath, message);
  }

  let ahead = 1; // if we can't determine, attempt the push anyway
  try {
    ahead = parseInt(git(repoPath, `rev-list --count origin/${branch}..HEAD`).trim(), 10) || 0;
  } catch (e) {
    // origin/<branch> ref not present locally — fall through and try to push
  }
  if (ahead > 0) {
    execSync(`git -C ${repoPath} push origin ${branch}`, { stdio: 'pipe' });
    log('[GIT:PUSH]', repoPath, `${ahead} commit(s)`);
    return true;
  }
  log('[GIT:SKIP]', repoPath, 'nothing to push');
  return false;
}

// ── Claude runner ─────────────────────────────────────────────────────────────
function parseClaudeJson(stdout) {
  const trimmed = (stdout || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // tolerate stray non-JSON noise before/after the object
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try { return JSON.parse(trimmed.slice(first, last + 1)); } catch (_) {}
    }
    return null;
  }
}

// Spawn claude, register the proc in `running` so reaper/stop can kill it.
// Resolves { result, sessionId, isError, subtype, exitCode, stderr, launchError }.
function runClaude({ repoPath, prompt, resumeId, threadTs }) {
  return new Promise((resolve) => {
    // -p/--print is a boolean flag; the prompt is fed via stdin (the documented pipe
    // pattern). This avoids commander parsing a prompt that starts with "--" as an
    // option, and sidesteps argv length limits on large thread-history prompts.
    const args = ['--dangerously-skip-permissions', '--output-format', 'json'];
    if (resumeId) args.push('--resume', resumeId);
    args.push('-p');

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: repoPath,
      env: { ...process.env, PATH: `/home/youruser/.local/bin:${process.env.PATH}`, HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const entry = running.get(threadTs);
    if (entry) entry.proc = proc;

    proc.stdin.on('error', () => {}); // ignore EPIPE if claude exits early
    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', (err) => {
      resolve({ result: '', sessionId: null, isError: true, subtype: 'spawn_error', exitCode: -1, stderr: String(err), launchError: err });
    });

    proc.on('close', (code) => {
      const json = parseClaudeJson(stdout);
      if (!json) {
        resolve({
          result: stderr.trim() || stdout.trim() || '(no output)',
          sessionId: null,
          isError: true,
          subtype: 'unparseable',
          exitCode: code,
          stderr,
        });
        return;
      }
      resolve({
        result: json.result ?? '',
        sessionId: json.session_id ?? null,
        isError: Boolean(json.is_error) || code !== 0,
        subtype: json.subtype ?? null,
        exitCode: code,
        stderr,
      });
    });
  });
}

// ── Thread context building ─────────────────────────────────────────────────────
async function fetchThread(client, channel, threadTs) {
  const messages = [];
  let cursor;
  do {
    const res = await client.conversations.replies({
      channel, ts: threadTs, limit: 200, cursor, include_all_metadata: true,
    });
    messages.push(...(res.messages || []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return messages;
}

// Full readable transcript — used for a FRESH run (no SessionID found).
async function buildFullContext(client, messages) {
  const ids = messages.filter(m => !isSteve(m)).map(m => m.user);
  await resolveNames(client, ids);
  const lines = ['--- Thread history ---'];
  for (const m of messages) {
    const raw = (m.text || '').trim();
    if (!raw) continue;
    if (isSteve(m)) {
      const body = stripSessionLine(raw);
      if (body) lines.push(`[Steve]: ${body}`);
    } else {
      const name = userNameCache.get(m.user) || m.user || 'user';
      lines.push(`[Human] ${name}: ${stripMention(raw)}`);
    }
  }
  lines.push('--- End of thread history ---');
  return lines.join('\n');
}

// Only the human messages added since the last SessionID marker — used on RESUME.
async function newMessagesSinceSession(client, messages) {
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (sessionIdOf(messages[i])) { idx = i; break; }
  }
  const after = messages.slice(idx + 1).filter(m => !isSteve(m));
  const ids = after.map(m => m.user);
  await resolveNames(client, ids);
  const lines = [];
  for (const m of after) {
    const raw = stripMention((m.text || '').trim());
    if (!raw) continue;
    const name = userNameCache.get(m.user) || m.user || 'user';
    lines.push(`[Human] ${name}: ${raw}`);
  }
  return lines.join('\n');
}

// ── Commands ────────────────────────────────────────────────────────────────────
async function cmdStatus(client, channel, threadTs) {
  const entries = [...running.entries()];
  if (entries.length === 0) {
    await postMsg(client, channel, threadTs, '📭 No sessions currently running.');
    return;
  }
  const lines = entries.map(([ts, s]) => {
    const age = Math.round((Date.now() - s.startedAt) / 60000);
    return `• thread \`${ts}\` — channel \`${s.channelId}\` — ${age}m — pid ${s.proc?.pid ?? '—'}`;
  });
  await postMsg(client, channel, threadTs, `📊 Running sessions:\n${lines.join('\n')}`);
}

async function cmdStop(client, channel, threadTs) {
  const session = running.get(threadTs);
  if (!session) {
    await postMsg(client, channel, threadTs, '⚠️ No running session in this thread.');
    return;
  }
  try { if (session.proc) process.kill(session.proc.pid, 'SIGTERM'); } catch (e) {}
  await withRepoLock(session.repoPath, async () => {
    try {
      gitCommitPush(session.repoPath, REPO_BRANCH, commitMsg(session.task, true));
    } catch (e) {
      log('[ERROR]', 'stop commit', e.message);
    }
  });
  running.delete(threadTs);
  await postMsg(client, channel, threadTs, '🛑 Session stopped. Any changes were committed.');
}

async function cmdHelp(client, channel, threadTs) {
  const text = [
    '*Steve* — tag `@Steve` to drive Claude Code in this channel\'s repo.',
    '',
    '• `@Steve <task>` — start a task (in a channel) or continue (in a thread)',
    '• `@Steve status` — list currently running sessions',
    '• `@Steve stop` — stop this thread\'s session (commits any changes)',
    '• `@Steve help` — this message',
    '',
    'Reply in a thread with `@Steve …` to resume that exact session. Plain replies without `@Steve` are ignored. Changes are committed straight to `' + REPO_BRANCH + '` only when files actually change.',
  ].join('\n');
  await postMsg(client, channel, threadTs, text);
}

// ── Core orchestration ──────────────────────────────────────────────────────────
async function handleMention({ client, channel, threadTs, isThread, rawText, userId, files }) {
  if (!isAllowed(userId)) {
    await postMsg(client, channel, threadTs, '🚫 Not authorised.');
    return;
  }

  const repoPath = CHANNEL_REPO_MAP[channel];
  if (!repoPath) {
    await postMsg(client, channel, threadTs, '⚠️ This channel is not configured in CHANNEL_REPO_MAP.');
    return;
  }

  const text = stripMention(rawText);
  const hasImages = (files || []).some(f => (f.mimetype || '').startsWith('image/'));
  const cmd = text.toLowerCase().split(/\s+/)[0];
  if (cmd === 'status') return cmdStatus(client, channel, threadTs);
  if (cmd === 'stop')   return cmdStop(client, channel, threadTs);
  // An image with no text is a valid task ("look at this"), so don't fall to help.
  if (cmd === 'help' || (text === '' && !hasImages)) return cmdHelp(client, channel, threadTs);

  // Reject if a process is already running in this thread.
  if (running.has(threadTs)) {
    const s = running.get(threadTs);
    const age = Math.round((Date.now() - s.startedAt) / 60000);
    await postMsg(client, channel, threadTs,
      `⏳ Already working in this thread (pid ${s.proc?.pid ?? '—'}, running ${age}m). \`@Steve stop\` to cancel.`);
    return;
  }

  // Reserve the slot synchronously to close the race before any await.
  running.set(threadTs, { proc: null, startedAt: Date.now(), channelId: channel, repoPath, task: text });
  await postMsg(client, channel, threadTs, '▶️ On it...');

  let imageTmpDir = null; // deleted in finally — images never outlive the run
  try {
    await withRepoLock(repoPath, async () => {
      // Sync the repo first.
      try {
        gitFetch(repoPath);
        pullIfAhead(repoPath, REPO_BRANCH);
      } catch (e) {
        log('[ERROR]', 'git sync', e.message);
        await postMsg(client, channel, threadTs,
          `❌ Repo could not be synced on \`${REPO_BRANCH}\`: \`${e.message.split('\n')[0]}\`. Resolve manually and retry.`);
        return;
      }

      // Decide resume vs fresh from thread history.
      let resumeId = null;
      let prompt;
      if (isThread) {
        const messages = await fetchThread(client, channel, threadTs);
        resumeId = extractSessionId(messages);
        if (resumeId) {
          const since = await newMessagesSinceSession(client, messages);
          prompt = since || text;
          log('[RESUME]', threadTs, resumeId);
        } else {
          const ctx = await buildFullContext(client, messages);
          prompt = `${ctx}\n\nLatest: ${text}`;
          log('[START]', threadTs, channel, repoPath, '(no session id; full context)');
        }
      } else {
        prompt = text;
        log('[START]', threadTs, channel, repoPath, JSON.stringify(text.slice(0, 80)));
      }

      // Pull down any attached images to an ephemeral temp dir (deleted in finally)
      // and point Claude at the paths.
      if (hasImages) {
        const { dir, paths } = await downloadImages(files);
        imageTmpDir = dir;
        if (paths.length) {
          const list = paths.map(p => `- ${p}`).join('\n');
          prompt = `Attached image file(s) saved temporarily — read them with the Read tool:\n${list}\n\n${prompt}`;
        }
      }

      const res = await runClaude({ repoPath, prompt, resumeId, threadTs });

      if (res.launchError) {
        await postMsg(client, channel, threadTs, `❌ Could not launch claude: \`${res.stderr}\``);
        log('[ERROR]', 'spawn', res.stderr);
        return;
      }

      // Commit any changes — even on error, labelled — so partial work isn't lost.
      try {
        gitCommitPush(repoPath, REPO_BRANCH, commitMsg(running.get(threadTs)?.task || text, res.isError));
      } catch (e) {
        log('[ERROR]', 'commit/push', e.message);
        await postMsg(client, channel, threadTs, `⚠️ Work done but commit/push failed: \`${e.message.split('\n')[0]}\``);
      }

      const body = res.isError
        ? `⚠️ Session ended with an error${res.subtype ? ` (${res.subtype})` : ''}.\n\n${res.result || res.stderr || '(no output)'}`
        : res.result;
      await postResult(client, channel, threadTs, body, res.sessionId);
      log('[DONE]', threadTs, `exit ${res.exitCode}`);
    });
  } catch (e) {
    log('[ERROR]', 'handleMention', e.message);
    try { await postMsg(client, channel, threadTs, `❌ Unexpected error: \`${e.message}\``); } catch (_) {}
  } finally {
    cleanupImages(imageTmpDir);
    running.delete(threadTs);
  }
}

// ── TTL reaper ──────────────────────────────────────────────────────────────────
setInterval(async () => {
  const now = Date.now();
  for (const [threadTs, session] of [...running.entries()]) {
    if (now - session.startedAt <= SESSION_TTL_MS) continue;
    const age = Math.round((now - session.startedAt) / 60000);
    log('[REAP]', threadTs, `${age}m`);
    try { if (session.proc) process.kill(session.proc.pid, 'SIGTERM'); } catch (e) {}
    await withRepoLock(session.repoPath, async () => {
      try { gitCommitPush(session.repoPath, REPO_BRANCH, commitMsg(session.task, true)); }
      catch (e) { log('[ERROR]', 'reap commit', e.message); }
    });
    running.delete(threadTs);
    try {
      await postMsg(slackApp.client, session.channelId, threadTs,
        `⏱️ Session auto-closed after ${TTL_HOURS}h. Tag @Steve in this thread to continue.`);
    } catch (e) {
      log('[ERROR]', 'reap notify', e.message);
    }
  }
}, 10 * 60 * 1000);

// ── Event wiring (mentions only) ──────────────────────────────────────────────
slackApp.event('app_mention', async ({ event, client }) => {
  try {
    const threadTs = event.thread_ts || event.ts;
    const isThread = Boolean(event.thread_ts);
    await handleMention({
      client,
      channel: event.channel,
      threadTs,
      isThread,
      rawText: event.text || '',
      userId: event.user,
      files: event.files || [],
    });
  } catch (e) {
    log('[ERROR]', 'app_mention', e.message);
  }
});

// ── Start ───────────────────────────────────────────────────────────────────────
(async () => {
  await slackApp.start();
  try {
    const auth = await slackApp.client.auth.test();
    BOT_USER_ID = auth.user_id;
  } catch (e) {
    log('[ERROR]', 'auth.test', e.message);
  }
  console.log('⚡ Steve bridge running (Socket Mode)');
  console.log(`   Bot:      ${BOT_USER_ID || 'unknown'}`);
  console.log(`   Channels: ${Object.keys(CHANNEL_REPO_MAP).length ? Object.entries(CHANNEL_REPO_MAP).map(([c, r]) => `${c}→${r}`).join(', ') : '(none configured!)'}`);
  console.log(`   Branch:   ${REPO_BRANCH}`);
  console.log(`   TTL:      ${TTL_HOURS}h`);
  console.log(`   Allowed:  ${ALLOWED_USERS.join(', ') || 'everyone'}`);
})();
