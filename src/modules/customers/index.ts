/** Public API of the customers module (CLAUDE.md §2.5). */
export {
  scopeFilter,
  inScope,
  getCustomerRef,
  getCustomerRefs,
  getByErpId,
  idsInArea,
  idsAssignedTo,
  erpPaidBetween,
  assignmentStateOfBranch,
  applyAssignments,
  setTag,
  setOpenPromiseDates,
  customerVersion,
  registerListEnricher,
  registerDetailContributor,
  registerTimelineSource,
  overdueSummary,
  searchCustomers,
  nearestCustomer,
  overdueAging,
  overdueRows,
  erpFieldPayments,
  dataQualityScan,
} from './service.js';
export { QUALITY_ISSUES, type QualityIssue } from './domain/quality.js';
export type { CustomerRef, AssignmentChange, ListExtras, ListEnricher, DetailContributor, TimelineItem, TimelineSource, OverdueRow, ErpFieldPayment, QualityRow } from './service.js';
export type { CustomerStatus } from './domain/status.js';
