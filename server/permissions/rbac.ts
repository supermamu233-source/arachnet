import { Role } from "@/lib/generated/prisma/enums";

/**
 * Role hierarchy, highest privilege first. A role satisfies a required
 * minimum role if it appears at or before that role in this list.
 */
const ROLE_ORDER: Role[] = ["OWNER", "ADMIN", "MANAGER", "COUNTER", "VIEWER"];

export function roleSatisfies(actual: Role, minimum: Role): boolean {
  return ROLE_ORDER.indexOf(actual) <= ROLE_ORDER.indexOf(minimum);
}

export { ROLE_ORDER };
export type { Role };
