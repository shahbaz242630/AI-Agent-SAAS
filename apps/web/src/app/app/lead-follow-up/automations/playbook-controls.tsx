"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  LEAD_PLAYBOOK_LABELS,
  REPLY_CHANNEL_LABELS,
  REPLY_CHANNELS,
  type LeadPlaybookDto,
  type LeadPlaybookKey,
  type LeadPlaybookWordingDto,
  type ReplyChannel,
} from "@eva/types";
import { GhostButton, PrimarySubmit, StatusPill, TextArea } from "@/components/ui";
import {
  emptyBoxLine,
  sendsFromLine,
  switchBlockedLine,
  type SendsFrom,
} from "@/products/lead-follow-up/automations-screen";
import {
  clearPlaybookWording,
  savePlaybookWording,
  setPlaybookEnabled,
  type AutomationActionState,
} from "./actions";

/**
 * One card: a thing Eva does on her own, with its switch and a box of words
 * per channel (slice 3.5a, ruling 93; blueprint §3.6 — "on/off, a wording box
 * per channel, one or two numbers, and nothing else").
 *
 * ⚠️ ONE FORM PER CONTROL, NOT ONE "SAVE ALL" — the `step-controls.tsx`
 * precedent. The switch is its own form; each box is its own form; each clear
 * is its own form. A single button would fire five PATCHes and leave a
 * customer guessing which one failed.
 *
 * ⚠️ NO `useEffect` RESETTING ANYTHING. React 19 resets a form after an action
 * completes, so `defaultValue` on an uncontrolled field is re-read from the
 * server data the revalidation just refreshed. Making these controlled would
 * reintroduce the live-money bug from 2026-08-27.
 *
 * ⚠️ THE CONFIRM FORMS ARE SIBLINGS OF THE EDITOR FORMS, NEVER CHILDREN. HTML
 * forbids a nested `<form>`; the browser drops the inner one and every confirm
 * button becomes a submit of the enclosing form — "Yes, clear it" would have
 * saved. `automations.spec.ts` parses this file for exactly that.
 */

const MAX_BODY = 4000;

/**
 * What the box says about where the words end up. An email leaves the
 * customer's mailbox and picks up their signature; a WhatsApp message leaves
 * their business number and picks up their profile name.
 */
function bodyHint(channel: ReplyChannel): string {
  switch (channel) {
    case "email":
      return "Plain text — it is sent from your own mailbox, so your usual signature goes on the end.";
    case "whatsapp":
      return "Plain text — it is sent from your WhatsApp number, under your business name, as a reply in the same chat.";
  }
}

export function PlaybookCard({
  organisationId,
  playbook,
  sendsFrom,
  openingHoursSet,
  canEdit,
}: {
  organisationId: string;
  playbook: LeadPlaybookDto;
  sendsFrom: Record<ReplyChannel, SendsFrom>;
  openingHoursSet: boolean;
  canEdit: boolean;
}) {
  const label = LEAD_PLAYBOOK_LABELS[playbook.key];
  const blocked = switchBlockedLine(playbook, openingHoursSet);

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-bold">{label.name}</h2>
          <StatusPill tone={playbook.enabled ? "good" : "mute"}>
            {playbook.enabled ? "On" : "Off"}
          </StatusPill>
        </div>
        <p className="text-[12.5px] text-muted-foreground">{label.when}</p>
        {blocked && (
          <p className="text-[12.5px] text-muted-foreground">
            {blocked.text}
            {blocked.action && (
              <>
                {" "}
                <Link href={blocked.action.href} className="font-medium text-link hover:underline">
                  {blocked.action.label}
                </Link>
              </>
            )}
          </p>
        )}
        {canEdit ? (
          /* A blocked card that is off has no switch to offer: the api would
             refuse it, and a button that can only fail is worse than a line
             saying what to do first. A blocked card that is ON can still be
             switched off. */
          (playbook.enabled || !blocked) && (
            <SwitchControl organisationId={organisationId} playbook={playbook} />
          )
        ) : (
          <p className="text-[12.5px] text-muted-foreground">
            Only an owner can switch this on or off.
          </p>
        )}
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {REPLY_CHANNELS.map((channel) => (
          <WordingBox
            key={channel}
            organisationId={organisationId}
            playbookKey={playbook.key}
            channel={channel}
            wording={playbook.wordings[channel]}
            sendsFrom={sendsFrom[channel]}
            canEdit={canEdit}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The switch. Rendered for the state the card is in, so a press replaces it —
 * which is why its action returns no message (see `actions.ts`).
 *
 * ⚠️ SWITCHING THE INSTANT REPLY OFF IS CONFIRMED, BECAUSE IT IS THE ONE
 * CONTROL THAT MAKES THE PRODUCT DO LESS. Everything else here changes what
 * Eva says; this stops her answering anybody, and somebody who pressed it by
 * accident would not find out until an enquirer told them.
 */
function SwitchControl({
  organisationId,
  playbook,
}: {
  organisationId: string;
  playbook: LeadPlaybookDto;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<AutomationActionState, FormData>(
    setPlaybookEnabled,
    {},
  );
  const turningOff = playbook.enabled;
  const needsConfirm = turningOff && playbook.key === "instant_reply";

  if (needsConfirm && !confirming) {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <GhostButton onClick={() => setConfirming(true)}>Switch off</GhostButton>
        </div>
        {state.error && <p className="text-sm text-danger">{state.error}</p>}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {needsConfirm && (
        <p className="text-sm font-medium">
          Stop replying to enquiries automatically? They will still arrive in the book, and nobody
          hears back until somebody replies themselves.
        </p>
      )}
      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="organisationId" value={organisationId} />
        <input type="hidden" name="key" value={playbook.key} />
        <input type="hidden" name="enabled" value={turningOff ? "false" : "true"} />
        <PrimarySubmit disabled={pending}>
          {pending
            ? turningOff
              ? "Switching off…"
              : "Switching on…"
            : needsConfirm
              ? "Yes, switch it off"
              : turningOff
                ? "Switch off"
                : "Switch on"}
        </PrimarySubmit>
        {needsConfirm && <GhostButton onClick={() => setConfirming(false)}>Cancel</GhostButton>}
      </form>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
    </div>
  );
}

/**
 * One channel's box on one card: where its replies leave from, the words,
 * and the way to empty it.
 *
 * ⚠️ AN EMPTY BOX IS A CHOICE AND THE SCREEN SAYS WHAT IT MEANS. The switch is
 * per card, across channels; clearing a box is how a customer silences one
 * channel for one card, and the line under the empty box says so.
 *
 * ⚠️ `sendsFrom === null` ONLY GREYS THE WORDS. The line above says why, and
 * the box stays editable: an owner may well write the words before the
 * mailbox or the number is connected.
 */
function WordingBox({
  organisationId,
  playbookKey,
  channel,
  wording,
  sendsFrom,
  canEdit,
}: {
  organisationId: string;
  playbookKey: LeadPlaybookKey;
  channel: ReplyChannel;
  wording: LeadPlaybookWordingDto | null;
  sendsFrom: SendsFrom;
  canEdit: boolean;
}) {
  const [state, formAction, pending] = useActionState<AutomationActionState, FormData>(
    savePlaybookWording,
    {},
  );
  const line = sendsFromLine(channel, sendsFrom);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-[13.5px] font-semibold">{REPLY_CHANNEL_LABELS[channel]}</h3>
        <p className="text-[12.5px] text-muted-foreground">
          {line.text}
          {line.action && (
            <>
              {" "}
              <Link href={line.action.href} className="font-medium text-link hover:underline">
                {line.action.label}
              </Link>
            </>
          )}
        </p>
      </div>

      <div className={`flex flex-col gap-3 ${sendsFrom ? "" : "opacity-60"}`}>
        {canEdit ? (
          <form action={formAction} className="flex flex-col gap-3">
            <input type="hidden" name="organisationId" value={organisationId} />
            <input type="hidden" name="key" value={playbookKey} />
            <input type="hidden" name="channel" value={channel} />
            <TextArea
              name="body"
              label="What Eva says"
              defaultValue={wording?.body ?? ""}
              rows={6}
              maxLength={MAX_BODY}
              hint={wording ? bodyHint(channel) : emptyBoxLine(channel)}
            />
            <div className="flex flex-wrap items-center gap-3">
              <PrimarySubmit disabled={pending}>{pending ? "Saving…" : "Save"}</PrimarySubmit>
            </div>
            {state.error && <p className="text-sm text-danger">{state.error}</p>}
            {state.success && <p className="text-sm text-success">{state.success}</p>}
          </form>
        ) : wording ? (
          <p className="text-sm whitespace-pre-wrap">{wording.body}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{emptyBoxLine(channel)}</p>
        )}

        {canEdit && wording && (
          <ClearWording
            organisationId={organisationId}
            playbookKey={playbookKey}
            channel={channel}
          />
        )}
      </div>
    </div>
  );
}

/**
 * ⚠️ ITS OWN `<form>`, BESIDE THE EDITOR'S AND NEVER INSIDE IT. It posts a
 * different action; as a submit of the editing form it would send whatever
 * was half-typed in the box along with "clear this", and HTML would drop the
 * inner form anyway. Confirmed, because the only visible difference afterwards
 * is an empty box.
 */
function ClearWording({
  organisationId,
  playbookKey,
  channel,
}: {
  organisationId: string;
  playbookKey: LeadPlaybookKey;
  channel: ReplyChannel;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<AutomationActionState, FormData>(
    clearPlaybookWording,
    {},
  );

  if (!confirming) {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <GhostButton size="sm" onClick={() => setConfirming(true)}>
            Clear this box
          </GhostButton>
        </div>
        {state.error && <p className="text-sm text-danger">{state.error}</p>}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <p className="text-sm font-medium">
        {`Empty the ${REPLY_CHANNEL_LABELS[channel]} box? Eva will say nothing on ${REPLY_CHANNEL_LABELS[channel]} for this card.`}
      </p>
      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="organisationId" value={organisationId} />
        <input type="hidden" name="key" value={playbookKey} />
        <input type="hidden" name="channel" value={channel} />
        <PrimarySubmit disabled={pending}>{pending ? "Clearing…" : "Yes, clear it"}</PrimarySubmit>
        <GhostButton onClick={() => setConfirming(false)}>Cancel</GhostButton>
      </form>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
    </div>
  );
}
