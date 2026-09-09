# #198 core perception and observation addressing

- Branch: `codex/198-core-implementation`.
- User approved the proposal direction and explicitly requested implementation after the design-only PR.
- Drivers optionally return measured popup/clickability/occlusion facts and opaque references for
  `snapshot({ perception: true })`; legacy no-options snapshots and frozen Target/Step vocabulary stay compatible.
- Shared ranking removes positive occlusion before region quotas, preserves accessible roles,
  prioritizes active popup candidates, reserves intent evidence, and enforces hard caps.
- A one-decision engine observation table maps fresh model tokens to original full-snapshot candidates.
  Semantic rendering contains no addressing generation, so unchanged compression and explore no-op detection survive rotating refs.
- Reference choices are canonicalized before ambiguity and consumer policy. Forged, conflicting,
  expired, duplicate-transformed, or already-consumed bindings fail without a name fallback.
- Exact dispatch uses optional `locateRef` and ref parameters through the existing step handler.
  Persistent targets are allowlisted before action; secret filling and origin checks retain their shared path.
- Discover, explore, surgical heal, and locate heal share the protocol. Both healing paths now reject
  ambiguous legacy choices and accept the caller's policy/perception adjustments.
- Added 19 regression cases in two new files; no existing test, helper, fixture, or snapshot changed.
  Red probes covered missing observation module, absent heal refs/ambiguity, absent explore perception,
  popup priority under long intents, and fact rendering.
- Verification: typecheck, build, dependency boundaries, 1,076 harness tests and 5 portability tests pass.
  CLI subprocess tests require local IPC, so the complete suite was run with the permitted escalation.
- State change for develop after merge: #198 runtime core implemented; Chrome facts/reference implementation
  and combined real-browser verification are integrated by the parent task. No release/version change.
