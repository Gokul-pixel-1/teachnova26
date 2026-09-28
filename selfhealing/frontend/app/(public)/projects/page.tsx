'use client'

import { useMemo, useState } from 'react'
import { getProjects, createProject, type ProjectCreateInput } from '@/lib/api/projects'
import { useAsync } from '@/lib/hooks'
import { projectStatusMeta } from '@/components/projects/project-card'
import { ProjectCard } from '@/components/projects/project-card'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/fields'
import { Modal } from '@/components/ui/modal'
import { Field } from '@/components/ui/field'
import { Icon } from '@/components/ui/icon'
import { Tabs, TabList, Tab, TabPanel } from '@/components/ui/tabs'
import { ProjectGridSkeleton } from '@/components/feedback/skeleton'
import { EmptyState } from '@/components/feedback/empty-state'
import { ErrorState } from '@/components/feedback/error-state'
import { TagEditor } from '@/components/posts/tag-editor'
import { MAX_PROJECT_TAGS } from '@/lib/validation'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/components/auth/auth-provider'
import type { ProjectStatus } from '@/lib/types'

export default function ProjectsPage() {
  const { toast } = useToast()
  const { user } = useAuth()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | ProjectStatus>('all')
  const [createOpen, setCreateOpen] = useState(false)

  const allProjects = useAsync(() => getProjects())
  const mine = useAsync(() => (user ? getProjects({ mine: true }) : Promise.resolve({ projects: [], pagination: { page: 1, pageSize: 30, total: 0, totalPages: 0 } })))

  const filtered = useMemo(() => {
    const list = allProjects.data?.projects ?? []
    const q = query.trim().toLowerCase()
    return list.filter((p) => {
      const statusOk = status === 'all' || p.status === status
      const queryOk =
        !q ||
        p.name.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q)
      return statusOk && queryOk
    })
  }, [allProjects.data, status, query])

  const handleCreated = () => {
    setCreateOpen(false)
    toast('success', 'Project created', 'Your new project is ready.')
    allProjects.refetch()
    mine.refetch()
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-bh-ink">Projects</h1>
          <p className="mt-1 text-sm text-bh-muted">
            Discover and showcase developer projects.
          </p>
        </div>
        {user && (
          <Button size="sm" icon="plus" onClick={() => setCreateOpen(true)}>
            Create project
          </Button>
        )}
      </div>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1" data-ux-id="projects-search">
          <span className="pointer-events-none absolute inset-y-0 left-0 flex w-10 items-center justify-center text-bh-faint">
            <Icon name="search" size={18} />
          </span>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects by name or description…"
            aria-label="Search projects"
            className="pl-10"
          />
        </div>
        <div className="w-full sm:w-48" data-ux-id="projects-status-filter">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as 'all' | ProjectStatus)}
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            {Object.entries(projectStatusMeta).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Tabs defaultValue="discover" className="mt-6">
        <TabList aria-label="Projects" className={user ? undefined : 'hidden'}>
          <Tab id="discover">Discover</Tab>
          {user && (
            <Tab id="mine" count={mine.data?.projects.length}>
              My projects
            </Tab>
          )}
        </TabList>

        <TabPanel id="discover">
          {allProjects.loading && <ProjectGridSkeleton />}
          {allProjects.error && (
            <ErrorState
              title="Couldn’t load projects"
              description={allProjects.error}
              onRetry={allProjects.refetch}
            />
          )}
          {!allProjects.loading && !allProjects.error && filtered.length === 0 && (
            <EmptyState
              icon="search"
              title={
                query || status !== 'all'
                  ? 'No matching projects'
                  : 'No projects yet'
              }
              description={
                query || status !== 'all'
                  ? 'Try a different search or filter.'
                  : 'Be the first to create a project and start collaborating.'
              }
              actionLabel={
                query || status !== 'all' ? undefined : user ? 'Create project' : undefined
              }
              onAction={() => setCreateOpen(true)}
            />
          )}
          {!allProjects.loading && !allProjects.error && filtered.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          )}
        </TabPanel>

        <TabPanel id="mine">
          {mine.loading && <ProjectGridSkeleton />}
          {mine.error && (
            <ErrorState
              title="Couldn’t load your projects"
              description={mine.error}
              onRetry={mine.refetch}
            />
          )}
          {!mine.loading && !mine.error && mine.data && mine.data.projects.length === 0 && (
            <EmptyState
              icon="folder"
              title="No projects yet"
              description="Create your first project to start collaborating."
              actionLabel="Create project"
              onAction={() => setCreateOpen(true)}
            />
          )}
          {!mine.loading &&
            !mine.error &&
            (mine.data?.projects ?? []).length > 0 && (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {mine.data?.projects.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            )}
        </TabPanel>
      </Tabs>

      <CreateProjectModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  )
}

function CreateProjectModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<ProjectStatus>('ACTIVE')
  const [tags, setTags] = useState<string[]>([])
  const [tagError, setTagError] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (tagError) {
      setError(tagError)
      return
    }
    if (!name.trim()) {
      setError('Give your project a name.')
      return
    }
    setLoading(true)
    try {
      const input: ProjectCreateInput = {
        name: name.trim(),
        description: description.trim() || undefined,
        tags,
      }
      if (status !== 'ACTIVE') input.status = status
      await createProject(input)
      setName('')
      setDescription('')
      setStatus('ACTIVE')
      setTags([])
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your project.')
      toast('error', 'Failed to create project', 'Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create a project"
      description="Share a project you’re building or have shipped."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-project-form" loading={loading}>
            Create project
          </Button>
        </>
      }
    >
      <form id="create-project-form" onSubmit={submit} className="space-y-4">
        <Field
          id="proj-name"
          label="Project name"
          placeholder="e.g. QueryRaft"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error}
          autoFocus
        />
        <div>
          <label htmlFor="proj-desc" className="mb-1.5 block text-sm font-medium text-bh-ink">
            Description
          </label>
          <Textarea
            id="proj-desc"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What’s this project about? Who’s it for?"
          />
        </div>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-bh-ink">Status</span>
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as ProjectStatus)}
            aria-label="Project status"
          >
            {Object.entries(projectStatusMeta).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-bh-ink">
            Tags <span className="font-normal text-bh-faint">(up to {MAX_PROJECT_TAGS})</span>
          </span>
          <TagEditor value={tags} onChange={setTags} onError={setTagError} max={MAX_PROJECT_TAGS} />
        </div>
      </form>
    </Modal>
  )
}