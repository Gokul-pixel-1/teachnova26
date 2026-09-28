# Jira approvals

BuildHub asks a human before it changes code. With the Jira channel on, the
approval request is a **Jira card** in project **KAN**, not an email. This
covers both pipelines:

| Pipeline | When a card is created | What the card shows |
|---|---|---|
| Self-healing (bug repair) | A MEDIUM/HIGH-risk patch is ready | Incident, AI root cause, before/after code, Critic + Judge, validation and rollback plan |
| UX suggestions | A new placement passed the sandbox test | Why (user behaviour), proposed change, sandbox rounds, **before/after screenshots attached** |

## Deciding

Cards wait in **In Review**.

- **Approve**: drag the card to **Done**, or comment `approve`.
- **Reject**: drag the card to **To Do**, or comment `reject`.

BuildHub checks Jira every 15 s. The app runs on localhost, so Jira cannot call
it back. When BuildHub sees a decision it:

1. runs the same approve or reject logic as the dashboard;
2. adds a **BuildHub:** comment with the result (for example "Patch applied and
   validation passed — INC-… is RESOLVED", or "rolled back");
3. moves the card to match the result.

Moving a card to **In Progress** decides nothing.

A card is open for 30 minutes (`JIRA_APPROVAL_TTL_MINUTES`). Approving after
that expires the request, and nothing is changed. A decision made in the
dashboard is also mirrored: BuildHub comments on the card and closes it.

If Jira cannot be reached, the request falls back to the approval email, so it
is never lost. Other emails and Telegram alerts (incident detected, final
result) are unchanged.

## One-time setup

1. Create an API token at
   https://id.atlassian.com/manage-profile/security/api-tokens.
2. From `selfhealing\frontend`, run:
   ```
   node scripts/jira-setup.mjs
   ```
   Paste the token when asked. It is hidden, and it is only stored in
   `.env.local`. The script checks the login, project KAN, the board statuses
   and your permissions, then saves the `JIRA_*` settings.
3. Restart BuildHub:
   ```
   powershell -ExecutionPolicy Bypass -File C:\Users\sugan\buildhub-tools\start-buildhub.ps1
   ```
4. Check the status at http://localhost:3000/api/jira/status. You need to be
   logged in as an operator. It should show `"channel":"jira"` and
   `"connection":{"ok":true,...}`.

Settings in `.env.local`:

| Setting | Meaning |
|---|---|
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Your Jira site and login |
| `JIRA_PROJECT_KEY` | Project (default `KAN`) |
| `JIRA_ISSUE_TYPE` | Issue type (default `Task`) |
| `JIRA_WAITING_STATUS` | Status cards wait in (default `In Review`) |
| `JIRA_APPROVE_STATUS` | Status that approves (default `Done`) |
| `JIRA_REJECT_STATUS` | Status that rejects (default `To Do`) |
| `APPROVAL_CHANNEL` | `jira` or `email` |
| `JIRA_APPROVAL_TTL_MINUTES` | How long a card stays open |
| `JIRA_POLL_SECONDS` | How often BuildHub checks Jira |

## Tests (never touch the real Jira)

TEST mode refuses any Jira address except localhost. The tests use a local
mock Jira:

```
node scripts/mock-jira.mjs                                              # window 1
powershell -ExecutionPolicy Bypass -File C:\Users\sugan\buildhub-tools\start-buildhub.ps1 -TestMode -JiraMock   # window 2
node scripts/verify-jira-approval.mjs                                   # window 3
```

The Jira suite has 44 checks:

- repair: approve by card move, reject by comment (background checker), dashboard decision mirrored, expiry;
- UX: approve (screenshots attached) and reject.

`verify-repair-flow.mjs` and `verify-ux-suggestions.mjs` pass in both the Jira
and the email channel.
