import { PRESETS, PLANETS_ORDER } from './hud-data.js'
import { PLANETS } from '../world/planet.js'
import { TIMES, systemTimeOfDay } from '../world/sky.js'
import { STATUS_LABEL } from '../game/colony.js'
import { FACE, FRAME_COLS, FRAME_ROWS } from '../agents/faces.js'
import { PLOT_PALETTE, hashString } from '../world/plots.js'

/**
 * The whole HUD, in plain DOM.
 *
 * Deliberately not a framework: this sits on top of a render loop that must not miss a
 * frame, so the UI only ever touches the DOM when something it shows has actually changed —
 * every setter compares against the last value it wrote and returns early otherwise.
 *
 * The one hard rule is that all of this is optional. Pressing H hides every panel, and the
 * game stays fully readable because status lives above the astronauts' heads in the scene,
 * not in here.
 */

/**
 * The page only ever runs on the machine the server is on — it answers nothing else — so the
 * browser's OS is the server's OS, and the name of the thing that shows a folder can be read
 * here rather than asked for.
 */
const IS_MAC = /Mac/.test(navigator.platform)
const FILE_MANAGER = IS_MAC ? 'Finder' : /Win/.test(navigator.platform) ? 'Explorer' : 'Files'

const ICON = {
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19M6.6 6.6C4.06 8.2 2 11 2 11s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24M2 2l20 20"/></svg>`,
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M9.5 20v-6h5v6"/></svg>`,
  next: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/></svg>`,
  camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 8.5h3.2l1.5-2h8.6l1.5 2H21v11H3z"/><circle cx="12" cy="14" r="3.4"/></svg>`,
  help: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.6v.4"/><path d="M12 17h.01"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 20h12"/><path d="M12 16V4M7.5 8.5 12 4l4.5 4.5"/></svg>`,
  open: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18v3H3z"/><path d="M5 9v10h14V9"/><path d="M10 13h4"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11.7a8 8 0 0 1-8.5 8 9.3 9.3 0 0 1-2.7-.4L4.5 21l1.4-4.1a7.9 7.9 0 0 1-2.4-5.7A8 8 0 0 1 12 3.6a8 8 0 0 1 8.5 8.1z"/><path d="M12 8.6v5.4M9.3 11.3h5.4"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.4A1.4 1.4 0 0 1 4.4 6h4.2l2 2.5h7A1.4 1.4 0 0 1 19 9.9v7.7a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 17.6z"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`,
  locate: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.6"/><path d="M12 1.8v2.6M12 19.6v2.6M1.8 12h2.6M19.6 12h2.6"/></svg>`,
  orbit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="10.2" ry="4.6" transform="rotate(-24 12 12)"/><circle cx="21" cy="8.2" r="1.5" fill="currentColor" stroke="none"/></svg>`,
  sound: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a8 8 0 0 1 0 11"/></svg>`,
  soundOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>`,
}

const STAT_DEFS = [
  { key: 'working', label: 'building', cls: 'working' },
  { key: 'waiting', label: 'need you', cls: 'waiting' },
  { key: 'blocked', label: 'blocked', cls: 'blocked' },
  { key: 'celebrating', label: 'shipped', cls: 'done' },
  { key: 'agents', label: 'crew', cls: 'idle' },
]

export class Hud {
  constructor(root, settings, actions) {
    this.settings = settings
    this.actions = actions
    this.visible = true
    this._last = {}
    this.hiddenOpen = false
    this.skillsOpen = false
    this.contextOpen = false
    this.contextEditing = false
    this._context = { exists: false, content: '', revision: null }

    this.el = document.createElement('div')
    this.el.className = 'hud'
    this.el.innerHTML = TEMPLATE
    root.appendChild(this.el)

    this.$ = (sel) => this.el.querySelector(sel)

    this._buildStats()
    this._buildSettings()
    this._buildAvatar()
    this._wire()
    this.$('#btn-add-project').addEventListener('click', () => this.actions.addProject?.())
    this.syncSettings()
    // Read layout when panels resize/change, never in the animation loop.
    this._layoutObserver = new ResizeObserver(() => this._syncLayout())
    this._layoutObserver.observe(this.el)
    this._layoutObserver.observe(this.$('.side'))
    this._syncLayout()
  }

  // ── construction ────────────────────────────────────────────────────────────────────

  _buildStats() {
    const wrap = this.$('.stats')
    this.statEls = {}
    for (const def of STAT_DEFS) {
      const b = document.createElement('button')
      b.className = `stat ${def.cls}`
      b.type = 'button'
      b.dataset.key = def.key
      b.title = `Jump to the next ${def.label} astronaut`
      b.innerHTML = `<i class="pip"></i><span class="n">0</span><span class="lbl">${def.label}</span>`
      b.type = 'button'
      b.addEventListener('click', () => this.actions.focusStatus?.(def.key))
      wrap.appendChild(b)
      this.statEls[def.key] = b
    }
  }

  _buildSettings() {
    const body = this.$('.settings .body')
    const s = this.settings
    this.controls = []

    // Quality presets.
    body.appendChild(
      group(
        'Quality preset',
        chips(
          Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, title: p.hint })),
          () => s.get('preset'),
          (id) => s.applyPreset(id),
          this.controls
        )
      )
    )

    // Performance.
    const perf = group('Performance')
    perf.append(
      this._toggle('Battery saver', 'batterySaver', '24 fps while interacting, 12 when idle, 10 when unfocused. Keeps the colony moving and caps high-density resolution. Hidden tabs pause.'),
      this._toggle('HDR + bloom', 'bloom', 'Glowing eyes, lamps and windows. The first thing to drop.'),
      this._toggle('Tilt-shift', 'tiltShift', 'A shallow depth of field, which is what makes the colony read as a model.'),
      this._slider(
        'Tilt-shift blur',
        'tiltShiftStrength',
        0,
        1,
        0.05,
        (v) => `${Math.round(v * 100)}%`,
        'Aperture: how shallow the focus is, and how far out of it things go.'
      ),
      this._slider(
        'Tilt-shift angle',
        'tiltShiftAngle',
        -90,
        90,
        1,
        (v) => `${v}°`,
        'Swings the plane of focus, the way tilting a real lens does.'
      ),
      this._select('Shadows', 'shadows', [
        ['off', 'Off'],
        ['low', 'Low'],
        ['high', 'High'],
        ['ultra', 'Ultra'],
      ]),
      this._select('Particles', 'particles', [
        ['off', 'Off'],
        ['low', 'Low'],
        ['full', 'Full'],
      ]),
      this._select('Textures', 'textureQuality', [
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
        ['ultra', 'Ultra'],
      ]),
      this._select('Ground detail', 'groundDetail', [
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
      ]),
      this._toggle('Anti-aliasing', 'antialias', 'SMAA pass. Cheap, but not free.'),
      this._slider(
        'Render scale',
        'renderScale',
        0.35,
        2,
        0.05,
        (v) => `${Math.round(v * 100)}%`,
        '100% is your display’s own resolution, retina included.'
      ),
      this._toggle('Adaptive quality', 'autoQuality', 'Quietly drops render scale if frames get expensive.'),
      this._slider('Scatter', 'scatterDensity', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this._slider('Max crew', 'maxAgents', 10, 200, 10, (v) => String(v)),
      this._toggle('Stars', 'stars')
    )
    body.appendChild(perf)

    // World.
    const world = group('Planet')
    const planets = document.createElement('div')
    planets.className = 'planets'
    for (const id of PLANETS_ORDER) {
      const planet = PLANETS[id]
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'planet'
      b.title = planet.blurb
      const c1 = hex(planet.ground.high)
      const c2 = hex(planet.ground.low)
      b.innerHTML = `<i class="orb" style="background:radial-gradient(circle at 33% 30%, ${c1}, ${c2})"></i><span>${planet.name}</span>`
      b.addEventListener('click', () => this.settings.set('planet', id))
      planets.appendChild(b)
      this.controls.push({ el: b, sync: () => b.setAttribute('aria-pressed', String(this.settings.get('planet') === id)) })
    }
    world.appendChild(planets)
    body.appendChild(world)

    // Lighting.
    const light = group('Lighting')
    light.append(
      chips(
        // `Live` is a time of day like the others from where you are standing, so it belongs
        // in the same row rather than in a toggle further down.
        [...TIMES.map((t) => ({ id: t.id, label: t.label })), { id: 'live', label: 'Live' }],
        () => (this.settings.get('clockTime') ? 'live' : nearestTime(this.settings.get('timeOfDay'))),
        (id) => {
          this.settings.set('autoTime', false)
          this.settings.set('clockTime', id === 'live')
          if (id === 'live') this.settings.set('timeOfDay', systemTimeOfDay())
          else this.settings.set('timeOfDay', TIMES.find((t) => t.id === id).value)
        },
        this.controls
      ),
      this._slider('Time of day', 'timeOfDay', 0, 1, 0.005, clockLabel, undefined, () => {
        // Reaching for the slider is a request for a particular light, so stop following the
        // clock — otherwise the next frame would drag the thumb straight back.
        this.settings.set('clockTime', false)
      }),
      this._toggle(
        'Cycle day/night',
        'autoTime',
        'Runs the clock forward on its own. Ignored while the sky is following this machine’s clock.'
      ),
      this._slider('Cycle length', 'dayLength', 30, 900, 30, (v) => `${Math.round(v / 60)}m`),
      this._toggle(
        'Environment light',
        'ibl',
        'Image-based lighting taken from this planet’s own sky. Metals get something to reflect.'
      ),
      this._slider('Environment', 'iblIntensity', 0, 2, 0.05, (v) => v.toFixed(2)),
      this._slider('Exposure', 'exposure', 0.4, 2, 0.05, (v) => v.toFixed(2)),
      this._slider('Bloom', 'bloomStrength', 0, 1.6, 0.02, (v) => v.toFixed(2))
    )
    body.appendChild(light)

    // View.
    const view = group('View')
    view.append(
      this._toggle(
        'Hide dormant repos',
        'hideDormant',
        'Takes a repo off the map when every thread in it has been quiet for three days. Its threads are untouched, and it comes back to the same ground the moment one wakes up.'
      )
    )
    view.append(
      this._toggle('Follow selected agent', 'followSelected', 'Tracks the selected agent until you deselect. Drag to pan, right-drag to orbit, and scroll to zoom.'),
      this._toggle('Return to isometric', 'autoFrame', 'Eases the angle back when you stop dragging.'),
      this._slider('Field of view', 'fov', 20, 60, 1, (v) => `${v}°`),
      this._toggle('Project labels', 'showLabels'),
      this._toggle('Reduced motion', 'reducedMotion', 'Calms the bobbing and the camera easing.'),
      this._toggle('Show FPS', 'showFps')
    )
    body.appendChild(view)

    // Look.
    const look = group('Look')
    look.append(
      this._slider(
        'Ambient occlusion',
        'ambientOcclusion',
        0,
        1,
        0.05,
        (v) => v === 0 ? 'Off' : `${Math.round(v * 100)}%`,
        'Soft shading in creases and where surfaces meet. Try 20–35% for a subtle effect; 0 turns it off.'
      ),
      this._slider(
        'World curve',
        'worldCurve',
        0,
        1,
        0.05,
        (v) => `${Math.round(v * 100)}%`,
        'How far the ground bends away toward the horizon. The point under the cursor never moves.'
      ),
      this._toggle('Colour grade', 'colorGrade', 'Saturation, warmth, lifted shadows and a soft vignette on the finished frame.'),
      this._slider('Saturation', 'saturation', 0.6, 1.5, 0.05, (v) => v.toFixed(2)),
      this._slider('Vignette', 'vignette', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this._toggle('Clouds', 'clouds', 'Cumulus drifting over worlds that have weather.'),
      this._select('Wildlife', 'fauna', [
        ['off', 'Off'],
        ['low', 'Some'],
        ['full', 'Full'],
      ])
    )
    body.appendChild(look)

    // Sound.
    const sound = group('Sound')
    sound.append(
      this._toggle(
        'Ambient sound',
        'sound',
        'A bed for each world, things calling out on their own clocks, and work you can hear where it is happening. Louder as you lean in.'
      ),
      this._slider('Master', 'masterVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this._slider('Ambience', 'ambienceVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, 'Beds and the sounds of the world.'),
      this._slider('Effects', 'effectsVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, 'Hammering, drones, splashes, the chime when somebody needs you.')
    )
    body.appendChild(sound)
  }

  _row(label, hint) {
    const row = document.createElement('div')
    row.className = 'row'
    const l = document.createElement('div')
    l.className = 'label'
    l.innerHTML = `<span>${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}`
    row.appendChild(l)
    return row
  }

  _toggle(label, key, hint) {
    const row = this._row(label, hint)
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'toggle'
    b.setAttribute('role', 'switch')
    b.setAttribute('aria-label', label)
    b.addEventListener('click', () => this.settings.set(key, !this.settings.get(key)))
    row.appendChild(b)
    this.controls.push({
      el: row,
      sync: () => {
        b.setAttribute('aria-checked', String(Boolean(this.settings.get(key))))
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  _select(label, key, options, hint) {
    const row = this._row(label, hint)
    const sel = document.createElement('select')
    sel.className = 'select'
    for (const [value, text] of options) {
      const o = document.createElement('option')
      o.value = value
      o.textContent = text
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => this.settings.set(key, sel.value))
    row.appendChild(sel)
    this.controls.push({
      el: row,
      sync: () => {
        sel.value = String(this.settings.get(key))
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  _slider(label, key, min, max, step, format, hint, onInput) {
    const row = this._row(label, hint)
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px'
    const input = document.createElement('input')
    input.type = 'range'
    input.setAttribute('aria-label', label)
    input.className = 'slider'
    input.min = min
    input.max = max
    input.step = step
    const out = document.createElement('span')
    out.className = 'value'
    input.addEventListener('input', () => {
      onInput?.()
      this.settings.set(key, Number(input.value))
    })
    wrap.append(input, out)
    row.appendChild(wrap)
    this.controls.push({
      el: row,
      sync: () => {
        const v = Number(this.settings.get(key))
        // Never fight the thumb the user is dragging.
        if (document.activeElement !== input) input.value = String(v)
        out.textContent = format(v)
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  /** The little face on the agent card, drawn from the same atlas the astronauts use. */
  _buildAvatar() {
    const canvas = this.$('.thread-pop .avatar canvas')
    canvas.width = 108
    canvas.height = 108
    this.avatarCtx = canvas.getContext('2d')
    this.avatarTmp = document.createElement('canvas')
    this.avatarTmp.width = 108
    this.avatarTmp.height = 108
    this.avatarTmpCtx = this.avatarTmp.getContext('2d')
    this._avatarState = { frame: -1, color: '' }
  }

  _wire() {
    const on = (sel, ev, fn) => this.$(sel).addEventListener(ev, fn)

    on('#btn-settings', 'click', () => this.toggleSettings())
    // On a phone the sidebar is a sheet: a tap on its brand row (not on its buttons) pulls
    // it up or lets it drop, and a drag on the row does the same by direction.
    const brandbar = this.$('.side .brandbar')
    const grab = this.$('.side .grab')
    let dragY = null
    const startDrag = (e) => {
      if (!this.isPhone() || e.target.closest('.btn')) return
      dragY = e.clientY
    }
    const endDrag = (e) => {
      if (dragY === null) return
      const dy = e.clientY - dragY
      dragY = null
      if (Math.abs(dy) > 24) this.toggleSheet(dy < 0)
      else if (!e.target.closest('.btn')) this.toggleSheet()
    }
    for (const el of [brandbar, grab]) {
      el.addEventListener('pointerdown', startDrag)
      el.addEventListener('pointerup', endDrag)
    }
    on('#btn-close-settings', 'click', () => this.toggleSettings(false))
    on('#btn-hide', 'click', () => this.toggleUi())
    on('#btn-help', 'click', () => this.toggleHelp())
    on('#btn-shot', 'click', () => this.actions.screenshot?.())
    on('#btn-convert', 'click', () => this.$('#file-convert').click())
    on('#file-convert', 'change', (e) => {
      const file = e.target.files[0]
      e.target.value = '' // so picking the same file twice still fires 'change'
      if (file) this.actions.convertToMarkdown?.(file)
    })
    on('#btn-home', 'click', () => this.actions.resetView?.())
    on('#btn-next', 'click', () => this.actions.focusStatus?.('waiting'))
    on('#btn-orbit', 'click', () => this.setOrbit(this.actions.toggleOrbit?.()))
    on('#btn-planet', 'click', () => this.actions.cyclePlanet?.())
    on('#btn-time', 'click', () => this.actions.cycleTime?.())
    on('#btn-sound', 'click', () => this.settings.set('sound', !this.settings.get('sound')))
    on('#btn-open', 'click', () => this.actions.openThread?.())
    on('#btn-viewed', 'click', () => this.actions.markViewed?.())
    on('#btn-archive', 'click', () => this.actions.archiveThread?.())
    on('#btn-deselect', 'click', () => this.actions.select?.(null))
    on('#btn-follow', 'click', () => this.settings.set('followSelected', !this.settings.get('followSelected')))
    on('#btn-new-session', 'click', () => this.actions.newConversation?.())
    on('#btn-reveal', 'click', () => this.actions.revealProject?.())
    on('#btn-vscode', 'click', () => this.actions.openProjectInEditor?.())
    on('#btn-copy-path', 'click', () => this.actions.copyProjectPath?.())
    on('#btn-hide-project', 'click', () => this.actions.hideProject?.())
    on('#btn-hidden-toggle', 'click', () => this.toggleHiddenList())
    on('#btn-skills-toggle', 'click', () => this.toggleSkillsList())
    on('#btn-skills-browse', 'click', () => this._openSkillRegistry())
    on('#btn-registry-close', 'click', () => this._closeSkillRegistry())
    this.$('.registry-add').addEventListener('submit', (e) => {
      e.preventDefault()
      this._submitAddMarketplace()
    })
    on('#input-skill-search', 'input', (e) => this._filterRegistry(e.target.value))
    on('.registry', 'click', (e) => {
      if (e.target === this.$('.registry')) this._closeSkillRegistry()
    })
    this.$('.registry .sheet').addEventListener('click', (e) => e.stopPropagation())
    on('#btn-context-toggle', 'click', () => this.toggleContext())
    on('#btn-context-edit', 'click', () => this._startContextEdit())
    on('#btn-context-create', 'click', () => this._startContextEdit())
    on('#btn-context-cancel', 'click', () => this._cancelContextEdit())
    on('#btn-context-save', 'click', () => this._saveContextEdit())
    on('#btn-locate', 'click', () => this.actions.focusProject?.(this.project?.name))
    on('#btn-close-project', 'click', () => this.actions.closeProject?.())
    on('.help', 'click', (e) => {
      if (e.target === this.$('.help')) this.toggleHelp(false)
    })
    this.$('.help .sheet').addEventListener('click', (e) => e.stopPropagation())
    on('#btn-help-close', 'click', () => this.toggleHelp(false))

    // The menu itself never gets a click-through-to-dismiss handler — outside clicks are
    // caught at the document level instead, in pickHarness, since "outside" has to include
    // the anchor button that opened it and every other panel behind the menu alike.
    this.$('.picker-menu').addEventListener('click', (e) => e.stopPropagation())

    this.settings.onChange(() => this.syncSettings())
  }

  // ── state in ────────────────────────────────────────────────────────────────────────

  syncSettings() {
    const follow = Boolean(this.settings.get('followSelected'))
    this.$('#btn-follow').setAttribute('aria-pressed', String(follow))
    this.$('#btn-follow').title = follow ? 'Stop following selected agent' : 'Follow selected agent'
    for (const c of this.controls) c.sync()
    this.$('.fps').classList.toggle('on', Boolean(this.settings.get('showFps')))
    const sound = Boolean(this.settings.get('sound'))
    const btn = this.$('#btn-sound')
    btn.innerHTML = sound ? ICON.sound : ICON.soundOff
    btn.setAttribute('aria-pressed', String(sound))
    btn.title = sound ? 'Mute (M)' : 'Unmute (M)'
  }

  setStats(stats) {
    for (const def of STAT_DEFS) {
      const n = stats[def.key] ?? 0
      const el = this.statEls[def.key]
      if (this._last['stat:' + def.key] === n) continue
      this._last['stat:' + def.key] = n
      el.querySelector('.n').textContent = String(n)
      el.dataset.empty = String(n === 0)
    }
  }

  /**
   * Every repo, in the sidebar. This was a strip of chips along the bottom of the screen;
   * it is a list now because the sidebar is where all the chrome lives, and because a list
   * can carry a count and an alarm without running out of room at eleven repos.
   */
  setLegend(projects, activeName = null, hidden = [], folded = []) {
    const signature =
      projects.map((p) => `${p.name}:${p.count}:${p.accent}:${p.urgent ? 1 : 0}`).join('|') +
      `~${activeName}~` +
      hidden.map((p) => `${p.name}:${p.count}`).join('|') +
      `~${folded.length}`
    if (this._last.legend === signature) return
    this._last.legend = signature

    const wrap = this.$('.projects')
    wrap.innerHTML = ''
    for (const p of projects) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'repo'
      b.title = `${p.count} thread${p.count === 1 ? '' : 's'} in ${p.name}`
      b.setAttribute('aria-pressed', String(p.name === activeName))
      b.innerHTML =
        `<i class="swatch" style="background:${hex(p.accent)};color:${hex(p.accent)}"></i>` +
        `<span class="n">${escapeHtml(p.name)}</span>` +
        (p.urgent ? '<i class="alarm"></i>' : '') +
        `<span class="count">${p.count}</span>`
      b.addEventListener('click', () => this.actions.pickProject?.(p.name))
      wrap.appendChild(b)
    }
    this.$('.sec-head span').textContent = `${projects.length} repo${projects.length === 1 ? '' : 's'}`

    // The hidden list is its own block at the foot of the sidebar: collapsed by default, because
    // the whole point of hiding a repo is not to look at it.
    const block = this.$('.hidden-block')
    block.hidden = hidden.length === 0 && folded.length === 0
    const hiddenWrap = this.$('.hidden-projects')
    hiddenWrap.innerHTML = ''
    for (const p of hidden) {
      const accent = PLOT_PALETTE[hashString(p.name) % PLOT_PALETTE.length]
      const row = document.createElement('div')
      row.className = 'repo hidden-repo'
      row.innerHTML =
        `<i class="swatch" style="background:${hex(accent)};color:${hex(accent)}"></i>` +
        `<span class="n">${escapeHtml(p.name)}</span>` +
        `<span class="count">${p.count}</span>`
      const show = document.createElement('button')
      show.type = 'button'
      show.className = 'btn ghost show-repo'
      show.title = `Show ${p.name} on the map again`
      show.textContent = 'Show'
      show.addEventListener('click', () => this.actions.unhideProject?.(p.name))
      row.appendChild(show)
      hiddenWrap.appendChild(row)
    }

    // The dormant fold gets one line rather than a row each: it is a setting, not a list of
    // decisions, and the thing worth offering is the way back rather than per-repo control.
    if (folded.length) {
      const n = folded.reduce((sum, p) => sum + p.count, 0)
      const row = document.createElement('div')
      row.className = 'repo hidden-repo folded-note'
      row.innerHTML =
        `<span class="n">${folded.length} quiet repo${folded.length === 1 ? '' : 's'}` +
        `, ${n} thread${n === 1 ? '' : 's'}</span>`
      const show = document.createElement('button')
      show.type = 'button'
      show.className = 'btn ghost show-repo'
      show.title = 'Put dormant repos back on the map'
      show.textContent = 'Show'
      show.addEventListener('click', () => this.settings.set('hideDormant', false))
      row.appendChild(show)
      hiddenWrap.appendChild(row)
    }

    const total = hidden.length + folded.length
    this.$('#btn-hidden-toggle .label').textContent = `${total} off the map`
    this._syncHiddenList()
  }

  toggleHiddenList() {
    this.hiddenOpen = !this.hiddenOpen
    this._syncHiddenList()
  }

  _syncHiddenList() {
    this.$('#btn-hidden-toggle').setAttribute('aria-expanded', String(this.hiddenOpen))
    this.$('.hidden-projects').hidden = !this.hiddenOpen
  }

  /**
   * The project sidebar: what a zone is, and the things you can do to the *repo* rather
   * than to one thread in it. Opened by clicking a zone, its name plate, its legend chip,
   * or any astronaut standing on it.
   */
  setProject(project) {
    const panel = this.$('.side')
    if (!project) {
      this.project = null
      if (this._last.project === null) return
      this._last.project = null
      panel.classList.remove('drilled')
      panel.classList.remove('open')
      this._syncLayout()
      return
    }

    this.project = project
    // On a phone, opening a repo pulls the sheet up so its threads are in view — unless an
    // astronaut was just picked, whose card wants the room above the sheet's peek.
    if (this.isPhone() && !this.selected && !panel.classList.contains('open')) {
      panel.classList.add('open')
      this._syncLayout()
    }
    // The minute is part of the signature because `ago()` is: without it a repo where
    // nothing is happening keeps whatever "4m ago" it was first drawn with, for as long as
    // you leave the panel open.
    const signature =
      `${project.name}~${project.path}~${project.accent}~${project.selectedId}~${Math.floor(Date.now() / 60000)}~` +
      project.threads.map((t) => `${t.id}:${t.status}:${t.title}:${t.lastActivityAt}`).join('|')
    panel.classList.add('drilled')
    if (this._last.project === signature) return
    this._last.project = signature

    const swatch = this.$('.side .who .swatch')
    swatch.style.background = hex(project.accent)
    swatch.style.color = hex(project.accent) // the halo is `currentColor`
    this.$('.side .name').textContent = project.name
    const path = this.$('.side .path')
    path.textContent = project.path ? shortPath(project.path) : 'folder unknown'
    path.title = project.path || ''
    // Nothing to open a new thread in, and nothing to reveal, without a folder on disk.
    this.$('#btn-new-session').disabled = !project.path
    this.$('#btn-reveal').disabled = !project.path
    this.$('#btn-copy-path').disabled = !project.path
    this.$('#btn-vscode').disabled = !project.path

    const n = project.threads.length
    const waiting = project.threads.filter((t) => t.status === 'waiting' || t.status === 'blocked').length
    this.$('.side .threads-head').innerHTML =
      `<span>${n} thread${n === 1 ? '' : 's'}</span>` + (waiting ? `<span class="want">${waiting} need you</span>` : '')

    const list = this.$('.side .threads')
    // A poll rewrites these rows every time a live thread's timestamp moves. Losing your
    // place in a forty-thread repo every fifteen seconds would make the list unusable.
    const scroll = list.scrollTop
    list.innerHTML = ''
    for (const t of project.threads) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `thread ${statusClass(t.status)}`
      b.setAttribute('aria-pressed', String(t.id === project.selectedId))
      b.title = STATUS_LABEL[t.status] || t.status
      b.innerHTML =
        '<i class="pip"></i>' +
        `<span class="t">${escapeHtml(t.title || 'Untitled thread')}</span>` +
        `<span class="when">${ago(t.lastActivityAt)}</span>` +
        (t.worktree ? `<span class="wt">⑂ ${escapeHtml(t.worktree)}</span>` : '')
      b.addEventListener('click', () => this.actions.focusThread?.(t.id))
      list.appendChild(b)
      // A long repo can hide the astronaut you just clicked in the world. Scrolled by hand
      // rather than with `scrollIntoView`, which walks up the ancestors and will happily
      // scroll the *page* — and a page that can scroll at all is one keystroke away from
      // the whole HUD sitting sideways with nothing to put it back.
      if (t.id === project.selectedId && this._scrolledTo !== t.id) {
        this._scrolledTo = t.id
        const row = b
        requestAnimationFrame(() => {
          const top = row.offsetTop
          const bottom = top + row.offsetHeight
          if (top < list.scrollTop) list.scrollTop = top
          else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
        })
      }
    }
    list.scrollTop = scroll
    if (!project.selectedId) this._scrolledTo = null
  }

  /**
   * Which skills this project can see — its own `.claude/skills`/`.agents/skills` plus every
   * user-level one, fetched separately from `setProject` since it is a network round trip
   * main.js only bothers with when the selected project's path actually changes, not on every
   * poll. The section itself always shows, even at zero — "Browse" has to be reachable before a
   * project has any skills at all, not just after.
   */
  setSkills(list, trashed = []) {
    this._installedSkillNames = new Set(list.map((s) => s.name))
    // Full objects, not just names — so Browse can list a locally-authored skill (no marketplace
    // behind it at all, e.g. one dropped straight into `~/.claude/skills/`) alongside real
    // marketplace ones, instead of it only ever being visible in the sidebar.
    this._installedSkillsFull = list
    this.$('#btn-skills-toggle .label').textContent = `${list.length} skill${list.length === 1 ? '' : 's'}`
    const container = this.$('.skills-list')
    container.innerHTML = ''
    for (const skill of list) {
      const row = document.createElement('div')
      row.className = 'skill-row'
      row.title = skill.description || ''
      // A use count only when there is one — a page full of "0 uses" is noise, not signal.
      const uses = skill.uses > 0 ? `<span class="uses">${skill.uses}×</span>` : ''
      const label = document.createElement('span')
      label.className = 'row-label'
      label.innerHTML = `<span class="n">${escapeHtml(skill.name)}</span>${uses}`
      row.appendChild(label)

      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'skill-delete'
      del.title = skill.scope === 'user' ? 'Remove (every project, not just this one)' : 'Remove from this project'
      del.textContent = '×'
      del.addEventListener('click', async (e) => {
        e.stopPropagation()
        const warning =
          skill.scope === 'user'
            ? `Remove "${skill.name}"? It's a user-level skill — this deletes it for every project, not just this one.`
            : `Remove "${skill.name}" from this project?`
        if (!confirm(warning)) return
        del.disabled = true
        try {
          await this.actions.deleteSkill?.(skill.name, skill.scope)
        } catch (err) {
          del.disabled = false
          this.toast(err.message || 'Could not remove that skill', 'err')
        }
      })
      row.appendChild(del)
      container.appendChild(row)
    }

    // Only shown when there's actually something to restore — a skill removed here always has a
    // way back, marketplace-backed or not, since a delete moves its folder into `.trash` rather
    // than deleting it outright.
    if (trashed.length) {
      const heading = document.createElement('div')
      heading.className = 'skills-trash-title'
      heading.textContent = `Removed (${trashed.length})`
      container.appendChild(heading)

      for (const skill of trashed) {
        const row = document.createElement('div')
        row.className = 'skill-row trashed'
        row.title = skill.description || ''
        const label = document.createElement('span')
        label.className = 'row-label'
        label.innerHTML = `<span class="n">${escapeHtml(skill.name)}</span>`
        row.appendChild(label)

        const restore = document.createElement('button')
        restore.type = 'button'
        restore.className = 'btn ghost skill-restore'
        restore.textContent = 'Restore'
        restore.addEventListener('click', async (e) => {
          e.stopPropagation()
          restore.disabled = true
          restore.textContent = 'Restoring…'
          try {
            await this.actions.restoreSkill?.(skill.name, skill.scope)
          } catch (err) {
            restore.disabled = false
            restore.textContent = 'Restore'
            this.toast(err.message || 'Could not restore that skill', 'err')
          }
        })
        row.appendChild(restore)
        container.appendChild(row)
      }
    }
  }

  /** The marketplace skill browser — a full modal, not the small dropdown `.picker` is, since a
   * scrollable list of twenty-plus entries needs the room. */
  async _openSkillRegistry() {
    this.$('.registry').classList.add('open')
    this.$('#input-skill-search').value = ''
    const list = this.$('.registry-list')
    list.innerHTML = '<div class="registry-empty">Loading…</div>'
    try {
      const skills = await this.actions.fetchSkillRegistry?.()
      this._setRegistrySkills(skills || [])
    } catch (err) {
      list.innerHTML = `<div class="registry-empty">${escapeHtml(err.message || 'Could not load the registry')}</div>`
    }
  }

  _closeSkillRegistry() {
    this.$('.registry').classList.remove('open')
  }

  /**
   * Caches the full registry so search can re-filter it without a refetch, then renders through
   * whatever's currently typed in the search box — a fresh add/reload shouldn't silently discard
   * an in-progress search.
   */
  _setRegistrySkills(skills) {
    // A locally-authored skill (no marketplace behind it — dropped straight into
    // `~/.claude/skills/` or `.claude/skills/` by hand) has no place in a registry scan at all,
    // but showing it only in the sidebar and never here was the wrong call: browsing "what skills
    // exist" should mean all of them, not just the ones a marketplace happens to know about.
    // Folded in under a synthetic "On this machine" group, keyed off whatever the sidebar's own
    // last fetch already has — already-installed either way, so the existing `installed.has(...)`
    // check in `_renderRegistry` marks it "Installed" with no special-casing needed.
    const known = new Set(skills.map((s) => s.name))
    const local = (this._installedSkillsFull || [])
      .filter((s) => !known.has(s.name))
      .map((s) => ({
        marketplace: 'On this machine',
        plugin: s.scope === 'user' ? 'every project' : 'this project',
        name: s.name,
        description: s.description,
      }))
    this._registrySkills = [...skills, ...local]
    this._filterRegistry(this.$('#input-skill-search')?.value || '')
  }

  /**
   * With 58 real skills across four marketplaces, "just named evaluation" was a real complaint —
   * grouping by marketplace and letting a name search narrow it down both aim at the same thing:
   * you shouldn't have to read a flat alphabetical list to find or place a skill.
   */
  _filterRegistry(query) {
    const all = this._registrySkills || []
    const q = query.trim().toLowerCase()
    const filtered = !q
      ? all
      : all.filter((s) =>
          [s.name, s.marketplace, s.plugin, s.description].some((f) => (f || '').toLowerCase().includes(q))
        )
    const emptyMessage = all.length
      ? `No skills match "${escapeHtml(query.trim())}".`
      : 'No marketplace skills found. Add a marketplace with Claude Code\'s <code>/plugin marketplace add</code> first.'
    // A search result sitting inside a group the user left collapsed would be invisible — force
    // every group open while there's a query, and let collapse state resume once it's cleared.
    this._renderRegistry(filtered, emptyMessage, { forceExpanded: !!q })
  }

  _toggleRegistryGroup(marketplace) {
    if (!this._openRegistryGroups) this._openRegistryGroups = new Set()
    if (this._openRegistryGroups.has(marketplace)) this._openRegistryGroups.delete(marketplace)
    else this._openRegistryGroups.add(marketplace)
    this._filterRegistry(this.$('#input-skill-search')?.value || '')
  }

  /**
   * Adds a marketplace nobody's configured here yet — a name, URL, or `owner/repo` the user found
   * and typed in, not just the ones already known when the server started. Runs Claude Code's own
   * `claude plugin marketplace add` server-side (see `addMarketplace` in `server/api.mjs`); on
   * success the response already carries the freshly-rescanned registry, so this repaints the list
   * in place rather than issuing a second fetch.
   */
  async _submitAddMarketplace() {
    const input = this.$('#input-marketplace')
    const btn = this.$('#btn-marketplace-add')
    const errBox = this.$('#marketplace-add-error')
    const source = input.value.trim()
    if (!source) return
    errBox.hidden = true
    btn.disabled = true
    btn.textContent = 'Adding…'
    try {
      const skills = await this.actions.addMarketplace?.(source)
      input.value = ''
      this._setRegistrySkills(skills || [])
    } catch (err) {
      errBox.textContent = err.message || 'Could not add that marketplace'
      errBox.hidden = false
    } finally {
      btn.disabled = false
      btn.textContent = 'Add'
    }
  }

  /**
   * Grouped by marketplace — a flat alphabetical list of 78 skills made an entry like "evaluation"
   * unreadable without hunting for the small `.src` label. The marketplace is now a section
   * heading instead, so each row's own label switches to the plugin it came from, which is the
   * more useful of the two once the marketplace is no longer ambiguous.
   *
   * Collapsed by default (`_openRegistryGroups` starts empty, so every group reads as closed
   * until clicked) — with five marketplaces and 78 skills, showing every row up front is the same
   * wall of text grouping was meant to fix. `forceExpanded` overrides that while a search is
   * active, so a match hiding inside a collapsed group isn't invisible.
   */
  _renderRegistry(skills, emptyMessage, { forceExpanded = false } = {}) {
    const list = this.$('.registry-list')
    list.innerHTML = ''
    if (!skills.length) {
      list.innerHTML = `<div class="registry-empty">${emptyMessage || 'No skills found.'}</div>`
      return
    }
    const installed = this._installedSkillNames || new Set()
    const groups = new Map()
    for (const skill of skills) {
      if (!groups.has(skill.marketplace)) groups.set(skill.marketplace, [])
      groups.get(skill.marketplace).push(skill)
    }
    for (const [marketplace, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const open = forceExpanded || this._openRegistryGroups?.has(marketplace)
      const heading = document.createElement('button')
      heading.type = 'button'
      heading.className = 'registry-group-title'
      heading.setAttribute('aria-expanded', String(open))
      heading.innerHTML =
        `<span class="caret">${open ? '▾' : '▸'}</span>${escapeHtml(marketplace)} <span class="count">(${items.length})</span>`
      heading.addEventListener('click', () => this._toggleRegistryGroup(marketplace))
      list.appendChild(heading)
      if (!open) continue

      for (const skill of items) {
        const row = document.createElement('div')
        row.className = 'registry-row'
        const info = document.createElement('div')
        info.className = 'info'
        info.innerHTML =
          `<span class="n">${escapeHtml(skill.name)}</span><span class="src">${escapeHtml(skill.plugin)}</span>` +
          `<div class="d">${escapeHtml(skill.description || '')}</div>`
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'btn ghost'
        const already = installed.has(skill.name)
        btn.textContent = already ? 'Installed' : 'Install'
        btn.disabled = already
        btn.addEventListener('click', async () => {
          btn.disabled = true
          btn.textContent = 'Installing…'
          try {
            await this.actions.installSkill?.(skill.marketplace, skill.plugin, skill.name)
            btn.textContent = 'Installed'
            this._installedSkillNames?.add(skill.name)
          } catch (err) {
            btn.textContent = 'Install'
            btn.disabled = false
            this.toast(err.message || 'Could not install that skill', 'err')
          }
        })
        row.append(info, btn)
        list.appendChild(row)
      }
    }
  }

  toggleSkillsList() {
    this.skillsOpen = !this.skillsOpen
    this.$('#btn-skills-toggle').setAttribute('aria-expanded', String(this.skillsOpen))
    this.$('.skills-list').hidden = !this.skillsOpen
  }

  /**
   * The repo's `.agent-context.md` — same shared-notes file the SessionStart hook injects, and
   * the `saveContext` revision check protects against two tabs stepping on each other's edits.
   *
   * The section is shown even with no context yet, as a "+ Add project context" prompt — a repo
   * that has never opted in should still make it obvious it can.
   */
  setContext({ exists, content, revision }) {
    this._context = { exists, content: content || '', revision: revision ?? null }
    // A background refresh (main.js re-fetches on every poll now) must not clobber a draft the
    // user is midway through typing — the save-time revision check is what actually protects
    // the file on disk; this is only about not yanking the textarea out from under them.
    if (this.contextEditing) return
    this.$('#btn-context-edit').textContent = exists ? 'Edit' : 'Create'
    this.$('.context-body').textContent = content || ''
    this._renderContextState()
  }

  /** Which of the three context panels shows: create-prompt, read view, or the editor. */
  _renderContextState() {
    const { exists } = this._context
    this.$('#context-section').hidden = false
    this.$('.context-head').hidden = this.contextEditing || !exists
    this.$('#btn-context-create').hidden = this.contextEditing || exists
    this.$('.context-body').hidden = this.contextEditing || !exists || !this.contextOpen
    this.$('.context-editor').hidden = !this.contextEditing
  }

  toggleContext() {
    this.contextOpen = !this.contextOpen
    this.$('#btn-context-toggle').setAttribute('aria-expanded', String(this.contextOpen))
    this._renderContextState()
  }

  _startContextEdit() {
    this.contextEditing = true
    this.$('.context-textarea').value = this._context.content
    this.$('.context-error').textContent = ''
    this._renderContextState()
    this.$('.context-textarea').focus()
  }

  _cancelContextEdit() {
    this.contextEditing = false
    this._renderContextState()
  }

  /** Save is the actions object's job — it owns the network call and knows the project path. */
  async _saveContextEdit() {
    const content = this.$('.context-textarea').value
    const errEl = this.$('.context-error')
    errEl.textContent = ''
    this.$('#btn-context-save').disabled = true
    try {
      const result = await this.actions.saveContext?.(content, this._context.revision)
      this.contextEditing = false
      if (result) this.setContext(result)
      else this._renderContextState()
    } catch (err) {
      errEl.textContent = err.message || 'Could not save'
    } finally {
      this.$('#btn-context-save').disabled = false
    }
  }

  /**
   * The selected thread, shown inside the zone sidebar rather than in a panel of its own —
   * one thread and its repo are the same context, and splitting them across the screen made
   * you look in two places to act on one astronaut.
   */
  setSelection(agent, thread) {
    const card = this.$('.thread-pop')
    // Only ever one accent button in the panel: whichever action is the immediate one.
    this.$('#btn-new-session').classList.toggle('primary', !agent || !thread)
    if (!agent || !thread) {
      card.classList.remove('on')
      this.selected = null
      return
    }
    this.selected = { agent, thread }
    card.classList.add('on')
    // On a phone the card docks above the sheet's peek, so the sheet drops to make room.
    if (this.isPhone()) this.toggleSheet(false)

    this.$('.thread-pop .title').textContent = thread.title || 'Untitled thread'
    const status = STATUS_LABEL[agent.status] || agent.status
    const meta = this.$('.thread-pop .meta')
    const bits = [
      `<span class="tag"><i class="swatch" style="background:${hex(agent.trim.getHex())}"></i>${escapeHtml(status)}</span>`,
    ]
    // The repo is the panel's own heading now, so the card says what the *thread* is —
    // starting with whose it is, since that decides what Open can do.
    if (thread.harnessName) bits.push(`<span class="tag">${escapeHtml(thread.harnessName)}</span>`)
    if (thread.worktree) bits.push(`<span class="tag">⑂ ${escapeHtml(thread.worktree)}</span>`)
    if (thread.gitBranch) bits.push(`<span class="tag">${escapeHtml(thread.gitBranch)}</span>`)
    if (thread.model) bits.push(`<span class="tag">${escapeHtml(shortModel(thread.model))}</span>`)
    bits.push(`<span>${ago(thread.lastActivityAt)}</span>`)
    meta.innerHTML = bits.join('')

    const pct = Math.round((this.actions.progressFor?.(thread.id) ?? 0) * 100)
    this.$('.thread-pop .progress > i').style.width = `${pct}%`
    this.$('.thread-pop .progress > i').style.background = hex(agent.trim.getHex())
    // Measured once per selection rather than per frame: placing the card beside its
    // astronaut needs its size sixty times a second, and asking the layout for it that
    // often is how a HUD starts costing frames.
    this._cardSize = { w: card.offsetWidth, h: card.offsetHeight }
    this.$('#btn-open').disabled = thread.canOpen === false
    // Only offered when there is something to dismiss. A third button on every card would
    // crowd the two that are always worth having, and "Viewed" on a thread that is not asking
    // for anything is a control with no effect.
    this.$('#btn-viewed').hidden = !thread.unread
  }

  /**
   * Put the thread card beside its own astronaut, in screen space, every frame.
   *
   * `screen` is where the astronaut is right now, in CSS pixels, or null when it is behind
   * the camera. The card prefers the astronaut's right, flips to its left rather than slide
   * under the sidebar, and never leaves the window — so it stays reachable at any zoom
   * without ever covering the thing it is describing.
   */
  placeCard(screen) {
    const el = this.$('.thread-pop')
    if (!screen || !this.selected) {
      if (this._cardOn) {
        this._cardOn = false
        el.classList.remove('on')
      }
      return
    }
    // On a phone the card is docked above the sheet by the stylesheet; nothing to place.
    if (this.isPhone()) {
      if (!this._cardOn) {
        this._cardOn = true
        el.classList.add('on')
      }
      return
    }
    const size = this._cardSize || { w: 280, h: 150 }
    const margin = 12
    const gap = 26
    const rightWall = window.innerWidth - margin - (this._sideWidth || 0)

    let flip = false
    let left = screen.x + gap
    if (left + size.w > rightWall) {
      left = screen.x - gap - size.w
      flip = true
      // Nowhere to go on either side — sit over the middle rather than off the edge.
      if (left < margin) left = Math.min(Math.max(margin, screen.x - size.w / 2), rightWall - size.w)
    }
    const top = Math.min(Math.max(margin, screen.y - size.h / 2), window.innerHeight - margin - size.h)

    if (!this._cardOn) {
      this._cardOn = true
      el.classList.add('on')
    }
    // Whole pixels, and only when it actually moved: a transform written every frame with a
    // fractional delta is a repaint the compositor cannot skip.
    const x = Math.round(left)
    const y = Math.round(top)
    if (x !== this._cardX || y !== this._cardY) {
      this._cardX = x
      this._cardY = y
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
    // The nib points back at the astronaut, so it changes sides with the card.
    if (flip !== this._cardFlip) {
      this._cardFlip = flip
      el.classList.toggle('flip', flip)
    }
    // And it tracks the astronaut vertically when the card has been pushed off-centre.
    const nib = Math.min(Math.max(14, screen.y - y), size.h - 14)
    if (nib !== this._cardNib) {
      this._cardNib = nib
      el.style.setProperty('--nib-y', `${Math.round(nib)}px`)
    }
  }

  /** Share one measured safe area between camera framing, cards, and the legend. */
  _syncLayout() {
    const width = this.el.clientWidth
    const height = this.el.clientHeight
    const side = this.$('.side')
    let right = 0
    let bottom = 0
    if (this.visible) {
      if (this.isPhone()) {
        // Use the sheet's destination, not an intermediate animation transform.
        const peek = parseFloat(getComputedStyle(this.el).getPropertyValue('--peek')) || 0
        const top = side.offsetTop + (side.classList.contains('open') ? 0 : side.offsetHeight - peek)
        bottom = Math.max(0, height - top)
      } else {
        right = Math.max(0, width - side.offsetLeft)
      }
    }
    this._sideWidth = right
    this.el.style.setProperty('--side', `${right}px`)
    this.actions.viewportChanged?.({ width, height, right, bottom })
  }

  /** Redraw the card's face so it blinks in step with the astronaut it belongs to. */
  updateAvatar(faceAtlasCanvas) {
    if (!this.selected || !faceAtlasCanvas) return
    const agent = this.selected.agent
    const frame = agent.faceFrame ?? FACE.idle
    const color = agent.eye
    const css = cssFromGlow(color)
    if (this._avatarState.frame === frame && this._avatarState.color === css) return
    this._avatarState = { frame, color: css }

    const size = 108
    const cell = faceAtlasCanvas.width / FRAME_COLS
    const sx = (frame % FRAME_COLS) * cell
    const sy = Math.floor(frame / FRAME_COLS) * (faceAtlasCanvas.height / FRAME_ROWS)

    // The atlas is an opaque white-on-black mask, so the tint is a `multiply`, not a
    // `source-in`: black stays black and the white features take the eye colour. Keying on
    // alpha instead would flood the whole cell, because every pixel in it is opaque.
    const t = this.avatarTmpCtx
    t.globalCompositeOperation = 'source-over'
    t.clearRect(0, 0, size, size)
    t.drawImage(faceAtlasCanvas, sx, sy, cell, cell, 0, 0, size, size)
    t.globalCompositeOperation = 'multiply'
    t.fillStyle = css
    t.fillRect(0, 0, size, size)
    t.globalCompositeOperation = 'source-over'

    const c = this.avatarCtx
    c.fillStyle = '#06070c'
    c.fillRect(0, 0, size, size)
    c.drawImage(this.avatarTmp, 0, 0)
    // Scanlines, so the card's face reads as the same little screen as the one in the world.
    c.globalAlpha = 0.2
    c.fillStyle = '#000'
    for (let y = 0; y < size; y += 3) c.fillRect(0, y, size, 1)
    c.globalAlpha = 1
  }

  setFps(perf, viewport, extra) {
    if (!this.settings.get('showFps')) return
    const el = this.$('.fps')
    const fps = Math.round(perf.fps)
    if (this._last.fps === fps && this._last.calls === perf.drawCalls) return
    this._last.fps = fps
    this._last.calls = perf.drawCalls
    el.innerHTML =
      `<b>${fps}</b> fps · ${perf.frameMs.toFixed(1)} ms<br>` +
      `${perf.drawCalls} draws · ${(perf.triangles / 1000).toFixed(0)}k tris<br>` +
      // The setting is a share of the display, so the readout is too — otherwise a retina
      // machine sitting exactly on the 100% slider reads back "200%".
      `${viewport.bw}×${viewport.bh} (${Math.round((viewport.scale / (window.devicePixelRatio || 1)) * 100)}%)` +
      (extra ? `<br>${extra}` : '')
  }

  hint(text, ms = 3200) {
    const el = this.$('.hint-pill')
    el.textContent = text
    el.classList.add('on')
    clearTimeout(this._hintTimer)
    this._hintTimer = setTimeout(() => el.classList.remove('on'), ms)
  }

  toast(message, kind = '') {
    const el = document.createElement('div')
    el.className = `toast panel ${kind}`
    el.textContent = message
    this.$('.toasts').appendChild(el)
    setTimeout(() => {
      el.classList.add('leaving')
      setTimeout(() => el.remove(), 260)
    }, 3600)
  }

  // ── visibility ──────────────────────────────────────────────────────────────────────

  /** Reflect orbit mode on the rail button. */
  setOrbit(on) {
    this.$('#btn-orbit').setAttribute('aria-pressed', String(Boolean(on)))
  }

  /** Whether the layout is the phone one: the sheet, the docked card, the top rail. */
  isPhone() {
    return window.matchMedia('(max-width: 600px)').matches
  }

  /** Pull the sidebar sheet up over the colony, or let it drop to its peek. Phone only. */
  toggleSheet(force) {
    const side = this.$('.side')
    const open = force ?? !side.classList.contains('open')
    side.classList.toggle('open', open)
    this._syncLayout()
    return open
  }

  toggleSettings(force) {
    const panel = this.$('.settings')
    const open = force ?? panel.classList.contains('closed')
    panel.classList.toggle('closed', !open)
    this.$('#btn-settings').setAttribute('aria-pressed', String(open))
    // Settings replaces the sidebar in its existing slot, including for keyboard users.
    const side = this.$('.side')
    side.classList.toggle('covered', open)
    side.inert = open
    panel.inert = !open
    if (open) this.$('#btn-close-settings').focus({ preventScroll: true })
    else if (panel.contains(document.activeElement)) this.$('#btn-settings').focus({ preventScroll: true })
  }

  toggleHelp(force) {
    const el = this.$('.help')
    const open = force ?? !el.classList.contains('open')
    el.classList.toggle('open', open)
  }

  /** Settle whatever `pickHarness` is currently waiting on, or do nothing if none is. */
  _resolvePicker(value) {
    const resolve = this._pickerResolve
    if (!resolve) return
    this._pickerResolve = null
    this.$('.picker').classList.remove('open')
    document.removeEventListener('keydown', this._pickerKeyHandler)
    document.removeEventListener('click', this._pickerOutsideHandler)
    resolve(value)
  }

  /**
   * Which harness should answer a new conversation — asked only when there is an actual
   * choice; a machine with one detected harness never sees this. A small menu anchored under
   * the New Conversation button, not a modal — there is nothing here worth dimming the whole
   * colony for. Resolves with the chosen id, or null for Escape / a click outside it, both of
   * which mean "never mind" alike.
   */
  pickHarness(options, { preferred } = {}) {
    return new Promise((resolve) => {
      // A still-open menu nobody answered loses to whichever call comes next — only one
      // choice is ever live at a time.
      this._resolvePicker(null)
      this._pickerResolve = resolve

      const menu = this.$('.picker')
      const list = this.$('.picker-options')
      list.innerHTML = ''
      for (const h of options) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'btn ghost' + (h.id === preferred ? ' primary' : '')
        btn.textContent = h.name
        btn.addEventListener('click', () => this._resolvePicker(h.id))
        list.appendChild(btn)
      }

      // Anchored under whichever button opens a new conversation — the click and the C
      // shortcut both only ever fire with a repo already selected, so this is always there.
      const anchor = this.$('#btn-new-session')
      const rect = anchor.getBoundingClientRect()
      const menuWidth = 190 // matches the CSS min-width; measuring the real box needs a layout pass first
      menu.style.top = `${rect.bottom + 6}px`
      menu.style.left = `${Math.min(rect.left, window.innerWidth - menuWidth - 12)}px`

      this._pickerKeyHandler = (e) => {
        if (e.key === 'Escape') this._resolvePicker(null)
      }
      document.addEventListener('keydown', this._pickerKeyHandler)
      // Deferred a tick: the click that opened this menu is still bubbling when this listener
      // gets added, and without the delay it would catch that same click and close immediately.
      this._pickerOutsideHandler = (e) => {
        if (!menu.contains(e.target)) this._resolvePicker(null)
      }
      setTimeout(() => document.addEventListener('click', this._pickerOutsideHandler), 0)

      menu.classList.add('open')
    })
  }

  /**
   * Dismiss everything. This is the mode the game is really meant to be left in — the
   * colony carries its own state above the astronauts' heads, so the panels are for
   * setting things up, not for playing.
   */
  toggleUi(force) {
    this.visible = force ?? !this.visible
    this.el.classList.toggle('hidden', !this.visible)
    this.$('#btn-hide').innerHTML = this.visible ? ICON.eye : ICON.eyeOff
    this.actions.uiVisibility?.(this.visible)
    this._syncLayout()
    if (!this.visible) this.toggleHelp(false)
    return this.visible
  }

  removeBoot() {
    const boot = document.querySelector('.boot')
    if (!boot) return
    boot.classList.add('gone')
    setTimeout(() => boot.remove(), 550)
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────────

function group(title, child) {
  const el = document.createElement('div')
  el.className = 'group'
  el.innerHTML = `<h3>${title}</h3>`
  if (child) el.appendChild(child)
  return el
}

function chips(items, current, onPick, registry) {
  const wrap = document.createElement('div')
  wrap.className = 'chips'
  const buttons = []
  for (const item of items) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'chip'
    b.textContent = item.label
    if (item.title) b.title = item.title
    b.addEventListener('click', () => onPick(item.id))
    wrap.appendChild(b)
    buttons.push([item.id, b])
  }
  registry.push({
    el: wrap,
    sync: () => {
      const now = current()
      for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(id === now))
    },
  })
  return wrap
}

const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6)
/**
 * Eye colours are authored above 1.0 so the bloom pass catches them in the scene. For the
 * card they are normalised by the brightest channel — which keeps the hue the astronaut
 * actually has rather than clipping a 3.0-red down to the same white as a 3.0-blue.
 */
function cssFromGlow(color) {
  const peak = Math.max(color.r, color.g, color.b, 1)
  const enc = (v) => Math.round(Math.pow(Math.min(1, v / peak), 1 / 2.2) * 255)
  return `rgb(${enc(color.r)},${enc(color.g)},${enc(color.b)})`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** Status → the colour family the top-bar counters already use for it. */
function statusClass(status) {
  if (status === 'working') return 'working'
  if (status === 'waiting') return 'waiting'
  if (status === 'blocked') return 'blocked'
  if (status === 'celebrating') return 'done'
  return 'idle'
}

/**
 * A path that fits, trimmed from the *left* so the repo end survives — the deep end is the
 * part that identifies it. CSS can only ellipsise the tail, and `direction: rtl` mangles a
 * leading `~`, so the trim is done here and the whole path lives in the title attribute.
 */
function shortPath(dir, max = 30) {
  const home = dir.replace(/^\/Users\/[^/]+/, '~')
  if (home.length <= max) return home
  const parts = home.split('/')
  let out = parts.pop() || ''
  while (parts.length) {
    const next = parts.pop()
    if (out.length + next.length + 3 > max) break
    out = `${next}/${out}`
  }
  return `…/${out}`
}

function shortModel(model) {
  return String(model).replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

function clockLabel(t) {
  const total = t * 24 * 60
  const h = Math.floor(total / 60) % 24
  const m = Math.floor(total % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function nearestTime(value) {
  let best = TIMES[0]
  let bestD = Infinity
  for (const t of TIMES) {
    // Wrap-aware, so 0.99 is nearest to dawn rather than to noon.
    const d = Math.min(Math.abs(t.value - value), 1 - Math.abs(t.value - value))
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  return bestD < 0.03 ? best.id : null
}

function ago(ts) {
  if (!ts) return 'never'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const TEMPLATE = `
<aside class="side panel">
  <div class="grab"></div>
  <header class="brandbar">
    <div class="brand"><i class="dot"></i>Bot Crossing</div>
    <input type="file" id="file-convert" hidden accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.html,.csv,.json,.xml,image/*" />
    <button class="btn icon ghost" id="btn-convert" title="Copy a file for Claude Code: PDF/doc → markdown, image → copied as-is">${ICON.upload}</button>
    <button class="btn icon ghost" id="btn-shot" title="Screenshot (P)">${ICON.camera}</button>
    <button class="btn icon ghost" id="btn-help" title="Help (?)">${ICON.help}</button>
    <button class="btn icon ghost" id="btn-hide" title="Hide all UI (H)">${ICON.eye}</button>
    <button class="btn icon ghost" id="btn-settings" title="Settings (S)" aria-pressed="false">${ICON.settings}</button>
  </header>

  <div class="stats"></div>

  <div class="side-body">
    <div class="projects-pane">
      <div class="sec-head"><span>Repos</span></div>
      <button class="btn" id="btn-add-project" type="button">+ Add project</button>
      <div class="projects"></div>
      <div class="hidden-block" hidden>
        <button type="button" class="hidden-toggle" id="btn-hidden-toggle" aria-expanded="false">
          <span class="label">0 hidden</span>
        </button>
        <div class="hidden-projects" hidden></div>
      </div>
    </div>

    <div class="project-detail">
      <button class="btn ghost back" id="btn-close-project" title="Back to every repo (Esc)">${ICON.back} All repos</button>
      <div class="who">
        <i class="swatch"></i>
        <div class="text">
          <div class="name"></div>
          <div class="path"></div>
        </div>
        <button class="btn icon ghost" id="btn-locate" title="Fly to this zone">${ICON.locate}</button>
      </div>
      <div class="project-actions">
        <button class="btn primary" id="btn-new-session" title="Start a new thread in this folder (C)">${ICON.plus} New conversation</button>
        <div class="pair">
          <button class="btn" id="btn-reveal" title="Show this folder in ${FILE_MANAGER}">${ICON.folder} ${FILE_MANAGER}</button>
          <button class="btn" id="btn-copy-path" title="Copy the folder path">${ICON.copy} Copy path</button>
        </div>
        <button class="btn" id="btn-vscode" title="Open this folder in VS Code">${ICON.open} VS Code</button>
        <button class="btn" id="btn-hide-project" title="Hide this repo from the colony — does not archive its threads">${ICON.eyeOff} Hide from colony</button>
      </div>
      <div class="threads-head"></div>
      <div class="threads"></div>

      <div class="side-section" id="skills-section">
        <div class="skills-head">
          <button type="button" class="hidden-toggle" id="btn-skills-toggle" aria-expanded="false">
            <span class="label">0 skills</span>
          </button>
          <button type="button" class="btn ghost" id="btn-skills-browse">Browse</button>
        </div>
        <div class="skills-list" hidden></div>
      </div>

      <div class="side-section" id="context-section" hidden>
        <div class="context-head" hidden>
          <button type="button" class="hidden-toggle" id="btn-context-toggle" aria-expanded="false">
            <span class="label">Project context</span>
          </button>
          <button type="button" class="btn ghost" id="btn-context-edit">Edit</button>
        </div>
        <button type="button" class="btn ghost context-create" id="btn-context-create" hidden>
          ${ICON.plus} Add project context
        </button>
        <pre class="context-body" hidden></pre>
        <div class="context-editor" hidden>
          <textarea
            class="context-textarea"
            spellcheck="false"
            placeholder="Notes for future Claude Code / Codex sessions in this repo…"
          ></textarea>
          <div class="context-editor-actions">
            <span class="context-error"></span>
            <button type="button" class="btn ghost" id="btn-context-cancel">Cancel</button>
            <button type="button" class="btn primary" id="btn-context-save">Save</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</aside>

<div class="rail panel">
  <button class="btn icon" id="btn-home" title="Reset the view (0)">${ICON.home}</button>
  <button class="btn icon" id="btn-next" title="Next astronaut waiting on you (N)">${ICON.next}</button>
  <div class="sep"></div>
  <button class="btn icon" id="btn-orbit" title="Orbit mode — sweep around the colony (O)" aria-pressed="false">${ICON.orbit}</button>
  <button class="btn icon" id="btn-planet" title="Change planet (Tab)">${ICON.globe}</button>
  <button class="btn icon" id="btn-time" title="Change the time of day (L)">${ICON.sun}</button>
  <div class="sep"></div>
  <button class="btn icon" id="btn-sound" title="Mute (M)" aria-pressed="true">${ICON.sound}</button>
</div>

<div class="settings panel closed" inert>
  <header>Settings <button class="btn icon ghost" id="btn-close-settings" title="Close">${ICON.close}</button></header>
  <div class="body"></div>
</div>

<div class="thread-pop panel">
  <i class="nib"></i>
  <div class="top">
    <div class="avatar"><canvas></canvas></div>
    <div class="info">
      <div class="title"></div>
      <div class="meta"></div>
    </div>
    <button class="btn icon ghost" id="btn-follow" title="Follow selected agent" aria-label="Follow selected agent" aria-pressed="false">${ICON.locate}</button>
    <button class="btn icon ghost" id="btn-deselect" title="Deselect (Esc)">${ICON.close}</button>
  </div>
  <div class="progress"><i></i></div>
  <div class="pair">
    <button class="btn primary" id="btn-open" title="Open this thread in the harness it came from (Enter)">${ICON.open} Open</button>
    <button class="btn" id="btn-viewed" title="Stop this thread asking for you until it moves on again (V)">${ICON.eye} Viewed</button>
    <button class="btn" id="btn-archive" title="Archive — this astronaut walks back to the ship (A)">${ICON.archive} Archive</button>
  </div>
</div>

<div class="toasts"></div>
<div class="fps panel"></div>
<div class="hint-pill panel"></div>

<div class="help">
  <div class="sheet panel">
    <h2>Bot Crossing</h2>
    <p class="sub">Every coding-agent thread on this machine is an astronaut. They walk out of the ship, claim a plot for their repo, and build. Click one to open its thread; click a zone — its deck or its name — for the repo itself, and start a new conversation there. Hide a repo from that panel if you would rather not see it — its threads stay in your harness, and you can show it again from the list. Navigation works like Google Earth — drag the ground itself, right-drag to tilt, scroll to zoom in on whatever is under the cursor.</p>
    <div class="cols">
      <div>
        <div class="k"><span>Drag the ground</span><kbd>drag</kbd></div>
        <div class="k"><span>Tilt &amp; rotate</span><kbd>right-drag</kbd></div>
        <div class="k"><span>&nbsp;</span><kbd>⌃ or ⇧ + drag</kbd></div>
        <div class="k"><span>Zoom to cursor</span><kbd>scroll</kbd></div>
        <div class="k"><span>Move / zoom</span><kbd>arrows</kbd> <kbd>+ −</kbd></div>
        <div class="k"><span>Reset view</span><kbd>0</kbd></div>
        <div class="k"><span>Hide all UI</span><kbd>H</kbd> <kbd>${IS_MAC ? '⌘' : 'Ctrl'}\\</kbd></div>
        <div class="k"><span>Settings</span><kbd>S</kbd></div>
        <div class="k"><span>Screenshot</span><kbd>P</kbd></div>
      </div>
      <div>
        <div class="k"><span>Next needing you</span><kbd>N</kbd></div>
        <div class="k"><span>Open thread</span><kbd>Enter</kbd></div>
        <div class="k"><span>Mark viewed</span><kbd>V</kbd></div>
        <div class="k"><span>Archive</span><kbd>A</kbd></div>
        <div class="k"><span>New conversation</span><kbd>C</kbd></div>
        <div class="k"><span>Orbit mode</span><kbd>O</kbd></div>
        <div class="k"><span>Change planet</span><kbd>Tab</kbd></div>
        <div class="k"><span>Time of day</span><kbd>L</kbd></div>
        <div class="k"><span>Mute</span><kbd>M</kbd></div>
        <div class="k"><span>Deselect</span><kbd>Esc</kbd></div>
        <div class="k"><span>This sheet</span><kbd>?</kbd></div>
      </div>
    </div>
    <div style="margin-top:16px">
      <div class="legend-row"><i class="badge" style="background:#1a2b46;color:#8fb4ee">?</i> waiting on your reply — click to open the thread</div>
      <div class="legend-row"><i class="badge" style="background:#3d1c1c;color:#e88b8b">!</i> the session hit an error</div>
      <div class="legend-row"><i class="badge" style="background:#16301f;color:#7fd39a">⚒</i> running right now, building</div>
      <div class="legend-row"><i class="badge" style="background:#332b12;color:#e6c67f">✓</i> its pull request landed</div>
      <div class="legend-row"><i class="badge" style="background:#1d1f2e;color:#a9a8c0">z</i> nothing for three days</div>
    </div>
    <div style="margin-top:18px;display:flex;justify-content:flex-end">
      <button class="btn primary" id="btn-help-close">Got it</button>
    </div>
  </div>
</div>

<div class="picker">
  <div class="picker-menu panel">
    <div class="picker-options"></div>
  </div>
</div>

<div class="help registry">
  <div class="sheet panel">
    <h2>Browse skills</h2>
    <p class="sub">Every skill available from a marketplace Claude Code already knows about — installing one copies it into this repo's own <code>.claude/skills</code>, visible to Codex too on the next session.</p>
    <form class="registry-add">
      <input type="text" id="input-marketplace" placeholder="Marketplace name, URL, or owner/repo" autocomplete="off" />
      <button class="btn ghost" type="submit" id="btn-marketplace-add">Add</button>
    </form>
    <div class="registry-add-error" id="marketplace-add-error" hidden></div>
    <input type="text" class="registry-search" id="input-skill-search" placeholder="Search skills…" autocomplete="off" />
    <div class="registry-list"></div>
    <div style="margin-top:14px;display:flex;justify-content:flex-end">
      <button class="btn ghost" type="button" id="btn-registry-close">Close</button>
    </div>
  </div>
</div>
`
