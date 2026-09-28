'use client'

import { useMemo, useRef, useSyncExternalStore } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'

import type { IncidentDetailDTO } from '@/lib/api/observability'
import { cn } from '@/lib/cn'
import { activeStage, type OperationalStage } from './command-center-model'

type NodeId = 'buildhub' | 'monitor' | 'analyzer' | 'coder' | 'critic' | 'judge' | 'risk' | 'human' | 'repair' | 'validation' | 'recovery' | 'learning'

const NODES: Array<{ id: NodeId; label: string; position: [number, number, number] }> = [
  { id: 'buildhub', label: 'BuildHub', position: [-3.0, 1.05, 0] },
  { id: 'monitor', label: 'Monitor', position: [-2.0, 0.35, 0.2] },
  { id: 'analyzer', label: 'Analyzer', position: [-1.0, -0.35, 0.35] },
  { id: 'coder', label: 'Coder', position: [0, -0.85, 0.1] },
  { id: 'critic', label: 'Critic', position: [1.0, -0.35, 0.3] },
  { id: 'judge', label: 'Judge', position: [2.0, -0.85, 0] },
  { id: 'risk', label: 'Risk Gate', position: [3.0, -0.2, 0.2] },
  { id: 'human', label: 'Human', position: [2.55, 0.85, 0.1] },
  { id: 'repair', label: 'Repair', position: [1.35, 1.1, 0.35] },
  { id: 'validation', label: 'Validation', position: [0.15, 0.72, 0.15] },
  { id: 'recovery', label: 'Recovery', position: [-1.05, 1.2, 0.2] },
  { id: 'learning', label: 'Learning', position: [-2.1, 1.45, -0.05] },
]

const EDGES: Array<[NodeId, NodeId]> = [
  ['buildhub', 'monitor'], ['monitor', 'analyzer'], ['analyzer', 'coder'], ['coder', 'critic'],
  ['critic', 'judge'], ['judge', 'risk'], ['risk', 'human'], ['risk', 'repair'], ['human', 'repair'],
  ['repair', 'validation'], ['validation', 'recovery'], ['recovery', 'learning'], ['learning', 'monitor'],
]

const STAGE_NODES: Record<OperationalStage, NodeId[]> = {
  DETECTION: ['buildhub', 'monitor'], ANALYZER: ['analyzer'], CODER: ['coder'], CRITIC: ['critic'],
  JUDGE: ['judge', 'risk'], APPROVAL: ['human'], PATCH: ['repair'], VALIDATION: ['validation'],
  RECOVERY: ['recovery', 'buildhub'], LEARNING: ['learning'],
}

const NODE_GROUPS = [
  { label: 'Application', detail: 'BuildHub → Monitor', ids: ['buildhub', 'monitor'] as NodeId[] },
  { label: 'AI review', detail: 'Analyzer → Coder → Critic → Judge', ids: ['analyzer', 'coder', 'critic', 'judge'] as NodeId[] },
  { label: 'Risk control', detail: 'Risk Gate → Human (MEDIUM/HIGH)', ids: ['risk', 'human'] as NodeId[] },
  { label: 'Prove repair', detail: 'Repair → Validation → Recovery', ids: ['repair', 'validation', 'recovery'] as NodeId[] },
  { label: 'Memory', detail: 'Recovery → Learning', ids: ['learning'] as NodeId[] },
]

const byId = new Map(NODES.map((node) => [node.id, node]))

function positionsForEdges() {
  const values: number[] = []
  for (const [from, to] of EDGES) {
    values.push(...(byId.get(from)?.position ?? [0, 0, 0]), ...(byId.get(to)?.position ?? [0, 0, 0]))
  }
  return new Float32Array(values)
}

function TopologyScene({ stage, active }: { stage: OperationalStage; active: boolean }) {
  const group = useRef<THREE.Group>(null)
  const pulse = useRef<THREE.Mesh>(null)
  const edgePositions = useMemo(() => positionsForEdges(), [])
  const highlighted = new Set(STAGE_NODES[stage])
  const current = NODES.find((node) => highlighted.has(node.id)) ?? NODES[3]
  const target = stage === 'RECOVERY' ? byId.get('recovery')! : current

  useFrame((state) => {
    if (group.current) group.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.25) * 0.025
    if (!pulse.current || !active) return
    const t = (Math.sin(state.clock.elapsedTime * 1.6) + 1) / 2
    const origin = byId.get(stage === 'PATCH' || stage === 'VALIDATION' || stage === 'RECOVERY' ? 'repair' : 'monitor')!
    pulse.current.position.set(
      THREE.MathUtils.lerp(origin.position[0], target.position[0], t),
      THREE.MathUtils.lerp(origin.position[1], target.position[1], t),
      THREE.MathUtils.lerp(origin.position[2], target.position[2], t),
    )
  })

  return (
    <group ref={group}>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[edgePositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#31505c" transparent opacity={0.7} />
      </lineSegments>
      {NODES.map((node) => {
        const selected = highlighted.has(node.id)
        const core = node.id === 'buildhub' || node.id === 'validation' || node.id === 'recovery'
        return (
          <group key={node.id} position={node.position}>
            <mesh>
              {core ? <boxGeometry args={[0.36, 0.36, 0.36]} /> : <octahedronGeometry args={[0.22, 0]} />}
              <meshStandardMaterial
                color={selected ? '#67e8f9' : core ? '#81909d' : '#42616c'}
                emissive={selected ? '#0ea7bb' : '#071014'}
                emissiveIntensity={selected ? 1.8 : 0.25}
                roughness={0.42}
                metalness={0.42}
              />
            </mesh>
            {selected && (
              <mesh scale={1.7}>
                <sphereGeometry args={[0.24, 12, 12]} />
                <meshBasicMaterial color="#22d3ee" transparent opacity={0.12} wireframe />
              </mesh>
            )}
          </group>
        )
      })}
      <mesh ref={pulse} visible={active}>
        <sphereGeometry args={[0.075, 10, 10]} />
        <meshBasicMaterial color="#f8fafc" />
      </mesh>
      <ambientLight intensity={0.45} />
      <pointLight position={[0, 2, 4]} intensity={12} color="#67e8f9" />
    </group>
  )
}

function subscribe(callback: () => void) {
  const queries = [
    window.matchMedia('(prefers-reduced-motion: reduce)'),
    window.matchMedia('(pointer: coarse)'),
    window.matchMedia('(max-width: 720px)'),
  ]
  queries.forEach((query) => query.addEventListener('change', callback))
  return () => queries.forEach((query) => query.removeEventListener('change', callback))
}

function eligibleSnapshot() {
  if (typeof window === 'undefined') return false
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(max-width: 720px)').matches) return false
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

function useWebGL() {
  return useSyncExternalStore(subscribe, eligibleSnapshot, () => false)
}

function StaticTopology({ stage }: { stage: OperationalStage }) {
  const highlighted = new Set(STAGE_NODES[stage])
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 p-4" aria-label={`System topology. Active stage: ${stage}`}>
      {NODE_GROUPS.map((group, index) => {
        const selected = group.ids.some((id) => highlighted.has(id))
        return (
          <div key={group.label} className="contents">
            <div className={cn('rounded-lg border px-3 py-2.5', selected ? 'border-bh-accent/60 bg-bh-accent-soft' : 'border-bh-line bg-bh-bg/40')}>
              <p className={cn('font-mono text-[9px] font-semibold uppercase tracking-[0.16em]', selected ? 'text-bh-accent-ink' : 'text-bh-faint')}>{group.label}</p>
              <p className="mt-1 text-xs leading-[18px] text-bh-muted">{group.detail}</p>
            </div>
            {index < NODE_GROUPS.length - 1 && <span className="h-2 border-l border-bh-line-strong self-center" aria-hidden="true" />}
          </div>
        )
      })}
    </div>
  )
}

export function SystemTopology({ incident }: { incident: IncidentDetailDTO | null }) {
  const webgl = useWebGL()
  const stage = activeStage(incident)
  const active = Boolean(incident && !['RESOLVED', 'ROLLED_BACK', 'AI_REPAIR_FAILED', 'REJECTED'].includes(incident.status))
  const highlighted = new Set(STAGE_NODES[stage])
  const pathLabel: Record<OperationalStage, string> = {
    DETECTION: 'BuildHub → Monitor (signal detected)', ANALYZER: 'Monitor → Analyzer', CODER: 'Analyzer → Coder',
    CRITIC: 'Coder → Critic', JUDGE: 'Critic → Judge → Risk Gate', APPROVAL: 'Risk Gate → Human approval',
    PATCH: 'Risk decision → Repair', VALIDATION: 'Repair → Validation',
    RECOVERY: 'Validation → Recovery → BuildHub', LEARNING: 'Recovery → Learning memory',
  }

  return (
    <section className="overflow-hidden rounded-xl border border-bh-line bg-bh-surface/75" aria-labelledby="topology-title">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-bh-line px-4 py-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bh-faint">Live system topology</p>
          <h2 id="topology-title" className="mt-1 text-sm font-semibold text-bh-ink">Evidence path → repair path</h2>
        </div>
        <span className="rounded border border-bh-accent/25 bg-bh-accent-soft px-2 py-1 font-mono text-[10px] font-semibold text-bh-accent-ink">{incident ? stage : 'MONITORING'}</span>
      </div>
      <div className="relative h-[22rem] min-h-0 sm:h-[26rem]">
        {webgl ? (
          <div className="absolute inset-0" aria-hidden="true">
            <Canvas camera={{ position: [0.2, 0.15, 8], fov: 45 }} dpr={[1, 1.35]} gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}>
              <TopologyScene stage={stage} active={active} />
            </Canvas>
          </div>
        ) : <StaticTopology stage={stage} />}
        {webgl && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 grid grid-cols-2 gap-1.5 sm:grid-cols-5">
            {NODE_GROUPS.map((group) => (
              <span key={group.label} className={cn('min-w-0 rounded border bg-bh-bg/90 px-2 py-1.5 text-center backdrop-blur', group.ids.some((id) => highlighted.has(id)) ? 'border-bh-accent/50 text-bh-accent-ink' : 'border-bh-line text-bh-faint')}>
                <span className="block font-mono text-[8px] font-bold uppercase tracking-wide">{group.label}</span>
                <span className="mt-0.5 block text-[8px] leading-[11px] text-bh-muted">{group.detail}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <p className="border-t border-bh-line px-4 py-2.5 text-xs leading-[18px] text-bh-muted">
        Current path: <span className="font-medium text-bh-ink">{incident ? pathLabel[stage] : 'BuildHub → Monitor (standing by)'}</span>{incident ? ` · ${incident.status.replaceAll('_', ' ').toLowerCase()}` : ''}
      </p>
    </section>
  )
}
