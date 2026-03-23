# Security Checklist Playbook

Use this checklist before commit and before creating a PR.

## Sensitive Data

- Ensure no secrets are added (`.env`, API keys, private tokens, credentials).
- Check staged files for accidental secret material.

## Change Risk

- Confirm no debug backdoors or permissive defaults were introduced.
- Confirm access checks and validation logic were not weakened.

## Dependency and Surface Changes

- Verify new dependencies are necessary and from trusted sources.
- Review network-facing changes for input validation and error handling.

## Final Verification

- Ensure logs and error messages do not expose sensitive information.
- Keep the final diff focused on requested behavior.
