// One farm zone rendered in 3D. Dispatches on zone.kind, scatters its
// plantings, and exposes click / hover for selection.

import { useMemo, useState } from 'react'
import { Html } from '@react-three/drei'
import Flowers from './Flowers.jsx'
import Tree from './Tree.jsx'
import { bloomStatus, zoneBloomState } from '../../lib/bloom.js'

function treeLayout(zone) {
  const [w, d] = zone.size
  const all = []
  for (const p of zone.plantings) {
    for (let i = 0; i < p.count; i++) all.push(p)
  }
  const n = all.length
  const cols = Math.max(1, Math.round(Math.sqrt((n * w) / d)))
  const rows = Math.ceil(n / cols)
  const out = []
  all.forEach((p, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    const x = ((c + 0.5) / cols - 0.5) * (w - 1.5)
    const z = ((r + 0.5) / rows - 0.5) * (d - 1.5)
    out.push({ p, x, z })
  })
  return out
}

export default function Zone({ zone, selected, todayMMDD, onSelect }) {
  const [hovered, setHovered] = useState(false)
  const [x, z] = zone.position
  const [w, d] = zone.size
  const bloom = zoneBloomState(zone, todayMMDD)

  const enter = () => {
    setHovered(true)
    document.body.style.cursor = 'pointer'
  }
  const leave = () => {
    setHovered(false)
    document.body.style.cursor = 'auto'
  }
  const click = (e) => {
    e.stopPropagation()
    onSelect(zone.id)
  }

  const trees = useMemo(
    () => (zone.kind === 'orchard' || zone.kind === 'water' ? treeLayout(zone) : []),
    [zone],
  )

  const highlight = selected ? '#fff4c2' : hovered ? '#e8ffd8' : null

  return (
    <group position={[x, 0, z]}>
      {/* selection / hover glow ring under the zone */}
      {highlight && (
        <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[w + 1.4, d + 1.4]} />
          <meshBasicMaterial color={highlight} transparent opacity={selected ? 0.55 : 0.3} />
        </mesh>
      )}

      {/* ---- structures (farmhouse, barn) ---- */}
      {zone.kind === 'structure' && (
        <group onClick={click} onPointerOver={enter} onPointerOut={leave}>
          <mesh position={[0, 1.6, 0]} castShadow receiveShadow>
            <boxGeometry args={[w, 3.2, d]} />
            <meshStandardMaterial color={zone.color} roughness={0.85} />
          </mesh>
          <mesh position={[0, 3.9, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
            <coneGeometry args={[Math.max(w, d) * 0.75, 2.2, 4]} />
            <meshStandardMaterial color="#4a3b32" roughness={0.9} />
          </mesh>
        </group>
      )}

      {/* ---- raised beds ---- */}
      {zone.kind === 'bed' && (
        <group>
          <mesh position={[0, 0.2, 0]} onClick={click} onPointerOver={enter} onPointerOut={leave}
            castShadow receiveShadow>
            <boxGeometry args={[w, 0.4, d]} />
            <meshStandardMaterial color="#5a4632" roughness={1} />
          </mesh>
          <group position={[0, 0.4, 0]}>
            {zone.plantings.map((p) =>
              p.kind === 'tree' ? null : (
                <Flowers key={p.id} planting={p} footprint={[w, d]} todayMMDD={todayMMDD} />
              ),
            )}
          </group>
        </group>
      )}

      {/* ---- open fields (lavender, meadow, sunflowers) ---- */}
      {zone.kind === 'field' && (
        <group>
          <mesh position={[0, 0.04, 0]} onClick={click} onPointerOver={enter} onPointerOut={leave}
            receiveShadow>
            <boxGeometry args={[w, 0.08, d]} />
            <meshStandardMaterial color={zone.color} roughness={1} />
          </mesh>
          <group position={[0, 0.08, 0]}>
            {zone.plantings.map((p) => (
              <Flowers key={p.id} planting={p} footprint={[w, d]} todayMMDD={todayMMDD} />
            ))}
          </group>
        </group>
      )}

      {/* ---- orchard ---- */}
      {zone.kind === 'orchard' && (
        <group>
          <mesh position={[0, 0.04, 0]} onClick={click} onPointerOver={enter} onPointerOut={leave}
            receiveShadow>
            <boxGeometry args={[w, 0.08, d]} />
            <meshStandardMaterial color={zone.color} roughness={1} />
          </mesh>
          {trees.map(({ p, x: tx, z: tz }, i) => {
            const s = bloomStatus(p, todayMMDD).state
            return (
              <Tree key={i} position={[tx, tz]} height={p.height}
                blossom={s === 'blooming'} blossomColor={p.bloomColor} />
            )
          })}
        </group>
      )}

      {/* ---- pond ---- */}
      {zone.kind === 'water' && (
        <group>
          <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}
            onClick={click} onPointerOver={enter} onPointerOut={leave} receiveShadow>
            <circleGeometry args={[Math.min(w, d) / 2, 40]} />
            <meshStandardMaterial color={zone.color} roughness={0.15} metalness={0.2}
              transparent opacity={0.85} />
          </mesh>
          {trees.map(({ p, x: tx, z: tz }, i) => {
            const angle = (i / trees.length) * Math.PI * 2
            const rx = Math.cos(angle) * (w / 2 - 0.5)
            const rz = Math.sin(angle) * (d / 2 - 0.5)
            const s = bloomStatus(p, todayMMDD).state
            return (
              <Tree key={i} position={[rx, rz]} height={p.height} weeping
                blossom={s === 'blooming'} blossomColor={p.bloomColor} />
            )
          })}
        </group>
      )}

      {/* label */}
      <Html position={[0, zone.kind === 'structure' ? 5.6 : 2.4, 0]} center distanceFactor={42}
        zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
        <div className={`zone-label ${selected ? 'is-selected' : ''} bloom-${bloom}`}>
          {zone.name}
        </div>
      </Html>
    </group>
  )
}
