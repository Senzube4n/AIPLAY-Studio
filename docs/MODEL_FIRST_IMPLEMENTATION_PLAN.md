# Model-first setup: minimal implementation plan

Baseline: `e9c6b46`. The only pre-existing working-tree addition was `AIPLAY_CURRENT_STATE_AUDIT.md`; preserve it. This plan was established before implementation or commits.

1. Add dependency-free shared workflow/profile metadata referencing existing capability IDs and curated file manifests. Preserve existing IDs, graph builders and target-specific installers. Verify ACE XL artifact identity, companions and workflow defaults from pinned upstream metadata before enabling installation; retain experimental inference status.
2. Extend the existing Your Goal panel with category combinations and per-category model choices. Store validated preferences through `PREF_PATHS`. Add a corresponding Local planning surface within existing Settings/Models navigation, with explicit launch-mode guidance rather than changing the running server mode.
3. Build a server-side selected-model plan from the shared profiles, existing `fitFor` rules, local/remote inventory and workload settings. Deduplicate artifact storage; use maximum sequential VRAM requirements, with evidence qualifiers. Rank current NVIDIA RunPod inventory into Budget/Recommended/Performance only where justified. Keep manual choices and fresh price approval.
4. Resolve selected profiles through the existing local and worker download managers. Extend reviewed bundle manifests for supported ACE variants; do not introduce a second transfer engine or relay weights through the PC.
5. Report provider state, worker connection, verified artifacts, runtime nodes, workflow schema and successful inference separately. Bind remote checks to the selected worker/computer. Replace fixed goal-bundle readiness with the persisted selected plan.
6. Reuse existing generation selection/submit handlers and saved preferences. Discover remote ACE DiTs and companion choices from remote loader metadata. Label execution locations and preserve native/local/API restrictions.
7. Extend existing suites for selections/migration, manifests, fit/storage planning, guarded routes, installers, staged readiness and generation regressions. Browser-check the existing layout at normal and narrow widths. Run the mandatory repository gate.
8. Update the implementation report after each phase with evidence and limitations. Paid hardware acceptance is a separate explicitly authorized activity; no provider resource mutations or weight downloads are part of implementation validation.

Constraints: no sidebar/application redesign, replacement libraries, universal mode-switch toggle, automatic resource replacement, secret duplication or unsupported workflow claims. The cloud wizard remains Your Goal → Costs → Install AI → Ready.
