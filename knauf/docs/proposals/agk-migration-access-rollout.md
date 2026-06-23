# AGK Migration Access Rollout README

Last reviewed: 2026-06-12

## Summary

We should keep one shared list of users who are allowed to use the new Agentic Karl platform.

Both systems need to read the same decision:

- Old Karl: `https://karl.knauf.com`
- New Agentic Karl: `https://agentic-karl.knauf.com`

The important rule is simple:

```text
One user access list.
One runtime decision.
Both apps use the Okta user identity.
```

The preferred architecture is still an AGK-owned access API because it keeps database details inside AGK.
If the team chooses direct database access instead, both backends may read the same AGK Mongo/Cosmos entitlement collection, but only with the DB rules in this document.

## Problem

We have:

- Old Karl connected to the current production MongoDB/Cosmos database.
- More than 18k registered users.
- Around 8k active users.
- A future need to open the new platform in batches.
- Two apps that must agree whether a user is allowed into Agentic Karl.

Do not maintain two separate user lists.

```text
Bad approach:

Old Karl DB                 New AGK DB
+----------------+          +----------------+
| allowed users  |          | allowed users  |
+----------------+          +----------------+

Problem:
- Two lists to maintain
- Easy to forget one side
- Hard to audit
- Users can see different behavior in each app
```

## Recommended Source Of Truth

Use one AGK-owned entitlement collection.

```text
                         +--------------------------+
                         | AGK Mongo / Cosmos       |
                         | migration_entitlements   |
                         +------------+-------------+
                                      |
                                      |
                         +------------v-------------+
                         | AGK Backend API          |
                         | access decision service  |
                         +------------+-------------+
                                      |
             +------------------------+------------------------+
             |                                                 |
+------------v-------------+                    +--------------v-----------+
| Old Karl backend         |                    | New AGK backend          |
| karl.knauf.com           |                    | agentic-karl.knauf.com   |
+--------------------------+                    +--------------------------+
| Ask: is user enabled?    |                    | Ask: is user enabled?    |
| If yes: show button      |                    | If yes: allow app        |
| If no: normal old app    |                    | If no: waiting screen    |
+--------------------------+                    +--------------------------+
```

This is the cleanest boundary:

- AGK owns the new-platform access rules.
- Old Karl does not need AGK database credentials.
- AGK can change database schema later without changing Old Karl.
- The same logic can be reused by new AGK APIs and old Karl migration prompts.

## Direct Database Variant

The direct database option is possible, but it creates tighter coupling.

```text
Direct DB approach:

+------------------+          +--------------------------+          +------------------+
| Old Karl backend |--------->| AGK Mongo / Cosmos       |<---------| New AGK backend  |
| read only access |          | migration_entitlements   |          | read/write access|
+------------------+          +--------------------------+          +------------------+
```

Use this only if the team accepts these requirements:

- Old Karl gets a dedicated read-only Mongo credential.
- The credential can read only the entitlement collection or entitlement database.
- Old Karl must not use AGK's main application Mongo credential.
- AGK keeps write/admin ownership of the collection.
- Network access must exist from the Old Karl AKS/VNet to the AGK prod Mongo private endpoint.
- Private DNS, routing, NSG/firewall rules, Key Vault secret, and ExternalSecret wiring must be configured.
- Both apps must use the same lookup contract and the same deny-by-default behavior.

Direct DB access avoids a service-to-service API call, but it spreads AGK database knowledge into Old Karl.
The API approach is still the safer default for long-term ownership.

## User Identity Rule

Do not use either app's Mongo `_id` as the shared key.

Reason: old and new apps can have different user collections, so their Mongo IDs can differ.

Use the Okta/OpenID subject as the shared runtime key.

```text
Preferred runtime key:
Okta subject / OpenID subject / openidId

Example app field names:
- req.user.openidId
- token.sub
- user.openidId
```

The backend must get this value from the authenticated session or a verified Okta token.
Do not trust an Okta ID sent by the browser as a query parameter or request body field.

```text
Correct:
Backend reads authenticated user identity
        |
        v
Backend checks entitlement list

Wrong:
Browser sends ?oktaId=abc
        |
        v
Backend trusts the browser value
```

## Data Minimization Rules

Store only what is needed to make and audit the rollout access decision.

Required fields:

```text
+------------------+----------------------------------------------+
| field            | meaning                                      |
+------------------+----------------------------------------------+
| identityProvider | Okta environment, for example okta-prod       |
| oktaSubject      | stable Okta/OpenID subject                    |
| status           | enabled / disabled                           |
| batchId          | rollout batch, for example pilot-1            |
| source           | csv, rule, manual, admin, import              |
| createdAt        | audit timestamp                               |
| updatedAt        | audit timestamp                               |
| createdBy        | admin, script, or service that created record |
| updatedBy        | admin, script, or service that changed record |
| schemaVersion    | entitlement document version                  |
+------------------+----------------------------------------------+
```

Optional fields:

```text
+------------------+----------------------------------------------+
| field            | when to use                                  |
+------------------+----------------------------------------------+
| enabledFrom      | only if access starts in the future           |
| enabledUntil     | only if access must expire                    |
| emailHash        | troubleshooting or dedupe without raw email   |
| emailNormalized  | only if approved and needed for admin support |
| reason           | short rollout reason, not sensitive profile   |
+------------------+----------------------------------------------+
```

Do not store:

- Full name.
- Department.
- Job title.
- Country or region unless required by rollout rules.
- Okta groups.
- Old Karl Mongo user ID.
- AGK Mongo user ID.
- Access tokens.
- Refresh tokens.
- Session IDs.
- Avatars.
- Arbitrary Okta profile claims.
- Usage history or active-user analytics in this collection.

## Should We Store Email?

For runtime access checks, Okta subject is enough.

```text
Minimum production record:

{
  identityProvider: "okta-prod",
  oktaSubject: "<okta-subject>",
  status: "enabled",
  batchId: "pilot-1",
  source: "import",
  createdAt: "...",
  updatedAt: "...",
  createdBy: "...",
  updatedBy: "...",
  schemaVersion: 1
}
```

Email is useful for humans, but it is personal data and it is not the best runtime key.

Recommendation:

```text
Default:
- Store oktaSubject.
- Do not store raw email in migration_entitlements.

If support/admin needs email:
- Prefer emailHash.
- Store emailNormalized only with approval and a clear operational reason.
```

If email is stored:

- Normalize it with lowercase and trim.
- Treat it as PII.
- Do not use it as the primary key.
- Do not log it during normal access checks.
- Do not use it to grant access if the Okta subject does not match.

## Suggested Collection

Collection:

```text
migration_entitlements
```

Suggested document:

```json
{
  "identityProvider": "okta-prod",
  "oktaSubject": "00u123example",
  "status": "enabled",
  "batchId": "pilot-1",
  "source": "csv-import",
  "enabledFrom": "2026-06-15T00:00:00.000Z",
  "enabledUntil": null,
  "createdAt": "2026-06-12T10:00:00.000Z",
  "updatedAt": "2026-06-12T10:00:00.000Z",
  "createdBy": "migration-import-script",
  "updatedBy": "migration-import-script",
  "schemaVersion": 1
}
```

Suggested indexes:

```text
unique: identityProvider + oktaSubject
index:  status + batchId
index:  enabledFrom + enabledUntil
index:  emailHash, only if emailHash is used
```

Missing record means the user is not enabled.

```text
No entitlement record
        |
        v
Access denied to new AGK
Old Karl stays normal
```

## Runtime Access Check

Both systems must make the same decision.

```text
Input:
- authenticated Okta user

Lookup:
- identityProvider = okta-prod
- oktaSubject = authenticated user's Okta subject
- status = enabled
- enabledFrom is empty or in the past
- enabledUntil is empty or in the future

Output:
- enabled true or false
```

Pseudocode:

```text
user = getAuthenticatedUser(request)

identityProvider = "okta-prod"
oktaSubject = user.openidId or user.sub

entitlement = migration_entitlements.findOne({
  identityProvider,
  oktaSubject,
  status: "enabled"
})

if no entitlement:
  return enabled = false

if enabledFrom exists and enabledFrom > now:
  return enabled = false

if enabledUntil exists and enabledUntil <= now:
  return enabled = false

return enabled = true
```

Do not pass raw browser-provided `oktaSubject` into this lookup.
The backend should derive it from the authenticated user context.

## New App Behavior

Users can log in with Okta, but login alone does not mean they can use Agentic Karl.

```text
User opens Agentic Karl
        |
        v
Login with Okta
        |
        v
AGK backend reads Okta subject
        |
        v
Check migration_entitlements
        |
   +----+----+
   |         |
 allowed   not allowed
   |         |
   v         v
Use AGK   Show waiting screen:
          - access coming later
          - join waitlist
          - go to old Karl
```

The new app must enforce this on the backend.
A popup or frontend route guard is not enough.

Protected APIs should reject non-enabled users, including:

- Chat.
- Files.
- Agents.
- Conversations.
- Mutations.
- Any data export or integration action.

## Old App Behavior

Old Karl continues working normally.

For enabled users, Old Karl shows a modal and button.

```text
User opens Old Karl
        |
        v
Login with Okta
        |
        v
Old Karl backend checks same entitlement list
        |
   +----+----+
   |         |
 enabled   not enabled
   |         |
   v         v
Show modal  Normal old app
"Agentic Karl is available"
Button: Open Agentic Karl
```

If the entitlement check is temporarily unavailable, Old Karl should fail soft:

```text
Entitlement check unavailable
        |
        v
Do not show migration modal
Keep Old Karl usable
```

The new app should fail closed:

```text
Entitlement check unavailable
        |
        v
Do not allow protected AGK features
Show friendly waiting/error state
```

## Waitlist Rule

Keep waitlist data separate from entitlement data.

```text
+--------------------------+       +-----------------------------+
| waitlist_submissions     |       | migration_entitlements      |
+--------------------------+       +-----------------------------+
| user asked for access    |       | user is allowed access      |
| can contain email        |       | should use oktaSubject      |
| product/support workflow |       | runtime authorization check |
+--------------------------+       +-----------------------------+
```

The waitlist can store an email because the user explicitly submitted it.
The entitlement collection should stay minimal because it is used by both backends at runtime.

## API Option

If using the recommended API boundary, AGK exposes small access-decision endpoints.

```text
New AGK frontend/backend:
GET /api/migration/access

Old Karl backend:
POST /api/internal/migration/access/resolve
```

Example response:

```json
{
  "enabled": true,
  "status": "enabled",
  "newAppUrl": "https://agentic-karl.knauf.com",
  "oldAppUrl": "https://karl.knauf.com",
  "batchId": "pilot-1"
}
```

The old app should call AGK from its backend, not directly from the browser.

## Caching

Both approaches can cache the decision for a short time.

```text
Suggested cache TTL:
5 to 15 minutes
```

Cache key:

```text
migration-access:okta-prod:<oktaSubject>
```

Do not cache allowed users forever.
Access might need to be revoked.

## Logging And Audit

Audit entitlement changes.
Do not create noisy audit records for every normal access check.

Audit events should include:

- Who created or changed the entitlement.
- When it changed.
- Previous status.
- New status.
- Batch ID.
- Source.

Normal application logs should avoid raw email and raw Okta subject.
If correlation is needed, prefer a short hash or internal request ID.

## Why Not Other Options

### Do Not Use Build-Time Files

```text
Change user list
        |
        v
Rebuild app
        |
        v
Redeploy
        |
        v
Users get access
```

This is too slow and operationally heavy for a growing rollout list.

### Do Not Use Key Vault Or Env Vars

```text
Change secret
        |
        v
Refresh ExternalSecret
        |
        v
Restart pods
```

Key Vault is for secrets, not changing business access lists.

### Do Not Keep Two Mongo Lists

```text
Old list != New list
```

Two lists will eventually drift.

## Optional Alternative

If the company wants Identity/Okta to own rollout access, use an Okta group:

```text
Okta group:
karl-new-platform-enabled
```

This can also be a single source of truth.

However, if rollout batches are based on product usage, active-user data, personas, teams, or rules from the old Karl database, then an AGK-owned entitlement collection is more flexible.

## Recommended Decision

Use this by default:

```text
AGK Mongo/Cosmos collection
        |
        v
AGK access API
        |
        +--> New AGK enforces access
        |
        +--> Old Karl shows switch modal/button
```

If the team chooses direct DB instead:

```text
AGK Mongo/Cosmos collection
        |
        +--> New AGK backend reads/writes
        |
        +--> Old Karl backend reads only
```

In both cases, the data model and runtime decision must remain the same.

## Implementation Plan

```text
Phase 1
- Create migration_entitlements collection
- Add schema validation or model validation
- Add indexes
- Add import script for oktaSubject-based batches

Phase 2
- Add AGK entitlement service
- Add backend enforcement in AGK
- Add waiting screen and waitlist flow in AGK

Phase 3
- Choose Old Karl integration style:
  - preferred: call AGK access API
  - alternative: direct read-only DB lookup
- Add Old Karl modal and button

Phase 4
- Add admin or batch tooling
- Add audit logs for entitlement changes
- Backfill first pilot batch
```

## Open Questions

1. Will batches be based on Okta groups, product usage, business rules, or manual CSV import?
2. Does support/admin need to see email in the entitlement collection, or is `oktaSubject` enough?
3. If email is needed, should we store `emailHash` only or approved `emailNormalized`?
4. Should direct DB access be accepted, or should Old Karl call AGK through an API?
5. Who manages batches: admin UI, script, scheduled rule, or Okta?
6. Should access be reversible per user and per batch?
7. What should the first pilot batch be?

## Jira Ticket Context

Title:

```text
Implement shared migration entitlement list for Agentic Karl rollout
```

Background:

```text
Old Karl and Agentic Karl need a shared runtime decision for whether an authenticated user can access the new Agentic Karl platform. We must avoid maintaining separate access lists in both systems because they can drift and create inconsistent user behavior.
```

Goal:

```text
Create one AGK-owned migration entitlement list keyed by Okta/OpenID subject. Both Old Karl and Agentic Karl must reference this list to decide whether a user can access the new platform or should stay on the old platform/waitlist flow.
```

Scope:

- Create `migration_entitlements` collection/model.
- Store minimal access data keyed by `identityProvider + oktaSubject`.
- Add required indexes.
- Implement runtime access check.
- Enforce access in Agentic Karl backend.
- Expose API endpoint for Old Karl or document direct read-only DB lookup.
- Add Old Karl modal/button behavior for enabled users.
- Add waiting screen behavior for non-enabled users in Agentic Karl.

Data minimization requirements:

- Required runtime key is Okta/OpenID subject.
- Do not store old/new Mongo user IDs.
- Do not store tokens, sessions, full profile claims, department, job title, or usage history.
- Do not store raw email unless there is an approved support/admin reason.
- Prefer `emailHash` over `emailNormalized` if troubleshooting or dedupe is needed.
- Missing entitlement record must mean not enabled.

Acceptance criteria:

- Given an enabled Okta subject, Agentic Karl allows the user into protected backend features.
- Given a missing, disabled, expired, or future entitlement, Agentic Karl blocks protected backend features.
- Given an enabled Okta subject in Old Karl, Old Karl displays the migration modal/button to open Agentic Karl.
- Given a non-enabled Okta subject in Old Karl, Old Karl behaves normally without the modal.
- Old Karl remains usable if the entitlement check fails.
- Entitlement lookup uses the backend-authenticated Okta subject, not a browser-provided parameter.
- Entitlement documents contain only approved minimal fields.
- Unique index exists on `identityProvider + oktaSubject`.
- Access decisions can be updated at runtime without rebuilding or redeploying either frontend.

Out of scope:

- Full admin UI for batch management unless separately requested.
- Okta group management automation.
- Migration of historical user profile data.
- Replacing Old Karl authentication.

Implementation note:

```text
Preferred integration:
Old Karl backend calls AGK access API.

Accepted alternative:
Old Karl backend reads AGK Mongo/Cosmos directly with a dedicated read-only credential and required network/private DNS setup.
```
