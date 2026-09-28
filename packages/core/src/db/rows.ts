/** Row types inferred from the Drizzle schema, named once so services and pure code agree. */
import type {
  approvals,
  auditEvents,
  cases,
  customers,
  devices,
  disputes,
  executions,
  ledgerEntries,
  merchants,
  orders,
  paymentAttempts,
  payments,
  refunds,
  resolutions,
  settlements,
  supportNotes,
  users,
  validationResults,
} from './schema';

export type OrderRow = typeof orders.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type MerchantRow = typeof merchants.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;
export type LedgerEntryRow = typeof ledgerEntries.$inferSelect;
export type RefundRow = typeof refunds.$inferSelect;
export type SettlementRow = typeof settlements.$inferSelect;
export type PaymentAttemptRow = typeof paymentAttempts.$inferSelect;
export type SupportNoteRow = typeof supportNotes.$inferSelect;
export type CaseRow = typeof cases.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type ResolutionRow = typeof resolutions.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type ExecutionRow = typeof executions.$inferSelect;
export type ValidationResultRow = typeof validationResults.$inferSelect;
export type DisputeRow = typeof disputes.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
