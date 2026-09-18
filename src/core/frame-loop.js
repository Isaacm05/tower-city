/** Sleep between frames instead of waking on every high-refresh display tick. */
export class FrameLoop {
  constructor(draw, frameRate, clock = {
    now: () => performance.now(),
    request: fn => requestAnimationFrame(fn),
    cancel: id => cancelAnimationFrame(id),
    delay: (fn, ms) => setTimeout(fn, ms),
    clear: id => clearTimeout(id),
  }) {
    this.draw = draw
    this.frameRate = frameRate
    this.clock = clock
    this.running = false
    this.raf = null
    this.timeout = null
    this.next = 0
  }

  start() {
    if (this.running) return
    this.running = true
    this.next = this.clock.now()
    this.raf = this.clock.request(() => this.tick())
  }

  stop() {
    this.running = false
    if (this.raf !== null) this.clock.cancel(this.raf)
    if (this.timeout !== null) this.clock.clear(this.timeout)
    this.raf = this.timeout = null
  }

  tick() {
    this.raf = null
    if (!this.running) return
    const fps = this.frameRate()
    if (!fps) { this.stop(); return }
    const now = this.clock.now()
    const interval = 1000 / fps
    // Small tolerance avoids dropping a frame to floating-point/vsync rounding.
    if (now >= this.next - 1) {
      this.draw()
      this.next = Math.max(this.next + interval, now)
    }
    if (!this.running) return
    // Let rAF align the actual draw to the display; the timer avoids needless callbacks.
    this.timeout = this.clock.delay(() => {
      this.timeout = null
      if (this.running) this.raf = this.clock.request(() => this.tick())
    }, Math.max(0, this.next - this.clock.now() - 4))
  }
}

export function frameRate({ hidden, focused, saver, idle }) {
  if (hidden) return 0
  if (!saver) return 60
  if (!focused) return 10
  return idle ? 12 : 24
}
