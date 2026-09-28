'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createComment } from '@/lib/api/comments'
import { COMMENT_CONTENT_MAX } from '@/lib/validation'
import { cn } from '@/lib/cn'
import { useAuth } from '@/components/auth/auth-provider'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Textarea } from '@/components/ui/fields'
import { useToast } from '@/components/ui/toast'

export function CommentForm({
  postId,
  onCreated,
}: {
  postId: string
  onCreated?: () => void
}) {
  const { toast } = useToast()
  const { user } = useAuth()
  const router = useRouter()
  const [content, setContent] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading'>('idle')
  const [error, setError] = useState('')

  const remaining = COMMENT_CONTENT_MAX - content.length

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!user) {
      router.push(`/login?next=/posts/${postId}`)
      return
    }
    if (!content.trim()) {
      setError('Write something before posting.')
      return
    }
    setStatus('loading')
    try {
      await createComment(postId, content)
      setContent('')
      onCreated?.()
      toast('success', 'Comment posted', 'Your comment is live.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post your comment.')
      toast('error', 'Failed to comment', 'Please try again.')
    } finally {
      setStatus('idle')
    }
  }

  if (!user) {
    return (
      <div className="rounded-xl border border-bh-line bg-bh-surface-2 p-4 text-sm text-bh-muted">
        <Button asChild variant="outline" size="sm">
          <a href={`/login?next=/posts/${postId}`}>Log in to comment</a>
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} aria-label="Add a comment" className="flex gap-3">
      <Avatar name={user.name} username={user.username} size={36} />
      <div className="min-w-0 flex-1">
        <Textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value)
            if (error) setError('')
          }}
          placeholder="Write a comment…"
          maxLength={COMMENT_CONTENT_MAX}
          rows={2}
          invalid={!!error}
          aria-label="Comment content"
          className="min-h-[64px] text-sm"
        />
        {error && (
          <p role="alert" className="mt-1 flex items-start gap-1 text-xs text-bh-danger">
            <Icon name="warning" size={13} className="mt-px shrink-0" />
            {error}
          </p>
        )}
        <div className="mt-1.5 flex items-center justify-between gap-2">
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
            data-ux-id="post-comment-button"
            loading={status === 'loading'}
            disabled={!content.trim()}
          >
            Post comment
          </Button>
        </div>
      </div>
    </form>
  )
}