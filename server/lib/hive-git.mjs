import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

/**
 * Shared "hive" storage backed by files inside the project's own repo — replaces an earlier
 * Supabase-backed design entirely. No external service, no account setup for the team: every
 * machine writes only its *own* file (`.hive/agents/<device-id>.json`), so there is nothing to
 * merge-conflict on — a normal `git pull` brings in everyone else's file untouched, and a normal
 * `git push` is what actually shares it.
 *
 * Deliberately does **not** run git itself. `git add`/`commit`/`push` against a shared repo,
 * unattended, on a timer, is exactly the kind of hard-to-reverse, team-visible action that needs
 * a person doing it, not a background loop — the file this writes just shows up as a normal
 * untracked/modified file in `git status`, committed and pushed whenever its owner next pushes
 * anything else. `.agent-context.md`-style project context needs nothing built for it at all:
 * it's already a normal tracked file, already shared the same way every other file in the repo
 * is — the hive only had to add its own new file to that same, already-working transport.
 */

const HIVE_DIR = '.hive/agents'

let deviceIdCache = null
async function deviceId() {
  if (deviceIdCache) return deviceIdCache
  const file = path.join(os.homedir(), '.bot-crossing-hive', 'device-id')
  try {
    deviceIdCache = (await fsp.readFile(file, 'utf8')).trim()
    if (deviceIdCache) return deviceIdCache
  } catch {
    /* first run on this machine */
  }
  deviceIdCache = crypto.randomUUID()
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, deviceIdCache, 'utf8')
  return deviceIdCache
}

/** A thread is done contributing once it has a transcript and nothing is still writing to it. */
function isComplete(thread) {
  return Boolean(thread.hasTranscript) && !thread.hasLiveProcess
}

/**
 * Writes this machine's own completed threads for one project to its own file. Never touches
 * any other machine's file, never runs git — just an ordinary file write into the working tree,
 * same as any editor would make.
 */
export async function writeLocalAgents(projectPath, threads) {
  if (!projectPath) return
  const id = await deviceId()
  const dir = path.join(projectPath, HIVE_DIR)
  const file = path.join(dir, `${id}.json`)
  const rows = threads.filter(isComplete).map((t) => ({
    thread_id: t.id,
    harness: t.harness || '',
    lines_of_code: t.linesOfCode || 0,
    completed_at: new Date(t.lastActivityAt || Date.now()).toISOString(),
  }))
  try {
    // A nickname a person set for one of their own threads lives only in this same file — read
    // whatever's already there first, so a routine resync never clobbers a rename with a blank.
    const nicknames = {}
    try {
      const prev = JSON.parse(await fsp.readFile(file, 'utf8'))
      for (const row of prev.threads || []) if (row.nickname) nicknames[row.thread_id] = row.nickname
    } catch {
      /* first sync for this project, or the file is new/malformed — nothing to carry forward */
    }
    for (const row of rows) if (nicknames[row.thread_id]) row.nickname = nicknames[row.thread_id]

    await fsp.mkdir(dir, { recursive: true })
    const body = JSON.stringify({ device_id: id, updated_at: new Date().toISOString(), threads: rows }, null, 2)
    await fsp.writeFile(file, body, 'utf8')
  } catch (err) {
    console.warn(`bot-crossing-hive: could not write ${file} —`, err?.message || err)
  }
}

/**
 * Every completed thread the *whole team* has recorded for one project — every other machine's
 * own file in `.hive/agents/`, aggregated. This machine's own threads are not included; the
 * caller already has those from its own live scan and would otherwise see itself twice.
 */
export async function readTeamAgents(projectPath, project) {
  if (!projectPath) return []
  const id = await deviceId()
  const dir = path.join(projectPath, HIVE_DIR)
  let files
  try {
    files = await fsp.readdir(dir)
  } catch {
    return [] // no .hive/agents yet for this project — nobody has synced it, including this machine
  }

  const out = []
  for (const name of files) {
    if (!name.endsWith('.json') || name === `${id}.json`) continue
    try {
      const data = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'))
      for (const row of data.threads || []) {
        const at = Date.parse(row.completed_at) || 0
        out.push({
          id: row.thread_id,
          project,
          projectPath: '',
          worktree: '',
          harness: row.harness || '',
          harnessName: row.harness || '',
          title: row.nickname || 'Untitled thread',
          preview: '',
          createdAt: at,
          lastActivityAt: at,
          recordActivityAt: at,
          lastFocusedAt: 0,
          hasLiveProcess: false,
          running: false,
          unread: false,
          hasError: false,
          starred: false,
          routine: '',
          prState: '',
          archived: false,
          hasTranscript: true,
          sizeBytes: 0,
          linesOfCode: row.lines_of_code || 0,
          transcriptFile: '',
          // A teammate's machine, not this one — nothing here to open/resume/reveal.
          canOpen: false,
          source: 'hive',
          remote: true,
        })
      }
    } catch {
      /* a teammate's file mid-write over a slow sync, or malformed — skip it, not the rest */
    }
  }
  return out
}

/**
 * A friendly name for one of *this machine's own* threads — the only file this machine can
 * write. Renaming a teammate's thread isn't possible by design: their file is theirs.
 */
export async function setNickname(projectPath, threadId, nickname) {
  const id = await deviceId()
  const file = path.join(projectPath, HIVE_DIR, `${id}.json`)
  let data
  try {
    data = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    throw new Error('This thread has not synced to the hive yet — try again in a moment')
  }
  const row = (data.threads || []).find((r) => r.thread_id === threadId)
  if (!row) throw new Error("That thread isn't in this project's hive file")
  const trimmed = (nickname || '').trim()
  if (trimmed) row.nickname = trimmed
  else delete row.nickname
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
}

/**
 * Every immediate subdirectory of the workspace that already has a `.hive/agents/` folder —
 * found purely by that folder's presence, with no local thread and no explicit "+ Add project"
 * required. This is what makes a project's shared skyline visible on a machine that has never
 * run a real agent session against it: without this, `readTeamAgents` only ever gets called for
 * a project this machine's own scan already knows about (see `projectPathsOf` below), which
 * means a fresh clone that hasn't done anything locally yet can never even ask the question,
 * let alone see a teammate's synced data answer it. One level deep only, and every per-folder
 * check wrapped so one unreadable/permission-denied folder costs that folder, not the whole scan.
 */
export async function discoverHiveProjects(workspaceRoot) {
  if (!workspaceRoot) return []
  let entries
  try {
    entries = await fsp.readdir(workspaceRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = path.join(workspaceRoot, entry.name)
    const hasHive = await fsp
      .access(path.join(dir, HIVE_DIR))
      .then(() => true, () => false)
    if (hasHive) found.push({ name: entry.name, path: dir })
  }
  return found
}

/** Every project path with at least one local completed thread, so the sync loop knows which
 * repos actually need a `.hive/agents/<device-id>.json` written. */
export function projectPathsOf(threads) {
  const paths = new Map()
  for (const t of threads) {
    if (t.remote || !t.projectPath) continue
    if (!paths.has(t.projectPath)) paths.set(t.projectPath, { project: t.project, threads: [] })
    paths.get(t.projectPath).threads.push(t)
  }
  return paths
}

/** Writes every local project's own hive file. Errors are per-project and non-fatal — one repo
 * with a permissions problem should not stop the rest from syncing. */
export async function syncLocalAgents(threads) {
  for (const [projectPath, { threads: projectThreads }] of projectPathsOf(threads)) {
    await writeLocalAgents(projectPath, projectThreads)
  }
}

/** Starts the slow write loop — this machine's own side of the sync, on a timer. Returns a stop
 * function. Reading everyone else's files happens per-request in `/api/threads` instead, since
 * it's cheap (local disk, not a network round trip) and always wants to be fresh. */
export function startHiveSync(scanThreads, intervalMs = Number(process.env.HIVE_SYNC_INTERVAL_MS) || 5 * 60 * 1000) {
  const tick = () => scanThreads().then(syncLocalAgents).catch((err) => {
    console.warn('bot-crossing-hive: hive write failed —', err?.message || err)
  })
  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
