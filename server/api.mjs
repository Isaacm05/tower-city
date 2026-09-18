import fsp from 'node:fs/promises'
import { projectStore } from './projects.mjs'
import { readContext, contextWriter } from './context.mjs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { openInTerminal, schemeHasHandler, schemeOf } from './lib/xdg.mjs'
import {
  openInTerminal as openInTerminalWin,
  schemeHasHandler as schemeHasHandlerWin,
  schemeOf as schemeOfWin,
} from './lib/win.mjs'
import { exists, findExecutable, jsonLines, listDirs, listFiles } from './lib/fsutil.mjs'
import {
  defaultHarness,
  harnessStatus,
  newSession as harnessNewSession,
  openThread as harnessOpenThread,
  scanThreads,
  disambiguateProjects,
} from './scan.mjs'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.BOT_CROSSING_DATA || path.join(here, '..', 'data')
const STATE_FILE = path.join(DATA_DIR, 'colony.json')
const projects = projectStore({ data: DATA_DIR })
const writeContext = contextWriter(process.env.BOT_CROSSING_WORKSPACE || path.resolve(here, '../..'))

const STATE_VERSION = 2

/**
 * v1 keyed everything on a bare session id, because Claude Code was the only harness and its
 * ids are UUIDs. Adapters now prefix (`claude-code:…`, `codex:…`) so two harnesses can never
 * name the same thread, which means a v1 file's archive list no longer matches anything.
 *
 * Only Claude Code ever wrote a bare id, so the rewrite is unambiguous. One shot, on read.
 */
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const migrateId = (id) => (BARE_UUID.test(id) ? `claude-code:${id}` : id)

function migrate(raw) {
  if (Number(raw.version) >= 2) return raw
  const keys = (o) => Object.fromEntries(Object.entries(asObject(o)).map(([k, v]) => [migrateId(k), v]))
  return {
    ...raw,
    archived: asArray(raw.archived).map(migrateId),
    archivedAt: keys(raw.archivedAt),
    opened: asArray(raw.opened).map(migrateId),
    seen: keys(raw.seen),
    viewedAt: keys(raw.viewedAt),
  }
}

/**
 * Colony state is only ever the things the *game* invents — which plot a project got,
 * what a thread's building looks like, what you archived, which repos you took off the map.
 * The threads themselves stay
 * read-only: this file is the only thing Bot Crossing writes, anywhere.
 */
const emptyState = () => ({
  version: STATE_VERSION,
  archived: [],
  archivedAt: {},
  opened: [],
  plots: {},
  seen: {},
  hiddenProjects: [],
  viewedAt: {},
  settings: null,
  updatedAt: 0,
})

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const asArray = (v) => (Array.isArray(v) ? v : [])

async function readState() {
  try {
    const raw = migrate(JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')))
    return {
      version: STATE_VERSION,
      archived: asArray(raw.archived),
      archivedAt: asObject(raw.archivedAt),
      opened: asArray(raw.opened),
      plots: asObject(raw.plots),
      seen: asObject(raw.seen),
      hiddenProjects: asArray(raw.hiddenProjects).map(String).filter(Boolean),
      viewedAt: asObject(raw.viewedAt),
      settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
      updatedAt: Number(raw.updatedAt) || 0,
    }
  } catch {
    return emptyState()
  }
}

/**
 * One writer: the browser owns this file and PUTs it whole. Nothing on the server writes it —
 * if anything did, the next save from a page holding older state would silently drop every
 * archive made since that page loaded.
 */
/**
 * Writes are serialised through one chain, and each gets its own temp file.
 *
 * Both halves matter and neither is theoretical. A shared `colony.json.tmp` means two saves
 * landing together race on the rename and one throws ENOENT — a 500 the page has no idea what
 * to do with, so the save is simply lost. And read-then-write is not atomic across an `await`,
 * so without the chain two callers can both pass the version check below before either writes.
 */
let writeQueue = Promise.resolve()
let tmpSeq = 0
const serialise = (fn) => (writeQueue = writeQueue.then(fn, fn))

async function writeState(next) {
  const state = {
    version: STATE_VERSION,
    archived: asArray(next.archived),
    archivedAt: asObject(next.archivedAt),
    opened: asArray(next.opened),
    plots: asObject(next.plots),
    seen: asObject(next.seen),
    hiddenProjects: asArray(next.hiddenProjects).map(String).filter(Boolean),
    viewedAt: asObject(next.viewedAt),
    settings: next.settings && typeof next.settings === 'object' ? next.settings : null,
    updatedAt: Date.now(),
  }
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const tmp = `${STATE_FILE}.${process.pid}.${++tmpSeq}.tmp`
  try {
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
    await fsp.rename(tmp, STATE_FILE)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  return state
}

/**
/**
 * Hand a `harness://…` deep link, or a folder, to whatever opens things on this OS. The
 * opener gets an argument list, never a shell string.
 *
 * Only `present()` calls this, and no harness knowledge ever reaches it: an adapter says what it
 * wants opened and this decides how, which is the seam that keeps `server/harnesses/` swappable.
 *
 * macOS's `open(1)` does both jobs, and `xdg-open` is the Linux equivalent. On Windows the
 * equivalent is ShellExecute, reached through `rundll32 url.dll,FileProtocolHandler`: a
 * registered protocol URL goes to its app and a folder opens in Explorer, with the argument
 * passed through untouched. Two more obvious routes were tried and rejected — `explorer.exe
 * <url>` silently drops any URL that carries a query string, so `code/new?folder=…` never
 * arrived, and `cmd /c start` parses its own argument line, where the `%3A%5C` escapes in that
 * same link are exactly what it expands.
 *
 * The spawn is guarded because the opener may simply not be installed — a headless Linux box
 * has no `xdg-open` — and an unhandled `error` event on a child process takes the whole server
 * down. Failing quietly is right here: there is nothing the page could do with the error, and
 * the scan path must never depend on whether presentation worked.
 */
const OPENERS = {
  darwin: ['open'],
  win32: ['rundll32', 'url.dll,FileProtocolHandler'],
  linux: ['xdg-open'],
}

function launch(target) {
  const opener = OPENERS[process.platform]
  if (!opener) return
  const [cmd, ...args] = opener
  const child = spawn(cmd, [...args, target], { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}

/**
 * A folder is openable only if it is still on this machine and still a directory. Paths
 * arrive from the page, which got them from a scan that may be minutes old — a repo that
 * has since been moved or deleted must fail here rather than hand the opener a dead path.
 * Absolute is judged by `path.isAbsolute` rather than a leading `/`, which no Windows path has.
 */
async function resolveFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null
  const dir = path.resolve(folder)
  const stat = await fsp.stat(dir).catch(() => null)
  return stat && stat.isDirectory() ? dir : null
}

/**
 * Enough of YAML frontmatter to read a SKILL.md's `name` and `description` — not a general
 * parser. Handles a plain `key: value` line and a folded (`>-`) or literal (`|-`) block scalar,
 * which is the one construct real SKILL.md files actually reach for — descriptions run long
 * enough that authors fold them. A skill whose frontmatter needs more than that is not one the
 * colony sidebar is trying to fully understand, just its name and a one-line blurb.
 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return {}
  const lines = match[1].split(/\r?\n/)
  const out = {}
  let i = 0
  while (i < lines.length) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!kv) {
      i++
      continue
    }
    const [, key, rest] = kv
    if (rest === '>-' || rest === '|-' || rest === '>' || rest === '|') {
      const folded = rest.startsWith('>')
      const parts = []
      i++
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
        parts.push(lines[i].replace(/^ {2}/, ''))
        i++
      }
      out[key] = folded ? parts.join(' ').replace(/\s+/g, ' ').trim() : parts.join('\n').trim()
    } else {
      out[key] = rest.trim().replace(/^["']|["']$/g, '')
      i++
    }
  }
  return out
}

/**
 * Skill directories that actually look like a skill: a directory with `SKILL.md` at its root.
 * `dir` (the skill's own absolute folder) and `scope` ride along internally — `scanSkills` needs
 * `dir` so a delete can target the exact folder a name resolved to (a `SKILL.md`'s own declared
 * `name` can differ from its folder name), and `scope` so the client knows whether removing it
 * only affects this project or every one of them.
 */
async function scanSkillDir(dir, scope) {
  const out = []
  for (const sub of await listDirs(dir)) {
    const file = path.join(sub, 'SKILL.md')
    if (!(await exists(file))) continue
    try {
      const meta = parseFrontmatter(await fsp.readFile(file, 'utf8'))
      out.push({ name: meta.name || path.basename(sub), description: meta.description || '', dir: sub, scope })
    } catch {
      /* unreadable or malformed — one bad skill costs itself, not the rest of the list */
    }
  }
  return out
}

/**
 * Every skill visible to a project: its own `.claude/skills` and `.agents/skills` (if it has
 * them), plus the two user-level directories that apply everywhere — deduplicated by name, first
 * writer wins, which favours a project's own skill over a same-named user-level one.
 */
async function scanSkills(projectPath) {
  const dirs = [
    { dir: path.join(os.homedir(), '.claude', 'skills'), scope: 'user' },
    { dir: path.join(os.homedir(), '.agents', 'skills'), scope: 'user' },
  ]
  if (projectPath) {
    dirs.unshift(
      { dir: path.join(projectPath, '.claude', 'skills'), scope: 'project' },
      { dir: path.join(projectPath, '.agents', 'skills'), scope: 'project' }
    )
  }
  const lists = await Promise.all(dirs.map((d) => scanSkillDir(d.dir, d.scope)))
  const byName = new Map()
  for (const list of lists) {
    for (const skill of list) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill)
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The pair of skill directories a given scope actually means, resolving a project path once. */
async function skillRoots(scope, projectPath) {
  if (scope === 'project') {
    const dir = await resolveFolder(projectPath)
    if (!dir) throw Object.assign(new Error('That project folder is not on this machine any more.'), { status: 404 })
    return [path.join(dir, '.claude', 'skills'), path.join(dir, '.agents', 'skills')]
  }
  return [path.join(os.homedir(), '.claude', 'skills'), path.join(os.homedir(), '.agents', 'skills')]
}

/**
 * Every skill sitting in one scope's trash — same shape and matching logic as `scanSkills`, just
 * pointed at each root's `.trash` subfolder. `scanSkillDir`'s own one-level-deep walk means a
 * trashed skill's `SKILL.md` is never picked up by the *normal* scan (it lives one directory
 * deeper, under `.trash/<name>/`), so trashing something can't make it reappear as if nothing
 * happened — it only shows up here, until restored.
 */
async function scanTrashedSkills(projectPath) {
  const dirs = [
    { dir: path.join(os.homedir(), '.claude', 'skills', '.trash'), scope: 'user' },
    { dir: path.join(os.homedir(), '.agents', 'skills', '.trash'), scope: 'user' },
  ]
  if (projectPath) {
    dirs.unshift(
      { dir: path.join(projectPath, '.claude', 'skills', '.trash'), scope: 'project' },
      { dir: path.join(projectPath, '.agents', 'skills', '.trash'), scope: 'project' }
    )
  }
  const lists = await Promise.all(dirs.map((d) => scanSkillDir(d.dir, d.scope)))
  const byName = new Map()
  for (const list of lists) {
    for (const skill of list) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill)
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Removes an installed skill — by moving its folder into a `.trash` subfolder of wherever it
 * actually lived, not deleting it outright. A marketplace-installed skill can always be put back
 * by installing it again, but plenty of real skills (anything dropped straight into
 * `~/.claude/skills/` by hand, with no marketplace behind it at all) have no such path back —
 * caught live when the user pointed out exactly that about a skill named "eli5". Re-derives the
 * exact directory from a fresh scan rather than trusting any path the client might send, same
 * reasoning `installRegistrySkill` uses for install, more important here since this still moves
 * real files: only ever acts on a folder `scanSkillDir` itself just found and parsed as a real
 * skill under one of the exact expected roots.
 */
async function uninstallSkill({ name, scope, projectPath }) {
  if (!name) throw Object.assign(new Error('No skill name given.'), { status: 400 })
  const roots = await skillRoots(scope, projectPath)

  for (const root of roots) {
    const found = (await scanSkillDir(root, scope)).find((s) => s.name === name)
    if (found) {
      const trashed = path.join(root, '.trash', path.basename(found.dir))
      await fsp.mkdir(path.dirname(trashed), { recursive: true })
      // A second delete of the same name overwrites its own last trashed copy rather than
      // erroring — one recoverable generation back is the useful case, not a full history.
      await fsp.rm(trashed, { recursive: true, force: true })
      await fsp.rename(found.dir, trashed)
      return { removed: name }
    }
  }
  throw Object.assign(new Error(`"${name}" isn't installed there.`), { status: 404 })
}

/** The other direction of `uninstallSkill` — moves a trashed skill's folder back into place. */
async function restoreSkill({ name, scope, projectPath }) {
  if (!name) throw Object.assign(new Error('No skill name given.'), { status: 400 })
  const roots = await skillRoots(scope, projectPath)

  for (const root of roots) {
    const found = (await scanSkillDir(path.join(root, '.trash'), scope)).find((s) => s.name === name)
    if (found) {
      const target = path.join(root, path.basename(found.dir))
      if (await exists(target)) {
        throw Object.assign(
          new Error(`"${name}" is already installed there — remove it first if you want to swap.`),
          { status: 409 }
        )
      }
      await fsp.rename(found.dir, target)
      return { restored: name }
    }
  }
  throw Object.assign(new Error(`"${name}" isn't in the trash there.`), { status: 404 })
}

/**
 * `~/.claude/projects/<encoded-cwd>/` — the inverse of `decodeProjectDir` in
 * `server/harnesses/claude-code.mjs`. Kept local rather than shared: this is the one place
 * outside that adapter that ever needs to go the other direction, and it is a small enough
 * mapping that a second copy is cheaper than a new export just for this.
 */
function encodeClaudeProjectDir(absPath) {
  const drive = /^([A-Za-z]):\\?(.*)$/.exec(absPath)
  if (drive) return `${drive[1]}--${drive[2].replace(/[\\/]/g, '-')}`
  return `-${absPath.replace(/^\//, '').replace(/\//g, '-')}`
}

/**
 * How many times each skill has actually fired in one transcript — a `tool_use` content block
 * named `Skill`, `input.skill` giving which one. Confirmed against real local transcripts before
 * writing this; Codex has no equivalent yet, since no local Codex transcript has ever actually
 * invoked one to confirm the wire format against (see `.agent-context.md`).
 *
 * Cached against the file's own mtime, the same reasoning as `transcriptMeta` in
 * `claude-code.mjs` — a transcript only grows, and counting from scratch on every poll for a
 * long-running thread would mean re-parsing megabytes of history every fifteen seconds.
 */
const skillUsageCache = new Map()
async function transcriptSkillCounts(file) {
  let stat
  try {
    stat = await fsp.stat(file)
  } catch {
    return null
  }
  const cached = skillUsageCache.get(file)
  if (cached && cached.mtime === stat.mtimeMs) return cached.counts

  const counts = new Map()
  try {
    for (const record of jsonLines(await fsp.readFile(file, 'utf8'))) {
      if (record.type !== 'assistant' || !Array.isArray(record.message?.content)) continue
      for (const block of record.message.content) {
        if (block?.type === 'tool_use' && block.name === 'Skill' && typeof block.input?.skill === 'string') {
          counts.set(block.input.skill, (counts.get(block.input.skill) || 0) + 1)
        }
      }
    }
  } catch {
    /* mid-write, or gone between the stat above and now — best effort */
  }
  skillUsageCache.set(file, { mtime: stat.mtimeMs, counts })
  return counts
}

/** Every skill invocation across this project's own Claude Code CLI transcripts, tallied. */
async function scanSkillUsage(projectPath) {
  if (!projectPath) return {}
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(projectPath))
  const total = new Map()
  for (const file of await listFiles(dir, (n) => n.endsWith('.jsonl'))) {
    const counts = await transcriptSkillCounts(file)
    if (!counts) continue
    for (const [name, n] of counts) total.set(name, (total.get(name) || 0) + n)
  }
  return Object.fromEntries(total)
}

/**
 * Every skill offered by a marketplace Claude Code already knows about — the same
 * `.claude-plugin/marketplace.json` format its own plugin system reads (confirmed against a
 * real `"$schema": "https://anthropic.com/claude-code/marketplace.schema.json"` on one of them),
 * already cloned locally the moment a marketplace becomes known: `extraKnownMarketplaces` in
 * `~/.claude/settings.json` plus the built-in `claude-plugins-official`, each under
 * `~/.claude/plugins/marketplaces/<name>/`. This *is* the skills registry — no need to invent or
 * depend on a separate one.
 *
 * Not every plugin in a marketplace ships a skill at all — MCP-server-only or hooks-only
 * plugins simply have no `skills` field, and skip cleanly; a plugin that claims a skill whose
 * `SKILL.md` isn't actually there costs only that one entry, not the whole marketplace.
 */
async function listRegistrySkills() {
  const marketplacesRoot = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces')
  const out = []
  for (const dir of await listDirs(marketplacesRoot)) {
    const marketplace = path.basename(dir)
    let manifest
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(dir, '.claude-plugin', 'marketplace.json'), 'utf8'))
    } catch {
      continue
    }
    for (const plugin of manifest.plugins || []) {
      // A plugin's `source` is a local relative path in a community marketplace like the ones
      // in `extraKnownMarketplaces` — but the official marketplace mixes in plugins sourced from
      // an entirely separate repo (`{"source": "git-subdir", "url": "..."}`), which nothing here
      // has fetched and has no local skill directory to read yet. Skipped, not crashed on.
      if (typeof plugin.source !== 'string') continue

      // A plugin's own marketplace.json entry is only ever *asked* to list its skills in
      // `skills[]` — the schema doesn't require it, and plenty of real plugins ship a skill
      // under the conventional `skills/<name>/SKILL.md` layout without ever declaring it there
      // (confirmed on a real marketplace: "impeccable" ships exactly one skill this way, and an
      // explicit-only scan silently missed it).
      //
      // The convention scan only fires when `skills[]` is empty, not as an always-on supplement:
      // a marketplace with several plugins sharing one `source` root (every callstack plugin
      // points at `./`) would otherwise have each plugin's scan list *everyone's* skills under
      // that shared folder, not just its own — a real bug caught live (callstack's 5 real skills
      // showed up as a mislabeled 25-entry cross-product before this guard).
      const declared = plugin.skills || []
      const skillDirs = declared.length
        ? new Set(declared.map((rel) => path.resolve(dir, plugin.source, rel)))
        : new Set(await listDirs(path.resolve(dir, plugin.source, 'skills')))

      for (const skillDir of skillDirs) {
        try {
          const meta = parseFrontmatter(await fsp.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'))
          out.push({
            marketplace,
            plugin: plugin.name,
            name: meta.name || path.basename(skillDir),
            description: meta.description || plugin.description || '',
            dir: skillDir,
          })
        } catch {
          /* a plugin claiming a skill that isn't actually there on disk — skip just this one */
        }
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Copies (never symlinks) a registry skill into a project's own `.claude/skills/<name>` — a
 * real, independent copy, since the marketplace's own local clone can be updated or removed by
 * Claude Code itself at any time, and an installed skill should not silently change or vanish
 * out from under a project because of that. `sync-skills.mjs`'s SessionStart hook picks up the
 * new directory and bridges it into `.agents/skills` on the next session, the same as any other
 * project-level skill — nothing extra to wire up here for Codex to see it too.
 *
 * `entry` is re-derived from a fresh scan rather than trusting the client's own copy of one —
 * the client only ever holds paths this same scan already produced, but a path arriving over
 * the network is never trusted on its say-so alone.
 */
async function installRegistrySkill({ marketplace, plugin, skillName, projectPath }) {
  const registry = await listRegistrySkills()
  const entry = registry.find((s) => s.marketplace === marketplace && s.plugin === plugin && s.name === skillName)
  if (!entry) throw Object.assign(new Error('That skill is no longer available.'), { status: 404 })

  const dir = await resolveFolder(projectPath)
  if (!dir) throw Object.assign(new Error('That project folder is not on this machine any more.'), { status: 404 })

  const target = path.join(dir, '.claude', 'skills', entry.name)
  if (await exists(target)) {
    throw Object.assign(new Error(`"${entry.name}" is already installed in this project.`), { status: 409 })
  }
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.cp(entry.dir, target, { recursive: true })
  return { installed: entry.name }
}

/**
 * Where the `claude` CLI is, so a marketplace nobody's configured here yet can be added the same
 * way `/plugin marketplace add` would from inside a session — shelling out to Claude Code's own
 * command rather than reimplementing its git-clone-plus-`extraKnownMarketplaces` bookkeeping.
 * Same PATH-then-fallback-dirs reasoning as every other `cliBinary` in this codebase; not reused
 * from `harnesses/claude-code.mjs` because that one isn't exported and is small enough to redo.
 */
const CLAUDE_CLI_NAMES = process.platform === 'win32' ? ['claude.cmd', 'claude.exe'] : ['claude']
const CLAUDE_CLI_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.claude', 'local'),
  '/usr/local/bin',
  '/usr/bin',
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm'),
]
let claudeBinary
async function claudeCli() {
  if (claudeBinary !== undefined) return claudeBinary
  for (const name of CLAUDE_CLI_NAMES) {
    const found = await findExecutable(name, CLAUDE_CLI_DIRS)
    if (found) return (claudeBinary = found)
  }
  return (claudeBinary = null)
}

/**
 * Adds a marketplace by name, URL, or path — a real, un-cloned one the user found and typed in,
 * not just the ones already sitting in `extraKnownMarketplaces`. Runs Claude Code's own
 * non-interactive command (`claude plugin marketplace add <source> --scope user`, confirmed via
 * `claude plugin marketplace add --help`) rather than hand-rolling the git clone and settings.json
 * bookkeeping it does — `--scope user` matches what `/plugin` itself defaults to, so this also
 * makes the marketplace available to real Claude Code sessions, not just this registry. Once it
 * lands under `~/.claude/plugins/marketplaces/`, `listRegistrySkills` already scans it on the very
 * next call — nothing else here needs to change for a new marketplace's skills to show up.
 *
 * `claude.cmd` is an npm shim (confirmed on this machine — no `claude.exe` exists), so it needs
 * the same `cmd.exe /c` wrapping `openEditor` uses for `code.cmd`; `execFile` hits the same
 * spawn-a-.cmd-directly restriction (Node's CVE-2024-27980 fix) that `spawn` does.
 */
async function addMarketplace(source) {
  const trimmed = String(source || '').trim()
  if (!trimmed) throw Object.assign(new Error('Give a marketplace name, URL, or path.'), { status: 400 })
  // No shell is involved (`execFile`), so this isn't a command-injection guard — it's keeping a
  // typo like "-x" from being read as a flag by the CLI's own argument parser instead of a source.
  if (trimmed.startsWith('-')) {
    throw Object.assign(new Error("That doesn't look like a marketplace name, URL, or path."), { status: 400 })
  }

  const bin = await claudeCli()
  if (!bin) throw Object.assign(new Error('No `claude` CLI found on this machine.'), { status: 500 })

  const argv = ['plugin', 'marketplace', 'add', trimmed, '--scope', 'user']
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', bin, ...argv]] : [bin, argv]
  try {
    await execFileAsync(cmd, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  } catch (err) {
    const text = String(err?.stderr || err?.stdout || err?.message || '')
    const last = text.trim().split('\n').filter(Boolean).pop()
    throw Object.assign(new Error(last || 'Could not add that marketplace.'), { status: 400 })
  }
  return { ok: true, skills: await listRegistrySkills() }
}

/**
 * Where VS Code's CLI is. Same reasoning as every `cliBinary` in `server/harnesses/` — PATH
 * first, since the installer's own "Add to PATH" option is what usually puts it there, then the
 * couple of places it lands when that option was off: a system-wide install under Program Files,
 * or a per-user one under the current user's own Programs folder.
 */
const EDITOR_NAMES = process.platform === 'win32' ? ['code.cmd', 'code.exe'] : ['code']
const EDITOR_DIRS =
  process.platform === 'win32'
    ? [
        path.join('C:', 'Program Files', 'Microsoft VS Code', 'bin'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin'),
      ]
    : ['/usr/local/bin', '/usr/bin']
let editorBinary
async function editorCli() {
  if (editorBinary !== undefined) return editorBinary
  for (const name of EDITOR_NAMES) {
    const found = await findExecutable(name, EDITOR_DIRS)
    if (found) return (editorBinary = found)
  }
  return (editorBinary = null)
}

/**
 * Open a folder in VS Code via its own CLI rather than the `vscode://file/` deep link — the
 * `claude://` handler on this very machine turned out to be a registered-but-broken URL scheme
 * (see the note on `schemeHasHandler` in `win.mjs`), and there is no reason to trust a second
 * one blind when the CLI, once resolved, is unambiguous.
 *
 * On Windows the binary is a `.cmd` file, and `child_process.spawn` refuses to run one directly
 * without `shell: true` since Node's fix for CVE-2024-27980 — wrapping it through `cmd.exe /c`
 * instead is the same trick `win.mjs`'s bare-console fallback already uses, and `windowsHide`
 * keeps that wrapper's own console from flashing on screen for the moment it takes to hand off
 * to VS Code's own process.
 */
async function openEditor(dir) {
  const bin = await editorCli()
  if (!bin) return { ok: false, error: 'No `code` CLI found on this machine' }
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', bin, dir]] : [bin, [dir]]
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true })
  child.on('error', () => {})
  child.unref()
  return { ok: true }
}

/**
 * `markitdown` (github.com/microsoft/markitdown) is a Python package, not an npm one, so this
 * shells out the same way `editorCli` does for VS Code — `python -m markitdown` rather than
 * resolving a separate `markitdown` console script, since pip's own Scripts directory isn't
 * reliably on PATH while `python` itself already has to be.
 */
const PYTHON_NAMES = process.platform === 'win32' ? ['python.exe', 'py.exe'] : ['python3', 'python']
let pythonBinary
async function pythonCli() {
  if (pythonBinary !== undefined) return pythonBinary
  for (const name of PYTHON_NAMES) {
    const found = await findExecutable(name)
    if (found) return (pythonBinary = found)
  }
  return (pythonBinary = null)
}

/**
 * Converts one uploaded file to markdown via `markitdown`, so it can be copied straight into a
 * Claude Code / Codex prompt. The file never touches the colony's own data — written to a temp
 * file only for the duration of the conversion, then removed regardless of outcome.
 */
async function convertToMarkdown(buffer, filename) {
  const python = await pythonCli()
  if (!python) return { ok: false, error: 'No Python interpreter found on this machine' }

  const tmp = path.join(
    os.tmpdir(),
    `bot-crossing-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(filename || '')}`
  )
  await fsp.writeFile(tmp, buffer)
  try {
    const { stdout } = await execFileAsync(python, ['-m', 'markitdown', tmp], {
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    })
    return { ok: true, markdown: stdout }
  } catch (err) {
    const stderr = String(err?.stderr || '')
    const missing = /No module named ['"]?markitdown/.test(stderr)
    return {
      ok: false,
      error: missing
        ? 'markitdown is not installed — run `pip install "markitdown[all]"` and try again'
        : stderr.trim().split('\n').filter(Boolean).pop() || err.message || 'Conversion failed',
    }
  } finally {
    await fsp.rm(tmp, { force: true })
  }
}

/**
 * Show a harness's answer to "open this" — `{ ok, url, command }` — and say truthfully whether
 * anything happened.
 *
 * macOS hands the URL to the opener exactly as before: a scheme the harness's app registers is
 * always answered there, so nothing is probed. Linux and Windows are the platforms where the URL
 * may have nowhere to go — the desktop app is optional and often absent on Linux, and simply
 * doesn't exist for some harnesses on Windows — and handing an unclaimed scheme to the shell
 * opener exits quietly or pops an unhelpful dialog, either of which used to reach the page as
 * "Opened". So on both, the scheme is checked first; failing that, the harness's own CLI runs in
 * a terminal, from the `command` the adapter offered alongside the URL; failing that, the page is
 * told so.
 *
 * `command.cwd` came from the page — inside `ref`, or as the folder itself — so it gets the same
 * check as any other folder the page names. There is no fallback directory on purpose:
 * `claude --resume` looks a session up under the folder it ran in, and a terminal that opens on
 * "No conversation found" and closes is worse than an error toast.
 */
async function present(result) {
  // Only the reason reaches the page: a failure may still carry the adapter's command.
  if (!result || !result.ok) return { ok: false, error: result?.error || 'Nothing to open' }

  if (process.platform === 'darwin') {
    if (!result.url) return { ok: false, error: 'That harness has no deep link to open on this platform' }
    launch(result.url)
    // A note is the adapter saying it opened *something* — the repo rather than the thread.
    return { ok: true, url: result.url, note: result.note }
  }

  const desktop =
    process.platform === 'win32'
      ? { hasHandler: schemeHasHandlerWin, openInTerminal: openInTerminalWin, schemeOf: schemeOfWin }
      : { hasHandler: schemeHasHandler, openInTerminal, schemeOf }

  if (result.url && (await desktop.hasHandler(result.url))) {
    launch(result.url)
    return { ok: true, url: result.url }
  }
  if (result.command) {
    if (!result.command.cwd) return { ok: false, error: 'That thread has no folder on record to resume in' }
    const cwd = await resolveFolder(result.command.cwd)
    if (!cwd) return { ok: false, error: 'The folder that thread ran in is not on this machine any more' }
    // A folder that exists but cannot be entered fails inside every terminal alike, and the
    // terminal gets the blame; say what is actually wrong instead.
    const enterable = await fsp.access(cwd, fsp.constants.X_OK).then(() => true, () => false)
    if (!enterable) return { ok: false, error: 'The folder that thread ran in cannot be entered' }
    return desktop.openInTerminal(result.command.argv, cwd, result.command.id)
  }
  const scheme = desktop.schemeOf(result.url)
  return {
    ok: false,
    error: scheme
      ? `Nothing on this machine opens ${scheme}:// links, and there is no CLI command to run instead`
      : 'Nothing on this machine can open that',
  }
}

/**
 * Mark the threads the colony has retired.
 *
 * Nothing is written anywhere. Bot Crossing used to set `isArchived` on the desktop app's own
 * session record, and it did land on disk — but the app serves from the copy it loaded at
 * launch, so the thread stayed put in its own list until the next restart, and the app would
 * rewrite the record from memory whenever it touched the thread. Papering over that took a
 * re-assert on every poll, a `ps` sweep to guess whether the app had re-read the file, and a
 * *pending* state for the gap between the two — a lot of machinery for something that still
 * looked broken to anyone with the app open.
 *
 * So the colony keeps its own list and that is all it does. Archiving in the harness's own UI
 * still sends the astronaut home, because the scan reads that flag; archiving here is the
 * colony's own business. Nothing outside `data/colony.json` is ever written.
 */
async function reconcileArchived(threads) {
  const state = await readState()
  if (!state.archived.length) return threads
  const wanted = new Set(state.archived)

  /**
   * An archive is remembered by the thread id the page saw, but that id is only the *canonical*
   * one. A thread the desktop app knows and the CLI has not written a transcript for is keyed on
   * its desktop record; the moment a transcript appears it re-keys to that session's UUID, and a
   * list keyed on the old string stops matching. The thread quietly comes back, which reads as
   * the archive having failed.
   *
   * So the ids inside `ref` count too. They are opaque to everything else here — this only ever
   * asks whether a string it already holds appears among them.
   */
  const archived = (thread) => {
    if (wanted.has(thread.id)) return true
    const ref = thread.ref
    if (!ref || typeof ref !== 'object') return false
    for (const value of Object.values(ref)) {
      if (typeof value === 'string') {
        if (value && wanted.has(value)) return true
      } else if (Array.isArray(value)) {
        for (const v of value) if (typeof v === 'string' && v && wanted.has(v)) return true
      }
    }
    return false
  }

  return threads.map((t) => (archived(t) ? { ...t, archived: true } : t))
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// The machine's own LAN addresses count as local too, so the colony can be
// served to the home network with BOT_CROSSING_HOST set. Harmless when bound
// to loopback (those hosts can't reach the server anyway), and the Host +
// Origin pairing still stops DNS rebinding and CSRF exactly as before.
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const a of addrs || []) {
    if (a && a.family === 'IPv4' && !a.internal && a.address) LOCAL_HOSTS.add(a.address)
  }
}

/** Hostname out of a `Host:` or `Origin:` value, with the port and any brackets stripped. */
function hostnameOf(value) {
  if (!value) return ''
  const raw = String(value).includes('://') ? value : `http://${value}`
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

/**
 * Only a page this server itself served may drive it. Two checks, against two different
 * attacks, both of which a localhost server with an `open`-the-desktop-app button is a
 * genuinely attractive target for:
 *
 *   - **Host** stops DNS rebinding. Binding to 127.0.0.1 is not on its own enough: an
 *     attacker who points `evil.com` at 127.0.0.1 reaches us *as a same-origin page*, and
 *     can then read every response. The rebound request still carries `Host: evil.com`.
 *   - **Origin** stops CSRF. A cross-site `fetch` with a `text/plain` body is not
 *     preflighted, so without this check any page you happened to be visiting could POST
 *     here — spawning sessions, opening Finder windows, or wiping the colony layout —
 *     even though it could never read the reply.
 *
 * A state-changing request with no `Origin` at all is refused: browsers always send one on
 * POST/PUT, so its absence means the caller is not the page. That does mean a bare `curl`
 * POST is rejected; pass `-H 'Origin: http://localhost:5274'` if you are scripting this.
 */
function isLocalRequest(req) {
  if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host))) return false

  const origin = req.headers.origin
  if (origin && origin !== 'null') return LOCAL_HOSTS.has(hostnameOf(origin))
  return req.method === 'GET' || req.method === 'HEAD'
}

function readJsonBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/** Connect-style middleware: handles /api/*, passes everything else through. */
export async function apiMiddleware(req, res, next) {
  const url = new URL(req.url, 'http://localhost')
  if (!url.pathname.startsWith('/api/')) return next ? next() : send(res, 404, { error: 'Not found' })

  if (!isLocalRequest(req)) {
    return send(res, 403, { error: 'Bot Crossing only answers its own page on this machine' })
  }

  try {
    if (url.pathname === '/api/projects' && req.method === 'GET') {
      return send(res, 200, { projects: await projects.list() })
    }
    if (url.pathname === '/api/project-folders' && req.method === 'GET') {
      try { return send(res, 200, await projects.options(url.searchParams.get('folder') || '')) }
      catch (err) { return send(res, 400, { error: err.message }) }
    }
    if (url.pathname === '/api/projects' && req.method === 'POST') {
      try { return send(res, 200, await projects.add(await readJsonBody(req))) }
      catch (err) { return send(res, 400, { error: err.message }) }
    }
    if (url.pathname === '/api/threads' && req.method === 'GET') {
      const threads = await reconcileArchived(await scanThreads())
      // A harness that is present but cannot read its own store says so here, rather than
      // appearing healthy in the list while quietly contributing nothing.
      const warnings = (await harnessStatus()).filter((h) => h.detected && h.error).map((h) => h.error)
      const saved = await projects.list()
      const combined = disambiguateProjects([
        ...threads.map(t => ({ ...t, project: t.projectPath ? path.basename(t.projectPath) : t.project })),
        ...saved.map(p => ({ project: p.name, projectPath: p.path })),
      ])
      return send(res, 200, {
        threads: combined.slice(0, threads.length),
        projects: saved.map((p, i) => ({ ...p, name: combined[threads.length + i].project })),
        scannedAt: Date.now(), warnings,
      })
    }

    if (url.pathname === '/api/harnesses' && req.method === 'GET') {
      return send(res, 200, { harnesses: await harnessStatus() })
    }

    if (url.pathname === '/api/skills' && req.method === 'GET') {
      // A project path that no longer resolves still gets user-level skills back — those
      // exist independently of any one project — rather than a 400 over something the page
      // could not have known was stale.
      const dir = await resolveFolder(url.searchParams.get('path'))
      const [skills, usage, trashed] = await Promise.all([scanSkills(dir), scanSkillUsage(dir), scanTrashedSkills(dir)])
      // `dir` (the skill's absolute folder) is internal — a delete re-derives it from a fresh
      // scan rather than trusting whatever the client sends back, so there's no reason to ship it
      // over the wire at all. `scope` does need to reach the client: it's what a delete confirms
      // against ("remove from just this project" vs "remove everywhere"), and what a restore
      // needs to know which pair of directories to look in.
      return send(res, 200, {
        skills: skills.map(({ dir: _dir, ...s }) => ({ ...s, uses: usage[s.name] || 0 })),
        trashed: trashed.map(({ dir: _dir, ...s }) => s),
      })
    }

    if (url.pathname === '/api/skills/registry' && req.method === 'GET') {
      return send(res, 200, { skills: await listRegistrySkills() })
    }

    if (url.pathname === '/api/skills/install' && req.method === 'POST') {
      try {
        return send(res, 200, await installRegistrySkill(await readJsonBody(req)))
      } catch (err) {
        return send(res, err.status || 500, { error: err.message || String(err) })
      }
    }

    if (url.pathname === '/api/skills/uninstall' && req.method === 'POST') {
      try {
        return send(res, 200, await uninstallSkill(await readJsonBody(req)))
      } catch (err) {
        return send(res, err.status || 500, { error: err.message || String(err) })
      }
    }

    if (url.pathname === '/api/skills/restore' && req.method === 'POST') {
      try {
        return send(res, 200, await restoreSkill(await readJsonBody(req)))
      } catch (err) {
        return send(res, err.status || 500, { error: err.message || String(err) })
      }
    }

    if (url.pathname === '/api/marketplaces/add' && req.method === 'POST') {
      try {
        const { source } = await readJsonBody(req)
        return send(res, 200, await addMarketplace(source))
      } catch (err) {
        return send(res, err.status || 500, { error: err.message || String(err) })
      }
    }

    if (url.pathname === '/api/context' && req.method === 'GET') {
      const dir = await resolveFolder(url.searchParams.get('path'))
      if (!dir) return send(res, 404, { error: 'That folder is not on this machine any more.' })
      return send(res, 200, await readContext(dir))
    }

    if (url.pathname === '/api/context' && req.method === 'PUT') {
      try {
        return send(res, 200, await writeContext(await readJsonBody(req, 200 * 1024)))
      } catch (err) {
        return send(res, err.status || 500, { error: err.message || String(err) })
      }
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, await readState())
    }

    /**
     * Optimistic concurrency, so a second tab cannot paste over the first one's work.
     *
     * `baseUpdatedAt` is the version the caller last agreed with. If the file no longer carries
     * it, the caller's whole-file body describes a colony that no longer exists — so the disk
     * state comes back with a 409 and the page merges against it. Merging here was the other
     * option and it is the wrong place: the server has no idea which of two `plots` layouts a
     * person actually dragged.
     *
     * The test is inequality rather than "older than", because a colony file also moves
     * *backwards* — restored from a backup, edited by hand — and a page open across that holds
     * a base newer than disk, which sails through a greater-than check and pastes the
     * pre-restore colony straight back.
     *
     * A missing or zero base is a first write and is allowed: nothing to lose on a fresh
     * install, and it keeps the endpoint drivable from `curl`.
     */
    if (url.pathname === '/api/state' && req.method === 'PUT') {
      const body = await readJsonBody(req)
      const base = Number(body.baseUpdatedAt) || 0
      return serialise(async () => {
        const current = await readState()
        if (base && current.updatedAt !== base) return send(res, 409, current)
        return send(res, 200, await writeState(body))
      })
    }

    if (url.pathname === '/api/open' && req.method === 'POST') {
      const { harness, ref } = await readJsonBody(req)
      const shown = await present(await harnessOpenThread(harness, ref))
      return send(res, shown.ok ? 200 : 400, shown)
    }

    // Base64 in a JSON body rather than multipart: the file never needs to be more than a few
    // MB, and it saves pulling in a multipart parser for one upload. 30MB of JSON covers roughly
    // 22MB of raw file after base64's ~33% overhead — comfortable for a PDF, image, or doc.
    if (url.pathname === '/api/convert-to-markdown' && req.method === 'POST') {
      const { filename, dataBase64 } = await readJsonBody(req, 30 * 1024 * 1024)
      if (typeof filename !== 'string' || !filename || typeof dataBase64 !== 'string') {
        return send(res, 400, { ok: false, error: 'No file in the request' })
      }
      const result = await convertToMarkdown(Buffer.from(dataBase64, 'base64'), filename)
      return send(res, result.ok ? 200 : 400, result)
    }

    if (
      (url.pathname === '/api/new-session' || url.pathname === '/api/reveal' || url.pathname === '/api/open-editor') &&
      req.method === 'POST'
    ) {
      const { folder, harness } = await readJsonBody(req)
      const dir = await resolveFolder(folder)
      if (!dir) return send(res, 400, { ok: false, error: 'That folder is not on this machine any more' })

      if (url.pathname === '/api/reveal') {
        launch(dir)
        return send(res, 200, { ok: true })
      }
      if (url.pathname === '/api/open-editor') {
        const result = await openEditor(dir)
        return send(res, result.ok ? 200 : 400, result)
      }
      const shown = await present(await harnessNewSession(harness || (await defaultHarness()), dir))
      return send(res, shown.ok ? 200 : 400, shown)
    }

    return send(res, 404, { error: 'Unknown endpoint' })
  } catch (err) {
    return send(res, 500, { error: String(err && err.message ? err.message : err) })
  }
}
