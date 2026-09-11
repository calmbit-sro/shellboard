# 2026-08-16 — Repo transfer ok2cqr → calmbit-sro

- **Branch:** master (commit `ae30739`)
- **Participants:** Petr + Claude (Fable 5)

## Context

Petr wanted the whole repository moved under https://github.com/calmbit-sro.
`calmbit-sro` turned out to be a **personal account, not an org**, which shaped
the mechanics: user-to-user transfers need e-mail acceptance by the recipient.

## What was done

- Initiated GitHub transfer via `POST /repos/ok2cqr/shellboard/transfer`
  using the `ok2cqr` token (`gh auth token --user ok2cqr`) — the active
  gh account (`calmbit-sro`) had no admin on the source repo.
- Petr accepted the transfer from the calmbit-sro account's e-mail;
  repo now lives at **calmbit-sro/shellboard**.
- Local `origin` re-pointed to `git@github.com:calmbit-sro/shellboard.git`.
- Verified all 16 `APPLE_*` Actions secrets survived the transfer —
  tagged-release signing/notarization needs no re-setup.
- `ae30739`: `src/utils/updateCheck.ts` `REPO` constant updated to
  `calmbit-sro/shellboard` (only hardcoded old-path reference in the repo).
- Pushed by Petr; SSH still authenticates as `ok2cqr`, which works because
  GitHub adds the previous owner as a collaborator on user-to-user transfers.

## Key decisions

- Transfer (not create-new-and-push): preserves issues, releases, tags,
  stars, watchers, secrets, and sets permanent redirects from the old URL.

## Open questions

- None. (Redirect from `ok2cqr/shellboard` holds only until a repo with
  that name is re-created under `ok2cqr` — don't.)

## Next steps

- Nothing pending from this session. Future privileged gh calls no longer
  need the `ok2cqr` token switch — `calmbit-sro` is now the repo owner.
