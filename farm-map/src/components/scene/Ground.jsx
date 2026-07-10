// The terrain: a grassy plane, a gravel path up to the farmhouse, and a
// low split-rail fence around the property edge.

import { useMemo } from 'react'
import { Instances, Instance } from '@react-three/drei'

export default function Ground({ terrain }) {
  const half = terrain.size / 2

  const posts = useMemo(() => {
    const out = []
    const step = 4
    for (let p = -half; p <= half; p += step) {
      out.push([p, 0, -half])
      out.push([p, 0, half])
      out.push([-half, 0, p])
      out.push([half, 0, p])
    }
    return out
  }, [half])

  return (
    <group>
      {/* grass */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[terrain.size, terrain.size]} />
        <meshStandardMaterial color={terrain.color} roughness={1} />
      </mesh>

      {/* gravel path to the farmhouse porch */}
      <mesh position={[0, 0.02, -6]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[3, 28]} />
        <meshStandardMaterial color="#c9bd9e" roughness={1} />
      </mesh>

      {/* fence posts + rails */}
      <Instances limit={posts.length} castShadow>
        <boxGeometry args={[0.18, 1.1, 0.18]} />
        <meshStandardMaterial color="#7a6647" roughness={0.9} />
        {posts.map((p, i) => (
          <Instance key={i} position={[p[0], 0.55, p[2]]} />
        ))}
      </Instances>
    </group>
  )
}
