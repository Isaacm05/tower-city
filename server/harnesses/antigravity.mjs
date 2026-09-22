/**
 * Harness adapter: Antigravity (Google) — the desktop IDE and the `agy` CLI together.
 *
 * Built against a real installation, not guessed at — see `.agent-context.md` for how the
 * format was found (a throwaway "how are you" in the GUI, then a real one against a project
 * folder from the CLI, comparing what each wrote under `~/.gemini/`).
 *
 * Two sibling stores, both under the user's home directory regardless of OS (Antigravity's own
 * `~/.gemini` convention, not an OS-specific AppData/Library path the way Claude Code's desktop
 * app needs): `~/.gemini/antigravity` (the desktop IDE) and `~/.gemini/antigravity-cli` (the
 * `agy` CLI). Each has its own `conversation_summaries.db`, but a conversation started in one
 * can show up in the other's summaries too — deduped here by `conversation_id`, last one read
 * wins, since both copies describe the same conversation.
 *
 * `workspace_uris` (a JSON array of `file://` URIs) is what actually maps a conversation to a
 * project — `project_id` is not: the CLI stamps every conversation with the same
 * `"default-cli-project"` sentinel regardless of which folder it ran in.
 *
 * Read-only, without exception — same ground rule every adapter here follows.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { findExecutable } from '../lib/fsutil.mjs'

const HOME = os.homedir()

/** Confirmed against a real `agy --help` on this machine, not guessed — same
 * PATH-then-known-install-dir resolution every other CLI-backed adapter here uses. */
const CLI_DIRS = [path.join(HOME, '.local', 'bin'), path.join(HOME, 'AppData', 'Local', 'agy', 'bin')]
const CLI_NAMES = process.platform === 'win32' ? ['agy.exe'] : ['agy']

async function cliBinary() {
  for (const name of CLI_NAMES) {
    const found = await findExecutable(name, CLI_DIRS)
    if (found) return found
  }
  return null
}

/** Both stores this adapter knows how to read — order doesn't matter, both get merged. */
const STORES = ['antigravity', 'antigravity-cli']
const storeDir = (store) => path.join(HOME, '.gemini', store)
const summariesDb = (store) => path.join(storeDir(store), 'conversation_summaries.db')

/**
 * `node:sqlite` needs a flag before Node 22.13 (`--experimental-sqlite`), not literally a newer
 * Node — confirmed directly against this module, contrary to what `codex.mjs`'s own comment
 * assumed. Imported lazily so its absence on an unflagged, older Node costs this one harness,
 * not the whole server (same reasoning as `codex.mjs`'s `sqliteApi`).
 */
let sqlitePromise
const sqliteApi = () => (sqlitePromise ??= import('node:sqlite').catch(() => null))

/**
 * "2026-09-22 20:16:45.5406696+00:00" → epoch ms. A space instead of `T` and up to 7 fractional
 * digits, both of which `Date.parse` is not guaranteed to handle consistently — normalized by
 * hand rather than trusted to parse as-is. The CLI's zero-value sentinel
 * ("0001-01-01 00:00:00+00:00") parses to a large *negative* number, not zero — caught here and
 * normalized to a real 0, since callers fall back on this being falsy (`parseAgyTime(a) ||
 * parseAgyTime(b)`) and a negative-but-truthy sentinel would silently defeat that fallback,
 * exactly as it did on the first pass before this was caught against the real output.
 */
function parseAgyTime(s) {
  if (!s) return 0
  const iso = s.replace(' ', 'T').replace(/(\.\d{3})\d*/, '$1')
  const t = Date.parse(iso)
  return Number.isFinite(t) && t > 0 ? t : 0
}

/** The first `file://` workspace URI, decoded to a real OS path — or '' for a conversation that
 * was never tied to a folder (the CLI's `project_id: "outside-of-project"` case). */
function workspacePath(workspaceUris) {
  try {
    const uris = JSON.parse(workspaceUris || '[]')
    if (!Array.isArray(uris) || !uris.length) return ''
    return fileURLToPath(uris[0])
  } catch {
    return ''
  }
}

async function detect() {
  for (const store of STORES) {
    if (await fsp.access(storeDir(store)).then(() => true, () => false)) return true
  }
  return false
}

/** Cheap, best-effort "how finished a building looks" — the transcript file's own size, same
 * spirit as every other adapter's `sizeBytes`. 0 rather than thrown if it's not there yet. */
async function transcriptSize(store, conversationId) {
  const file = path.join(
    storeDir(store),
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript_full.jsonl'
  )
  return fsp.stat(file).then((s) => s.size, () => 0)
}

async function storeRows(store) {
  const sqlite = await sqliteApi()
  if (!sqlite?.DatabaseSync) return []
  let db
  try {
    db = new sqlite.DatabaseSync(summariesDb(store), { readOnly: true })
  } catch {
    // Not there yet, or a WAL sidecar mid-write refusing a read-only open — the other store
    // (if any) still answers, same as codex.mjs's own database-open failure handling.
    return []
  }
  try {
    return db.prepare('SELECT * FROM conversation_summaries').all()
  } catch {
    return []
  } finally {
    db.close()
  }
}

async function scanThreads() {
  const byId = new Map()
  for (const store of STORES) {
    for (const row of await storeRows(store)) {
      byId.set(row.conversation_id, row)
    }
  }

  const threads = []
  for (const row of byId.values()) {
    const store = row.app_data_dir === 'antigravity-cli' ? 'antigravity-cli' : 'antigravity'
    const projectPath = workspacePath(row.workspace_uris)
    threads.push({
      id: `antigravity:${row.conversation_id}`,
      title: row.title || 'Untitled thread',
      preview: row.preview || '',
      project: projectPath ? path.basename(projectPath) : '',
      projectPath,
      worktree: '',
      cwd: projectPath,
      gitBranch: '',
      // Model/effort are only ever seen so far as prose inside a step's own content (a
      // <USER_SETTINGS_CHANGE> note the one time a session actually switched models), not as a
      // clean field anywhere queried here — left blank rather than scraped out of free text.
      model: '',
      effort: '',
      createdAt: parseAgyTime(row.last_user_input_time) || parseAgyTime(row.last_modified_time),
      lastActivityAt: parseAgyTime(row.last_modified_time),
      lastFocusedAt: 0,
      // Only two `status` values actually seen (`CASCADE_RUN_STATUS_IDLE`, and empty for an
      // older row) — nothing confirmed for "currently running", so this stays false rather than
      // guessing a status string that was never observed.
      running: false,
      unread: false,
      hasError: false,
      archived: false,
      sizeBytes: await transcriptSize(store, row.conversation_id),
      source: store === 'antigravity-cli' ? 'cli' : 'gui',
      canOpen: true,
      ref: { conversationId: row.conversation_id, store, projectPath },
    })
  }
  return threads
}

/**
 * `agy --conversation <id>` is a real, confirmed flag (`agy --help`, not guessed) for resuming a
 * specific conversation — used regardless of whether the thread's own `source` was `gui` or
 * `cli`: the conversation itself lives in the shared `~/.gemini` store either way, not inside
 * whichever process happened to create it, the same reasoning `claude-code.mjs` uses to fall
 * back to its own CLI for a desktop-created thread. No confirmed way to make the *desktop app*
 * itself jump to a specific conversation (no deep link, no CLI flag for it), so this is the one
 * real path either kind of thread gets.
 */
async function openThread(ref) {
  const { conversationId, projectPath } = ref || {}
  if (!conversationId) return { ok: false, error: 'No conversation id on that thread' }
  const bin = await cliBinary()
  if (!bin) return { ok: false, error: 'The agy CLI is not on PATH or in its known install location on this machine' }
  return {
    ok: true,
    url: '',
    command: {
      argv: [bin, '--conversation', conversationId],
      cwd: typeof projectPath === 'string' && projectPath ? projectPath : '',
      id: `antigravity:${conversationId}`,
    },
  }
}

/** Bare `agy` in the target directory — confirmed live: this is exactly how the very
 * project-tied conversation this adapter was built against was actually started. */
async function newSession(dir) {
  const bin = await cliBinary()
  if (!bin) return { ok: false, error: 'The agy CLI is not on PATH or in its known install location on this machine' }
  return { ok: true, url: '', command: { argv: [bin], cwd: dir } }
}

async function diagnostic() {
  if (!(await detect())) return ''
  if (!(await sqliteApi())?.DatabaseSync) {
    return `Antigravity threads need Node 22.13 or newer for node:sqlite (running ${process.versions.node})`
  }
  return ''
}

export default {
  id: 'antigravity',
  name: 'Antigravity',
  detect,
  diagnostic,
  scanThreads,
  openThread,
  newSession,
}
