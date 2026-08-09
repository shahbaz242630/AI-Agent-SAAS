import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import {
  importConfirmedLine,
  importFieldLabel,
  importReadLine,
  importRowStatusLabel,
  isImportableRowStatus,
} from "@/lib/import-messages";
import { can, readOnlyImportsLine } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { ConfirmImportControls } from "../import-controls";

/**
 * The preview, and afterwards the report (slice 1.6c).
 *
 * ⚠️ ONE PAGE FOR BOTH, because they are the same rows: before a confirm it
 * says what WOULD happen, and after it says what DID. Two pages would mean two
 * renderings of the same table drifting apart, and the API already models it
 * this way — `GET .../imports/:id` is "preview before confirm, report after".
 */

interface OrganisationSummary {
  id: string;
  name: string;
  /** What this person may do here — resolved by the API, never by us. */
  permissions: string[];
}

interface ImportRow {
  id: string;
  rowNumber: number;
  raw: Record<string, string>;
  status: string;
  errors: string[];
  createdInvoiceId: string | null;
}

interface ImportDetail {
  id: string;
  originalFilename: string;
  status: string;
  mapping: Record<string, string>;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  suppressedRows: number;
  createdRows: number;
  rows: ImportRow[];
}

export default async function ImportPreviewPage({
  params,
}: {
  // Next 16: `params` is a Promise and must be awaited.
  params: Promise<{ importId: string }>;
}) {
  const { importId } = await params;
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");

  const organisations = (await (
    await apiFetch("/organisations", accessToken)
  ).json()) as OrganisationSummary[];
  const organisation = organisations[0];
  if (!organisation) redirect("/app");

  /**
   * ⚠️ 403 AND 402 WERE UNCAUGHT UNTIL TASK 8, and both are reachable: this
   * page's only read is module-owned, so an organisation without Invoice
   * Chasing hit the `else throw` and got a crash instead of an upgrade prompt.
   * The gate order is preserved — 404 before either, so an upload id that does
   * not exist never becomes a way to ask what a stranger's organisation has
   * bought (standing rule §0d).
   */
  let detail: ImportDetail | null = null;
  let missing = false;
  let forbidden = false;
  let notEntitled = false;
  try {
    detail = (await (
      await apiFetch(`/organisations/${organisation.id}/imports/${importId}`, accessToken)
    ).json()) as ImportDetail;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    else if (error instanceof ApiError && error.status === 404) missing = true;
    else if (error instanceof ApiError && error.status === 403) forbidden = true;
    else if (error instanceof ApiError && error.status === 402) notEntitled = true;
    else throw error;
  }

  if (missing) {
    return (
      <Shell>
        <p className="w-full max-w-5xl text-sm text-muted-foreground">
          That upload is no longer here. It may have been discarded in another tab.
        </p>
      </Shell>
    );
  }

  if (notEntitled) {
    return (
      <Shell>
        <section className="flex w-full max-w-5xl flex-col gap-3 rounded-[var(--radius-card)] bg-muted px-6 py-4">
          <p className="text-sm">
            {`${organisation.name} doesn't have Invoice Chasing, so there's nowhere for these invoices to go yet.`}
          </p>
          <div>
            <Link
              href="/app/settings/modules"
              className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              See your products
            </Link>
          </div>
        </section>
      </Shell>
    );
  }

  if (forbidden || !detail) {
    return (
      <Shell>
        <p className="w-full max-w-5xl text-sm text-muted-foreground">
          {`Your role doesn't have access to ${organisation.name}'s uploads. Ask an owner or administrator.`}
        </p>
      </Shell>
    );
  }

  /**
   * ⚠️ SEEING THE PREVIEW AND COMMITTING IT ARE DIFFERENT PERMISSIONS.
   * `imports:read` shows the staged rows; `imports:write` turns them into
   * invoices or throws them away. A role holding only the first belongs on this
   * page — checking somebody else's upload before it lands is exactly what it
   * is for — and must not be offered either button.
   */
  const canImport = can(organisation, "imports:write");

  const done = detail.status === "completed";
  const skipped = detail.totalRows - detail.createdRows;

  /** The file's own column headings, in the order the importer mapped them. */
  const mappedColumns = Object.entries(detail.mapping);

  return (
    <Shell>
      <section className="flex w-full max-w-5xl flex-col gap-2">
        <h1 className="text-2xl font-bold text-primary">
          {done ? "Imported" : "Check this before it is saved"}
        </h1>
        <p className="text-sm text-muted-foreground">{detail.originalFilename}</p>
        <p className="text-sm">
          {done
            ? importConfirmedLine(detail.createdRows, skipped)
            : importReadLine({
                totalRows: detail.totalRows,
                validRows: detail.validRows,
                invalidRows: detail.invalidRows,
                duplicateRows: detail.duplicateRows,
                suppressedRows: detail.suppressedRows,
              })}
        </p>
      </section>

      {/* What Eva decided each of your headings meant — the single most useful
          thing to check before confirming, and the thing a wrong import is
          almost always caused by. */}
      {mappedColumns.length > 0 && (
        <section className="flex w-full max-w-5xl flex-col gap-2 rounded-[var(--radius-card)] bg-muted px-6 py-4">
          <h2 className="text-sm font-medium">How your columns were read</h2>
          <ul className="flex flex-wrap gap-2">
            {mappedColumns.map(([column, field]) => (
              <li
                key={column}
                className="rounded-[var(--radius-card)] bg-background px-3 py-1 text-xs"
              >
                {`${column} → ${importFieldLabel(field)}`}
              </li>
            ))}
          </ul>
          {!done && (
            <p className="text-xs text-muted-foreground">
              If any of these are wrong, discard the file and upload it again with clearer headings
              — nothing has been created yet.
            </p>
          )}
        </section>
      )}

      {!done && (
        <section className="w-full max-w-5xl">
          {canImport ? (
            <ConfirmImportControls
              organisationId={organisation.id}
              importId={detail.id}
              validRows={detail.validRows}
            />
          ) : (
            /* The rows below are still worth reading — this says why nothing
               can be done about them here, rather than leaving a preview that
               appears to have lost its buttons. */
            <p className="rounded-[var(--radius-card)] bg-muted px-6 py-3 text-sm text-muted-foreground">
              {readOnlyImportsLine(organisation.name)}
            </p>
          )}
        </section>
      )}

      <section className="w-full max-w-5xl overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-muted text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">Row</th>
              <th className="px-3 py-2 font-medium">What Eva read</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {detail.rows.map((row) => (
              <tr key={row.id} className="border-b border-muted/50 align-top">
                <td className="px-3 py-3 text-muted-foreground">{row.rowNumber}</td>
                <td className="px-3 py-3">
                  <span className="block text-xs">
                    {Object.entries(row.raw)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(" · ")}
                  </span>
                  {/*
                    A row that will not import must say why HERE, not after
                    confirming — that is the whole point of a preview.

                    ⚠️ COLOURED BY THE ROW'S STATUS, NOT BY THE ARRAY IT CAME
                    FROM. `errors` also carries INFORMATIONAL flags — "customer
                    'Harbour Freight Ltd' will be created on confirm" is news,
                    not a fault. The first version painted every one of them
                    danger red, so four rows that imported perfectly were
                    covered in red warnings. Only a row that genuinely failed
                    gets the alarming colour.
                  */}
                  {row.errors.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {row.errors.map((error) => (
                        <li
                          key={error}
                          className={`text-xs ${
                            row.status === "invalid" ? "text-danger" : "text-muted-foreground"
                          }`}
                        >
                          {error}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  <span
                    className={`inline-block rounded-[var(--radius-card)] px-2 py-1 text-xs font-medium ${
                      isImportableRowStatus(row.status) || row.status === "imported"
                        ? "bg-success/10 text-success"
                        : row.status === "invalid"
                          ? "bg-danger/10 text-danger"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {importRowStatusLabel(row.status)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {done && (
        <div className="flex w-full max-w-5xl gap-3">
          <Link
            href="/app/invoices?status=draft"
            className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            See the drafts
          </Link>
          <Link
            href="/app/invoices/import"
            className="rounded-[var(--radius-card)] bg-muted px-4 py-2 text-sm font-medium hover:opacity-80"
          >
            Upload another file
          </Link>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex w-full max-w-[1080px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
      {children}
      <Link
        href="/app/invoices"
        className="text-sm font-medium text-muted-foreground hover:underline"
      >
        Back to your invoices
      </Link>
    </main>
  );
}
