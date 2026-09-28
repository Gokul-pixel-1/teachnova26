'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Logo, LogoMark } from '@/components/layout/logo'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Icon } from '@/components/ui/icon'
import { ProjectCard } from '@/components/projects/project-card'
import { HeroBlocks } from '@/components/landing/hero-blocks'
import { Skeleton, ProjectCardSkeleton } from '@/components/feedback/skeleton'
import { useAsync } from '@/lib/hooks'
import { getProjects } from '@/lib/api/projects'
import { getPosts } from '@/lib/api/posts'

const navLinks = [
  { href: '#projects', label: 'Featured projects' },
  { href: '#workflow', label: 'How it works' },
  { href: '#community', label: 'Community' },
]

const workflow = [
  { step: '01', title: 'Create a project', body: 'Give it a name, a description, a status, and a few tags that describe the stack.' },
  { step: '02', title: 'Share in the feed', body: 'Post updates and link each one back to the project it moves forward.' },
  { step: '03', title: 'Get real feedback', body: 'Likes and threaded comments show up instantly — no hidden queues.' },
  { step: '04', title: 'It stays on your profile', body: 'Everything you ship is browsable on your public profile for anyone to find.' },
]



export default function LandingPage() {
  const [mobileOpen, setMobileOpen] = useState(false)

  const featured = useAsync(() => getProjects({ pageSize: 60 }))
  const recent = useAsync(() => getPosts({ pageSize: 60 }))

  const featuredList = (featured.data?.projects ?? []).slice(0, 3)
  const postList = (recent.data?.posts ?? []).slice(0, 3)
  const projectTotal = featured.data?.pagination?.total ?? featuredList.length
  const postTotal = recent.data?.pagination?.total ?? postList.length

  return (
    <div className="min-h-screen bg-bh-bg text-bh-ink">
      <header className="sticky top-0 z-30 border-b border-bh-line bg-bh-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <nav className="hidden items-center gap-8 md:flex" aria-label="Landing navigation">
            {navLinks.map((l) => (
              <a key={l.href} href={l.href} className="text-sm font-medium text-bh-muted hover:text-bh-ink">
                {l.label}
              </a>
            ))}
          </nav>
          <div className="hidden items-center gap-2 md:flex">
            <Link href="/login" data-ux-id="landing-login">
              <Button variant="ghost" size="sm">Log in</Button>
            </Link>
            <Link href="/signup" data-ux-id="landing-get-started">
              <Button size="sm">Get started</Button>
            </Link>
          </div>
          <button
            className="flex h-9 w-9 items-center justify-center rounded-md text-bh-muted hover:bg-bh-surface-2 md:hidden"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label="Toggle menu"
            aria-expanded={mobileOpen}
          >
            <Icon name={mobileOpen ? 'x' : 'menu'} size={20} />
          </button>
        </div>
        {mobileOpen && (
          <nav className="border-t border-bh-line bg-bh-surface px-4 py-4 md:hidden" aria-label="Mobile landing navigation">
            <div className="flex flex-col gap-1">
              {navLinks.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  onClick={() => setMobileOpen(false)}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-bh-muted hover:bg-bh-surface-2 hover:text-bh-ink"
                >
                  {l.label}
                </a>
              ))}
              <div className="mt-2 flex gap-2 border-t border-bh-line pt-3">
                <Link href="/login" className="flex-1">
                  <Button variant="secondary" className="w-full">Log in</Button>
                </Link>
                <Link href="/signup" className="flex-1">
                  <Button className="w-full">Get started</Button>
                </Link>
              </div>
            </div>
          </nav>
        )}
      </header>

      {/* Hero */}
      <section className="bh-grid-bg relative overflow-hidden">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28 lg:py-32">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-bh-line bg-bh-surface px-3 py-1 text-xs font-medium text-bh-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-bh-accent" />
                Developer collaboration platform
              </span>
              <h1 className="mt-5 text-4xl font-semibold tracking-tight text-bh-ink sm:text-5xl lg:text-6xl">
                Build. <span className="text-bh-accent">Collaborate.</span>
                <br />
                Share.
              </h1>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-bh-muted">
                Share what you are building, link every post to the project it moves forward, and get real
                feedback from a community that cares about the details.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link href="/signup" data-ux-id="landing-hero-start">
                  <Button size="lg" className="w-full sm:w-auto">Start building — it’s free</Button>
                </Link>
                <Link href="/projects" data-ux-id="landing-hero-explore">
                  <Button size="lg" variant="outline" className="w-full sm:w-auto">Explore projects</Button>
                </Link>
              </div>
              <div className="mt-8 inline-flex items-center gap-2 rounded-lg border border-bh-line bg-bh-surface px-3 py-2 text-sm text-bh-muted">
                <span className="h-2 w-2 animate-pulse rounded-full bg-bh-success" aria-hidden="true" />
                Live: {projectTotal} projects · {postTotal} posts on BuildHub
              </div>
            </div>

            <HeroBlocks />
          </div>
        </div>
      </section>

      {/* Featured projects (real data) */}
      <section id="projects" className="border-t border-bh-line bg-bh-surface">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
            <div className="max-w-2xl">
              <p className="text-sm font-semibold uppercase tracking-widest text-bh-accent">Featured projects</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                What the community is building right now
              </h2>
              <p className="mt-4 text-lg text-bh-muted">
                Live from the projects feed — every card below is real data from a real Postgres database.
              </p>
            </div>
            <Link href="/projects">
              <Button variant="outline" size="sm">View all projects</Button>
            </Link>
          </div>

          <div className="mt-10">
            {featured.loading && (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <ProjectCardSkeleton /><ProjectCardSkeleton /><ProjectCardSkeleton />
              </div>
            )}
            {featured.error && (
              <p className="rounded-xl border border-bh-line bg-bh-bg p-6 text-sm text-bh-muted">
                Couldn’t load projects right now — try again in a moment.
              </p>
            )}
            {featuredList.length === 0 && (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {['Start with a project', 'Give it tags and a status', 'Share your first post'].map((t) => (
                  <div key={t} className="rounded-xl border border-bh-line bg-bh-surface p-6">
                    <Icon name="folder" size={18} className="text-bh-accent" />
                    <p className="mt-3 text-sm font-medium text-bh-ink">{t}</p>
                  </div>
                ))}
              </div>
            )}
            {featuredList.length > 0 && (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {featuredList.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="workflow" className="border-t border-bh-line">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-sm font-semibold uppercase tracking-widest text-bh-accent">How it works</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              From idea to shipped, in the open
            </h2>
            <p className="mt-4 text-lg text-bh-muted">
              A loop that matches how developers actually build — no task boards invented for the sake of a demo.
            </p>
          </div>
          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {workflow.map((w) => (
              <div key={w.step} className="relative rounded-xl border border-bh-line bg-bh-surface p-6">
                <span className="font-mono text-sm font-semibold text-bh-accent">{w.step}</span>
                <h3 className="mt-3 text-base font-semibold">{w.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-bh-muted">{w.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Community (real posts) */}
      <section id="community" className="border-t border-bh-line bg-bh-surface">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <p className="text-sm font-semibold uppercase tracking-widest text-bh-accent">Community feed</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                Real posts from real builders
              </h2>
              <p className="mt-4 max-w-lg text-lg text-bh-muted">
                Progress updates, technical write-ups, and launch notes — straight from the feed, with likes
                and comments intact.
              </p>
              <div className="mt-8 flex flex-wrap gap-2">
                {['Project launches', 'Tech discussions', 'Open source', 'Dev progress'].map((t) => (
                  <Badge key={t} tone="neutral">{t}</Badge>
                ))}
              </div>
            </div>
            <div className="space-y-4">
              {recent.loading && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-bh-line bg-bh-surface p-5"><Skeleton className="h-4 w-1/3" /><Skeleton className="mt-3 h-3.5 w-full" /><Skeleton className="mt-2 h-3.5 w-5/6" /></div>
                  <div className="rounded-xl border border-bh-line bg-bh-surface p-5"><Skeleton className="h-4 w-1/3" /><Skeleton className="mt-3 h-3.5 w-full" /><Skeleton className="mt-2 h-3.5 w-5/6" /></div>
                  <div className="rounded-xl border border-bh-line bg-bh-surface p-5"><Skeleton className="h-4 w-1/3" /><Skeleton className="mt-3 h-3.5 w-full" /><Skeleton className="mt-2 h-3.5 w-5/6" /></div>
                </div>
              )}
              {recent.error && (
                <p className="rounded-xl border border-bh-line bg-bh-bg p-6 text-sm text-bh-muted">
                  Couldn’t load the feed right now.
                </p>
              )}
              {postList.length > 0 && (
                <div className="space-y-4">
                  {postList.map((post) => (
                    <div key={post.id} className="rounded-xl border border-bh-line bg-bh-surface p-5">
                      <div className="flex items-center gap-2.5">
                        <span className="text-sm font-medium">{post.author.name}</span>
                        <span className="text-xs text-bh-faint">@{post.author.username}</span>
                      </div>
                      <p className="mt-2.5 line-clamp-2 whitespace-pre-wrap text-sm leading-relaxed text-bh-muted">
                        {post.content}
                      </p>
                      <div className="mt-3 flex items-center gap-4 text-xs text-bh-faint">
                        <span className="inline-flex items-center gap-1"><Icon name="heart" size={13} /> {post.likeCount}</span>
                        <span className="inline-flex items-center gap-1"><Icon name="comment" size={13} /> {post.commentCount}</span>
                        {post.project && (
                          <span className="inline-flex items-center gap-1 text-bh-accent">
                            <Icon name="launch" size={13} /> {post.project.name}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-bh-line">
        <div className="mx-auto max-w-4xl px-4 py-20 text-center sm:px-6">
          <div className="mx-auto flex justify-center">
            <LogoMark size={44} />
          </div>
          <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
            Ready to put your next build out there?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-bh-muted">
            Create a project, publish a post, and let the community respond. It takes less than a minute.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/signup">
              <Button size="lg">Create your account</Button>
            </Link>
            <Link href="/projects">
              <Button size="lg" variant="outline">Explore projects</Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-bh-line bg-bh-surface">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <div className="flex flex-col items-center justify-between gap-6 md:flex-row">
            <Logo />
            <p className="text-sm text-bh-muted">Build. Collaborate. Share.</p>
            <Link href="/login" className="text-sm font-medium text-bh-muted hover:text-bh-ink">
              Log in
            </Link>
          </div>
          <p className="mt-8 border-t border-bh-line pt-6 text-center text-xs text-bh-faint">
            © {new Date().getFullYear()} BuildHub. Built for developers, by developers.
          </p>
        </div>
      </footer>
    </div>
  )
}