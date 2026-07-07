# ADR-001: Apache Kafka over RabbitMQ for Event Streaming

**Status:** Accepted  
**Date:** 2025-07-02  
**Deciders:** Principal Engineer

## Context
USRP requires asynchronous event processing for G2G API vetting calls (NIDA, NESA, RIB). 
The original document listed "Kafka or RabbitMQ" as equivalent options.

## Decision
Apache Kafka in KRaft mode (no Zookeeper).

## Rationale
1. **Audit immutability:** Kafka's append-only log creates an inherent immutable audit trail. 
   Every vetting action is a permanent, replayable record — satisfying government audit requirements.
2. **Multi-consumer fan-out:** A single `ApplicantSubmittedEvent` must trigger NIDA, NESA, and 
   RIB workers simultaneously. Kafka consumer groups handle this natively.
3. **State reconstruction:** If the system crashes mid-vetting, Kafka's log compaction enables 
   full state recovery from offset replay.
4. **KRaft mode:** Eliminates Zookeeper dependency — saves ~256MB RAM on constrained dev hardware.

## Consequences
- Adds operational complexity over RabbitMQ
- Requires Schema Registry for Avro schema evolution
- Consumer group management requires careful offset handling
