import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { part, atlasTexture, ATLAS, CELL, cellMask } from '../world/kit.js'

/**
 * One tower's mesh: whole KayKit *Space Base Bits* modules stacked straight up, one per level,
 * with an occasional container bolted onto the side of an upper floor — built up over time by
 * however many agents finished work here, not planned as one recipe the way the original
 * bot-crossing buildings are. New, standalone module: does not import from or touch
 * `src/world/buildings.js`, which stays exactly as upstream bot-crossing shipped it.
 *
 * Deliberately simpler than that file's own building pipeline: no construction-reveal shader,
 * no per-vertex spin, no per-cell roughness/metalness or night glow. It does borrow the one
 * piece of that pipeline this view actually needs — recolouring just the atlas's gold TRIM
 * swatch (see `kit.js`) rather than the whole model — since that trim is the "little yellow
 * shields" every kit part carries, and tinting the *whole* mesh instead (an earlier pass here)
 * just washed the entire tower toward one flat colour.
 */

const DECK = 1.0
const SCALE = 1.45

const BASE_MODULES = ['basemodule_A', 'basemodule_B', 'basemodule_C', 'basemodule_D']
const ROOF_MODULES = ['roofmodule_base', 'roofmodule_cargo_A', 'roofmodule_cargo_B']
const CONTAINERS = ['containers_A', 'containers_B', 'containers_C', 'containers_D']

const pick = (rand, list) => list[Math.floor(rand() * list.length)]

/** A tiny seeded PRNG, so a given tower looks the same on every rebuild until it grows. */
function mulberry(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Same one-swatch repaint `world/buildings.js` uses (see its `decorate()`), stripped down to
// just the part this view needs: no construction-sink, no per-vertex spin, no night emissive.
// One material per accent colour, cached, so a whole skyline of towers is still a handful of
// shader variants rather than one compile per tower.
const CELL_COUNT = ATLAS.cols * ATLAS.rows
const TRIM_MASK = cellMask([CELL.TRIM])
const materials = new Map()
function accentMaterial(accent = 0xffffff) {
  let mat = materials.get(accent)
  if (mat) return mat
  mat = new THREE.MeshStandardMaterial({ map: atlasTexture(), roughness: 0.6, metalness: 0.05 })
  const uAccent = new THREE.Color(accent)
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAccent = { value: uAccent }
    shader.uniforms.uCellAccent = { value: TRIM_MASK }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vAtlasUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvAtlasUv = uv;`)
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec2 vAtlasUv;
         uniform vec3 uAccent;
         uniform float uCellAccent[ ${CELL_COUNT} ];
         int atlasCell() {
           int cx = int( clamp( floor( vAtlasUv.x * ${ATLAS.cols}.0 ), 0.0, ${ATLAS.cols - 1}.0 ) );
           int cy = int( clamp( floor( vAtlasUv.y * ${ATLAS.rows}.0 ), 0.0, ${ATLAS.rows - 1}.0 ) );
           return cy * ${ATLAS.cols} + cx;
         }`
      )
      // Luminance carries the swatch's own gradient across, so the trim keeps its shading
      // instead of going flat the moment it changes colour — same trick `buildings.js` uses.
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         float accentAmount = uCellAccent[ atlasCell() ];
         if ( accentAmount > 0.0 ) {
           float lum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
           diffuseColor.rgb = mix( diffuseColor.rgb, uAccent * clamp( lum * 1.9, 0.3, 1.5 ), accentAmount );
         }`
      )
  }
  materials.set(accent, mat)
  return mat
}

/**
 * @param {number} seed     stable per tower, so re-rolling the same tower id looks the same
 * @param {number} levels   how many modules tall, >= 1
 * @param {number} [accent] this tower's colour — replaces only the atlas's gold trim swatch,
 *                          everywhere it appears on this tower; every other swatch (structural
 *                          panel, glass, grey trim) stays the kit's own native colour
 */
export function createTowerMesh(seed, levels, accent) {
  const rand = mulberry(seed)
  const n = Math.max(1, Math.round(levels))
  const parts = []

  for (let i = 0; i < n; i++) {
    parts.push(part(pick(rand, BASE_MODULES)).translate(0, i * DECK, 0))
    if (i > 0 && rand() > 0.4) {
      const side = part(pick(rand, CONTAINERS))
      const x = (rand() > 0.5 ? 1 : -1) * 1.2
      const z = (rand() - 0.5) * 1.6
      side.rotateY(rand() * Math.PI * 2)
      side.translate(x, i * DECK, z)
      parts.push(side)
    }
  }
  parts.push(part(pick(rand, ROOF_MODULES)).translate(0, n * DECK, 0))

  // Not `computeVertexNormals()` — the source parts already carry the kit's own per-face
  // normals, and recomputing after a merge would smooth across seams between separate parts
  // that happen to share edge vertices, softening the pack's deliberately faceted look.
  const geo = BufferGeometryUtils.mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  geo.scale(SCALE, SCALE, SCALE)
  geo.computeBoundingBox()

  const mesh = new THREE.Mesh(geo, accentMaterial(accent))
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

/**
 * A decorative wind turbine for an empty deck slot — same kit part the original bot-crossing
 * `antenna` building uses, but built as two real Object3D meshes (mast + rotor) instead of
 * one merged draw call with a custom vertex-shader spin: there are only ever a handful of
 * these on one deck, so a plain `rotor.rotation.y += ...` each frame is simpler and plenty
 * cheap, without needing buildings.js's per-vertex pivot machinery at all.
 *
 * @returns {{ group: THREE.Group, rotor: THREE.Mesh }} rotor is the part to spin per frame
 */
export function createWindmill(seed, accent) {
  const rand = mulberry(seed)
  const tall = rand() > 0.4
  const name = tall ? 'windturbine_tall' : 'windturbine_low'
  const hubY = (tall ? 2.05 : 0.89) * SCALE

  const mastGeo = part(name, 'base', { solo: true })
  mastGeo.scale(SCALE, SCALE, SCALE)
  const mast = new THREE.Mesh(mastGeo, accentMaterial(accent))
  mast.castShadow = true

  // Not `solo` — that map only ever holds nodes that are themselves a mesh (see kit.js's
  // `harvest`), and the original `antenna` building doesn't request it solo either; `parts`
  // is the one guaranteed to have every named node, fan included.
  const rotorGeo = part(`${name}_fan`, 'base')
  rotorGeo.scale(SCALE, SCALE, SCALE)
  const rotor = new THREE.Mesh(rotorGeo, accentMaterial(accent))
  rotor.position.y = hubY
  rotor.castShadow = true

  const group = new THREE.Group()
  group.add(mast, rotor)
  return { group, rotor, speed: 0.5 + rand() * 0.4 }
}
