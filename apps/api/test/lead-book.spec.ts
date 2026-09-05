import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import {
  LEAD_SOURCES_BY_CHANNEL,
  PIPELINE_SYSTEM_STAGE_KEYS,
  REPLY_CHANNELS,
  replyChannelForLeadSource,
} from "@eva/types";
import { ensureSystemStages } from "../src/platform/people/spine.js";
import { csvCell, stamp } from "../src/platform/leads/lead-book-csv.js";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  type FixtureOrg,
} from "./support.js";

/**
 * The enquiry book at volume (ruling 81, 2026-09-05): a page at a time, with
 * filters, a search, the counts its tabs need, and the same book as a CSV.
 *
 * ⚠️ THE FOUR READS SHARE ONE `where`, AND THESE TESTS HOLD THEM TO IT. The
 * page, the total, the tab counts and the file must all mean the same thing
 * by "the WhatsApp ones you searched for", or a customer reads "212 new" on
 * a tab and downloads 300 rows.
 */

describe("The enquiry book at volume", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let unentitledOrg: FixtureOrg;
  const tokens = new Map<string, string>();
  let unentitledToken: string;
  const ids: Record<"loft" | "boiler" | "formula", string> = { loft: "", boiler: "", formula: "" };

  const T0 = new Date("2026-09-01T08:00:00.000Z");
  const T1 = new Date("2026-09-02T09:00:00.000Z");
  const T2 = new Date("2026-09-03T10:00:00.000Z");

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(
      owner,
      "lead-book",
      ["owner", "sales", "finance"],
      "Lead Book Ltd",
      [{ moduleKey: "lead_follow_up" }],
    );
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }
    unentitledOrg = await createOrgWithMembers(
      owner,
      "lead-book-unentitled",
      ["owner"],
      undefined,
      [{ moduleKey: "email_credit_controller" }],
    );
    unentitledToken = await signToken({
      sub: unentitledOrg.members[0]!.authUserId,
      email: unentitledOrg.members[0]!.email,
    });

    const stages = await ensureSystemStages(owner, org.id);
    const base = { organisationId: org.id, pipelineStageId: stages.new };
    ids.loft = (
      await owner.lead.create({
        data: {
          ...base,
          source: "email_enquiry",
          contactName: "Tom Bright",
          contactEmail: "tom@example.com",
          enquiry: "Quote for a loft conversion, please.",
          receivedAt: T0,
        },
      })
    ).id;
    ids.boiler = (
      await owner.lead.create({
        data: {
          ...base,
          source: "whatsapp_enquiry",
          contactName: "Sarah Khan",
          contactPhone: "+971 50 000 1234",
          enquiry: "Boiler making a banging noise since last night.",
          receivedAt: T1,
          firstRespondedAt: new Date(T1.getTime() + 3_000),
        },
      })
    ).id;
    ids.formula = (
      await owner.lead.create({
        data: {
          ...base,
          source: "email_enquiry",
          contactName: "A Stranger",
          contactEmail: "stranger@example.com",
          contactPhone: "+44 7700 900123",
          enquiry: '=HYPERLINK("http://example.invalid","click")',
          status: "do_not_contact",
          receivedAt: T2,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  const list = (query: Record<string, string | number> = {}, role = "owner") =>
    request(app.getHttpServer())
      .get(`/organisations/${org.id}/leads`)
      .query(query)
      .set("Authorization", `Bearer ${tokens.get(role)!}`);

  const exportCsv = (query: Record<string, string> = {}, role = "owner") =>
    request(app.getHttpServer())
      .get(`/organisations/${org.id}/leads/export.csv`)
      .query(query)
      .set("Authorization", `Bearer ${tokens.get(role)!}`);

  const rowIds = (body: { rows: { id: string }[] }) => body.rows.map((row) => row.id);
  const stageCount = (body: { stages: { key: string | null; count: number }[] }, key: string) =>
    body.stages.find((stage) => stage.key === key)?.count;

  it("returns a page, newest first, with the total and a tab for every stage", async () => {
    const response = await list().expect(200);
    expect(rowIds(response.body)).toEqual([ids.formula, ids.boiler, ids.loft]);
    expect(response.body.totalCount).toBe(3);
    expect(response.body.stages.map((stage: { key: string }) => stage.key)).toEqual([
      ...PIPELINE_SYSTEM_STAGE_KEYS,
    ]);
    expect(stageCount(response.body, "new")).toBe(3);
    expect(stageCount(response.body, "lost")).toBe(0);
    // The row carries its stage, so the screen never has to look it up.
    expect(response.body.rows[0].stage).toEqual({ key: "new", name: "New" });
  });

  it("filters by channel, by whether Eva has answered, and by a word in the enquiry", async () => {
    expect(rowIds((await list({ channel: "whatsapp" }).expect(200)).body)).toEqual([ids.boiler]);
    expect(rowIds((await list({ channel: "email" }).expect(200)).body)).toEqual([
      ids.formula,
      ids.loft,
    ]);
    expect(rowIds((await list({ answered: "yes" }).expect(200)).body)).toEqual([ids.boiler]);
    expect(rowIds((await list({ answered: "no" }).expect(200)).body)).toEqual([
      ids.formula,
      ids.loft,
    ]);
    // Case does not matter, and the enquiry text counts as much as the name.
    expect(rowIds((await list({ search: "boiler" }).expect(200)).body)).toEqual([ids.boiler]);
    expect(rowIds((await list({ search: "tom" }).expect(200)).body)).toEqual([ids.loft]);
    expect(rowIds((await list({ search: "7700" }).expect(200)).body)).toEqual([ids.formula]);
  });

  /**
   * ⚠️ THE TABS COUNT UNDER THE OTHER FILTERS AND IGNORE THE STAGE ONE. With
   * "lost" selected, the New tab must still say three — otherwise choosing any
   * tab zeroes every other tab, and the customer cannot see where to go next.
   */
  it("counts the stage tabs under the channel and search filters, never under the stage filter", async () => {
    const lost = await list({ stage: "lost" }).expect(200);
    expect(lost.body.rows).toEqual([]);
    expect(lost.body.totalCount).toBe(0);
    expect(stageCount(lost.body, "new")).toBe(3);

    const whatsapp = await list({ stage: "lost", channel: "whatsapp" }).expect(200);
    expect(stageCount(whatsapp.body, "new")).toBe(1);
  });

  it("pages, and the total does not move with the page", async () => {
    const first = await list({ limit: 2 }).expect(200);
    expect(rowIds(first.body)).toEqual([ids.formula, ids.boiler]);
    expect(first.body.totalCount).toBe(3);
    const second = await list({ limit: 2, offset: 2 }).expect(200);
    expect(rowIds(second.body)).toEqual([ids.loft]);
    expect(second.body.totalCount).toBe(3);
  });

  it("refuses a filter it does not understand rather than showing everything", async () => {
    await list({ stage: "urgent" }).expect(400);
    await list({ channel: "carrier-pigeon" }).expect(400);
    await list({ limit: 0 }).expect(400);
    await list({ limit: 1000 }).expect(400);
    await list({ search: "   " }).expect(400);
  });

  describe("the same book as a file", () => {
    it("exports the rows the filter selects, as a CSV a spreadsheet opens cleanly", async () => {
      const response = await exportCsv({ channel: "email" }).expect(200);
      expect(response.headers["content-type"]).toMatch(/^text\/csv/);
      expect(response.headers["content-disposition"]).toMatch(
        /^attachment; filename="enquiries-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      const text = response.text;
      expect(text.startsWith("\uFEFF")).toBe(true);
      const lines = text
        .replace(/^\uFEFF/, "")
        .trimEnd()
        .split("\r\n");
      expect(lines[0]).toBe(
        '"Name","Email","Phone","Channel","What they asked","Received (Europe/London)","Answered (Europe/London)","Stage","Do not contact"',
      );
      // Two email rows, newest first; the WhatsApp one is not in this file.
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain('"A Stranger"');
      expect(lines[2]).toContain('"Tom Bright"');
      expect(text).not.toContain("Sarah Khan");
      // Stage, do-not-contact, and the received time in the organisation's zone.
      expect(lines[1]).toContain('"New","yes"');
      expect(lines[2]).toContain('"2026-09-01 09:00","","New","no"');
    });

    /**
     * ⚠️ A STRANGER'S FORMULA MUST NOT RUN ON THE CUSTOMER'S MACHINE. The
     * enquiry text is whatever they typed; `=HYPERLINK(...)` in a cell is code
     * to Excel. The apostrophe is the defence, and a phone number that merely
     * starts with a plus keeps its plus.
     */
    it("defuses a formula in an enquiry and leaves a phone number alone", async () => {
      const response = await exportCsv({ search: "stranger" }).expect(200);
      expect(response.text).toContain(`"'=HYPERLINK(""http://example.invalid"",""click"")"`);
      expect(response.text).toContain('"+44 7700 900123"');
    });

    it("is refused to a role that cannot read the book, and to an organisation without the product", async () => {
      await exportCsv({}, "finance").expect(403);
      await request(app.getHttpServer())
        .get(`/organisations/${unentitledOrg.id}/leads/export.csv`)
        .set("Authorization", `Bearer ${unentitledToken}`)
        .expect(402);
    });
  });

  describe("the pieces the file is made of", () => {
    it("quotes every cell, doubles quotes inside, and defuses only what would run", () => {
      expect(csvCell("plain")).toBe('"plain"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell("=1+1")).toBe(`"'=1+1"`);
      expect(csvCell("@import")).toBe(`"'@import"`);
      expect(csvCell("-cmd")).toBe(`"'-cmd"`);
      expect(csvCell("+44 7700 900123")).toBe('"+44 7700 900123"');
      expect(csvCell("-")).toBe(`"'-"`);
      expect(csvCell("\tx")).toBe(`"'\tx"`);
    });

    it("stamps a moment in the organisation's own zone, sortable", () => {
      expect(stamp(new Date("2026-07-01T23:30:00.000Z"), "Europe/London")).toBe("2026-07-02 00:30");
      expect(stamp(new Date("2026-07-01T23:30:00.000Z"), "Asia/Dubai")).toBe("2026-07-02 03:30");
      expect(stamp(new Date("2026-01-15T09:05:00.000Z"), "UTC")).toBe("2026-01-15 09:05");
    });
  });

  /**
   * The channel filter and the reply channel are one map read in two
   * directions; if somebody adds a source to one and not the other, this is
   * where it shows.
   */
  it("keeps the channel filter and the reply channel in step", () => {
    for (const channel of REPLY_CHANNELS) {
      expect(LEAD_SOURCES_BY_CHANNEL[channel].length).toBeGreaterThan(0);
      for (const source of LEAD_SOURCES_BY_CHANNEL[channel]) {
        expect(replyChannelForLeadSource(source)).toBe(channel);
      }
    }
  });
});
