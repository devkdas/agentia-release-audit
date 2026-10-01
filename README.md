# Agentia Release Audit

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](package.json)
[![Agentia 0.122](https://img.shields.io/badge/agentia-0.122.0--alpha.1-blue.svg)](https://developer.copado.com/docs)

**Release Audit** fuses stories, promotions and test evidence into one
compliance report with an optional AI executive summary. The reporting
layer on top of the delivery plugins.

No manual evidence assembly required. Built for the **Agentia Headless
Virtual Hackathon** as an oclif plugin on top of the public `agentia` CLI.

---

## Table of Contents

- [The Problem](#the-problem)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Live Demo Workflow](#live-demo-workflow)
- [Command Reference](#command-reference)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [How It Works](#how-it-works)
- [Security](#security)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Hackathon Fit](#hackathon-fit)
- [License](#license)

---

## The Problem

After every release, compliance and business teams ask what shipped,
whether tests were green and who approved what. Developers rebuild that
evidence by hand from stories, test runs and chat threads, which takes
hours and still misses proof. There is no `release` object in the CLI to
query, so the evidence stays scattered.

## Features

- **Story aggregation** — lists stories scoped by project, filtered
  client side by release name or ID since stories carry both fields.
- **Promotion evidence** — lists promotions by project with statuses.
- **Test evidence** — latest build status per job through build search,
  with execution IDs.
- **Governance rechecks** — live policy gate status per story through
  Gov Guard when installed, degrading to unknown otherwise.
- **Opt-in AI summary** — `--ai-summary` asks the release agent for a
  stakeholder executive summary plus risks. Off by default, null safe.
- **Dual artifacts** — markdown report plus JSON evidence, always both.
- **Zero private imports** — only shells out to public `agentia`
  commands.

## Installation

### Prerequisites

- Node 18 or newer.
- Agentia CLI beta: `npm install -g @copado/agentia-cli@beta`
- Authenticated machine: `agentia setup` (CICD at minimum).

### Install from source

```sh
git clone https://github.com/devkdas/agentia-release-audit.git
cd agentia-release-audit
npm install
npm run build
agentia plugins link .
```

Re-run `npm run build` after every change to the TypeScript files.

## Quick Start

### 1. Audit a project

```sh
agentia release audit --project a15xxx
```

### 2. Add test evidence

```sh
agentia release audit --project a15xxx --job 120561 --crt-project 76303
```

### 3. Add the AI executive summary

```sh
agentia release audit --project a15xxx --job 120561 --crt-project 76303 --ai-summary --json
```

## Live Demo Workflow

Verified live against a real Source Format project:

```text
1. agentia release audit --project a15xxx --job 120561 --crt-project 76303
   -> 1 story (US-0000024), gov gate pass, markdown plus JSON written
2. JSON shows test evidence reading the latest green build 5875760
   after a parser fix for the search response shape
3. Re-run with --ai-summary for the release agent executive summary
```

## Command Reference

### `agentia release audit`

| Flag | Description |
|---|---|
| `-p, --project <id>` | Copado project ID scoping stories plus promotions |
| `-r, --release <name>` | Release name substring filtering stories |
| `-j, --job <id>` | CRT job ID for test evidence, repeatable |
| `--crt-project <id>` | CRT project ID used with job IDs |
| `--format md\|json` | Report file format (default `md`, JSON always written) |
| `-o, --output-dir <dir>` | Report directory (default `./release-audit`) |
| `--ai-summary` | Release agent executive summary, off by default |
| `--json` | Machine readable stdout summary |

### `agentia release sprint`

| Flag | Description |
|---|---|
| `-p, --project <id>` | Copado project ID scoping the sprint (required) |
| `-j, --job <id>` | CRT job ID for test evidence, repeatable |
| `--crt-project <id>` | CRT project ID used with job IDs |
| `-o, --output-dir <dir>` | Sprint files directory (default `./sprint-report`) |
| `--ai-narrate` | Release agent manager narrative, off by default |
| `--json` | Machine readable stdout summary |

Sprint counts delivered versus open by status, tracks promotions plus
green test jobs, and writes markdown plus JSON every run.

### `agentia release export`

| Flag | Description |
|---|---|
| `-p, --project <id>` | Copado project ID scoping the export (required) |
| `-r, --release <name>` | Release name substring filtering stories |
| `-j, --job <id>` | CRT job ID for test evidence, repeatable |
| `--crt-project <id>` | CRT project ID used with job IDs |
| `--format html\|md` | Export file format (default `html`, JSON always written) |
| `-o, --output-dir <dir>` | Export directory (default `./compliance-export`) |
| `--json` | Machine readable stdout summary |

Exports a traceability matrix of story to data commits to tests to
promotions to policy gate, as self contained HTML or markdown plus
JSON. Evidence for review, never a certification.

At least one of `--project`, `--release` or `--job` is required. Story
and gov sections cap at 50 plus 10 with notes when truncated.

## Configuration

Output directory only. Gov rechecks degrade gracefully when the Gov
Guard plugin is absent. Test evidence needs both job and CRT project
IDs together.

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| No stories matched | Wrong project or release filter | List stories first and copy the exact name |
| No test evidence | Job without CRT project | Add `--crt-project` alongside `--job` |
| Gov status unknown | Gov plugin not linked | Link Gov Guard or accept unknown |
| AI summary null | Agent unreachable | Raw evidence still stands, retry later |
| ESM auto-transpile warning | Linked ESM plugin notice | Benign, compiled output is used |

## How It Works

```text
agentia release audit
  -> cicd work list (stories, client filtered by release)
  -> cicd promotion list --project-id (promotions)
  -> testing build search per job (latest status)
  -> gov check per story (live gates, best effort)
  -> ai agent ask --agent release (opt-in summary)
  -> AUDIT-<slug>-<date>.md plus .json
```

## Security

Read operations plus one optional AI call. No deployments, no writes to
orgs, no tokens printed. Report files may reference IDs but never
secrets.

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript on Node 18+ |
| CLI Framework | oclif v4 (ESM, matching the host CLI) |
| Runtime calls | `node:child_process` to public `agentia` commands |

## Architecture

```text
Release manager / Agent
       |
agentia release audit --project [--job ...] [--ai-summary]
       |
Release Audit (this plugin)
  |- stories     -> work list, release filtered
  |- promotions  -> promotion list by project
  |- tests       -> build search per job
  |- governance  -> gov check per story
  |- narrative   -> release agent (opt-in)
       |
Markdown report + JSON evidence
```

## Hackathon Fit

Enables notifications, reporting and event driven proof with a
compliance artifact judges can read. Combines stories, promotions, tests
and gates in one flow nobody else aggregates, strengthening auditability
exactly where enterprise releases hurt.

## License

MIT License — see [LICENSE](LICENSE) for details.
