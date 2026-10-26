# data pack

Use this pack for any change to a batch or streaming pipeline, an ETL or ELT job, a warehouse model, or a dataset another team reads. It extends the core pack and assumes a pipeline made of stages, each reading named datasets and writing others, run by an orchestrator on a schedule.

## Rules

1. Every step writes its output by overwriting its partition or merging on a key, so the step is idempotent and a rerun gives the same result.
   Test: no step in the diff appends to a target without a dedup key or partition overwrite; running it twice on the same input gives the same row count.
2. A step's output depends only on its inputs and its run parameters, such as the logical date, and never on the wall clock or a "latest" lookup.
   Test: no `now()`, `current_date` or latest-file lookup in a step's logic in the diff; the processing date arrives as a parameter.
3. Each dataset passed between stages has a schema declared in the repo: columns, types, nullability and keys.
   Test: each output table or file added or changed in the diff has a schema file or model definition next to it.
4. A producer validates its output against the schema before publishing, and a consumer reads only declared columns.
   Test: the step in the diff writes through a schema check, and no query in the diff does `SELECT *` from another stage's output.
5. Schema changes are additive by default; renaming, retyping or dropping a column is a new schema version with a change in every consumer.
   Test: no column is removed or retyped in the diff without a version bump and a matching change in each downstream consumer.
6. Raw data lands once, as received, and is never updated or deleted in place except by the documented retention job.
   Test: no `UPDATE`, `DELETE`, `MERGE` or overwrite against the raw zone in the diff; writes to raw are append-only.
7. Cleaning, typing and deduplication happen in a later stage that reads from raw, so any stage can be rebuilt from raw.
   Test: the ingestion code in the diff writes the payload and load metadata only, with no business transformation.
8. Every row written carries lineage: the source, the run ID and the code version that produced it.
   Test: each new output schema in the diff has source, run-ID and load-time columns, or the step emits lineage to the catalog.
9. Each step declares its upstream datasets in code, so the orchestrator generates the dependency graph.
   Test: each new step in the diff lists its inputs in the orchestrator definition and reads no dataset it doesn't declare.
10. Any step can be backfilled over a date range through the same code path as the scheduled run.
   Test: the step takes a start and end partition as parameters, and the diff adds no separate one-off backfill script.
11. A backfill runs in bounded partition batches with a concurrency limit so it can't starve the scheduled runs.
   Test: the backfill command in the diff or its runbook names a partition range, a batch size and a concurrency limit.
12. Data-quality checks gate publication: a failing check stops the step before any consumer can see the output.
   Test: each new output in the diff has quality checks (row count, null keys, uniqueness, accepted values) that run before the publish step, and a failure exits non-zero.
13. A step writes to a staging location and publishes by an atomic swap or partition switch.
   Test: no step in the diff writes directly to the table or path consumers read; it writes to staging, then renames or swaps.
14. Personal and sensitive columns are tagged in the schema and masked or dropped before they leave the restricted zone.
   Test: each new column holding personal data in the diff has a classification tag and a masking or drop rule in the stage that leaves the restricted zone.

## Notes

Rules 1, 2 and 10 make core's idempotency rule specific: a step you can rerun for any date is a step you can backfill. Rules 3 to 5 are core's contracts at seams, with the dataset as the seam.
