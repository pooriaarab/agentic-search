export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "not allowed") {
    super(message);
    this.name = "ForbiddenError";
  }
}
