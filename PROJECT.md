# Vedic FHE Match MVP (Basic)

## What
A basic, deployable frontend shell implementing the first pass of the PRD:
- Create Profile screen
- Matching Status screen
- Result screen with state cards
- Section-level design notes and implementation checklist

This version now has two tracks:
- User-facing app shell (create profile, wallet connect, matching simulation, consent/reveal states)
- Backend simulation harness for consent/decrypt state-machine and race-safety tests

The internal build checklist is now kept in project docs, not exposed in the UI.

## Required env
- None for local preview
- `VERCEL_TOKEN` only if deploying via CLI in this workspace

## How to start
- Local preview: serve `src/` as static site
- Vercel: deploy project root with Output Directory = `src`

## Outputs
- Live UI app shell with:
  - Wallet connect button + network check
  - Profile creation with validation
  - Local derivation + encryption simulation hooks
  - Matching state simulation (normal vs delayed)
  - Result cards with consent/decline/reveal/share transitions

- Backend simulation harness:
  - `backend/state_machine.py` (core transition logic)
  - `backend/sim_test.py` (deterministic test scenarios)
  - `backend/README.md` (runbook + next steps)

## Troubleshooting
- If Vercel deploy fails due to auth linkage, connect this directory to your existing Vercel project or provide org/project IDs.
- If preview shows blank page, refresh once after first load.
