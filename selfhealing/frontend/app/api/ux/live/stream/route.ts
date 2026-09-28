import { requireSecurityOperator } from '@/lib/server/security'
import { latestLiveFrame } from '@/lib/server/ux/live'

// Live sandbox screen as an MJPEG stream (<img src> shows it as live video):
// every new screencast frame of the UX simulation browser is pushed as it
// arrives. Operator-only; the stream ends when the tab closes.
export const dynamic = 'force-dynamic'

const BOUNDARY = 'bhliveframe'

export async function GET(request: Request) {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastSeq = -1
      let lastSent = 0
      const push = () => {
        const frame = latestLiveFrame()
        // New frame, or re-send the current one every 2 s so a freshly opened
        // tab shows the (unchanging) idle screen too.
        if (!frame || (frame.seq === lastSeq && Date.now() - lastSent < 2000)) return
        lastSeq = frame.seq
        lastSent = Date.now()
        try {
          controller.enqueue(encoder.encode(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.jpeg.length}\r\n\r\n`))
          controller.enqueue(new Uint8Array(frame.jpeg))
          controller.enqueue(encoder.encode('\r\n'))
        } catch {
          if (timer) clearInterval(timer)
        }
      }
      push()
      timer = setInterval(push, 120)
      request.signal.addEventListener('abort', () => {
        if (timer) clearInterval(timer)
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      })
    },
    cancel() {
      if (timer) clearInterval(timer)
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
    },
  })
}
