import * as THREE from 'three'
import { PLANETS, createTerrain, createScatter, terrainHeight, SKY_MARGIN, SKY_MAX_CELLS } from '../world/planet.js'
import { createSkyIsland } from '../world/skyisland.js'
import { createHexIsland } from '../world/hexisland.js'
import { Plot, allocateCells, PLOT_PALETTE, PLOT_CELL, hashString, shipPosition, DECK_TOP } from '../world/plots.js'
import { Scaffolds, BUILDING_RADIUS } from '../world/buildings.js'
import { Fauna } from '../world/fauna.js'
import { Ship } from '../world/ship.js'
import { Astronauts } from '../agents/astronauts.js'
import { Indicators, BADGE } from '../agents/indicators.js'
import { Sky } from '../world/sky.js'
import { MAX_AGENT_CAP } from '../core/settings.js'
import { statusFor, STATUS_ORDER } from '../game/colony.js'
import { createTowerMesh, createWindmill } from './tower-mesh.js'

/**
 * Tower Colony — the same crew, sidebar and bookkeeping as the original bot-crossing colony
 * (astronauts with real status, badges, a ship to walk out of, skills/settings/project chrome
 * driven by `Hud` in `src/towers/app.js`), but the *purpose* has changed: one project at a
 * time, shown as a skyline that grows with how much code it has, not a map of every project's
 * threads at once. Every project you've viewed this session keeps its own deck and towers,
 * cached in its own hidden `THREE.Group` — switching projects just swaps which group is
 * visible, so growth already watched is never lost or re-randomised.
 *
 * New module — does not import from or touch `src/game/colony.js`'s own rendering (only its
 * exported, side-effect-free `statusFor`/`STATUS_ORDER` helpers) or `src/world/buildings.js`'s
 * `createBuilding`/`KINDS`. `Plot`, `allocateCells`, `Ship`, `Astronauts`, `Indicators`,
 * `Fauna`, `Scaffolds`, `BUILDING_RADIUS` are the same *generic* world/agent infrastructure the
 * original app is built from, imported read-only, same as `tower-mesh.js` already does for
 * KayKit parts.
 */

const LOC_PER_GROWTH_POINT = 20
const GROW_EXISTING_CHANCE = 0.8
const MIN_MAX_LEVELS = 2
const MAX_MAX_LEVELS = 8
const POINTS_PER_SLOT = 5
const WINDMILL_CHANCE = 0.35
/** How often a crew member's spot on the deck reseeds to a new cell — long enough that it reads
 * as "wandered over there" rather than teleporting every poll, short enough to actually notice. */
const WANDER_PERIOD_MS = 25000
const FLOCK_RANGE = 16
const DEFAULT_BIRDS = { kind: 'crow', count: 6, altitude: [7, 13], colors: [0x2a2420, 0x3a302a], size: 1.1 }

const BADGE_FOR = {
  waiting: BADGE.waiting,
  blocked: BADGE.blocked,
  working: BADGE.working,
  celebrating: BADGE.done,
  sleeping: BADGE.none,
  idle: BADGE.none,
  spawning: BADGE.spawning,
  leaving: BADGE.leaving,
}

function slotRand(i) {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

/** Every planet, tuned for a single deck: a default crow flock for the airless presets (which
 * otherwise have none), and every bird's wander kept tight around the one thing there is to
 * circle instead of `fauna.js`'s own 60-unit default (sized for a whole multi-plot colony). */
export function tunedPlanet(base) {
  return {
    ...base,
    fauna: {
      ...base.fauna,
      birds: { ...DEFAULT_BIRDS, ...(base.fauna?.birds || {}), range: FLOCK_RANGE },
    },
  }
}

export class TowerColony {
  constructor(scene, settings, camera, renderer) {
    this.scene = scene
    this.settings = settings
    this.camera = camera
    this.renderer = renderer

    this.projects = new Map() // name -> per-project state, see `_stateFor`
    this.currentName = null
    this.threads = new Map() // id -> thread, current project only

    this.ship = new Ship(scene, shipPosition())
    this.astronauts = new Astronauts(scene, settings)
    this.astronauts.world = this._world()
    this.indicators = new Indicators(scene, settings, MAX_AGENT_CAP)
    this._buildBeacons()
    this.scaffolds = new Scaffolds(scene, 256)
    this.fauna = new Fauna(scene, settings)
    // Fauna calls these unconditionally (a bird-call, a landing ripple) rather than optional-
    // chaining them — real no-ops, not `{}`, or the first bird call throws.
    this.faunaHooks = { ripple: () => {}, sound: () => {} }

    this.ground = null
    this.scatter = null
    this.planet = null
    // The real sky: skydome, sun/ambient lights, stars, and — the part a hand-rolled
    // `AmbientLight`+`DirectionalLight` pair (this used to be that) cannot give you — an actual
    // prefiltered environment map for image-based lighting. Every kit part in this scene uses a
    // PBR material with real roughness/metalness; without an environment to reflect, those
    // materials have nothing to pick up ambient light from and render close to black regardless
    // of how bright the direct lights are. That is almost certainly why the deck "went black"
    // after the first few astronauts spawned — they're a different (non-PBR) material, which is
    // also why *they* stayed visible while everything else didn't.
    this.sky = new Sky(scene, settings, renderer)

    this.urgentPlots = new Set()
    this.dormantProjects = new Set() // one project on screen at a time — folding never applies
  }

  // ── planet / landscape ────────────────────────────────────────────────────────────────

  setPlanet(planet) {
    this.planet = planet
    this.sky.setPlanet(planet)
    this.sky.setTime(this.settings.get('timeOfDay'))

    if (this.ground) {
      this.scene.remove(this.ground)
      this.ground.geometry.dispose()
      this.ground.material.dispose()
    }
    if (this.scatter) this.scene.remove(this.scatter)
    this.ground = createTerrain(planet, 'medium', 1337)
    this.ground.receiveShadow = true
    this.scene.add(this.ground)
    // `inside` matters only for a "sky"-shaped planet (see `onIsland` below) — every other
    // shape's `onIsland` always returns true, same as the original, so scatter is unrestricted.
    // Without it, trees/rocks were scattered across the whole (mostly invisible, clipped-away)
    // ground plane, including well outside the actual floating island.
    this.scatter = createScatter(planet, 0.25, [], 4242, (x, z) => this.onIsland(x, z))
    this.scene.add(this.scatter)

    this.fauna.setPlanet(planet, {
      heightAt: (x, z) => terrainHeight(x, z, planet),
      // No `parcelSurfaceAt` — see tower-mesh/tower-city history: supplying one at all, even
      // one returning null, beats Fauna's own real fallback (it checks the function's
      // truthiness, not its return value) and crashes the first drone drop.
      waterLevel: planet.water?.level ?? null,
      waterHeightAt: undefined,
    })
    this._syncFaunaSites()
    this._buildIsland()
  }

  // ── per-project state ─────────────────────────────────────────────────────────────────

  _stateFor(name) {
    let st = this.projects.get(name)
    if (!st) {
      const group = new THREE.Group()
      group.visible = false
      this.scene.add(group)
      st = {
        group,
        towers: [],
        windmills: new Map(),
        plot: null,
        plotCells: new Map(),
        totalPoints: 0,
        lastLoc: 0,
        accent: PLOT_PALETTE[hashString(name) % PLOT_PALETTE.length],
      }
      this.projects.set(name, st)
    }
    return st
  }

  /** A stable colour for a project's legend chip, even before it's ever been shown. */
  accentFor(name) {
    return this._stateFor(name).accent
  }

  /** Switch which project's deck is visible. Growth already watched is kept, not rebuilt. */
  showProject(name) {
    if (this.currentName === name) return
    for (const [n, st] of this.projects) st.group.visible = n === name
    this.currentName = name
    const st = this._stateFor(name)
    // Scaffolds, fauna sites and (on a "sky"-shaped planet) the ground itself are shared,
    // scene-wide systems, not per-project groups — they have to be told about the switch
    // explicitly rather than just riding along with `group.visible`.
    this._syncScaffolds(st)
    this._syncFaunaSites()
    this._syncIslandRock(st)
  }

  get current() {
    return this.currentName ? this.projects.get(this.currentName) : null
  }

  /** A `plots`-like map, one entry — the *currently shown* project — matching enough of the
   * original `Colony.plots` surface (`.get`, `.has`, iteration) for the app's HUD wiring. */
  get plots() {
    const st = this.current
    const map = new Map()
    if (st) {
      map.set(this.currentName, {
        id: this.currentName,
        name: this.currentName,
        accent: st.accent,
        center: st.plot ? st.plot.center : new THREE.Vector3(0, 0, 0),
        middle: st.plot ? st.plot.middle : new THREE.Vector3(0, 0, 0),
      })
    }
    return map
  }

  get plotOrder() {
    return [...this.plots.values()]
  }

  // ── deck / towers ─────────────────────────────────────────────────────────────────────

  _ensureCapacity(st, neededSlots) {
    if (st.plot && st.plot.slots.length >= neededSlots) return
    const layout = allocateCells([{ id: this.currentName, size: neededSlots }], st.plotCells)
    const cells = layout.get(this.currentName)
    st.plotCells.set(this.currentName, cells)
    if (st.plot) {
      st.group.remove(st.plot.group)
      st.plot.dispose()
    }
    st.plot = new Plot({ id: this.currentName, name: this.currentName, index: 0, cells, accent: st.accent })
    st.group.add(st.plot.group)
    for (const t of st.towers) t.mesh.position.copy(st.plot.worldSlot(t.slot))
    if (st === this.current) this._syncIslandRock(st)
  }

  /**
   * Everything a "sky"-shaped planet needs to actually look like a floating island rather than
   * a flat patch of ground clipped to a hard edge — mirrors `Colony._buildIsland`/
   * `_syncIslandRock` exactly, just fed the *current* project's deck instead of every plot on
   * the map. Three things, all keyed to the same footprint:
   * 1. `createTerrain`'s ground shader only renders where `setFootprint(cells, reach)` has told
   *    it to (world-space cell centres) — never called before, so the "archipelago" either
   *    showed nothing or a stale shape regardless of how many hex tiles the deck actually had.
   * 2. `createHexIsland` builds the actual rock/soil/vine underside hanging off the rim — the
   *    part that makes it read as a floating island instead of a raft. Never built at all
   *    before this; without it, there was nothing under the clipped edge but void.
   * 3. `createSkyIsland`'s round default underside/vines are switched off (this footprint isn't
   *    round, `createHexIsland` already covers it) — it's only here for the cloud sea and the
   *    drifting puffs around the rim.
   * No-ops entirely off a non-"sky" planet, same as the original.
   */
  /** Whether a world point is on the island: within a cell and its grass margin. Always true
   * off a "sky"-shaped planet — mirrors `Colony.onIsland` exactly. */
  onIsland(x, z) {
    if (this.planet?.shape !== 'sky') return true
    const reach = (PLOT_CELL + SKY_MARGIN) * 0.86
    for (const c of this._footprintCells(this.current)) {
      const dx = x - c.x
      const dz = z - c.z
      if (dx * dx + dz * dz < reach * reach) return true
    }
    return false
  }

  _footprintCells(st) {
    // `st` is null at boot — `applyPlanet()` runs before any project has ever been shown, so a
    // "sky"-shaped planet chosen from a previous session hits this before `this.current` exists.
    const list = st?.plot ? st.plot.localCenters.map((c) => ({ x: st.plot.center.x + c.x, z: st.plot.center.z + c.z })) : []
    const ship = shipPosition()
    list.push({ x: ship.x, z: ship.z })
    return list.slice(0, SKY_MAX_CELLS)
  }

  _footprintRadius(st) {
    let r = PLOT_CELL
    for (const c of this._footprintCells(st)) r = Math.max(r, Math.hypot(c.x, c.z) + PLOT_CELL)
    return r
  }

  _disposeIsland() {
    if (this.island) {
      this.scene.remove(this.island.group)
      this.island.dispose()
      this.island = null
    }
    if (this.rock) {
      this.scene.remove(this.rock.group)
      this.rock.dispose()
      this.rock = null
    }
  }

  /** Rebuilds the cloud-sea backdrop for the current planet — once per planet change, not
   * once per deck growth (that's `_syncIslandRock`, the cheaper of the two). */
  _buildIsland() {
    this._disposeIsland()
    if (this.planet?.shape !== 'sky') return
    const detail = this.settings.get('groundDetail')
    this.island = createSkyIsland({
      planet: this.planet,
      heightAt: (x, z) => terrainHeight(x, z, this.planet),
      rimRadius: this._footprintRadius(this.current) + 6,
      quality: detail === 'high' ? 'high' : detail === 'low' ? 'low' : 'medium',
    })
    this.island.meshes.underside.visible = false
    this.island.meshes.vines.visible = false
    this.island.setDaylight(this.sky?.dayFactor ?? 1)
    this.scene.add(this.island.group)
    this._syncIslandRock(this.current)
  }

  /** Rebuilds the ground-shader footprint and the hex-shaped rock underside for `st` — cheap
   * enough to call on every deck-capacity change, unlike `_buildIsland`. */
  _syncIslandRock(st) {
    if (!st) return
    const cells = this._footprintCells(st)
    this.ground?.userData?.setFootprint?.(cells, PLOT_CELL + SKY_MARGIN)
    if (this.planet?.shape !== 'sky') return
    if (this.rock) {
      this.scene.remove(this.rock.group)
      this.rock.dispose()
      this.rock = null
    }
    const detail = this.settings.get('groundDetail')
    const p = this.planet.skyIsland || {}
    this.rock = createHexIsland({
      cells,
      cellRadius: PLOT_CELL,
      margin: SKY_MARGIN,
      palette: { soil: p.soil, rock: p.rock, vine: p.vine, moss: this.planet.ground.low },
      quality: detail === 'low' ? 'low' : 'medium',
    })
    this.scene.add(this.rock.group)
  }

  _spawnTower(st) {
    const taken = new Set([...st.towers.map((t) => t.slot), ...st.windmills.keys()])
    // Real bug, found from a live stack trace: sizing capacity off tower count alone left no
    // room once windmills (up to ~35% of the otherwise-empty slots) had claimed some — `free`
    // could come back empty even though `plot.slots.length > towers.length`, handing
    // `_rebuildTowerMesh` an `undefined` slot and crashing `Plot.worldSlot`. Windmills only ever
    // fill slots *after* a tower has had first pick (see `_syncWindmills`), so reserving room
    // for today's count of them is enough — it can never be an underestimate at this point.
    this._ensureCapacity(st, st.towers.length + st.windmills.size + 1)
    const free = []
    for (let i = 0; i < st.plot.slots.length; i++) if (!taken.has(i)) free.push(i)
    // Belt and suspenders: if this is ever wrong again, force one more cell rather than crash.
    if (!free.length) {
      this._ensureCapacity(st, st.plot.slots.length + 1)
      for (let i = 0; i < st.plot.slots.length; i++) if (!taken.has(i)) free.push(i)
    }
    const slot = free[Math.floor(Math.random() * free.length)]
    const tower = {
      slot,
      seed: Math.floor(Math.random() * 0xffffffff),
      levels: 1,
      maxLevels: MIN_MAX_LEVELS + Math.floor(Math.random() * (MAX_MAX_LEVELS - MIN_MAX_LEVELS + 1)),
      mesh: null,
    }
    this._rebuildTowerMesh(st, tower)
    st.towers.push(tower)
    try {
      this._syncWindmills(st)
    } catch (err) {
      console.error('tower-colony: windmill sync failed', err)
    }
    try {
      this._syncScaffolds(st)
    } catch (err) {
      console.error('tower-colony: scaffold sync failed', err)
    }
    return tower
  }

  _rebuildTowerMesh(st, tower) {
    if (tower.mesh) {
      st.group.remove(tower.mesh)
      tower.mesh.geometry.dispose()
    }
    // Each tower's accent comes from its own seed — a project-wide accent read as "one flat
    // tint for the whole city", not the varied skyline that was actually asked for.
    const mesh = createTowerMesh(tower.seed, tower.levels, PLOT_PALETTE[tower.seed % PLOT_PALETTE.length])
    mesh.position.copy(st.plot.worldSlot(tower.slot))
    st.group.add(mesh)
    tower.mesh = mesh
  }

  _syncWindmills(st) {
    const takenByTower = new Set(st.towers.map((t) => t.slot))
    const wanted = new Set()
    for (let i = 0; i < st.plot.slots.length; i++) {
      if (!takenByTower.has(i) && slotRand(i) < WINDMILL_CHANCE) wanted.add(i)
    }
    for (const [slot, wm] of st.windmills) {
      if (wanted.has(slot) && !takenByTower.has(slot)) continue
      st.group.remove(wm.group)
      wm.group.traverse((o) => o.isMesh && o.geometry.dispose())
      st.windmills.delete(slot)
    }
    for (const slot of wanted) {
      if (st.windmills.has(slot) || takenByTower.has(slot)) continue
      const wm = createWindmill(slot * 104729 + 7, st.accent)
      wm.group.position.copy(st.plot.worldSlot(slot))
      st.group.add(wm.group)
      st.windmills.set(slot, wm)
    }
  }

  /** Scaffolds are one shared `InstancedMesh` for the whole scene (see `world/buildings.js`),
   * not per-project — only worth recomputing when it's the *visible* project that changed. */
  _syncScaffolds(st) {
    if (st !== this.current) return
    const sites = st.towers
      .filter((t) => t.levels < t.maxLevels)
      .map((t) => ({ x: t.mesh.position.x, y: t.mesh.position.y, z: t.mesh.position.z, radius: BUILDING_RADIUS * 0.6, height: 1.6 }))
    this.scaffolds.update(sites)
  }

  spinWindmills(dt) {
    const st = this.current
    if (!st) return
    for (const wm of st.windmills.values()) wm.rotor.rotation.y += dt * wm.speed
  }

  /** Spend `points` growth points on the given project's state. */
  _grow(st, points) {
    st.totalPoints += points
    try {
      this._ensureCapacity(st, Math.max(st.towers.length, Math.ceil(st.totalPoints / POINTS_PER_SLOT)))
    } catch (err) {
      console.error('tower-colony: deck growth failed', err)
    }
    for (let i = 0; i < points; i++) {
      try {
        const uncapped = st.towers.filter((t) => t.levels < t.maxLevels)
        const spawnNew = uncapped.length === 0 || Math.random() > GROW_EXISTING_CHANCE
        if (spawnNew) {
          this._spawnTower(st)
        } else {
          const t = uncapped[Math.floor(Math.random() * uncapped.length)]
          t.levels++
          this._rebuildTowerMesh(st, t)
        }
      } catch (err) {
        console.error('tower-colony: growth step failed', err)
      }
    }
    try {
      this._syncWindmills(st)
    } catch (err) {
      console.error('tower-colony: windmill sync failed', err)
    }
  }

  // ── roster ────────────────────────────────────────────────────────────────────────────

  /**
   * Rebuild the currently-shown project's skyline and crew from its own threads. `list` is
   * that project's threads only — the app is expected to have already filtered `/api/threads`
   * down to whichever project is selected, same as it filters the legend from the full list.
   */
  setThreads(list, knownIds = new Set()) {
    const name = this.currentName
    if (!name) return { agents: 0 }
    const st = this._stateFor(name)
    // Belt and suspenders: this is the project on screen right now, by definition — an earlier
    // version of `showProject` had a real bug leaving a freshly-created project's group invisible
    // forever (fixed), but nothing costs anything by also asserting it here on every refresh.
    st.group.visible = true

    const totalLoc = list.reduce((sum, t) => sum + (t.linesOfCode || 0), 0)
    const delta = totalLoc - st.lastLoc
    try {
      if (delta >= LOC_PER_GROWTH_POINT) {
        this._grow(st, Math.floor(delta / LOC_PER_GROWTH_POINT))
        st.lastLoc += Math.floor(delta / LOC_PER_GROWTH_POINT) * LOC_PER_GROWTH_POINT
      } else if (st.towers.length === 0) {
        this._spawnTower(st)
        st.lastLoc = totalLoc
      }
    } catch (err) {
      // However this fails, the roster below still has to run — an empty skyline is a much
      // smaller problem than an empty skyline *and* every astronaut frozen mid-poll.
      console.error('tower-colony: setThreads growth failed', err)
    }

    this.threads = new Map(list.map((t) => [t.id, t]))
    const now = Date.now()
    const stats = { agents: 0 }
    for (const key of STATUS_ORDER) stats[key] = 0
    let urgent = false

    const roster = []
    // A random point picked from a *circle* around the deck's centre can easily land in the
    // gap between two hex cells — the footprint isn't a filled disc, it's a cluster of distinct
    // tiles with real space between non-adjacent ones. Picking an actual cell first, then
    // jittering only a safe distance inside *that* cell's own bounds, is what keeps everyone
    // standing on a real tile instead of floating over bare ground next to the deck.
    //
    // The chosen cell (and the jitter within it) is reseeded every `WANDER_PERIOD_MS`, not once
    // per thread forever — that's what makes the crew actually walk around over time instead of
    // planting themselves in one spot for the life of the thread. Bucketing time rather than
    // reseeding every single poll keeps it from looking like a jittery reshuffle every 15s.
    const wanderBucket = Math.floor(now / WANDER_PERIOD_MS)
    list.forEach((thread) => {
      const status = statusFor(thread, now)
      if (stats[status] !== undefined) stats[status]++
      if (status === 'waiting' || status === 'blocked') urgent = true
      stats.agents++
      const seed = `${thread.id}:${wanderBucket}`
      let ax = 0
      let az = 0
      if (st.plot && st.plot.localCenters.length) {
        const cell = st.plot.localCenters[hashString(seed) % st.plot.localCenters.length]
        const localAngle = (hashString(`${seed}:a`) % 100000 / 100000) * Math.PI * 2
        const localRadius = (hashString(`${seed}:r`) % 100000 / 100000) * PLOT_CELL * 0.65
        ax = st.plot.center.x + cell.x + Math.cos(localAngle) * localRadius
        az = st.plot.center.z + cell.z + Math.sin(localAngle) * localRadius
      }
      roster.push({
        id: thread.id,
        thread,
        status,
        site: null,
        anchor: new THREE.Vector3(ax, DECK_TOP, az),
        known: knownIds.has(thread.id),
      })
    })
    this.urgentPlots = urgent ? new Set([name]) : new Set()

    for (const member of roster) member.site = member.anchor.clone()
    try {
      this.astronauts.setRoster(roster, this._world())
    } catch (err) {
      console.error('tower-colony: astronaut roster failed', err)
    }
    try {
      this._syncFaunaSites()
    } catch (err) {
      console.error('tower-colony: fauna site sync failed', err)
    }
    stats.done = stats.celebrating
    this.stats = stats
    return stats
  }

  _syncFaunaSites() {
    const st = this.current
    if (!st) {
      this.fauna.setSites({ pad: { x: -26, y: 0, z: 0 }, sites: [] })
      return
    }
    const sites = st.towers.map((t) => ({
      x: t.mesh.position.x,
      y: t.mesh.position.y,
      z: t.mesh.position.z,
      radius: BUILDING_RADIUS * 2.2,
      active: t.levels < t.maxLevels,
    }))
    this.fauna.setSites({ pad: { x: st.plot ? st.plot.middle.x : 0, y: DECK_TOP, z: st.plot ? st.plot.middle.z : 0 }, sites })
  }

  // ── picking / world ───────────────────────────────────────────────────────────────────

  pick(ndcX, ndcY, aspect) {
    return this.astronauts.pick(this.camera, ndcX, ndcY, aspect)
  }

  agentFor(id) {
    return this.astronauts.byId.get(id)
  }

  /** No hover name-plates in this view — the sidebar always shows the one project on screen. */
  pickLabel() {
    return null
  }

  setHoveredPlot() {}

  plotAt(x, z) {
    const st = this.current
    if (!st?.plot?.containsWorld(x, z)) return null
    return this.plots.get(this.currentName)
  }

  groundAt(x, z) {
    const st = this.current
    if (st?.plot?.containsWorld(x, z)) return DECK_TOP
    return terrainHeight(x, z, this.planet)
  }

  surfaceAt(x, z) {
    const ground = this.groundAt(x, z)
    const level = this.planet?.water?.level
    return level !== undefined && ground < level ? level : ground
  }

  _world() {
    return {
      shipDoor: () => this.ship.shipDoor(),
      shipAirlock: () => this.ship.shipAirlock(),
      groundAt: (x, z) => this.groundAt(x, z),
    }
  }

  _badgeFor(agent) {
    if (agent.state === 'spawning') return BADGE.spawning
    if (agent.state === 'leaving') return BADGE.leaving
    return BADGE_FOR[agent.status] ?? BADGE.none
  }

  /**
   * A glowing ring under every astronaut, regardless of status — `Indicators`' own badges only
   * ever show for a handful of statuses (idle/sleeping deliberately get none, see `BADGE_FOR` in
   * `game/colony.js`), which is right for "who wants you" but wrong for "where is everyone" once
   * a crowd is scattered widely around a tall skyline instead of standing right next to their
   * own building. One shared `InstancedMesh`, same pattern as `Indicators`/`Scaffolds` — cheap
   * regardless of how many agents there are.
   */
  /**
   * A halo around each astronaut's own body, not a decal on the ground under their feet — a
   * flat ground ring is easy to lose in a crowd of towers from above, and doesn't read as
   * "that one, right there" the way a ring drawn *on* them does. Left un-rotated (a `RingGeometry`
   * faces +Z by default) and then billboarded to the camera every frame in `_updateBeacons`, so
   * it always presents as a full circle around the character regardless of view angle, the way a
   * sprite/halo would — a flat-on-the-ground ring can only ever be seen edge-on from the game's
   * own low camera angles, which is a lot of why it was hard to spot in the first place.
   */
  _buildBeacons() {
    const geo = new THREE.RingGeometry(0.3, 0.48, 24)
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe066,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
      // No depth test at all — the whole point is finding an astronaut standing behind a tower
      // from the camera's angle, so it has to draw through solid geometry, not get hidden by it.
      depthTest: false,
      toneMapped: false,
    })
    this.beacons = new THREE.InstancedMesh(geo, mat, MAX_AGENT_CAP)
    this.beacons.count = 0
    this.beacons.frustumCulled = false
    // High enough to draw after everything else in the scene, since depth testing is off for
    // this mesh and render order is what keeps it from fighting with whatever's behind it.
    this.beacons.renderOrder = 999
    this.scene.add(this.beacons)
    this._beaconDummy = new THREE.Object3D()
  }

  _updateBeacons(elapsed) {
    const d = this._beaconDummy
    let n = 0
    for (const agent of this.astronauts.agents) {
      // Only your own crew gets a "find me" halo — a teammate's thread is on their machine,
      // not yours, and highlighting it as if it needed the same attention yours do is misleading.
      if (agent.thread?.remote || agent.scale < 0.4 || n >= MAX_AGENT_CAP) continue
      // A slow pulse, phased by position so a cluster of them doesn't beat in lockstep.
      const pulse = 1 + Math.sin(elapsed * 2.4 + agent.pos.x * 1.7 + agent.pos.z) * 0.18
      // Roughly chest height on a ~1.1-unit-tall astronaut — centred on the body, not the feet.
      d.position.set(agent.pos.x, agent.pos.y + 0.55, agent.pos.z)
      d.quaternion.copy(this.camera.quaternion)
      d.scale.setScalar(pulse * agent.scale)
      d.updateMatrix()
      this.beacons.setMatrixAt(n++, d.matrix)
    }
    this.beacons.count = n
    this.beacons.instanceMatrix.needsUpdate = true
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────

  setUiVisible() {}

  /** Mirrors `Colony.onSettingsChanged` — forward to every subsystem that owns a setting of
   * its own, same as the original does for `sky`/`astronauts`/`fauna` (no `particles` here,
   * that system isn't ported yet). Missed originally; nothing propagated at all, which is why
   * moving the time-of-day slider changed the *setting* but never the sky. */
  onSettingsChanged(changed) {
    this.sky.onSettingsChanged(changed)
    this.astronauts.onSettingsChanged(changed)
    this.fauna.onSettingsChanged(changed)
    if (changed.has('clouds') && this.planet) this.sky.setPlanet(this.planet)
    if (changed.has('timeOfDay')) this.sky.setTime(this.settings.get('timeOfDay'))
  }

  layoutForSave() {
    return {}
  }

  restoreLayout() {}

  onAssetsReady() {}

  /** Per-frame update — astronauts, badges, windmills, fauna. No navigation grid yet, so
   * astronauts walk straight to their site rather than routing around a tower in the way;
   * acceptable at this deck's scale, worth revisiting if it ever looks wrong. */
  update(dt, elapsed, focus) {
    // Each system gets its own try/catch: a throw in one used to kill every frame after it for
    // the whole page (the caller's own frame loop has no error handling at all, and an uncaught
    // exception there stops `requestAnimationFrame` from ever being asked for again — "the
    // screen went black" after the first few astronauts walked in, with nothing in between).
    let night = 0
    try {
      if (focus) this.sky.setFocus(focus)
      const cycled = this.sky.update(dt, elapsed, this.camera)
      if (cycled) this.settings.values.timeOfDay = this.sky.time
      night = this.sky.nightFactor ?? 0
    } catch (err) {
      console.error('tower-colony: sky update failed', err)
    }
    try {
      if (this.island) {
        this.island.update(dt, elapsed)
        this.island.setDaylight(this.sky.dayFactor ?? 1)
      }
      this.rock?.update(dt, elapsed)
    } catch (err) {
      console.error('tower-colony: island update failed', err)
    }
    try {
      this.astronauts.update(dt, elapsed)
    } catch (err) {
      console.error('tower-colony: astronauts update failed', err)
    }
    try {
      this.indicators.update(this.astronauts.agents, elapsed, (a) => this._badgeFor(a))
    } catch (err) {
      console.error('tower-colony: indicators update failed', err)
    }
    try {
      this._updateBeacons(elapsed)
    } catch (err) {
      console.error('tower-colony: beacon update failed', err)
    }
    this.spinWindmills(dt)
    try {
      this.fauna.update(dt, elapsed, this.camera, night, this.faunaHooks)
    } catch (err) {
      console.error('tower-colony: fauna update failed', err)
    }
  }
}
