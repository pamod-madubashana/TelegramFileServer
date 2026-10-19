# Contributing

Thanks for your interest in improving TelegramFileServer.

## Ways to contribute

- Report bugs and reproducible issues
- Suggest features or workflow improvements
- Help improve docs, setup steps, and examples
- Submit code changes for the Rust workspace

## Development workflow

1. Fork the repository and create a branch from `v2`.
2. Keep changes focused on a single concern per commit.
3. Run the relevant validation commands before opening a pull request:

```bash
cargo fmt --all
cargo test --workspace
cargo clippy --workspace
```

4. Open a pull request with a clear summary of:
   - what changed
   - why it changed
   - how it was validated

## Coding expectations

- Prefer small, readable, well-scoped patches.
- Keep API and behavior changes explicit.
- Match the existing Rust code style and naming patterns.
- Do not commit secrets, environment files, Telegram credentials, bot tokens, API hashes, or database URIs.

## Reporting issues

When filing an issue, include:

- a short, clear title
- steps to reproduce
- expected vs. actual behavior
- relevant logs, screenshots, or configuration snippets
- whether the issue affects the server, API, Telegram engine, or UI

## Security

Please do not disclose security vulnerabilities in public issues. Instead, contact the maintainer privately and provide the details needed to assess and remediate the issue safely.

## Community standards

We expect respectful, constructive collaboration. Disagreements are fine, but personal attacks, harassment, or disruptive behavior are not.
