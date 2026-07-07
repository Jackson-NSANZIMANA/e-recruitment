# ADR-003: CRDT + Vector Clocks for Offline Field Tablet Sync

**Status:** Accepted  
**Date:** 2025-07-02  

## Context
Field officers at physical testing venues use tablets in areas with unstable connectivity.
Score data must be captured offline and synced reliably without conflicts or stale-write overwriting.

## Decision
Automerge CRDT library for score records, with Ed25519 device signatures and vector clocks 
for conflict detection and stale-write rejection.

## Rationale
1. **Conflict-free merging:** CRDT operations are mathematically guaranteed to converge 
   regardless of sync order.
2. **Stale write prevention:** Vector clocks detect when a device is attempting to sync 
   data that predates a newer server record.
3. **Device signing:** Ed25519 signatures on each score record ensure a compromised tablet 
   cannot inject fabricated scores without detection.
4. **Immutability:** Once a score is device-signed and server-accepted, it cannot be modified — 
   only a new corrective record can be added (with audit trail).
