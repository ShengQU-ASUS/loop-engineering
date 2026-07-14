export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function notFound(kind: string, id: string): HttpError {
  return new HttpError(404, "NOT_FOUND", `${kind} '${id}' was not found`);
}

export function conflict(code: string, message: string, details?: unknown): HttpError {
  return new HttpError(409, code, message, details);
}
