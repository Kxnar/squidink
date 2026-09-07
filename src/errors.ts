export class SquidError extends Error {
  constructor(message: string, readonly code = 'invalid') { super(message); this.name = 'SquidError'; }
}
export function messageFor(error: unknown): string {
  // Raw transport exceptions and response bodies can contain private data.
  return error instanceof SquidError ? error.message : 'Squid could not complete this action. Your note has not been replaced.';
}
