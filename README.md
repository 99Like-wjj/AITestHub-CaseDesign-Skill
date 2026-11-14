# AITestHub-CaseDesign-Skill

Skill ID: ath-case-design. AI designs business coverage, independent scenarios/cases, existing-case drafts and review responses. Deterministic helpers validate, persist and submit drafts without executing or approving tests.

The entry point and referenced runtime rules are under skills/ath-case-design/. They are implementation inputs retained with the source. Human review and visualization stay in AITestHub.

    pnpm install --frozen-lockfile --ignore-scripts
    pnpm typecheck
    pnpm build
    pnpm check:package

Hosts inject Tool/Result/Workspace ports. Build checks do not prove native installation, automatic loading or a full live permission/file matrix.

See SECURITY.md and SOURCE_PUBLICATION.md.

Test source and test-only scripts are retained separately in the private local workspace.

## Development standards

Read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md) and the [current development standards](docs/development/README.md) before changing code, configuration or packaging.

Run pnpm quality:check for source/document formatting and strict type checks. Architecture, privacy and behavior still require the [review checklist](docs/development/review-checklist.md); this command does not establish deployment or live acceptance.

Private operational history remains in the ignored AGENTS.local.md when present. Generic engineering standards may be versioned; private product design, tests, instances and real evidence remain excluded.
