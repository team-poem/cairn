# Probe fixtures

Real pages for the one piece of this engine that cannot be tested without a layout engine: the
in-page probe that decides whether a same-named element is reachable, occluded, or unmeasured
(`reachableRolesProbeScript`, #176). It reads `getBoundingClientRect`, `elementFromPoint` and the
computed `overflow`/`position` of ancestors — jsdom returns zeros for all of it, so a unit test can
only pin the script's *text*, which is how three real bugs shipped past green tests:

- a `\s` swallowed while assembling the script, leaving a regex that matched the letter "s";
- a scroll-clip check written against the wrong axis (it asked where the hit landed, not where the
  candidate's own centre sat);
- a `position: fixed` modal read as clipped by an ancestor whose overflow it escapes.

Each file is one layout, and the expectation lives next to it in `probe.browser.test.ts`. Every
element that matters is named "Continue", because the probe's whole job is telling same-named
elements apart. Add a fixture when a review turns up a layout the probe gets wrong — the file is the
report, and the test is the fix's proof.
