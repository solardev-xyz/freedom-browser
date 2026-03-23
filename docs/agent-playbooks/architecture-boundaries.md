# Architecture Boundaries Playbook

Use this playbook when a task can affect module ownership, service boundaries, or top-level package layout.

## Required Checks

1. Read the architecture sections in `README.md` before editing.
2. Confirm the task can be completed without changing top-level boundaries.
3. If boundary changes seem necessary, stop and ask for explicit approval.

## Safe Change Pattern

- Prefer extending existing modules over moving responsibilities between packages.
- Keep renderer and main-process responsibilities separated as currently defined.
- Avoid introducing new cross-layer dependencies unless approved.

## PR/Commit Notes

When architecture-adjacent changes are made, include:

- Why the chosen location fits current responsibilities.
- Why alternatives were not used (one short sentence is enough).
