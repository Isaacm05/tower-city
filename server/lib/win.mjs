/**
 * Windows desktop plumbing: does anything on this machine answer a URL scheme, and how do you
 * put a command in a new console window here.
 *
 * Mirrors what `xdg.mjs` does for Linux desktops. Only `server/api.mjs` uses this, and only on
 * win32 — an adapter never imports it, and nothing in here knows about a particular harness.
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * A locally-built `wsh` with `--target`/`--split` on `wsh run` — see `tools/README.md`. Falls
 * back to whatever plain `wsh.exe` PATH resolves to (the stock binary, no placement flags) so a
 * checkout without the patched copy still opens threads correctly, just without deliberate
 * placement — `wshRun` below treats the two flags as optional for exactly this reason.
 */
const PATCHED_WSH = path.join(here, '..', '..', 'tools', 'bin', 'wsh-patched.exe')
const WSH_BIN = existsSync(PATCHED_WSH) ? PATCHED_WSH : 'wsh.exe'

/** The scheme of a URL, or '' if it does not parse. */
export function schemeOf(url) {
  try {
    return new URL(url).protocol.replace(/:$/, '')
  } catch {
    return ''
  }
}

/**
 * Is a program registered to handle this URL's scheme?
 *
 * A custom protocol on Windows lives at `HKEY_CLASSES_ROOT\<scheme>`, marked with a
 * "URL Protocol" value — but that value alone is not proof anything answers it. An installer
 * that registered the scheme and was later removed (or crashed mid-install) can leave the marker
 * behind with no `shell\open\command` underneath, which is exactly the state this was written
 * against: `HKCR\claude` on a real machine carried "URL Protocol" and nothing else, so checking
 * only the marker reported a handler that could not actually launch anything. The command key is
 * the one thing `ShellExecute` itself needs, so that is what gets checked; anything that stops
 * the query — key missing, `reg` itself absent — counts as "no handler".
 */
export async function schemeHasHandler(url) {
  const scheme = schemeOf(url)
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) return false
  try {
    const { stdout } = await execFileAsync('reg', ['query', `HKCR\\${scheme}\\shell\\open\\command`], {
      timeout: 5000,
    })
    return /REG_SZ/.test(stdout)
  } catch {
    return false
  }
}

/**
 * Run `argv` in a console, `cwd` as its working directory — a tab in an existing Windows
 * Terminal window when one is installed, a brand new console window otherwise.
 *
 * `wt -w 0 new-tab` is the tab-not-window behaviour: `-w 0` targets "the most recently used
 * window", creating one only if none exists yet, so a colony full of clicks accumulates tabs in
 * one place instead of a taskbar full of separate console windows. `wt` itself is just a
 * dispatcher — it hands the request to whichever window answers and exits immediately, which is
 * why success here is "the dispatch didn't error", not "the tab is up"; there is nothing further
 * worth waiting on.
 *
 * Falls back to `cmd /c start` — a new console window every time — on a Windows install without
 * Windows Terminal, which is rare on 11 but not impossible on 10. The empty quoted title (`""`)
 * there is required: `start` reads its first quoted argument as a window title, and without one
 * a quoted path is misread as the title instead, which sends the rest of the command line
 * nowhere.
 *
 * The caller has already resolved both: `argv[0]` is an absolute executable and `cwd` an
 * existing directory.
 *
 * `wt.exe` is never resolved by hand the way `claude.cmd` is elsewhere in this codebase — it
 * ships as an MSIX "app execution alias", a reparse point the OS loader knows how to follow but
 * `fs.stat` does not, so a manual PATH walk (`findExecutable`) reports one as missing even when
 * it launches fine. Handing the bare name straight to `spawn` lets Windows resolve it itself,
 * exactly as typing `wt` at a prompt would; `ENOENT` on that attempt is what "not installed"
 * actually looks like here.
 */
/**
 * `unref` only after the promise has actually settled. Calling it right after `spawn` — before
 * `exit`/`error` has fired — tells the event loop this child is not a reason to keep running,
 * and a caller with nothing else pending (a bare script; possibly a request handler between
 * ticks) can let Node exit before the listener below ever runs, leaving this promise forever
 * unsettled rather than rejected. The resolved window/tab is already independent of this
 * process by then regardless, so unreffing on the way out costs nothing.
 */
function trySpawn(cmd, args, cwd) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { cwd, stdio: 'ignore', detached: true })
    } catch (err) {
      resolve({ ok: false, error: err?.code || err?.message || String(err) })
      return
    }
    const settle = (result) => {
      child.unref()
      resolve(result)
    }
    child.on('error', (err) => settle({ ok: false, error: err?.code || err?.message || String(err) }))
    child.on('exit', (code) =>
      settle(
        code === 0
          ? { ok: true }
          : { ok: false, error: `Could not open a terminal (${path.basename(cmd)} exited with code ${code})` }
      )
    )
  })
}

/**
 * The tag a block is found by later. Namespaced so nothing else Wave-side collides with it, and
 * scoped to the same id the colony already keys a thread on (`claude-code:<uuid>`,
 * `codex:<uuid>`) — the one identifier every caller already has to hand.
 */
const TAG_KEY = 'bot-crossing:thread'
const BLOCK_ID = /block:([0-9a-f-]{36})/i

/**
 * A single transient `wsh` failure (a slow tick, a busy daemon) used to read exactly like "no
 * block exists" here, which sent every dedupe check straight past a block that was still open —
 * and since `tryWave`'s own `wsh run` call was just as likely to hit the same blip, that reads as
 * "Wave Terminal is closed" and cascades all the way to opening an entirely separate terminal app
 * next to the one already sitting there. One retry after a short pause absorbs a blip without
 * hiding a real, sustained failure (wsh missing, Wave Terminal actually closed) — both fail fast
 * on a local socket rather than sitting out the full timeout twice.
 */
async function execWsh(args) {
  try {
    return await execFileAsync(WSH_BIN, args, { timeout: 5000 })
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 300))
    return execFileAsync(WSH_BIN, args, { timeout: 5000 })
  }
}

/**
 * The block already open for this thread, if `wsh blocks list` still knows about one — closing a
 * block (or Wave Terminal itself exiting) drops it from this list on its own, so "not listed"
 * always means "not open" with nothing here to clean up.
 */
async function findWaveBlock(tag) {
  if (!tag) return ''
  try {
    const { stdout } = await execWsh(['blocks', 'list', '--json', '--view=term'])
    const blocks = JSON.parse(stdout || '[]')
    return blocks.find((b) => b?.meta?.[TAG_KEY] === tag)?.blockid || ''
  } catch {
    return ''
  }
}

/**
 * Column tracking for deliberate placement — reset on every server restart, which matches
 * reality closely enough: Wave Terminal's own blocks don't survive a restart of *it* either, and
 * the far more common case (this server restarting while Wave Terminal keeps running) costs
 * nothing worse than the next block landing in a fresh column instead of continuing an existing
 * one, never a wrong or broken placement.
 *
 * Best-effort in the other direction too: nothing here watches for the user manually
 * rearranging blocks by hand, so the tracked shape can drift from the real one over a long
 * session. `nextPlacement` re-validates against `wsh blocks list` before trusting any of it, so
 * drift costs a sub-optimal placement, never a crash or a block aimed at a gone-away target.
 */
const MAX_STACK = 2
let columns = []

/** The colony's own web view block — https?://…:5274 — the anchor the first column splits off. */
async function findWebBlock() {
  try {
    const { stdout } = await execFileAsync(WSH_BIN, ['blocks', 'list', '--json', '--view=web'], { timeout: 5000 })
    const blocks = JSON.parse(stdout || '[]')
    return blocks.find((b) => /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(b?.meta?.url || ''))?.blockid || ''
  } catch {
    return ''
  }
}

/**
 * Where the next new terminal block should go: the colony's web view gets a column of its own,
 * new terminals fill columns to the right of it, two stacked per column before a new column
 * starts. Returns `null` for "let Wave Terminal decide" when there is nothing to anchor against
 * — no web block found, and no column tracked yet either.
 */
async function nextPlacement() {
  if (columns.length) {
    let live = new Set()
    try {
      const { stdout } = await execFileAsync(WSH_BIN, ['blocks', 'list', '--json', '--view=term'], {
        timeout: 5000,
      })
      live = new Set(JSON.parse(stdout || '[]').map((b) => b.blockid))
    } catch {
      columns = [] // can't tell what's still open — start clean rather than aim at stale ids
    }
    if (live.size) {
      for (const col of columns) col.blocks = col.blocks.filter((id) => live.has(id))
      columns = columns.filter((col) => col.blocks.length > 0)
    }
  }

  const last = columns.at(-1)
  if (last && last.blocks.length < MAX_STACK) {
    return { targetBlockId: last.blocks.at(-1), targetAction: 'down', column: last }
  }

  /**
   * A new column always anchors on the web block, never on a previous column's own blocks.
   * Wave Terminal's split algorithm (`frontend/layout/lib/layoutTree.ts`) only inserts a
   * sibling in place when the target's *parent* is already a row; once a column has two
   * blocks stacked, both are children of a column-group node instead, which isn't itself
   * addressable — splitting relative to either one nests *inside* that group rather than
   * beside it. The web block's parent never changes, since nothing ever splits the web block
   * itself, so it is the one anchor guaranteed to still be a direct child of the root row.
   * The trade-off: each new column lands immediately next to the web block, pushing earlier
   * columns further right, rather than appending past them.
   */
  const anchor = await findWebBlock()
  if (!anchor) return null
  const column = { blocks: [] }
  columns.push(column)
  return { targetBlockId: anchor, targetAction: 'right', column }
}

/**
 * Wave Terminal, when it is the terminal actually installed here, gets first refusal via its own
 * `wsh` CLI hook.
 *
 * A `tag` is checked against `wsh blocks list` first: a thread already sitting in a block gets
 * focused (`wsh focusblock`) rather than resumed a second time into a duplicate window — running
 * `claude --resume` or `codex resume` twice against the same session from two blocks is not
 * merely untidy, it is two processes racing to write the same transcript. `execFile` rather than
 * the fire-and-forget `trySpawn` below because this path actually needs `wsh run`'s stdout — it
 * prints the new block's id (`run block created: block:<uuid>`), which is what gets tagged for
 * next time — and `wsh run` itself returns as soon as the block exists, not when the command
 * inside it finishes, so buffering the output costs nothing worth avoiding it for.
 *
 * Unlike the `wt.exe` → `cmd.exe` step below, *any* failure here falls through rather than only
 * `ENOENT`: `wsh` on PATH with no running Wave Terminal to answer it is the ordinary case on a
 * machine that has it installed but closed, not a problem worth surfacing when there is always
 * another working way to open the thread.
 */
async function tryWave(argv, cwd, tag) {
  const existing = await findWaveBlock(tag)
  if (existing) {
    try {
      // `-b` needs a full ORef (`block:<uuid>`), not the bare id `blocks list` hands back —
      // a bare id only resolves via a `WAVETERM_BLOCKID`-relative RPC lookup wsh does client
      // side, which nothing here ever has reason to set. The prefixed form parses directly,
      // with no dependency on any extra env var at all.
      await execWsh(['focusblock', '-b', `block:${existing}`])
      return { ok: true }
    } catch {
      // Tagged against a block that closed between the list above and now — fall through to
      // opening a fresh one rather than failing on a reference that just went stale.
    }
  }

  // Only the patched binary understands these; on the stock one they are simply never added,
  // which is exactly the graceful-degradation `WSH_BIN` is picked for.
  const placement = WSH_BIN !== 'wsh.exe' ? await nextPlacement() : null
  const placementArgs = placement ? ['--target', placement.targetBlockId, '--split', placement.targetAction] : []

  let stdout
  try {
    ;({ stdout } = await execWsh(['run', '--cwd', cwd, ...placementArgs, '--', ...argv]))
  } catch (err) {
    return { ok: false, error: err?.code || err?.message || String(err) }
  }
  const blockId = BLOCK_ID.exec(stdout)?.[1]
  if (blockId) {
    placement?.column.blocks.push(blockId)
    if (tag) {
      // Best-effort: failing to tag it only costs the *next* open its refocus, not this one.
      // Same full-ORef requirement as `focusblock` above.
      await execWsh(['setmeta', '-b', `block:${blockId}`, `${TAG_KEY}=${tag}`]).catch(() => {})
    }
  }
  return { ok: true }
}

/**
 * `tag` is a stable id for the thread being opened — `claude-code:<uuid>`, `codex:<uuid>` — used
 * only to dedupe against an existing Wave Terminal block; every other launcher here ignores it,
 * since neither `wt.exe` nor a bare console window has anything comparable to search.
 */
export async function openInTerminal(argv, cwd, tag) {
  const wellFormed = Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string' && a)
  if (!wellFormed || !path.isAbsolute(argv[0]) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return { ok: false, error: 'Invalid launch command' }
  }

  const viaWave = await tryWave(argv, cwd, tag)
  if (viaWave.ok) return viaWave

  const wtArgs = ['-w', '0', 'new-tab', '--title', path.basename(cwd), '-d', cwd, '--', ...argv]
  const viaWt = await trySpawn('wt.exe', wtArgs, cwd)
  if (viaWt.ok || viaWt.error !== 'ENOENT') return viaWt

  return trySpawn('cmd.exe', ['/c', 'start', '""', '/D', cwd, ...argv], cwd)
}
