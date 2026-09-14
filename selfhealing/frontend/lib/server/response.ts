import 'server-only'

import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import type { ZodError } from 'zod'
import { logApiError, resolveRequestId } from './logger'

export function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}

const DEFAULT_SERVER_ERROR = 'Something went wrong. Please try again.'

export function handleApiError(err: unknown) {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // Unique constraint violation (duplicate email/username).
    if (err.code === 'P2002') {
      const target = uniqueTarget(err)
      const field =
        target.includes('email')
          ? 'email'
          : target.includes('username')
            ? 'username'
            : 'field'
      return errorResponse(
        field === 'username'
          ? 'That username is already taken.'
          : field === 'email'
            ? 'An account with that email already exists.'
            : 'That value is already in use.',
        409,
      )
    }
    // Foreign key constraint violation (referenced record does not exist).
    if (err.code === 'P2003') {
      return errorResponse('Referenced resource does not exist.', 400)
    }
    return errorResponse(DEFAULT_SERVER_ERROR, 500)
  }
  return errorResponse(DEFAULT_SERVER_ERROR, 500)
}

/**
 * Error path used by route handlers: returns the same safe HTTP response as
 * `handleApiError` AND records the real runtime failure as a structured ERROR
 * LogEvent (errorName, message, stackTrace, sourceFile/sourceLine, requestId,
 * route, method, status). Discovery by the log monitor depends on this.
 *
 * Status is derived from the translated response so 4xx contract errors
 * (e.g. 409 duplicate) are logged accurately while unhandled exceptions stay 500.
 */
export function handleRouteError(
  err: unknown,
  request: Request,
  meta: { route?: string; method?: string; service?: string; errorCode?: string } = {},
): NextResponse {
  const response = handleApiError(err)
  const route = meta.route ?? urlPath(request.url)
  const method = meta.method ?? request.method
  const requestId = resolveRequestId(request) ?? undefined
  logApiError(err, {
    service: meta.service ?? 'api',
    route,
    method,
    status: response.status,
    requestId,
    errorCode: meta.errorCode,
  })
  return response
}

export function urlPath(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}`
  } catch {
    return url
  }
}

function uniqueTarget(err: Prisma.PrismaClientKnownRequestError): string {
  const target = err.meta?.target
  if (Array.isArray(target)) return String(target[0] ?? '')
  if (typeof target === 'string') return target
  // Driver-adapter errors nest the constraint index under driverAdapterError.
  const driver = err.meta?.driverAdapterError
  if (driver && typeof driver === 'object') {
    const cause = (driver as { cause?: { constraint?: { index?: string } } }).cause
    if (cause?.constraint?.index) return cause.constraint.index
  }
  return String(target ?? 'field')
}

export function firstZodIssue(err: ZodError): string {
  return err.issues[0]?.message ?? 'Invalid input.'
}
