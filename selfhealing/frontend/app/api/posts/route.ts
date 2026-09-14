import type { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/server/db'
import { getSessionUser } from '@/lib/server/auth'
import {
  errorResponse,
  firstZodIssue,
  handleRouteError,
} from '@/lib/server/response'
import { postInclude, serializePost } from '@/lib/server/serializers'
import { createPostSchema } from '@/lib/server/validation'
import { isFaultActive } from '@/lib/server/fault-injection'

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50

export async function POST(request: Request) {
  const user = await getSessionUser()

  if (!user) {
    return errorResponse('Not authenticated.', 401)
  }

  let body: unknown

  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid request body.', 400)
  }

  const parsed = createPostSchema.safeParse(body)

  if (!parsed.success) {
    return errorResponse(firstZodIssue(parsed.error), 400)
  }

  const { content, projectId, tags } = parsed.data

  try {
    if (projectId) {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true },
      })

      if (!project) {
        return errorResponse('Linked project does not exist.', 400)
      }
    }

    /*
     * LOW-01 INTENTIONAL RUNTIME ERROR
     *
     * This is intentionally active for the self-healing demonstration.
     * The source remains syntactically valid, but POST /api/posts
     * cannot create a post and returns HTTP 500.
     */
    if (isFaultActive('LOW-01')) {
    throw new Error('LOW-01: Post creation service failure')
    }

    const createData: Omit<
      Prisma.PostUncheckedCreateInput,
      'authorId'
    > & {
      authorId?: string
    } = {
      content,
      authorId: user.id,
      projectId: projectId ?? null,
      tags: tags ?? [],
    }

    const post = await prisma.post.create({
      data: createData as Prisma.PostUncheckedCreateInput,
      include: postInclude(user.id),
    })

    const postData = serializePost(post, user.id)

    return NextResponse.json(
      { post: postData },
      { status: 201 },
    )
  } catch (err) {
    return handleRouteError(err, request)
  }
}

export async function GET(request: Request) {
  const currentUser = await getSessionUser()

  const url = new URL(request.url)

  const author =
    url.searchParams.get('author')?.trim().toLowerCase() || null

  const page = Math.max(
    1,
    parseInt(
      url.searchParams.get('page') ?? '1',
      10,
    ) || 1,
  )

  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(
      1,
      parseInt(
        url.searchParams.get('pageSize') ??
          String(DEFAULT_PAGE_SIZE),
        10,
      ) || DEFAULT_PAGE_SIZE,
    ),
  )

  try {
    const where = author
      ? { author: { username: author } }
      : {}

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where,
        include: postInclude(currentUser?.id),
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),

      prisma.post.count({ where }),
    ])

    return NextResponse.json({
      posts: posts.map((post) =>
        serializePost(post, currentUser?.id),
      ),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(
          1,
          Math.ceil(total / pageSize),
        ),
      },
    })
  } catch (err) {
    return handleRouteError(err, request)
  }
}