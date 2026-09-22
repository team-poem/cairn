---
issue: null
pr: 256
status: in-progress
summary: Keep opt-in target-choice policy out of the browser bundle and skip unused replay accounting
next: Review the paired benchmark and approved hosted evaluation before adopting the pilot
---

The first cairn-pingu report measured a 1,024-byte browser gzip increase. Its four replay samples
per tier do not establish a runtime regression. Dependency analysis located finite-choice policy
and response validation in the browser-exported SelfHealingDriver, despite the pilot's composition
being exposed through the Node entry.

The policy now arrives through createTargetChoiceRepair; the existing browser driver still
performs the same grounding, reference validation, policy check and tentative-repair confirmation.
The runScenario.targetChoice API is unchanged. Direct users of the experimental decorator option
wrap their configuration with the factory. A bundle-graph check prevents the policy/provider
modules from returning to the browser surface. Usage accounting and pending repairs are allocated
only when used.

The split trades a small npm tarball increase for lower browser download size; both are reported
in the validation record. The existing paired benchmark is unchanged, including its fixtures,
original assertions, warmup exclusion and AB/BA schedule. Scripted provider checks remain contract
evidence only. Neither a speedup nor Jev quality is inferred from them.
