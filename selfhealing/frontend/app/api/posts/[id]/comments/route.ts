import { NextResponse } from 'next/server'
import { prisma } from '@/lib/server/db'
import { getSessionUser } from '@/lib/server/auth'
import { createCommentSchema } from '@/lib/validation'
import {
  errorResponse,
  firstZodIssue,
  handleApiError,
  handleRouteError,
} from '@/lib/server/response'
import { serializeComment } from '@/lib/server/serializers'
import { isFaultActive } from '@/lib/server/fault-injection'

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const currentUser = await getSessionUser()

  try {
    const post = await prisma.post.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!post) {
      return errorResponse('Post not found.', 404)
    }

    const comments = await prisma.comment.findMany({
      where: { postId: id },
      include: { author: true },
      orderBy: { createdAt: 'asc' },
    })

    return NextResponse.json({
      comments: comments.map((c) => serializeComment(c, currentUser?.id)),
    })
  } catch (err) {
    console.error(
      `[api] GET /api/posts/${id}/comments failed:`,
      err instanceof Error ? err.message : 'unknown error',
    )
    return handleApiError(err)
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) {
    return errorResponse('Not authenticated.', 401)
  }

  const { id } = await ctx.params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid request body.', 400)
  }

  const parsed = createCommentSchema.safeParse(body)
  if (!parsed.success) {
    return errorResponse(firstZodIssue(parsed.error), 400)
  }

  try {
    const post = await prisma.post.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!post) {
      return errorResponse('Post not found.', 404)
    }

    // COMMENT-01 (runtime fault, LOW risk): only while activated from the
    // Command Center, comment creation fails before persistence (500).
    if (isFaultActive('COMMENT-01')) {
      throw new Error('COMMENT-01: Injected comment service failure')
    }

    const comment = await prisma.comment.create({
      data: {
        content: parsed.data.content,
        postId: id,
        authorId: user.id,
      },
      include: { author: true },
    })

    return NextResponse.json(
      { comment: serializeComment(comment, user.id) },
      { status: 201 },
    )
  } catch (err) {
    return handleRouteError(err, request, {
      route: `/api/posts/${id}/comments`,
      method: 'POST',
      service: 'api',
    })
  }
}
