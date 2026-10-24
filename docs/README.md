# Docs index

| File | What it covers | Status |
|---|---|---|
| [Backend-Take-Home-Task.pdf](Backend-Take-Home-Task.pdf) | The original task (source of truth for requirements) | — |
| [discussion.md](discussion.md) | Running log of questions, answers and decisions, in order | Living |
| [architecture.md](architecture.md) | Components, deployment topology, request and sync flow | Agreed |
| [pos-integration.md](pos-integration.md) | How the POS behaves and how we react to each response | Agreed |
| [sync-state-machine.md](sync-state-machine.md) | Per-check sync model, worker claim/lease, ordering of create/cancel | Proposed |
| [rate-limiting.md](rate-limiting.md) | Shared per-restaurant limiter across API instances | Proposed |
| [schema.md](schema.md) | Tables, columns, enums, indexes; who writes which column | Proposed |
| [api.md](api.md) | Endpoints, check transitions, status codes, `GET /sync` response | Proposed |
| [risk.md](risk.md) | Risk register: what can go wrong, mitigation, what is left, which test covers it | Proposed |

[`CLAUDE.md`](../CLAUDE.md) lives at the repo root (Claude Code only loads it from there). Its hard rules come from these docs: keep them in sync.

`DECISIONS.md` (the 2-page deliverable at the repo root) is distilled from these files once the design is final.

Status meanings: **Agreed** = discussed and accepted. **Proposed** = drafted, still to be reviewed.
