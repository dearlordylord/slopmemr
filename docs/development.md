# Development and distribution

Development requires Node 24, pnpm, Git, and a sibling `../unii` checkout. slopmemr uses the exact Effect 4 and TypeScript dependency cohort declared in package.json.

```sh
pnpm --dir ../unii install --ignore-scripts
pnpm --dir ../unii build
pnpm install
pnpm dev-install -- --runtime codex
pnpm check-all
```

Use `--runtime claude` for Claude Code. The installer captures an immutable runtime that survives removal of the checkout.

`pnpm check-all` runs TypeScript and Effect diagnostics, dependency-cycle and capability checks, complexity, typed lint, duplication, formatting, secret scanning, CRAP4ts, and installed/native-package/npm witnesses. Offline gates do not call a provider. `pnpm test:native` and `pnpm test:claude` are explicit opt-in synthetic witnesses using the existing subscription login.

## Generated README references

Tool names, descriptions and input fields come from the production MCP catalog and its schemas. The CLI reference captures the built command’s `--help` output. One generator updates both marked README regions; authored prose is preserved.

```sh
pnpm docs:generate
```

`pnpm docs:check` checks marker handling and rejects stale generated content without rewriting files. It runs after build in `pnpm check-all`; there is no separately maintained tool or command list in README.

## npm package

```sh
pnpm npm:pack
pnpm test:npm
```

The tarball is written to `dist/npm`. The development manifest remains private; the staged publication manifest exposes only the standalone CLI and dedicated hook. It has no runtime dependencies, library exports or lifecycle scripts, and requires Node 24+ on Linux or macOS. Both bundles include their dependency notices.

`pnpm test:npm` installs the tarball offline in a temporary global npm prefix, exercises both native registrations, update and repair, then removes the npm installation. It verifies cold startup from the retained hooks, memory reads, self-read filtering and memory retention after native uninstall. Evidence is saved in [npm-package.json](validation/npm-package.json).

After a successful full gate, publish the tested tarball, replacing VERSION with the package version:

```sh
npm publish dist/npm/firfi-slopmemr-VERSION.tgz --access public --ignore-scripts
```

Publication requires an npm account with access to `@firfi`. Never publish the private development directory or commit authentication tokens. npm versions are immutable; documentation updates in Git do not change an already published package README.

## Standalone archives

`pnpm package` creates the current platform's archive and checksum in `dist/releases`, including Node. The native platform workflow reuses checksum-pinned portable bundles from a validated seed release, then packages and tests each platform on its own runner. See the [installation contract](installation.md), [platform acceptance](validation/platform-release.json), [architecture](architecture.md), and [authentication research](research/compactor-auth.md).

Track planned work and completion in [GitHub Issues](https://github.com/dearlordylord/slopmemr/issues).
