import * as THREE from 'three'
import '../ui/styles.css'
import { DEFAULT_PRESET, Settings, hasStoredSettings } from '../core/settings.js'
import { Engine } from '../core/engine.js'
import { CameraRig } from '../core/camera.js'
import { STATUS_LABEL, STATUS_ORDER, statusFor, transcriptProgress } from '../game/colony.js'
import { Hud } from '../ui/hud.js'
import { showAddProject } from '../ui/add-project.js'
import { PLANETS } from '../world/planet.js'
import { loadKit } from '../world/kit.js'
import { crewRig, loadCrew } from '../agents/crew.js'
import { TIMES } from '../world/sky.js'
import { CURVE_FULL, bendPoint, installWorldCurve, setCurveView } from '../core/curve.js'
import {
  fetchThreads,
  fetchState,
  fetchHarnesses,
  saveState,
  openThread,
  newSession,
  revealFolder,
  openInEditor,
  fetchSkills,
  fetchContext,
  saveContext,
  fetchSkillRegistry,
  installSkill,
  deleteSkill,
  restoreSkill,
  addMarketplace,
  convertToMarkdown,
  setupProjectHive,
} from '../game/api.js'
import { TowerColony, tunedPlanet } from './tower-colony.js'

/**
 * Tower City — the app. Same sidebar, skills manager, settings, project chrome and astronaut
 * crew as the original bot-crossing's own boot script (`src/main.js`, since removed from this
 * repo — see Bot Crossing itself for the multi-project map this was ported from), ported here
 * rather than added to that file, since this view's purpose is different: one project's
 * skyline, grown by lines of code, not a map of every project's threads at once.
 *
 * Deliberately dropped from this first pass, versus the original: ambient sound, hammering
 * particle sparks, and per-project ground-layout persistence (a single deck always regrows
 * from its own project's total lines of code, so there is nothing about *where* it sits worth
 * saving — see `TowerColony.layoutForSave`). "Hide project" doesn't have an equivalent here
 * either — with one project on screen at a time, switching to another *is* hiding this one.
 */

const POLL_MS = 15000
const app = document.getElementById('app')

app.insertAdjacentHTML(
  'beforeend',
  `<div class="boot"><div class="inner">
     <h1>Tower City</h1>
     <p>Scanning for agent threads…</p>
     <div class="bar"><i></i></div>
   </div></div>`
)

const settings = new Settings()
const phoneLike = window.matchMedia('(max-width: 600px)').matches || (window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900)
if (!hasStoredSettings()) {
  settings.applyPreset(phoneLike ? 'low' : DEFAULT_PRESET)
  // Tower City's own default, not the shared one in `core/settings.js` — this is the one view
  // where growth is the whole point, so the frame counter is worth seeing without digging into
  // Settings for it. Only on a fresh install: someone who has already turned it off keeps that.
  settings.set('showFps', true)
}

installWorldCurve()
const engine = new Engine(settings).mount(app)
const rig = new CameraRig(engine.camera, engine.canvas, settings)
// One deck, not a sprawling multi-plot map — a plain drag turning the camera around it is more
// useful here than panning to somewhere else on a map that isn't there. Modifier+drag now pans.
rig.dragRotates = true
const colony = new TowerColony(engine.scene, settings, engine.camera, engine.renderer)

let state = { archived: [], archivedAt: {}, opened: [], seen: {}, viewedAt: {} }
let threads = []
let addedProjects = []
let harnesses = []
let legendProjects = []
let selectedId = null
/** Which project's skyline is on screen. Unlike the original app this is never "no project" —
 * boot picks the busiest one, same tie-break the legend itself sorts by. */
let selectedProject = null
let hoverId = null
let statusCursor = 0
let pendingSave = 0
const hoverGround = new THREE.Vector3()
let openingThreadId = null
let converting = false

// ── actions the HUD can trigger ────────────────────────────────────────────────────────

const actions = {
  // `showAddProject` already POSTs to `/api/projects` itself — this only has to notice the
  // result, same as the original app: refetch so `addedProjects`/`threads` include it, then
  // switch the skyline to it.
  addProject: () => showAddProject(async (result) => {
    const res = await fetchThreads()
    addedProjects = res.projects || []
    const project = addedProjects.find((p) => p.path === result.project.path) || result.project
    applyThreads(res.threads || [])
    selectProject(project.name, { fly: true })
    hud.toast(result.warning || `Added ${project.name}`, result.warning ? 'err' : undefined)
  }),

  viewportChanged: ({ width, height, right, bottom }) => {
    rig.setViewportInsets(width, height, { right, bottom })
    engine.tiltShift?.setCamera(engine.camera)
  },

  resetView: () => {
    if (rig.following) select(null, {})
    rig.resetView()
  },

  screenshot: () => {
    engine.renderFrame()
    const url = engine.canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = `tower-city-${selectedProject || 'colony'}-${stamp()}.png`
    a.click()
    hud.toast('Screenshot saved')
  },

  toggleOrbit: () => {
    const on = rig.toggleOrbit()
    hud.hint(on ? 'Orbit mode on — drag or press O to stop' : 'Orbit mode off')
    return on
  },

  cyclePlanet: () => {
    const ids = Object.keys(PLANETS)
    const next = ids[(ids.indexOf(settings.get('planet')) + 1) % ids.length]
    settings.set('planet', next)
    hud.hint(`${PLANETS[next].name} — ${PLANETS[next].blurb}`)
  },

  cycleTime: () => {
    settings.set('autoTime', false)
    settings.set('clockTime', false)
    const current = settings.get('timeOfDay')
    const next = TIMES.find((t) => t.value > current + 0.005) || TIMES[0]
    settings.set('timeOfDay', next.value)
    hud.hint(next.label)
  },

  focusStatus: (status) => {
    const key = status === 'agents' ? null : status
    const pool = colony.astronauts.agents.filter((a) => (key ? a.status === key : true))
    if (!pool.length) {
      hud.hint(key ? `Nobody is ${(STATUS_LABEL[key] || key).toLowerCase()} right now` : 'No crew on the surface')
      return
    }
    pool.sort((a, b) => a.id.localeCompare(b.id))
    const agent = pool[statusCursor++ % pool.length]
    select(agent.id, { fly: true })
  },

  focusProject: () => {
    if (rig.following) select(null, {})
    // Every project's deck starts fresh at its own local (0,0,0) — `resetView` (home distance,
    // default angle, target at the origin) already puts the camera exactly where a freshly
    // switched-to deck actually is. The previous version flew to `plot.middle` at a fixed
    // distance of 30 regardless of whatever distance you'd already zoomed to, which is what
    // read as "zooms in a bunch" on every switch instead of going home.
    rig.resetView()
  },

  pickProject: (name) => selectProject(name, { fly: true }),

  // One project is always on screen here, so "closing" it just drops the thread selection.
  closeProject: () => select(null, {}),

  select: (id) => select(id, {}),

  focusThread: (id) => select(id, { fly: true }),

  newConversation: async () => {
    const name = selectedProject
    const folder = name && pathForProject(name)
    if (!folder) {
      hud.toast('No folder on disk for that project', 'err')
      return
    }
    const detected = harnesses.filter((h) => h.detected)
    if (!detected.length) {
      hud.toast('No coding-agent harness detected on this machine', 'err')
      return
    }
    // Always offered, even with only one harness detected — a deliberate choice every time,
    // not just when there happens to be more than one option to choose between. Composed
    // client-side, not a `hud.js` change: `pickHarness` just shows whatever `{id, name}` list
    // it's given, so crossing detected harnesses with how to actually launch them (the app
    // itself, Wave Terminal specifically, or a plain terminal even if Wave is also running) is
    // real "select waveterm, cli, or the app" choice without touching the shared menu at all.
    let harness = harnessForProject(name) || detected[0].id
    const TRANSPORTS = [
      { id: 'gui', label: 'App' },
      { id: 'waveterm', label: 'WaveTerm' },
      { id: 'cli', label: 'Terminal' },
    ]
    const options = detected.flatMap((h) => TRANSPORTS.map((t) => ({ id: `${h.id}::${t.id}`, name: `${h.name} — ${t.label}` })))
    const chosen = await hud.pickHarness(options, { preferred: `${harness}::gui` })
    if (!chosen) return
    const [chosenHarness, transport] = chosen.split('::')
    harness = chosenHarness
    try {
      await newSession(folder, harness, transport)
      hud.toast(`New thread in ${name} — opening ${harnessLabel(harness)}`)
      setTimeout(poll, 6000)
    } catch (err) {
      hud.toast(err.message || 'Could not start a thread there', 'err')
    }
  },

  revealProject: async () => {
    const folder = selectedProject && pathForProject(selectedProject)
    if (!folder) return
    try {
      await revealFolder(folder)
    } catch (err) {
      hud.toast(err.message || 'Could not open that folder', 'err')
    }
  },

  openProjectInEditor: async () => {
    const folder = selectedProject && pathForProject(selectedProject)
    if (!folder) return
    try {
      await openInEditor(folder)
    } catch (err) {
      hud.toast(err.message || 'Could not open VS Code', 'err')
    }
  },

  saveContext: async (content, revision) => {
    const folder = selectedProject && pathForProject(selectedProject)
    if (!folder) throw new Error('No folder on disk for that project')
    return saveContext(folder, content, revision)
  },

  fetchSkillRegistry: async () => (await fetchSkillRegistry()).skills,
  addMarketplace: async (source) => (await addMarketplace(source)).skills,

  installSkill: async (marketplace, plugin, skillName) => {
    const folder = selectedProject && pathForProject(selectedProject)
    if (!folder) throw new Error('No folder on disk for that project')
    const result = await installSkill(marketplace, plugin, skillName, folder)
    extrasFetchedAt = 0
    loadProjectExtras(folder)
    return result
  },

  deleteSkill: async (name, scope) => {
    const folder = selectedProject && pathForProject(selectedProject)
    if (!folder) throw new Error('No folder on disk for that project')
    const result = await deleteSkill(name, scope, folder)
    extrasFetchedAt = 0
    loadProjectExtras(folder)
    return result
  },

  restoreSkill: async (name, scope) => {
    const folder = selectedProject && pathForProject(selectedProject)
    if (!folder) throw new Error('No folder on disk for that project')
    const result = await restoreSkill(name, scope, folder)
    extrasFetchedAt = 0
    loadProjectExtras(folder)
    return result
  },

  markViewed: () => {
    const thread = threads.find((t) => t.id === selectedId)
    if (!thread) return
    state.viewedAt = { ...(state.viewedAt || {}), [thread.id]: Date.now() }
    queueSave()
    applyThreads(threads)
    hud.toast(`Marked ${thread.title.slice(0, 40)} as viewed`)
  },

  hideProject: () => hud.toast('Switch to another project instead — one is always shown here'),
  unhideProject: () => {},

  setupHive: async () => {
    const folder = selectedProject && pathForProject(selectedProject)
    if (!folder) return
    try {
      const result = await setupProjectHive(folder)
      const made = [
        result.createdContext && 'context file',
        result.createdHook && 'stop hook',
        result.updatedSettings && 'settings',
        result.createdAgentsMd && 'AGENTS.md',
        result.createdAgyHook && 'Antigravity hook',
        result.updatedAgyHooks && 'Antigravity hooks.json',
      ].filter(Boolean)
      hud.toast(made.length ? `Set up: ${made.join(', ')}` : 'Already set up — nothing to add')
      extrasFetchedAt = 0
      loadProjectExtras(folder)
    } catch (err) {
      hud.toast(err.message || 'Could not set that up', 'err')
    }
  },

  copyProjectPath: async () => {
    const folder = selectedProject && pathForProject(selectedProject)
    if (!folder) return
    const copied = await copyToClipboard(folder)
    hud.toast(copied ? 'Path copied' : 'Could not reach the clipboard', copied ? '' : 'err')
  },

  convertToMarkdown: async (file) => {
    if (!file || converting) return
    if (file.type.startsWith('image/')) return actions.copyImage(file)
    converting = true
    hud.toast(`Converting ${file.name}…`)
    try {
      const dataBase64 = await fileToBase64(file)
      const { markdown } = await convertToMarkdown(file.name, dataBase64)
      const copied = await copyToClipboard(markdown)
      hud.toast(
        copied ? `Copied ${file.name} as markdown` : 'Converted, but could not reach the clipboard',
        copied ? '' : 'err'
      )
    } catch (err) {
      hud.toast(err.message || 'Could not convert that file', 'err')
    } finally {
      converting = false
    }
  },

  copyImage: async (file) => {
    if (!file || converting) return
    converting = true
    try {
      const png = await toPngBlob(file)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      hud.toast(`Copied ${file.name} — paste into Claude Code with Alt+V (Ctrl+V on macOS/Linux)`)
    } catch (err) {
      hud.toast(err.message || 'Could not copy that image', 'err')
    } finally {
      converting = false
    }
  },

  openThread: async () => {
    const thread = threads.find((t) => t.id === selectedId)
    if (!thread || openingThreadId) return
    if (thread.canOpen === false) {
      hud.toast('That thread is on a teammate’s machine, not this one', 'err')
      return
    }
    openingThreadId = thread.id
    try {
      const res = await openThread(thread)
      colony.astronauts.celebrate(thread.id)
      hud.toast(res?.note || `Opened in ${thread.harnessName || 'your harness'}`)
      setTimeout(poll, 1800)
    } catch (err) {
      hud.toast(err.message || 'Could not open that thread', 'err')
    } finally {
      openingThreadId = null
    }
  },

  archiveThread: () => {
    const thread = threads.find((t) => t.id === selectedId)
    if (!thread) return
    state.archived = [...new Set([...state.archived, thread.id])]
    state.archivedAt = { ...state.archivedAt, [thread.id]: Date.now() }
    queueSave()
    select(null, {})
    applyThreads(threads)
    hud.toast('Archived — heading home')
    colony.ship.ping?.()
  },

  uiVisibility: (visible) => colony.setUiVisible(visible),

  progressFor: (id) => {
    const thread = threads.find((t) => t.id === id)
    return thread ? transcriptProgress(thread) : 0
  },
}

const hud = new Hud(app, settings, actions)

// `Hud` is the exact same class the original multi-project map uses, unedited — including its
// "Bot Crossing" brand and its repo list built for *browsing many projects at once*. This app
// only ever shows one, so on top of that shared chrome (DOM patches, not a hud.js edit) it gets
// its own name and an actual `<select>` for "which one" instead of relying solely on the list.
const brand = app.querySelector('.side .brand')
if (brand) brand.lastChild.textContent = 'Tower City'

// `hidden` the attribute does nothing here — `styles.css` sets `.side .projects { display:
// flex }` etc. directly, which is more specific than the browser's default `[hidden] { display:
// none }` rule and silently wins over it. An inline style instead, since nothing in an external
// stylesheet can outrank that short of `!important` (styles.css uses none).
const hide = (el) => el && (el.style.display = 'none')

// `.projects-pane` (where this lived at first) is exactly the wrong place: `styles.css` has
// `.side.drilled .projects-pane { display: none }` — drilling into a repo *swaps the whole pane
// out* for `.project-detail` rather than showing both, and this app calls `setProject` with a
// real project from the moment it boots, so `.side` carries `.drilled` permanently. Anything
// placed in `.projects-pane` is therefore never visible here at all. `.project-detail` — right
// above `.who` (the swatch/name/path block) — is the pane that's actually on screen.
// A plain `<select>` renders with the OS's own default chrome regardless of the surrounding
// dark theme — `appearance: none` plus a hand-drawn chevron is what makes it actually look like
// it belongs in this sidebar next to real `.btn` buttons, rather than a stock form control
// dropped on top of it. The hover/focus rules go through a real `<style>` tag (inline styles
// can't express a pseudo-class); everything else stays inline, next to the element it styles.
const repoSelectCss = document.createElement('style')
repoSelectCss.textContent = `
  .repo-select:hover { background-color: rgba(255,255,255,.11); border-color: var(--line-strong); }
  .repo-select:focus { outline: none; border-color: var(--accent); }
`
document.head.appendChild(repoSelectCss)

const repoLabel = document.createElement('label')
repoLabel.textContent = 'Project'
repoLabel.style.cssText = 'display:block;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:12px 0 4px;padding:0 15px;'
const repoSelect = document.createElement('select')
repoSelect.className = 'repo-select'
repoSelect.title = 'Which project this skyline is showing'
repoSelect.style.cssText =
  'display:block;flex:1;height:34px;padding:0 30px 0 11px;' +
  'font:inherit;font-size:13px;color:var(--text);cursor:pointer;' +
  'border-radius:10px;border:1px solid var(--line);background-color:rgba(255,255,255,.05);' +
  'appearance:none;-webkit-appearance:none;' +
  `background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%239b9aa3' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");` +
  'background-repeat:no-repeat;background-position:right 12px center;' +
  'transition:background-color 140ms ease, border-color 140ms ease;'

// `#btn-add-project` (the original "+ Add project" trigger) lives inside `.projects-pane`,
// which `.side.drilled .projects-pane { display: none }` hides permanently here — this app
// calls `setProject` with a real project from boot, so `.side` always carries `.drilled`.
// `actions.addProject` (below) already wraps `showAddProject` correctly; it just had no visible
// way to reach it once that pane was gone. A plain "+" button next to the project switcher is
// the equivalent entry point for a single-project sidebar.
const addProjectBtn = document.createElement('button')
addProjectBtn.type = 'button'
addProjectBtn.className = 'btn icon'
addProjectBtn.title = 'Add another project to switch between'
addProjectBtn.textContent = '+'
addProjectBtn.style.cssText = 'flex:none;font-size:18px;'
addProjectBtn.addEventListener('click', () => actions.addProject())

const repoRow = document.createElement('div')
repoRow.style.cssText = 'display:flex;gap:8px;margin:0 15px 10px;'
repoRow.append(repoSelect, addProjectBtn)

const projectDetail = app.querySelector('.project-detail')
const who = projectDetail?.querySelector('.who')
projectDetail?.insertBefore(repoLabel, who)
projectDetail?.insertBefore(repoRow, who)
repoSelect.addEventListener('change', () => selectProject(repoSelect.value, { fly: true }))

/** Keeps the dropdown in step with whichever project is actually showing — including the very
 * first paint, so it opens already pointed at the repo you're looking at, not a blank choice. */
function syncRepoSelect() {
  const names = legendProjects.map((p) => p.name)
  // The closed `<select>` picks up the inline styles below just fine, but the *open* dropdown
  // list is browser-native chrome that mostly ignores styling on the `<select>` itself — Edge/
  // Chrome do still honour `background`/`color` set directly on each `<option>`, which is the
  // only thing that actually fixed "grey text on a white background" here.
  const html = names
    .map((n) => `<option value="${n}"${n === selectedProject ? ' selected' : ''} style="background:#14151b;color:#f2f0ec;">${n}</option>`)
    .join('')
  if (repoSelect.innerHTML !== html) repoSelect.innerHTML = html
  repoSelect.value = selectedProject || ''
}

// The rest of the multi-project chrome this shares with the original app, trimmed to what
// actually applies when exactly one project is ever on screen:
// - the clickable repo *list* duplicates the dropdown above it now — one selector, not two.
// - "hidden repos" has no equivalent — nothing here is ever hidden, only switched away from.
// - "← All repos" went to a view (the whole-map overview) that doesn't exist in this app; it
//   looked broken because clicking it genuinely did nothing.
// - "Hide from colony" is the same story — already just a toast pointing at switching projects.
hide(app.querySelector('.projects-pane .projects'))
hide(app.querySelector('.hidden-block'))
hide(app.querySelector('#btn-close-project'))
hide(app.querySelector('#btn-hide-project'))
// Sat to the right of the project name/path doing "fly to the only thing on screen" — never
// useful here the way it is in the real multi-plot map, so out entirely rather than relabelled.
hide(app.querySelector('#btn-locate'))

// The shared repo notes are the actual point of this app — "a shared project for the whole team,
// not just lines of code" — so it doesn't stay a collapsed section at the bottom of the sidebar
// (the original map's treatment). It becomes its own slide-out panel: a slim trigger stays in
// the sidebar where the section used to live, and `#context-section` itself is styled as a fixed
// drawer that slides out from behind the sidebar — real room to read, not a cramped 280px clip.
//
// It IS reparented — one level, not out to `document.body`. `hud.$` (every `setContext`/edit/
// save call) is `this.el.querySelector`, scoped to the `<div class="hud">` `Hud` built for
// itself, so the node has to stay somewhere in `hud.el`'s subtree — `querySelector` searches the
// whole subtree regardless of depth, so moving it from deep inside `.side` to a direct child of
// `hud.el` keeps every lookup working. It has to move at least that far, though: `.side` carries
// `.panel`'s `backdrop-filter` (line ~180 of `styles.css`) plus its own `overflow: hidden` —
// `backdrop-filter` on an ancestor creates a new containing block for a `position: fixed`
// descendant, so while it was still nested inside `.side` the drawer was being sized and
// clipped *to the sidebar's own box*, not the viewport, no matter what `top`/`right`/`width` it
// was given — confirmed against a screenshot showing it literally unable to extend past the
// sidebar's edge. `hud.el` (`.hud`) itself never gets a `transform`/`filter`/`backdrop-filter`
// (checked directly — only `overflow: clip`, which alone doesn't trap `fixed` descendants), so a
// direct child of it is genuinely viewport-relative.
const contextSection = app.querySelector('#context-section')
const contextTrigger = document.createElement('button')
if (contextSection && who) {
  hud.contextOpen = true
  contextSection.classList.add('panel')
  // `right: 334px` is the sidebar's own width (320px) plus its 14px gap — the same footprint
  // `--side` (`.hud`'s own CSS custom property) uses elsewhere for "how much room the sidebar
  // takes." Anchoring the drawer there, not at `right: 14px`, means it opens *beside* the
  // sidebar rather than on top of it — both visible together — and the closed transform below
  // shifts it past its own width plus that same 320px, so it tucks fully behind the sidebar
  // rather than merely off-screen to the right.
  // A negative z-index (`.side` itself never sets one, so it paints at the default level) keeps
  // the drawer behind the sidebar for the whole slide, not just at rest — sliding it *out* from
  // under `.side` rather than over top of it, which is what "in front of it" looked like before.
  contextSection.style.cssText =
    'position:fixed;top:14px;bottom:14px;right:334px;width:min(920px,calc(100vw - 534px));' +
    'z-index:-1;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;' +
    'transition:transform 260ms cubic-bezier(.22,1,.36,1);transform:translateX(calc(100% + 320px));'
  hud.el.appendChild(contextSection)

  // Every `.side .context-*` rule in `styles.css` needs `.side` as an ancestor to match —
  // moving this element out of `.side` (see the containing-block note above) silently dropped
  // every one of them: the textarea's real size, the header's layout, the body's own colour and
  // wrapping. Replaced here, scoped by id so `.side` isn't needed, and re-tuned for a drawer
  // this much bigger than the card those rules were originally sized for. `overflow-wrap: anywhere`
  // (not just the old `word-break: break-word`) is what actually stops a long unbroken token —
  // a path, a url — from forcing the sideways scroll that showed up without it.
  const contextDrawerCss = document.createElement('style')
  contextDrawerCss.textContent = `
    /* #context-section itself now carries NO padding at all — every earlier attempt at a sticky
       header fought that outer padding with a negative-margin/re-pad trick, which is exactly what
       kept coming out wrong (too thick, a visible gap above it, backgrounds that didn't reach the
       container's own top edge or corners). Simpler and more robust: the header owns its own
       modest padding and matches the container's own top corner radius directly, and every other
       child (.context-body/.context-create/.context-editor) gets its own padding instead of
       relying on the container's. No margin arithmetic left for any of it to get wrong.
       A translucent overlay (the previous rgba white tint) let scrolled text show straight
       through it — a sticky header has to actually be opaque to cover what's scrolling under it,
       not just tinted. var(--panel-solid) is fully opaque and already the app's own solid-surface
       colour (the add-project dialog uses it too) — no backdrop-filter needed either way, see the
       lesson already recorded about that on a sticky element. */
    #context-section .context-head {
      display: flex; align-items: center; gap: 10px; position: sticky; top: 0; z-index: 1;
      padding: 14px 28px; border-bottom: 1px solid var(--line); border-radius: 14px 14px 0 0;
      background: var(--panel-solid);
    }
    #context-section #btn-context-toggle { flex: 1; justify-content: flex-start; padding: 0; background: none; border: none; cursor: default; pointer-events: none; }
    #context-section #btn-context-toggle .label { font-size: 15px; font-weight: 600; color: var(--text); }
    #context-section .context-body { padding: 18px 28px 22px; color: var(--text); overflow-wrap: anywhere; }
    #context-section .context-create { width: calc(100% - 56px); margin: 18px 28px; justify-content: flex-start; color: var(--muted); }
    #context-section .context-editor { flex: 1; display: flex; flex-direction: column; gap: 10px; padding: 18px 28px 22px; min-height: 0; }
    #context-section .context-textarea {
      flex: 1; width: 100%; min-height: 0; resize: none; font: inherit; font-size: 14px; line-height: 1.6;
      padding: 14px; border-radius: 10px; border: 1px solid var(--line); background: rgba(255,255,255,.04);
      color: var(--text); overflow-wrap: anywhere;
    }
    #context-section .context-editor-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
    #context-section .context-error { flex: 1; color: var(--red); font-size: 12px; }
    /* Same trap as .projects-pane earlier: an author rule's explicit display (this file's own
       rules above, or .btn's base rule on .context-create) always beats the browser's default
       hidden-attribute rule, origin order regardless of specificity — while this lived inside
       .side, its own [hidden] overrides handled that; out here, these have to instead. */
    #context-section .context-head[hidden],
    #context-section .context-create[hidden],
    #context-section .context-editor[hidden],
    #context-section .context-body[hidden] { display: none; }
    /* Same thin, near-invisible-until-hovered scrollbar the sidebar's own thread/project lists
       use (.side .threads/.projects in styles.css) — the drawer sits outside .side now, so it
       needs its own copy rather than inheriting theirs. */
    #context-section, #context-section .context-textarea {
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,.16) transparent;
    }
    #context-section::-webkit-scrollbar, #context-section .context-textarea::-webkit-scrollbar { width: 8px; }
    #context-section::-webkit-scrollbar-thumb, #context-section .context-textarea::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,.14); border-radius: 8px;
    }
  `
  document.head.appendChild(contextDrawerCss)

  // A real drawer handle, not a button sitting in the header — a slim vertical tab at the
  // drawer's own left edge (the side facing the rest of the scene, where a real drawer's pull
  // would be), pointing → since the drawer opened by sliding *left*, so collapsing it pushes it
  // back *right*. `position: absolute` inside `#context-section` (which is `position: fixed`,
  // so it's a valid containing block on its own) rather than a sibling: it needs to slide with
  // the drawer as one piece, and a sibling would need to duplicate the exact same `min()` width
  // math just to stay aligned with the drawer's actual edge. Sits at `left: 0`, not sticking out
  // past it — `#context-section` still clips overflow-x, so anything positioned outside its own
  // box would just be cut off — sized to fit inside the 28px left padding each content child
  // (.context-body/.context-editor) already leaves along that edge, which is plenty of room for
  // a slim tab to read as attached to the edge without overlapping real text.
  const drawerHandle = document.createElement('button')
  drawerHandle.type = 'button'
  drawerHandle.title = 'Close'
  drawerHandle.textContent = '→'
  drawerHandle.style.cssText =
    'position:absolute;left:0;top:50%;transform:translateY(-50%);width:20px;height:68px;' +
    'display:flex;align-items:center;justify-content:center;padding:0;' +
    'border:1px solid var(--line);border-left:none;border-radius:0 10px 10px 0;' +
    'background:rgba(255,255,255,.08);color:var(--muted);cursor:pointer;'
  contextSection.appendChild(drawerHandle)

  contextTrigger.type = 'button'
  contextTrigger.id = 'btn-context-drawer'
  contextTrigger.title = 'Open the shared project notes'
  contextTrigger.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;width:calc(100% - 30px);' +
    'margin:10px 15px 14px;padding:10px 12px;font:inherit;font-size:13px;color:var(--text);' +
    'cursor:pointer;border-radius:10px;border:1px solid var(--line);background:rgba(255,255,255,.05);'
  contextTrigger.innerHTML = '<span>Shared project context</span><span aria-hidden="true" class="drawer-chevron" style="display:inline-block;transition:transform 200ms ease;">&rsaquo;</span>'
  const contextTriggerChevron = contextTrigger.querySelector('.drawer-chevron')
  projectDetail.insertBefore(contextTrigger, who.nextSibling)

  const setOpen = (open) => {
    contextSection.style.transform = open ? 'translateX(0)' : 'translateX(calc(100% + 320px))'
    contextSection.dataset.open = String(open)
    // Closed, the chevron points right — "opens leftward, this way." Open, it flips to point
    // left — "closes rightward, back this way" — same direction the tab's own arrow points.
    if (contextTriggerChevron) contextTriggerChevron.style.transform = open ? 'rotate(180deg)' : 'none'
  }
  contextTrigger.addEventListener('click', () => setOpen(contextSection.dataset.open !== 'true'))
  drawerHandle.addEventListener('click', () => setOpen(false))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && contextSection.dataset.open === 'true') setOpen(false)
  })
  document.addEventListener('pointerdown', (e) => {
    if (contextSection.dataset.open !== 'true') return
    if (contextSection.contains(e.target) || contextTrigger.contains(e.target)) return
    setOpen(false)
  })
}
const contextBody = app.querySelector('.context-body')
if (contextBody) {
  // `.context-body` is a `<pre>` — its UA default is `white-space: pre` (no wrapping at all).
  // Dropping the override here (done when the font was added) let a long rendered line run off
  // and get clipped flush at the container's edge by `overflow-x: hidden`, which is what read as
  // "no right padding": the text wasn't wrapping into the padding at all, it was being cut off
  // right at the boundary. `normal`, not the earlier `pre-wrap`, since the rendered output is
  // real block HTML now with no meaningful raw newlines left to preserve.
  contextBody.style.cssText =
    'max-height:none;font-size:15px;line-height:1.7;white-space:normal;' +
    "font-family:Georgia,'Iowan Old Style','Palatino Linotype',Palatino,serif;"
}
const contextLabel = app.querySelector('#context-section .label')
if (contextLabel) contextLabel.textContent = 'Project context'

// A rendered view for reading, a raw textarea for editing — not a live split-pane preview,
// which wasn't asked for and would fight `.context-editor`'s own layout. Small hand-rolled
// renderer rather than a new dependency: this file's own notes only ever use headings, bold,
// inline code, links and bullet lists, so covering exactly that is a few lines, not a library.
// `hud.js` itself only ever writes `.context-body`'s plain `textContent` (`setContext`); wrapping
// that method from here — rather than editing it — re-renders as HTML every time it's called,
// same "extend, don't edit" approach as everything else touched in `hud.js`'s neighbourhood.
//
// A bullet in this file routinely wraps across several soft-wrapped source lines with no `-` on
// the continuation ones — the first version treated every one of those as its own new paragraph,
// which is what actually made the reading view look like "spacing all over the place": a
// one-sentence `<p>` interrupting what should have read as a single list item, over and over.
// Real Markdown treats a block as ending at a *blank* line, not at every line break — matching
// that (join a list item's continuation lines into the same `<li>`, only breaking on a blank
// line, a new bullet, or a heading) is what actually fixes it, not a CSS margin tweak.
function renderContextMarkdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')

  let html = ''
  let inList = false
  let para = []
  let item = null
  const flushItem = () => {
    if (item) { html += `<li>${inline(item.join(' '))}</li>`; item = null }
  }
  const closeList = () => {
    flushItem()
    if (inList) { html += '</ul>'; inList = false }
  }
  const flushPara = () => {
    if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = [] }
  }
  for (const line of (md || '').split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const item_ = /^\s*[-*]\s+(.*)$/.exec(line)
    if (heading) {
      flushPara()
      closeList()
      html += `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`
    } else if (item_) {
      flushPara()
      flushItem()
      if (!inList) { html += '<ul>'; inList = true }
      item = [item_[1]]
    } else if (line.trim() === '') {
      flushPara()
      closeList()
    } else if (inList && item) {
      item.push(line.trim())
    } else {
      closeList()
      para.push(line)
    }
  }
  flushPara()
  closeList()
  return html
}
if (contextBody) {
  const originalSetContext = hud.setContext.bind(hud)
  hud.setContext = (data) => {
    originalSetContext(data)
    if (!hud.contextEditing && hud._context?.exists) contextBody.innerHTML = renderContextMarkdown(hud._context.content)
  }
  // `_startContextEdit` (`hud.js`) sets `.context-textarea.value` then calls `.focus()` — on a
  // long file (this repo's own is 700+ lines) that leaves the cursor, and several browsers'
  // default selection, sitting at the *end* of the text, which drags the textarea's own internal
  // scrollbar down to its bottom on focus — a second, separate scroll from the drawer's own,
  // which is what kept jumping even after resetting `contextSection.scrollTop`. Forcing the
  // selection to position 0 before resetting both scroll positions fixes the actual cause.
  if (contextSection) {
    for (const method of ['_startContextEdit', '_cancelContextEdit', '_saveContextEdit']) {
      const original = hud[method].bind(hud)
      hud[method] = async (...args) => {
        const result = await original(...args)
        const textarea = contextSection.querySelector('.context-textarea')
        if (textarea) {
          textarea.setSelectionRange(0, 0)
          textarea.scrollTop = 0
        }
        contextSection.scrollTop = 0
        return result
      }
    }
  }
  // Browser default heading/paragraph margins are all roughly the same size, which reads as
  // one undifferentiated wall of even gaps rather than actual structure — a heading should
  // stand apart from what follows it more than two paragraphs stand apart from each other.
  const contextTypographyCss = document.createElement('style')
  contextTypographyCss.textContent = `
    .context-body h1, .context-body h2, .context-body h3,
    .context-body h4, .context-body h5, .context-body h6 { margin: 14px 0 4px; line-height: 1.25; }
    .context-body h1:first-child, .context-body h2:first-child,
    .context-body h3:first-child, .context-body h4:first-child { margin-top: 0; }
    .context-body p { margin: 0 0 6px; }
    .context-body ul { margin: 0 0 6px; padding-left: 20px; }
    .context-body li { margin: 0 0 2px; }
    .context-body li:last-child, .context-body p:last-child { margin-bottom: 0; }
  `
  document.head.appendChild(contextTypographyCss)
}
const contextTextarea = app.querySelector('.context-textarea')
if (contextTextarea) {
  contextTextarea.placeholder =
    'Headings, **bold**, `code`, links and - bullets all render in the view above.\n\n' +
    'A loose standard for this file, not a rigid schema — adjust freely:\n' +
    '## Overview — what this project is, in a couple sentences\n' +
    '## Lessons & Notes — one bullet per thing worth knowing, tag the kind: [decision] [gotcha] [todo]\n' +
    '## Open Questions — unresolved, needs a person'
}

// Provisions the shared context file + stop hook for teammates who clone this repo — additive
// and idempotent server-side (`ensureProjectSetup`), so this button is safe to click more than
// once and just reports "already set up" the second time.
const projectActions = app.querySelector('.project-actions')
const vscodeBtn = app.querySelector('#btn-vscode')
if (projectActions && vscodeBtn) {
  const setupBtn = document.createElement('button')
  setupBtn.type = 'button'
  setupBtn.className = 'btn'
  setupBtn.id = 'btn-setup-hive'
  setupBtn.title = 'Add the shared context file + stop hook to this repo, for every teammate who clones it'
  setupBtn.textContent = 'Set up shared hive'
  setupBtn.addEventListener('click', () => actions.setupHive())
  vscodeBtn.insertAdjacentElement('afterend', setupBtn)
}

const contextHead = app.querySelector('.context-head')
const contextEditBtn = app.querySelector('#btn-context-edit')
if (contextHead && contextEditBtn) {
  const downloadBtn = document.createElement('button')
  downloadBtn.type = 'button'
  downloadBtn.className = 'btn ghost'
  downloadBtn.textContent = 'Download'
  downloadBtn.title = 'Save .agent-context.md'
  downloadBtn.addEventListener('click', () => {
    const blob = new Blob([hud._context?.content || ''], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '.agent-context.md'
    a.click()
    URL.revokeObjectURL(url)
  })
  contextHead.insertBefore(downloadBtn, contextEditBtn)
}

// ── planet (background) ──────────────────────────────────────────────────────────────

function applyPlanet() {
  colony.setPlanet(tunedPlanet(PLANETS[settings.get('planet')] || PLANETS.moon))
  engine.setPlanetGrade(PLANETS[settings.get('planet')]?.grade)
}

// ── selection ─────────────────────────────────────────────────────────────────────────

function select(id, { fly = false } = {}) {
  selectedId = id
  const agent = id ? colony.agentFor(id) : null
  if (!agent) {
    selectedId = null
    rig.setFollow(null)
    colony.astronauts.setSelected(null)
    hud.setSelection(null, null)
    syncProject()
    return
  }
  colony.astronauts.setSelected(agent)
  const thread = threads.find((t) => t.id === id) || agent.thread
  hud.setSelection(agent, thread)
  syncProject()
  if (fly) rig.focus(new THREE.Vector3(agent.pos.x, 0, agent.pos.z), { distance: Math.min(rig.desiredDistance, 26) })
  rig.setFollow(settings.get('followSelected') ? agent : null)
}

/** Switches which project's skyline is on screen — the equivalent of the original app's
 * "open a zone's sidebar", except here that also means rebuilding the crew and towers for it. */
function selectProject(name, { fly = false } = {}) {
  if (!name || name === selectedProject) {
    if (fly) actions.focusProject(name)
    return
  }
  if (selectedId) select(null, {})
  selectedProject = name
  // `localStorage`, not `/api/state` — that file's read/write path (`server/api.mjs`) rebuilds
  // a fixed schema on every save (`archived`/`archivedAt`/`plots`/… ) and would silently drop
  // any field not already in it, so a `state.lastProject` never would have survived a save.
  // It's also arguably the more correct home for it anyway: which project *you* were last
  // looking at is a per-viewer preference, not shared server state the way the archive list is.
  try {
    localStorage.setItem('towerCity.lastProject', name)
  } catch {
    /* private browsing, storage disabled, or full — losing "last opened" is not worth a crash */
  }
  colony.showProject(name)
  refreshCurrentProject()
  if (fly) actions.focusProject(name)
}

function harnessLabel(id) {
  for (const thread of threads) {
    if (thread.harness === id && thread.harnessName) return thread.harnessName
  }
  return 'your harness'
}

function harnessForProject(name) {
  const counts = new Map()
  for (const thread of threads) {
    if (thread.project !== name || !thread.harness) continue
    counts.set(thread.harness, (counts.get(thread.harness) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [id, n] of counts) {
    if (n <= bestCount) continue
    best = id
    bestCount = n
  }
  return best
}

function pathForProject(name) {
  const added = addedProjects.find((p) => p.name === name)
  if (added) return added.path
  const counts = new Map()
  for (const thread of threads) {
    if (thread.project !== name) continue
    const dir = thread.projectPath || thread.cwd
    if (!dir) continue
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [dir, n] of counts) {
    if (n <= bestCount) continue
    best = dir
    bestCount = n
  }
  return best
}

let extrasPath = null
let extrasFetchedAt = 0
let extrasInFlight = null
async function loadProjectExtras(path) {
  if (path !== extrasPath) {
    extrasPath = path
    extrasFetchedAt = 0
    hud.setSkills([])
    hud.setContext({ exists: false, content: '' })
  }
  if (!path || extrasInFlight || Date.now() - extrasFetchedAt < POLL_MS) return
  const forPath = path
  extrasInFlight = (async () => {
    try {
      const [skillsRes, contextRes] = await Promise.all([fetchSkills(forPath), fetchContext(forPath)])
      if (extrasPath !== forPath) return
      hud.setSkills(skillsRes.skills || [], skillsRes.trashed || [])
      hud.setContext(contextRes)
      extrasFetchedAt = Date.now()
    } catch {
      /* left as-is; extrasFetchedAt stays put so the next poll retries */
    } finally {
      extrasInFlight = null
    }
  })()
  await extrasInFlight
}

/** Rebuild the visible project's crew/towers from the current `threads`, and push its sidebar
 * panel. Called on every poll and every selection change — same cadence as the original. */
function refreshCurrentProject() {
  if (!selectedProject) return
  const now = Date.now()
  const known = new Set(Object.keys(state.seen || {}))
  const projectThreads = threads.filter((t) => t.project === selectedProject && !state.archived.includes(t.id))
  const stats = colony.setThreads(projectThreads, known)
  hud.setStats(stats)

  // The sidebar's thread list is yours to act on — open, archive, mark viewed — none of which
  // makes sense for a teammate's thread on their own machine (`remote: true`, `canOpen: false`
  // already). They still walk around the deck as astronauts; they just don't belong in this list.
  const list = projectThreads
    .filter((thread) => !thread.remote)
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      worktree: thread.worktree,
      lastActivityAt: thread.lastActivityAt,
      status: statusFor(thread, now),
    }))
    .sort((a, b) => {
      const rank = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
      return rank || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    })

  const projectPath = pathForProject(selectedProject)
  loadProjectExtras(projectPath)
  const plot = colony.plots.get(selectedProject)
  hud.setProject({ name: selectedProject, accent: plot?.accent, path: projectPath, threads: list, selectedId })
  hud.setLegend(legendProjects, selectedProject, [], [])
  syncRepoSelect()
}

function syncProject() {
  refreshCurrentProject()
}

// ── pointer ───────────────────────────────────────────────────────────────────────────

const cardAnchor = new THREE.Vector3()
function screenOf(agent) {
  bendPoint(cardAnchor.set(agent.pos.x, agent.pos.y + 0.95, agent.pos.z)).project(engine.camera)
  if (cardAnchor.z > 1) return null
  const { w, h } = engine.viewport
  return { x: (cardAnchor.x * 0.5 + 0.5) * w, y: (-cardAnchor.y * 0.5 + 0.5) * h }
}

function ndc(e) {
  const rect = engine.canvas.getBoundingClientRect()
  return {
    x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
    y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
    aspect: rect.width / rect.height,
  }
}

engine.canvas.addEventListener('pointermove', (e) => {
  if (rig.interacting) {
    engine.canvas.style.cursor = rig._mode === 'orbit' ? 'move' : 'grabbing'
    return
  }
  const p = ndc(e)
  const agent = colony.pick(p.x, p.y, p.aspect)
  hoverId = agent?.id ?? null
  colony.astronauts.setHover(agent)
  engine.canvas.style.cursor = agent ? 'pointer' : 'grab'
})

engine.canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !rig.wasClick) return
  const p = ndc(e)
  const agent = colony.pick(p.x, p.y, p.aspect)
  if (agent) select(agent.id, {})
  else if (selectedId) select(null, {})
})

engine.canvas.addEventListener('pointerleave', () => {
  hoverId = null
  colony.astronauts.setHover(null)
})

// ── keyboard ──────────────────────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (document.querySelector('.add-project-dialog[open]')) return
  const t = e.target
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return

  if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault()
    hud.toggleUi()
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return

  switch (e.key) {
    case 'h':
    case 'H':
      hud.toggleUi()
      break
    case 's':
    case 'S':
      hud.toggleSettings()
      break
    case 'n':
    case 'N':
      actions.focusStatus('waiting')
      break
    case 'p':
    case 'P':
      actions.screenshot()
      break
    case 'l':
    case 'L':
      actions.cycleTime()
      break
    case 'o':
    case 'O':
      hud.setOrbit(actions.toggleOrbit())
      break
    case 'Tab':
      e.preventDefault()
      actions.cyclePlanet()
      break
    case '0':
      actions.resetView()
      hud.setOrbit(false)
      break
    case 'Enter':
      if (selectedId) actions.openThread()
      break
    case 'a':
    case 'A':
      if (selectedId) actions.archiveThread()
      break
    case 'v':
    case 'V':
      if (selectedId) actions.markViewed()
      break
    case 'c':
    case 'C':
      if (selectedProject) actions.newConversation()
      break
    case '?':
      hud.toggleHelp()
      break
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight': {
      e.preventDefault()
      const step = rig.distance * 0.09
      const forward = new THREE.Vector3(Math.sin(rig.azimuth), 0, Math.cos(rig.azimuth))
      const right = new THREE.Vector3(forward.z, 0, -forward.x)
      if (e.key === 'ArrowUp') rig.desiredTarget.addScaledVector(forward, -step)
      if (e.key === 'ArrowDown') rig.desiredTarget.addScaledVector(forward, step)
      if (e.key === 'ArrowLeft') rig.desiredTarget.addScaledVector(right, -step)
      if (e.key === 'ArrowRight') rig.desiredTarget.addScaledVector(right, step)
      rig._clampTarget()
      rig.idleFor = 0
      break
    }
    case '+':
    case '=':
      rig.desiredDistance = Math.max(4, rig.desiredDistance * 0.82)
      break
    case '-':
    case '_':
      rig.desiredDistance = Math.min(150, rig.desiredDistance * 1.22)
      break
    case 'Escape':
      if (document.querySelector('.help.open')) hud.toggleHelp(false)
      else if (selectedId) select(null, {})
      break
  }
})

// ── paste & drag-drop ────────────────────────────────────────────────────────────────

window.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file')?.getAsFile()
  if (!file) return
  e.preventDefault()
  actions.convertToMarkdown(file)
})

let dragDepth = 0
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  if (++dragDepth === 1) document.body.classList.add('drag-active')
})
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
})
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0
    document.body.classList.remove('drag-active')
  }
})
window.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0]
  dragDepth = 0
  document.body.classList.remove('drag-active')
  if (!file) return
  e.preventDefault()
  actions.convertToMarkdown(file)
})

// ── data ──────────────────────────────────────────────────────────────────────────────

function applyThreads(list) {
  const viewed = state.viewedAt || {}
  threads = list.map((t) => {
    const at = viewed[t.id]
    return at && t.lastActivityAt <= at ? { ...t, unread: false } : t
  })
  const archivedSet = new Set(state.archived)

  const known = new Set(Object.keys(state.seen || {}))
  let firstSeen = false
  for (const t of threads) {
    if (state.seen?.[t.id]) continue
    state.seen = { ...(state.seen || {}), [t.id]: Date.now() }
    firstSeen = true
  }
  if (firstSeen) queueSave()

  // The legend groups the *whole* thread list by project — unlike the original app, nothing
  // here renders more than one project at once, so it can't be built from what's on screen.
  const byProject = new Map()
  for (const t of threads) {
    if (archivedSet.has(t.id)) continue
    if (!byProject.has(t.project)) byProject.set(t.project, { count: 0, urgent: false, accent: null })
    const entry = byProject.get(t.project)
    entry.count++
    const status = statusFor(t, Date.now())
    if (status === 'waiting' || status === 'blocked') entry.urgent = true
  }
  legendProjects = [...byProject.entries()]
    .map(([name, e]) => ({ name, count: e.count, urgent: e.urgent, accent: colony.accentFor(name) }))
    .sort((a, b) => b.count - a.count)

  if (!selectedProject || !byProject.has(selectedProject)) {
    // First poll ever (nothing picked yet this session): reopen wherever you left off, falling
    // back to the busiest repo only if that one's gone (renamed, no threads left, never existed).
    let lastProject = null
    try {
      lastProject = localStorage.getItem('towerCity.lastProject')
    } catch {
      /* private browsing, storage disabled — just falls through to the busiest repo */
    }
    selectedProject = (lastProject && byProject.has(lastProject) ? lastProject : legendProjects[0]?.name) || null
    if (selectedProject) colony.showProject(selectedProject)
  }
  if (selectedProject) refreshCurrentProject()
  else hud.setProject(null)

  if (selectedId) {
    const still = colony.agentFor(selectedId)
    if (still) hud.setSelection(still, threads.find((t) => t.id === selectedId) || still.thread)
    else select(null, {})
  }
}

let polling = false
async function poll() {
  if (polling || document.hidden) return
  polling = true
  try {
    const res = await fetchThreads()
    addedProjects = res.projects || []
    applyThreads(res.threads || [])
    hud.removeBoot()
  } catch (err) {
    hud.toast(err.message || 'Could not reach the thread scanner', 'err')
    hud.removeBoot()
  } finally {
    polling = false
  }
}

function queueSave() {
  clearTimeout(pendingSave)
  pendingSave = setTimeout(async () => {
    try {
      state = await saveState(state)
    } catch {
      /* the colony still runs; only the archive list is at risk, and it retries next time */
    }
  }, 500)
}

async function boot() {
  const settle = (p) => p.then(() => null, (err) => err)
  const [, kitError, crewError] = await Promise.all([
    fetchState()
      .then((s) => {
        state = { ...state, ...s }
        if (!hasStoredSettings() && state.settings) settings.applyAll(state.settings)
      })
      .catch(() => {}),
    fetchHarnesses()
      .then((res) => {
        harnesses = res.harnesses || []
      })
      .catch(() => {}),
    settle(loadKit()),
    settle(loadCrew()),
  ])
  if (kitError || crewError) {
    hud.toast('Could not load the model assets — run `npm run assets`', 'err')
    console.error(kitError || crewError)
  }
  colony.astronauts.setRig(crewRig())
  // Anything here throwing (a bad planet preset restored from a previous session, say) used to
  // leave "Scanning for agent threads…" up forever — `boot()` runs fire-and-forget (see the
  // bottom of this file) with no caller to catch a rejection, and `poll()`'s own try/catch
  // (which always calls `hud.removeBoot()`) never even gets reached. Never again: whatever
  // happens before `poll()`, the boot screen comes down and the reason is on screen, not silent.
  try {
    applyPlanet()
  } catch (err) {
    console.error('tower-city: applyPlanet failed at boot', err)
    hud.toast(err.message || 'Could not set up the world', 'err')
  }

  try {
    await poll()
  } finally {
    hud.removeBoot()
  }
  setInterval(() => { if (!document.hidden) poll() }, POLL_MS)
  window.addEventListener('focus', poll)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll()
  })

  hud.hint('Drag to rotate · right-click drag to pan · click an astronaut · switch projects in the sidebar', 6200)
}

// ── settings plumbing ────────────────────────────────────────────────────────────────

settings.onChange((changed, scope) => {
  state.settings = { ...settings.values }
  queueSave()
  if (scope.render || changed.has('fov')) engine.applySettings()
  if (changed.has('planet')) applyPlanet()
  if (changed.has('showFps')) hud.syncSettings()
  if (changed.has('followSelected')) rig.setFollow(settings.get('followSelected') ? colony.agentFor(selectedId) : null)
  if (changed.has('maxAgents')) refreshCurrentProject()
  // Missed entirely at first — the original app forwards every settings change to the colony
  // (time of day, shadows, stars, fauna tier, …); without this, moving the time-of-day slider
  // or pressing L changed the *setting* but the sky never heard about it.
  colony.onSettingsChanged(changed, scope)
})

// ── frame ────────────────────────────────────────────────────────────────────────────

engine.add({
  // The engine's own frame loop (`Engine._loop` in core/engine.js) has no try/catch around its
  // updaters — an uncaught throw here doesn't just skip a frame, it kills `requestAnimationFrame`
  // for good, since nothing schedules the next one. That reads as "the screen went black" after
  // whatever last rendered (a few astronauts walking in, say), not as an error dialog — there
  // isn't one. Everything below is wrapped for exactly that reason.
  update(dt, elapsed) {
    try {
      rig.setFollow(settings.get('followSelected') ? colony.agentFor(selectedId) : null)
      rig.update(dt)
      setCurveView(rig.target, rig.azimuth, settings.get('worldCurve') * CURVE_FULL)
      colony.update(dt, elapsed, rig.target)
      engine.setFocusDistance(rig.distance)

      if (selectedId) {
        hud.updateAvatar(colony.astronauts.faceTexture.image)
        const agent = colony.agentFor(selectedId)
        if (!agent) select(null, {})
        else hud.placeCard(screenOf(agent))
      }
      hud.setFps(engine.perf, engine.viewport, `${colony.astronauts.visibleCount} crew`)
    } catch (err) {
      console.error('tower-city: frame update failed', err)
    }
  },
})

engine.start()
boot()

window.towerCity = { engine, rig, colony, settings, hud, poll, get threads() { return threads } }

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return copyFallback(text)
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '')
    reader.onerror = () => reject(reader.error || new Error('Could not read that file'))
    reader.readAsDataURL(file)
  })
}

function toPngBlob(file) {
  if (file.type === 'image/png') return Promise.resolve(file)
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d').drawImage(img, 0, 0)
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode that image'))), 'image/png')
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read that image'))
    }
    img.src = url
  })
}

function copyFallback(text) {
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.cssText = 'position:fixed;top:0;opacity:0;pointer-events:none'
  document.body.appendChild(el)
  el.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  el.remove()
  return ok
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
