import 'server-only'

import { z } from 'zod'
import { isFaultActive } from '@/lib/server/fault-injection'

// Server-only validation used by API routes (server-side) only.

export const POST_CONTENT_MAX = 1000
export const MAX_TAGS = 5

// LOW-03 (runtime fault): while active the minimum is raised to 1001 so
// valid content is rejected with a 400 (no exception, no source change).
function getPostContentMin(): number {
  return isFaultActive('LOW-03') ? 1001 : 1 // Normal
}

// NOTE: the LOW-03 min is evaluated at parse time (not build time) via refine
// so that activating/deactivating the fault takes effect on subsequent requests.
export const postContentSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    if (value.length < getPostContentMin()) {
      ctx.addIssue({
        code: 'custom',
        message: 'Post content is required.',
      })
    }
  })
  .max(POST_CONTENT_MAX, `Posts must be ${POST_CONTENT_MAX} characters or fewer.`)

export const tagSchema = z
  .string()
  .trim()
  .min(1, 'Tags must not be empty.')
  .max(24, 'Tags must be 24 characters or fewer.')
  .regex(/^[a-z0-9-]+$/, 'Tags may only contain lowercase letters, numbers, and hyphens.')
  .transform((t) => t.toLowerCase())

export const tagsSchema = z
  .array(tagSchema)
  .max(MAX_TAGS, `You can add up to ${MAX_TAGS} tags.`)

export const createPostSchema = z.object({
  content: postContentSchema,
  projectId: z
    .string()
    .trim()
    .min(1, 'Invalid project reference.')
    .optional()
    .nullable(),
  tags: tagsSchema.optional(),
})

export const updatePostSchema = z
  .object({
    content: postContentSchema.optional(),
    projectId: z
      .string()
      .trim()
      .min(1, 'Invalid project reference.')
      .optional()
      .nullable(),
    tags: tagsSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Nothing to update.',
  })
