import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import { LEAD_PLAYBOOKS_BUILT, REPLY_CHANNELS, type LeadPlaybooksDto } from "@eva/types";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  type FixtureOrg,
} from "./support.js";
import { DEFAULT_LEAD_PLAYBOOK_WORDINGS } from "../src/products/lead-follow-up/playbooks/default-wordings.js";

/**
 * The cards on the Automations screen (slice 3.5a, ruling 93).
 *
 * ⚠️ THE INVARIANTS ARE THE POINT OF THIS FILE, NOT THE CRUD. Four cost
 * something real if they break:
 *
 *   1. the cards and their words seed ONCE in an organisation's life —
 *      seeding whenever a box is empty means clearing a box is an action the
 *      product quietly undoes;
 *   2. the out-of-hours card cannot be switched on without opening hours —
 *      switched on blind, it would either never fire or always fire;
 *   3. only the owner may switch or rewrite anything (ruling 2026-09-01);
 *   4. a box is addressed by card AND channel — a wording can never move
 *      between mediums.
 */
describe("Lead playbooks: the switches and their words", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let unentitledOrg: FixtureOrg;
  const tokens = new Map<string, string>();
  let unentitledToken: string;

  const ALL_CLOSED = {
    mon: null,
    tue: null,
    wed: null,
    thu: null,
    fri: null,
    sat: null,
    sun: null,
  };

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(
      owner,
      "playbooks",
      ["owner", "administrator", "sales", "read_only"],
      undefined,
      [{ moduleKey: "email_credit_controller" }, { moduleKey: "lead_follow_up" }],
    );
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }
    unentitledOrg = await createOrgWithMembers(
      owner,
      "playbooks-unentitled",
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

  const list = (token = tokens.get("owner")!, organisationId = org.id) =>
    request(app.getHttpServer())
      .get(`/organisations/${organisationId}/lead-playbooks`)
      .set("Authorization", `Bearer ${token}`);

  const read = async (token = tokens.get("owner")!): Promise<LeadPlaybooksDto> => {
    const response = await list(token);
    expect(response.status).toBe(200);
    return response.body as LeadPlaybooksDto;
  };

  const flip = (key: string, enabled: unknown, token = tokens.get("owner")!) =>
    request(app.getHttpServer())
      .patch(`/organisations/${org.id}/lead-playbooks/${key}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled });

  const write = (key: string, channel: string, body: unknown, token = tokens.get("owner")!) =>
    request(app.getHttpServer())
      .put(`/organisations/${org.id}/lead-playbooks/${key}/wordings/${channel}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body });

  const clear = (key: string, channel: string, token = tokens.get("owner")!) =>
    request(app.getHttpServer())
      .delete(`/organisations/${org.id}/lead-playbooks/${key}/wordings/${channel}`)
      .set("Authorization", `Bearer ${token}`);

  const setHours = (businessHours: unknown) =>
    request(app.getHttpServer())
      .patch(`/organisations/${org.id}/settings`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .send({ businessHours });

  describe("the cards a customer starts with", () => {
    it("seeds both cards and a wording per channel on the first read, instant reply on, out of hours off", async () => {
      const dto = await read();
      expect(dto.playbooks.map((p) => p.key)).toEqual([...LEAD_PLAYBOOKS_BUILT]);
      const instant = dto.playbooks.find((p) => p.key === "instant_reply")!;
      const afterHours = dto.playbooks.find((p) => p.key === "after_hours")!;
      expect(instant.enabled).toBe(true);
      expect(afterHours.enabled).toBe(false);
      for (const channel of REPLY_CHANNELS) {
        expect(instant.wordings[channel]?.body).toBe(
          DEFAULT_LEAD_PLAYBOOK_WORDINGS.instant_reply[channel],
        );
        expect(afterHours.wordings[channel]?.body).toBe(
          DEFAULT_LEAD_PLAYBOOK_WORDINGS.after_hours[channel],
        );
      }
      // Nothing connected, no hours: the honest state of a fresh organisation.
      expect(dto.sendsFrom).toEqual({ email: null, whatsapp: null });
      expect(dto.openingHoursSet).toBe(false);
    });

    it("seeds once — a second read creates nothing", async () => {
      const before = await owner.leadReplyTemplate.count({ where: { organisationId: org.id } });
      const switches = await owner.leadPlaybook.count({ where: { organisationId: org.id } });
      await read();
      await read(tokens.get("sales")!);
      expect(await owner.leadReplyTemplate.count({ where: { organisationId: org.id } })).toBe(
        before,
      );
      expect(await owner.leadPlaybook.count({ where: { organisationId: org.id } })).toBe(switches);
      expect(before).toBe(LEAD_PLAYBOOKS_BUILT.length * REPLY_CHANNELS.length);
      expect(switches).toBe(LEAD_PLAYBOOKS_BUILT.length);
    });

    it("says the defaults were seeded, and by which screen-opener", async () => {
      const entries = await owner.auditLog.findMany({
        where: {
          organisationId: org.id,
          action: { in: ["lead_playbook.defaults_seeded", "lead_reply_template.defaults_seeded"] },
        },
      });
      expect(entries.filter((e) => e.action === "lead_playbook.defaults_seeded")).toHaveLength(
        LEAD_PLAYBOOKS_BUILT.length,
      );
      expect(
        entries.filter((e) => e.action === "lead_reply_template.defaults_seeded"),
      ).toHaveLength(REPLY_CHANNELS.length);
      for (const entry of entries) {
        expect(entry.actorUserId).toBe(org.members.find((m) => m.roleKey === "owner")!.id);
      }
      // The rows themselves say nobody wrote them.
      const seeded = await owner.leadReplyTemplate.findMany({ where: { organisationId: org.id } });
      expect(seeded.every((row) => row.createdBy === null)).toBe(true);
    });

    it("is readable by sales, refused for a product the organisation has not bought, and 404 across tenants", async () => {
      await list(tokens.get("sales")!).expect(200);
      await list(tokens.get("read_only")!).expect(200);
      await list(unentitledToken, unentitledOrg.id).expect(402);
      await list(unentitledToken, org.id).expect(404);
    });
  });

  describe("the switch", () => {
    it("refuses to switch the out-of-hours card on until opening hours exist, then allows it", async () => {
      const refused = await flip("after_hours", true).expect(409);
      expect(refused.body.message).toContain("opening hours");
      expect((await read()).playbooks.find((p) => p.key === "after_hours")!.enabled).toBe(false);

      await setHours(ALL_CLOSED).expect(200);
      expect((await read()).openingHoursSet).toBe(true);
      const on = await flip("after_hours", true).expect(200);
      expect(on.body).toMatchObject({ key: "after_hours", enabled: true });

      const entry = await owner.auditLog.findFirst({
        where: { organisationId: org.id, action: "lead_playbook.switched_on" },
        orderBy: { createdAt: "desc" },
      });
      expect(entry?.metadata).toMatchObject({ key: "after_hours" });
    });

    it("switches the instant reply off and on again, and audits which way", async () => {
      expect((await flip("instant_reply", false).expect(200)).body.enabled).toBe(false);
      expect((await read()).playbooks.find((p) => p.key === "instant_reply")!.enabled).toBe(false);
      const off = await owner.auditLog.findFirst({
        where: { organisationId: org.id, action: "lead_playbook.switched_off" },
      });
      expect(off?.metadata).toMatchObject({ key: "instant_reply" });
      expect((await flip("instant_reply", true).expect(200)).body.enabled).toBe(true);
    });

    it("is the owner's alone", async () => {
      await flip("instant_reply", false, tokens.get("administrator")!).expect(403);
      await flip("instant_reply", false, tokens.get("sales")!).expect(403);
      expect((await read()).playbooks.find((p) => p.key === "instant_reply")!.enabled).toBe(true);
    });

    it("refuses a card nothing runs yet, and a body that is not a switch", async () => {
      // Admitted by the database, not by the api: no behaviour exists for it.
      await flip("no_reply_nudge", true).expect(400);
      await flip("owner_alert", true).expect(400);
      await flip("instant_reply", "yes").expect(400);
      await flip("instant_reply", undefined).expect(400);
    });
  });

  describe("the words in a box", () => {
    it("rewrites the seeded wording in place", async () => {
      const before = (await read()).playbooks.find((p) => p.key === "instant_reply")!.wordings
        .whatsapp!;
      const saved = await write(
        "instant_reply",
        "whatsapp",
        "Got it — back to you shortly.",
      ).expect(200);
      expect(saved.body).toMatchObject({
        id: before.id,
        channel: "whatsapp",
        body: "Got it — back to you shortly.",
      });
      // The email box is untouched: a wording is addressed by channel.
      const after = (await read()).playbooks.find((p) => p.key === "instant_reply")!;
      expect(after.wordings.email?.body).toBe(DEFAULT_LEAD_PLAYBOOK_WORDINGS.instant_reply.email);
      expect(after.wordings.whatsapp?.body).toBe("Got it — back to you shortly.");
    });

    it("empties a box, keeps the row for the record, and does not re-seed it", async () => {
      const wording = (await read()).playbooks.find((p) => p.key === "after_hours")!.wordings
        .email!;
      await clear("after_hours", "email").expect(204);
      expect((await read()).playbooks.find((p) => p.key === "after_hours")!.wordings.email).toBe(
        null,
      );
      // Soft: the row is still there, retired.
      const row = await owner.leadReplyTemplate.findUniqueOrThrow({ where: { id: wording.id } });
      expect(row.deletedAt).not.toBeNull();
      // And a further read does not bring it back (rule 1).
      await read();
      expect((await read()).playbooks.find((p) => p.key === "after_hours")!.wordings.email).toBe(
        null,
      );
      // Clearing an empty box is a 404, not a silent 204.
      await clear("after_hours", "email").expect(404);
    });

    it("fills an emptied box with a fresh row named for the card", async () => {
      const saved = await write(
        "after_hours",
        "email",
        "We are closed just now — back tomorrow.",
      ).expect(200);
      const row = await owner.leadReplyTemplate.findUniqueOrThrow({ where: { id: saved.body.id } });
      expect(row).toMatchObject({
        channel: "email",
        playbookKey: "after_hours",
        name: "Out-of-hours reply",
        deletedAt: null,
      });
      expect(row.createdBy).toBe(org.members.find((m) => m.roleKey === "owner")!.id);
    });

    it("binds an old unbound wording of the card's name rather than clashing with it", async () => {
      // A wording from before 3.5a, live, with the card's name and no card.
      await clear("instant_reply", "email").expect(204);
      const orphan = await owner.leadReplyTemplate.create({
        data: {
          organisationId: org.id,
          channel: "email",
          name: "instant reply",
          body: "An old wording of the same name.",
          playbookKey: null,
        },
      });
      const saved = await write("instant_reply", "email", "The instant reply, rewritten.").expect(
        200,
      );
      expect(saved.body.id).toBe(orphan.id);
      const row = await owner.leadReplyTemplate.findUniqueOrThrow({ where: { id: orphan.id } });
      expect(row.playbookKey).toBe("instant_reply");
      expect(row.body).toBe("The instant reply, rewritten.");
    });

    it("refuses an empty wording, a channel Eva cannot answer on, and anybody but the owner", async () => {
      await write("instant_reply", "email", "").expect(400);
      await write("instant_reply", "email", "   ").expect(400);
      await write("instant_reply", "messenger", "Hello").expect(400);
      await write("instant_reply", "email", "Hello", tokens.get("administrator")!).expect(403);
      await write("instant_reply", "email", "Hello", tokens.get("sales")!).expect(403);
      await clear("instant_reply", "email", tokens.get("sales")!).expect(403);
    });
  });
});
