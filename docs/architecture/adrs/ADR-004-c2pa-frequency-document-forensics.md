# ADR-004: C2PA + DCT Frequency Analysis for Document Forgery Detection

**Status:** Accepted  
**Date:** 2025-07-02  

## Context
The original document proposed Error Level Analysis (ELA) only. ELA fails against 
AI-generated documents (no compression artifacts to detect).

## Decision
Multi-stage forensics pipeline:
1. ELA (Error Level Analysis) — detects Photoshop-style pixel edits
2. DCT Frequency Domain Analysis — detects GAN/diffusion-generated documents
3. C2PA Manifest Verification — validates cryptographic provenance of NESA-issued documents
4. Font/Kerning Consistency — structural layout profiling
5. Stamp Ink Channel Separation — detects cloned digital stamps

## Rationale
Generative AI can produce photorealistic certificates with zero ELA signature.
DCT coefficient analysis detects the statistical fingerprints left by neural 
image generators in frequency space — invisible to ELA.
C2PA provides cryptographic ground truth for documents where NESA embeds provenance manifests.

## Consequence
Requires Python-based CV service (OpenCV, NumPy) alongside the Node.js service layer.
The forensics service is the only service with a Python runtime dependency.
