// Only these deliberately authored messages may be returned to clients.
export class SubscriptionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
