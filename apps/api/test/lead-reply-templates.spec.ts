import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import { MAX_LEAD_REPLY_TEMPLATES, type LeadReplyTemplatesDto } from "@eva/types";
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

  const add = (token: string, body: Record<string, unknown>) =>
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
    it("creates them on the very first read, with exactly one automatic", async () => {
      const body = await read();

      expect(body.templates).toHaveLength(DEFAULT_LEAD_REPLY_TEMPLATES.length);
      expect(body.templates.filter((template) => template.isAutomatic)).toHaveLength(1);
      expect(body.automaticTemplateId).not.toBeNull();

      // The automatic one comes first — it is what somebody came to check.
      expect(body.templates[0]!.isAutomatic).toBe(true);
      expect(body.templates[0]!.id).toBe(body.automaticTemplateId);
    });

    /**
     * ⚠️ THE DEFAULTS MUST NOT CONTAIN A PLACEHOLDER. There is no substitution
     * in the send path until 3.1c-3, so a `{{name}}` shipped here would be sent
     * to a real enquirer verbatim. This is a copy rule with no other guard —
     * exactly the class of thing that shipped seven false sentences in #109.
     */
    it("ships no placeholder tokens in the default wordings", () => {
      for (const template of DEFAULT_LEAD_REPLY_TEMPLATES) {
        expect(template.body, `${template.name} carries a placeholder`).not.toMatch(
          /\{\{|\}\}|\$\{|%\w+%/,
        );
      }
    });

    it("marks exactly one default as automatic", () => {
      const automatic = DEFAULT_LEAD_REPLY_TEMPLATES.filter((t) => t.isAutomatic);
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
      expect(templates).toHaveLength(DEFAULT_LEAD_REPLY_TEMPLATES.length);

      // The automatic one cannot be deleted while it is automatic, so it is
      // switched off first — which is exactly the route a customer would take.
      const automatic = templates.find((template) => template.isAutomatic)!;
      expect(
        (
          await request(app.getHttpServer())
            .patch(`${url}/${automatic.id}`)
            .set("Authorization", `Bearer ${token}`)
            .send({ isAutomatic: false })
        ).status,
      ).toBe(200);

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

      // ⚠️ THE ASSERTION THE WRONG RULE FAILS: three templates would be back.
      expect(body.templates).toHaveLength(0);
      expect(body.automaticTemplateId).toBeNull();
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
      expect(after.automaticTemplateId).not.toBe(response.body.id);
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

    it("refuses a patch that changes nothing", async () => {
      const body = await read();
      expect((await patch(tokens.get("owner")!, body.templates[0]!.id, {})).status).toBe(400);
    });
  });

  describe("exactly one automatic reply (ruling 55)", () => {
    it("promoting one demotes the other, in the same request", async () => {
      const before = await read();
      const wasAutomatic = before.automaticTemplateId!;
      const promote = before.templates.find((template) => !template.isAutomatic)!;

      const response = await patch(tokens.get("owner")!, promote.id, { isAutomatic: true });
      expect(response.status).toBe(200);
      expect(response.body.isAutomatic).toBe(true);

      const after = await read();
      expect(after.automaticTemplateId).toBe(promote.id);
      expect(after.templates.filter((template) => template.isAutomatic)).toHaveLength(1);
      // The old one is still there to send by hand — demoted, not deleted.
      expect(after.templates.map((t) => t.id)).toContain(wasAutomatic);
      expect(after.templates.find((t) => t.id === wasAutomatic)!.isAutomatic).toBe(false);
    });

    /**
     * ⚠️ THE STATE THE SENDER MUST BE ABLE TO DETECT. A customer may switch the
     * automatic reply off entirely; `automaticTemplateId` going null is how the
     * screen says "nobody hears back on their own" rather than guessing.
     */
    it("lets the automatic reply be switched off, and says so plainly", async () => {
      const before = await read();
      const automatic = before.automaticTemplateId!;

      expect((await patch(tokens.get("owner")!, automatic, { isAutomatic: false })).status).toBe(
        200,
      );

      const after = await read();
      expect(after.automaticTemplateId).toBeNull();
      expect(after.templates.filter((template) => template.isAutomatic)).toHaveLength(0);

      // Put it back, so the tests below start from a normal organisation.
      expect((await patch(tokens.get("owner")!, automatic, { isAutomatic: true })).status).toBe(
        200,
      );
      expect((await read()).automaticTemplateId).toBe(automatic);
    });
  });

  describe("the automatic reply cannot be deleted by accident", () => {
    it("refuses to delete it, and names what to do instead", async () => {
      const before = await read();
      const automatic = before.automaticTemplateId!;

      const response = await remove(tokens.get("owner")!, automatic);
      expect(response.status).toBe(400);
      expect(response.body.message).toContain("automatic");

      // And it really is still there and still automatic.
      const after = await read();
      expect(after.automaticTemplateId).toBe(automatic);
    });

    it("allows it once a different wording is the automatic one", async () => {
      const before = await read();
      const wasAutomatic = before.automaticTemplateId!;
      const successor = before.templates.find((template) => !template.isAutomatic)!;

      expect((await patch(tokens.get("owner")!, successor.id, { isAutomatic: true })).status).toBe(
        200,
      );
      expect((await remove(tokens.get("owner")!, wasAutomatic)).status).toBe(204);

      const after = await read();
      expect(after.automaticTemplateId).toBe(successor.id);
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
    it(`refuses the ${MAX_LEAD_REPLY_TEMPLATES + 1}th template`, async () => {
      const before = await read();
      for (let i = before.templates.length; i < MAX_LEAD_REPLY_TEMPLATES; i += 1) {
        const response = await add(tokens.get("owner")!, {
          name: `Filler ${i}`,
          body: `Filler body ${i}.`,
        });
        expect(response.status).toBe(201);
      }
      expect((await read()).templates).toHaveLength(MAX_LEAD_REPLY_TEMPLATES);

      const overflow = await add(tokens.get("owner")!, {
        name: "One too many",
        body: "This should not fit.",
      });
      expect(overflow.status).toBe(409);
      expect(overflow.body.message).toContain(String(MAX_LEAD_REPLY_TEMPLATES));
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
