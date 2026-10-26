# infra pack

Applies when the work touches infrastructure: cloud resources, networks, IAM, Kubernetes manifests, Helm charts, container images, or CI/CD pipelines. It assumes infrastructure is managed as code with a tool such as Terraform, Pulumi, CloudFormation or Kubernetes manifests, and that changes reach production through a pipeline. It extends the core pack, and core's rules still apply.

## Rules

1. Every infrastructure resource is defined in code in the repo; nothing is created or changed by hand in a console.
   Test: each resource the diff relies on appears in an infrastructure-as-code file, and `terraform plan` (or the tool's equivalent) against the live environment shows no unexplained drift.
2. Infrastructure changes are applied by the pipeline from reviewed code, not from a laptop.
   Test: the diff applies changes only through a CI job that runs plan, then apply after approval; no runbook step tells a person to apply by hand.
3. Deploys are immutable: a release replaces running instances with a new image; it never patches them in place.
   Test: the diff adds no SSH, `kubectl exec`, or configuration-management step that changes a running host or container.
4. Images and artifacts are referenced by immutable digest or version, never by a moving tag.
   Test: grep the diff for `:latest` and untagged image references; none appear in deploy manifests.
5. Every deploy has a rollback path: the previous version can be restored with one documented command or pipeline action.
   Test: the deploy config keeps the previous release (for example image history or Helm revisions), and the runbook or pipeline names the rollback step.
6. Schema and data migrations that ship with a deploy are backward-compatible with the previous release, so rollback stays safe.
   Test: the diff's migrations only add columns, tables or indexes in the same release as the code that uses them; drops and renames come in a later release.
7. Each identity gets least privilege: only the actions and resources it needs.
   Test: no IAM policy, role or service account in the diff grants `*` on actions or resources, or an admin or owner role.
8. Workloads use their own identity, not shared or personal credentials.
   Test: each new service, job or pipeline in the diff has its own role or service account; no user credentials or long-lived shared keys appear.
9. Secrets live in a secret manager and reach workloads at runtime, never in code, state files or images.
   Test: grep the diff and its Dockerfiles for secret values and key patterns; secrets are referenced by secret-manager path or injected variable only.
10. Network access is closed by default and opened per need.
   Test: no security group, firewall rule or network policy in the diff allows `0.0.0.0/0` (or `::/0`) inbound except on a public load balancer's listener ports.
11. Infrastructure state is remote, locked and encrypted.
   Test: the backend config stores state in a remote store with locking and encryption enabled; no state file is committed.
12. Tool, provider and module versions are pinned.
   Test: the diff pins the infrastructure tool version, each provider and each module source to an exact version or commit.
13. Environments differ only in variables, not in copied code.
   Test: staging and production use the same modules or charts with per-environment variable files; the diff adds no environment-specific copy of a module.
