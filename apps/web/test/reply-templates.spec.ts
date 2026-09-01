import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { MODULE_CATALOGUE, moduleHref } from "@eva/types";
import { PRODUCT_NAV } from "@/lib/navigation";

/**
 * The replies screen (slice 3.1c-1) — the first screen the lead product owns.
 *
 * ⚠️ THE FIRST TEST HERE EXISTS BECAUSE I SHIPPED THE DEFECT IT CATCHES INTO
 * MY OWN WORKING TREE. The confirm buttons for "Eva sends this one", "Turn off
 * automatic replies" and "Delete" each own a `<form>`, and I first wrote them
 * INSIDE the editor's `<form>`. HTML forbids a nested form: React renders the
 * markup happily, the browser discards the inner one, and every confirm button
 * silently becomes a submit of the enclosing SAVE form — so "Yes, delete it"
 * would have saved the template instead of deleting it.
 *
 * Typecheck passed. Lint passed. The build passed. Every test passed. **No test
 * in this repo can click**, and this is precisely the class of defect that
 * makes that sentence expensive — the same shape as #125's reminder timing,
 * which 607 green tests could not see.
 *
 * ⚠️ SO IT IS PARSED, NOT GREPPED, AND IT FOLLOWS COMPOSITION. The two forms
 * are never adjacent in the source: `ConfirmRow` renders the inner one, three
 * components render `ConfirmRow`, and `ReplyTemplateCard` renders those. A
 * scanner that only looked for `<form>` inside `<form>` in one JSX tree would
 * find nothing and pass forever.
 */

const CONTROLS = fileURLToPath(
  new URL("../src/app/app/lead-follow-up-email/replies/reply-controls.tsx", import.meta.url),
);
const ACTIONS = fileURLToPath(
  new URL("../src/app/app/lead-follow-up-email/replies/actions.ts", import.meta.url),
);
const PAGE = fileURLToPath(
  new URL("../src/app/app/lead-follow-up-email/replies/page.tsx", import.meta.url),
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

describe("the replies screen never nests a form", () => {
  it("has no form inside a form, following composition", () => {
    expect(nestedForms(readFileSync(CONTROLS, "utf8"), "reply-controls.tsx")).toEqual([]);
  });

  /**
   * ⚠️ THE CASE THAT MUST FAIL (habit 3), AND IT IS THE SHAPE I ACTUALLY WROTE
   * — the inner form reached through TWO components, not sitting next to the
   * outer one. Without this, the assertion above passes just as happily against
   * a scanner that resolves nothing and finds nothing, forever.
   */
  it("catches the nesting when it is two components deep", () => {
    const relapsed = `
      function ConfirmRow() {
        return (
          <form action={formAction}>
            <PrimarySubmit>Yes, delete it</PrimarySubmit>
          </form>
        );
      }
      function DeleteTemplate() {
        return <ConfirmRow />;
      }
      function ReplyTemplateCard() {
        return (
          <form action={save}>
            <TextField name="name" />
            <DeleteTemplate />
          </form>
        );
      }`;
    expect(nestedForms(relapsed, "relapsed.tsx")).toEqual([
      "ReplyTemplateCard renders <DeleteTemplate/>, which is a <form>, inside its own <form>",
    ]);
  });

  /** And the blunt version, in case somebody types both in one component. */
  it("catches a form written directly inside a form", () => {
    const blunt = `
      function Card() {
        return (
          <form action={save}>
            <form action={other}>
              <button type="submit">Delete</button>
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
            <form action={save}><TextField name="name" /></form>
            <div><DeleteTemplate /></div>
          </section>
        );
      }
      function DeleteTemplate() {
        return <form action={remove}><button type="submit">Delete</button></form>;
      }`;
    expect(nestedForms(fine, "fine.tsx")).toEqual([]);
  });

  /** The scan read something. A file it could not parse would pass silently. */
  it("actually found the components it is scanning", () => {
    const components = readComponents(readFileSync(CONTROLS, "utf8"), "reply-controls.tsx");
    expect(components.size).toBeGreaterThanOrEqual(6);
    for (const name of ["ReplyTemplateList", "ReplyTemplateCard", "ConfirmRow", "MakeAutomatic"]) {
      expect(components.has(name), `${name} was not found`).toBe(true);
    }
    // And the thing the guard is about is genuinely there to get wrong.
    expect(rendersFormTransitively("ConfirmRow", components)).toBe(true);
    expect(rendersFormTransitively("DeleteTemplate", components)).toBe(true);
  });
});

/**
 * ⚠️ FOUND BY WALKING, AFTER EVERY TEST IN THIS FILE PASSED.
 *
 * Four of the five server actions returned a carefully written success message
 * and **none of those four could ever reach a screen.** Promoting, turning off
 * and deleting all change what the card renders, so `revalidatePath` refreshes
 * the data and the component holding the action state unmounts — taking the
 * message with it. Adding rendered its message only in the collapsed branch,
 * which the open form was keeping shut, so pressing "Add this reply" emptied
 * both boxes and said nothing at all.
 *
 * Typecheck, lint and the whole suite were perfectly happy with copy nobody
 * could read. This is the guard that would have said so.
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
      // es2018 target the web app's tsconfig does not set — caught by
      // `typecheck`, which esbuild had happily run straight past.
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

describe("the replies screen is reachable and on the kit", () => {
  it("is in the lead product's navigation", () => {
    const items = PRODUCT_NAV.lead_follow_up_email ?? [];
    const replies = items.find((item) => item.label === "Replies");
    expect(replies).toBeDefined();
    expect(replies!.href).toBe(moduleHref("lead_follow_up_email", "replies"));
    // Built from the catalogue, so renaming the product cannot strand the link.
    expect(replies!.href).toContain(MODULE_CATALOGUE.lead_follow_up_email.slug);
  });

  /**
   * ⚠️ THE SAME RULE THE SETTINGS SCAN ENFORCES, APPLIED BEFORE THE DRIFT
   * RATHER THAN AFTER IT. Fourteen screens retype the page shell and fifteen
   * retype the title block; this one is new, so there is no excuse for it to
   * become the sixteenth. `settings-consistency.spec.tsx` was written after the
   * copies existed and could only report them.
   */
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
    const source = stripComments(readFileSync(PAGE, "utf8"));
    expect(source).not.toContain('"/app/lead-follow-up-email');
  });
});

describe("the screen does not claim to send anything yet", () => {
  /**
   * ⚠️ COPY HAS NO ASSERTIONS UNLESS SOMEBODY WRITES THEM, and this project has
   * shipped seven false sentences in one slice. Eva cannot send these replies
   * until 3.1c-3; a screen full of Save buttons implies she can, so the page
   * says so out loud. **When the reply ships, this test is what will fail** —
   * which is the point: it makes changing the sentence a deliberate act rather
   * than something nobody remembers.
   */
  it("says the sending half is still being built", () => {
    const source = stripComments(readFileSync(PAGE, "utf8"));
    expect(source).toContain("being built");
  });

  it("warns when no automatic reply is switched on", () => {
    const source = stripComments(readFileSync(PAGE, "utf8"));
    expect(source).toContain("automaticTemplateId === null");
    expect(source).toContain("nobody hears back");
  });
});

/** Prose describing a shape is not the shape — the `design-tokens` guard. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
