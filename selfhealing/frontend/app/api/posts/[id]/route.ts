import { NextResponse } from 'next/server'
import { prisma } from '@/lib/server/db'
import { getSessionUser } from '@/lib/server/auth'
import {
  errorResponse,
  firstZodIssue,
  handleRouteError,
} from '@/lib/server/response'
import { postInclude, serializePost } from '@/lib/server/serializers'
import { updatePostSchema as updatePostSchemaServer } from '@/lib/server/validation'
import { isFaultActive } from '@/lib/server/fault-injection'

async function findPost(id: string, currentUserId?: string | null) {
  return prisma.post.findUnique({
    where: { id },
    include: postInclude(currentUserId),
  })
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const currentUser = await getSessionUser()

  try {
    const post = await findPost(id, currentUser?.id)
    if (!post) {
      return errorResponse('Post not found.', 404)
    }
    const postData = serializePost(post, currentUser?.id)
    // LOW-02 (runtime fault): rename the response key post → poost while active.
    const responseKey = isFaultActive('LOW-02') ? 'poost' : 'post'
    return NextResponse.json({ [responseKey]: postData })
  } catch (err) {
    return handleRouteError(err, request)
  }
}

export async function PATCH(
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

  const parsed = updatePostSchemaServer.safeParse(body)
  if (!parsed.success) {
    return errorResponse(firstZodIssue(parsed.error), 400)
  }

  try {
    const existing = await prisma.post.findUnique({ where: { id } })
    if (!existing) {
      return errorResponse('Post not found.', 404)
    }
    if (existing.authorId !== user.id) {
      return errorResponse('You can only edit your own posts.', 403)
    }

    const data = parsed.data

    if (data.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: data.projectId },
        select: { id: true },
      })
      if (!project) {
        return errorResponse('Linked project does not exist.', 400)
      }
    }

    const post = await prisma.post.update({
      where: { id },
      data: {
        ...(data.content !== undefined ? { content: data.content } : {}),
        ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
        ...(data.tags !== undefined ? { tags: data.tags } : {}),
      },
      include: postInclude(user.id),
    })

    return NextResponse.json({ post: serializePost(post, user.id) })
  } catch (err) {
    return handleRouteError(err, request)
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) {
    return errorResponse('Not authenticated.', 401)
  }

  const { id } = await ctx.params

  try {
    const existing = await prisma.post.findUnique({ where: { id } })
    if (!existing) {
      return errorResponse('Post not found.', 404)
    }
    if (existing.authorId !== user.id) {
      return errorResponse('You can only delete your own posts.', 403)
    }

    await prisma.post.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return handleRouteError(err, request)
  }
}
