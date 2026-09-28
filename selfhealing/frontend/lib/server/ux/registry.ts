import 'server-only'

// Tracked UI components. Each entry pairs a `data-ux-id` attribute placed on a
// real element with the source file that renders it, so behaviour signals
// collected in the browser can be turned into a concrete, patchable target.
// Adding a component to behaviour analysis = tag the element + add a row here.

export interface UxComponentSpec {
  uxId: string
  label: string
  file: string
  /** A page that renders the component, probed after a change is applied. */
  probePath: string
  /** Page the sandbox usability simulation opens. `:post` = the newest post. */
  simPath: string
  /** The component only renders for a signed-in user. */
  auth: boolean
}

export const UX_COMPONENTS: UxComponentSpec[] = [
  { uxId: 'login-button', label: 'Log in button (app header)', file: 'components/navigation/header.tsx', probePath: '/projects', simPath: '/projects', auth: false },
  { uxId: 'signup-button', label: 'Sign up button (app header)', file: 'components/navigation/header.tsx', probePath: '/projects', simPath: '/projects', auth: false },
  { uxId: 'sidebar-login', label: 'Log in button (sidebar)', file: 'components/navigation/sidebar.tsx', probePath: '/projects', simPath: '/projects', auth: false },
  { uxId: 'sidebar-signup', label: 'Sign up button (sidebar)', file: 'components/navigation/sidebar.tsx', probePath: '/projects', simPath: '/projects', auth: false },
  { uxId: 'landing-login', label: 'Log in button (landing page)', file: 'app/page.tsx', probePath: '/', simPath: '/', auth: false },
  { uxId: 'landing-get-started', label: 'Get started button (landing page)', file: 'app/page.tsx', probePath: '/', simPath: '/', auth: false },
  { uxId: 'landing-hero-start', label: 'Start building button (landing hero)', file: 'app/page.tsx', probePath: '/', simPath: '/', auth: false },
  { uxId: 'landing-hero-explore', label: 'Explore projects button (landing hero)', file: 'app/page.tsx', probePath: '/', simPath: '/', auth: false },
  { uxId: 'projects-search', label: 'Project search box', file: 'app/(public)/projects/page.tsx', probePath: '/projects', simPath: '/projects', auth: false },
  { uxId: 'projects-status-filter', label: 'Project status filter', file: 'app/(public)/projects/page.tsx', probePath: '/projects', simPath: '/projects', auth: false },
  { uxId: 'publish-post-button', label: 'Publish post button', file: 'components/posts/post-composer.tsx', probePath: '/feed', simPath: '/feed', auth: true },
  { uxId: 'post-comment-button', label: 'Post comment button', file: 'components/posts/comment-form.tsx', probePath: '/projects', simPath: '/posts/:post', auth: true },
  { uxId: 'like-button', label: 'Like button', file: 'components/posts/like-button.tsx', probePath: '/projects', simPath: '/posts/:post', auth: false },
]

export function uxComponent(uxId: string | null | undefined): UxComponentSpec | null {
  if (!uxId) return null
  return UX_COMPONENTS.find((c) => c.uxId === uxId) ?? null
}

export function isTrackedUxId(uxId: string | null | undefined): boolean {
  return uxComponent(uxId) !== null
}
