# Agent instructions

## Project and responsibilities

`omp-intellij` integrates the managed IntelliJ Language Server (ILS) with OMP. It is one npm package with a Gradle Kotlin/JVM subproject, not a web application.

- `src/`: TypeScript ESM using NodeNext and strict typing. Owns installation, server/process lifecycle, workspace configuration, LSP/DAP transport, client capability adaptation and CLI orchestration.
- `jvm/intellij-android/`: Kotlin/JVM extension. Owns PSI/UAST semantics, Android resource provenance, Lint, adblib/JDWP and debugger runtime hooks.
- `test/`: Node protocol/component tests. `test/integration/` exercises the assembled TypeScript, JVM, native ILS and Android device stack; its implementation language does not make it a TypeScript-only test layer.

Keep dependency direction explicit. `project/workspace.ts` contains lower-level workspace/configuration operations. `project/workspace-reimport.ts` composes those operations with `debug/run-core.ts`; lower-level workspace code must not import the session orchestrator. Android RPC clients own a minimal structural client contract rather than importing orchestrator-specific session types. Preserve validation on both sides of RPC boundaries.

## Documentation ownership

- `README.md`: public project overview, requirements, installation, quick start, usage limits and links.
- `docs/`: durable architecture, protocol contracts, design rationale and troubleshooting. Update the affected explanation rather than appending unrelated material.
- `AGENTS.md`: repository-specific agent setup, commands, dependency constraints and verification policy.

Keep session transcripts, progress reports, temporary plans and one-off test-result dumps out of repository documentation. Report executed verification in the final response. Do not add a README source-layout section or duplicate technical explanations across files.

## Setup and development

Use Node.js 22 or newer and npm with the checked-in `package-lock.json`.

```sh
npm ci
npm run build
npm run build:jvm
```

`npm run build` compiles TypeScript into `dist/`. `npm run watch` runs the incremental TypeScript compiler. JVM builds use the standard Gradle wrapper through `scripts/run-gradle.mjs`; the launcher reuses SDK discovery from `scripts/setup-dev-env.mjs`, updates `jvm/intellij-android/local.properties` and prefers the selected ILS installation's bundled JBR. Keep machine-specific SDK paths in local configuration, not tracked source.

`src/server/bundle-metadata.ts` is the source of truth for the ILS target. Read the Gradle build and lockfiles before changing Kotlin, JVM targets or Android dependencies. The extension currently targets Java 25 bytecode. Reuse host Kotlin, coroutine and serialization libraries; do not bundle duplicate host runtimes.

## Verification

| Command                    | Purpose                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                 | Rebuild TypeScript/test output and run Node unit/component and asset-contract tests; independent of ILS/JDK/device availability |
| `npm run test:jvm`         | Run Kotlin/JVM tests against the pinned ILS SDK                                                                                 |
| `npm run build:jvm`        | Stage the implementation, descriptor, upstream JARs, hashes and manifest                                                        |
| `npm run test:smoke` | Fixed real JVM/ILS smoke: Gradle subproject debug breakpoint/report and sandbox crash recovery; no AVD required |
| `npm run test:smoke:android` | Fixed real device/AVD normal-attach, variables, step and detach smoke |
| `npm run test:smoke:xml` | Fixed native XML symbols and resource/manifest references smoke |
| `npm run test:smoke:all` | All four real smoke scenarios, prepared once and run serially |
| `npm run test:integration` | Compile tests, stage current JVM assets, then run all real suites sequentially by file |
| `npm run test:integration:android` | Prepare once and run only the real device/AVD attach suite |
| `npm run test:integration:xml` | Prepare once and run only Android XML/resource/Lint integration |
| `npm run test:integration:engineering` | Prepare once and run only module models, reload and Gradle debug integration |
| `npm run test:integration:stability` | Prepare once and run only JVM concurrency, cancellation and recovery integration |
| `npm run test:acceptance` | Stage/test JVM in one Gradle invocation, rebuild/run Node tests, then run all real suites without repeating preparation |
| `npm run typecheck`        | Check production and test TypeScript without emitting files                                                                     |
| `npm run check`            | Check Biome lint and formatting rules                                                                                           |

Focused Node tests use compiled output:

```sh
npm run pretest
node --test dist-test/test/workspace.test.js
```

Focused JVM tests use standard Gradle test filtering:

```sh
node scripts/run-gradle.mjs test --tests org.jetbrains.android.debug.AndroidDebugHandlesTest --no-daemon
```

Use `test:smoke` for the standard native JVM path, adding the Android or XML smoke entry when that subsystem changes. Smoke cases carry `[smoke]` in their existing names; no test bodies are copied. The runner rejects extra Node filters and requires a successful non-skipped/non-todo marked case in every selected file. Empty selections or removed tags fail instead of accepting Node's file-only pass result.

Full integration retains the complete JDK concurrency, cancellation, ownership, Waiting for Debugger, recovery, XML/Lint and model/reload matrices. Keep protocol combinations and deterministic timer boundaries in Node components, PSI/UAST semantics in JVM tests, and native loading/transport/device behavior in real integration. Add a full-only real case when it exercises a host-specific risk, rather than repeating a component matrix.

Choose the narrowest real suite and pass Node filters after `--`:

```sh
npm run test:integration:stability -- --test-name-pattern='^crash recovery:'
```

`test:integration` remains the complete real gate. The internal `--no-prepare` runner flag is only for chaining from an already staged/compiled acceptance run; directed entries prepare their own current outputs by default. Filters do not relax prerequisite checks, serial execution or the 180-second test timeout.

Missing prerequisite variables fail before compilation/staging. The selected real suite still validates paths, the accepted EULA hash and device availability; the entrypoint never invents acceptance or skips unavailable coverage.

Real integration requires these explicit prerequisites:

- `OMP_INTELLIJ_TEST_SERVER`: pinned ILS executable.
- `OMP_INTELLIJ_TEST_JDK17` and `OMP_INTELLIJ_TEST_JDK21`: fixture JDK installations.
- `OMP_INTELLIJ_TEST_ACCEPTED_EULA_HASH`: hash of terms the user has already reviewed and accepted. Never fabricate consent or automatically accept new terms.
- `ANDROID_HOME` or `ANDROID_SDK_ROOT`: Android SDK.
- `OMP_INTELLIJ_TEST_ANDROID_DEVICE`: selected online device/AVD serial.
- Optional `OMP_INTELLIJ_TEST_GRADLE_CACHE`: existing dependency cache.

Explicit integration runs must fail when prerequisites are missing or the selected device is offline; a skipped suite is incomplete acceptance. Stage current JVM assets before validating the assembled system. Changes to plugin metadata/classloading require real ILS verification; JVM test classpaths do not reproduce host plugin visibility. Android debugger changes require actual device/AVD attach coverage, not only mocked DAP responses.

Keep every integration client's native `indexDir` under its sandbox, including CLI/DAP-created sessions. Use the existing persisted raw initialization options rather than test-only production environment variables. Cleanup may stop only fixture-owned processes/daemons and the selected fixture application; never kill unrelated Java, Gradle or ADB processes. Do not restart or reimport a user's shared project to run tests.

Android attach builds its APK once into a run-owned artifact directory outside all sandboxes. Later scenarios copy that artifact after the producer sandbox is removed; generated `build` and `.gradle` inputs are excluded from source copies. Failed builds are never captured, and the run-level hook disposes the artifact directory.

Fixtures report cache preparation, LSP/DAP initialization/startup and each cleanup stage with elapsed time. Cleanup continues across resource failures, restores the caller's environment in `finally`, and retains the sandbox with an aggregate error when shutdown or ownership checks fail. Use the reported sandbox path for diagnosis rather than globally stopping processes or clearing caches.

Run the narrowest meaningful check while fixing a defect, then the relevant complete gate after integration. Permanent tests should catch observable behavior, boundaries, errors, cancellation or ownership transitions. Avoid tests that merely pin source text, imports, forwarding or mock echoes. Report unavailable coverage and unrelated baseline failures explicitly; do not weaken assertions, add retries or increase timeouts to hide failures.

## Code and dependency conventions

- Follow `biome.json`: TypeScript uses two-space indentation, single quotes, semicolons, trailing commas and LF. Use four-space Kotlin indentation and existing local conventions.
- Keep comments concise, English and ASCII, explaining non-obvious reasons. Avoid decorative banners, emoji and commented-out historical code.
- Prefer existing helpers and standard library facilities. Keep standalone Bridge/Proxy launch paths independent of OMP host-only runtime imports.
- Move all callers when relocating an exported API; remove obsolete exports and aliases. Use available LSP references/rename/code actions before text-based edits.
- For locked host APIs, prefer native ILS definition/hover/decompile output. Decompiled declaration stubs establish signatures and visibility, not method bodies.
- Depend on public host modules. A JAR present on a compilation/test classpath may still be inaccessible to a plugin. Do not suppress Kotlin visibility or use reflection to bypass host boundaries.
- Keep Gradle dependency locking and checksum verification strict. Verify new upstream checksums against the official release before accepting them.

## Packaging and delivery

`npm run build:jvm` stages assets under `resources/ils/<target>/android.lsp/`. Treat the JARs, companion SHA-256 files and `manifest.json` as one distribution contract; regenerate them together rather than editing hashes or flattening the implementation module. `npm pack --dry-run --json --ignore-scripts` inspects package contents after building. Do not publish or push without an explicit request.

Use Conventional Commits (`fix:`, `refactor:`, `build:`, `test:`, `docs:`) when asked to commit. Keep commits scoped, preserve user edits and report only verification actually exercised. Avoid unrelated mass formatting and dependency upgrades.
