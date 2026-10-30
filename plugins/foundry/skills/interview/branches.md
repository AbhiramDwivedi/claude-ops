# Interview branches

The question catalogue for `foundry:interview` (ADR-0008, section 5). The ledger parses this file with `parseBranches`; the skill never reads it by hand, it runs `next` and `remaining` over it.

Each `## <id>` section is one branch. Text before the first `## ` is ignored. Fields, one per line:

- `Pack`: one of `core service frontend data ai infra library`.
- `Visit`: `standard`, `large`, `opened`, comma-and-space separated. Never `small`. A run of size `large` asks only branches that list `large`, so a branch both sizes should ask lists both. `opened` alone means "ask only after another branch's answer opened it", so some other branch must name it in `Opens`.
- `Fact`: what the fact-finder looks for, with typical paths.
- `Ask`: the question, in product terms.
- `Recommend`: how to pick the recommended answer from the facts.
- `Writes`: the kind of requirement the answer becomes.
- `Opens`: branches an answer can make relevant.

Order matters: `next` walks this file top to bottom and stops a batch after the first branch that has `Opens`.

## outcome
Pack: core
Visit: standard, large
Fact: an existing spec, plan or issue export the goal touches (`docs/`, `README.md`, `requirements.md`); the project's stated purpose
Ask: In one or two sentences, what should someone be able to do when this is finished that they can't do now? On a new repo, this answer also says what kind of product it is (service, web app, data pipeline, AI feature, infrastructure, library).
Recommend: Restate the goal in one sentence from the goal text and any `SPEC:` line, as what a user can do. If the facts don't say, recommend the goal text as written.
Writes: functional

## users
Pack: core
Visit: standard, large
Fact: existing roles, accounts or personas (`docs/`, auth or user models, `README.md`)
Ask: Who uses this: which kinds of people or systems, and roughly how many of each?
Recommend: Name the user types the repo already has; if none, recommend the single type the goal text implies.
Writes: functional

## acceptance
Pack: core
Visit: standard, large
Fact: existing tests, example inputs and outputs, fixtures (`tests/`, `examples/`, `docs/`)
Ask: Give one concrete example: with this input or action, what exactly should happen? How will you tell it works?
Recommend: Turn the goal into one Given/When/Then example using names and data from the repo's own fixtures.
Writes: functional

## non-goals
Pack: core
Visit: standard, large
Fact: items already marked out of scope (`docs/`, `README.md`, closed issues, a `Non-goals` section of `requirements.md`)
Ask: What should this explicitly not do, even though someone might expect it?
Recommend: Recommend the nearest adjacent feature the goal text does not mention, or "nothing extra beyond the goal" when none stands out.
Writes: non-goal

## hosting
Pack: core
Visit: standard, large
Fact: deploy config and platform files (`vercel.json`, `Dockerfile`, `fly.toml`, `netlify.toml`, `.github/workflows/`, `infra/`, `package.json` scripts)
Ask: Where will this run: a laptop only, a hosting platform, your own server or a cloud account? Your answer goes into docs/requirements.md, which is committed to the repo, so describe it by type (for example "a managed container platform") and leave out names, emails, user paths and private infrastructure details.
Recommend: Recommend the platform the deploy files already show. With none, recommend the cheapest managed option that fits the goal, or "runs locally only" for a tool or library.
Writes: constraint
Opens: environments, cost

## environments
Pack: core
Visit: standard, large
Fact: environment names in config and CI (`.env.example`, `config/`, `.github/workflows/`, `docker-compose*.yml`)
Ask: Which environments do you need besides production: a staging copy, per-branch previews, a local setup?
Recommend: Recommend the environments the CI and config files already define. With none, recommend local plus production for a small project and add staging when `hosting` is a shared platform.
Writes: constraint

## integrations
Pack: core
Visit: standard, large
Fact: third-party SDKs, API clients and base URLs (`package.json` or `pyproject.toml` dependencies, `src/**/client*`, `.env.example` key names)
Ask: Which outside services does this talk to: payments, email, maps, an identity provider, another team's API? docs/requirements.md is committed to the repo, so name the kind of service (for example "a card payment provider") and leave out names, emails, user paths and private infrastructure details.
Recommend: Recommend the integrations the dependencies and client code already show. With none, recommend "none" and let the goal text add any it names.
Writes: constraint
Opens: webhooks, secrets

## auth
Pack: core
Visit: standard, large
Fact: login, session or token code and identity-provider config (`src/auth*`, `middleware*`, `.env.example` keys such as `*_CLIENT_ID`)
Ask: Who is allowed in, and how do they prove who they are: nobody (public), a shared password, accounts you manage, or sign-in through an existing provider?
Recommend: Recommend the scheme the repo already uses. With none, recommend sign-in through an existing provider when `users` has more than one type, and "no login" when it is one person or a library.
Writes: constraint
Opens: authz

## secrets
Pack: core
Visit: standard, large
Fact: how keys are loaded today (`.env.example`, `.gitignore`, CI secret references, `config/`, a secrets manager client)
Ask: Where do keys, passwords and tokens live and who may read them: a secrets manager, your hosting platform's settings, or a local file that stays out of the repo?
Recommend: Recommend the mechanism the repo already uses. With none, recommend the hosting platform's secret settings, and an uncommitted local file for local runs.
Writes: constraint

## data-sensitivity
Pack: core
Visit: standard, large
Fact: stored personal or financial fields (`schema*`, `migrations/`, `models/`, `.sql` files, logging calls that print records)
Ask: Will this store or handle personal, financial, health or otherwise private data? Which fields?
Recommend: Recommend "yes" and list the field names from the schema when the facts show email, name, address, payment or health columns; otherwise recommend "no sensitive data".
Writes: constraint
Opens: compliance, retention

## scale
Pack: core
Visit: standard, large
Fact: existing load figures, batch sizes, seed data or test volumes (`docs/`, `tests/`, `scripts/`, monitoring config)
Ask: How much will it handle: how many users, records or requests per day, now and in a year?
Recommend: Recommend a number taken from existing data volumes, scaled up tenfold for the one-year figure. With no facts, recommend a small figure for an internal tool and ask the owner to confirm it.
Writes: nfr

## latency
Pack: core
Visit: standard, large
Fact: existing timeouts, SLOs, performance tests (`tests/perf*`, `k6/`, gateway or client timeout settings)
Ask: How fast must the main action feel: what response time is acceptable, and for how many of the requests?
Recommend: Recommend the timeout or SLO already in the repo. With none, recommend "95 percent of requests under 1 second" for interactive actions and "under 5 minutes" for batch jobs.
Writes: nfr

## availability
Pack: core
Visit: standard, large
Fact: replicas, health checks, uptime or on-call docs (`docs/runbook*`, `k8s/`, status-page config)
Ask: How bad is it if this is down for an hour, and how much downtime per month is acceptable?
Recommend: Recommend the target in the runbook or health-check config. With none, recommend "business hours, a few hours of downtime a month" for an internal tool and ask the owner to confirm.
Writes: nfr

## cost
Pack: core
Visit: standard, large
Fact: current hosting bills, plan tiers and per-use pricing in config (`infra/`, `vercel.json`, API pricing notes in `docs/`)
Ask: What is the monthly budget for running this, and what would be a surprise?
Recommend: Recommend a ceiling just above what the current hosting and API plan costs, or the free tier when the facts show no paid plan.
Writes: nfr

## compliance
Pack: core
Visit: opened
Fact: policy and audit documents (`docs/compliance*`, `SECURITY.md`, `PRIVACY*`, DPA or certification references)
Ask: Does a law, contract or customer rule apply to this data, such as GDPR, HIPAA, PCI or a customer security review?
Recommend: Recommend the regimes the repo's docs already name. Absent those, recommend GDPR when `users` includes people in the EU and "none known" otherwise.
Writes: constraint

## authz
Pack: service
Visit: opened
Fact: role and permission checks (`src/**/policy*`, `roles*`, `permissions*`, middleware guards)
Ask: Once someone is signed in, who may see or change what? For example, can users only see their own records?
Recommend: Recommend the roles the repo already defines. With none, recommend "each user sees and edits only their own records, plus one admin role".
Writes: constraint

## idempotency
Pack: service
Visit: standard, large
Fact: idempotency keys, retry logic and dedupe tables (`src/**/retry*`, `Idempotency-Key` headers, unique constraints)
Ask: If the same request arrives twice, for example a retry after a timeout, should it happen once or twice?
Recommend: Recommend "once" for anything that charges, sends or creates, and "safe to repeat" for reads.
Writes: functional

## rate-limits
Pack: service
Visit: standard, large
Fact: throttling middleware and quota config (`rate-limit*`, gateway config, provider quota notes in `docs/`)
Ask: Should callers be limited in how often they can call this, and what happens when they hit the limit?
Recommend: Recommend the limit already configured. With none, recommend a per-caller limit with a clear "try again in N seconds" answer for any public endpoint, and none for internal ones.
Writes: nfr

## webhooks
Pack: service
Visit: opened
Fact: webhook routes and signature checks (`src/**/webhook*`, `routes/`, provider docs in `docs/`)
Ask: Will outside services call this with events, or will this call others? What should happen if a delivery fails or arrives twice?
Recommend: Recommend the event flow the integration's client code shows, with signed requests and retries on failure. Recommend "no webhooks" if the facts show none.
Writes: functional

## browsers
Pack: frontend
Visit: standard, large
Fact: `browserslist`, framework support notes, existing cross-browser tests (`package.json`, `.browserslistrc`, `playwright.config.*`)
Ask: Which browsers and devices must it work on, including phones?
Recommend: Recommend the `browserslist` already set. With none, recommend the current and previous major version of the common browsers, phones included.
Writes: constraint

## accessibility
Pack: frontend
Visit: standard, large
Fact: lint rules, axe or Lighthouse checks and ARIA use (`.eslintrc*`, `tests/a11y*`, CI steps)
Ask: Must it be usable with a keyboard and a screen reader, and is there a standard you have to meet?
Recommend: Recommend WCAG 2.2 level AA when the repo has any accessibility check or the product is public; otherwise recommend keyboard-usable and labelled controls.
Writes: nfr

## i18n
Pack: frontend
Visit: large
Fact: translation files and locale code (`locales/`, `i18n/`, `messages*.json`, `Intl` use)
Ask: Will it be used in more than one language or region, which ones, and does it need right-to-left layouts?
Recommend: Recommend the languages the locale files already hold. With none, recommend a single language with text kept out of the code, to ease adding more later.
Writes: constraint

## retention
Pack: data
Visit: opened
Fact: delete jobs, TTL settings and retention notes (`migrations/`, `cron*`, `docs/`)
Ask: How long do you keep this data, and what happens when someone asks you to delete theirs?
Recommend: Recommend the retention the repo already enforces. With none, recommend keeping it only as long as the product needs it, with deletion on request.
Writes: constraint

## backfill
Pack: data
Visit: large
Fact: migration and backfill scripts, existing tables that need the new field (`migrations/`, `scripts/`)
Ask: Is there existing data that must be converted or filled in, and can the system be paused while that runs?
Recommend: Recommend a backfill when the facts show existing rows the new shape touches, run without a pause; otherwise "no existing data".
Writes: constraint

## lineage
Pack: data
Visit: large
Fact: pipeline definitions, source-to-table mappings, data catalogue entries (`dags/`, `dbt/`, `docs/`)
Ask: Do you need to trace each number or record back to where it came from?
Recommend: Recommend "yes, record the source and run for every table" when the facts show multiple sources feeding one table; otherwise "no".
Writes: constraint

## model-choice
Pack: ai
Visit: standard, large
Fact: model names and SDK calls in code and config (`src/**/llm*`, `.env.example`, `package.json` dependencies)
Ask: Which AI model or provider should it use, and does the data it sees allow sending it to an outside provider?
Recommend: Recommend the model already in use. With none, recommend the smallest hosted model that handles the example from `acceptance`, if `data-sensitivity` allows an outside provider.
Writes: constraint

## eval-set
Pack: ai
Visit: large
Fact: evaluation sets, golden files and scoring scripts (`evals/`, `tests/fixtures/`, `benchmarks/`)
Ask: How will you know the AI part is good enough: do you have examples of right and wrong answers, and what score is acceptable?
Recommend: Recommend the existing eval set with its current score as the bar. With none, recommend writing about 20 labelled examples from the `acceptance` example, with a passing score set by the owner.
Writes: nfr

## model-cost
Pack: ai
Visit: standard, large
Fact: token or call counters, provider pricing notes, caching (`src/**/llm*`, `docs/`, usage dashboards config)
Ask: What can each AI call cost, and what is the monthly ceiling?
Recommend: Recommend a per-call and monthly ceiling just above current spend. With no spend, estimate from `scale` times the model's price and recommend that figure.
Writes: nfr

## iac
Pack: infra
Visit: large
Fact: Terraform, Pulumi, CloudFormation or Helm files (`infra/`, `terraform/`, `*.tf`, `charts/`)
Ask: Should the infrastructure be defined in code so it can be rebuilt, or set up by hand?
Recommend: Recommend the tool already in the repo. With none, recommend infrastructure as code for anything beyond one small instance.
Writes: constraint

## regions
Pack: infra
Visit: large
Fact: region settings and data-residency notes (`*.tf` region variables, `vercel.json` regions, `docs/`)
Ask: In which countries or regions must it run, and must any data stay in one place?
Recommend: Recommend the region already configured. With none, recommend the region nearest the users, and a single region unless `compliance` names residency.
Writes: constraint

## ci-cd
Pack: infra
Visit: standard, large
Fact: pipeline files and release scripts (`.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`, `scripts/release*`)
Ask: How should changes reach production: automatically when checks pass, or with a person approving each release? Who can roll back?
Recommend: Recommend the existing pipeline's behavior. With none, recommend automatic deploys to staging and a manual approval for production.
Writes: constraint

## consumers
Pack: library
Visit: standard, large
Fact: dependents, example projects and public entry points (`package.json` `exports`, `examples/`, `README.md` usage)
Ask: Who will use this library and in what environments: which languages, runtimes and versions?
Recommend: Recommend the runtimes in the repo's engines or CI matrix. With none, recommend the current long-term-support runtime.
Writes: constraint

## versioning
Pack: library
Visit: standard, large
Fact: version numbers, changelog and deprecation notes (`package.json`, `CHANGELOG.md`, release tags)
Ask: What counts as a breaking change, how do you version releases, and how long do you support old versions?
Recommend: Recommend semantic versioning with a changelog entry per release, and the support window the changelog already shows.
Writes: constraint
