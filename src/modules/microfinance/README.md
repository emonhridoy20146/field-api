# microfinance (reserved)

Boundary only (FR-MF-001/002, ADR-020). Do **not** add routes, models or logic here.

- Separate legal entity; must be checked with counsel against MRA regulation before any work.
- Data must live in `mf_*` collections, preferably in a separate database or cluster.
- Permission namespace `microfinance.*` is reserved: overrides cannot grant it, super admin does not hold it.
- Flag `module.microfinance` is locked until `settings.microfinance.legalApproved = true` is set by a super admin with a document reference.
