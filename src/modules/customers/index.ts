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
} from './service.js';
export type { CustomerRef, AssignmentChange, ListExtras, ListEnricher, DetailContributor, TimelineItem, TimelineSource } from './service.js';
export type { CustomerStatus } from './domain/status.js';
