# core pack

Applies to every change in every project, whatever its language or domain. It assumes the code is split into modules (packages, directories or files with a clear owner) and that the project's architecture doc names each module's public entry point and seams.

## Rules

1. A module imports another module only through that module's index or public entry file.
   Test: no import path in the diff reaches past another module's entry file into its internals.
2. Each new file or function belongs to the module whose responsibility it serves, so cohesion stays high.
   Test: every new file sits under a path the module map assigns to a module whose stated responsibility covers it.
3. Code at a module edge depends on an interface or abstract type, not on another module's concrete class, to keep coupling loose, when a second implementation or a test double exists or is planned; otherwise rule 12 applies.
   Test: constructor and function parameters that cross a module boundary are typed as interfaces, protocols or function types, not concrete classes.
4. A class that mixes I/O with domain logic has one reason to change and receives its collaborators instead of constructing them (SOLID: single responsibility, dependency inversion); otherwise rule 12 applies.
   Test: no new class both does I/O and holds domain logic, and no constructor in the diff calls `new` (or the language's equivalent) on another module's service.
5. A seam that two or more modules or crews build against has an explicit contract: a typed signature, schema or documented interface; otherwise rule 12 applies.
   Test: each function, endpoint or message that crosses a module boundary in the diff has declared input and output types or a schema file.
6. Code that takes input from outside the process validates it at that boundary so it can fail fast with a specific error; otherwise rule 12 applies.
   Test: new public functions check required arguments at the top and raise or return a named error, and no `catch` block in the diff swallows an error without rethrowing or logging it.
7. Operations that something actually retries are idempotent: running one twice leaves the same state as running it once; otherwise rule 12 applies.
   Test: every new write, job or handler that may be retried uses an idempotency key, an upsert, or a check-before-write, and a test runs it twice.
8. New code paths that call a service outside the process or fail in a way an operator must diagnose emit observability signals: a structured log line, metric or trace span; otherwise rule 12 applies.
   Test: each new external call and error branch in the diff logs or records a metric with a stable event name and context fields.
9. Errors and logs never carry secrets or personal data.
   Test: grep the diff for tokens, passwords, keys and full request bodies inside log, print or error-message calls; none appear.
10. New settings, endpoints and permissions ship with a secure default: off, closed or least access until configured.
   Test: every new flag, CORS rule, auth check or permission in the diff defaults to deny or disabled.
11. Secrets come from configuration or a secret store, never from source.
   Test: a secret scanner (for example `gitleaks detect`) or a grep for key patterns finds nothing new in the diff.
12. Code is written for a current requirement, not a guessed future one (YAGNI).
   Test: every new parameter, option, abstraction or extension point in the diff has a caller in the same diff or in existing code.
13. A behavior change ships with a test that fails without the change.
   Test: the diff adds or changes a test that exercises the changed behavior, and reverting the source change makes that test fail.
14. Dead code goes in the same change that makes it dead.
   Test: no function, file or flag the diff stops using is left in place; a search for its name finds no remaining definition.
