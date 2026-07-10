// The immersive 3D view: canvas, lighting, sky, orbit controls, and every
// zone. Selection is lifted to the parent so the UI panels stay in sync.

import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Sky } from '@react-three/drei'
import Ground from './scene/Ground.jsx'
import Zone from './scene/Zone.jsx'
import { FARM } from '../data/farm.js'
import { dateToMMDD } from '../lib/bloom.js'

export default function FarmScene({ viewDate, selectedId, onSelect }) {
  const todayMMDD = dateToMMDD(viewDate)

  return (
    <Canvas
      shadows
      camera={{ position: [0, 34, 48], fov: 50, near: 0.1, far: 400 }}
      onPointerMissed={() => onSelect(null)}
      dpr={[1, 2]}
    >
      <color attach="background" args={['#bcd6e8']} />
      <fog attach="fog" args={['#c4d8e6', 70, 190]} />

      <Sky sunPosition={[40, 30, 20]} turbidity={6} rayleigh={1.2} mieCoefficient={0.006} />

      <hemisphereLight args={['#dfeeff', '#4a5b34', 0.7]} />
      <ambientLight intensity={0.25} />
      <directionalLight
        position={[38, 46, 22]}
        intensity={1.35}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-50}
        shadow-camera-right={50}
        shadow-camera-top={50}
        shadow-camera-bottom={-50}
        shadow-camera-near={1}
        shadow-camera-far={160}
        shadow-bias={-0.0004}
      />

      <Suspense fallback={null}>
        <Ground terrain={FARM.terrain} />
        {FARM.zones.map((zone) => (
          <Zone
            key={zone.id}
            zone={zone}
            selected={selectedId === zone.id}
            todayMMDD={todayMMDD}
            onSelect={onSelect}
          />
        ))}
      </Suspense>

      <OrbitControls
        target={[0, 0, 2]}
        enableDamping
        dampingFactor={0.08}
        minDistance={12}
        maxDistance={110}
        maxPolarAngle={Math.PI / 2.15}
      />
    </Canvas>
  )
}
