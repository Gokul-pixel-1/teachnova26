'use client'

import { useEffect, useRef, useState } from 'react'

import { openLiveSandbox } from '@/lib/api/ux'

// Live sandbox tab: shows the UX simulation browser's screen as it works
// (cursor replaying real users, ✓/✗ marks, each AI placement, results).
export function UxLiveClient() {
  const [state, setState] = useState<'starting' | 'ready' | 'error'>('starting')
  const [error, setError] = useState<string | null>(null)
  const [streamKey, setStreamKey] = useState(0)
  const screenRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    openLiveSandbox()
      .then(() => {
        if (!cancelled) {
          setState('ready')
          setStreamKey((k) => k + 1)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState('error')
          setError(err instanceof Error ? err.message : 'Could not start the live sandbox view.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-bh-faint">Mission Control</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-bh-ink">Live Sandbox</h1>
          <p className="mt-1 max-w-3xl text-sm text-bh-muted">
            The UX agent&apos;s test environment, live. When users struggle with a feature, you will see the cursor replay where
            they clicked, each AI placement applied to the sandbox copy (never the real site), and whether it passed. Keep
            this tab open.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void screenRef.current?.requestFullscreen?.().catch(() => undefined)}
            className="flex h-9 items-center rounded-md bg-bh-accent px-3.5 text-sm font-medium text-white hover:bg-bh-accent-strong"
          >
            Full screen
          </button>
          <button
            onClick={() => setStreamKey((k) => k + 1)}
            className="flex h-9 items-center rounded-md border border-bh-line px-3.5 text-sm font-medium text-bh-ink hover:bg-bh-surface-2"
          >
            Reconnect
          </button>
        </div>
      </div>

      {state === 'starting' && (
        <p className="rounded-lg border border-bh-line px-3.5 py-2.5 text-sm text-bh-muted" role="status">
          Starting the sandbox view… the first time can take up to a minute.
        </p>
      )}
      {state === 'error' && (
        <p className="rounded-lg border border-bh-danger/40 px-3.5 py-2.5 text-sm text-bh-danger" role="alert">
          {error}
        </p>
      )}
      {state === 'ready' && (
        <div ref={screenRef} className="flex items-center justify-center overflow-hidden rounded-xl border border-bh-line bg-black">
          {/* MJPEG stream: the browser keeps replacing the image with each new frame. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={streamKey}
            src={`/api/ux/live/stream?k=${streamKey}`}
            alt="Live view of the UX sandbox test browser"
            className="block max-h-[calc(100vh-150px)] w-full object-contain [:fullscreen_&]:max-h-screen"
          />
        </div>
      )}
    </div>
  )
}
