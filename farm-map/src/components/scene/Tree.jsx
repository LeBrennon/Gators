// A simple stylized tree: a trunk plus a couple of canopy blobs. When
// `blossom` is true (spring bloom window) the canopy is tinted toward the
// blossom color.

import { useMemo } from 'react'

export default function Tree({ position = [0, 0, 0], height = 3, canopyColor = '#3f5e34',
  blossom = false, blossomColor = '#f4b6c6', weeping = false }) {
  const trunkH = height * 0.45
  const canopyR = height * 0.32
  const color = blossom ? blossomColor : canopyColor

  const blobs = useMemo(() => {
    if (weeping) {
      return [
        [0, trunkH + canopyR * 0.5, 0, canopyR * 1.15],
        [canopyR * 0.5, trunkH + canopyR * 0.1, 0, canopyR * 0.8],
        [-canopyR * 0.5, trunkH + canopyR * 0.1, 0, canopyR * 0.8],
      ]
    }
    return [
      [0, trunkH + canopyR * 0.7, 0, canopyR],
      [canopyR * 0.55, trunkH + canopyR * 0.35, canopyR * 0.2, canopyR * 0.75],
      [-canopyR * 0.45, trunkH + canopyR * 0.4, -canopyR * 0.25, canopyR * 0.7],
    ]
  }, [trunkH, canopyR, weeping])

  return (
    <group position={[position[0], 0, position[1]]}>
      <mesh position={[0, trunkH / 2, 0]} castShadow>
        <cylinderGeometry args={[height * 0.06, height * 0.09, trunkH, 6]} />
        <meshStandardMaterial color="#6b4a2f" roughness={0.9} />
      </mesh>
      {blobs.map(([x, y, z, r], i) => (
        <mesh key={i} position={[x, y, z]} castShadow>
          <sphereGeometry args={[r, 10, 10]} />
          <meshStandardMaterial
            color={weeping ? '#6f9a4a' : color}
            roughness={0.85}
            emissive={blossom ? blossomColor : '#000000'}
            emissiveIntensity={blossom ? 0.15 : 0}
          />
        </mesh>
      ))}
    </group>
  )
}
