# ai pack

Use this pack for any change that calls a language model or another learned model at runtime: prompts, model choice, retrieval, agents and tool use, and the code around those calls. It extends the core pack and assumes the model is reached through an API whose output can vary from call to call.

## Rules

1. A change to a prompt, model, model parameter or retrieval setup lands with an eval run against the current baseline, and its results are checked in.
   Test: a diff that changes a prompt, model name, model parameter or retrieval setting also adds or updates an eval results file with scores for the old and new version on the same eval set.
2. The eval set is checked into the repo with expected outputs or grading criteria, and each fixed production failure adds a case.
   Test: an eval dataset file exists in the repo, and a diff that fixes a reported bad output adds an eval case for it.
3. Graders are deterministic code where possible; a model grader is pinned to a fixed model and prompt and checked against human labels.
   Test: each grader in the diff is code, or names a pinned grader model and has an agreement check against labelled samples.
4. Prompts live in versioned files under one prompt directory, never as string literals inside business logic.
   Test: grep the diff for multi-line prompt strings in application code; there are none, and prompts load from the prompt directory.
5. Every model call names a pinned model version from config, never a floating alias.
   Test: no model ID in the diff is an alias such as `latest`; each is a dated or versioned ID read from config.
6. Every model call is traced with the prompt version, model version, parameters and token counts.
   Test: the call wrapper in the diff writes prompt ID and version, model ID, temperature, and input and output tokens to the log or trace.
7. All model calls go through one client wrapper that owns retries, timeouts, tracing and cost tracking.
   Test: no file in the diff outside the wrapper module imports a provider SDK.
8. Model output is parsed and validated against a schema at the seam, so code downstream receives typed data or an error.
   Test: each new model call in the diff is followed by schema validation, and a parse failure takes a defined path (retry, fallback or error).
9. Decisions that code can make, such as routing, arithmetic and permission checks, stay in code and out of the prompt.
   Test: no prompt in the diff asks the model to enforce access control, compute totals, or pick among options the code already knows.
10. Unit tests run without network access, with model calls replaced at the wrapper by a fake or recorded responses.
   Test: the unit test suite passes with the provider API key unset.
11. Model output that triggers a side effect (sending, writing, paying, running code) passes an allowlist or a human confirmation first.
   Test: each tool or action the model can call in the diff is on an explicit allowlist, and destructive ones require confirmation.
12. Untrusted text (user input, retrieved documents, tool output) goes into the prompt as marked data and never into the system instructions.
   Test: no user or retrieved text in the diff is interpolated into a system prompt; it sits in a delimited user or data section.
13. Each model-backed feature has a cost budget per request and per day, enforced in code.
   Test: the wrapper config in the diff sets max output tokens per call, and a spend counter or quota rejects calls over the daily cap.
14. Each model-backed feature has a latency budget, enforced by a timeout with a fallback.
   Test: every new model call in the diff sets a timeout no larger than the feature's latency budget, and the timeout path has a handled fallback.

## Notes

Rules 7 and 8 apply core's explicit contracts at seams to model calls, which makes the seam deterministic: everything past the wrapper is ordinary code you can test. Rule 12 applies core's secure defaults to prompt injection.
