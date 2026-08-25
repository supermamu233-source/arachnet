import type { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/prisma";

type Tx = Prisma.TransactionClient;

interface RecordAuditParams {
  organizationId: string;
  actorUserId?: string;
  actorRobotId?: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
  requestId?: string;
}

/**
 * Creates an audit log row. Audit rows are never updated after creation
 * (enforced by convention here, not by a DB trigger — nothing in this
 * codebase should ever call `auditLog.update` or `.delete`).
 */
export async function recordAudit(params: RecordAuditParams, client: Tx | typeof prisma = prisma) {
  await client.auditLog.create({
    data: {
      organizationId: params.organizationId,
      actorType: params.actorRobotId ? "ROBOT" : params.actorUserId ? "USER" : "SYSTEM",
      actorUserId: params.actorUserId,
      actorRobotId: params.actorRobotId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      oldValue: params.oldValue === undefined ? undefined : (params.oldValue as Prisma.InputJsonValue),
      newValue: params.newValue === undefined ? undefined : (params.newValue as Prisma.InputJsonValue),
      requestId: params.requestId,
    },
  });
}
