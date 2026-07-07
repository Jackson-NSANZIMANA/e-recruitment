# Application Status History Pattern

Every agency schema (rdf_ops, rnp_ops, rcs_ops) includes
an application_status_history table alongside the main
applications table.

WHY: Application status is never overwritten.
     Each status transition creates a new immutable row.
     This provides:
     1. Full audit trail of every status change
     2. Ability to reconstruct timeline for investigations
     3. Compliance with Law N° 058/2021 audit requirements

PATTERN:
  applications.status = CURRENT status (denormalized for query performance)
  application_status_history = FULL IMMUTABLE HISTORY

When a status changes:
  1. INSERT into application_status_history (old → new, reason, actor)
  2. UPDATE applications.status = new status
  Both in the same database transaction.
