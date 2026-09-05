"use client";

import { useActionState, useState } from "react";
import {
  MAX_LEAD_REPLY_TEMPLATES,
  REPLY_CHANNEL_LABELS,
  type LeadReplyTemplateDto,
  type ReplyChannel,
} from "@eva/types";
import { GhostButton, PrimarySubmit, StatusPill, TextArea, TextField } from "@/components/ui";
import { firstLine } from "@/products/lead-follow-up/replies-screen";
import {
  addReplyTemplate,
  deleteReplyTemplate,
  saveReplyTemplate,
  setAutomaticReply,
  turnOffAutomaticReply,
  type ReplyTemplateActionState,
} from "./actions";

/**
 * Editing the words Eva replies with (slice 3.1c-1).
 *
 * ⚠️ THE WHOLE FEATURE IS "THESE ARE YOURS TO REWRITE", so the editor opens
 * in place, on the page, rather than behind a modal or a second screen — one
 * at a time since ruling 89, because six open editors (twenty at the cap)
 * buried the one fact the screen exists for: which wording Eva sends. Three
 * wordings arrive written; a customer who changes nothing still sends
 * something sensible, and a customer who wants their own voice types over
 * ours in place.
 *
 * ⚠️ ONE FORM PER TEMPLATE, NOT ONE "SAVE ALL" — the `step-controls.tsx`
 * precedent. Each save is its own PATCH, so a single button would fire four of
 * them and leave a customer guessing which one failed.
 *
 * ⚠️ NO `useEffect` RESETTING ANYTHING. React 19 resets a form after an action
 * completes, so `defaultValue` on an uncontrolled field is re-read from the
 * server data the revalidation just refreshed. Making these controlled would
 * reintroduce the live-money bug from 2026-08-27, where a `value` with no HTML
 * default snapped a select back to its first option.
 */

const MAX_NAME = 80;
const MAX_BODY = 4000;

/**
 * What the wording box says about where the words end up (3.4a). An email
 * leaves the customer's mailbox and picks up their signature; a WhatsApp
 * message leaves their business number and picks up their profile name. The
 * hint was one sentence about a mailbox until there was a second channel, and
 * that sentence was wrong on the WhatsApp card.
 */
function bodyHint(channel: ReplyChannel): string {
  switch (channel) {
    case "email":
      return "Plain text — it is sent from your own mailbox, so your usual signature goes on the end.";
    case "whatsapp":
      return "Plain text — it is sent from your WhatsApp number, under your business name, as a reply in the same chat.";
  }
}

/**
 * One channel's wordings, as a list that opens one editor at a time (ruling
 * 89). A row per wording — its name, its first line, the pill on the one Eva
 * sends — puts the whole channel in one view, and a click opens the editor
 * in place under the row.
 *
 * ⚠️ THE ROW IS A BUTTON, NOT A FORM. Each editor owns a `<form>`, and the
 * confirm controls own theirs; the row that opens them must not be one, or
 * the nesting guard in `reply-templates.spec.ts` is the only thing that would
 * notice.
 *
 * ⚠️ `connected` ONLY GREYS THE LIST. The panel's own line says why, and the
 * wordings stay editable: an owner may well write them before the mailbox or
 * the number is connected.
 */
export function ChannelWordings({
  organisationId,
  channel,
  templates,
  automaticTemplateId,
  canEdit,
  connected,
}: {
  organisationId: string;
  channel: ReplyChannel;
  templates: LeadReplyTemplateDto[];
  automaticTemplateId: string | null;
  canEdit: boolean;
  connected: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const automaticName = templates.find((template) => template.id === automaticTemplateId)?.name;

  return (
    <div className="flex flex-col gap-4">
      {templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {`No ${REPLY_CHANNEL_LABELS[channel]} wordings yet.`}
        </p>
      ) : (
        <ul
          className={`flex flex-col divide-y divide-hairline border-t border-hairline ${
            connected ? "" : "opacity-60"
          }`}
        >
          {templates.map((template) => {
            const open = template.id === openId;
            return (
              <li key={template.id} className="flex flex-col">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : template.id)}
                  className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 py-3 text-left hover:bg-chip-hover"
                >
                  <span className="text-[13.5px] font-semibold">{template.name}</span>
                  {template.isAutomatic && <StatusPill tone="good">Eva sends this one</StatusPill>}
                  <span className="basis-full truncate text-[12.5px] text-muted-foreground">
                    {firstLine(template.body)}
                  </span>
                </button>
                {open && (
                  <div className="pb-5">
                    <ReplyTemplateCard
                      organisationId={organisationId}
                      template={template}
                      previousAutomaticName={
                        /* Only meaningful when promoting a DIFFERENT one — the
                           message that names what stepped down would otherwise
                           name this template. Scoped to the channel, because
                           promoting a WhatsApp wording steps down a WhatsApp one. */
                        template.isAutomatic ? undefined : automaticName
                      }
                      canEdit={canEdit}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && templates.length < MAX_LEAD_REPLY_TEMPLATES && (
        <AddReplyTemplate organisationId={organisationId} channel={channel} />
      )}
    </div>
  );
}

function ReplyTemplateCard({
  organisationId,
  template,
  previousAutomaticName,
  canEdit,
}: {
  organisationId: string;
  template: LeadReplyTemplateDto;
  previousAutomaticName: string | undefined;
  canEdit: boolean;
}) {
  const [state, formAction, pending] = useActionState<ReplyTemplateActionState, FormData>(
    saveReplyTemplate,
    {},
  );

  return (
    <section className="flex flex-col gap-4">
      {/**
       * ⚠️ SAID ON THE AUTOMATIC CARD, EVERY TIME, NOT ONCE AT THE TOP OF THE
       * PAGE. This is the only wording that leaves the building without anybody
       * reading it first, and somebody editing the box needs to know that while
       * they are typing — not to have read it in a paragraph above four cards.
       */}
      {template.isAutomatic && (
        <p className="text-[12.5px] text-muted-foreground">
          Sent automatically, on its own, to everyone who gets in touch. Nobody checks it first.
        </p>
      )}

      {canEdit ? (
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="organisationId" value={organisationId} />
          <input type="hidden" name="templateId" value={template.id} />
          <TextField
            name="name"
            label="Name"
            defaultValue={template.name}
            maxLength={MAX_NAME}
            required
          />
          <TextArea
            name="body"
            label="What it says"
            defaultValue={template.body}
            maxLength={MAX_BODY}
            required
            hint={bodyHint(template.channel)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <PrimarySubmit disabled={pending}>{pending ? "Saving…" : "Save"}</PrimarySubmit>
          </div>
          {state.error && <p className="text-sm text-danger">{state.error}</p>}
          {state.success && <p className="text-sm text-success">{state.success}</p>}
        </form>
      ) : (
        <>
          <p className="text-sm whitespace-pre-wrap">{template.body}</p>
          <p className="text-[12.5px] text-muted-foreground">
            Only an owner can change these wordings.
          </p>
        </>
      )}

      {/**
       * ⚠️ OUTSIDE THE EDITOR'S `<form>`, AND THAT IS LOAD-BEARING RATHER THAN
       * TIDY. Each of these controls owns a `<form>` of its own, and HTML
       * forbids a nested one: React renders the markup happily, the browser
       * drops the inner form, and every confirm button then submits the
       * ENCLOSING form instead. "Yes, delete it" would have saved the template.
       *
       * Nothing catches that — it type-checks, it lints, and no test in this
       * repo can click. `reply-templates.spec.tsx` asserts the nesting is gone
       * by parsing this file, because the next person to tuck a button into
       * that row would reintroduce it invisibly.
       */}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-4">
          {!template.isAutomatic && (
            <MakeAutomatic
              organisationId={organisationId}
              template={template}
              previousAutomaticName={previousAutomaticName}
            />
          )}
          {template.isAutomatic ? (
            <TurnOffAutomatic organisationId={organisationId} template={template} />
          ) : (
            <DeleteTemplate organisationId={organisationId} template={template} />
          )}
        </div>
      )}
    </section>
  );
}

/**
 * ⚠️ ITS OWN `<form>`, IN ITS OWN ROW BELOW THE EDITOR. Each of these posts a
 * different action, so they cannot be submits of the editing form: that would
 * send the name and body along with "make this automatic" and save whatever was
 * half-typed in the boxes as a side effect of a different button.
 *
 * ⚠️ AND THEY MUST NOT BE MOVED BACK INTO THAT FORM. I wrote them inside it
 * first. HTML forbids a nested `<form>`; React emits the markup, the browser
 * discards the inner one, and each confirm button silently becomes a submit of
 * the SAVE form — so "Yes, delete it" saves instead of deleting. Typecheck,
 * lint and the whole suite pass on that, because no test here can click.
 */
function MakeAutomatic({
  organisationId,
  template,
  previousAutomaticName,
}: {
  organisationId: string;
  template: LeadReplyTemplateDto;
  previousAutomaticName: string | undefined;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<ReplyTemplateActionState, FormData>(
    setAutomaticReply,
    {},
  );

  if (!confirming) {
    return (
      <>
        <GhostButton onClick={() => setConfirming(true)}>Eva sends this one</GhostButton>
        {state.error && <p className="w-full text-sm text-danger">{state.error}</p>}
      </>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <p className="text-sm font-medium">
        {previousAutomaticName
          ? `Reply to every new enquiry with “${template.name}” instead of “${previousAutomaticName}”?`
          : `Reply to every new enquiry with “${template.name}”?`}
      </p>
      <ConfirmRow
        organisationId={organisationId}
        templateId={template.id}
        formAction={formAction}
        pending={pending}
        confirmLabel="Yes, Eva sends this one"
        pendingLabel="Saving…"
        onCancel={() => setConfirming(false)}
      />
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
    </div>
  );
}

/**
 * ⚠️ CONFIRMED, BECAUSE IT IS THE ONE CONTROL THAT MAKES THE PRODUCT DO LESS.
 * Everything else here changes what Eva says; this stops her saying anything at
 * all, and the only visible difference afterwards is a missing pill. Somebody
 * who pressed it by accident would not find out until an enquirer told them.
 */
function TurnOffAutomatic({
  organisationId,
  template,
}: {
  organisationId: string;
  template: LeadReplyTemplateDto;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<ReplyTemplateActionState, FormData>(
    turnOffAutomaticReply,
    {},
  );

  if (!confirming) {
    return (
      <>
        <GhostButton onClick={() => setConfirming(true)}>Turn off automatic replies</GhostButton>
        {state.error && <p className="w-full text-sm text-danger">{state.error}</p>}
      </>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <p className="text-sm font-medium">
        Stop replying to enquiries automatically? They will still arrive in the book, and nobody
        hears back until somebody replies themselves.
      </p>
      <ConfirmRow
        organisationId={organisationId}
        templateId={template.id}
        formAction={formAction}
        pending={pending}
        confirmLabel="Yes, turn it off"
        pendingLabel="Turning off…"
        onCancel={() => setConfirming(false)}
      />
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
    </div>
  );
}

function DeleteTemplate({
  organisationId,
  template,
}: {
  organisationId: string;
  template: LeadReplyTemplateDto;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<ReplyTemplateActionState, FormData>(
    deleteReplyTemplate,
    {},
  );

  if (!confirming) {
    return (
      <>
        <GhostButton onClick={() => setConfirming(true)}>Delete</GhostButton>
        {state.error && <p className="w-full text-sm text-danger">{state.error}</p>}
      </>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <p className="text-sm font-medium">{`Delete “${template.name}”?`}</p>
      <ConfirmRow
        organisationId={organisationId}
        templateId={template.id}
        formAction={formAction}
        pending={pending}
        confirmLabel="Yes, delete it"
        pendingLabel="Deleting…"
        onCancel={() => setConfirming(false)}
      />
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
    </div>
  );
}

/**
 * The confirm/cancel pair, so three confirmations cannot drift into three shapes.
 *
 * ⚠️ IT CARRIES THE ORGANISATION AND THE TEMPLATE AND NOTHING ELSE. It had an
 * `extra` slot for additional hidden fields, which existed only to feed the
 * names into success messages that turned out never to render (see the note in
 * `actions.ts`). An unused extension point on a shared component is how a file
 * grows a shape nobody needs and everybody copies.
 */
function ConfirmRow({
  organisationId,
  templateId,
  formAction,
  pending,
  confirmLabel,
  pendingLabel,
  onCancel,
}: {
  organisationId: string;
  templateId: string;
  formAction: (formData: FormData) => void;
  pending: boolean;
  confirmLabel: string;
  pendingLabel: string;
  onCancel: () => void;
}) {
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="templateId" value={templateId} />
      <PrimarySubmit disabled={pending}>{pending ? pendingLabel : confirmLabel}</PrimarySubmit>
      <GhostButton onClick={onCancel}>Cancel</GhostButton>
    </form>
  );
}

/**
 * ⚠️ THE FORM IS BEHIND A BUTTON, NOT ALWAYS OPEN. An empty name-and-body pair
 * sitting under three filled cards reads as a fourth template that somebody
 * forgot to write, and it is the one thing on this screen a customer does
 * rarely.
 */
function AddReplyTemplate({
  organisationId,
  channel,
}: {
  organisationId: string;
  channel: ReplyChannel;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ReplyTemplateActionState, FormData>(
    addReplyTemplate,
    {},
  );

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <GhostButton onClick={() => setOpen(true)}>Add another reply</GhostButton>
        </div>
        {state.success && <p className="text-sm text-success">{state.success}</p>}
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-4 border-t border-hairline pt-4">
      <h2 className="text-[13.5px] font-semibold">A new reply</h2>
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="organisationId" value={organisationId} />
        {/**
         * ⚠️ THE CHANNEL TRAVELS WITH THE FORM, AND THE SERVER DOES NOT
         * DEFAULT IT. A wording saved against the wrong medium is not a
         * filing error — it becomes a candidate for Eva to send, so an
         * email wording could go out over WhatsApp telling the reader to
         * "reply to this email".
         */}
        <input type="hidden" name="channel" value={channel} />
        <TextField
          name="name"
          label="Name"
          maxLength={MAX_NAME}
          required
          placeholder="Booked up this month"
        />
        <TextArea
          name="body"
          label="What it says"
          maxLength={MAX_BODY}
          required
          hint="Kept for when Eva can choose between wordings. She keeps sending whichever one is marked automatic."
        />
        <div className="flex flex-wrap items-center gap-3">
          <PrimarySubmit disabled={pending}>{pending ? "Adding…" : "Add this reply"}</PrimarySubmit>
          <GhostButton onClick={() => setOpen(false)}>Cancel</GhostButton>
        </div>
        {state.error && <p className="text-sm text-danger">{state.error}</p>}
        {/**
         * ⚠️ RENDERED HERE AS WELL AS IN THE COLLAPSED VIEW, AND LEAVING IT OUT
         * MADE ADDING A REPLY LOOK LIKE IT HAD FAILED. Found by walking the
         * screen; invisible to every test in the repo.
         *
         * React 19 resets a form once its action completes, so pressing "Add
         * this reply" emptied both boxes and left the form open. The template
         * really had been saved — but it is placed alphabetically, so it
         * usually lands off the top of the screen, and the only confirmation
         * was in the branch `open` was keeping shut. Two empty boxes and no
         * message is indistinguishable from a form that silently did nothing.
         *
         * The form deliberately stays OPEN afterwards rather than collapsing:
         * the empty boxes plus this line read as "saved, ready for the next
         * one", and collapsing would need state set from an effect, which
         * `react-hooks/set-state-in-effect` refuses — correctly.
         */}
        {state.success && <p className="text-sm text-success">{state.success}</p>}
      </form>
    </section>
  );
}
