# COMPLETE REPOSITORY AUDIT — READ-ONLY

Act as a principal software engineer performing a complete pre-production audit of this application.

This is NOT a targeted feature review.

I want you to inspect the entire meaningful codebase and discover the application yourself.

Do not assume what the application does from previous conversations, documentation, filenames, or my description.

The source of truth is the repository.

## Important known context

I already know that some areas may be unfinished, for example:

- SMTP / email functionality
- custom domain functionality

These are examples only.

Do NOT limit your unfinished-feature search to these areas.

Your job is also to discover:

- partially implemented features
- abandoned implementations
- TODO functionality
- placeholder code
- mocked production behavior
- unfinished integrations
- code paths that are implemented only on frontend or backend
- features exposed in UI but not fully functional
- backend capabilities with no working UI
- config/env variables for functionality that is never completed
- dead integrations
- migration/schema fields that are never used
- incomplete production setup

Do not treat unfinished functionality automatically as a bug.

Classify it properly as:

- intentionally unfinished
- partially implemented
- broken
- dead/obsolete
- unclear
- production blocker

---

# MODE

You are initially in READ-ONLY AUDIT MODE.

Do NOT:

- modify source files
- modify tests
- modify documentation
- modify configuration
- modify package files
- create migrations
- refactor code
- fix issues
- create new functionality

You may run safe read-only commands and existing verification commands such as tests, lint, typecheck, coverage, and builds.

After completing the audit, stop.

Do not create a fix plan until I ask for one.

---

# CORE REQUIREMENT

I want evidence that the repository was actually inspected.

Do not only inspect:

- entry points
- large files
- files mentioned in documentation
- files referenced by tests
- obvious features

Inspect ALL meaningful source areas.

Ignore only clearly generated or dependency directories such as:

- node_modules
- dist
- build
- coverage
- .git
- generated caches
- vendor dependencies
- framework output directories

If unsure whether a directory contains meaningful project code, inspect it.

---

# PHASE 1 — REPOSITORY INVENTORY

First create a complete repository map.

Identify:

- applications
- packages
- libraries
- source folders
- API/backend code
- frontend/client code
- database/schema/models
- migrations
- jobs/workers/queues
- CLI/scripts
- authentication
- authorization
- middleware
- integrations
- email
- domains/DNS
- storage/uploads
- payments, if present
- webhooks
- sockets/realtime, if present
- cron/scheduled tasks
- background jobs
- admin functionality
- user functionality
- public functionality
- configuration
- environment variables
- tests
- E2E tests
- CI/CD
- deployment
- infrastructure
- documentation

Do not begin with assumptions about which features are important.

Discover them from the code.

---

# PHASE 2 — INSPECTION LEDGER

Create an inspection ledger.

For every meaningful directory, record:

| Path | Purpose | Important files | Files inspected | Status | Risk |
|---|---|---|---|---|---|

Status must be one of:

- fully inspected
- partially inspected
- not yet inspected

Do not finish the audit while meaningful directories remain marked `not yet inspected`.

For unusually large directories, summarize how many meaningful files exist and how many were inspected.

I want this ledger to demonstrate repository coverage.

---

# PHASE 3 — APPLICATION DISCOVERY

Determine what the application actually does.

Create a feature inventory based on implementation.

For every discovered feature include:

- feature name
- purpose
- user/persona using it
- frontend entry point
- backend/API entry point
- business logic
- database entities
- external integrations
- config/env dependencies
- tests
- current implementation status

Status must be one of:

- complete
- mostly complete
- partial
- scaffold only
- broken
- dead/obsolete
- unclear

Do not rely on documentation for implementation status.

Verify it against code.

---

# PHASE 4 — TRACE EVERY MAJOR FEATURE END-TO-END

For every meaningful feature, trace:

user action
→ frontend
→ client state
→ API request
→ authentication/authorization
→ validation
→ backend/controller
→ service/business logic
→ database
→ external service if applicable
→ response
→ frontend result
→ failure handling

Check both success and failure paths.

Look for:

- missing links in the flow
- frontend/backend disagreement
- state inconsistencies
- missing validation
- missing authorization
- incorrect assumptions
- unexpected null/undefined states
- unhandled errors
- retries
- duplicate operations
- stale state
- race conditions
- transaction problems
- partial writes
- incorrect caching
- lost updates
- timeout behavior
- recovery behavior

---

# PHASE 5 — FIND UNFINISHED FUNCTIONALITY

Search deliberately for evidence of incomplete work.

Look for:

- TODO
- FIXME
- HACK
- temporary implementations
- placeholders
- stub methods
- empty handlers
- commented-out implementation
- mock data
- fake success responses
- hardcoded values
- development-only behavior leaking into production
- `throw new Error("Not implemented")`
- disabled UI
- hidden feature controls
- unused env variables
- unfinished database columns
- unused API endpoints
- incomplete providers/adapters
- feature flags permanently disabled
- unfinished onboarding/setup flows
- missing error states
- incomplete third-party integrations

Specifically inspect SMTP/email and custom-domain functionality, but do not stop there.

For every incomplete area report:

- feature
- files
- what currently exists
- what is missing
- whether current UI exposes it
- whether current API exposes it
- whether database/config support exists
- risk
- classification:
  - intentional unfinished work
  - partial implementation
  - broken implementation
  - dead code
  - production blocker
  - needs clarification

---

# PHASE 6 — LOGIC AUDIT

Review business logic carefully.

Do not assume that code is correct because:

- it compiles
- tests pass
- it has been in the repository for a long time
- another agent reviewed it
- documentation describes it

Search for:

- incorrect conditions
- inverted checks
- incorrect defaults
- bad state transitions
- missing state transitions
- impossible states
- invalid combinations of data
- arithmetic errors
- timezone/date bugs
- pagination bugs
- filtering bugs
- sorting bugs
- ownership mistakes
- stale data assumptions
- concurrency bugs
- duplicate submission bugs
- idempotency problems
- error swallowing
- false-success responses

Trace suspicious logic to its callers and consumers before reporting it.

---

# PHASE 7 — DATABASE AND DATA INTEGRITY

Inspect:

- schema/models
- migrations
- indexes
- relations
- foreign keys
- unique constraints
- nullability
- defaults
- cascades
- soft delete behavior
- transactions
- raw queries
- data ownership
- data lifecycle

Look for situations where application logic expects something that the database does not enforce.

Look for:

- orphaned data
- duplicate records
- missing indexes
- missing uniqueness
- dangerous cascades
- incorrect nullability
- schema/code disagreement
- migration drift
- old fields no longer used
- new fields not fully integrated

---

# PHASE 8 — SECURITY AUDIT

Review:

- authentication
- sessions/tokens
- authorization
- ownership
- role permissions
- tenant isolation if applicable
- password handling
- reset flows
- email verification
- dangerous actions
- public APIs
- admin APIs
- webhooks
- uploads
- secrets
- environment variables
- CORS
- CSRF
- SSRF
- XSS
- SQL/ORM injection risks
- rate limiting
- brute-force protection
- API abuse
- sensitive logging
- sensitive data exposure

For each issue distinguish:

- theoretical concern
- realistic vulnerability
- exploitable vulnerability
- production blocker

---

# PHASE 9 — EXTERNAL INTEGRATIONS

Find every external integration automatically.

Examples may include:

- SMTP/email provider
- custom domains/DNS
- authentication providers
- cloud storage
- payment providers
- analytics
- queues
- messaging
- third-party APIs
- webhooks

For each integration inspect:

- configuration
- setup
- credentials
- runtime handling
- retries
- timeout behavior
- failure handling
- idempotency
- test/mock behavior
- production readiness

Identify integrations that appear configured but are actually incomplete.

---

# PHASE 10 — TEST AUDIT

Discover the actual testing stack from the repository.

Run the existing coverage commands if safe.

Do not merely report coverage percentages.

Map tests to features.

For each major feature determine:

- unit coverage
- integration coverage
- E2E coverage
- error-path coverage
- permission coverage
- edge-case coverage
- regression coverage

Find:

- critical code with no tests
- branches with no tests
- tests with weak assertions
- tests that mock away the behavior they claim to test
- duplicate tests
- brittle tests
- tests that always pass
- skipped tests
- disabled test suites
- missing regression tests

For each missing test explain what real failure it could catch.

Do NOT recommend tests solely to increase the percentage.

---

# PHASE 11 — STATIC QUALITY CHECKS

Inspect existing project scripts before running anything.

Where available run:

- test
- test coverage
- lint
- typecheck
- build
- E2E
- dependency audit

Do not install new tools without approval.

Report the exact command and result.

Distinguish:

- existing failure
- warning
- configuration issue
- environmental failure
- code failure

---

# PHASE 12 — PRODUCTION READINESS

Review whether this application could safely be deployed and operated.

Inspect:

- startup
- environment validation
- production config
- database migrations
- background jobs
- deploy scripts
- CI/CD
- logging
- monitoring
- backups
- recovery
- rollback
- health checks
- shutdown handling
- secrets
- dependency vulnerabilities
- retry strategy
- error reporting
- unfinished production integrations

Identify anything that works locally but may fail in production.

---

# PHASE 13 — CODE QUALITY / CLEARLY BETTER IMPLEMENTATIONS

Find code that can objectively be improved.

Only report improvements that provide concrete value:

- reduce bug risk
- remove duplicated business logic
- improve security
- improve correctness
- improve data integrity
- improve maintainability significantly
- improve testability
- improve meaningful performance
- simplify fragile code

Do NOT report subjective formatting/style preferences.

Do NOT propose rewrites merely because another architecture is fashionable.

For every improvement explain:

- current implementation
- problem
- proposed approach
- measurable benefit
- risk of changing it
- priority

---

# FINDING FORMAT

Every finding must contain:

**ID**

**Severity**
- Critical
- High
- Medium
- Low
- Informational

**Confidence**
- High
- Medium
- Low

**Category**

**File(s)**

**Function/class/component**

**Observed behavior**

**Why it is a problem**

**Real failure scenario**

**Evidence**

**Recommended direction**

**Regression test needed**
- yes / no

**Production blocker**
- yes / no

Do not report speculative problems as confirmed bugs.

---

# FINAL REPORT

Produce:

## 1. Executive Summary

## 2. Repository Inspection Coverage

Include:
- meaningful directories discovered
- directories fully inspected
- directories partially inspected
- directories not inspected
- approximate meaningful files inspected

If anything important was not inspected, say so explicitly.

## 3. Application Feature Inventory

## 4. Complete / Partial / Broken Feature Matrix

## 5. Known Unfinished Areas

Including SMTP and custom domains plus anything else discovered.

## 6. Critical Findings

## 7. High Findings

## 8. Medium Findings

## 9. Low / Informational Findings

## 10. Security Review

## 11. Data Integrity Review

## 12. Integration Review

## 13. Frontend/Backend Contract Review

## 14. Test Coverage Review

## 15. Missing Regression Tests

## 16. Static Analysis / Build / Test Results

## 17. Production Readiness

## 18. Clearly Better Improvements

## 19. Dead / Duplicate / Obsolete Code

## 20. Documentation vs Code Discrepancies

## 21. Top 10 Risks

## 22. Areas Requiring Manual Verification

## 23. Recommended Follow-Up Audit Order

Do NOT create a fix plan yet.

Do NOT modify anything.

Stop after the audit and wait for my instruction.

---

# FINAL QUALITY RULE

A long report is not automatically a good report.

I would rather have:

- 25 verified findings

than:

- 100 speculative findings.

Trace claims back to actual code.

Challenge your own conclusions before including them.

If you suspect an issue but cannot prove it, label it as:

`NEEDS VERIFICATION`

rather than presenting it as fact.