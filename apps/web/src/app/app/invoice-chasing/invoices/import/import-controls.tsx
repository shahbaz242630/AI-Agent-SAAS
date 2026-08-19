"use client";

import { useActionState } from "react";
import { importConfirmLabel, MAX_UPLOAD_BYTES } from "@/products/invoice-follow-up/import-messages";
import { cancelImport, confirmImport, uploadImport, type ImportActionState } from "./actions";

const INITIAL: ImportActionState = {};

/**
 * ⚠️ THE APP'S BUTTON VOCABULARY, NOT THIS SCREEN'S OWN (dressed 2026-08-11).
 * These carried the pre-design shapes — card radius, `font-medium`, no shadow,
 * a grey secondary — so the import flow's controls did not match the buttons on
 * any screen a customer had already used. Consistency across a product is not
 * decoration; a control that looks different reads as doing something
 * different.
 */
const BUTTON_CLASS =
  "cursor-pointer rounded-[var(--radius-control)] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-[var(--shadow-primary)] hover:opacity-90 disabled:opacity-60";
const SMALL_BUTTON_CLASS =
  "cursor-pointer rounded-[var(--radius-control)] border border-input-border bg-surface px-3 py-1.5 text-xs font-semibold hover:bg-chip-hover disabled:opacity-60";

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
        /* The file picker's own button is a control like any other — the
           browser's default is nobody's design system. */
        className="cursor-pointer text-sm text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-[var(--radius-control)] file:border file:border-input-border file:bg-surface file:px-4 file:py-2 file:text-[13px] file:font-semibold file:text-label hover:file:bg-chip-hover"
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
