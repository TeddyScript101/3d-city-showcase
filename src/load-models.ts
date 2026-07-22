import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { MODEL_SLUGS, type ModelSlug } from './models.ts'

const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderPath('/draco/')

const loader = new GLTFLoader()
loader.setDRACOLoader(dracoLoader)

function loadModel(slug: ModelSlug): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    loader.load(
      `/assets/models/${slug}.glb`,
      (gltf) => resolve(gltf.scene),
      undefined,
      (error) => reject(new Error(`Failed to load ${slug}: ${error}`)),
    )
  })
}

export async function loadAllModels(): Promise<Record<ModelSlug, THREE.Group>> {
  const entries = await Promise.all(
    MODEL_SLUGS.map(async (slug) => [slug, await loadModel(slug)] as const),
  )
  return Object.fromEntries(entries) as Record<ModelSlug, THREE.Group>
}
