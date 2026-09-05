# Expected tests

Offline:

```powershell
python -m py_compile postman/web/artifact_detector.py postman/web/browser_observer.py postman/web/browser_submit.py
python -m unittest discover -s postman/web/tests -p test_artifact_detector.py -v
python -m unittest discover -s postman/web/tests -p test_browser_observer.py -v
python -m unittest discover -s postman/web/tests -p test_browser_submit.py -v
python -m unittest discover -s postman/web/tests -p test_browser_bootstrap.py -v
node --test postman/web/tests/artifact-validator.test.mjs
git diff --check
```

Required regressions:

- exact BEGIN -> ARTIFACT -> END accepted;
- wrong request rejected;
- wrong filename rejected;
- duplicate/ambiguous envelope rejected;
- stale attachment before current user anchor ignored;
- same filename outside correlated assistant turn rejected;
- unrelated Download control ignored;
- changed assistant turn identity rejected;
- active generation rejected;
- zero page-wide body search;
- zero click/download/save APIs in P5.

Live smoke: exactly one prompt after all offline tests PASS. It must generate
one tiny ZIP attachment with a unique trusted request id and the exact envelope.
The detector must return `ARTIFACT_DOM_CONFIRMED`. Do not download the ZIP.
No automatic or manual retry in the same acceptance run.
