# Authorization ratification pack — who may do what

**Purpose:** the eight roles and their permissions in
`packages/shared-auth/src/permissions.ts` are an engineering default. Each
agency must ratify or amend them. Nothing here is policy until signed.

## 1. Roles → permissions (current default)

| Role | Permissions | Agency decides |
|---|---|---|
| `agency_admin` | all `campaign.*`, `application.read`, `adjudication.read` | May ever decide candidates? (default: no) |
| `reviewer` | `campaign.read.admin`, `application.read`, `adjudication.read` | — |
| `screening_officer` | `walkin.register`, `walkin.vet`, `identity.verify`, `biometric.verify`, `document.verify.venue`, `field.device.enroll`, `field.score.sync`, + read | Venue staffing. `document.verify.venue` = the front-door check-in post clears a paper at the venue (**decided 2026-10-14**, ADR-032) |
| `field_supervisor` | `field.device.enroll`, `field.score.sync`, `field.conflict.resolve`, + read | Who resolves physical-evidence conflicts |
| `medical_officer` | `medical.review`, + read | RDF board vs RNP/RCS certificate verification |
| `adjudicator` | `adjudication.decide`, + read | Document / late-disqualification holds |
| `decision_authority` | `decision.final`, `application.accept`, + read | **Who signs and who enlists** |
| `dpo` | `erasure.queue.read`, `erasure.decide` | Law N° 058/2021 officer |

## 2. Separation of duties (per application)
| Rule | Default | Decision needed |
|---|---|---|
| Final decision ≠ officer who recorded the medical verdict | **ON** | Confirm |
| Accept ≠ officer who signed the final decision | off | On or off? |
| Any override of the above | none exists | Needed? Who? Reason + audit? |

## 3. Migration of existing accounts
Accounts provisioned before this change carry `reviewer` and/or `agency_admin`
only. They keep read access and campaign administration; they **lose** medical,
final-decision, accept, adjudication, walk-in, field and biometric actions until
re-provisioned. Required before go-live: a signed list of officer → post per
agency, applied by an authorised administrator. There is no role-assignment API
yet (officer lifecycle is open).

## 4. Sign-off
| Agency | Name / post | Date | Signature |
|---|---|---|---|
| RDF | | | |
| RNP | | | |
| RCS | | | |
