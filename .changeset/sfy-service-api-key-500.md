---
"@truefoundry/trueforge": patch
---

Map ServiceFoundry 401/403 on calls authenticated with `TRUEFOUNDRY_API_KEY` to 500 so a mismatched service key does not log the UI out.
