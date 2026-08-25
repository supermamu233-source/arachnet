# Reconciliation

## What is compared

For every **product + location** pair (never a location-level count against
a product-wide global total — product principle 3.7):

```
expected = the ExpectedStockBalance row with the latest sourceUpdatedAt
           for this (organizationId, productId, locationId)

observed = the latest accepted InventoryCount or RobotObservation
           for the same (organizationId, productId, locationId)

difference = observed - expected
```

Implemented in `domain/reconciliation/status.ts::classifyDiscrepancyStatus`,
`domain/reconciliation/severity.ts::classifySeverity`, and
`domain/reconciliation/confidence.ts::classifyConfidence` — all pure,
DB-free, unit-tested functions. The orchestration (loading the right rows,
writing/updating `InventoryDiscrepancy`, appending
`DiscrepancyResolutionEvent`s) lives in `server/services/reconciliation.ts`.

## Status classification

| Condition | Status |
|---|---|
| No expected balance exists | `EXPECTED_MISSING` |
| No physical observation exists | `PHYSICAL_UNVERIFIED` |
| Latest observation's confidence is `REVIEW_REQUIRED` | `REVIEW_REQUIRED` |
| `observed === expected` | `MATCH` |
| `observed > expected` | `SURPLUS` |
| `observed < expected` | `SHORTAGE` |

`RESOLVED` and `DISMISSED` are terminal states applied by the resolution
workflow (a human decision), never derived automatically.

## Confidence classification

A robot (or other machine) observation's `confidenceLevel` is never derived
above `REVIEW_REQUIRED` if the raw confidence score is missing or the
evidence is incomplete (e.g. no image attached) — see product principle 2.2:
a low-confidence or evidence-incomplete observation must never automatically
correct an external system.

Default thresholds (`domain/reconciliation/confidence.ts`, configurable):

| Level | Raw confidence |
|---|---|
| HIGH | ≥ 0.90 |
| MEDIUM | ≥ 0.75 |
| LOW | ≥ 0.50 |
| REVIEW_REQUIRED | < 0.50, or missing, or incomplete evidence |

## Severity classification

Default thresholds (`domain/reconciliation/severity.ts`, configurable per
organization) — **operational triage bands, not a statistical accuracy
claim** (product principle 2.8: no fake certainty):

| Severity | Absolute difference | OR percentage of expected |
|---|---|---|
| MEDIUM | ≥ 5 units | ≥ 10% |
| HIGH | ≥ 20 units | ≥ 25% |
| CRITICAL | ≥ 50 units | ≥ 50% |
| LOW | below all of the above | |

Whichever threshold (absolute or percentage) is more sensitive for a given
expected quantity wins — a 100-unit expected balance with an 8-unit miss is
still `MEDIUM` (absolute threshold), even though 8% is under the 10%
percentage threshold, because 8 ≥ 5. If the expected quantity is 0, the
percentage term is treated as infinite, so any nonzero observed quantity is
`CRITICAL` — finding stock where none should exist (or the reverse) is
inherently the most surprising case, not a small anomaly.

## Worked example (the required robot-integration case)

```
Product EAN 8431234567890, defaultUnitsPerBox = 6
Location WH1-A03-RB-L04
Expected quantity = 82

Robot reports: 12 boxes, 2 loose units, confidence 0.97

observed = 12 * 6 + 2 = 74        (domain/inventory/quantity.ts)
difference = 74 - 82 = -8
severity = MEDIUM                  (abs 8 ≥ 5, even though 8/82 ≈ 9.8% < 10%)
confidence = HIGH                  (0.97 ≥ 0.90, evidence complete)
status = SHORTAGE
```

An `InventoryDiscrepancy` is created/updated, evidence is linked, an audit
record is written, and the organization's official expected stock is **never**
overwritten automatically — a human resolves the discrepancy explicitly, and
that resolution (plus the full history) is retained even if the discrepancy
later reopens.

## Resolution history

Resolving or dismissing a discrepancy appends a `DiscrepancyResolutionEvent`
row rather than deleting anything. If a later observation reopens the same
product-location pair, the prior resolution stays visible in that
discrepancy's history — it is never erased by a new one.
