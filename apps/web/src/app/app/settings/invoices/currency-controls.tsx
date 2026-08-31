"use client";

import { useActionState } from "react";
import { CURRENCY_SUGGESTIONS } from "@/lib/currencies";
import { PrimarySubmit } from "@/components/ui";
import { setDefaultCurrency, type SettingsActionState } from "./actions";

/**
 * Choosing the currency a new invoice opens on (slice 1.6c, task 13).
 *
 * ⚠️ A FREE-TEXT INPUT WITH SUGGESTIONS, NOT A CLOSED DROPDOWN. The founder's
 * ruling is that this is a default and never a restriction, and a `<select>`
 * would make the suggestion list the whole world — a business trading in a
 * currency we did not think to list could not set it, and would conclude Eva
 * does not support them. The API accepts any three-letter ISO 4217 code.
 */

const FIELD = "rounded-[var(--radius-card)] border border-muted-foreground/20 px-3 py-2 text-sm";

export function CurrencyControls({
  organisationId,
  current,
}: {
  organisationId: string;
  current: string;
}) {
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    setDefaultCurrency,
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="organisationId" value={organisationId} />

      <label className="flex max-w-xs flex-col gap-1 text-sm">
        Currency code
        <input
          name="defaultCurrency"
          required
          /* ⚠️ Re-seeded from what was SUBMITTED before falling back to what is
             stored. React 19 resets an uncontrolled form when its action
             returns, so on a refusal this would otherwise snap back to the old
             value and look as though the typing never happened. */
          defaultValue={state.submitted ?? current}
          list="settings-currency-suggestions"
          maxLength={3}
          pattern="[A-Za-z]{3}"
          autoComplete="off"
          /* Presentation only — the action uppercases what it actually sends,
             because a CSS transform does not change what the form posts. */
          className={`${FIELD} uppercase`}
        />
        <datalist id="settings-currency-suggestions">
          {CURRENCY_SUGGESTIONS.map((code) => (
            <option key={code} value={code} />
          ))}
        </datalist>
      </label>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="text-sm text-success">
          {state.success}
        </p>
      )}

      <div>
        <PrimarySubmit disabled={pending}>{pending ? "Saving…" : "Save"}</PrimarySubmit>
      </div>
    </form>
  );
}
