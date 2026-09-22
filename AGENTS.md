# Instructions for AI agents working in this repository

Read these first. They apply to every agent (Codex, Claude, Copilot, anything else):

1. **`CLAUDE.md`** (if your clone has one; it is gitignored): repository rules (stamp the lineage after an upstream
   merge, the protocol number, the pre-commit gate).
2. **`docs/UI_GUIDE.md`**: how the interface must look and read. Read it before
   changing anything in `web/`. It covers the text budget (short labels,
   one-sentence hints, no design rationale on screen, no em dashes), the page
   kit, where new features go, and which classes to use.
3. **`VERSIONING.md`**: build line and version numbers.

Changes must work on NVIDIA, AMD, Intel and CPU-only machines, and on portable,
source and Desktop installs.
