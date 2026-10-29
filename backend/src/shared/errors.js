/**
 * An error that is safe to show to clients. `details` is merged into the JSON error body;
 * `headers` are set on the response (e.g. Retry-After).
 */
export class AppError extends Error {
  constructor(status, code, message, { headers, details } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.details = details;
  }
}