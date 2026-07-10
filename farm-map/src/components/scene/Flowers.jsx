// Instanced flowers for one planting, scattered across a zone footprint.
// Blooms turn their vivid color inside the bloom window and fade to foliage
// green otherwise, so scrubbing the date visibly changes the farm.

import { useMemo } from 'react'
import { Instances, Instance } from '@react-three/drei'
import { bloomStatus } from '../../lib/bloom.js'

// Deterministic scatter so flowers don't jump around between renders.
function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashId(id) {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const CAP = 60 // keep instance counts sane

export default function Flowers({ planting, footprint, todayMMDD }) {
  const [w, d] = footprint
  const status = bloomStatus(planting, todayMMDD)
  const blooming = status.state === 'blooming'

  const points = useMemo(() => {
    const rand = mulberry32(hashId(planting.id))
    const n = Math.min(planting.count, CAP)
    const pad = 0.7
    const arr = []
    for (let i = 0; i < n; i++) {
      const x = (rand() - 0.5) * (w - pad)
      const z = (rand() - 0.5) * (d - pad)
      const jitter = 0.85 + rand() * 0.3
      arr.push([x, z, jitter])
    }
    return arr
  }, [planting.id, planting.count, w, d])

  const stemH = Math.min(planting.height, 2.4)
  const bloomColor = blooming ? planting.bloomColor : planting.foliage
  const bloomR = blooming ? 0.16 : 0.11
  const emissive = blooming ? planting.bloomColor : '#000000'
  const emissiveIntensity = blooming ? 0.25 : 0

  return (
    <group>
      {/* stems */}
      <Instances limit={CAP} castShadow>
        <cylinderGeometry args={[0.02, 0.03, 1, 5]} />
        <meshStandardMaterial color={planting.foliage} />
        {points.map(([x, z, j], i) => (
          <Instance key={i} position={[x, (stemH * j) / 2, z]} scale={[1, stemH * j, 1]} />
        ))}
      </Instances>
      {/* blooms */}
      <Instances limit={CAP} castShadow>
        <sphereGeometry args={[bloomR, 8, 8]} />
        <meshStandardMaterial
          color={bloomColor}
          emissive={emissive}
          emissiveIntensity={emissiveIntensity}
          roughness={0.7}
        />
        {points.map(([x, z, j], i) => (
          <Instance key={i} position={[x, stemH * j, z]} scale={0.85 + j * 0.4} />
        ))}
      </Instances>
    </group>
  )
}
