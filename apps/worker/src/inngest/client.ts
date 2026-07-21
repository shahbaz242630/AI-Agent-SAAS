import { Inngest } from "inngest";

/**
 * Single Inngest client for the platform (BRD 9.3).
 * All durable functions are registered in src/functions and served from main.ts.
 */
export const inngest = new Inngest({ id: "eva-platform" });
