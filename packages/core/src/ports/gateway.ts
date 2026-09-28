import type {
  CardNetwork,
  GwPaymentStatus,
  GwRefundStatus,
  PaymentMethod,
  WebhookDeliveryStatus,
  WebhookEventType,
} from '@payops/shared';

/**
 * What PayOps needs from a payment gateway. The simulator implements it over the gw_* tables;
 * a Razorpay test-mode adapter can implement it over HTTP later. All amounts in paise.
 */
export interface GatewayPayment {
  id: string;
  orderRef: string;
  merchantId: string;
  amountMinor: number;
  status: GwPaymentStatus;
  method: PaymentMethod;
  card: { last4: string; network: CardNetwork; country: string } | null;
  capturedAt: Date | null;
  refundedMinor: number;
  createdAt: Date;
}

export interface GatewayRefund {
  id: string;
  gwPaymentId: string;
  amountMinor: number;
  status: GwRefundStatus;
  processedAt: Date | null;
  createdAt: Date;
}

export interface GatewayWebhookDelivery {
  id: string;
  event: WebhookEventType;
  gwPaymentId: string;
  gwRefundId: string | null;
  attempts: Array<{ at: string; httpStatus: number | null; latencyMs: number; error: string | null }>;
  finalStatus: WebhookDeliveryStatus;
  createdAt: Date;
}

export interface GatewaySettlementLine {
  id: string;
  batchId: string;
  merchantId: string;
  gwPaymentId: string;
  grossMinor: number;
  feeMinor: number;
  taxMinor: number;
  netMinor: number;
  lineNo: number;
  settledOn: Date;
}

export interface PaymentGatewayPort {
  readonly name: string;
  getPayments(ids: readonly string[]): Promise<GatewayPayment[]>;
  listPaymentsByOrder(orderRefs: readonly string[]): Promise<GatewayPayment[]>;
  listWebhookDeliveries(gwPaymentIds: readonly string[]): Promise<GatewayWebhookDelivery[]>;
  listRefunds(gwPaymentIds: readonly string[]): Promise<GatewayRefund[]>;
  listSettlementLines(filter: { batchIds?: readonly string[]; gwPaymentIds?: readonly string[] }): Promise<GatewaySettlementLine[]>;
}
