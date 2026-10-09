/**
 * The hand-off, worded as not built (brief DOOR-16). agentcheck's hourly watch checks MCP servers
 * only, and nothing of ours takes a ping from a job. GitHub emails one person when a scheduled run
 * fails; nobody is told when it never runs. So every run and every page ends with the same sentence
 * and a link to the /restoreproof waitlist button, whose click is the count. No price is named
 * until one is decided and its checkout works.
 */

/** The pages, on agentcheck. */
export const PAGES_URL = "https://agentwares-agentcheck.vercel.app/restoreproof";

/** What the CLI's links put in `?ref=`, recorded through agentcheck's page-view beacon. */
export const REF = "restoreproof";

/** Where a run's hand-off line points: the landing page's watch section. */
export const HANDOFF_URL = `${PAGES_URL}?ref=${REF}#watch`;

/** The hand-off, word for word, at the end of every run and in the watch section of every page. */
export const HANDOFF_LINE =
  "An email when a weekly restore test fails or does not run is not built.";

/** What it would do, what GitHub does today, and what agentcheck's free watch covers today. */
export const HANDOFF_DETAIL =
  "It would email the people you name when a test fails, when the backup shrinks, or when no test " +
  "has run for eight days, from outside GitHub's scheduler. Today GitHub emails one person when a " +
  "scheduled run fails, and nobody when it never runs. agentcheck's free hourly watch covers MCP " +
  "servers only. If you would pay for this one, say so with one click:";
