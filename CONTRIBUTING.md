# Contributing to EdgeClaw

Thank you for your interest! This document covers how to set up a development environment, submit pull requests, and follow the project's code style.

---

## Development setup

1. **Fork and clone**
   ```bash
   git clone https://github.com/yourusername/cf-truth.git
   cd cf-truth
   npm install
   ```

2. **Configure Wrangler**
   ```bash
   cp wrangler.example.jsonc wrangler.jsonc
   # Fill in all YOUR_* placeholders
   ```

3. **Add secrets (local dev)**
   ```bash
   wrangler secret put ANTHROPIC_API_KEY
   ```

4. **Verify the setup**
   ```bash
   npm run type-check   # must pass with zero errors
   npm run lint         # must pass with zero warnings
   npm run dev          # starts local Worker emulation
   ```

---

## Pull request workflow

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```

2. Make your changes. Run `npm run type-check` and `npm run lint` before committing.

3. Push and open a PR against `main`. Fill in the PR template:
   - **What** -- what the change does
   - **Why** -- motivation or issue link
   - **Testing** -- how you verified the change

4. A maintainer will review and merge. Please respond to review feedback promptly.

---

## Code style

| Rule | Detail |
|---|---|
| Language | TypeScript strict (`noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`) |
| Formatter | Prettier (`npm run format`) -- run before committing |
| Linter | ESLint (`npm run lint`) -- zero warnings policy |
| Imports | Named imports only; no default exports except Worker entry points |
| Types | Prefer `interface` over `type` for object shapes; `type` for unions/aliases |
| Error handling | Use typed errors at system boundaries; don't swallow errors silently |

---

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add per-agent rate limiting via Durable Objects
fix: prevent double-execution of recovery hook
docs: add CONTRIBUTING.md
refactor: extract webhook validation into lib/validation.ts
test: add ModelRouter unit tests
```

---

## Testing expectations

Currently the project uses `tsc --noEmit` and ESLint as the only automated checks. When adding new logic:

- Add inline documentation for any non-obvious behavior.
- If the Roadmap item for Vitest unit tests has shipped, add tests alongside your change (`src/**/*.test.ts`).
- Verify the full agentic loop manually with `npm run dev` before opening a PR.

---

## Security disclosures

Do **not** open a public issue for security vulnerabilities. Email the maintainers directly (see `package.json` author field) with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact

We will respond within 72 hours and coordinate a responsible disclosure timeline.

---

## Questions

Open a [GitHub Discussion](../../discussions) for questions about the codebase, design decisions, or roadmap items.
