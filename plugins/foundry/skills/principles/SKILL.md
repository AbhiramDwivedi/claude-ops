---
name: principles
description: Holds foundry's architecture principle packs, one file per domain (core, service, frontend, data, ai, infra, library), each a list of rules with a one-line test a reviewer can check against a diff. Use when designing, planning or reviewing a change against architecture principles, or when writing the principles section of a project's architecture doc.
---

# Principle packs

Each pack is a numbered list of rules. Every rule has a one-line test that names what a reviewer looks for in a diff, or what to run. The packs are defaults: the project's architecture doc decides which rules hold in that repo.

## The packs

| File | Applies when |
|---|---|
| `core.md` | Always. Every change in every project. |
| `service.md` | The work touches a long-running process that serves requests: an HTTP or RPC handler, a worker, a queue consumer, or its deploy config. |
| `frontend.md` | The work touches UI: components, pages, client state, styles, or the design system. |
| `data.md` | The work touches pipelines, ETL or batch jobs, schemas between stages, migrations, or stored datasets. |
| `ai.md` | The work touches a model call: prompts, model choice, evals, or the code that parses model output. |
| `infra.md` | The work touches infrastructure: Terraform, Pulumi, CloudFormation, Kubernetes manifests, Helm charts, CI/CD pipelines, IAM policies, or Dockerfiles. |
| `library.md` | The work touches code that other projects install and import: a package, an SDK, or a shared module with a published version. |

## Pick the packs

1. Always load `core.md`.
2. Add each pack whose domain the work touches. Judge by the paths and files the work changes, not by what the project calls itself:
   - an HTTP route, request handler, worker entry point, or service deploy config means `service.md`;
   - UI components, pages, or stylesheets mean `frontend.md`;
   - a pipeline step, a migration, or a schema file between stages means `data.md`;
   - a prompt file, an LLM client call, or an eval suite means `ai.md`;
   - Terraform, Kubernetes, Helm, CI workflow files, IAM policy, or a Dockerfile means `infra.md`;
   - a package manifest with a published version (`package.json`, `pyproject.toml`, `Cargo.toml`, `*.gemspec`) and the code it exports means `library.md`.
3. Load every pack that matches. Several often apply at once: an API service with its own Terraform takes core, service and infra; a web app that calls a model takes core, frontend and ai.

## Read a pack

The Skill tool's result for this skill gives its base directory. Read `<base directory>/<pack>.md` with the Read tool, for example `<base directory>/service.md`. No agent needs the plugin's install path.

## How the rules are used

The project's architecture doc owns the principles (foundry's design ADR, `docs/adr/0001-design-phase.md` in the foundry plugin, section 1). It adopts the pack rules that fit, adapts them to the repo's paths, languages and tools, and gives a reason for each rule it drops. A pack rule is a default, not law over the doc: where the doc adapts or drops a rule, the doc wins. When you review a diff, check it against the doc's principles; use a pack directly only for a rule the doc doesn't address.
