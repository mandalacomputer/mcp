# review 1

- base: `origin/main`
- head: `e76b1ad` on `OPL-4809-event-gap-attribution`
- when: 2026-09-12T22:31:06Z

# Codex Adversarial Review

Target: branch diff against origin/main
Verdict: needs-attention

Do not ship: buffer overflow during a wait can turn an unknown gap into a falsely precise count. Watch recovery showed no substantive regression. All 24 focused checks passed; the three new tests fail against main for their intended reasons, and the amended assertion still detects its original bug.

Findings:
- [medium] Preserve unknown cursor loss when overflow occurs during a wait (src/events.ts:946-953)
  Start a wait with an unplaceable since and no standing loss, then receive 1,025 nonmatching events followed by the match. Overflow now establishes a numeric #loss because waitFor no longer stamps null. This fallback selects that numeric loss instead of merging the unknown cursor gap. Reproduced with limit: 1: origin/main returns events: null; this branch returns events: 1025. The response conceals the unmeasurable history preceding the buffer and incorrectly presents local overflow plus omitted events as the complete loss count.
  Recommendation: For an unplaceable cursor, merge standing loss with events: null even when standing loss has a numeric count, preserving the cursor-gap explanation without mutating subscription state.

Next steps:
- Add a regression that starts an unknown-cursor wait before overflow and verifies events remains null, both with and without through-limit omissions.
