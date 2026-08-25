import { NextResponse } from "next/server";
import { ZodError } from "zod";

/**
 * Stable machine-readable error codes returned to API clients. Keep this list
 * append-only — removing or renaming a code is a breaking change for any
 * client (browser, offline queue, robot simulator) that branches on it.
 */
export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "IDEMPOTENCY_CONFLICT"
  | "ORGANIZATION_MISMATCH"
  | "PRODUCT_NOT_FOUND"
  | "LOCATION_NOT_FOUND"
  | "EVIDENCE_NOT_FOUND"
  | "EVIDENCE_NOT_READY"
  | "EVIDENCE_HASH_MISMATCH"
  | "EVIDENCE_TYPE_REJECTED"
  | "EVIDENCE_TOO_LARGE"
  | "ROBOT_UNAUTHENTICATED"
  | "ROBOT_DISABLED"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 422,
  IDEMPOTENCY_CONFLICT: 409,
  ORGANIZATION_MISMATCH: 403,
  PRODUCT_NOT_FOUND: 404,
  LOCATION_NOT_FOUND: 404,
  EVIDENCE_NOT_FOUND: 404,
  EVIDENCE_NOT_READY: 409,
  EVIDENCE_HASH_MISMATCH: 422,
  EVIDENCE_TYPE_REJECTED: 422,
  EVIDENCE_TOO_LARGE: 413,
  ROBOT_UNAUTHENTICATED: 401,
  ROBOT_DISABLED: 403,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

interface ApiEnvelope<T> {
  data: T | null;
  error: { code: ApiErrorCode; message: string; details?: unknown } | null;
  requestId: string;
}

export function ok<T>(data: T, requestId: string, init?: ResponseInit) {
  const body: ApiEnvelope<T> = { data, error: null, requestId };
  return NextResponse.json(body, init);
}

/**
 * Converts any thrown error into a stable API envelope. Never forwards a
 * stack trace or raw internal message to the client for unexpected errors —
 * only ApiError and ZodError messages are considered safe to show.
 */
export function toErrorResponse(error: unknown, requestId: string) {
  if (error instanceof ApiError) {
    const body: ApiEnvelope<null> = {
      data: null,
      error: { code: error.code, message: error.message, details: error.details },
      requestId,
    };
    return NextResponse.json(body, { status: error.status });
  }

  if (error instanceof ZodError) {
    const body: ApiEnvelope<null> = {
      data: null,
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
        details: error.issues,
      },
      requestId,
    };
    return NextResponse.json(body, { status: 422 });
  }

  const body: ApiEnvelope<null> = {
    data: null,
    error: { code: "INTERNAL_ERROR", message: "Internal server error." },
    requestId,
  };
  return NextResponse.json(body, { status: 500 });
}
