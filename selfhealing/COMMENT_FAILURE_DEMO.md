# COMMENT-01 — physical “Cannot Comment” replacement

This is a controlled source-file demo. It intentionally replaces the normal
route with a complete drop-in copy whose `POST` handler throws before the real
Prisma insert. Do not overwrite the original automatically.

## Files

- Original: `frontend/app/api/posts/[id]/comments/route.ts`
- Replacement: `COMMENT_FAILURE_ROUTE.ts`
- Handler: exported `POST` in both files

The replacement preserves authentication, parsing, response helpers, Prisma
queries, serialization, and `GET`. Its only behavioral change is the deliberate
`COMMENT-01` server error immediately before `prisma.comment.create(...)`.

## Backup, replace, and reproduce

From `~/selfhealing`:

```bash
cp frontend/app/api/posts/[id]/comments/route.ts frontend/app/api/posts/[id]/comments/route.ts.backup
cp COMMENT_FAILURE_ROUTE.ts frontend/app/api/posts/[id]/comments/route.ts
```

With an authenticated user, create a comment in the normal UI or call
`POST /api/posts/<real-post-id>/comments`. The expected result is **HTTP 500**
with the normal structured route error (`COMMENT-01: Injected comment service
failure`). The logger records the failure and observability creates an incident.

## Expected self-healing

The persisted incident is detected by the existing monitor and proceeds through
Analyzer → Coder → Critic → Judge and the applicable risk policy. The repair
should restore the original working route, then validation must perform a real
comment creation and verify the persisted post and author relationships. The
incident is resolved only after that validation succeeds. Gmail approval applies
only when the persisted risk policy requires it; this physical failure is
normally LOW risk.

## Verify recovery

After repair, repeat `POST /api/posts/<real-post-id>/comments`. Expect **HTTP
201** and a returned comment. Verify the new row in the database has the target
`postId` and authenticated `authorId`.

## Manual restoration

If needed, restore the backup explicitly:

```bash
cp frontend/app/api/posts/[id]/comments/route.ts.backup frontend/app/api/posts/[id]/comments/route.ts
```

Remove the backup only when the restored route has been verified. The normal
working route must be left in place after testing.
