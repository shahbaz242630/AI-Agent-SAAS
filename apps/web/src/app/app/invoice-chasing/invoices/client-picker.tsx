"use client";

import { useId, useMemo, useRef, useState } from "react";

/**
 * Choosing WHICH client an invoice belongs to (founder, 2026-08-18).
 *
 * ⚠️ THE PROBLEM IS THAT A NAME IS NOT AN IDENTITY. Before this, the add form
 * asked for the client's name as text and the API matched it — case-insensitive
 * exact — against existing clients. That works until two real clients share a
 * name, which the founder immediately found: *"a freelancer made content for
 * Imran Khalid, then for a 2nd client also named imran khalid"*. No matching
 * rule can separate those, so the API could only refuse, and the person was
 * stuck with no way to say which one they meant.
 *
 * Picking sends `customerId` and the name stops being matched at all.
 *
 * ⚠️ IT MUST STILL ACCEPT A NAME NOBODY HAS USED YET. The whole reason this
 * form exists is that adding a client, finding it again and then adding an
 * invoice was three steps the founder asked us to remove. Typing a new name and
 * ignoring the list creates the client exactly as before.
 */

export interface PickableClient {
  id: string;
  name: string;
  email: string | null;
  reference: string | null;
}

/** How many suggestions are shown at once — enough to choose from, not a list
    to read. Everything else is reachable by typing more of the name. */
const MAX_SUGGESTIONS = 8;

const FIELD = "rounded-[var(--radius-card)] border border-muted-foreground/20 px-3 py-2 text-sm";

export function ClientPicker({
  clients,
  defaultName,
}: {
  clients: PickableClient[];
  /** What was typed before a refusal, so the form does not lose it. */
  defaultName: string;
}) {
  const [query, setQuery] = useState(defaultName);
  /**
   * ⚠️ CLEARED THE MOMENT THE TEXT CHANGES. A picked client and a name that no
   * longer matches it is the one state that could put an invoice on a client
   * the person did not mean — they choose "Imran Khalid (IK-001)", then edit
   * the text to "Imran Khalid (IK-002)", and a kept id sends it to the first.
   */
  const [picked, setPicked] = useState<PickableClient | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const trimmed = query.trim();
  const suggestions = useMemo(() => {
    if (trimmed === "") return clients.slice(0, MAX_SUGGESTIONS);
    const needle = trimmed.toLowerCase();
    return clients
      .filter((client) => client.name.toLowerCase().includes(needle))
      .slice(0, MAX_SUGGESTIONS);
  }, [clients, trimmed]);

  /**
   * The founder's exact scenario, caught before the API has to refuse it: the
   * typed name belongs to more than one client and none has been chosen.
   */
  const sameName = useMemo(
    () =>
      trimmed === ""
        ? []
        : clients.filter((client) => client.name.toLowerCase() === trimmed.toLowerCase()),
    [clients, trimmed],
  );
  const ambiguous = picked === null && sameName.length > 1;

  const choose = (client: PickableClient) => {
    setPicked(client);
    setQuery(client.name);
    setOpen(false);
    inputRef.current?.focus();
  };

  const chooseNew = () => {
    setPicked(null);
    setOpen(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // Stops the caret jumping to the ends of the text while browsing.
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const last = suggestions.length - 1;
      setActive((current) =>
        event.key === "ArrowDown"
          ? current >= last
            ? 0
            : current + 1
          : current <= 0
            ? last
            : current - 1,
      );
      return;
    }
    if (event.key === "Enter" && open) {
      const chosen = suggestions[active];
      if (chosen) {
        // Only swallow the Enter when it actually picked something, or a
        // keyboard user could never submit the form from this field.
        event.preventDefault();
        choose(chosen);
      }
    }
  };

  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="flex flex-col gap-1" htmlFor={`${listId}-input`}>
        Client name
        <div className="relative">
          <input
            id={`${listId}-input`}
            ref={inputRef}
            name="clientName"
            required
            maxLength={200}
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPicked(null);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            /* A blur that fires before the click lands would close the list and
               swallow the choice, so it waits a tick. `onMouseDown` on the
               options would also work; this keeps the option a plain button. */
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onKeyDown={onKeyDown}
            className={`w-full ${FIELD}`}
          />
          {open && (suggestions.length > 0 || trimmed !== "") && (
            <div
              id={listId}
              role="listbox"
              className="absolute z-30 mt-1 flex w-full flex-col rounded-[var(--radius-card)] border border-border bg-surface py-1 shadow-[var(--shadow-panel)]"
            >
              {suggestions.map((client, index) => (
                <button
                  key={client.id}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  onClick={() => choose(client)}
                  onMouseEnter={() => setActive(index)}
                  className={`flex flex-col gap-0.5 px-3 py-2 text-left ${
                    index === active ? "bg-chip-hover" : ""
                  }`}
                >
                  <span className="text-[13px] font-medium">{client.name}</span>
                  {/* ⚠️ THE DISTINGUISHING DETAIL IS THE POINT OF THE ROW. Two
                      options both reading "Imran Khalid" are no better than the
                      text box this replaced. */}
                  <span className="text-xs text-muted-foreground">
                    {[client.reference ? `Ref ${client.reference}` : null, client.email]
                      .filter(Boolean)
                      .join(" · ") || "No reference or email yet"}
                  </span>
                </button>
              ))}
              {trimmed !== "" && (
                <button
                  type="button"
                  onClick={chooseNew}
                  className="border-t border-hairline px-3 py-2 text-left text-[13px] font-medium"
                >
                  {`+ Add "${trimmed}" as a new client`}
                </button>
              )}
            </div>
          )}
        </div>
      </label>

      {picked && <input type="hidden" name="customerId" value={picked.id} />}

      {picked ? (
        <span className="text-xs text-success">
          {`Adding to ${picked.name}${
            picked.reference ? ` · Ref ${picked.reference}` : ""
          }${picked.email ? ` · ${picked.email}` : ""}`}
        </span>
      ) : ambiguous ? (
        <span role="alert" className="text-xs text-danger">
          {`${String(sameName.length)} of your clients are called "${trimmed}". Choose the one you mean from the list — otherwise this can't be saved.`}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">
          Start typing to pick an existing client, or type a new name to create one.
        </span>
      )}
    </div>
  );
}
