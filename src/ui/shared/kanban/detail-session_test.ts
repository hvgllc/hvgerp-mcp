import { assertEquals, assertNotEquals } from "@std/assert";
import {
  createDetailSessionTracker,
  sameDetailSession,
  settleDetailOperation,
  updateDetailDraft,
} from "./detail-session.ts";
import { createKanbanInitialState, kanbanStateReducer } from "./state.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

Deno.test("detail draft preserves reverting a field while an earlier value is being saved", () => {
  const draft = { subject: "Sent value", description: "Other edit" };
  assertEquals(
    updateDetailDraft(draft, "subject", "Original", "Original", true),
    {
      subject: "Original",
      description: "Other edit",
    },
  );
  assertEquals(
    updateDetailDraft(draft, "subject", "Original", "Original", false),
    {
      description: "Other edit",
    },
  );
  assertEquals(draft, { subject: "Sent value", description: "Other edit" });
});

Deno.test("detail session changes on close and reopening the same document", () => {
  const sessions = createDetailSessionTracker();
  const first = sessions.open("Task", "A");
  assertEquals(sessions.isCurrent(first), true);
  sessions.close();
  assertEquals(sessions.isCurrent(first), false);
  const reopened = sessions.open("Task", "A");
  assertEquals(reopened.generation, first.generation + 2);
  assertEquals(sameDetailSession(reopened, first), false);
  assertEquals(
    sameDetailSession({ ...reopened, doctype: "Issue" }, reopened),
    false,
  );
  assertEquals(
    sameDetailSession({ ...reopened, cardId: "B" }, reopened),
    false,
  );
});

for (const operation of ["read", "save", "assign", "unassign"] as const) {
  for (const outcome of ["success", "error"] as const) {
    for (
      const destination of ["B", "reopened-A", "Issue-A", "closed"] as const
    ) {
      Deno.test(`detail ${operation} ${outcome} cannot change ${destination} session`, async () => {
        const sessions = createDetailSessionTracker();
        const first = sessions.open("Task", "A");
        let state = kanbanStateReducer(createKanbanInitialState(), {
          type: "select-card",
          session: first,
        });
        const pending = deferred<Record<string, unknown>>();
        let successfulMutations = 0;
        let draft = "A draft";
        let message = "";
        let busy = true;
        const completion = settleDetailOperation({
          request: async () => {
            try {
              const doc = await pending.promise;
              if (operation !== "read") ++successfulMutations;
              state = kanbanStateReducer(state, {
                type: "hydrate-detail",
                session: first,
                detail: doc,
              });
              return doc;
            } catch (error) {
              state = kanbanStateReducer(state, {
                type: "detail-error",
                session: first,
                message: "A error",
              });
              throw error;
            }
          },
          isCurrent: () => sessions.isCurrent(first),
          onSuccess: () => {
            draft = "";
            message = "A saved";
          },
          onError: () => {
            message = "A failed";
          },
          onSettled: () => {
            busy = false;
          },
        });
        sessions.close();
        state = kanbanStateReducer(state, { type: "close-detail" });
        if (destination !== "closed") {
          const next = sessions.open(
            destination === "Issue-A" ? "Issue" : "Task",
            destination === "B" ? "B" : "A",
          );
          state = kanbanStateReducer(state, {
            type: "select-card",
            session: next,
          });
          assertNotEquals(first.generation, next.generation);
        }
        draft = "New draft";
        message = "New message";
        busy = true;
        const before = structuredClone(state);
        if (outcome === "success") {
          pending.resolve({ name: "A", subject: "Updated A" });
        } else pending.reject(new Error("A error"));
        await completion;
        assertEquals(state, before);
        assertEquals(draft, "New draft");
        assertEquals(message, "New message");
        assertEquals(busy, true);
        assertEquals(
          successfulMutations,
          outcome === "success" && operation !== "read" ? 1 : 0,
        );
      });
    }
  }
}

for (const outcome of ["success", "error"] as const) {
  Deno.test(`detail save ${outcome} preserves edits made while saving and clears own loading`, async () => {
    const sessions = createDetailSessionTracker();
    const session = sessions.open("Task", "A");
    const pending = deferred<void>();
    let revision = 1;
    const capturedRevision = revision;
    let draft = "Sent draft";
    let message: string | null = null;
    let saving = true;
    const completion = settleDetailOperation({
      request: () => pending.promise,
      isCurrent: () => sessions.isCurrent(session),
      canApplyResult: () => revision === capturedRevision,
      onSuccess: () => {
        draft = "";
        message = "Saved";
      },
      onError: () => {
        message = "Failed";
      },
      onSettled: () => {
        saving = false;
      },
    });
    ++revision;
    draft = "New unsaved draft";
    if (outcome === "success") pending.resolve();
    else pending.reject(new Error("Save failed"));
    await completion;
    assertEquals(draft, "New unsaved draft");
    assertEquals(message, null);
    assertEquals(saving, false);
  });
}

for (const outcome of ["success", "error"] as const) {
  Deno.test(`current detail operation applies ${outcome} and settles loading`, async () => {
    const sessions = createDetailSessionTracker();
    const session = sessions.open("Task", "A");
    const calls: string[] = [];
    await settleDetailOperation({
      request: async () => {
        if (outcome === "error") throw new Error("Current failure");
        return { saved: true };
      },
      isCurrent: () => sessions.isCurrent(session),
      onSuccess: (value) => {
        assertEquals(value.saved, true);
        calls.push("success");
      },
      onError: (error) => {
        assertEquals((error as Error).message, "Current failure");
        calls.push("error");
      },
      onSettled: () => {
        calls.push("settled");
      },
    });
    assertEquals(calls, [outcome, "settled"]);
  });
}
