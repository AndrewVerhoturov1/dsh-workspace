# Stage 7 WPF benchmark — relevant excerpt

Source: `results/stage7-route-certification.json` and `STAGE7_ROUTE_CERTIFICATION_REPORT.md`.

Environment recorded by Stage 7:

- repetitions: 20
- policy: `backgroundOnly=true`, experimental `allowUncertifiedSemanticRoute=true`
- production allowlist: empty

| Framework | Control | controlType | className | Pattern | Attempts | Verified | Foreground steals | Provider errors | Timeouts | Focus events | Classification |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| WPF | Button | Button | Button | InvokePattern | 20 | 20 | 1 | 0 | 0 | 1 | BACKGROUND_UNSAFE |
| WPF | CheckBox | CheckBox | CheckBox | TogglePattern | 20 | 20 | 0 | 0 | 0 | 1 | BACKGROUND_SAFE candidate, not certified |
| WPF | ListItem | ListItem | ListBoxItem | SelectionItemPattern | 20 | 20 | 0 | 0 | 0 | 1 | BACKGROUND_SAFE candidate, not certified |
| WPF | Expander | Group | Expander | ExpandCollapsePattern | 20 | 20 | 0 | 0 | 0 | 1 | BACKGROUND_SAFE candidate, not certified |

Exact Stage 7 route rows:

```json
{
  "framework": "WPF",
  "control": "Button",
  "controlType": "Button",
  "className": "Button",
  "pattern": "InvokePattern",
  "attempts": 20,
  "verifiedEffects": 20,
  "foregroundSteals": 1,
  "providerErrors": 0,
  "timeouts": 0,
  "focusEvents": 1,
  "targetForegroundObserved": true,
  "classification": "BACKGROUND_UNSAFE",
  "certifiedBeforeBenchmark": false
}
```

```json
{
  "framework": "WPF",
  "control": "CheckBox",
  "controlType": "CheckBox",
  "className": "CheckBox",
  "pattern": "TogglePattern",
  "attempts": 20,
  "verifiedEffects": 20,
  "foregroundSteals": 0,
  "providerErrors": 0,
  "timeouts": 0,
  "focusEvents": 1,
  "targetForegroundObserved": false,
  "classification": "BACKGROUND_SAFE",
  "certifiedBeforeBenchmark": false
}
```

The allowlist remained empty; benchmark results never update production policy.