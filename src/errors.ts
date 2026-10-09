/** Every error and warning carries what went wrong, why, how to fix it, and whether a retry helps. */
export interface Problem {
  code: string;
  cause: string;
  fix: string;
  retryable: boolean;
}

export class CliError extends Error implements Problem {
  readonly code: string;
  override readonly cause: string;
  readonly fix: string;
  readonly retryable: boolean;
  /** 2 for a usage mistake, 1 for anything else */
  readonly exitCode: number;

  constructor(p: Problem, exitCode = 1) {
    super(`${p.code}: ${p.cause}`);
    this.name = "CliError";
    this.code = p.code;
    this.cause = p.cause;
    this.fix = p.fix;
    this.retryable = p.retryable;
    this.exitCode = exitCode;
  }

  toJSON(): Problem {
    return { code: this.code, cause: this.cause, fix: this.fix, retryable: this.retryable };
  }
}

export function usage(cause: string, fix: string): CliError {
  return new CliError({ code: "BAD_ARGUMENTS", cause, fix, retryable: false }, 2);
}

export function fail(code: string, cause: string, fix: string, retryable = false): CliError {
  return new CliError({ code, cause, fix, retryable });
}
