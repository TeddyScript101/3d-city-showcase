import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'

interface Viewpoint {
  position: THREE.Vector3
  target: THREE.Vector3
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

// Cycles the camera through a handful of scripted viewpoints (an overview,
// a couple of close street-level shots, a near-top-down, a skyline angle),
// smoothly lerping between them. Used for the "dynamic" camera mode.
export class CameraDirector {
  private viewpoints: Viewpoint[] = []
  private index = 0
  private from: Viewpoint = { position: new THREE.Vector3(), target: new THREE.Vector3() }
  private segmentStart = 0
  private readonly holdSeconds = 1
  private readonly transitionSeconds = 3.5
  active = false

  setCitySpan(citySpan: number): void {
    const s = citySpan
    this.viewpoints = [
      { position: new THREE.Vector3(s * 0.85, s * 0.65, s * 0.85), target: new THREE.Vector3(0, 0, 0) },
      { position: new THREE.Vector3(s * 0.24, s * 0.14, s * 0.3), target: new THREE.Vector3(0, s * 0.06, 0) },
      { position: new THREE.Vector3(-s * 0.35, s * 0.3, s * 0.1), target: new THREE.Vector3(0, s * 0.08, 0) },
      { position: new THREE.Vector3(s * 0.03, s * 0.9, s * 0.03), target: new THREE.Vector3(0, 0, 0) },
      { position: new THREE.Vector3(s * 0.45, s * 0.12, -s * 0.2), target: new THREE.Vector3(s * 0.1, s * 0.06, 0) },
      { position: new THREE.Vector3(-s * 0.15, s * 0.08, -s * 0.12), target: new THREE.Vector3(0, s * 0.05, 0) },
    ]
  }

  start(camera: THREE.PerspectiveCamera, controls: OrbitControls, elapsed: number): void {
    if (this.viewpoints.length === 0) return
    this.active = true
    this.index = 0
    this.from = { position: camera.position.clone(), target: controls.target.clone() }
    this.segmentStart = elapsed
  }

  stop(): void {
    this.active = false
  }

  update(camera: THREE.PerspectiveCamera, controls: OrbitControls, elapsed: number): void {
    if (!this.active || this.viewpoints.length === 0) return
    const cycle = this.holdSeconds + this.transitionSeconds
    let t = elapsed - this.segmentStart
    if (t > cycle) {
      const held = this.viewpoints[this.index]!
      this.from = { position: held.position.clone(), target: held.target.clone() }
      this.index = (this.index + 1) % this.viewpoints.length
      this.segmentStart = elapsed
      t = 0
    }
    const to = this.viewpoints[this.index]!
    if (t < this.transitionSeconds) {
      const k = easeInOutCubic(t / this.transitionSeconds)
      camera.position.lerpVectors(this.from.position, to.position, k)
      controls.target.lerpVectors(this.from.target, to.target, k)
    } else {
      camera.position.copy(to.position)
      controls.target.copy(to.target)
    }
  }
}
