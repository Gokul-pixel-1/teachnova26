'use client'

import { useEffect, useState } from 'react'
import { createPost } from '@/lib/api/posts'
import { getProjects } from '@/lib/api/projects'
import { cn } from '@/lib/cn'
import { useAuth } from '@/components/auth/auth-provider'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Textarea } from '@/components/ui/fields'
import { TagEditor } from '@/components/posts/tag-editor'
import { useToast } from '@/components/ui/toast'

const MAX_LENGTH = 1000

export function PostComposer({ onCreated }: { onCreated?: () => void }) {
  const { toast } = useToast()
  const { user } = useAuth()
  const [content, setContent] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [projectId, setProjectId] = useState('')
  const [projectOptions, setProjectOptions] = useState<{ id: string; name: string }[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'success'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    getProjects({ pageSize: 50 })
      .then((res) => {
        if (!cancelled) setProjectOptions(res.projects)
      })
      .catch(() => {
        // Project list is optional; posts can still be created unlinked.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const remaining = MAX_LENGTH - content.length

  const reset = () => {
    setContent('')
    setTags([])
    setProjectId('')
    setStatus('idle')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!content.trim()) {
      setError('Write something to share with your network.')
      return
    }
    if (content.length > MAX_LENGTH) {
      setError(`Keep your post under ${MAX_LENGTH} characters.`)
      return
    }
    setStatus('loading')
    try {
      await createPost({
        content,
        projectId: projectId || null,
        tags,
      })
      setStatus('success')
      toast('success', 'Post published', 'Your post is now live in your feed.')
      reset()
      onCreated?.()
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Could not publish your post.')
      toast('error', 'Failed to publish', 'Please try again.')
    }
  }

  if (!user) return null

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-bh-line bg-bh-surface p-4 shadow-sm"
      aria-label="Create a post"
    >
      <div className="flex gap-3">
        <Avatar name={user.name} username={user.username} size={40} />
        <Textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value)
            if (status !== 'idle') setStatus('idle')
            if (error) setError('')
          }}
          placeholder="Share an update, ask a question, or start a discussion…"
          maxLength={MAX_LENGTH}
          rows={3}
          invalid={!!error}
          aria-label="Post content"
          className="min-h-[80px] border-none bg-transparent px-0 text-[15px] shadow-none focus:ring-0"
        />
      </div>

      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-bh-faint">
            <Icon name="folder" size={15} />
          </span>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            aria-label="Link a project"
            className="h-8 w-full appearance-none rounded-md border border-bh-line bg-bh-surface-2 pl-8 pr-8 text-xs text-bh-muted focus:border-bh-accent focus:outline-none"
          >
            <option value="">Link a project</option>
            {projectOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-bh-faint">
            <Icon name="chevronDown" size={14} />
          </span>
        </div>

        <TagEditor
          value={tags}
          onChange={setTags}
          onError={(message) => setError(message === null ? '' : message)}
          className="w-full sm:w-64"
        />
      </div>

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1 text-xs text-bh-danger">
          <Icon name="warning" size={14} className="mt-px shrink-0" />
          {error}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-bh-line pt-3">
        <span
          className={cn(
            'text-xs tabular-nums',
            remaining < 0 ? 'font-medium text-bh-danger' : 'text-bh-faint',
          )}
        >
          {remaining}
        </span>
        <Button
          type="submit"
          size="sm"
          data-ux-id="publish-post-button"
          loading={status === 'loading'}
          disabled={!content.trim()}
        >
          {status === 'success' ? 'Posted' : 'Publish'}
        </Button>
      </div>
    </form>
  )
}