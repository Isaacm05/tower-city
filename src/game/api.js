import { mergeState } from './merge-state.js'

async function req(url, options) {
  const res = await fetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
  return body
}

const post = (url, payload) =>
  req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

export const fetchThreads = () => req('/api/threads')
export const fetchProjectFolders = (folder = '') => req(`/api/project-folders?folder=${encodeURIComponent(folder)}`)
export const addProject = (input) => post('/api/projects', input)

/** Who is installed on this machine, and what they can do — see `harnessStatus` in scan.mjs. */
export const fetchHarnesses = () => req('/api/harnesses')

/**
 * The colony file, and the base every later save is measured against.
 *
 * `baseUpdatedAt` is the file version this tab last agreed with; `baseSnapshot` is the state as
 * it looked at that moment. The snapshot is the half that matters: without it a conflicted save
 * can only union the two lists, and a union can never express "I un-archived this".
 */
let baseUpdatedAt = 0
let baseSnapshot = null

function adoptBase(state, updatedAt) {
  baseUpdatedAt = Number(updatedAt ?? state?.updatedAt) || 0
  // Cloned, because the page mutates the object it holds. Sharing the reference would let
  // `local` and `base` drift into being the same thing, which reads as "this tab changed
  // nothing" and quietly turns every save back into last-writer-wins.
  baseSnapshot = structuredClone(state)
}

export const fetchState = async () => {
  const state = await req('/api/state')
  adoptBase(state)
  return state
}

/** Enough attempts to get through a burst of saves from another tab, and no more. */
const SAVE_TRIES = 3

/**
 * Save the colony, merging rather than clobbering if another tab got there first.
 *
 * The server answers 409 with what is on disk when this tab's base is stale. That is not a
 * failure to report at the user — it is the normal shape of two tabs being open — so it is
 * merged and re-sent here. The base for the next attempt is the disk state just merged against,
 * which keeps a retry from re-applying edits it has already folded in.
 *
 * Returns the state the caller should hold from now on: the *same object* when nothing
 * conflicted, so the common path never swaps the page's state out from under a click that
 * happened mid-flight, and only a real merge hands back something new.
 */
export async function saveState(state) {
  let local = state
  for (let attempt = 0; attempt < SAVE_TRIES; attempt++) {
    const res = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...local, baseUpdatedAt }),
    })
    const body = await res.json().catch(() => ({}))

    if (res.status === 409) {
      local = mergeState(baseSnapshot, local, body)
      adoptBase(body)
      continue
    }
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
    adoptBase(local, body.updatedAt)
    return local
  }
  // Losing three times running means the other tab is saving faster than we can merge. The
  // caller swallows this: nothing local is lost, and the next save tries again.
  throw new Error('Could not save the colony — another tab kept writing first')
}

/**
 * Hand a thread back to whichever harness owns it — the desktop app comes forward on its own.
 *
 * `ref` is opaque here on purpose: it is whatever that harness's adapter needs to find the
 * thread again, and the browser only ever passes it straight back. Nothing in the UI knows
 * what a Claude Code session id, or a Codex rollout id, actually looks like.
 */
export const openThread = (thread, transport) => post('/api/open', { harness: thread.harness, ref: thread.ref, transport })

/**
 * A brand new thread in a repo, via that harness's own new-session deep link.
 *
 * `transport` overrides how the server opens it: `'gui'` forces the desktop app (fails rather
 * than falling back to a terminal), `'waveterm'`/`'cli'` force a terminal — Wave Terminal only,
 * or skipping Wave even when it's running — instead of letting the server pick automatically.
 * Omit it for the original automatic behaviour.
 */
export const newSession = (folder, harness, transport) => post('/api/new-session', { folder, harness, transport })

export const revealFolder = (folder) => post('/api/reveal', { folder })

export const openInEditor = (folder) => post('/api/open-editor', { folder })

/** Skills visible to a project — its own + every user-level one. */
export const fetchSkills = (folder) => req('/api/skills?path=' + encodeURIComponent(folder || ''))

/**
 * A project's `.agent-context.md`, or `{ exists: false }` if it has none — including when the
 * folder itself is gone, which the server answers with 404. That specific case reads the same
 * as "nothing to show", not a failure worth retrying; anything else (network trouble, a real
 * server error) still throws, so the caller's own retry-on-failure logic still applies to those.
 */
export const fetchContext = async (folder) => {
  const res = await fetch('/api/context?path=' + encodeURIComponent(folder || ''))
  if (res.status === 404) return { exists: false, content: '', revision: null }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
  return body
}

/**
 * `revision` is the hash `fetchContext` last returned — `null` for a brand new file. The server
 * answers 409 (surfaced here as a thrown error, same as any other failure) when it no longer
 * matches what's on disk, so a save can never silently clobber a change made since the page last
 * read the file.
 */
export const saveContext = (folder, content, revision) =>
  req('/api/context', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, content, revision }),
  })

/**
 * Every skill any marketplace Claude Code already knows about offers — same registry Claude
 * Code's own `/plugin` command reads, just flattened down to the skills inside it.
 */
export const fetchSkillRegistry = () => req('/api/skills/registry')

/** Copies one registry skill into a project's own `.claude/skills/<name>`. */
export const installSkill = (marketplace, plugin, skillName, projectPath) =>
  post('/api/skills/install', { marketplace, plugin, skillName, projectPath })

/**
 * Removes an installed skill — moved into a `.trash` folder server-side, not deleted outright, so
 * `restoreSkill` can always put it back even when (unlike a marketplace install) there's no other
 * source to reinstall it from. `scope` ('project' or 'user', from `fetchSkills`'s own response)
 * decides which pair of directories the server looks in.
 */
export const deleteSkill = (name, scope, projectPath) =>
  post('/api/skills/uninstall', { name, scope, projectPath })

/** The other direction — moves a trashed skill's folder back into place. */
export const restoreSkill = (name, scope, projectPath) =>
  post('/api/skills/restore', { name, scope, projectPath })

/**
 * Adds a marketplace nobody's configured here yet — a name, URL, or path the user found and
 * typed in, run through Claude Code's own `claude plugin marketplace add` rather than anything
 * bot-crossing invents itself. Answers with the registry's fresh skill list, same shape as
 * `fetchSkillRegistry`, so the caller doesn't need a second round trip to see the new skills.
 */
export const addMarketplace = (source) => post('/api/marketplaces/add', { source })

/** A PDF/doc/image, converted to markdown via `markitdown` on the server. */
export const convertToMarkdown = (filename, dataBase64) => post('/api/convert-to-markdown', { filename, dataBase64 })

/** Provisions `.agent-context.md` and a project-level Stop hook reminding a session to keep it
 * updated — committed to the repo like any other file, so every teammate who clones it gets the
 * same nudge. Idempotent: safe to call on a project that already has either. */
export const setupProjectHive = (folder) => post('/api/hive/setup', { folder })
