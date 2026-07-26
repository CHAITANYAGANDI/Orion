# Recallix AI — Load Testing

> **Status: planned, not yet implemented.** This document is the test plan. The
> k6 scripts described below have **not been written** and no load run has been
> performed — the results table further down is an empty template, not findings.

The intended harness is [k6](https://k6.io), with scripts to live under
`backend-spring/load-testing/`:

```bash
# once the scripts exist, with the stack running (docker compose up) and dev auth:
k6 run backend-spring/load-testing/list-meetings.js
k6 run backend-spring/load-testing/create-meeting.js
k6 run backend-spring/load-testing/rate-limit.js
```

## Scenarios
| Scenario | Script | Goal | Pass criteria |
|---|---|---|---|
| 100 VUs listing meetings | `list-meetings.js` | read throughput | p95 < 300ms, 0 errors |
| 50 VUs creating meeting metadata | `create-meeting.js` | write stability | p95 < 500ms, 0 5xx |
| Rate-limited AI endpoint | `rate-limit.js` | plan enforcement | receives HTTP 429 after FREE limit |
| WebSocket status | manual / `k6/x-websockets` | progress delivery | events received, no UI freeze |

## Results (template — fill in after your run)
| Metric | list-meetings (100 VU) | create-meeting (50 VU) |
|---|---|---|
| Requests | — | — |
| avg | — | — |
| p95 | — | — |
| Error rate | — | — |

> Record your machine specs and a screenshot of the k6 summary here for the README.
