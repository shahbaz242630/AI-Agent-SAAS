import { ConflictException } from "@nestjs/common";
import type { ImportStatus } from "@eva/types";
import type { TenantTx } from "../../common/permissions/permissions.js";

/**
 * THE import status machine (the 1.2 pattern): transitionImportStatus is the
 * ONLY code path that may change imports.status. Every transition starts at
 * `uploaded` (plan §3): confirm runs synchronously to `completed` (plan §7.8
 * — 'confirmed' is never a stored state), cancel moves to `cancelled`, and
 * an unexpected confirm failure moves to `failed`.
 */
export type ImportAction = "confirm" | "cancel" | "fail";

const ACTIONS: Readonly<Record<ImportAction, { from: readonly ImportStatus[]; to: ImportStatus }>> =
  {
    confirm: { from: ["uploaded"], to: "completed" },
    cancel: { from: ["uploaded"], to: "cancelled" },
    fail: { from: ["uploaded"], to: "failed" },
  };

/**
 * The single status-write path. Throws 409 when `action` is not legal from
 * the import's current status. Returns the new stored status.
 */
export async function transitionImportStatus(
  tx: TenantTx,
  importId: string,
  currentStatus: string,
  action: ImportAction,
): Promise<ImportStatus> {
  const spec = ACTIONS[action];
  if (!spec.from.includes(currentStatus as ImportStatus)) {
    throw new ConflictException(`Import cannot '${action}' from status '${currentStatus}'`);
  }
  await tx.import.update({ where: { id: importId }, data: { status: spec.to } });
  return spec.to;
}
