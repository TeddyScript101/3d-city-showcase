import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { loadAllModels } from './load-models.ts'
import { buildCity, type CityVehicle, type TrafficBulb } from './city-layout.ts'
import { CameraDirector } from './camera-director.ts'

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <canvas id="scene"></canvas>
  <div id="camera-switcher">
    <button data-mode="orbit" class="active">Orbit</button>
    <button data-mode="dynamic">Dynamic</button>
    <button data-mode="follow">Follow Car</button>
    <button data-mode="free">Free</button>
  </div>
  <div id="info-overlay">
    <h1>3D City Showcase</h1>
    <p>Drag to rotate &middot; scroll to zoom &middot; switch camera mode top-left</p>
  </div>
  <div id="loading-overlay">
    <div class="spinner"></div>
    <p>Loading city&hellip;</p>
  </div>
`
const canvas = document.querySelector<HTMLCanvasElement>('#scene')!

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x87ceeb)

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
)
camera.position.set(15, 12, 15)

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

const ambientLight = new THREE.AmbientLight(0xfff4e0, 0.5)
scene.add(ambientLight)

const sunLight = new THREE.DirectionalLight(0xfff1d0, 2)
sunLight.position.set(10, 20, 10)
scene.add(sunLight)

const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x6f9a52 })
const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), groundMaterial)
ground.rotation.x = -Math.PI / 2
// Sits slightly below y=0 so it doesn't z-fight with road/plaza tiles resting at y=0.
ground.position.y = -0.05
scene.add(ground)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0, 0)
controls.enableDamping = true
controls.autoRotate = true
controls.autoRotateSpeed = 0.6

const director = new CameraDirector()

// The overview position/target set once the city finishes loading, so
// switching back to orbit mode can zoom back out to it.
const defaultCameraPosition = new THREE.Vector3()
const defaultTarget = new THREE.Vector3()

let followMode = false
let followAngle = 0

const cameraButtons = document.querySelectorAll<HTMLButtonElement>('#camera-switcher button')
cameraButtons.forEach((button) => {
  button.addEventListener('click', () => {
    cameraButtons.forEach((b) => b.classList.remove('active'))
    button.classList.add('active')
    const mode = button.dataset.mode
    director.stop()
    controls.autoRotate = false
    controls.enabled = true
    followMode = false
    if (mode === 'dynamic') {
      controls.enabled = false
      director.start(camera, controls, timer.getElapsed())
    } else if (mode === 'orbit') {
      camera.position.copy(defaultCameraPosition)
      controls.target.copy(defaultTarget)
      controls.autoRotate = true
    } else if (mode === 'follow') {
      controls.enabled = false
      followMode = true
    } else if (mode === 'free') {
      camera.position.copy(defaultCameraPosition)
      controls.target.copy(defaultTarget)
    }
    // 'free' resets to the default overview position, then stays fully static until dragged.
  })
})

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

let vehicles: CityVehicle[] = []
let roadHalfSpan = 0
let trafficBulbs: TrafficBulb[] = []
const timer = new THREE.Timer()

// One global synchronized signal: X-axis traffic gets the green/yellow
// window for half the cycle, then Z-axis gets the other half. Purely
// decorative now — cars drive through regardless (see chat: removing the
// stop-at-red behavior looked better than cars actually stopping).
const GREEN_SECONDS = 5
const YELLOW_SECONDS = 1.2
const PHASE_SECONDS = GREEN_SECONDS + YELLOW_SECONDS
const FULL_CYCLE_SECONDS = PHASE_SECONDS * 2

function signalFor(axis: 'x' | 'z', elapsed: number): 'green' | 'yellow' | 'red' {
  const t = elapsed % FULL_CYCLE_SECONDS
  const activeAxis: 'x' | 'z' = t < PHASE_SECONDS ? 'x' : 'z'
  if (axis !== activeAxis) return 'red'
  const tInPhase = t < PHASE_SECONDS ? t : t - PHASE_SECONDS
  return tInPhase < GREEN_SECONDS ? 'green' : 'yellow'
}

function animate() {
  requestAnimationFrame(animate)
  timer.update()
  const delta = timer.getDelta()
  const elapsed = timer.getElapsed()

  for (const vehicle of vehicles) {
    const axis = vehicle.axis
    vehicle.obj.position[axis] += vehicle.speed * delta
    if (vehicle.obj.position[axis] > roadHalfSpan) vehicle.obj.position[axis] = -roadHalfSpan
    if (vehicle.obj.position[axis] < -roadHalfSpan) vehicle.obj.position[axis] = roadHalfSpan
  }

  for (const bulb of trafficBulbs) {
    const signal = signalFor(bulb.axis, elapsed)
    const color = signal === 'green' ? 0x22ff44 : signal === 'yellow' ? 0xffdd00 : 0xff2222
    bulb.material.color.setHex(color)
    bulb.material.emissive.setHex(color)
  }

  if (director.active) director.update(camera, controls, elapsed)

  if (followMode && vehicles.length > 0) {
    const target = vehicles[0]!.obj.position
    followAngle += delta * 0.6
    const radius = 9
    const height = 4.5
    camera.position.set(target.x + Math.cos(followAngle) * radius, height, target.z + Math.sin(followAngle) * radius)
    controls.target.set(target.x, height * 0.3, target.z)
  }

  controls.update()
  renderer.render(scene, camera)
}
animate()

loadAllModels().then((models) => {
  document.querySelector<HTMLDivElement>('#loading-overlay')?.remove()

  const {
    citySpan,
    vehicles: cityVehicles,
    trafficBulbs: cityTrafficBulbs,
  } = buildCity(scene, models)
  vehicles = cityVehicles
  trafficBulbs = cityTrafficBulbs
  roadHalfSpan = citySpan / 2
  director.setCitySpan(citySpan)

  ground.scale.set(citySpan * 3, citySpan * 3, 1)

  // Mobile screens are narrower, so the default framing crops more of the
  // city into view; pull the camera back further to compensate.
  const isMobile = window.innerWidth <= 768
  const cameraDistance = citySpan * (isMobile ? 1.35 : 0.9)
  camera.position.set(cameraDistance, cameraDistance * 0.7, cameraDistance)
  camera.far = cameraDistance * 10
  camera.updateProjectionMatrix()
  controls.update()
  defaultCameraPosition.copy(camera.position)
  defaultTarget.copy(controls.target)

  sunLight.position.set(citySpan * 0.5, citySpan * 0.8, citySpan * 0.5)
})
