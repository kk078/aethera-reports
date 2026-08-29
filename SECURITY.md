# Security Policy

## PHI / HIPAA notice — read this before deploying

Aethera Reports is designed to process healthcare claim and revenue-cycle
data, which for most deployments constitutes **Protected Health
Information (PHI)** under HIPAA. Please understand what the application
does and does not do for you:

- **The app stores data locally**, on the machine it runs on: an embedded
  DuckDB analytics database (`analytics.duckdb`) and a SQLite metadata
  database (`meta.db`), both under the OS-standard Electron `userData`
  directory. There is no server component and no cloud sync in v1.
- **The app ships no telemetry.** It does not phone home, does not report
  usage analytics, and does not auto-update over the network. The one
  network-touching convenience is the **update check** — a single request
  to the public GitHub Releases API that reads the latest version number
  and downloads nothing. It runs only when a user clicks "Check now" in
  Settings, or at launch if the user has explicitly enabled the
  launch-time check there (off by default).
- **You are responsible for the HIPAA compliance of your deployment.**
  That includes, at minimum: full-disk encryption on any machine running
  the app (the Settings screen checks Windows BitLocker status and warns
  if it's off, but cannot enable it for you), OS-level access controls,
  your organization's Business Associate Agreements, backup handling of
  the `userData` directory (which contains PHI once you import real
  data), and secure disposal of decommissioned hardware.
- **The analytics database is not encrypted at rest** by DuckDB itself in
  v1. If your threat model requires encryption at rest beyond full-disk
  encryption, do not deploy this version with real patient data yet —
  track the SQLCipher option noted in the project plan as a future
  enhancement.
- The public repository and its `sample-data/` fixtures contain **only
  synthetic data** — see `CONTRIBUTING.md`'s Data policy. Nothing in this
  repo is real patient, provider, or payer information.

If you are evaluating this project for a covered entity or business
associate, treat any real-data pilot as you would any other software that
touches PHI: run it past your organization's security and compliance
review first.

## Reporting a vulnerability

If you find a security issue in Aethera Reports (not a HIPAA-compliance
question about your own deployment — that's on you per above), please
report it privately rather than opening a public issue:

- Open a [GitHub Security Advisory](../../security/advisories/new) on
  this repository, **or**
- Email the maintainer contact listed in the repository's GitHub profile.

Please include:
- A description of the issue and its potential impact.
- Steps to reproduce (a minimal repro is very helpful).
- The version/commit you tested against.

We'll acknowledge reports within a reasonable timeframe and coordinate a
fix and disclosure timeline with you. Please don't publicly disclose
before a fix is available.

## Supported versions

This project is pre-1.0 and does not yet maintain parallel release
branches. Security fixes land on the latest release.
