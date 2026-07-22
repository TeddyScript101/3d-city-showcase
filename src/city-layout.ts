import * as THREE from 'three'
import type { ModelSlug } from './models.ts'

type ModelMap = Record<ModelSlug, THREE.Group>

function getFootprint(model: THREE.Object3D): THREE.Vector3 {
  const box = new THREE.Box3().setFromObject(model)
  const size = new THREE.Vector3()
  box.getSize(size)
  return size
}

interface PlaceOptions {
  rotationY?: number
  scale?: number | { x?: number; z?: number }
  // Y height of the surface this object sits on (e.g. a plaza tile's own
  // thickness), so it rests on TOP of that surface instead of being
  // embedded inside it, which is a z-fighting/flicker trap.
  surfaceY?: number
}

function place(
  models: ModelMap,
  slug: ModelSlug,
  x: number,
  z: number,
  { rotationY = 0, scale = 1, surfaceY = 0 }: PlaceOptions = {},
): THREE.Object3D {
  const clone = models[slug].clone(true)
  if (typeof scale === 'number') {
    clone.scale.setScalar(scale)
  } else {
    clone.scale.set(scale.x ?? 1, 1, scale.z ?? 1)
  }
  clone.rotation.y = rotationY
  // Many of these models are pivoted at their vertical center rather than
  // their base, so lift each one by its own (post-scale) bounding-box minimum.
  const baseY = surfaceY - new THREE.Box3().setFromObject(clone).min.y
  clone.position.set(x, baseY, z)
  return clone
}

// These GLBs use a shared vertex-color material, so hue-shifting each
// instance's material.color gives every building a distinct paint job
// without needing separate texture variants.
function tintObject(obj: THREE.Object3D, hueShift: number, satShift: number, lightShift: number): void {
  obj.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    const tinted = materials.map((material) => {
      const clone = material.clone()
      if (clone instanceof THREE.MeshStandardMaterial) {
        clone.color.offsetHSL(hueShift, satShift, lightShift)
      }
      return clone
    })
    child.material = Array.isArray(child.material) ? tinted : tinted[0]!
  })
}

function weightedPick(random: () => number, items: [ModelSlug, number][]): ModelSlug {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0)
  let r = random() * total
  for (const [slug, weight] of items) {
    if (r < weight) return slug
    r -= weight
  }
  return items[items.length - 1]![0]
}

// Deterministic PRNG so re-running the layout produces the same city.
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const HALF_PI = Math.PI / 2
const GRID_SIZE = 5 // intersections per axis -> (GRID_SIZE-1)^2 building plots

// This single block becomes a park instead of buildings (block indices run
// 0..GRID_SIZE-2).
const PARK_BLOCK_I = 1
const PARK_BLOCK_J = 1
const isParkBlock = (i: number, j: number): boolean => i === PARK_BLOCK_I && j === PARK_BLOCK_J

const BUILDING_SLUGS: ModelSlug[] = [
  'apartment-block-01',
  'glass-skyscraper-01',
  'corner-store-01',
  'convenience-store-01',
]

const BUILDING_WEIGHTS: [ModelSlug, number][] = [
  ['apartment-block-01', 1],
  ['glass-skyscraper-01', 2],
  ['corner-store-01', 1],
  ['convenience-store-01', 2.5],
]

const FURNITURE_SLUGS: ModelSlug[] = [
  'shop-awning-01',
  'street-lamp-01',
  'bench-01',
  'trash-bin-01',
  'street-sign-01',
  'bus-shelter-01',
]

// Trees weighted heavier so plots feel greener overall.
const GREENERY_WEIGHTS: [ModelSlug, number][] = [
  ['street-tree-01', 2.5],
  ['flower-planter-01', 1],
  ['grass-verge-01', 1],
]

export interface CityVehicle {
  obj: THREE.Object3D
  axis: 'x' | 'z'
  speed: number
}

export interface TrafficBulb {
  material: THREE.MeshStandardMaterial
  // Which travel axis this light governs, so it can be driven by the same
  // global signal used for its color-cycling animation.
  axis: 'x' | 'z'
}

export interface CityResult {
  citySpan: number
  vehicles: CityVehicle[]
  trafficBulbs: TrafficBulb[]
}

// traffic-light-01 is a single mesh with one shared vertex-color material,
// so there's no separate red/yellow/green bulb to recolor. Instead, stick a
// small glowing sphere near the head that we can actually cycle at runtime.
function attachTrafficBulb(obj: THREE.Object3D, axis: 'x' | 'z', bulbs: TrafficBulb[]): void {
  const worldTop = new THREE.Box3().setFromObject(obj).max.y
  const localHeight = worldTop - obj.position.y
  const material = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff2222, emissiveIntensity: 1.2 })
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), material)
  bulb.position.set(0, localHeight * 0.92, 0)
  obj.add(bulb)
  bulbs.push({ material, axis })
}

export function buildCity(scene: THREE.Scene, models: ModelMap): CityResult {
  const random = mulberry32(42)
  const vehicles: CityVehicle[] = []
  const trafficBulbs: TrafficBulb[] = []

  const buildingFootprint = Math.max(
    ...BUILDING_SLUGS.map((slug) => {
      const size = getFootprint(models[slug])
      return Math.max(size.x, size.z)
    }),
  )

  const blockSize = buildingFootprint * 1.9
  const roadWidth = getFootprint(models['road-straight-01']).x
  const pitch = roadWidth + blockSize
  const half = (GRID_SIZE - 1) / 2
  const gridPos = (i: number) => (i - half) * pitch

  // The plaza (where buildings sit) is inset from the road by a sidewalk
  // ring, so pedestrians have a visible buffer between a building's door
  // and traffic instead of the plaza butting straight onto the road.
  const sidewalkMargin = blockSize * 0.1
  const plotFillSize = blockSize - sidewalkMargin * 2

  const roadScale = blockSize / getFootprint(models['road-straight-01']).z
  const plazaScale = plotFillSize / getFootprint(models['plaza-paving-01']).x
  // Ground-tile thickness (Y is never scaled), so anything sitting on top of
  // a plaza/road is placed on its actual surface instead of embedded in it.
  const plazaSurfaceY = getFootprint(models['plaza-paving-01']).y
  const roadSurfaceY = getFootprint(models['road-straight-01']).y
  // Sits just below the plaza's own bottom face (both rest on y=0) so it
  // peeks out as a curb ring around the plaza without z-fighting it.
  const sidewalkY = -0.02
  const sidewalkMaterial = new THREE.MeshStandardMaterial({ color: 0xb9b2a4 })

  const roadBoxes: THREE.Box3[] = []

  // Intersections, one at every grid point.
  for (let i = 0; i < GRID_SIZE; i++) {
    for (let j = 0; j < GRID_SIZE; j++) {
      const obj = place(models, 'road-intersection-01', gridPos(i), gridPos(j))
      scene.add(obj)
      roadBoxes.push(new THREE.Box3().setFromObject(obj))
    }
  }

  // Road segments connecting every adjacent pair of intersections.
  for (let i = 0; i < GRID_SIZE; i++) {
    for (let j = 0; j < GRID_SIZE; j++) {
      if (i < GRID_SIZE - 1) {
        const x = (gridPos(i) + gridPos(i + 1)) / 2
        const z = gridPos(j)
        const obj = place(models, 'road-straight-01', x, z, { rotationY: HALF_PI, scale: { z: roadScale } })
        scene.add(obj)
        roadBoxes.push(new THREE.Box3().setFromObject(obj))
      }
      if (j < GRID_SIZE - 1) {
        const x = gridPos(i)
        const z = (gridPos(j) + gridPos(j + 1)) / 2
        const obj = place(models, 'road-straight-01', x, z, { scale: { z: roadScale } })
        scene.add(obj)
        roadBoxes.push(new THREE.Box3().setFromObject(obj))
      }
    }
  }

  // Building plots fill the (GRID_SIZE-1)^2 blocks between the roads.
  // Candidate furniture spots around the plot edge, as unit vectors so a
  // given radius is the true distance from plot center in every direction
  // (an un-normalized [1,1] would overshoot by sqrt(2) and land past the
  // plot boundary, onto the road or even into the neighboring plot).
  const DIAG = Math.SQRT1_2
  const DIAGONAL_CANDIDATES = [
    [DIAG, DIAG],
    [-DIAG, -DIAG],
    [DIAG, -DIAG],
    [-DIAG, DIAG],
  ] as const
  const CORNER_CANDIDATES = [
    ...DIAGONAL_CANDIDATES,
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const

  const decorationBoxes: THREE.Box3[] = []
  let furnitureIndex = 0
  let parkX = 0
  let parkZ = 0
  for (let i = 0; i < GRID_SIZE - 1; i++) {
    for (let j = 0; j < GRID_SIZE - 1; j++) {
      const x = (gridPos(i) + gridPos(i + 1)) / 2
      const z = (gridPos(j) + gridPos(j + 1)) / 2

      const sidewalk = new THREE.Mesh(new THREE.PlaneGeometry(blockSize, blockSize), sidewalkMaterial)
      sidewalk.rotation.x = -HALF_PI
      sidewalk.position.set(x, sidewalkY, z)
      scene.add(sidewalk)

      if (isParkBlock(i, j)) {
        parkX = x
        parkZ = z
        continue
      }

      const plaza = place(models, 'plaza-paving-01', x, z, { scale: { x: plazaScale, z: plazaScale } })
      scene.add(plaza)

      const buildingSlug = weightedPick(random, BUILDING_WEIGHTS)
      const rotationY = Math.floor(random() * 4) * HALF_PI
      const jitterScale = 0.7 + random() * 0.3
      // Centered on the plot (not offset) so every side keeps the same
      // clearance from the road, regardless of which way the entrance faces.
      const buildingObj = place(models, buildingSlug, x, z, {
        rotationY,
        scale: jitterScale,
        surfaceY: plazaSurfaceY,
      })
      tintObject(buildingObj, (random() - 0.5) * 0.8, (random() - 0.5) * 0.25, (random() - 0.5) * 0.2)
      scene.add(buildingObj)
      const buildingBox = new THREE.Box3().setFromObject(buildingObj)

      // Street furniture + a guaranteed piece of greenery. Search a few
      // rings of candidate spots at increasing distance from the plot
      // center; if a piece genuinely can't fit without overlapping, skip it
      // rather than force an overlapping placement.
      // Furniture/greenery/traffic-light radii stay beyond plotFillSize/2 so
      // they land on the sidewalk ring, not on the plaza next to the building.
      const placeAvoidingOverlap = (
        slug: ModelSlug,
        directions: readonly (readonly number[])[] = CORNER_CANDIDATES,
        radiusFactors: number[] = [0.42, 0.45, 0.48],
      ): THREE.Object3D | null => {
        for (const radiusFactor of radiusFactors) {
          const radius = blockSize * radiusFactor
          const candidates = [...directions].sort(() => random() - 0.5)
          for (const [sx, sz] of candidates) {
            // Face outward, away from the plot center (toward the road),
            // which reads correctly for directional pieces like bus shelters.
            const attempt = place(models, slug, x + sx * radius, z + sz * radius, {
              rotationY: Math.atan2(sx, sz),
            })
            const attemptBox = new THREE.Box3().setFromObject(attempt)
            const blocked =
              buildingBox.intersectsBox(attemptBox) ||
              decorationBoxes.some((box) => box.intersectsBox(attemptBox)) ||
              roadBoxes.some((box) => box.intersectsBox(attemptBox))
            if (!blocked) {
              decorationBoxes.push(attemptBox)
              return attempt
            }
          }
        }
        return null
      }

      const furnitureSlug = FURNITURE_SLUGS[furnitureIndex % FURNITURE_SLUGS.length]!
      furnitureIndex += 1
      const greenerySlug = weightedPick(random, GREENERY_WEIGHTS)
      const furnitureObj = placeAvoidingOverlap(furnitureSlug)
      if (furnitureObj) scene.add(furnitureObj)
      const greeneryObj = placeAvoidingOverlap(greenerySlug)
      if (greeneryObj) scene.add(greeneryObj)

      // A second, guaranteed tree per plot so the whole map reads greener.
      const extraTreeObj = placeAvoidingOverlap('street-tree-01')
      if (extraTreeObj) scene.add(extraTreeObj)

      // Traffic light belongs at the plot corner nearest an intersection,
      // not scattered anywhere along the edge like the other furniture.
      const trafficLightObj = placeAvoidingOverlap('traffic-light-01', DIAGONAL_CANDIDATES, [0.48, 0.45, 0.42])
      if (trafficLightObj) {
        scene.add(trafficLightObj)
        attachTrafficBulb(trafficLightObj, random() < 0.5 ? 'x' : 'z', trafficBulbs)
      }

      // Sky Day Dome is a small decorative structure, not a skybox; the flat
      // scene background color handles the sky. Tuck it into one plot as a
      // landmark rather than floating off past the edge of the whole grid.
      if (i === 0 && j === 0) {
        const domeObj = placeAvoidingOverlap('sky-day-dome-01')
        if (domeObj) scene.add(domeObj)
      }
    }
  }

  // Park: this one block gets a green space with a lake instead of a
  // building, since there's no water/park asset in the kit.
  {
    const parkCenterX = parkX
    const parkCenterZ = parkZ
    const parkSizeX = plotFillSize
    const parkSizeZ = plotFillSize

    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(parkSizeX, parkSizeZ),
      new THREE.MeshStandardMaterial({ color: 0x5a9c4a }),
    )
    grass.rotation.x = -HALF_PI
    grass.position.set(parkCenterX, 0.02, parkCenterZ)
    scene.add(grass)

    const lakeRadius = Math.min(parkSizeX, parkSizeZ) * 0.28
    const lake = new THREE.Mesh(
      new THREE.CircleGeometry(lakeRadius, 32),
      new THREE.MeshStandardMaterial({ color: 0x2f6f9e, roughness: 0.15, metalness: 0.3 }),
    )
    lake.rotation.x = -HALF_PI
    lake.position.set(parkCenterX, 0.05, parkCenterZ)
    scene.add(lake)
    const lakeBox = new THREE.Box3().setFromObject(lake)

    // Scatter trees around the lake, away from each other and the water.
    const parkBoxes: THREE.Box3[] = [lakeBox]
    const treeCount = 6
    for (let n = 0; n < treeCount; n++) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const tx = parkCenterX + (random() - 0.5) * parkSizeX * 0.85
        const tz = parkCenterZ + (random() - 0.5) * parkSizeZ * 0.85
        const tree = place(models, 'street-tree-01', tx, tz, { rotationY: random() * Math.PI * 2 })
        const treeBox = new THREE.Box3().setFromObject(tree)
        if (!parkBoxes.some((box) => box.intersectsBox(treeBox))) {
          parkBoxes.push(treeBox)
          scene.add(tree)
          break
        }
      }
    }

    // Benches ringed around the water, facing in toward it.
    const benchCount = 4
    for (let n = 0; n < benchCount; n++) {
      const angle = (n / benchCount) * Math.PI * 2
      const sx = Math.cos(angle)
      const sz = Math.sin(angle)
      const bench = place(models, 'bench-01', parkCenterX + sx * lakeRadius * 1.4, parkCenterZ + sz * lakeRadius * 1.4, {
        rotationY: Math.atan2(-sx, -sz),
      })
      scene.add(bench)
    }
  }

  // A handful of vehicles driving along the road segments, skipping any spot
  // that would overlap a vehicle already placed. Each one drives the full
  // length of its lane (not just its starting segment) and wraps around
  // when it reaches the edge of the grid.
  const vehicleSlugs: ModelSlug[] = ['car-sedan-01', 'taxi-01']
  const vehicleBoxes: THREE.Box3[] = []
  const vehicleCount = 8
  // Vehicles loop forever on a closed track, so two same-direction cars on
  // the exact same lane (same axis + same cross-coordinate) MUST share one
  // speed — any difference means the faster one eventually laps into the
  // slower one from behind, no matter how their start positions are staggered.
  const laneSpeeds = new Map<string, number>()
  // Minimum following distance between two vehicles placed in the same lane,
  // so spawning never puts two cars visibly nose-to-tail even though their
  // shared speed keeps that gap constant forever after.
  const carLength = Math.max(
    ...vehicleSlugs.map((slug) => {
      const size = getFootprint(models[slug])
      return Math.max(size.x, size.z)
    }),
  )
  const minLaneGap = carLength * 4
  const laneOccupancy = new Map<string, number[]>()
  // Vehicles wrap around the same span (see animate()'s wraparound), so
  // spreading each one's starting position by an even fraction of the grid
  // pitch keeps them from bunching up and repeatedly meeting a
  // perpendicular car at the same intersection at the same time.
  const halfSpan = (gridPos(GRID_SIZE - 1) - gridPos(0) + roadWidth) / 2
  const wrapToSpan = (value: number): number => {
    const span = halfSpan * 2
    const wrapped = ((value + halfSpan) % span + span) % span
    return wrapped - halfSpan
  }
  for (let n = 0; n < vehicleCount; n++) {
    let placedVehicle: THREE.Object3D | null = null
    let placedAxis: 'x' | 'z' = 'x'
    let placedSpeed = 0
    for (let attempt = 0; attempt < 5 && !placedVehicle; attempt++) {
      const i = Math.floor(random() * (GRID_SIZE - 1))
      const j = Math.floor(random() * GRID_SIZE)
      const horizontal = random() < 0.5
      const phaseShift = (n / vehicleCount) * pitch
      const movingCoord = wrapToSpan((gridPos(i) + gridPos(i + 1)) / 2 + phaseShift)
      const x = horizontal ? movingCoord : gridPos(j)
      const z = horizontal ? gridPos(j) : movingCoord
      const slug = vehicleSlugs[n % vehicleSlugs.length]!
      const directionSign = random() < 0.5 ? 1 : -1
      const rotationY = horizontal ? (directionSign > 0 ? HALF_PI : -HALF_PI) : directionSign > 0 ? 0 : Math.PI
      // Left-hand traffic: which side of the centerline a car sits on is
      // determined by its direction of travel (not independently random),
      // so opposite-direction cars never end up sharing the same side.
      const lateralSign = horizontal ? -directionSign : directionSign
      const lateralOffset = roadWidth * 0.2 * lateralSign
      const vehicleX = horizontal ? x : x + lateralOffset
      const vehicleZ = horizontal ? z + lateralOffset : z
      const laneKey = `${horizontal ? 'x' : 'z'}:${(horizontal ? vehicleZ : vehicleX).toFixed(2)}`
      const tooClose = (laneOccupancy.get(laneKey) ?? []).some(
        (coord) => Math.abs(wrapToSpan(movingCoord - coord)) < minLaneGap,
      )
      const attemptObj = place(models, slug, vehicleX, vehicleZ, { rotationY, surfaceY: roadSurfaceY })
      const attemptBox = new THREE.Box3().setFromObject(attemptObj)
      // Some road segments near the park were never built, so confirm a
      // real road tile is actually there before parking a vehicle on it.
      const blocked =
        tooClose ||
        !roadBoxes.some((box) => box.intersectsBox(attemptBox)) ||
        vehicleBoxes.some((box) => box.intersectsBox(attemptBox)) ||
        decorationBoxes.some((box) => box.intersectsBox(attemptBox))
      if (!blocked) {
        placedVehicle = attemptObj
        placedAxis = horizontal ? 'x' : 'z'
        // Same lane (axis + exact cross-coordinate) always gets the same
        // speed magnitude, so following distance never closes to zero.
        const speedMagnitude = laneSpeeds.get(laneKey) ?? 3 + random() * 3
        laneSpeeds.set(laneKey, speedMagnitude)
        placedSpeed = directionSign * speedMagnitude
        vehicleBoxes.push(attemptBox)
        laneOccupancy.set(laneKey, [...(laneOccupancy.get(laneKey) ?? []), movingCoord])
      }
    }
    if (placedVehicle) {
      scene.add(placedVehicle)
      vehicles.push({ obj: placedVehicle, axis: placedAxis, speed: placedSpeed })
    }
  }

  return {
    citySpan: gridPos(GRID_SIZE - 1) - gridPos(0) + roadWidth,
    vehicles,
    trafficBulbs,
  }
}
