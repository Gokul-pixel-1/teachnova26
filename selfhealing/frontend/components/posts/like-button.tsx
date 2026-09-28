'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { likePost, unlikePost } from '@/lib/api/posts'
import { cn } from '@/lib/cn'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/components/auth/auth-provider'

interface LikeButtonProps {
  postId: string
  liked: boolean
  count: number
  onChange?: (liked: boolean, likeCount: number) => void
  className?: string
}

export function LikeButton({
  postId,
  liked,
  count,
  onChange,
  className,
}: LikeButtonProps) {
  const { toast } = useToast()
  const { user } = useAuth()
  const router = useRouter()
  const [likedState, setLikedState] = useState(liked)
  const [countState, setCountState] = useState(count)
  const [pending, setPending] = useState(false)
  const [popping, setPopping] = useState(false)

  const toggle = async () => {
    if (pending) return
    // Guests are invited to sign in rather than hitting a 401.
    if (!user) {
      router.push(`/login?next=/posts/${postId}`)
      return
    }
    setPending(true)
    try {
      const next = likedState ? await unlikePost(postId) : await likePost(postId)
      setLikedState(next.likedByMe)
      setCountState(next.likeCount)
      onChange?.(next.likedByMe, next.likeCount)
      if (!likedState && next.likedByMe) {
        setPopping(true)
        window.setTimeout(() => setPopping(false), 260)
      }
    } catch (err) {
      toast(
        'error',
        'Could not update like',
        err instanceof Error ? err.message : 'Please try again.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      data-ux-id="like-button"
      onClick={toggle}
      aria-pressed={likedState}
      aria-label={likedState ? 'Unlike post' : 'Like post'}
      className={cn(
        'group inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm tabular-nums transition-colors',
        likedState
          ? 'text-bh-danger hover:bg-bh-danger/5'
          : 'text-bh-faint hover:bg-bh-surface-2 hover:text-bh-ink',
        pending && 'opacity-60',
        className,
      )}
    >
      <Icon
        name={likedState ? 'heartFilled' : 'heart'}
        size={16}
        className={cn(
          'transition-transform motion-safe:duration-200',
          popping && 'scale-150',
          !popping && !likedState && 'motion-safe:group-hover:scale-110',
        )}
      />
      {countState}
    </button>
  )
}