# Agent instructions

## Project and responsibilities

`omp-intellij` is a TypeScript ESM npm package using NodeNext and strict typing. It adapts and forwards LSP/DAP between OMP clients and an external IntelliJ Language Server (ILS).

- `src/`: installation, server/process ownership, workspace configuration, protocol transport, client capability adaptation and CLI integration.
- `test/`: Node component tests for framing, request routing, capability negotiation, cancellation, error delivery, session ownership and OS adaptation.
- `test/integration/`: real host tests for JVM session ownership, workspace configuration, concurrency, cancellation and recovery.

Language semantics, provider implementations and device-side execution belong to the server. Keep server feature logic out of the host. Forward opaque payloads without rebuilding their models or interpreting their business state.

`project/workspace.ts` owns lower-level workspace/configuration operations. `project/workspace-reimport.ts` composes them with `debug/run-core.ts`; lower-level workspace code must not import the session orchestrator. Keep standalone Bridge/Proxy entrypoints independent of OMP host-only runtime imports.

## Setup and development

Use Node.js 22 or newer and the checked-in `package-lock.json`.

```sh
npm ci
npm run build
```

`npm run build` emits clean production output in `dist/`; `npm run build -- --watch` starts the incremental compiler. `src/server/bundle-metadata.ts` owns the host's pinned ILS distribution metadata. The host does not build or bundle server extensions.

## Verification

| Command | Purpose |
| --- | --- |
| `npm test` | Compile once into clean `dist-test/` and run Node component tests; no production build or real ILS/JDK prerequisites |
| `npm run typecheck` | Check production and test TypeScript without emitting files |
| `npm run check` | Check Biome lint and formatting |
| `npm run test:smoke` | Real host JVM lifecycle and crash recovery smoke |
| `npm run test:integration -- engineering` | Real OMP JVM launch/attach ownership and capability adaptation |
| `npm run test:integration -- stability` | Real concurrency, cancellation, connection ownership and crash recovery |
| `npm run test:integration` | Compile tests and run both real host suites serially |

Use the narrowest meaningful check. Focused Node tests run compiled output:

```sh
npx tsc -p tsconfig.test.json
node --test dist-test/test/bridge.test.js dist-test/test/dap-proxy.test.js
```

Directed real runs accept Node filters:

```sh
npm run test:integration -- stability --test-name-pattern='^crash recovery:'
```

Smoke cases carry `[smoke]`; each selected file must run a successful non-skipped marked case. Run files serially and preserve in-file concurrency and deterministic timer boundaries.

Real integration requires:

- `OMP_INTELLIJ_TEST_SERVER`: pinned ILS executable.
- `OMP_INTELLIJ_TEST_JDK17` and `OMP_INTELLIJ_TEST_JDK21`: fixture JDK directories.
- `OMP_INTELLIJ_TEST_ACCEPTED_EULA_HASH`: hash of terms already reviewed and accepted by the user.
- Optional `OMP_INTELLIJ_TEST_GRADLE_CACHE`: existing dependency cache.

Missing prerequisites fail before compilation. Never invent acceptance, automatically accept new terms or silently skip unavailable coverage. Each directed integration command compiles its test output before execution.

### Isolation and test ownership

- Component tests cover adaptation and delivery; real tests cover host routing, reload, ownership and recovery. Keep server semantic matrices outside this repository.
- Each real case has its own 180-second budget and setup/cleanup hooks. Isolate crashes, cross-project behavior and JDK switching; run environment-mutating cases serially.
- Keep native indexes, writable Gradle homes and owned processes under the sandbox. Freeze run-owned dependency seeds; never reuse a live user cache as a seed.
- Cleanup only fixture-owned resources, restore environment variables in `finally`, and retain failed sandboxes with aggregate errors. Never restart a user's shared project for tests.
- Report missing coverage and baseline failures. Do not hide failures with weaker assertions, retries or larger timeouts.

## Code and delivery

- Follow `biome.json`: two spaces, single quotes, semicolons, trailing commas and LF.
- Comments are concise English ASCII and explain only non-obvious reasons. No decorative borders, emoji or commented-out historical code.
- Reuse existing helpers and standard library APIs. Avoid unrelated refactors or dependency upgrades.
- Use available LSP references/rename/code actions before exported API changes; migrate every caller and remove obsolete aliases.
- Report only verification actually exercised. Use `npm pack --dry-run --json --ignore-scripts` to inspect package contents after building.
- Do not publish, push or commit without an explicit request. Requested commits use Conventional Commits and preserve user edits.
