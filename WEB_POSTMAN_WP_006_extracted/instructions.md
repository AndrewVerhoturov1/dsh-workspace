# WP-006 / P5 Artifact DOM Detection

Base: `d837b85996ebe82cda40c72bfe03b629b2f5ed71`

This package implements P5 only.

## Result envelope

External ChatGPT ZIP responses are expected to contain exactly:

```text
<<<POSTMAN_RESULT_BEGIN:<REQ>>>
POSTMAN_ARTIFACT:POSTMAN_<REQ>_RESULT.zip
<<<POSTMAN_RESULT_END:<REQ>>>
```

The markers are additional untrusted correlation evidence. They never replace
trusted Runtime request metadata and never authorize a page-wide attachment.

## Implementation

New module:

- `postman/web/artifact_detector.py`

New tests:

- `postman/web/tests/test_artifact_detector.py`

Documentation is updated through `changes.patch`.

P5 consumes a trusted completed WP-005 result, re-confirms the same assistant
turn, requires the exact envelope and exact Runtime-derived filename, and
selects one download/attachment control only inside that turn.

P5 explicitly does not call `click()`, `expect_download()`, `save_as()` or the
artifact validator. Those belong to P6/WP-007.
