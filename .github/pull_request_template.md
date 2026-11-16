## Summary

<!-- What changed, and why. One or two sentences. -->

## Verification

<!-- What you actually ran, and what it showed. Not what you intended to run. -->

- [ ] `bun run verify` passes
- [ ] `bun run hooks` reports every guard live
- [ ] `./scripts/check-tarball.sh` clean, if anything shipped changed

## What was not tested

<!-- State it plainly. Unverified work described as done is worse than work
     described as unverified. -->

## Checks

- [ ] No client, supplier or account named in the code, the commit messages, or this description
- [ ] Anything that writes to the accounting system is gated on a human confirmation
