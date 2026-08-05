"use client";

import { useActionState } from "react";
import { importConfirmLabel, MAX_UPLOAD_BYTES } from "@/lib/import-messages";
import { cancelImport, confirmImport, uploadImport, type ImportActionState } from "./actions";

const INITIAL: ImportActionState = {};

const BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60";
const SMALL_BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-muted px-3 py-1.5 text-xs font-medium hover:opacity-80 disabled:opacity-60";

function Feedback({ state }: { state: ImportActionState }) {
  if (!state.error) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {state.error}
    </p>
  );
}

export function UploadForm({ organisationId }: { organisationId: string }) {
  const [state, action, pending] = useActionState(uploadImport, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="organisationId" value={organisationId} />
      <input
        type="file"
        name="file"
        required
        /* A hint to the picker, not a guarantee: the API identifies the file by
           its CONTENT, because an extension is a claim anybody can make. */
        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="text-sm file:mr-3 file:rounded-[var(--radius-card)] file:border-0 file:bg-muted file:px-4 file:py-2 file:text-sm file:font-medium"
      />
      <Feedback state={state} />
      <div>
        <button type="submit" disabled={pending} className={BUTTON_CLASS}>
          {pending ? "Reading your file…" : "Upload and preview"}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        {`Nothing is created by uploading. You will see what Eva read from the file, and can throw it away, before anything is saved. Up to ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`}
      </p>
    </form>
  );
}

/**
 * Confirm or discard a staged import.
 *
 * ⚠️ THE CONFIRM BUTTON SAYS HOW MANY, AND THE COPY SAYS "DRAFTS". The importer
 * creates DRAFT invoices, so nothing is chased until somebody starts them. That
 * is the safe behaviour and completely invisible unless it is said — a customer
 * who uploads two hundred invoices and assumes Eva is now chasing them would
 * find out weeks later.
 */
export function ConfirmImportControls({
  organisationId,
  importId,
  validRows,
}: {
  organisationId: string;
  importId: string;
  validRows: number;
}) {
  const [confirmState, confirmAction, confirming] = useActionState(confirmImport, INITIAL);
  const [cancelState, cancelAction, cancelling] = useActionState(cancelImport, INITIAL);

  const hidden = (
    <>
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="importId" value={importId} />
    </>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <form action={confirmAction}>
          {hidden}
          <button
            type="submit"
            disabled={confirming || cancelling || validRows === 0}
            className={BUTTON_CLASS}
          >
            {confirming ? "Importing…" : importConfirmLabel(validRows)}
          </button>
        </form>
        <form action={cancelAction}>
          {hidden}
          <button type="submit" disabled={confirming || cancelling} className={SMALL_BUTTON_CLASS}>
            {cancelling ? "Discarding…" : "Discard this file"}
          </button>
        </form>
      </div>
      {validRows > 0 && (
        <p className="text-xs text-muted-foreground">
          They arrive as drafts, so Eva will not email anyone until you start chasing them.
        </p>
      )}
      <Feedback state={confirmState} />
      <Feedback state={cancelState} />
    </div>
  );
}
