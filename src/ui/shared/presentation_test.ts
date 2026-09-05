import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  consumeViewerResult,
  getErrorPresentation,
  getInvoiceItemCode,
} from "./presentation.ts";
import type { ViewerState } from "./presentation.ts";

const initial: ViewerState<never> = {
  data: null,
  error: null,
  loading: true,
  refreshRequest: null,
};
const successResult = (payload: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
});
const kinds = ["invoice", "stock", "chart", "kpi", "funnel"] as const;
const payloads = {
  invoice: {
    data: {
      name: "INV-LOCAL",
      posting_date: "2026-09-05",
      status: "Draft",
      grand_total: 30,
      items: [{ item_code: "ITEM", qty: 2, rate: 15, amount: 30 }],
    },
  },
  stock: {
    count: 1,
    data: [{ item_code: "ITEM", warehouse: "Local", actual_qty: 12 }],
  },
  chart: {
    title: "Sales",
    labels: ["One"],
    datasets: [{ label: "Sales", values: [30] }],
  },
  kpi: { label: "Revenue", value: 1250, sparkline: [800, 900, 1250] },
  funnel: {
    title: "Sales",
    stages: [{ label: "Lead", count: 10, value: 5000, color: "#2563eb" }],
  },
};

for (const kind of kinds) {
  const payload = {
    ...payloads[kind],
    refreshRequest: { toolName: `local_${kind}`, arguments: {} },
  };
  Deno.test(`${kind} result rejects tool errors before parsing or trusting structured content`, () => {
    const state = consumeViewerResult(kind, {
      isError: true,
      structuredContent: { ...payload },
      content: [{ type: "text", text: "Local initial error" }],
    }, initial);
    assertEquals(state.data, null);
    assertEquals(state.loading, false);
    assertEquals(state.error, "Local initial error");
    assertEquals(getErrorPresentation(state), {
      blockingError: "Local initial error",
      inlineError: null,
    });
  });

  Deno.test(`${kind} result rejects malformed JSON, missing content and invalid schema`, () => {
    for (
      const result of [
        { content: [{ type: "text", text: "{broken" }] },
        {},
        successResult({ unexpected: true }),
        successResult([]),
        successResult("not a payload"),
      ]
    ) {
      const state = consumeViewerResult(kind, result, initial);
      assertEquals(state.data, null);
      assertEquals(state.loading, false);
      assert(state.error, `${kind}: malformed result must be an error`);
    }
  });

  Deno.test(`${kind} result hydrates success and keeps data and refresh request on refresh failure`, () => {
    const good = consumeViewerResult(kind, successResult(payload), initial);
    assert(good.data);
    assert(good.refreshRequest);
    assertEquals(good.error, null);
    assertEquals(good.loading, false);
    assertEquals(getErrorPresentation(good), {
      blockingError: null,
      inlineError: null,
    });
    for (
      const result of [
        {
          isError: true,
          content: [{ type: "text", text: "Local refresh error" }],
        },
        successResult({
          unexpected: true,
          refreshRequest: { toolName: "wrong", arguments: {} },
        }),
        { content: [{ type: "text", text: "{broken" }] },
      ]
    ) {
      const failed = consumeViewerResult(kind, result, good);
      assert(failed.error);
      assertStrictEquals(failed.data, good.data);
      assertStrictEquals(failed.refreshRequest, good.refreshRequest);
      assertEquals(getErrorPresentation(failed).blockingError, null);
      assertEquals(getErrorPresentation(failed).inlineError, failed.error);
      const recovered = consumeViewerResult(
        kind,
        successResult(payload),
        failed,
      );
      assertEquals(recovered.error, null);
      assertEquals(recovered.data, good.data);
    }
  });

  Deno.test(`${kind} result rejects malformed refresh metadata before replacing valid data`, () => {
    const good = consumeViewerResult(kind, successResult(payload), initial);
    for (
      const refreshRequest of [{}, { toolName: "", arguments: {} }, {
        toolName: "wrong",
        arguments: [],
      }]
    ) {
      const failed = consumeViewerResult(
        kind,
        successResult({ ...payload, refreshRequest }),
        good,
      );
      assert(failed.error);
      assertStrictEquals(failed.data, good.data);
      assertStrictEquals(failed.refreshRequest, good.refreshRequest);
    }
    const withoutRequest = { ...payload } as Record<string, unknown>;
    delete withoutRequest.refreshRequest;
    const next = consumeViewerResult(kind, successResult(withoutRequest), good);
    assertEquals(next.error, null);
    assertStrictEquals(next.refreshRequest, good.refreshRequest);
  });
}

Deno.test("viewer results preserve valid empty collections, optional fields and zero values", () => {
  const payloads = {
    invoice: {
      data: {
        name: "INV-ZERO",
        posting_date: "2026-09-05",
        status: "Draft",
        grand_total: 0,
        items: [],
      },
    },
    stock: { count: 0, data: [] },
    chart: { title: "Empty", labels: [], datasets: [] },
    kpi: { label: "Zero", value: 0 },
    funnel: { title: "Empty", stages: [] },
  };
  for (const kind of kinds) {
    const state = consumeViewerResult(
      kind,
      successResult(payloads[kind]),
      initial,
    );
    assert(state.data);
    assertEquals(state.error, null);
    assertEquals(state.loading, false);
    const empty = consumeViewerResult(kind, successResult(null), initial);
    assertEquals(empty.data, null);
    assertEquals(empty.error, null);
    assertEquals(empty.loading, false);
  }
});

Deno.test("viewer schemas reject malformed nested entries instead of crashing renderers", () => {
  const malformed = {
    invoice: {
      data: {
        name: "INV",
        posting_date: "2026-09-05",
        status: "Draft",
        grand_total: 0,
        items: [{ item_code: {}, qty: 1, rate: 1, amount: 1 }],
      },
    },
    stock: { count: 1, data: [null] },
    chart: {
      title: "Bad",
      labels: ["One"],
      datasets: [{ label: "Series", values: [{}] }],
    },
    kpi: { label: "Bad", value: 0, sparkline: [0, {}] },
    funnel: { title: "Bad", stages: [null] },
  };
  for (const kind of kinds) {
    const state = consumeViewerResult(
      kind,
      successResult(malformed[kind]),
      initial,
    );
    assertEquals(state.data, null);
    assert(state.error);
  }
});

Deno.test("viewer state starts loading and a failed refresh cannot turn valid empty data into a blocking error", () => {
  assertEquals(initial, {
    data: null,
    error: null,
    loading: true,
    refreshRequest: null,
  });
  const emptyStock = consumeViewerResult(
    "stock",
    successResult({ count: null, count_error: "Unavailable", data: [] }),
    initial,
  );
  assertEquals(emptyStock.error, null);
  const failed = consumeViewerResult("stock", { isError: true }, emptyStock);
  assertStrictEquals(failed.data, emptyStock.data);
  assertEquals(getErrorPresentation(failed), {
    blockingError: null,
    inlineError: "Tool returned an error",
  });
  assertEquals(initial.loading, true);
});

Deno.test("invoice accepts raw documents, explicit empty data and nullable optional ERP fields", () => {
  const raw = {
    ...payloads.invoice.data,
    currency: null,
    customer_name: null,
    items: null,
  };
  assertEquals(
    consumeViewerResult("invoice", successResult(raw), initial).error,
    null,
  );
  const empty = consumeViewerResult(
    "invoice",
    successResult({ data: null }),
    initial,
  );
  assertEquals(empty.data, null);
  assertEquals(empty.error, null);
});

Deno.test("chart enum fields reject arrays that stringify to a valid name", () => {
  for (
    const payload of [
      { ...payloads.chart, type: ["bar"] },
      {
        ...payloads.chart,
        datasets: [{ label: "Series", values: [1], type: ["line"] }],
      },
    ]
  ) assert(consumeViewerResult("chart", successResult(payload), initial).error);
});

for (const itemCode of [null, undefined]) {
  Deno.test(`invoice service line with ${itemCode === null ? "null" : "missing"} item code hydrates initially and on refresh`, () => {
    const item = {
      ...(itemCode === undefined ? {} : { item_code: itemCode }),
      item_name: "Consulting service",
      qty: 2,
      rate: 15,
      amount: 30,
    };
    const payload = {
      data: { ...payloads.invoice.data, items: [item] },
      refreshRequest: {
        toolName: "erpnext_sales_invoice_get",
        arguments: { name: "INV-SERVICE" },
      },
    };
    const loaded = consumeViewerResult(
      "invoice",
      successResult(payload),
      initial,
    );
    assertEquals(loaded.error, null);
    assertEquals<unknown>(loaded.data?.items?.[0], item);
    assertEquals(loaded.loading, false);
    const failed = consumeViewerResult("invoice", {
      isError: true,
      content: [{ type: "text", text: "Temporary failure" }],
    }, loaded);
    assertStrictEquals(failed.data, loaded.data);
    const refreshedItem = { ...item, qty: 3, amount: 45 };
    const refreshed = consumeViewerResult(
      "invoice",
      successResult({
        data: { ...payload.data, grand_total: 45, items: [refreshedItem] },
      }),
      failed,
    );
    assertEquals(refreshed.error, null);
    assertEquals<unknown>(refreshed.data?.items?.[0], refreshedItem);
    assertStrictEquals(refreshed.refreshRequest, loaded.refreshRequest);
  });
}

Deno.test("invoice service allowance still rejects object and array item codes without losing previous data", () => {
  const loaded = consumeViewerResult(
    "invoice",
    successResult(payloads.invoice),
    initial,
  );
  for (const item_code of [{ name: "ITEM" }, ["ITEM"]]) {
    const invalid = successResult({
      data: {
        ...payloads.invoice.data,
        items: [{ item_code, item_name: "Broken", qty: 1, rate: 1, amount: 1 }],
      },
    });
    const first = consumeViewerResult("invoice", invalid, initial);
    assert(first.error);
    assertEquals(first.data, null);
    const refreshed = consumeViewerResult("invoice", invalid, loaded);
    assert(refreshed.error);
    assertStrictEquals(refreshed.data, loaded.data);
  }
});

Deno.test("invoice detail lookup requires a nonempty item code, not a service line name", () => {
  const service = {
    item_name: "Consulting service",
    qty: 1,
    rate: 0,
    amount: 0,
  };
  for (
    const item of [service, { ...service, item_code: null }, {
      ...service,
      item_code: "",
    }, { ...service, item_code: "   " }]
  ) {
    assertEquals(getInvoiceItemCode(item), null);
  }
  assertEquals(
    getInvoiceItemCode({ ...service, item_code: "ITEM-LOCAL" }),
    "ITEM-LOCAL",
  );
});

Deno.test("chart schema accepts scatter and recursive treemap with empty generic series", () => {
  for (
    const payload of [
      {
        title: "Scatter",
        type: "scatter",
        labels: [],
        datasets: [],
        scatterData: [{ label: "Items", points: [{ x: 0, y: 0 }] }],
      },
      {
        title: "Tree",
        type: "treemap",
        labels: [],
        datasets: [],
        treeData: [{ name: "Group", children: [{ name: "Leaf", value: 0 }] }],
      },
    ]
  ) {
    assertEquals(
      consumeViewerResult("chart", successResult(payload), initial).error,
      null,
    );
  }
  for (
    const extras of [
      { scatterData: [{ label: "Items", points: [null] }] },
      { treeData: [{ name: "Group", children: [null] }] },
    ]
  ) {
    assert(
      consumeViewerResult(
        "chart",
        successResult({ title: "Bad", labels: [], datasets: [], ...extras }),
        initial,
      ).error,
    );
  }
});

Deno.test("viewer presentation - an error with no data blocks the whole view", () => {
  assertEquals(
    getErrorPresentation({
      data: null,
      error:
        "The tool returned a doclist payload with no rows array. This is a broken response, not an empty result - ask again.",
    }),
    {
      blockingError:
        "The tool returned a doclist payload with no rows array. This is a broken response, not an empty result - ask again.",
      inlineError: null,
    },
  );
});

Deno.test("viewer presentation - an error over existing data stays inline", () => {
  assertEquals(
    getErrorPresentation({ data: { count: 3 }, error: "Refresh failed" }),
    { blockingError: null, inlineError: "Refresh failed" },
  );
});

Deno.test("viewer presentation - no error means no message either way", () => {
  assertEquals(
    getErrorPresentation({ data: null, error: null }),
    { blockingError: null, inlineError: null },
  );
  assertEquals(
    getErrorPresentation({ data: { count: 0 }, error: null }),
    { blockingError: null, inlineError: null },
  );
});
