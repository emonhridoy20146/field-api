# Changelog — field-api

All notable changes. Format: Keep a Changelog; contract version = `docs/openapi.yaml` `info.version`.

## [Unreleased] — contract 1.2.0
### Added
- Phase 0 implementation: core (config, errors bn/en problem+json, Dhaka time, money, geo, Mongo + migrations, event bus, outbox, Mongo-leased jobs, idempotency, change feed), module loader with manifest validation, auth (EdDSA JWT, refresh rotation with reuse detection, lockout), users, rbac (catalog, overrides, explain), branches, settings (holidays, shifts), flags (locked microfinance flag), audit (hash chain), devices (binding/approval), system (health, app-config), erp-gateway (Laravel client, circuit breaker, mappers, MockErpClient, delta sync, reconcile, posting outbox handler).
- Phase 1 modules: customers (read model + FOS overlay, status derivation, bad suggestion, list/detail/map/timeline, refresh, pin corrections), tags (tag/untag, history, approval mode, balance-cleared review), assignments (areas, primary assignee, bulk, history), handovers (receiver acceptance, 72 h expiry, temporary cover revert), collections (idempotent record, receipt blocks, anomaly flags, ERP posting with timeout-after-store recovery, conflicts, void, resolve, ERP reversal reflection).
- Settings `location.trackingProvider` (`free` | `paid`, default `free`) and `location.providerConfig` so the background-location plugin can be switched from admin settings later.
- Contract 1.1.0 (additive): `TagEvent.kind/deviceLocation/approvalOf`, `TagReviewItem`, `GET /customers?includeTotal`.
- Contract 1.2.0 (additive, answering staff-app gaps): `geo` may be `null` with `geoUnavailableReason` on collection/visit/attendance (flag `no_location`); `CustomerListItem.installmentPoisha/overduePoisha/areaName`; documented per-entity shapes for `SyncChange.data` and `SyncMutation.payload`; `contact_attempt` entity + `/customers/{id}/contact-attempts` (FR-M-014, server implementation pending).
### Notes
- A plan ended yesterday with 1 poisha left is suggested as bad (FR-TAG-001 has no tolerance) — see OD-25.

## [0.0.0] — 2026-11-15
### Added
- Initial specification: system analysis, master requirements (138 FRs, NFRs, 50 permission keys), design guide, architecture with module manifest and folder tree, OpenAPI 1.0.0-spec (103 paths), data model, ERP integration spec with assumptions register E-01…E-26 and maintainer checklist, test plan with traceability matrix, ADR-001…023 and open decisions OD-01…OD-24, phased roadmap.
