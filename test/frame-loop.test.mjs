import test from 'node:test'
import assert from 'node:assert/strict'
import { FrameLoop, frameRate } from '../src/core/frame-loop.js'
import { Engine } from '../src/core/engine.js'
import { Settings } from '../src/core/settings.js'

function fixture(refresh = 60) {
  let now = 0
  let seq = 0
  let fps = 24
  const jobs = new Map()
  const draws = []
  const add = (fn, time) => { const id = ++seq; jobs.set(id, { fn, time }); return id }
  const clock = {
    now: () => now,
    request: fn => add(fn, (Math.floor(now / (1000 / refresh) + 1e-6) + 1) * (1000 / refresh)),
    cancel: id => jobs.delete(id),
    delay: (fn, ms) => add(fn, now + ms),
    clear: id => jobs.delete(id),
  }
  const loop = new FrameLoop(() => draws.push(now), () => fps, clock)
  function advance(ms) {
    const end = now + ms
    let steps = 0
    while (jobs.size) {
      const [id, job] = [...jobs.entries()].sort((a, b) => a[1].time - b[1].time)[0]
      if (job.time > end) break
      assert.ok(++steps < 10000, 'scheduler must yield rather than busy-loop')
      jobs.delete(id)
      now = job.time
      job.fn()
    }
    now = end
  }
  return { loop, draws, jobs, advance, setFps: n => { fps = n } }
}

test('battery policy keeps idle motion and pauses only hidden pages', () => {
  assert.equal(frameRate({ saver: true, focused: true, idle: false }), 24)
  assert.equal(frameRate({ saver: true, focused: true, idle: true }), 12)
  assert.equal(frameRate({ saver: true, focused: false }), 10)
  assert.equal(frameRate({ saver: false }), 60)
  assert.equal(frameRate({ hidden: true, saver: false }), 0)
})

for (const refresh of [60, 120, 144]) {
  test(`render budget stays near 24 fps on a ${refresh} Hz display`, () => {
    const f = fixture(refresh)
    f.loop.start()
    f.loop.start()
    f.advance(10000)
    assert.ok(f.draws.length >= 238 && f.draws.length <= 241, `${f.draws.length} frames`)
    assert.equal(f.jobs.size, 1, 'only one callback is scheduled')
    f.loop.stop()
    assert.equal(f.jobs.size, 0)
  })
}

test('idle frames continue, hidden cancels all work, resume has no catch-up burst', () => {
  const f = fixture()
  f.setFps(12)
  f.loop.start()
  f.advance(1000)
  assert.ok(f.draws.length >= 11 && f.draws.length <= 13)
  f.loop.stop()
  const before = f.draws.length
  f.advance(60000)
  assert.equal(f.draws.length, before)
  assert.equal(f.jobs.size, 0)
  f.setFps(24)
  f.loop.start()
  f.advance(1000)
  assert.ok(f.draws.length - before >= 23 && f.draws.length - before <= 25)
})

test('hidden policy stops before invoking updates or rendering', () => {
  const f = fixture()
  f.setFps(0)
  f.loop.start()
  f.advance(1000)
  assert.equal(f.draws.length, 0)
  assert.equal(f.jobs.size, 0)
  assert.equal(f.loop.running, false)
})

test('battery saver limits high-density pixels without raising a lower render scale', () => {
  const previous = globalThis.window
  globalThis.window = { devicePixelRatio: 2 }
  try {
    const values = { renderScale: 1, batterySaver: true }
    const engine = Object.create(Engine.prototype)
    engine.settings = { get: key => values[key] }
    assert.equal(engine._targetScale(), 1.25)
    values.renderScale = 0.5
    assert.equal(engine._targetScale(), 1)
    values.batterySaver = false
    values.renderScale = 1
    assert.equal(engine._targetScale(), 2)
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
})

test('existing installs gain battery saver without overwriting an explicit opt-out', () => {
  const previous = globalThis.localStorage
  let stored = JSON.stringify({ preset: 'high' })
  globalThis.localStorage = { getItem: () => stored }
  try {
    const settings = new Settings()
    assert.equal(settings.get('batterySaver'), true)
    assert.equal(settings.get('preset'), 'high')
    stored = JSON.stringify({ batterySaver: false })
    assert.equal(new Settings().get('batterySaver'), false)
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

test('adaptive quality does not mistake intentionally low frame rates for an overloaded GPU', () => {
  const previous = globalThis.window
  globalThis.window = { devicePixelRatio: 1 }
  try {
    const engine = Object.create(Engine.prototype)
    engine._targetScale = () => 1
    engine.viewport = { scale: 1 }
    engine.canvas = { parentElement: { clientWidth: 640, clientHeight: 400 } }
    for (const target of [10, 12, 24]) {
      engine._targetFps = target
      engine.perf = { fps: target }
      for (let i = 0; i < 12; i++) {
        engine._lastGovern = -Infinity
        engine._governQuality()
      }
      assert.equal(engine.viewport.scale, 1)
    }
    engine.perf.fps = 8
    for (let i = 0; i < 3; i++) {
      engine._lastGovern = -Infinity
      engine._governQuality()
    }
    assert.ok(engine.viewport.scale < 1, 'genuine overload still reduces resolution')
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
})
