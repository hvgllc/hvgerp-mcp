import { assert, assertEquals, assertRejects } from "@std/assert";
import { AmbiguousLinkError } from "../api/resolve.ts";
import {
  linkDisambiguationRequestKey,
  runWithLinkDisambiguation,
} from "./link-disambiguation.ts";
import type { ToolHandlerContext } from "@casys/mcp-server";

const inputPath = "customer";
const requestKey = linkDisambiguationRequestKey(inputPath);
const candidates = [
  { id: "CUST-001", label: "Acme" },
  { id: "CUST-002", label: "Acme" },
];

function ambiguity(path: string | undefined = inputPath): AmbiguousLinkError {
  return new AmbiguousLinkError({
    message: "the original ambiguity",
    doctype: "Customer",
    identifier: "Acme",
    inputPath: path,
    candidates,
    truncated: true,
  });
}

function elicitationContext(
  overrides: Partial<ToolHandlerContext> = {},
): ToolHandlerContext {
  return {
    toolName: "erpnext_customer_create",
    clientCapabilities: { elicitation: {} },
    ...overrides,
  };
}

Deno.test("link disambiguation - falls back by rethrowing the original ambiguity", async () => {
  const original = ambiguity();

  try {
    await runWithLinkDisambiguation({
      args: { customer: "Acme" },
      enabled: false,
      context: elicitationContext(),
      execute: () => Promise.reject(original),
    });
    throw new Error("expected ambiguity to be thrown");
  } catch (error) {
    assert(error === original, "must rethrow the exact original error");
  }

  const noPath = new AmbiguousLinkError({
    message: "no input path",
    doctype: "Customer",
    identifier: "Acme",
    candidates,
    truncated: false,
  });
  await assertRejects(
    () =>
      runWithLinkDisambiguation({
        args: { customer: "Acme" },
        enabled: true,
        context: elicitationContext(),
        execute: () => Promise.reject(noPath),
      }),
    AmbiguousLinkError,
  );
  await assertRejects(
    () =>
      runWithLinkDisambiguation({
        args: { customer: "Acme" },
        enabled: true,
        execute: () => Promise.reject(original),
      }),
    AmbiguousLinkError,
  );
});

Deno.test("link disambiguation - returns a deterministic MRTR form initially", async () => {
  const result = await runWithLinkDisambiguation({
    args: { customer: "Acme" },
    enabled: true,
    context: elicitationContext(),
    execute: () => Promise.reject(ambiguity()),
  });

  assertEquals(result.args, { customer: "Acme" });
  assertEquals(result.result, {
    resultType: "input_required",
    inputRequests: {
      [requestKey]: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message:
            'Multiple Customer records match "Acme". Choose the record ID to use: ' +
            "CUST-001 (Acme), CUST-002 (Acme). More matching records may exist.",
          requestedSchema: {
            type: "object",
            properties: {
              recordId: {
                type: "string",
                enum: ["CUST-001", "CUST-002"],
              },
            },
            required: ["recordId"],
            additionalProperties: false,
          },
        },
      },
    },
  });
});

Deno.test("link disambiguation - verified acceptance re-runs with the selected ID", async () => {
  const calls: Record<string, unknown>[] = [];
  const result = await runWithLinkDisambiguation({
    args: { customer: "Acme", status: "Draft" },
    enabled: true,
    context: elicitationContext({
      inputResponses: {
        [requestKey]: { action: "accept", content: { recordId: "CUST-002" } },
      },
      retryVerified: true,
    }),
    execute: async (args) => {
      calls.push(args);
      if (args.customer === "Acme") throw ambiguity();
      return { customer: args.customer };
    },
  });

  assertEquals(calls, [
    { customer: "Acme", status: "Draft" },
    { customer: "CUST-002", status: "Draft" },
  ]);
  assertEquals(result.args, { customer: "CUST-002", status: "Draft" });
  assertEquals(result.result, { customer: "CUST-002" });
});

for (
  const [name, response, retryVerified] of [
    [
      "unverified",
      { action: "accept", content: { recordId: "CUST-001" } },
      false,
    ],
    [
      "unknown ID",
      { action: "accept", content: { recordId: "CUST-404" } },
      true,
    ],
    ["cancel", { action: "cancel" }, true],
    ["decline", { action: "decline" }, true],
    ["invalid", { action: "accept", content: { recordId: 42 } }, true],
  ] as const
) {
  Deno.test(`link disambiguation - ${name} response cannot reach a mutation`, async () => {
    let mutations = 0;
    await assertRejects(
      () =>
        runWithLinkDisambiguation({
          args: { customer: "Acme" },
          enabled: true,
          context: elicitationContext({
            inputResponses: { [requestKey]: response },
            retryVerified,
          }),
          execute: async (args) => {
            if (args.customer === "Acme") throw ambiguity();
            mutations++;
            return { name: "MUTATION" };
          },
        }),
      Error,
    );
    assertEquals(mutations, 0);
  });
}

// -- array fields -------------------------------------------------------------

const assignPath = "assign_to";
const assignKey = linkDisambiguationRequestKey(assignPath);

/** An ambiguity on one entry of an array-valued field, the way `assign_to` raises it. */
function assigneeAmbiguity(): AmbiguousLinkError {
  return new AmbiguousLinkError({
    message: "the original ambiguity",
    doctype: "User",
    identifier: "Anh Le",
    inputPath: assignPath,
    candidates: [
      { id: "anh.le@havigroup.com", label: "Anh Le" },
      { id: "anh.le2@havigroup.com", label: "Anh Le" },
    ],
    truncated: false,
  });
}

Deno.test("link disambiguation - keeps the other assignees in an array field", async () => {
  const calls: Record<string, unknown>[] = [];
  const result = await runWithLinkDisambiguation({
    args: { assign_to: ["Anh Le", "khoa.do@havigroup.com"], name: "TASK-001" },
    enabled: true,
    context: elicitationContext({
      toolName: "erpnext_task_update",
      inputResponses: {
        [assignKey]: {
          action: "accept",
          content: { recordId: "anh.le@havigroup.com" },
        },
      },
      retryVerified: true,
    }),
    execute: async (args) => {
      calls.push(args);
      const assignees = args.assign_to as unknown[];
      if (assignees.includes("Anh Le")) throw assigneeAmbiguity();
      return { assigned: assignees };
    },
  });

  assertEquals(
    calls[1].assign_to,
    ["anh.le@havigroup.com", "khoa.do@havigroup.com"],
    "replacing the whole field with the selected scalar drops every other assignee, and the " +
      "write then succeeds with one person missing - no error for anyone to notice",
  );
  assertEquals(result.args.assign_to, [
    "anh.le@havigroup.com",
    "khoa.do@havigroup.com",
  ]);
});

Deno.test("link disambiguation - matches by value, not by position", async () => {
  const calls: Record<string, unknown>[] = [];
  await runWithLinkDisambiguation({
    // The assignment path trims and de-duplicates before resolving, so "Anh Le" sits at index 2
    // here but at index 1 in the list that actually raised the ambiguity. An index-based write
    // back would land on the wrong element.
    args: {
      assign_to: ["khoa.do@havigroup.com", " khoa.do@havigroup.com ", "Anh Le"],
    },
    enabled: true,
    context: elicitationContext({
      toolName: "erpnext_doc_assign",
      inputResponses: {
        [assignKey]: {
          action: "accept",
          content: { recordId: "anh.le@havigroup.com" },
        },
      },
      retryVerified: true,
    }),
    execute: async (args) => {
      calls.push(args);
      if ((args.assign_to as unknown[]).includes("Anh Le")) {
        throw assigneeAmbiguity();
      }
      return { ok: true };
    },
  });

  assertEquals(calls[1].assign_to, [
    "khoa.do@havigroup.com",
    " khoa.do@havigroup.com ",
    "anh.le@havigroup.com",
  ]);
});

Deno.test("link disambiguation - a scalar field is still a plain overwrite (control)", async () => {
  const calls: Record<string, unknown>[] = [];
  await runWithLinkDisambiguation({
    args: { customer: "Acme", status: "Draft" },
    enabled: true,
    context: elicitationContext({
      inputResponses: {
        [requestKey]: { action: "accept", content: { recordId: "CUST-002" } },
      },
      retryVerified: true,
    }),
    execute: async (args) => {
      calls.push(args);
      if (args.customer === "Acme") throw ambiguity();
      return { ok: true };
    },
  });

  assertEquals(calls[1], { customer: "CUST-002", status: "Draft" });
});

Deno.test("link disambiguation - refuses to place an ID that matches nothing", async () => {
  await assertRejects(
    () =>
      runWithLinkDisambiguation({
        args: { assign_to: ["khoa.do@havigroup.com"] },
        enabled: true,
        context: elicitationContext({
          inputResponses: {
            [assignKey]: {
              action: "accept",
              content: { recordId: "anh.le@havigroup.com" },
            },
          },
          retryVerified: true,
        }),
        execute: () => Promise.reject(assigneeAmbiguity()),
      }),
    Error,
    '"Anh Le" is not present in "assign_to"',
  );
});
