/**
 * Server instructions — the text a client reads on `initialize`, before it has seen a tool.
 *
 * Kept to the handful of rules a model cannot infer from the tool list itself: that first-person
 * questions need an identity lookup first, that `me` is accepted where a name is expected, and that
 * a permission refusal is an answer rather than a bug to route around.
 *
 * The permission paragraph is built per deployment rather than written once, because the sentence
 * "every call runs under the caller's own permissions" is only true in one of the three modes. Under
 * `off` - the default whenever static ERPNext credentials are configured - every call runs under the
 * deployment's service account, and a model told otherwise reports the service account's blind spots
 * as the person's own ("you have no access to Projects" when they do).
 *
 * @module lib/erpnext/instructions
 */

import type { CallerIdentityMode } from "./auth/caller-middleware.ts";

const HEADER = `This server exposes a live ERPNext/Frappe instance (HVG Group).

WHO IS ASKING
- Whenever the request is first-person - "my tasks", "what am I working on", "my leave balance",
  "cong viec cua toi" - call \`erpnext_whoami\` BEFORE any other tool. It returns the caller's User
  id, roles and linked Employee record; no other tool can produce them.
- \`erpnext_my_work\` answers "what is on my plate" in one call and needs no arguments.
- Anywhere a tool takes an employee or user, the literal string \`me\` resolves to the caller.
- \`erpnext_whoami\` reports \`identity_mode\`. When it is \`shared-service-account\`, the profile
  belongs to a service account and NOT to the person you are talking to - say so instead of
  presenting it as theirs.`;

const PERMISSIONS: Record<CallerIdentityMode, string> = {
  required: `PERMISSIONS
- Every call runs under the caller's own ERPNext permissions. A refusal or an empty list is a real
  answer about what this person may see; report it, and do not retry the same read through a
  different tool hoping for a wider view.`,

  optional: `PERMISSIONS
- A call runs under the caller's own ERPNext permissions when the request carries their identity,
  and under a shared service account when it does not. \`erpnext_whoami\` says which happened:
  \`identity_mode: per-caller\` means refusals and empty lists describe THIS person, while
  \`shared-service-account\` means they describe the deployment's account instead - do not report
  the latter as the person's own limits. Either way a refusal is an answer, not a bug: do not retry
  the same read through a different tool hoping for a wider view.`,

  off: `PERMISSIONS
- Every call runs under one shared ERPNext service account, NOT under the person you are talking
  to. A refusal or an empty list describes that account's access, so never phrase it as "you do not
  have permission" or "you have none" - say the deployment's account could not read it. A refusal
  is still an answer: do not retry the same read through a different tool hoping for a wider view.`,
};

const WRITES = `WRITES
- Some tools change live business data, and the NAME does not say which: \`erpnext_doc_assign\`,
  \`erpnext_doc_unassign\`, \`erpnext_kanban_move_card\`, \`erpnext_file_upload\` and
  \`erpnext_method_call\` all write without a _create/_update/_submit/_cancel/_delete suffix, and
  the last of those reaches any allowlisted business method. Every writing tool carries
  \`readOnlyHint: false\` in its \`tools/list\` annotations - read that rather than the name, and
  confirm the details with the user before calling one.`;

/** Build the `initialize` instructions for a deployment running in `mode`. */
export function buildServerInstructions(mode: CallerIdentityMode): string {
  return [HEADER, PERMISSIONS[mode], WRITES].join("\n\n");
}
