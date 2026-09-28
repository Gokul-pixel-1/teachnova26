// Next.js server start hook: begins polling Jira approval cards (only when
// Jira credentials are configured; see lib/server/jira/approvals.ts), and —
// with UX_SIM_LIVE=true — opens the live sandbox window so the UX agent's
// tests can be watched (lib/server/ux/live.ts).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startJiraPoller } = await import('./lib/server/jira/approvals')
    startJiraPoller()
    const { liveEnabled, openLiveWindow } = await import('./lib/server/ux/live')
    if (liveEnabled()) {
      // In the background: the sandbox server may need a minute to start.
      setTimeout(() => {
        void (async () => {
          const { ensureSandbox, sandboxBaseUrl } = await import('./lib/server/ux/sandbox')
          await ensureSandbox()
          await openLiveWindow(sandboxBaseUrl())
        })().catch((err: unknown) => console.warn('[ux-live] could not open the live sandbox window:', err instanceof Error ? err.message : err))
      }, 3000)
    }
  }
}
