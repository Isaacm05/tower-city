/**
 * `.agent-context.md` — read and write, for the colony sidebar's own create/edit/save controls.
 * The one file both `agent-context.mjs` (SessionStart) and `context-reminder.mjs` (Stop) in
 * `~/.claude/hooks/` also read/nudge — see `.agent-context.md` itself for that story.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

/** Plenty for hand-written notes; a runaway write (or a bad paste) shouldn't grow this unbounded. */
export const CONTEXT_LIMIT = 128 * 1024

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

/**
 * `revision` is a content hash, not a version counter — cheap to compute, and it means two
 * writes that happen to produce identical bytes never conflict with each other even if a
 * counter would have moved between them.
 */
export async function readContext(dir) {
  const file = path.join(dir, '.agent-context.md')
  try {
    const stat = await fsp.lstat(file)
    if (stat.isSymbolicLink() || !stat.isFile()) throw fail('Project context must be a regular file.')
    const content = await fsp.readFile(file, 'utf8')
    if (Buffer.byteLength(content) > CONTEXT_LIMIT) throw fail('Project context exceeds the 128 KB limit.')
    return { exists: true, content, revision: createHash('sha256').update(content).digest('hex') }
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, content: '', revision: null }
    throw err
  }
}

/**
 * A writer bound to one workspace root, serialising its own writes — the same reasoning as
 * `colony.json`'s `serialise` above: read-then-write is not atomic across an `await`, so without
 * a queue two saves racing each other could both pass the revision check before either writes.
 */
export function contextWriter(workspaceRoot) {
  let queue = Promise.resolve()

  async function write({ folder, content, revision }) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw fail('Choose a project folder.')
    if (typeof content !== 'string' || Buffer.byteLength(content) > CONTEXT_LIMIT) {
      throw fail('Context must be text no larger than 128 KB.')
    }
    if (revision !== null && typeof revision !== 'string') throw fail('Reload the context before saving.')

    // Resolved against the real workspace root so a folder outside it — even reached via `..`
    // or a symlink — is refused rather than quietly written to.
    const root = await fsp.realpath(workspaceRoot).catch(() => workspaceRoot)
    let dir
    try {
      dir = await fsp.realpath(folder)
    } catch {
      throw fail('That folder is not on this machine any more.')
    }
    const relative = path.relative(root, dir)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw fail('Context editing is limited to projects inside the workspace.')
    }

    const current = await readContext(dir)
    if (current.revision !== revision) {
      throw fail('Context changed on disk. Reload it before saving; your draft has been kept.', 409)
    }

    const file = path.join(dir, '.agent-context.md')
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await fsp.writeFile(temp, content, 'utf8')
      // Re-checked right before the rename: the gap between the check above and here is small,
      // but not zero, and losing someone else's save to a race is exactly what the check exists
      // to prevent.
      if ((await readContext(dir)).revision !== revision) {
        throw fail('Context changed on disk. Reload it before saving; your draft has been kept.', 409)
      }
      await fsp.rename(temp, file)
    } finally {
      await fsp.rm(temp, { force: true }).catch(() => {})
    }
    return readContext(dir)
  }

  return (input) => (queue = queue.then(() => write(input), () => write(input)))
}
