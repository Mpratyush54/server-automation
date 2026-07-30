# Contribution Guide

## Repository Setup

1. Fork the repository on GitHub: <https://github.com/Mpratyush54/SERVER-automation>
2. Clone your fork:
   ```bash
   git clone https://github.com/<your-username>/SERVER-automation.git
   cd SERVER-automation
   ```
3. Start the databases:
   ```bash
   docker compose up -d postgres mongodb redis
   ```
4. Install dependencies and start API + Portal:
   ```bash
   npm install
   npm run start
   ```
5. Open <http://localhost:4200> and sign in as `admin@pratyushes.dev` (no password).

Full walkthrough: [getting-started/installation.md](getting-started/installation.md).

## Branch Naming Convention

- `feature/<description>` — new features
- `fix/<description>` — bug fixes
- `docs/<description>` — documentation changes

Use kebab-case for descriptions (e.g., `feature/oauth2-support`).

## Commit Message Format

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]
[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`.

Examples:
```
feat(sdk): add OAuth2 token refresh
fix(api): handle null pointer in user resolver
docs(readme): update setup instructions
```

## PR Workflow

1. Fork the repository.
2. Create a feature branch from `main`.
3. Make your changes with clear commit messages.
4. Push to your fork and open a Merge Request / Pull Request.
5. Ensure all CI checks pass.
6. Request review from at least one maintainer.
7. Squash commits before merging.

## Code Style

- **TypeScript**: Strict mode enabled. No `any` types without explicit justification.
- **Formatting**: All code must pass Prettier formatting (`npm run format`).
- **Linting**: ESLint with the project's configuration (`npm run lint`).

## Testing Requirements

- All new features must include tests.
- All tests must pass before merging:
  ```bash
  npm test
  ```
- Aim for at least 80% code coverage on new code.

## Documentation

- Update documentation for any API or SDK changes.
- Document new environment variables in `.env.example`.
- Keep the changelog up to date.
- Use Markdown for all documentation files.

## Review Process

- At least one maintainer must approve changes.
- All CI checks must be green.
- Address all reviewer feedback before merging.
- Maintainers may request changes for code style, test coverage, or architectural concerns.

## Code of Conduct

All contributors must adhere to the [Contributor Covenant](https://www.contributor-covenant.org/). Be respectful, inclusive, and constructive. Harassment or discriminatory behavior will not be tolerated.
