import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import { MAX_LEAD_REPLY_TEMPLATES, REPLY_CHANNELS, type LeadReplyTemplatesDto } from "@eva/types";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  type FixtureOrg,
} from "./support.js";
import { DEFAULT_LEAD_REPLY_TEMPLATES } from "../src/products/lead-follow-up/templates/default-templates.js";

/**
 * The words Eva replies with (slice 3.1c-1) — the lead product's first owned
 * table.
 *
 * ⚠️ THE INVARIANTS ARE THE POINT OF THIS FILE, NOT THE CRUD. Three of them
 * cost something real if they break:
 *
 *   1. exactly one automatic reply, ever (ruling 55) — two means a customer
 *      does not know what a stranger receives in their name;
 *   2. the automatic one cannot be deleted — deleting it stops Eva answering
 *      enquiries silently, and nothing on screen afterwards looks different;
 *   3. the defaults seed ONCE in an organisation's life — seeding whenever the
 *      list is empty means deleting the last template is an action the product
 *      quietly undoes.
 *
 * Each has a test below that fails if the rule is relaxed.
 */
describe("Lead reply templates: what Eva writes back", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  /** An organisation that has NOT bought lead follow-up by email. */
  let unentitledOrg: FixtureOrg;
  const tokens = new Map<string, string>();
  let unentitledToken: string;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(
      owner,
      "reply-templates",
      ["owner", "administrator", "sales", "reception", "finance", "read_only"],
      undefined,
      [{ moduleKey: "email_credit_controller" }, { moduleKey: "lead_follow_up" }],
    );
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }

    unentitledOrg = await createOrgWithMembers(
      owner,
      "reply-templates-unentitled",
      ["owner"],
      undefined,
      [{ moduleKey: "email_credit_controller" }],
    );
    unentitledToken = await signToken({
      sub: unentitledOrg.members[0]!.authUserId,
      email: unentitledOrg.members[0]!.email,
    });
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  const list = (token: string) =>
    request(app.getHttpServer())
      .get(`/organisations/${org.id}/lead-reply-templates`)
      .set("Authorization", `Bearer ${token}`);

  /**
   * ⚠️ DEFAULTS THE CHANNEL SO THE OTHER TESTS STAY ABOUT WHAT THEY TEST — and
   * a caller can still override it by passing one. **Anything asserting that a
   * request WITHOUT a channel is refused must not come through here**, or the
   * default silently satisfies the very thing under test. That mistake was made
   * once already in `product-mailbox-isolation.spec.ts` with `?module=`, where a
   * bulk edit added the parameter to the test proving it was required.
   * `rawAdd` below exists for exactly that case.
   */
  const add = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/organisations/${org.id}/lead-reply-templates`)
      .set("Authorization", `Bearer ${token}`)
      .send({ channel: "email", ...body });

  /** Sends the body verbatim. No defaults, ever. */
  const rawAdd = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/organisations/${org.id}/lead-reply-templates`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);

  const patch = (token: string, id: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(`/organisations/${org.id}/lead-reply-templates/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);

  const remove = (token: string, id: string) =>
    request(app.getHttpServer())
      .delete(`/organisations/${org.id}/lead-reply-templates/${id}`)
      .set("Authorization", `Bearer ${token}`);

  /** The current list, as the screen would read it. */
  const read = async (token = tokens.get("owner")!): Promise<LeadReplyTemplatesDto> => {
    const response = await list(token);
    expect(response.status).toBe(200);
    return response.body as LeadReplyTemplatesDto;
  };

  describe("the three a customer starts with", () => {
    it("creates them on the very first read, with exactly one automatic per channel", async () => {
      const body = await read();

      const expected = REPLY_CHANNELS.reduce(
        (sum, channel) => sum + DEFAULT_LEAD_REPLY_TEMPLATES[channel].length,
        0,
      );
      expect(body.templates).toHaveLength(expected);
      for (const channel of REPLY_CHANNELS) {
        expect(
          body.templates.filter((template) => template.channel === channel && template.isAutomatic),
          `${channel} must seed exactly one automatic wording`,
        ).toHaveLength(1);
        expect(body.automaticTemplateIds[channel]).not.toBeNull();
      }

      // The automatic one comes first within its channel — it is what somebody
      // came to check — and email's group comes first of all.
      expect(body.templates[0]!.channel).toBe("email");
      expect(body.templates[0]!.isAutomatic).toBe(true);
      expect(body.templates[0]!.id).toBe(body.automaticTemplateIds.email);
    });

    /**
     * ⚠️ THE DEFAULTS MUST NOT CONTAIN A PLACEHOLDER. There is no substitution
     * in the send path until 3.1c-3, so a `{{name}}` shipped here would be sent
     * to a real enquirer verbatim. This is a copy rule with no other guard —
     * exactly the class of thing that shipped seven false sentences in #109.
     */
    it("ships no placeholder tokens in the default wordings", () => {
      for (const template of DEFAULT_LEAD_REPLY_TEMPLATES.email) {
        expect(template.body, `${template.name} carries a placeholder`).not.toMatch(
          /\{\{|\}\}|\$\{|%\w+%/,
        );
      }
    });

    it("marks exactly one default as automatic", () => {
      const automatic = DEFAULT_LEAD_REPLY_TEMPLATES.email.filter((t) => t.isAutomatic);
      expect(automatic).toHaveLength(1);
    });

    it("does not put back a template that was deleted", async () => {
      const before = await read();
      const spare = before.templates.find((template) => !template.isAutomatic)!;

      expect((await remove(tokens.get("owner")!, spare.id)).status).toBe(204);

      const after = await read();
      expect(after.templates).toHaveLength(before.templates.length - 1);
      expect(after.templates.map((t) => t.id)).not.toContain(spare.id);

      // And a second read does not quietly put it back.
      const again = await read();
      expect(again.templates).toHaveLength(after.templates.length);
    });

    /**
     * ⚠️ THE CASE THAT ACTUALLY SEPARATES THE TWO SEEDING RULES, AND MY FIRST
     * VERSION OF THIS FILE DID NOT REACH IT.
     *
     * The test above deletes ONE of three, so the live count never gets to
     * zero — and "seed when the org has never had one" and "seed whenever the
     * list is empty" behave identically all the way through it. I changed the
     * service to the wrong rule to check, and every one of the 22 tests stayed
     * green. Only an EMPTIED list tells them apart.
     *
     * It runs on its own organisation because emptying the list is destructive
     * and would leave every test after it starting from a state no customer
     * would ever be in.
     */
    it("leaves an emptied list empty, rather than seeding it all over again", async () => {
      const emptied = await createOrgWithMembers(
        owner,
        "reply-templates-emptied",
        ["owner"],
        undefined,
        [{ moduleKey: "lead_follow_up" }],
      );
      const token = await signToken({
        sub: emptied.members[0]!.authUserId,
        email: emptied.members[0]!.email,
      });
      const url = `/organisations/${emptied.id}/lead-reply-templates`;

      const seeded = await request(app.getHttpServer())
        .get(url)
        .set("Authorization", `Bearer ${token}`);
      expect(seeded.status).toBe(200);
      const templates = (seeded.body as LeadReplyTemplatesDto).templates;
      expect(templates).toHaveLength(
        REPLY_CHANNELS.reduce(
          (sum, channel) => sum + DEFAULT_LEAD_REPLY_TEMPLATES[channel].length,
          0,
        ),
      );

      // An automatic one cannot be deleted while it is automatic, so each
      // channel's is switched off first — exactly the route a customer takes.
      for (const automatic of templates.filter((template) => template.isAutomatic)) {
        expect(
          (
            await request(app.getHttpServer())
              .patch(`${url}/${automatic.id}`)
              .set("Authorization", `Bearer ${token}`)
              .send({ isAutomatic: false })
          ).status,
        ).toBe(200);
      }

      for (const template of templates) {
        expect(
          (
            await request(app.getHttpServer())
              .delete(`${url}/${template.id}`)
              .set("Authorization", `Bearer ${token}`)
          ).status,
        ).toBe(204);
      }

      const afterEmptying = await request(app.getHttpServer())
        .get(url)
        .set("Authorization", `Bearer ${token}`);
      expect(afterEmptying.status).toBe(200);
      const body = afterEmptying.body as LeadReplyTemplatesDto;

      // ⚠️ THE ASSERTION THE WRONG RULE FAILS: the defaults would be back.
      expect(body.templates).toHaveLength(0);
      for (const channel of REPLY_CHANNELS) {
        expect(body.automaticTemplateIds[channel]).toBeNull();
      }
    });
  });

  describe("the customer's own words", () => {
    it("rewrites a default in place, and the wording is what comes back", async () => {
      const body = await read();
      const target = body.templates.find((template) => !template.isAutomatic)!;

      const response = await patch(tokens.get("owner")!, target.id, {
        name: "Our own wording",
        body: "Cheers for the message, we'll bell you back today.",
      });
      expect(response.status).toBe(200);
      expect(response.body.name).toBe("Our own wording");
      expect(response.body.body).toBe("Cheers for the message, we'll bell you back today.");

      const after = await read();
      expect(after.templates.find((t) => t.id === target.id)!.body).toBe(
        "Cheers for the message, we'll bell you back today.",
      );
    });

    it("adds one of their own, and it is NOT automatic", async () => {
      const response = await add(tokens.get("owner")!, {
        name: "Booked up this month",
        body: "Thanks for asking — we are full until October.",
      });
      expect(response.status).toBe(201);
      expect(response.body.isAutomatic).toBe(false);

      const after = await read();
      // Adding one must not have changed which reply goes out on its own.
      expect(after.automaticTemplateIds.email).not.toBe(response.body.id);
    });

    it("refuses a second template with the same name, whatever the case", async () => {
      const response = await add(tokens.get("owner")!, {
        name: "BOOKED UP THIS MONTH",
        body: "Different words, same name.",
      });
      expect(response.status).toBe(409);
      expect(response.body.message).toContain("already have");
    });

    it("refuses a blank name or a blank body", async () => {
      expect((await add(tokens.get("owner")!, { name: "   ", body: "Words." })).status).toBe(400);
      expect((await add(tokens.get("owner")!, { name: "A name", body: "   " })).status).toBe(400);
    });

    /**
     * 🚨 THROUGH `rawAdd`, NOT `add`, AND THAT IS THE ENTIRE POINT OF THIS TEST.
     * The `add` helper supplies a channel, so routing this through it would
     * assert nothing while looking correct — the exact shape of the `?module=`
     * mistake this file's helper comment records.
     *
     * Slice 3.2b: a wording with no channel must be refused rather than filed
     * under a default, because a wording saved against the wrong medium becomes
     * a candidate for Eva to SEND — an email wording going out over WhatsApp,
     * telling the reader to "reply to this email".
     */
    it("refuses a template with no channel, rather than defaulting one", async () => {
      const response = await rawAdd(tokens.get("owner")!, {
        name: "No channel named",
        body: "Words.",
      });
      expect(response.status).toBe(400);

      // ...and the same request WITH one is accepted, so the 400 is about the
      // channel and not about something else in the payload.
      const accepted = await rawAdd(tokens.get("owner")!, {
        channel: "email",
        name: "No channel named",
        body: "Words.",
      });
      expect(accepted.status).toBe(201);
    });

    /** `whatsapp` was the refused value here until 3.4a; Messenger is the next one. */
    it("refuses a channel nothing can send on", async () => {
      const response = await rawAdd(tokens.get("owner")!, {
        channel: "messenger",
        name: "Too early",
        body: "Words.",
      });
      expect(response.status).toBe(400);
    });

    /**
     * ⚠️ EVERY CHANNEL SHIPS WITH WORDINGS OR IT SHIPS SILENT (slice 3.2b).
     *
     * A channel whose default list is empty seeds nothing, so the customer
     * meets the screen's "somebody has deleted them all" empty state on a
     * medium they have never touched — and Eva answers nobody on it, because
     * there is no automatic wording to send.
     *
     * `Record<ReplyChannel, …>` makes a MISSING channel a type error. It has
     * nothing to say about an EMPTY one, which is the easy way to satisfy the
     * compiler while shipping exactly this defect.
     */
    it("every channel has default wordings, exactly one of them automatic", () => {
      for (const channel of REPLY_CHANNELS) {
        const defaults = DEFAULT_LEAD_REPLY_TEMPLATES[channel];
        expect(defaults.length, `${channel} has no default wordings`).toBeGreaterThan(0);
        expect(
          defaults.filter((template) => template.isAutomatic),
          `${channel} must have exactly one automatic wording`,
        ).toHaveLength(1);
      }
    });

    /**
     * ⚠️ AND THE WORDINGS MUST BE WRITTEN FOR THEIR OWN MEDIUM. The email
     * default says "replying to this email is the quickest way to reach us",
     * which is nonsense on WhatsApp — and copying it across is the single most
     * likely way ruling 63 gets quietly undone, because the result is
     * grammatical, sincere and wrong.
     *
     * This cannot check whether prose suits a medium. What it CAN check is that
     * no two channels ship the identical body, which is what a copy-paste
     * produces.
     */
    it("no two channels ship the same default wording", () => {
      const seen = new Map<string, string>();
      for (const channel of REPLY_CHANNELS) {
        for (const template of DEFAULT_LEAD_REPLY_TEMPLATES[channel]) {
          const owner = seen.get(template.body);
          expect(
            owner,
            `${channel} reuses ${owner}'s wording verbatim — write one for this medium`,
          ).toBeUndefined();
          seen.set(template.body, channel);
        }
      }
    });

    it("refuses a patch that changes nothing", async () => {
      const body = await read();
      expect((await patch(tokens.get("owner")!, body.templates[0]!.id, {})).status).toBe(400);
    });
  });

  describe("exactly one automatic reply (ruling 55)", () => {
    it("promoting one demotes the other, in the same request", async () => {
      const before = await read();
      const wasAutomatic = before.automaticTemplateIds.email!;
      const promote = before.templates.find((template) => !template.isAutomatic)!;

      const response = await patch(tokens.get("owner")!, promote.id, { isAutomatic: true });
      expect(response.status).toBe(200);
      expect(response.body.isAutomatic).toBe(true);

      const after = await read();
      expect(after.automaticTemplateIds.email).toBe(promote.id);
      expect(
        after.templates.filter((template) => template.channel === "email" && template.isAutomatic),
      ).toHaveLength(1);
      // The old one is still there to send by hand — demoted, not deleted.
      expect(after.templates.map((t) => t.id)).toContain(wasAutomatic);
      expect(after.templates.find((t) => t.id === wasAutomatic)!.isAutomatic).toBe(false);
    });

    /**
     * ⚠️ THE STATE THE SENDER MUST BE ABLE TO DETECT. A customer may switch the
     * automatic reply off entirely; `automaticTemplateIds.email` going null is how the
     * screen says "nobody hears back on their own" rather than guessing.
     */
    it("lets the automatic reply be switched off, and says so plainly", async () => {
      const before = await read();
      const automatic = before.automaticTemplateIds.email!;

      expect((await patch(tokens.get("owner")!, automatic, { isAutomatic: false })).status).toBe(
        200,
      );

      const after = await read();
      expect(after.automaticTemplateIds.email).toBeNull();
      expect(
        after.templates.filter((template) => template.channel === "email" && template.isAutomatic),
      ).toHaveLength(0);
      // Switching email off says nothing about WhatsApp.
      expect(after.automaticTemplateIds.whatsapp).toBe(before.automaticTemplateIds.whatsapp);

      // Put it back, so the tests below start from a normal organisation.
      expect((await patch(tokens.get("owner")!, automatic, { isAutomatic: true })).status).toBe(
        200,
      );
      expect((await read()).automaticTemplateIds.email).toBe(automatic);
    });

    /**
     * 🔑 THE TEST THE SOURCE SCAN ASKED FOR (slice 3.2b → 3.4a).
     *
     * `demoteAutomatic` filters by channel. With one channel that filter was
     * a no-op, so 3.2b guarded it by reading the service's source for the
     * word `channel,` and said: *"When a second channel exists, replace this
     * with a real test: promote on one channel, assert the other channel's
     * automatic reply survives."* This is that test, in both directions.
     *
     * ⚠️ IT IS THE CASE THAT MUST FAIL. Remove the filter and promoting a
     * WhatsApp wording silently switches OFF the email automatic reply — no
     * error, no constraint violation, one screen showing exactly what was
     * asked for, and email enquiries quietly stop being answered. The
     * database cannot catch it: the unique index refuses a SECOND automatic
     * per channel and has nothing to say about clearing one.
     */
    it("promoting a wording on one channel leaves the other channel's automatic reply alone", async () => {
      const before = await read();
      const emailAutomatic = before.automaticTemplateIds.email!;
      const whatsappAutomatic = before.automaticTemplateIds.whatsapp!;
      expect(emailAutomatic).not.toBe(whatsappAutomatic);

      // Promote a WhatsApp wording: WhatsApp's automatic changes, email's does not.
      const whatsappSpare = before.templates.find(
        (template) => template.channel === "whatsapp" && !template.isAutomatic,
      )!;
      expect(
        (await patch(tokens.get("owner")!, whatsappSpare.id, { isAutomatic: true })).status,
      ).toBe(200);
      const afterWhatsApp = await read();
      expect(afterWhatsApp.automaticTemplateIds.whatsapp).toBe(whatsappSpare.id);
      expect(afterWhatsApp.automaticTemplateIds.email).toBe(emailAutomatic);
      expect(
        afterWhatsApp.templates.filter((template) => template.isAutomatic).map((t) => t.channel),
      ).toEqual(["email", "whatsapp"]);

      // And the reverse: promote an email wording, WhatsApp's survives.
      const emailSpare = afterWhatsApp.templates.find(
        (template) => template.channel === "email" && !template.isAutomatic,
      )!;
      expect((await patch(tokens.get("owner")!, emailSpare.id, { isAutomatic: true })).status).toBe(
        200,
      );
      const afterEmail = await read();
      expect(afterEmail.automaticTemplateIds.email).toBe(emailSpare.id);
      expect(afterEmail.automaticTemplateIds.whatsapp).toBe(whatsappSpare.id);

      // Adding a new automatic wording demotes only its own channel's, too.
      const added = await add(tokens.get("owner")!, {
        channel: "whatsapp",
        name: "Booked up this month",
        body: "Thanks — we're booked up this month, but tell us the job and we'll fit you in.",
        isAutomatic: true,
      });
      expect(added.status).toBe(201);
      const afterAdd = await read();
      expect(afterAdd.automaticTemplateIds.whatsapp).toBe(added.body.id);
      expect(afterAdd.automaticTemplateIds.email).toBe(emailSpare.id);
    });
  });

  describe("the automatic reply cannot be deleted by accident", () => {
    it("refuses to delete it, and names what to do instead", async () => {
      const before = await read();
      const automatic = before.automaticTemplateIds.email!;

      const response = await remove(tokens.get("owner")!, automatic);
      expect(response.status).toBe(400);
      expect(response.body.message).toContain("automatic");

      // And it really is still there and still automatic.
      const after = await read();
      expect(after.automaticTemplateIds.email).toBe(automatic);
    });

    it("allows it once a different wording is the automatic one", async () => {
      const before = await read();
      const wasAutomatic = before.automaticTemplateIds.email!;
      const successor = before.templates.find((template) => !template.isAutomatic)!;

      expect((await patch(tokens.get("owner")!, successor.id, { isAutomatic: true })).status).toBe(
        200,
      );
      expect((await remove(tokens.get("owner")!, wasAutomatic)).status).toBe(204);

      const after = await read();
      expect(after.automaticTemplateIds.email).toBe(successor.id);
      expect(after.templates.map((t) => t.id)).not.toContain(wasAutomatic);
    });

    /**
     * ⚠️ SOFT, NOT HARD — and the database enforces it whatever this code does.
     * `REVOKE DELETE` means eva_app cannot issue a hard DELETE at all, so the
     * wording Eva sent somebody stays readable to the reply record that will
     * point at it in 3.1c-3.
     */
    it("keeps the row, so the evidence of a sent reply survives", async () => {
      const remaining = await owner.leadReplyTemplate.count({
        where: { organisationId: org.id, deletedAt: { not: null } },
      });
      expect(remaining).toBeGreaterThan(0);
    });
  });

  /**
   * ⚠️ FOUNDER RULING 2026-09-01 — *"owner only for templates"*.
   *
   * I built this on `leads:write` first, which sales and reception hold, and
   * raised the consequence: a receptionist could rewrite the message that goes
   * out unread, in the business's name, to every stranger who enquires. The
   * founder closed it to the owner alone.
   *
   * ⚠️ READING STAYS WIDE, DELIBERATELY. Sales and reception must still SEE the
   * wordings or the "send one by hand from an enquiry" half of the product
   * (3.1c-4) is shut to the people whose job it is. Owner-only is about the
   * WRITE.
   */
  describe("who may do this — owner only", () => {
    /** Every write, so a rule proved on one endpoint cannot be false on another. */
    const everyWrite = async (token: string, templateId: string) => [
      (await patch(token, templateId, { body: "Rewritten." })).status,
      (await add(token, { name: `Added ${Math.random()}`, body: "New words." })).status,
      (await remove(token, templateId)).status,
    ];

    it("lets an owner change them", async () => {
      const body = await read();
      const target = body.templates.find((template) => !template.isAutomatic)!;
      expect(
        (await patch(tokens.get("owner")!, target.id, { body: "Owner wrote this." })).status,
      ).toBe(200);
    });

    /**
     * ⚠️ THE ONE THAT MAKES "OWNER ONLY" MEAN SOMETHING. `administrator` is
     * defined as "every permission except the named exceptions", so a new key
     * is inherited by default — this passes only because the exception is
     * written down. Delete it from that filter and this goes red.
     */
    it("refuses an ADMINISTRATOR, which is what owner-only actually means", async () => {
      const body = await read(tokens.get("administrator")!);
      expect(body.templates.length).toBeGreaterThan(0);
      const target = body.templates.find((template) => !template.isAutomatic)!;
      expect(await everyWrite(tokens.get("administrator")!, target.id)).toEqual([403, 403, 403]);
    });

    it("refuses sales and reception, who answer enquiries but do not set the words", async () => {
      for (const role of ["sales", "reception"]) {
        const body = await read(tokens.get(role)!);
        expect(body.templates.length, `${role} must still be able to read`).toBeGreaterThan(0);
        const target = body.templates.find((template) => !template.isAutomatic)!;
        expect(await everyWrite(tokens.get(role)!, target.id), role).toEqual([403, 403, 403]);
      }
    });

    it("refuses finance entirely — it holds no leads permission at all", async () => {
      expect((await list(tokens.get("finance")!)).status).toBe(403);
    });

    it("lets read_only look but not touch", async () => {
      const body = await read(tokens.get("read_only")!);
      expect(body.templates.length).toBeGreaterThan(0);
      const target = body.templates.find((template) => !template.isAutomatic)!;
      expect(await everyWrite(tokens.get("read_only")!, target.id)).toEqual([403, 403, 403]);
    });

    /**
     * ⚠️ 402, NOT 403, AND THE DIFFERENCE IS THE WHOLE OF §0d. "You have not
     * bought this product" and "your role cannot" send a customer to two
     * different people, and the screen shows a different thing for each.
     */
    it("answers 402 to an organisation that has not bought the product", async () => {
      const response = await request(app.getHttpServer())
        .get(`/organisations/${unentitledOrg.id}/lead-reply-templates`)
        .set("Authorization", `Bearer ${unentitledToken}`);
      expect(response.status).toBe(402);
    });

    /** Cross-tenant is 404, never 403 (BRD 15) — never confirm a tenant exists. */
    it("is a 404 from another tenant, not a 403", async () => {
      const response = await request(app.getHttpServer())
        .get(`/organisations/${org.id}/lead-reply-templates`)
        .set("Authorization", `Bearer ${unentitledToken}`);
      expect(response.status).toBe(404);
    });
  });

  describe("the cap", () => {
    /**
     * ⚠️ PER CHANNEL (slice 3.2b), and since 3.4a there are two to count. A
     * cap across channels would let a customer's email wordings use up the
     * budget for their WhatsApp ones; the twin assertion at the end is the
     * case that must fail if the count is ever made organisation-wide.
     */
    it(`refuses the ${MAX_LEAD_REPLY_TEMPLATES + 1}th template on a channel`, async () => {
      const onEmail = (dto: LeadReplyTemplatesDto) =>
        dto.templates.filter((template) => template.channel === "email");
      const before = await read();
      for (let i = onEmail(before).length; i < MAX_LEAD_REPLY_TEMPLATES; i += 1) {
        const response = await add(tokens.get("owner")!, {
          name: `Filler ${i}`,
          body: `Filler body ${i}.`,
        });
        expect(response.status).toBe(201);
      }
      expect(onEmail(await read())).toHaveLength(MAX_LEAD_REPLY_TEMPLATES);

      const overflow = await add(tokens.get("owner")!, {
        name: "One too many",
        body: "This should not fit.",
      });
      expect(overflow.status).toBe(409);
      expect(overflow.body.message).toContain(String(MAX_LEAD_REPLY_TEMPLATES));
      expect(overflow.body.message).toContain("Email");

      // A full email list says nothing about WhatsApp's.
      const elsewhere = await add(tokens.get("owner")!, {
        channel: "whatsapp",
        name: "Still room here",
        body: "There is room on WhatsApp.",
      });
      expect(elsewhere.status).toBe(201);
    });
  });

  describe("every change is answerable for", () => {
    it("audits the seed, the edit and the deletion", async () => {
      const actions = await owner.auditLog.findMany({
        where: { organisationId: org.id, entityType: "lead_reply_template" },
        select: { action: true },
      });
      const seen = new Set(actions.map((row) => row.action));
      expect(seen).toContain("lead_reply_template.defaults_seeded");
      expect(seen).toContain("lead_reply_template.created");
      expect(seen).toContain("lead_reply_template.updated");
      expect(seen).toContain("lead_reply_template.deleted");
    });

    /**
     * ⚠️ THE BODY IS NEVER AUDITED, ON PURPOSE. An audit row is not the place
     * to keep a second copy of every wording a customer has ever typed — it
     * would turn an append-only trail into an unmanaged archive of their words.
     */
    it("records the name of a template but never its body", async () => {
      const rows = await owner.auditLog.findMany({
        where: { organisationId: org.id, entityType: "lead_reply_template" },
        select: { metadata: true },
      });
      const serialised = JSON.stringify(rows);
      expect(serialised).not.toContain("Cheers for the message");
      expect(serialised).not.toContain("we are full until October");
    });
  });
});
