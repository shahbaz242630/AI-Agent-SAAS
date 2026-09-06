import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { LEAD_PLAYBOOKS_BUILT, MODULE_CATALOGUE, moduleHref, REPLY_CHANNELS } from "@eva/types";
import { PRODUCT_NAV } from "@/lib/navigation";

/**
 * The Automations screen (slice 3.5a, ruling 93) — the Replies screen of
 * 3.1c-1, reshaped into cards with switches. The guards of that screen's spec
 * are kept whole, pointed at the new files.
 *
 * ⚠️ THE FIRST TEST HERE EXISTS BECAUSE THE DEFECT IT CATCHES WAS SHIPPED
 * INTO A WORKING TREE ONCE. Each confirm control owns a `<form>`, and the first
 * Replies screen put them INSIDE the editor's `<form>`. HTML forbids a nested
 * form: React renders the markup happily, the browser discards the inner one,
 * and every confirm button silently becomes a submit of the enclosing form —
 * "Yes, clear it" would save the box instead of emptying it.
 *
 * Typecheck passed. Lint passed. The build passed. Every test passed. **No test
 * in this repo can click**, so it is parsed, not grepped, and it follows
 * composition — the inner form is reached through components, never adjacent.
 */

const CONTROLS = fileURLToPath(
  new URL("../src/app/app/lead-follow-up/automations/playbook-controls.tsx", import.meta.url),
);
const ACTIONS = fileURLToPath(
  new URL("../src/app/app/lead-follow-up/automations/actions.ts", import.meta.url),
);
const PAGE = fileURLToPath(
  new URL("../src/app/app/lead-follow-up/automations/page.tsx", import.meta.url),
);

interface ComponentFacts {
  /** Renders a `<form>` element directly in its own JSX. */
  ownsForm: boolean;
  /** Local components it renders anywhere in its JSX. */
  renders: Set<string>;
  /** Local components rendered inside one of its own `<form>` elements. */
  insideForm: Set<string>;
  /** A `<form>` element appears inside another `<form>` in this same tree. */
  selfNested: boolean;
}

/**
 * What each component in a file renders, and what it renders inside a `<form>`.
 *
 * A JSX tag starting with a capital letter is a component reference; a
 * lowercase one is an HTML element. That is a language rule, not a convention,
 * so it can be relied on.
 */
function readComponents(source: string, fileName: string): Map<string, ComponentFacts> {
  const tree = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const components = new Map<string, ComponentFacts>();

  const tagNameOf = (node: ts.Node): string | null => {
    if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
    if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
    return null;
  };

  const visitComponent = (name: string, body: ts.Node) => {
    const facts: ComponentFacts = {
      ownsForm: false,
      renders: new Set(),
      insideForm: new Set(),
      selfNested: false,
    };

    const walk = (node: ts.Node, formDepth: number) => {
      const tag = tagNameOf(node);
      let nextDepth = formDepth;
      if (tag !== null) {
        if (tag === "form") {
          facts.ownsForm = true;
          if (formDepth > 0) facts.selfNested = true;
          nextDepth = formDepth + 1;
        } else if (/^[A-Z]/.test(tag)) {
          facts.renders.add(tag);
          if (formDepth > 0) facts.insideForm.add(tag);
        }
      }
      ts.forEachChild(node, (child) => walk(child, nextDepth));
    };

    walk(body, 0);
    components.set(name, facts);
  };

  const collect = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      visitComponent(node.name.text, node.body);
    }
    ts.forEachChild(node, collect);
  };
  collect(tree);

  return components;
}

/** Whether a component renders a `<form>` itself or through anything it uses. */
function rendersFormTransitively(
  name: string,
  components: Map<string, ComponentFacts>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const facts = components.get(name);
  if (!facts) return false;
  if (facts.ownsForm) return true;
  return [...facts.renders].some((child) => rendersFormTransitively(child, components, seen));
}

/** Every nesting this file would produce in a browser, named by where it is. */
function nestedForms(source: string, fileName: string): string[] {
  const components = readComponents(source, fileName);
  const violations: string[] = [];
  for (const [name, facts] of components) {
    if (facts.selfNested) violations.push(`${name} puts a <form> directly inside a <form>`);
    for (const child of facts.insideForm) {
      // A component's own name inside itself is recursion, not nesting.
      if (child === name) continue;
      if (rendersFormTransitively(child, components)) {
        violations.push(`${name} renders <${child}/>, which is a <form>, inside its own <form>`);
      }
    }
  }
  return violations.sort();
}

describe("the automations screen never nests a form", () => {
  it("has no form inside a form, following composition", () => {
    expect(nestedForms(readFileSync(CONTROLS, "utf8"), "playbook-controls.tsx")).toEqual([]);
  });

  /**
   * ⚠️ THE CASE THAT MUST FAIL (habit 3), AND IT IS THE SHAPE THAT WAS ACTUALLY
   * WRITTEN ONCE — the inner form reached through TWO components, not sitting
   * next to the outer one. Without this, the assertion above passes just as
   * happily against a scanner that resolves nothing and finds nothing, forever.
   */
  it("catches the nesting when it is two components deep", () => {
    const relapsed = `
      function ConfirmRow() {
        return (
          <form action={formAction}>
            <PrimarySubmit>Yes, clear it</PrimarySubmit>
          </form>
        );
      }
      function ClearWording() {
        return <ConfirmRow />;
      }
      function WordingBox() {
        return (
          <form action={save}>
            <TextArea name="body" />
            <ClearWording />
          </form>
        );
      }`;
    expect(nestedForms(relapsed, "relapsed.tsx")).toEqual([
      "WordingBox renders <ClearWording/>, which is a <form>, inside its own <form>",
    ]);
  });

  /** And the blunt version, in case somebody types both in one component. */
  it("catches a form written directly inside a form", () => {
    const blunt = `
      function Card() {
        return (
          <form action={save}>
            <form action={other}>
              <button type="submit">Clear</button>
            </form>
          </form>
        );
      }`;
    expect(nestedForms(blunt, "blunt.tsx")).toContain(
      "Card puts a <form> directly inside a <form>",
    );
  });

  /**
   * ⚠️ AND IT MUST NOT FLAG THE CORRECT SHAPE. A scanner that called everything
   * a violation would also make the first assertion impossible to satisfy, and
   * the fix would be to delete the test.
   */
  it("does not flag sibling forms in the same component", () => {
    const fine = `
      function Card() {
        return (
          <section>
            <form action={save}><TextArea name="body" /></form>
            <div><ClearWording /></div>
          </section>
        );
      }
      function ClearWording() {
        return <form action={clear}><button type="submit">Clear</button></form>;
      }`;
    expect(nestedForms(fine, "fine.tsx")).toEqual([]);
  });

  /** The scan read something. A file it could not parse would pass silently. */
  it("actually found the components it is scanning", () => {
    const components = readComponents(readFileSync(CONTROLS, "utf8"), "playbook-controls.tsx");
    expect(components.size).toBeGreaterThanOrEqual(4);
    for (const name of ["PlaybookCard", "SwitchControl", "WordingBox", "ClearWording"]) {
      expect(components.has(name), `${name} was not found`).toBe(true);
    }
    // And the thing the guard is about is genuinely there to get wrong.
    expect(rendersFormTransitively("ClearWording", components)).toBe(true);
    expect(rendersFormTransitively("WordingBox", components)).toBe(true);
    expect(rendersFormTransitively("SwitchControl", components)).toBe(true);
  });
});

/**
 * ⚠️ FOUND BY WALKING THE REPLIES SCREEN, AFTER EVERY TEST PASSED (2026-09-01).
 *
 * Four of its five server actions returned a carefully written success message
 * and **none of those four could ever reach a screen** — each changed what the
 * card rendered, `revalidatePath` refreshed the data, and the component holding
 * the action state unmounted, taking the message with it. This is the guard
 * that would have said so, kept for the three actions here.
 */
describe("no action promises a message the screen cannot show", () => {
  /** Exported actions whose success path returns a message to render. */
  function actionsReturningSuccess(source: string): string[] {
    const found: string[] = [];
    for (const match of source.matchAll(/export async function (\w+)\(/g)) {
      const name = match[1]!;
      const start = match.index!;
      const nextExport = source.indexOf("\nexport ", start + 1);
      const body = source.slice(start, nextExport === -1 ? undefined : nextExport);
      // No `s` flag: `[^}]` already matches newlines, and the flag needs an
      // es2018 target the web app's tsconfig does not set.
      if (/return\s*\{[^}]*success:/.test(body)) found.push(name);
    }
    return found.sort();
  }

  /** Components that render `state.success`, and the actions they are wired to. */
  function componentsRenderingSuccess(source: string): Set<string> {
    const wired = new Set<string>();
    for (const match of source.matchAll(/useActionState<[^>]*>\(\s*(\w+)\s*,[\s\S]{0,200}?\)/g)) {
      const action = match[1]!;
      // The component body runs from this hook to the next function declaration.
      const start = match.index!;
      const nextFn = source.indexOf("\nfunction ", start);
      const body = source.slice(start, nextFn === -1 ? undefined : nextFn);
      if (body.includes("state.success")) wired.add(action);
    }
    return wired;
  }

  it("every success message is rendered somewhere", () => {
    const actions = actionsReturningSuccess(readFileSync(ACTIONS, "utf8"));
    const rendered = componentsRenderingSuccess(readFileSync(CONTROLS, "utf8"));

    expect(actions.length, "no actions found — the scanner is broken").toBeGreaterThan(0);
    const unreachable = actions.filter((action) => !rendered.has(action));
    expect(unreachable, "these return a success message nothing displays").toEqual([]);
  });

  /**
   * ⚠️ THE CASE THAT MUST FAIL. Without it the assertion above passes just as
   * happily against a scanner that finds nothing in either file.
   */
  it("catches an action whose message is never displayed", () => {
    const actions = `
      export async function saveThing(a, b) {
        return { success: "Saved." };
      }
      export async function deleteThing(a, b) {
        return { success: "Deleted." };
      }`;
    const controls = `
      function ThingCard() {
        const [state, formAction, pending] = useActionState<S, FormData>(saveThing, {});
        return <p>{state.success}</p>;
      }
      function DeleteThing() {
        const [state, formAction, pending] = useActionState<S, FormData>(deleteThing, {});
        return <p>{state.error}</p>;
      }`;
    const unreachable = actionsReturningSuccess(actions).filter(
      (a) => !componentsRenderingSuccess(controls).has(a),
    );
    expect(unreachable).toEqual(["deleteThing"]);
  });
});

describe("the automations screen is reachable and on the kit", () => {
  it("is in the lead product's navigation, under a word a plumber says", () => {
    const items = PRODUCT_NAV.lead_follow_up ?? [];
    const item = items.find((entry) => entry.label === "Automations");
    expect(item).toBeDefined();
    expect(item!.href).toBe(moduleHref("lead_follow_up", "automations"));
    // Built from the catalogue, so renaming the product cannot strand the link.
    expect(item!.href).toContain(MODULE_CATALOGUE.lead_follow_up.slug);
    // The old label is gone, not doubled.
    expect(items.find((entry) => entry.label === "Replies")).toBeUndefined();
  });

  it("uses the kit rather than retyping the frame", () => {
    const source = stripComments(readFileSync(PAGE, "utf8"));
    expect(source).toContain("PageShell");
    expect(source).toContain("PageHeader");
    expect(source).not.toMatch(/max-w-\[1080px\]/);
    expect(source).not.toMatch(/font-display text-\[29px\]/);
    // The wrong-shaped primary the five settings screens shared.
    expect(source).not.toMatch(/rounded-\[var\(--radius-card\)\] bg-primary/);
  });

  it("builds its links rather than writing them out", () => {
    for (const file of [PAGE, CONTROLS, ACTIONS]) {
      expect(stripComments(readFileSync(file, "utf8"))).not.toContain('"/app/lead-follow-up');
    }
  });
});

describe("the screen says what Eva does, and each claim is checked", () => {
  /**
   * 🚨 THE REPLIES SCREEN'S GUARD USED TO POINT THE WRONG WAY, AND THE SCREEN
   * WENT FALSE ON PRODUCTION BECAUSE OF IT. Asserting a sentence EXISTS fires
   * when somebody deletes it, never when it stops being true. Each half of the
   * notice is checked against what is built.
   */
  it("says Eva sends the instant reply on her own and the out-of-hours reply when closed, because she does", () => {
    const source = stripComments(readFileSync(PAGE, "utf8"));
    expect(source).toMatch(/Eva sends the instant reply the moment an enquiry arrives/);
    expect(source).toMatch(/When you are closed, the\s+out-of-hours reply goes instead/);
    expect(source).toMatch(/Nothing else sends until you switch it on/);
    // The old claims. Their return is a regression.
    expect(source).not.toMatch(/marked automatic/);
    expect(source).not.toMatch(/next thing being built/);
    expect(source).not.toMatch(/kept for when Eva can choose/i);
  });

  /**
   * ⚠️ SEND-BY-HAND IS DROPPED (ruling 89) AND STAYS DROPPED (ruling 93). If
   * it is ever built, this is the test that fails, and the fix is to write the
   * true sentence, not to delete the guard.
   */
  it("promises no send-by-hand, because none exists", () => {
    for (const file of [PAGE, CONTROLS, ACTIONS]) {
      expect(stripComments(readFileSync(file, "utf8"))).not.toMatch(/by hand/i);
    }
  });

  /**
   * ⚠️ AND WARNS ONLY FOR A CHANNEL THAT CAN SEND — ruling 89's rule, kept:
   * every channel has boxes from first sight, so "nobody hears back" is only
   * true and fixable here for a channel that is connected.
   */
  it("warns when the instant reply is on but a connected channel's box is empty", () => {
    const source = stripComments(readFileSync(PAGE, "utf8"));
    expect(source).toContain("silentChannels(data.playbooks, data.sendsFrom)");
    expect(source).toContain("nobody hears back");
    expect(source).toContain("instantReplyOff(data.playbooks)");
  });

  it("draws a box per channel on every card, so a second channel cannot vanish into one list", () => {
    const source = stripComments(readFileSync(CONTROLS, "utf8"));
    expect(source).toContain("REPLY_CHANNELS.map(");
    expect(source).toContain("REPLY_CHANNEL_LABELS[channel]");
  });
});

/**
 * 🚨 TWO TRIPWIRES. Adding a channel, or adding a card, is a deliberate act
 * with a walk — not a key appearing on a screen that promises what nothing yet
 * does. When either fires, the fix is not to change the list: walk the screen
 * with the new channel connected or the new card running, THEN update it.
 */
describe("adding a channel or a card is a deliberate act, not a silent one", () => {
  it("fails when REPLY_CHANNELS grows, so the screen is re-walked", () => {
    expect(
      REPLY_CHANNELS,
      "a channel was added — walk the Automations screen with all of them connected before updating this",
    ).toEqual(["email", "whatsapp"]);
  });

  it("fails when a card is built, so the screen is re-walked with it running", () => {
    expect(
      LEAD_PLAYBOOKS_BUILT,
      "a card was built — walk the Automations screen with it switched on before updating this",
    ).toEqual(["instant_reply", "after_hours"]);
  });
});

/** Prose describing a shape is not the shape — the `design-tokens` guard. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
