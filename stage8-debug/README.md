# Stage 8 parallel desktop use — failure-analysis bundle

This directory contains only the five requested debugging materials plus environment/failure notes. It is not the full prototype and is not a production change.

Contents:

1. `tests/parallel-retest-stage8.js` — complete attempted runner.
2. `src/foreground-monitor.ps1` — complete foreground monitor.
3. `src/adapter-excerpts.js` — adapter functions relevant to getState, typeText, semanticClick, and monitor lifecycle.
4. `src/provider-excerpts.js` — provider validation, text routes, semantic route, and monitor code.
5. `results/stage7-wpf-results.md` — Stage 7 WPF benchmark result excerpt.
6. `environment-and-failure.md` — versions, browser, command, and exact available failure output.

The attempted Stage 8 runner was not a valid benchmark: it timed out/was aborted before writing a result. No Stage 8 PASS/FAIL conclusion should be inferred from it.
