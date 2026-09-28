/** Realtime fan-out to the UI. Implemented by Socket.IO in the server, no-op in tests. */
export interface EventPublisherPort {
  publish(room: string, event: string, payload: unknown): void;
}
export const noopPublisher: EventPublisherPort = { publish: () => undefined };
