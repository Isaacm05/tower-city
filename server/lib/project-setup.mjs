import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Provisions a project with the same "keep shared context up to date" nudge this very repo's
 * own maintainer already runs personally — as a *user-level* Claude Code hook, which only ever
 * helps the one machine it's configured on. Writing the equivalent as a **project-level** hook
 * (committed to the repo, in `.claude/settings.json` + `.claude/hooks/`) means every teammate who
 * clones the repo gets the same reminder, regardless of what they've set up personally.
 *
 * Idempotent and additive only: never overwrites an existing `.agent-context.md`, and merges
 * into an existing `.claude/settings.json` rather than replacing it, so running this on a
 * project that already has its own hooks/settings doesn't clobber them.
 */

/**
 * A loose standard, not a rigid schema — three headings a session can always find the same
 * place, however little or much ends up under each. `Lessons & Notes` stays one flat list
 * (tagged `[decision]`/`[gotcha]`/`[todo]`/etc. inline) rather than a heading per tag: a fixed
 * set of tag headings fights whatever categories actually show up over a project's life, and a
 * flat, taggable list is still just as greppable.
 */
const CONTEXT_SCAFFOLD = (name) => `# ${name} — shared context

## Overview

## Lessons & Notes

## Open Questions
`

const HOOK_SCRIPT = `#!/usr/bin/env node
/**
 * Project-level Stop hook: reminds a session to keep .agent-context.md up to date before it
 * ends. Committed to the repo (via bot-crossing-hive's project setup) so every teammate gets
 * this nudge, not just whoever happened to configure it personally.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const REMIND_EVERY_MS = 30 * 60 * 1000
const MARKER_DIR = path.join('.claude', 'hooks', '.stop-markers')

let input = ''
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', () => {
  let data
  try {
    data = JSON.parse(input)
  } catch {
    process.exit(0)
  }
  const sessionId = data.session_id
  const cwd = data.cwd
  if (!sessionId || !cwd) process.exit(0)

  let root
  try {
    root = execSync('git rev-parse --show-toplevel', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    process.exit(0)
  }

  const marker = path.join(root, MARKER_DIR, sessionId)
  try {
    const age = Date.now() - fs.statSync(marker).mtimeMs
    if (age < REMIND_EVERY_MS) process.exit(0)
  } catch {
    /* no marker yet — first reminder this session */
  }
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(marker, '')
  } catch {
    process.exit(0)
  }

  const file = path.join(root, '.agent-context.md')
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, \`# \${path.basename(root)} — working notes\\n\`)
    } catch {
      process.exit(0)
    }
  }

  process.stderr.write(
    "Before this turn ends: this repo tracks shared context in \`.agent-context.md\`. If anything " +
    "from this session is worth a future session knowing, update it now — edit in place, keep it " +
    "tight, don't append a log. Nothing to add? Just say so and finish.\\n"
  )
  process.exit(2)
})
`

/** Merges one Stop-hook command into an existing settings.json without disturbing anything
 * else already configured there — additive, never a wholesale overwrite. */
function mergeHookIntoSettings(existing) {
  const settings = existing && typeof existing === 'object' ? existing : {}
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  const stop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : []
  const command = 'node .claude/hooks/context-reminder.mjs'
  const already = stop.some((entry) => (entry.hooks || []).some((h) => h.command === command))
  if (!already) {
    stop.push({ hooks: [{ type: 'command', command }] })
  }
  settings.hooks.Stop = stop
  return settings
}

/**
 * Antigravity does not read `.claude/settings.json` or `.agent-context.md` at all — confirmed
 * against its own shipped docs (`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/
 * docs/{hooks,rules}.md`), not guessed. It has its own, differently-shaped equivalents:
 *   - Skills already work with no changes needed here — `.agents/skills/<name>/SKILL.md` is
 *     Antigravity's *own* documented convention, and it's the exact same folder
 *     `sync-skills.mjs` already bridges Claude Code's skills into for Codex's sake. Nothing to
 *     provision.
 *   - Context: Antigravity discovers `AGENTS.md`/`GEMINI.md`, walking up from the cwd to the
 *     repo root — not `.agent-context.md`. `AGENTS.md` here is a short pointer, not a copy of
 *     the real file: a true file *symlink* would need elevated permissions on Windows (unlike
 *     the directory junction `sync-skills.mjs` uses, which doesn't), and a plain copy would drift
 *     out of sync with the real file, or silently truncate against Antigravity's own 24 KB
 *     per-rule-file cap on repos whose `.agent-context.md` has grown past that. A pointer has
 *     none of those problems and costs nothing to keep current.
 *   - Hooks: `.agents/hooks.json`, a JSON object of named hooks (not `.claude/settings.json`'s
 *     shape), each hook an event → handler-array map. `Stop` handlers get JSON on stdin
 *     (`conversationId`, `workspacePaths`, `terminationReason`, `fullyIdle`, …) and must answer
 *     JSON on stdout — `{"decision":"continue","reason":"…"}` blocks the stop and injects
 *     `reason` as a system message, the same shape of "one more turn, nudged" as Claude Code's
 *     own exit-code-2 Stop hook, just a different transport.
 */
const AGENTS_MD = (name) => `# ${name}

This repo's shared notes, lessons, and open questions live in \`.agent-context.md\` at the repo
root — read it before starting work here, and keep it updated the same way it asks.
`

const AGY_HOOK_SCRIPT = `#!/usr/bin/env node
/**
 * Project-level Antigravity Stop hook — the same "keep .agent-context.md current" nudge as
 * .claude/hooks/context-reminder.mjs, adapted to Antigravity's own JSON-on-stdin/stdout hook
 * contract (see .agents/hooks.json and its docs) rather than Claude Code's exit-code-2 one.
 */
import fs from 'node:fs'
import path from 'node:path'

const REMIND_EVERY_MS = 30 * 60 * 1000
const MARKER_DIR = path.join('.agents', '.stop-markers')

let input = ''
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', () => {
  let data
  try {
    data = JSON.parse(input)
  } catch {
    process.stdout.write('{}')
    return
  }
  const id = data.conversationId
  const root = (Array.isArray(data.workspacePaths) && data.workspacePaths[0]) || process.cwd()
  if (!id) {
    process.stdout.write('{}')
    return
  }

  const marker = path.join(root, MARKER_DIR, id)
  try {
    const age = Date.now() - fs.statSync(marker).mtimeMs
    if (age < REMIND_EVERY_MS) {
      process.stdout.write('{}')
      return
    }
  } catch {
    /* no marker yet — first reminder this conversation */
  }
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(marker, '')
  } catch {
    process.stdout.write('{}')
    return
  }

  const file = path.join(root, '.agent-context.md')
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, \`# \${path.basename(root)} — shared context\\n\\n## Overview\\n\\n## Lessons & Notes\\n\\n## Open Questions\\n\`)
    } catch {
      process.stdout.write('{}')
      return
    }
  }

  process.stdout.write(JSON.stringify({
    decision: 'continue',
    reason:
      "Before this turn ends: this repo tracks shared context in .agent-context.md. If anything " +
      "from this session is worth a future session knowing, update it now — edit in place, keep it " +
      "tight, don't append a log. Nothing to add? Just say so and finish.",
  }))
})
`

/** Same additive-merge shape as mergeHookIntoSettings, for Antigravity's differently-shaped
 * hooks.json — a flat array of handler objects under "Stop", not settings.json's nested
 * {hooks:[...]} groups. */
function mergeHookIntoAgyHooks(existing) {
  const hooks = existing && typeof existing === 'object' ? existing : {}
  const entry = hooks['context-reminder'] && typeof hooks['context-reminder'] === 'object' ? hooks['context-reminder'] : {}
  const stop = Array.isArray(entry.Stop) ? entry.Stop : []
  const command = 'node hooks/context-reminder.mjs'
  if (!stop.some((h) => h.command === command)) {
    stop.push({ type: 'command', command })
  }
  entry.Stop = stop
  hooks['context-reminder'] = entry
  return hooks
}

/**
 * @returns {{ createdContext: boolean, createdHook: boolean, updatedSettings: boolean,
 *   createdAgentsMd: boolean, createdAgyHook: boolean, updatedAgyHooks: boolean }}
 */
export async function ensureProjectSetup(projectPath) {
  const result = {
    createdContext: false,
    createdHook: false,
    updatedSettings: false,
    createdAgentsMd: false,
    createdAgyHook: false,
    updatedAgyHooks: false,
  }
  if (!projectPath) throw new Error('No project folder to set up')

  const contextFile = path.join(projectPath, '.agent-context.md')
  try {
    await fsp.access(contextFile)
  } catch {
    await fsp.writeFile(contextFile, CONTEXT_SCAFFOLD(path.basename(projectPath)), 'utf8')
    result.createdContext = true
  }

  const hooksDir = path.join(projectPath, '.claude', 'hooks')
  const hookFile = path.join(hooksDir, 'context-reminder.mjs')
  try {
    await fsp.access(hookFile)
  } catch {
    await fsp.mkdir(hooksDir, { recursive: true })
    await fsp.writeFile(hookFile, HOOK_SCRIPT, 'utf8')
    result.createdHook = true
  }

  const settingsFile = path.join(projectPath, '.claude', 'settings.json')
  let existing = null
  try {
    existing = JSON.parse(await fsp.readFile(settingsFile, 'utf8'))
  } catch {
    /* no settings.json yet, or unreadable — start fresh */
  }
  const merged = mergeHookIntoSettings(existing)
  const before = existing ? JSON.stringify(existing) : null
  const after = JSON.stringify(merged)
  if (before !== after) {
    await fsp.mkdir(path.dirname(settingsFile), { recursive: true })
    await fsp.writeFile(settingsFile, JSON.stringify(merged, null, 2) + '\n', 'utf8')
    result.updatedSettings = true
  }

  // Antigravity's own equivalents — see the block comment above mergeHookIntoAgyHooks for why
  // these are shaped so differently from the .claude/ versions above. Skills need no equivalent
  // provisioning: .agents/skills/ is already Antigravity's own documented convention.
  const agentsMdFile = path.join(projectPath, 'AGENTS.md')
  try {
    await fsp.access(agentsMdFile)
  } catch {
    await fsp.writeFile(agentsMdFile, AGENTS_MD(path.basename(projectPath)), 'utf8')
    result.createdAgentsMd = true
  }

  const agyHooksDir = path.join(projectPath, '.agents', 'hooks')
  const agyHookFile = path.join(agyHooksDir, 'context-reminder.mjs')
  try {
    await fsp.access(agyHookFile)
  } catch {
    await fsp.mkdir(agyHooksDir, { recursive: true })
    await fsp.writeFile(agyHookFile, AGY_HOOK_SCRIPT, 'utf8')
    result.createdAgyHook = true
  }

  const agyHooksFile = path.join(projectPath, '.agents', 'hooks.json')
  let existingAgyHooks = null
  try {
    existingAgyHooks = JSON.parse(await fsp.readFile(agyHooksFile, 'utf8'))
  } catch {
    /* no hooks.json yet, or unreadable — start fresh */
  }
  const mergedAgyHooks = mergeHookIntoAgyHooks(existingAgyHooks)
  const beforeAgy = existingAgyHooks ? JSON.stringify(existingAgyHooks) : null
  const afterAgy = JSON.stringify(mergedAgyHooks)
  if (beforeAgy !== afterAgy) {
    await fsp.mkdir(path.dirname(agyHooksFile), { recursive: true })
    await fsp.writeFile(agyHooksFile, JSON.stringify(mergedAgyHooks, null, 2) + '\n', 'utf8')
    result.updatedAgyHooks = true
  }

  return result
}
