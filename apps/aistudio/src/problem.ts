// An error that carries its HTTP status: 409 for a busy studio or a changed state, 422 for invalid input.
// Errors without a status answer 400.
export class Problem extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
